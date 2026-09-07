import {COLORS,clamp,dbToGain,gainToDb,uid,clone,clipEnd,sessionEnd,formatTime,makeTrack,makeClip,makeSession,findClip,SessionStore,splitClips,deleteClips,duplicateClips,trimClip,validateSession} from './model.js';
import {AudioEngine,EFFECTS,makeEffect} from './audio-engine.js';
import {DSPWorker,copyChannels,makeAudioBuffer} from './worker-client.js';
import {WaveRenderer,waveformGeometry,peakAt} from './renderer.js';
import {LocalProjectStorage,serializeProject,deserializeProject,download} from './persistence.js';
import {icon,hydrateIcons} from './icons.js';
const $=id=>document.getElementById(id);
const escapeHTML=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=(v,d=1)=>Number(v).toFixed(d);
const dbText=(v,d=1)=>v<=-100?'−∞':`${v<0?'−':''}${Math.abs(v).toFixed(d)}`;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const OP_NAMES={'normalize':'Normalize to −1 dBFS','match-rms':'Match RMS to −18 dBFS','reverse':'Reverse audio','fade-in':'Fade in','fade-out':'Fade out','silence':'Silence selection','dc':'Remove DC offset','gate':'Noise gate','spectral':'Spectral attenuation','gain':'Amplify audio'};
export class SonoraApp {
  constructor(){
    this.assets=new Map();this.worker=new DSPWorker();this.store=new SessionStore(makeSession(),this.assets);
    this.storage=new LocalProjectStorage();this.engine=new AudioEngine(()=>this.playbackState(),this.assets);this.renderer=new WaveRenderer($('wave-canvas'));
    this.ui={mode:'multitrack',dock:'mixer',tool:'move',snap:true,grid:'beat',viewStart:0,viewEnd:40,multiView:[0,40],spectral:false,automation:false,selectedAssetId:null,effectId:null,clipboard:[],spectralBand:null,heldPeaks:[0,0],visiblePeaks:[0,0],workspace:'default'};
    this.spectralCache=new Map();this.spectralPending=new Set();this.controlSnapshots=new WeakMap();this.booting=true;this.waveDirty=true;this.overviewDirty=true;this.lastMeterTime=0;this.recentHistory=[];this.autosaveTimer=0;this.saving=false;this.ready=false;this.drag=null;this.skipAudioRefresh=false;
  }
  async init(){
    hydrateIcons();this.bindEvents();this.renderer.addEventListener('backend',()=>{this.updateBackend();this.waveDirty=true;});
    const gpu=this.renderer.init();
    let restored=null;try{restored=await this.storage.load();}catch(error){console.warn('Sonora local storage:',error.message);}
    if(restored){for(const [id,a]of restored.assets)this.assets.set(id,a);this.store.replace(restored.state);this.ui.selectedAssetId=this.focused()?.clip.assetId;this.ui.viewEnd=Math.max(8,sessionEnd(this.store.state)*1.06);this.recentHistory.push('Restored local session');$('loading-message').textContent='Restoring your local session…';}
    else await this.loadDemo(false);
    $('loading-message').textContent='Analyzing audio & building peak caches…';
    this.renderAll();
    await Promise.all([...this.assets.values()].map(asset=>this.analyzeAsset(asset)));
    await gpu;this.booting=false;this.ready=true;this.renderAll();this.updateBackend();
    $('loading-overlay').classList.add('hidden');setTimeout(()=>$('loading-overlay').remove(),400);
    this.frame(performance.now());this.autosave();document.dispatchEvent(new Event('sonora-ready'));
    if(restored)this.toast('Your last local session has been restored.');
    this.setStatus('Drag clips to arrange. Space to listen. Double-click a clip to edit its waveform.');
  }
  async loadDemo(analyze=true){
    if(this.engine.recording)await this.finishRecording();this.engine.stop();
    const demo=await this.worker.run('demo',{sampleRate:48000});this.assets.clear();this.spectralCache.clear();
    const names=['Analog Keys','Sub Bass','Drum Machine','Atmosphere','Percussion','Transitions'];
    const tracks=names.map((name,i)=>makeTrack(name,i));
    demo.assets.forEach((data,i)=>{const id=uid('asset');const asset={id,name:data.name,buffer:makeAudioBuffer(data.channels,data.sampleRate)};this.assets.set(id,asset);tracks[i].assetId=id;tracks[i].role=i===5?'SFX':i===3?'Ambience':'Music';});
    const phrase=demo.phrase,bar=demo.bar;
    const add=(trackIndex,start,duration,label,offset=0)=>{const track=tracks[trackIndex],asset=this.assets.get(track.assetId),clip=makeClip(asset.id,Math.min(duration,asset.buffer.duration-offset),start,label);clip.offset=offset;track.clips.push(clip);return clip;};
    for(let i=0;i<4;i++)add(0,i*phrase,phrase,i===0?'Analog keys · opening':i===3?'Analog keys · resolve':'Analog keys');
    for(let i=1;i<4;i++)add(1,i*phrase,phrase,'Velvet sub');
    for(let i=1;i<4;i++)add(2,i*phrase,phrase,i===1?'808 · the pulse':'808 drum machine');
    add(3,0,phrase*2,'Night air · texture').fadeIn=2;add(3,phrase*2,phrase*2,'Night air · wide').fadeOut=3;
    add(4,phrase*2,phrase,'Orbit percussion');add(4,phrase*3,phrase,'Orbit percussion');
    add(5,phrase-bar*2,bar*2,'Reverse bloom');add(5,phrase*3-bar*2,bar*2,'Reverse bloom');
    tracks[0].effects=[{...makeEffect('eq'),low:-1,high:2.5},{...makeEffect('compressor'),threshold:-18,ratio:2},makeEffect('reverb')];
    tracks[1].effects=[{...makeEffect('highpass'),frequency:30},{...makeEffect('eq'),low:1.5,high:-4}];
    tracks[2].effects=[{...makeEffect('compressor'),threshold:-16,ratio:3},{...makeEffect('distortion'),drive:2,mix:.15}];
    tracks[3].effects=[{...makeEffect('eq'),low:-4},{...makeEffect('reverb'),mix:.32,decay:2.5}];
    tracks[4].effects=[{...makeEffect('highpass'),frequency:380},{...makeEffect('delay'),mix:.12}];
    tracks[5].effects=[{...makeEffect('highpass'),frequency:120},{...makeEffect('reverb'),mix:.24}];
    [-2,-4,-4,-8,-5,-7].forEach((gain,i)=>{tracks[i].gain=gain;delete tracks[i].assetId;});tracks[3].pan=-.16;tracks[4].pan=.2;
    const state=makeSession();Object.assign(state,{name:'Midnight Signal',tempo:108,tracks,selectedTrackId:tracks[0].id,selectedClipIds:[tracks[0].clips[0].id],markers:[{id:uid('marker'),time:0,name:'INTRO'},{id:uid('marker'),time:phrase,name:'THE PULSE'},{id:uid('marker'),time:phrase*3,name:'AFTER HOURS'},{id:uid('marker'),time:phrase*4,name:'OUTRO'}],loop:{enabled:false,start:phrase,end:phrase*2}});
    this.ui.selectedAssetId=tracks[0].clips[0].assetId;this.ui.mode='multitrack';this.ui.spectral=false;this.ui.viewStart=0;this.ui.viewEnd=40;this.ui.effectId=tracks[0].effects[0].id;this.ui.spectralBand=null;
    this.store.replace(state);this.recentHistory=['Created a 48 kHz stereo session','Generated six original audio sources','Loaded Midnight Signal'];
    if(analyze){await Promise.all([...this.assets.values()].map(a=>this.analyzeAsset(a)));this.renderAll();this.toast('Midnight Signal is ready. Press Space to play.');}
  }
  async analyzeAsset(asset){
    const channels=copyChannels(asset.buffer),result=await this.worker.run('analyze',{channels,sampleRate:asset.buffer.sampleRate},channels.map(c=>c.buffer));
    Object.assign(asset,result);this.waveDirty=true;this.overviewDirty=true;if(this.ready){this.renderInspector();this.renderFiles();}
  }
  selectedTrack(){return this.store.state.tracks.find(t=>t.id===this.store.state.selectedTrackId)||this.store.state.tracks[0];}
  focused(){return findClip(this.store.state,this.store.state.selectedClipIds[0]);}
  playbackState(){
    if(this.ui.mode!=='waveform')return this.store.state;
    const focus=this.focused();if(!focus)return {...this.store.state,tracks:[]};
    return {...this.store.state,tracks:[{...focus.track,mute:false,solo:false,clips:[{...focus.clip,start:0}],automation:[]}],loop:{...this.store.state.loop,start:clamp(this.store.state.loop.start,0,Math.max(0,focus.clip.duration-.05)),end:clamp(this.store.state.loop.end,.05,focus.clip.duration)}};
  }
  duration(){return this.ui.mode==='waveform'?(this.focused()?.clip.duration||1):sessionEnd(this.store.state);}
  span(){return this.ui.viewEnd-this.ui.viewStart;}
  pps(){return Math.max(1,$('lane-wrap').clientWidth)/this.span();}
  trackHeight(){return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-height'))||80;}
  updateBackend(){
    $('renderer-backend').textContent=this.renderer.mode;$('renderer-backend').title=this.renderer.mode==='WebGPU'?'Instanced WGSL waveform renderer':`Canvas fallback: ${this.renderer.reason||'WebGPU not available'}`;
    $('audio-backend').textContent=this.engine.context?`Web Audio · ${(this.engine.context.sampleRate/1000).toFixed(0)} kHz · ${Math.round((this.engine.context.baseLatency||0)*1000)} ms base`:'Web Audio · ready';
  }
  bindEvents(){
    document.addEventListener('click',e=>this.onClick(e));document.addEventListener('input',e=>this.onInput(e));document.addEventListener('change',e=>this.onChange(e));
    document.addEventListener('keydown',e=>this.onKey(e));document.addEventListener('dblclick',e=>this.onDoubleClick(e));
    document.addEventListener('contextmenu',e=>this.onContextMenu(e));
    $('lane-wrap').addEventListener('pointerdown',e=>this.onTimelineDown(e));$('automation-layer').addEventListener('pointerdown',e=>this.onAutomationDown(e));
    $('ruler').addEventListener('pointerdown',e=>this.onRulerDown(e));
    $('timeline-scroll').addEventListener('scroll',()=>{this.renderTimeline();});
    $('timeline-area').addEventListener('wheel',e=>this.onWheel(e),{passive:false});
    $('navigator').addEventListener('pointerdown',e=>this.onOverviewDown(e));
    $('file-list').addEventListener('dragstart',e=>{const row=e.target.closest('[data-asset]');if(row){e.dataTransfer.setData('application/x-sonora-asset',row.dataset.asset);e.dataTransfer.effectAllowed='copy';}});
    let dragDepth=0;
    $('workspace').addEventListener('dragenter',e=>{e.preventDefault();dragDepth++;$('drop-indicator').classList.add('visible');});
    $('workspace').addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='copy';});
    $('workspace').addEventListener('dragleave',()=>{if(--dragDepth<=0){dragDepth=0;$('drop-indicator').classList.remove('visible');}});
    $('workspace').addEventListener('drop',e=>{e.preventDefault();dragDepth=0;$('drop-indicator').classList.remove('visible');this.onDrop(e).catch(error=>this.error(error));});
    window.addEventListener('dragover',e=>e.preventDefault());window.addEventListener('drop',e=>e.preventDefault());
    $('file-input').addEventListener('change',async e=>{try{await this.importFiles([...e.target.files]);}catch(error){this.error(error);}finally{e.target.value='';}});
    this.store.addEventListener('change',e=>this.onDocumentChange(e.detail));
    this.engine.addEventListener('transport',()=>this.renderTransport());this.engine.addEventListener('ended',()=>this.renderTransport());
    this.engine.addEventListener('recording',()=>this.renderTransport());this.engine.addEventListener('contextchange',()=>this.updateBackend());this.engine.addEventListener('recordlimit',()=>this.finishRecording().catch(e=>this.error(e)));
    new ResizeObserver(()=>{this.renderTimeline();this.overviewDirty=true;}).observe($('timeline-area'));
    window.addEventListener('beforeunload',e=>{if(this.engine.recording){e.preventDefault();e.returnValue='Recording is still active.';}});
    $('brand').addEventListener('click',e=>{e.preventDefault();this.action('about');});
  }
  onDocumentChange({label,kind}){
    if(kind==='document'){
      this.recentHistory.push(label);if(this.recentHistory.length>100)this.recentHistory.shift();
      if(!this.skipAudioRefresh&&!this.booting)this.engine.refresh().catch(error=>this.error(error));
      if(!this.booting)this.autosave();
    }
    const focus=this.focused();if(focus)this.ui.selectedAssetId=focus.clip.assetId;
    if(this.ui.mode==='waveform'&&!focus){this.ui.mode='multitrack';[this.ui.viewStart,this.ui.viewEnd]=this.ui.multiView;}
    this.renderAll();
  }
  renderAll(){this.renderFiles();this.renderRack();this.renderTimeline();this.renderInspector();this.renderMixer();this.renderHistory();this.renderMarkers();this.renderTransport();this.renderClipProperties();this.renderChrome();this.overviewDirty=true;}
  renderChrome(){
    const state=this.store.state;$('session-caption').textContent=state.name;$('editor-title').textContent=this.ui.mode==='waveform'?(this.focused()?.clip.name||'Waveform'):`${state.name}.sonora`;
    $('dirty-indicator').style.display=this.store.dirty?'block':'none';document.title=`${state.name} — Sonora Studio`;
    document.querySelectorAll('[data-mode]').forEach(b=>b.classList.toggle('active',b.dataset.mode===this.ui.mode));
    document.querySelectorAll('[data-tool]').forEach(b=>b.classList.toggle('active',b.dataset.tool===this.ui.tool));
    $('snap-button').classList.toggle('active',this.ui.snap);$('spectral-button').classList.toggle('active',this.ui.spectral);$('undo-button').disabled=!this.store.undoStack.length;$('redo-button').disabled=!this.store.redoStack.length;
    $('workspace').className=`workspace ${this.ui.workspace} tool-${this.ui.tool}`;
    $('tempo-value').textContent=number(state.tempo,Number.isInteger(state.tempo)?0:1);$('session-format').textContent=`${state.sampleRate.toLocaleString()} Hz · Stereo`;
    const asset=this.assets.get(this.ui.selectedAssetId);$('asset-format').textContent=asset?`${asset.buffer.sampleRate/1000} kHz · ${asset.buffer.numberOfChannels===1?'Mono':asset.buffer.numberOfChannels===2?'Stereo':asset.buffer.numberOfChannels+' ch'}`:'48 kHz';
    $('master-gain-text').textContent=`${dbText(state.masterGain)} dB`;$('master-gain').value=state.masterGain;
  }
  renderFiles(){
    const query=$('file-search').value.toLowerCase();$('file-count').textContent=this.assets.size;
    $('file-list').innerHTML=[...this.assets.values()].filter(a=>a.name.toLowerCase().includes(query)).map(asset=>`<div class="file-row ${this.ui.selectedAssetId===asset.id?'selected':''}" data-asset="${asset.id}" draggable="true" role="button" tabindex="0" title="${escapeHTML(asset.name)} · ${asset.buffer.sampleRate.toLocaleString()} Hz · ${asset.buffer.numberOfChannels} channels. Drag to timeline or double-click to edit.">${icon('wave')}<span class="file-name">${escapeHTML(asset.name)}</span><span class="file-duration">${formatTime(asset.buffer.duration,1)}</span></div>`).join('')||'<div class="history-row">No audio files found.</div>';
  }
  renderRack(){
    const track=this.selectedTrack();$('rack-track-name').textContent=track.name;$('rack-color').style.background=track.color;
    if(!track.effects.some(f=>f.id===this.ui.effectId))this.ui.effectId=track.effects[0]?.id;
    $('rack-power').classList.toggle('active',track.effects.some(f=>f.enabled));
    $('effects-list').innerHTML=track.effects.map((fx,i)=>`<div class="effect-row ${this.ui.effectId===fx.id?'selected':''} ${fx.enabled?'':'off'}" data-fx-select="${fx.id}"><span class="effect-number">${String(i+1).padStart(2,'0')}</span><button class="icon-btn effect-power" data-fx-toggle="${fx.id}" title="${fx.enabled?'Bypass':'Enable'} effect" aria-label="Toggle ${EFFECTS[fx.type].name}">${icon('power')}</button><span class="effect-title">${EFFECTS[fx.type].short}</span><button class="icon-btn" data-fx-move="${fx.id}" title="Move effect up" aria-label="Move effect up">${icon('chevron','rotate-up')}</button><button class="icon-btn remove-fx" data-fx-remove="${fx.id}" title="Remove effect" aria-label="Remove effect">${icon('x')}</button></div>`).join('');
    const fx=track.effects.find(f=>f.id===this.ui.effectId);
    if(!fx){$('effect-detail').innerHTML='<div class="inspector-hint">Add an effect to start shaping your sound.<br>Playback and mixdown use the same processing graph.</div>';return;}
    $('effect-detail').innerHTML=`<div class="effect-detail-title"><span>${EFFECTS[fx.type].name}</span><span>${fx.enabled?'ACTIVE':'BYPASS'}</span></div>${fx.type==='eq'?`<svg class="eq-mini" viewBox="0 0 180 32" preserveAspectRatio="none"><path d="M0 16H180 M45 0V32 M90 0V32 M135 0V32" stroke="#415047" stroke-width=".5"/><path d="M0 ${16-fx.low*.7}C30 ${16-fx.low*.7},55 ${16-fx.mid*.9},90 ${16-fx.mid*.9}S145 ${16-fx.high*.7},180 ${16-fx.high*.7}" stroke="#96c8aa" stroke-width="1.5" fill="none"/></svg>`:''}${EFFECTS[fx.type].controls.map(([key,label,min,max,step,unit])=>`<div class="effect-control"><div class="control-label"><label for="fx-${key}">${label}</label><output id="fx-out-${key}">${number(fx[key],step<.01?3:step<1?1:0)} ${unit}</output></div><input id="fx-${key}" type="range" data-effect-id="${fx.id}" data-effect-param="${key}" min="${min}" max="${max}" step="${step}" value="${fx[key]}" aria-label="${label}"></div>`).join('')}`;
  }
  renderTimeline(){
    const area=$('timeline-scroll');if(!area||area.clientWidth<1)return;
    const tracks=this.store.state.tracks,rowHeight=this.trackHeight(),waveform=this.ui.mode==='waveform',focus=this.focused();
    const height=waveform?Math.max(100,area.clientHeight):Math.max(area.clientHeight,tracks.length*rowHeight),scroll=area.scrollTop;
    $('timeline-content').style.height=`${height}px`;$('lane-wrap').style.height=`${height}px`;
    const width=$('lane-wrap').clientWidth,pps=width/this.span();if(!Number.isFinite(pps)||pps<=0)return;
    $('ruler').style.marginRight=`${area.offsetWidth-area.clientWidth}px`;
    $('track-count').textContent=waveform?'Waveform editor':`${tracks.length} tracks`;$('track-count').title=waveform?'Calibrated source amplitude':'Waveforms are peak-scaled for visibility; audio levels are unchanged.';
    if(waveform&&focus){
      const asset=this.assets.get(focus.clip.assetId);$('track-headers').innerHTML=`<div class="waveform-header" style="--track-color:${focus.track.color}"><h3>${escapeHTML(focus.clip.name)}</h3><p>${asset?.buffer.sampleRate.toLocaleString()} Hz<br>${asset?.buffer.numberOfChannels===1?'Mono':'Stereo'} · 32-bit float</p><p style="margin-top:18px">${this.ui.spectral?'Hann · FFT 2048<br>Logarithmic frequency':'Amplitude<br>Linear scale'}</p><span class="waveform-channel-label" style="top:${this.ui.spectral?'20%':'27%'}">L&nbsp; +1 / −1</span><span class="waveform-channel-label" style="top:${this.ui.spectral?'39%':'75%'}">R&nbsp; +1 / −1</span>${this.ui.spectral?'<p style="position:absolute;bottom:24px;left:13px">Drag a spectral region with T.<br>Attenuate it in Effects.</p>':''}</div>`;
    }else $('track-headers').innerHTML=tracks.map((track,i)=>`<div class="track-header ${track.id===this.store.state.selectedTrackId?'selected':''}" style="--track-color:${track.color}" data-track="${track.id}"><div class="track-header-top"><span class="track-number">${String(i+1).padStart(2,'0')}</span><span class="track-title" data-track-rename="${track.id}" title="Double-click to rename">${escapeHTML(track.name)}</span><button class="track-menu" data-track-menu="${track.id}" title="Track options" aria-label="${escapeHTML(track.name)} options">${icon('more')}</button></div><div class="track-buttons"><button class="square-button mute ${track.mute?'active':''}" data-track-toggle="mute" data-track-id="${track.id}" title="Mute ${escapeHTML(track.name)}">M</button><button class="square-button solo ${track.solo?'active':''}" data-track-toggle="solo" data-track-id="${track.id}" title="Solo ${escapeHTML(track.name)}">S</button><button class="square-button arm ${track.armed?'active':''}" data-track-toggle="armed" data-track-id="${track.id}" title="Arm ${escapeHTML(track.name)} for recording">R</button><button class="square-button fx" data-track-fx="${track.id}" title="Track effects">fx</button><div class="track-meter"><span data-track-meter="${track.id}"></span></div></div><div class="track-bottom"><input type="range" min="-60" max="12" step="0.1" value="${track.gain}" data-track-gain="${track.id}" aria-label="${escapeHTML(track.name)} gain"><span class="track-gain-value" data-gain-value="${track.id}">${dbText(track.gain)} dB</span><span class="track-pan-value">${track.pan===0?'C':`${Math.round(Math.abs(track.pan)*100)}${track.pan<0?'L':'R'}`}</span></div></div>`).join('');
    const majorStep=this.rulerStep(),gridSize=majorStep*pps,subGrid=gridSize/4,offset=-(this.ui.viewStart*pps)%gridSize;
    $('grid-lanes').innerHTML=(waveform?[focus?.track||tracks[0]]:tracks).map(track=>`<div class="grid-lane ${track.id===this.store.state.selectedTrackId?'selected':''}" style="height:${waveform?height:rowHeight}px;background-size:${gridSize}px 100%,${subGrid}px 100%;background-position:${offset}px 0"><div class="track-zero"></div></div>`).join('');
    const html=[],items=[];this.items=items;
    const drawClip=(clip,track,row)=>{
      const start=waveform?0:clip.start,x=(start-this.ui.viewStart)*pps,w=clip.duration*pps,y=waveform?0:row*rowHeight+6,h=waveform?height:rowHeight-12;
      if(x+w<0||x>width||y+h<scroll||y>scroll+area.clientHeight)return;
      const selected=this.store.state.selectedClipIds.includes(clip.id),fadeIn=Math.min(w-7,Math.max(4,clip.fadeIn*pps)),fadeOut=Math.min(w-7,Math.max(4,clip.fadeOut*pps));
      html.push(`<div class="audio-clip ${selected?'selected':''} ${clip.locked?'locked':''} ${waveform?'waveform-clip':''}" data-clip="${clip.id}" style="--clip-color:${track.color};left:${x}px;top:${y}px;width:${Math.max(2,w)}px;height:${h}px" title="${escapeHTML(clip.name)} · ${formatTime(clip.duration)} · ${dbText(clip.gain)} dB${clip.locked?' · Locked':''}"><div class="clip-label">${icon(clip.locked?'lock':'wave')}<span class="clip-label-text">${escapeHTML(clip.name)}</span>${w>90?`<span class="clip-rate">${clip.rate!==1?`${number(clip.rate,2)}×`:'ST'}</span>`:''}</div>${!waveform?`<div class="clip-handle left" data-edge="left"></div><div class="clip-handle right" data-edge="right"></div><div class="fade-handle fade-in" data-fade="fadeIn" style="left:${fadeIn}px"></div><div class="fade-handle fade-out" data-fade="fadeOut" style="right:${fadeOut}px"></div><svg class="clip-fade-svg" viewBox="0 0 ${Math.max(1,w)} ${h-21}" preserveAspectRatio="none"><path d="M0 ${h-21}L${clip.fadeIn*pps} 1 M${Math.max(0,w-clip.fadeOut*pps)} 1L${w} ${h-21}"/></svg>`:''}</div>`);
      let waveformHeight=h-23;if(waveform&&this.ui.spectral)waveformHeight*=.44;
      items.push({clip:{...clip,start},trackId:track.id,x,y:y+21-scroll,w,h:waveformHeight,color:track.color,viewStart:this.ui.viewStart,pixelsPerSecond:pps,displayScale:waveform?1:.92/Math.max(.005,this.assets.get(clip.assetId)?.stats?.peak||1),fullY:y-scroll,fullHeight:h});
    };
    if(waveform&&focus)drawClip(focus.clip,focus.track,0);else tracks.forEach((track,i)=>track.clips.forEach(c=>drawClip(c,track,i)));
    $('clip-layer').innerHTML=html.join('');
    this.renderer.canvas.style.top=`${scroll}px`;this.renderer.canvas.style.height=`${area.clientHeight}px`;
    $('spectral-canvas').style.top=`${scroll}px`;$('spectral-canvas').style.height=`${area.clientHeight}px`;
    this.waveDirty=true;this.renderRuler();this.renderRange();this.renderAutomation();this.renderPlayhead();
    $('timeline-pan').value=clamp(this.ui.viewStart/Math.max(.001,this.extent()-this.span())*1000,0,1000);
    const full=Math.max(1,this.duration()*1.06);$('zoom-slider').value=clamp(Math.log2(full/this.span())/Math.log2(1000)*100,0,100);
    if(waveform&&this.ui.spectral&&focus)this.ensureSpectrogram(focus.clip.assetId);
  }
  extent(){return Math.max(this.duration()*1.15,40,this.ui.viewEnd);}
  rulerStep(){const desired=70/this.pps(),steps=[.001,.002,.005,.01,.02,.05,.1,.2,.5,1,2,5,10,15,30,60,120,300,600,1800];return steps.find(s=>s>=desired)||3600;}
  renderRuler(){
    const pps=this.pps(),step=this.rulerStep(),ticks=[];
    for(let t=Math.floor(this.ui.viewStart/step)*step;t<=this.ui.viewEnd+step;t+=step){const x=(t-this.ui.viewStart)*pps;if(x<-1)continue;ticks.push(`<div class="ruler-tick major" style="left:${x}px"><span>${formatTime(t,step<.1?3:step<1?1:0)}</span></div>`);for(let j=1;j<4;j++)ticks.push(`<div class="ruler-tick" style="left:${x+j*step*pps/4}px"></div>`);}
    $('ruler-ticks').innerHTML=ticks.join('');
    $('marker-layer').innerHTML=this.ui.mode==='waveform'?'':this.store.state.markers.filter(m=>m.time>=this.ui.viewStart&&m.time<=this.ui.viewEnd).map(m=>`<button class="marker-flag" data-marker-jump="${m.id}" style="left:${(m.time-this.ui.viewStart)*pps}px" title="${escapeHTML(m.name)} · ${formatTime(m.time)}">${escapeHTML(m.name)}</button>`).join('');
  }
  renderRange(){
    const {start,end}=this.store.state.selection,el=$('range-selection');el.style.display=end-start>.0001?'block':'none';el.style.left=`${(start-this.ui.viewStart)*this.pps()}px`;el.style.width=`${(end-start)*this.pps()}px`;
    const band=this.ui.spectralBand,b=$('spectral-selection');b.style.display=band&&this.ui.spectral?'block':'none';
    if(band&&this.items?.length){const item=this.items[0],top=item.fullY+21+(item.fullHeight-23)*.46,bottom=item.fullY+item.fullHeight-2,nyquist=Math.min(20000,this.assets.get(item.clip.assetId).buffer.sampleRate/2),y=f=>top+(1-Math.log(f/30)/Math.log(nyquist/30))*(bottom-top);b.style.left=`${(band.start-this.ui.viewStart)*this.pps()}px`;b.style.width=`${(band.end-band.start)*this.pps()}px`;b.style.top=`${y(band.high)+$('timeline-scroll').scrollTop}px`;b.style.height=`${Math.max(1,y(band.low)-y(band.high))}px`;}
    $('selection-start').textContent=formatTime(start);$('selection-end').textContent=formatTime(end);$('selection-duration').textContent=formatTime(end-start);
  }
  renderAutomation(){
    const svg=$('automation-layer');svg.classList.toggle('visible',this.ui.automation&&this.ui.mode==='multitrack');
    if(!this.ui.automation||this.ui.mode==='waveform'){svg.innerHTML='';return;}
    const width=$('lane-wrap').clientWidth,pps=this.pps(),h=this.trackHeight();
    svg.innerHTML=this.store.state.tracks.map((track,i)=>{const mapY=v=>i*h+25+(12-v)/72*(h-33),points=track.automation;
      const visible=points.map((p,j)=>({x:(p.time-this.ui.viewStart)*pps,y:mapY(p.value),j}));
      const path=visible.length?`M${visible.map(p=>`${p.x},${p.y}`).join('L')}`:`M0 ${mapY(0)}H${width}`;
      return `<path d="${path}"/>${visible.map(p=>`<circle cx="${p.x}" cy="${p.y}" r="4" data-auto-track="${track.id}" data-auto-index="${p.j}"/>`).join('')}${track.id===this.store.state.selectedTrackId?`<text x="9" y="${i*h+h-7}" class="automation-notice">Alt-click to add gain automation</text>`:''}`;
    }).join('');
  }
  renderInspector(){
    const focus=this.focused();if(!focus){$('essential-body').innerHTML=`<div class="empty-inspector">${icon('wave')}<span>Select a clip to shape its sound.<br>Or import audio to begin.</span><button class="small-button" data-action="import">${icon('plus')}Import audio</button></div>`;return;}
    const {clip,track}=focus,asset=this.assets.get(clip.assetId),stats=asset?.stats,role=track.role||'Music';
    const field=(key,label,value,step='.001',unit='s')=>`<div class="inspector-field input-with-unit"><label for="clip-${key}">${label}</label><input id="clip-${key}" type="number" data-clip-prop="${key}" data-clip-id="${clip.id}" value="${Number(value.toFixed(4))}" step="${step}" min="0" aria-label="Clip ${label}"><span class="input-unit">${unit}</span></div>`;
    $('essential-body').innerHTML=`<div class="selected-clip-heading"><div class="clip-type-icon" style="color:${track.color}">${icon('music')}</div><div><label>SELECTED CLIP</label><h3 title="${escapeHTML(clip.name)}">${escapeHTML(clip.name)}</h3></div></div><div class="sound-role">${['Dialogue','Music','SFX','Ambience'].map(r=>`<button data-role="${r}" class="${role===r?'active':''}" title="Assign ${r.toLowerCase()} metadata">${r}</button>`).join('')}</div><div class="inspector-section" style="border-top:0;padding-top:0;margin-top:0"><h3>${icon('sliders')}Clip settings</h3><div class="inspector-grid"><div class="inspector-field full"><label for="clip-name">Name</label><input id="clip-name" data-clip-prop="name" data-clip-id="${clip.id}" value="${escapeHTML(clip.name)}" maxlength="150" aria-label="Clip name"></div>${field('start','Start',clip.start)}${field('duration','Duration',clip.duration)}${field('fadeIn','Fade in',clip.fadeIn)}${field('fadeOut','Fade out',clip.fadeOut)}</div><div class="clip-gain-row"><label for="clip-gain">Clip gain</label><output id="clip-gain-output">${dbText(clip.gain)} dB</output></div><input class="inspector-range" id="clip-gain" type="range" min="-36" max="12" step=".1" data-clip-prop="gain" data-clip-id="${clip.id}" value="${clip.gain}" aria-label="Clip gain"><div class="clip-gain-row"><label for="clip-rate">Varispeed <span style="font-size:7px;opacity:.55">(changes pitch)</span></label><output id="clip-rate-output">${number(clip.rate,2)}×</output></div><input class="inspector-range" id="clip-rate" type="range" min=".25" max="4" step=".01" data-clip-prop="rate" data-clip-id="${clip.id}" value="${clip.rate}" aria-label="Varispeed playback rate"></div><div class="inspector-section"><h3>${icon('spark')}Quick processing</h3><div class="action-grid"><button data-process="normalize">${icon('normalize')}Normalize</button><button data-process="reverse">${icon('reverse')}Reverse</button><button data-process="fade-in">${icon('fade')}Fade in</button><button data-process="dc">${icon('clean')}Remove DC</button></div><p class="inspector-hint">Processes the time selection, or the entire clip.<br>Original source preserved. Every edit is undoable.</p></div><div class="inspector-section"><h3>${icon('wave')}Source analysis</h3><div class="source-stats"><div>Sample peak<strong>${stats?dbText(gainToDb(stats.peak)):'…'} <small>dBFS</small></strong></div><div>RMS level<strong>${stats?dbText(gainToDb(stats.rms)):'…'} <small>dBFS</small></strong></div></div><div class="automation-toggle"><span>Track gain automation</span><button data-action="automation">${this.ui.automation?'Hide envelope':'Show envelope'}</button></div></div>`;
  }
  renderMixer(){
    const state=this.store.state;
    $('mixer-strips').innerHTML=state.tracks.map(track=>`<div class="mixer-strip ${state.selectedTrackId===track.id?'selected':''}" style="--track-color:${track.color}" data-mixer-track="${track.id}"><div class="mixer-title" title="${escapeHTML(track.name)}">${escapeHTML(track.name)}</div><div class="mixer-pan"><span>L</span><input type="range" min="-1" max="1" step=".01" value="${track.pan}" data-track-pan="${track.id}" aria-label="${escapeHTML(track.name)} pan"><span>R</span></div><div class="mixer-channel-body"><div class="mixer-db-scale"><span>+12</span><span>0</span><span>−24</span><span>−60</span></div><input class="mixer-fader" type="range" min="-60" max="12" step=".1" value="${track.gain}" data-track-gain="${track.id}" aria-label="${escapeHTML(track.name)} fader"><div class="mini-meter-well"><div class="mini-meter-fill" data-mixer-meter="${track.id}"></div></div></div><div class="mixer-strip-bottom"><button class="square-button mute ${track.mute?'active':''}" data-track-toggle="mute" data-track-id="${track.id}" title="Mute ${escapeHTML(track.name)}">M</button><button class="square-button solo ${track.solo?'active':''}" data-track-toggle="solo" data-track-id="${track.id}" title="Solo ${escapeHTML(track.name)}">S</button><input type="number" min="-60" max="12" step=".1" value="${number(track.gain)}" data-track-gain="${track.id}" aria-label="${escapeHTML(track.name)} gain in dB"><span class="unit">dB</span></div></div>`).join('')+`<div class="mixer-strip master" style="--track-color:#afc797"><div class="mixer-title">Master</div><div class="mixer-pan"><span>Stereo output</span></div><div class="mixer-channel-body"><div class="mixer-db-scale"><span>+12</span><span>0</span><span>−24</span><span>−60</span></div><input class="mixer-fader" type="range" min="-60" max="12" step=".1" value="${state.masterGain}" data-master-gain="true" aria-label="Master fader"><div class="mini-meter-well"><div class="mini-meter-fill" data-mixer-master="true"></div></div></div><div class="mixer-strip-bottom"><span style="font-size:8px;color:#7b9580">OUT</span><input type="number" min="-60" max="12" step=".1" value="${number(state.masterGain)}" data-master-gain="true" aria-label="Master gain in dB"><span class="unit">dB</span></div></div>`;
  }
  renderHistory(){
    const items=this.recentHistory.slice(-5);$('history-list').innerHTML=items.map((name,i)=>`<div class="history-row ${i===items.length-1?'active':''}">${icon(i===items.length-1?'check':'clock')}<span>${escapeHTML(name)}</span></div>`).join('')||`<div class="history-row">${icon('new')}New session</div>`;
  }
  renderMarkers(){
    $('marker-count').textContent=this.store.state.markers.length;
    $('markers-list').innerHTML=this.store.state.markers.map((m,i)=>`<div class="marker-list-row"><span class="marker-index">${String(i+1).padStart(2,'0')}</span><button class="marker-time" data-marker-jump="${m.id}">${formatTime(m.time)}</button><input value="${escapeHTML(m.name)}" data-marker-name="${m.id}" aria-label="Marker ${i+1} name"><button class="icon-btn" data-marker-delete="${m.id}" title="Delete marker" aria-label="Delete marker">${icon('x')}</button></div>`).join('')||'<div class="history-row">Press M to add a marker at the playhead.</div>';
  }
  renderClipProperties(){
    const focus=this.focused();if(!focus){$('clip-properties').innerHTML='<div class="history-row">Select a clip to inspect its source and timing.</div>';return;}
    const {clip,track}=focus,asset=this.assets.get(clip.assetId);const props=[['Clip',clip.name],['Track',track.name],['Source',asset?.name],['Source sample rate',`${asset?.buffer.sampleRate.toLocaleString()} Hz`],['Timeline start',formatTime(clip.start)],['Source offset',formatTime(clip.offset)],['Duration',formatTime(clip.duration)],['End',formatTime(clipEnd(clip))],['Clip gain',`${dbText(clip.gain)} dB`],['Playback rate',`${number(clip.rate,2)}× · pitch follows`],['Source channels',asset?.buffer.numberOfChannels],['Source frames',asset?.buffer.length.toLocaleString()]];
    $('clip-properties').innerHTML=`<div class="clip-properties-table">${props.map(([key,value])=>`<div><label>${key}</label><strong>${escapeHTML(value)}</strong></div>`).join('')}</div>`;
  }
  renderTransport(){
    $('play-button').innerHTML=icon(this.engine.playing?'pause':'play');$('play-button').setAttribute('aria-label',this.engine.playing?'Pause':'Play');$('play-button').style.background=this.engine.playing?'#628b70':'';
    $('record-button').classList.toggle('recording',!!this.engine.recording);$('loop-button').classList.toggle('active',this.store.state.loop.enabled);
    $('transport-state').innerHTML=`<span class="mini-led" style="background:${this.engine.recording?'#e4878f':'#8ecfaf'}"></span>${this.engine.recording?'Recording':this.engine.playing?'Playing':'Ready'}`;
    $('time-display').textContent=formatTime(this.engine.position);this.renderRange();this.renderPlayhead();
  }
  renderPlayhead(){const x=(this.engine.position-this.ui.viewStart)*this.pps(),visible=x>=0&&x<=$('lane-wrap').clientWidth;for(const id of ['playhead','ruler-playhead']){$(id).style.left=`${x}px`;$(id).style.visibility=visible?'visible':'hidden';}}
  drawWaveforms(){
    if(!this.renderer.ready)return;const w=$('lane-wrap').clientWidth,h=$('timeline-scroll').clientHeight;if(!w||!h)return;
    this.renderer.render(waveformGeometry(this.items||[],this.assets,w,h),w,h);this.drawSpectral();
    $('render-stats').textContent=`${this.renderer.rectangles.toLocaleString()} peaks · ${this.renderer.lastMs.toFixed(2)} ms submit`;
  }
  async ensureSpectrogram(assetId){
    if(this.spectralCache.has(assetId)||this.spectralPending.has(assetId))return;const asset=this.assets.get(assetId);if(!asset)return;
    this.spectralPending.add(assetId);this.setStatus('Computing an FFT spectral display from source audio…');
    try{const channels=[asset.buffer.getChannelData(0).slice()],result=await this.worker.run('spectrogram',{channels,sampleRate:asset.buffer.sampleRate,width:1200,height:300},channels.map(c=>c.buffer));const canvas=document.createElement('canvas');canvas.width=result.width;canvas.height=result.height;canvas.getContext('2d').putImageData(new ImageData(result.pixels,result.width,result.height),0,0);this.spectralCache.set(assetId,canvas);this.waveDirty=true;this.setStatus('Spectral view · T: select time/frequency region · Effects: attenuate band');}catch(error){this.error(error);}finally{this.spectralPending.delete(assetId);}
  }
  drawSpectral(){
    const canvas=$('spectral-canvas'),w=$('lane-wrap').clientWidth,h=$('timeline-scroll').clientHeight,dpr=Math.min(devicePixelRatio||1,2);if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);}const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
    if(!this.ui.spectral||this.ui.mode!=='waveform'||!this.items?.length)return;
    const item=this.items[0],image=this.spectralCache.get(item.clip.assetId),asset=this.assets.get(item.clip.assetId),y=item.fullY+21+(item.fullHeight-23)*.46,dh=(item.fullHeight-23)*.54;
    ctx.fillStyle='#15141b';ctx.fillRect(0,y,w,dh);if(!image){ctx.fillStyle='#baacbd';ctx.font='11px sans-serif';ctx.fillText('Computing spectral data…',20,y+30);return;}
    const visibleStart=Math.max(0,this.ui.viewStart),visibleEnd=Math.min(item.clip.duration,this.ui.viewEnd),sx=(item.clip.offset+visibleStart*item.clip.rate)/asset.buffer.duration*image.width,sw=(visibleEnd-visibleStart)*item.clip.rate/asset.buffer.duration*image.width;
    ctx.imageSmoothingEnabled=true;ctx.drawImage(image,sx,0,Math.max(.01,sw),image.height,(visibleStart-this.ui.viewStart)*this.pps(),y,(visibleEnd-visibleStart)*this.pps(),dh);
    const max=Math.min(20000,asset.buffer.sampleRate/2);ctx.font='8px monospace';for(const hz of [16000,4000,1000,250,63])if(hz<max){const py=y+(1-Math.log(hz/30)/Math.log(max/30))*dh;ctx.fillStyle='#e6d4b191';ctx.fillText(hz>=1000?`${hz/1000}k`:`${hz}`,w-33,py);ctx.strokeStyle='#efdabe0c';ctx.beginPath();ctx.moveTo(0,py);ctx.lineTo(w-40,py);ctx.stroke();}
  }
  drawOverview(){
    const canvas=$('overview-canvas'),w=canvas.clientWidth,h=canvas.clientHeight,dpr=Math.min(devicePixelRatio||1,2);if(!w||!h)return;canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);const duration=Math.max(this.duration()*1.06,1),state=this.playbackState();
    ctx.fillStyle='#92b89a';
    for(let x=0;x<w;x++){const t=x/w*duration;let peak=0;for(const track of state.tracks)for(const clip of track.clips)if(t>=clip.start&&t<clipEnd(clip)){const asset=this.assets.get(clip.assetId);if(asset){const sample=(clip.offset+(t-clip.start)*clip.rate)*asset.buffer.sampleRate,spp=duration/w*asset.buffer.sampleRate*clip.rate,[lo,hi]=peakAt(asset,0,sample,sample+spp,spp);peak+=Math.max(Math.abs(lo),hi)*.35;}}const amp=Math.min(.9,peak)*h*.48;ctx.fillRect(x,h/2-amp,1,Math.max(1,amp*2));}
    this.updateOverviewWindow();
  }
  updateOverviewWindow(){const total=Math.max(this.duration()*1.06,1);$('overview-window').style.left=`${clamp(this.ui.viewStart/total*100,0,100)}%`;$('overview-window').style.right=`${clamp((1-this.ui.viewEnd/total)*100,0,100)}%`;}
  drawSpectrum(){
    const canvas=$('spectrum-canvas');if(this.ui.dock!=='spectrum')return;const w=canvas.clientWidth,h=canvas.clientHeight,dpr=Math.min(devicePixelRatio||1,2);if(!w||!h)return;if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);}const c=canvas.getContext('2d');c.setTransform(dpr,0,0,dpr,0,0);c.clearRect(0,0,w,h);const left=36,right=w-15,top=14,bottom=h-22;
    const x=f=>left+Math.log(f/20)/Math.log(1000)*(right-left),y=db=>top+clamp(-db/100,0,1)*(bottom-top);c.font='8px monospace';c.fillStyle='#6e8277';c.strokeStyle='#53655b33';c.lineWidth=.5;
    for(const f of [20,50,100,200,500,1000,2000,5000,10000,20000]){c.beginPath();c.moveTo(x(f),top);c.lineTo(x(f),bottom);c.stroke();c.fillText(f>=1000?`${f/1000}k`:String(f),x(f)-7,h-8);}for(const db of [0,-20,-40,-60,-80,-100]){c.beginPath();c.moveTo(left,y(db));c.lineTo(right,y(db));c.stroke();c.fillText(String(db),5,y(db)+3);}
    let bins,sampleRate,size;if(this.engine.graph?.analyser){const a=this.engine.graph.analyser;this.frequencyData ||= new Float32Array(a.frequencyBinCount);if(this.frequencyData.length!==a.frequencyBinCount)this.frequencyData=new Float32Array(a.frequencyBinCount);a.getFloatFrequencyData(this.frequencyData);bins=this.frequencyData;sampleRate=this.engine.context.sampleRate;size=a.fftSize;}else{const asset=this.assets.get(this.ui.selectedAssetId);if(!asset?.spectrum)return;({bins,sampleRate,size}=asset.spectrum);}
    c.beginPath();let first=true;for(let px=left;px<=right;px++){const f=20*Math.pow(1000,(px-left)/(right-left)),index=f/sampleRate*size,i=Math.floor(index),db=bins[i]??-120;if(first){c.moveTo(px,y(db));first=false;}else c.lineTo(px,y(db));}c.strokeStyle='#a2d9b6';c.lineWidth=1.2;c.stroke();c.lineTo(right,bottom);c.lineTo(left,bottom);c.closePath();const gradient=c.createLinearGradient(0,top,0,bottom);gradient.addColorStop(0,'#a0d1ac40');gradient.addColorStop(1,'#a0d1ac02');c.fillStyle=gradient;c.fill();
  }
  frame(time){
    if(this.waveDirty){this.waveDirty=false;this.drawWaveforms();}if(this.overviewDirty){this.overviewDirty=false;this.drawOverview();}
    if(time-this.lastMeterTime>40){this.lastMeterTime=time;this.updateMeters();this.drawSpectrum();if(this.engine.playing){$('time-display').textContent=formatTime(this.engine.position);if(this.engine.position>this.ui.viewEnd&&!this.drag){const span=this.span();this.ui.viewStart=Math.max(0,this.engine.position-span*.15);this.ui.viewEnd=this.ui.viewStart+span;this.renderTimeline();this.updateOverviewWindow();}}}
    if(this.engine.playing)this.renderPlayhead();requestAnimationFrame(t=>this.frame(t));
  }
  updateMeters(){
    const meter=this.engine.meters(),peaks=[meter.left.peak,meter.right.peak];if(this.engine.recording&&this.recordTrackId)meter.tracks[this.recordTrackId]=this.engine.recording.inputPeak||0;
    for(let ch=0;ch<2;ch++){this.ui.visiblePeaks[ch]=Math.max(peaks[ch],this.ui.visiblePeaks[ch]*.84);this.ui.heldPeaks[ch]=Math.max(this.ui.heldPeaks[ch],peaks[ch]);const suffix=ch?'r':'l',percent=clamp((gainToDb(this.ui.visiblePeaks[ch])+60)/60*100,0,100),hold=clamp((gainToDb(this.ui.heldPeaks[ch])+60)/60*100,0,100);$(`meter-${suffix}`).style.height=`${percent}%`;$(`hold-${suffix}`).style.bottom=`${hold}%`;$(`hold-${suffix}`).style.opacity=this.ui.heldPeaks[ch]>0?1:0;$(`clip-led-${suffix}`).classList.toggle('clipped',this.ui.heldPeaks[ch]>=1);}
    $('peak-readout').innerHTML=`${dbText(gainToDb(Math.max(...this.ui.heldPeaks)))} <small>dBFS</small>`;$('rms-readout').innerHTML=`${dbText(gainToDb(Math.sqrt((meter.left.rms**2+meter.right.rms**2)/2)))} <small>dBFS</small>`;
    document.querySelectorAll('[data-track-meter]').forEach(el=>el.style.width=`${clamp((gainToDb(meter.tracks[el.dataset.trackMeter]||0)+60)/60*100,0,100)}%`);
    document.querySelectorAll('[data-mixer-meter]').forEach(el=>el.style.height=`${clamp((gainToDb(meter.tracks[el.dataset.mixerMeter]||0)+60)/60*100,0,100)}%`);
    document.querySelectorAll('[data-mixer-master]').forEach(el=>el.style.height=`${clamp((gainToDb(Math.max(...peaks))+60)/60*100,0,100)}%`);
  }
  onClick(event){
    const target=event.target;
    const menu=target.closest('[data-menu]');if(menu){this.openMenu(menu.dataset.menu,menu);return;}
    if(!target.closest('#menu-popup'))this.closeMenu();
    const action=target.closest('[data-action]');if(action){this.action(action.dataset.action).catch(error=>this.error(error));return;}
    const mode=target.closest('[data-mode]');if(mode){this.setMode(mode.dataset.mode);return;}
    const tool=target.closest('[data-tool]');if(tool){this.setTool(tool.dataset.tool);return;}
    const dock=target.closest('[data-dock]');if(dock){this.setDock(dock.dataset.dock);return;}
    const process=target.closest('[data-process]');if(process){this.processSelection(process.dataset.process).catch(e=>this.error(e));return;}
    const toggle=target.closest('[data-track-toggle]');if(toggle){this.toggleTrack(toggle.dataset.trackId,toggle.dataset.trackToggle);return;}
    const fxToggle=target.closest('[data-fx-toggle]');if(fxToggle){this.store.execute('Toggle effect bypass',()=>{const fx=this.selectedTrack().effects.find(f=>f.id===fxToggle.dataset.fxToggle);fx.enabled=!fx.enabled;});return;}
    const fxRemove=target.closest('[data-fx-remove]');if(fxRemove){this.store.execute('Remove effect',()=>{this.selectedTrack().effects=this.selectedTrack().effects.filter(f=>f.id!==fxRemove.dataset.fxRemove);});return;}
    const fxMove=target.closest('[data-fx-move]');if(fxMove){this.store.execute('Reorder effects',()=>{const effects=this.selectedTrack().effects,i=effects.findIndex(f=>f.id===fxMove.dataset.fxMove);if(i>0)[effects[i-1],effects[i]]=[effects[i],effects[i-1]];});return;}
    const fx=target.closest('[data-fx-select]');if(fx){this.ui.effectId=fx.dataset.fxSelect;this.renderRack();return;}
    const trackFx=target.closest('[data-track-fx]');if(trackFx){this.store.select(trackFx.dataset.trackFx,[]);return;}
    const trackMenu=target.closest('[data-track-menu]');if(trackMenu){this.store.select(trackMenu.dataset.trackMenu,[]);this.openTrackMenu(trackMenu);return;}
    const role=target.closest('[data-role]');if(role){this.skipAudioRefresh=true;this.store.execute('Assign sound role',()=>{this.selectedTrack().role=role.dataset.role;});this.skipAudioRefresh=false;return;}
    const assetRow=target.closest('[data-asset]');if(assetRow){const id=assetRow.dataset.asset,now=performance.now(),double=this.lastAssetClick?.id===id&&now-this.lastAssetClick.time<420;this.lastAssetClick={id,time:now};this.selectAsset(id);if(double){this.lastAssetClick=null;this.setMode('waveform');}return;}
    const marker=target.closest('[data-marker-jump]');if(marker){const m=this.store.state.markers.find(m=>m.id===marker.dataset.markerJump);if(m)this.seek(m.time);return;}
    const markerDelete=target.closest('[data-marker-delete]');if(markerDelete){this.store.execute('Delete marker',state=>{state.markers=state.markers.filter(m=>m.id!==markerDelete.dataset.markerDelete);});return;}
    const track=target.closest('[data-track]')||target.closest('[data-mixer-track]');if(track&&!target.closest('input,button')){const id=track.dataset.track||track.dataset.mixerTrack;this.store.select(id,this.store.state.selectedClipIds.filter(clipId=>findClip(this.store.state,clipId)?.track.id===id));}
  }
  onInput(event){
    const el=event.target;
    if(el.id==='file-search'){this.renderFiles();return;}
    if(el.id==='timeline-pan'){const span=this.span(),max=Math.max(0,this.extent()-span);this.ui.viewStart=+el.value/1000*max;this.ui.viewEnd=this.ui.viewStart+span;this.renderTimeline();this.updateOverviewWindow();return;}
    if(el.id==='zoom-slider'){const full=Math.max(1,this.duration()*1.06),span=full/Math.pow(1000,+el.value/100);this.setZoomSpan(Math.max(.01,span),this.engine.position);return;}
    if(!el.matches('[data-track-gain],[data-track-pan],[data-master-gain],#master-gain,[data-effect-param],[data-clip-prop]'))return;
    if(el.dataset.clipProp==='name')return;
    if(!this.controlSnapshots.has(el))this.controlSnapshots.set(el,clone(this.store.state));
    const state=this.store.state,value=Number(el.value);if(!Number.isFinite(value))return;
    if(el.dataset.trackGain){const track=state.tracks.find(t=>t.id===el.dataset.trackGain);if(track){track.gain=clamp(value,-60,12);document.querySelectorAll(`[data-gain-value="${track.id}"]`).forEach(out=>out.textContent=`${dbText(track.gain)} dB`);document.querySelectorAll(`[data-track-gain="${track.id}"]`).forEach(input=>{if(input!==el)input.value=track.gain;});}this.engine.updateMix();}
    else if(el.dataset.trackPan){const track=state.tracks.find(t=>t.id===el.dataset.trackPan);if(track)track.pan=clamp(value,-1,1);this.engine.updateMix();}
    else if(el.dataset.masterGain||el.id==='master-gain'){state.masterGain=clamp(value,-60,12);$('master-gain-text').textContent=`${dbText(state.masterGain)} dB`;document.querySelectorAll('[data-master-gain],#master-gain').forEach(input=>{if(input!==el)input.value=state.masterGain;});this.engine.updateMix();}
    else if(el.dataset.effectParam){const fx=this.selectedTrack().effects.find(f=>f.id===el.dataset.effectId),key=el.dataset.effectParam;if(fx){fx[key]=value;const control=EFFECTS[fx.type].controls.find(c=>c[0]===key),out=$(`fx-out-${key}`);if(out)out.textContent=`${number(value,control[4]<.01?3:control[4]<1?1:0)} ${control[5]}`;}}
    else if(el.dataset.clipProp){const found=findClip(state,el.dataset.clipId);if(found){const {clip}=found,key=el.dataset.clipProp;if(clip.locked)return;
      if(key==='rate'){const before=findClip(this.controlSnapshots.get(el),clip.id).clip;clip.rate=clamp(value,.25,4);clip.duration=before.duration*before.rate/clip.rate;clip.fadeIn=Math.min(before.fadeIn,clip.duration/2);clip.fadeOut=Math.min(before.fadeOut,clip.duration/2);if($('clip-rate-output'))$('clip-rate-output').textContent=`${number(clip.rate,2)}×`;}
      else{clip[key]=value;if(key==='gain'&&$('clip-gain-output'))$('clip-gain-output').textContent=`${dbText(value)} dB`;}
      this.renderTimeline();
    }}
  }
  onChange(event){
    const el=event.target;
    if(el.id==='grid-select'){this.ui.grid=el.value;this.setStatus(`Snap grid: ${el.selectedOptions[0].textContent}`);return;}
    if(el.id==='workspace-select'){this.ui.workspace=el.value;this.renderChrome();this.renderTimeline();this.renderMixer();if(el.value==='mixing')this.setDock('mixer');return;}
    if(el.id==='rack-preset'){if(el.value!=='custom')this.applyRackPreset(el.value);return;}
    if(el.dataset.markerName){this.store.execute('Rename marker',state=>{const m=state.markers.find(m=>m.id===el.dataset.markerName);if(m)m.name=el.value;});return;}
    if(el.dataset.clipProp==='name'){this.store.execute('Rename clip',state=>{const c=findClip(state,el.dataset.clipId)?.clip;if(c)c.name=el.value;});return;}
    if(el.matches('[data-track-gain],[data-track-pan],[data-master-gain],#master-gain,[data-effect-param],[data-clip-prop]')){
      if(!this.controlSnapshots.has(el))this.onInput(event);const before=this.controlSnapshots.get(el);if(!before)return;this.controlSnapshots.delete(el);
      const mix=!!(el.dataset.trackGain||el.dataset.trackPan||el.dataset.masterGain||el.id==='master-gain');this.skipAudioRefresh=mix;
      try{const label=el.dataset.effectParam?'Adjust effect':el.dataset.clipProp?`Adjust clip ${el.dataset.clipProp}`:el.dataset.trackPan?'Adjust track pan':'Adjust mixer gain';this.store.commitFrom(before,label);if(mix)this.engine.updateMix();}catch(error){this.error(error);}finally{this.skipAudioRefresh=false;}
    }
  }
  onDoubleClick(event){
    const row=event.target.closest('[data-asset]');if(row){this.selectAsset(row.dataset.asset);this.setMode('waveform');return;}
    const name=event.target.closest('[data-track-rename]');if(name){this.renameTrack(name.dataset.trackRename);return;}
    const clip=event.target.closest('[data-clip]');if(clip){const found=findClip(this.store.state,clip.dataset.clip);if(found){this.store.select(found.track.id,[found.clip.id]);this.setMode('waveform');}return;}
  }
  onContextMenu(event){
    const auto=event.target.closest('[data-auto-track]');if(auto){event.preventDefault();this.store.execute('Remove automation point',state=>{state.tracks.find(t=>t.id===auto.dataset.autoTrack).automation.splice(+auto.dataset.autoIndex,1);});return;}
    const clipElement=event.target.closest('[data-clip]');if(clipElement){event.preventDefault();const found=findClip(this.store.state,clipElement.dataset.clip);if(found&&!this.store.state.selectedClipIds.includes(found.clip.id))this.store.select(found.track.id,[found.clip.id]);this.showMenu([['Waveform editor','waveform','wave',''],['Split at playhead','split','razor','⌘ K'],['Duplicate','duplicate','copy','⌘ D'],['Copy','copy','copy','⌘ C'],['Cut','cut','cut','⌘ X'],null,['Normalize to −1 dBFS','process-normalize','normalize',''],['Reverse audio','process-reverse','reverse',''],['Attenuate spectral band','spectral-process','spectrum',''],null,[found?.clip.locked?'Unlock clip':'Lock clip','lock','lock',''],['Delete','delete','trash','⌫']],event.clientX,event.clientY);return;}
    if(event.target.closest('#ruler')){event.preventDefault();this.seek(this.timeAt(event.clientX));this.showMenu([['Add marker here','add-marker','marker','M'],['Set loop to selection','loop-selection','loop',''],['Fit session','fit','fit','F']],event.clientX,event.clientY);}
  }
  async action(name){
    this.closeMenu();
    if(name.startsWith('process-')){await this.processSelection(name.slice(8));return;}
    switch(name){
      case 'play':if(this.engine.recording){await this.finishRecording();break;}if(this.engine.playing)this.engine.pause();else{let from=this.engine.position;if(from>=this.duration()-.001)from=this.store.state.loop.enabled?this.store.state.loop.start:0;await this.engine.play(from);}break;
      case 'stop':if(this.engine.recording)await this.finishRecording();this.engine.stop(0);this.renderTransport();break;
      case 'start':await this.seek(0);break;
      case 'end':await this.seek(this.duration());break;
      case 'back':{const pos=this.engine.position,m=[...this.store.state.markers].reverse().find(m=>m.time<pos-.05);await this.seek(m?.time??Math.max(0,pos-5));break;}
      case 'forward':{const pos=this.engine.position,m=this.store.state.markers.find(m=>m.time>pos+.05);await this.seek(m?.time??Math.min(this.duration(),pos+5));break;}
      case 'record':if(this.engine.recording)await this.finishRecording();else await this.startRecording();break;
      case 'undo':this.store.undo();break;case 'redo':this.store.redo();break;
      case 'snap':this.ui.snap=!this.ui.snap;this.renderChrome();this.toast(`Snapping ${this.ui.snap?'enabled':'disabled'}.`);break;
      case 'loop':this.store.execute('Toggle loop',state=>{state.loop.enabled=!state.loop.enabled;if(state.loop.enabled&&state.selection.end-state.selection.start>.05){state.loop.start=state.selection.start;state.loop.end=state.selection.end;}});break;
      case 'loop-selection':{const s=this.store.state.selection;if(s.end-s.start<.05){this.toast('Drag a time selection before setting the loop.');break;}this.store.execute('Loop time selection',state=>{state.loop={enabled:true,start:s.start,end:s.end};});break;}
      case 'zoom-in':this.zoom(1.5,this.engine.position);break;case 'zoom-out':this.zoom(1/1.5,this.engine.position);break;case 'fit':this.fit();break;
      case 'spectral':if(this.ui.spectral){this.ui.spectral=false;this.ui.spectralBand=null;this.renderAll();}else{this.setMode('waveform');if(this.ui.mode==='waveform'){this.ui.spectral=true;this.renderAll();}}break;
      case 'waveform':this.setMode('waveform');break;case 'multitrack':this.setMode('multitrack');break;
      case 'automation':this.ui.automation=!this.ui.automation;this.renderAutomation();this.renderInspector();this.setStatus(this.ui.automation?'Alt-click to add an envelope point. Drag points to edit; right-click removes a point.':'Gain automation hidden.');break;
      case 'add-track':this.store.execute('Add audio track',state=>{const track=makeTrack(`Audio ${state.tracks.length+1}`,state.tracks.length);state.tracks.push(track);state.selectedTrackId=track.id;state.selectedClipIds=[];});break;
      case 'remove-track':this.removeTrack();break;case 'rename-track':this.renameTrack(this.selectedTrack().id);break;
      case 'split':{const t=this.ui.mode==='waveform'?this.engine.position+(this.focused()?.clip.start||0):this.engine.position;let result=[];this.store.execute('Split clips',state=>{result=splitClips(state,t);});if(!result.length)this.toast('Place the playhead inside a selected clip to split it.');break;}
      case 'delete':if(this.ui.mode==='waveform'&&this.store.state.selection.end>this.store.state.selection.start)await this.deleteAudioSelection();else this.store.execute('Delete clips',state=>deleteClips(state,false));break;
      case 'ripple-delete':this.store.execute('Ripple delete clips',state=>deleteClips(state,true));break;
      case 'duplicate':this.store.execute('Duplicate clips',duplicateClips);break;
      case 'copy':this.copyClips();break;case 'cut':this.copyClips();this.store.execute('Cut clips',state=>deleteClips(state,false));break;
      case 'paste':this.pasteClips();break;
      case 'select-all':{if(this.ui.mode==='waveform'){this.store.state.selection={start:0,end:this.duration()};this.renderRange();}else this.store.select(this.store.state.selectedTrackId,this.store.state.tracks.flatMap(t=>t.clips.map(c=>c.id)));break;}
      case 'clear-selection':this.store.state.selection={start:0,end:0};this.ui.spectralBand=null;this.renderRange();break;
      case 'trim-selection':this.trimSelection();break;
      case 'lock':this.store.execute('Toggle clip lock',state=>{const clips=state.tracks.flatMap(t=>t.clips).filter(c=>state.selectedClipIds.includes(c.id)),locked=clips.some(c=>!c.locked);clips.forEach(c=>c.locked=locked);});break;
      case 'crossfade':this.crossfade();break;
      case 'import':$('file-input').click();break;
      case 'save':await this.saveProject();break;case 'restore':await this.restoreProject();break;
      case 'new':this.newSessionDialog();break;case 'demo':this.dialog('Open demo session',`<p>Replace the current session with <strong>Midnight Signal</strong>, an original six-track arrangement synthesized entirely on this device.</p><p>Save your current project first to keep a portable copy.</p>`,'Open demo',async()=>{await this.loadDemo();});break;
      case 'session':this.sessionDialog();break;case 'export':this.exportDialog();break;case 'add-marker':this.addMarker();break;
      case 'add-effect':this.addEffectDialog();break;
      case 'rack-power':this.store.execute('Toggle effects rack',()=>{const track=this.selectedTrack(),enable=!track.effects.some(f=>f.enabled);track.effects.forEach(f=>f.enabled=enable);});break;
      case 'spectral-process':this.spectralDialog();break;
      case 'noise-gate':this.gateDialog();break;
      case 'gain':this.gainDialog();break;
      case 'properties':this.setDock('properties');break;case 'mixer':this.setDock('mixer');break;case 'analysis':this.setDock('spectrum');break;case 'markers':this.setDock('markers');break;
      case 'reset-peaks':this.ui.heldPeaks=[0,0];this.updateMeters();break;
      case 'goto':this.gotoDialog();break;case 'shortcuts':this.shortcutsDialog();break;case 'about':this.aboutDialog();break;
      default:throw new Error(`Unknown command: ${name}`);
    }
  }
  setTool(tool){this.ui.tool=tool;this.renderChrome();this.setStatus({move:'Move: drag clips. Drag edges to trim, diamonds to fade. Hold Shift to bypass snapping.',range:'Time selection: drag a range. In spectral view, drag a time/frequency rectangle.',razor:'Razor: click inside a clip to split it.',hand:'Hand: drag the timeline to pan. Ctrl / ⌘ + wheel zooms around the pointer.'}[tool]);}
  setMode(mode){
    if(mode===this.ui.mode)return;
    if(this.engine.recording){this.toast('Stop recording before switching editors.');return;}
    if(mode==='waveform'&&!this.focused()){
      const first=this.selectedTrack().clips[0]||this.store.state.tracks.flatMap(t=>t.clips)[0];if(!first){this.toast('Import and select an audio clip to open the waveform editor.');return;}
      const found=findClip(this.store.state,first.id);this.store.select(found.track.id,[first.id]);
    }
    this.engine.stop();this.store.state.selection={start:0,end:0};this.store.state.loop.enabled=false;this.ui.spectralBand=null;
    if(mode==='waveform'){this.ui.multiView=[this.ui.viewStart,this.ui.viewEnd];this.ui.viewStart=0;this.ui.viewEnd=this.focused().clip.duration;}
    else{[this.ui.viewStart,this.ui.viewEnd]=this.ui.multiView;this.ui.spectral=false;}
    this.ui.mode=mode;$('timeline-scroll').scrollTop=0;this.renderAll();
  }
  setDock(name){
    this.ui.dock=name;document.querySelectorAll('[data-dock]').forEach(button=>{const active=button.dataset.dock===name;button.classList.toggle('active',active);button.setAttribute('aria-selected',active);});document.querySelectorAll('.dock-pane').forEach(pane=>pane.classList.toggle('active',pane.id===`${name}-pane`));
    $('dock-info').textContent={mixer:'TRACK MIXER',spectrum:'REAL AUDIO ANALYSIS',markers:'SESSION MARKERS',properties:'SOURCE METADATA'}[name];if(name==='spectrum')this.drawSpectrum();
  }
  selectAsset(id){
    const found=this.store.state.tracks.flatMap(track=>track.clips.map(clip=>({track,clip}))).find(x=>x.clip.assetId===id);this.ui.selectedAssetId=id;
    if(found){if(this.ui.mode==='waveform'){this.engine.stop();this.ui.viewStart=0;this.ui.viewEnd=found.clip.duration;}this.store.select(found.track.id,[found.clip.id]);}else this.renderFiles();
  }
  toggleTrack(id,key){
    this.skipAudioRefresh=true;this.store.execute(`${key==='armed'?'Arm':key==='mute'?'Mute':'Solo'} track`,state=>{const track=state.tracks.find(t=>t.id===id);if(key==='armed'){const value=!track.armed;state.tracks.forEach(t=>t.armed=false);track.armed=value;}else track[key]=!track[key];});this.skipAudioRefresh=false;this.engine.updateMix();
  }
  async seek(time){await this.engine.seek(clamp(time,0,Math.max(this.duration(),this.engine.recording?14400:0)));if(time<this.ui.viewStart||time>this.ui.viewEnd){const span=this.span();this.ui.viewStart=Math.max(0,time-span*.25);this.ui.viewEnd=this.ui.viewStart+span;this.renderTimeline();this.updateOverviewWindow();}this.renderTransport();}
  fit(){this.ui.viewStart=0;this.ui.viewEnd=Math.max(.01,this.duration()*(this.ui.mode==='waveform'?1:1.06));this.renderTimeline();this.overviewDirty=true;}
  setZoomSpan(span,anchor=this.engine.position){const oldSpan=this.span(),relative=clamp((anchor-this.ui.viewStart)/oldSpan,0,1);span=clamp(span,.005,Math.max(40,this.duration()*1.3));this.ui.viewStart=Math.max(0,anchor-span*relative);this.ui.viewEnd=this.ui.viewStart+span;this.renderTimeline();this.updateOverviewWindow();}
  zoom(factor,anchor){this.setZoomSpan(this.span()/factor,anchor);}
  timeAt(clientX){return Math.max(0,this.ui.viewStart+(clientX-$('lane-wrap').getBoundingClientRect().left)/this.pps());}
  snapTime(time,bypass=false,exclude=[]){
    if(!this.ui.snap||bypass)return Math.max(0,time);
    const beat=60/this.store.state.tempo,quantum={beat,bar:beat*4,half:beat/2,time:.1}[this.ui.grid],grid=Math.round(time/quantum)*quantum,tolerance=7/this.pps();let best=grid;
    const candidates=[0,...this.store.state.markers.map(m=>m.time),...this.store.state.tracks.flatMap(t=>t.clips.filter(c=>!exclude.includes(c.id)).flatMap(c=>[c.start,clipEnd(c)]))];
    for(const t of candidates)if(Math.abs(t-time)<Math.min(tolerance,Math.abs(best-time)))best=t;
    return Math.max(0,best);
  }
  onTimelineDown(event){
    if(event.button!==0&&event.button!==1)return;if(this.engine.recording)return;
    if(event.target.closest('[data-auto-track]'))return;
    const bounds=$('lane-wrap').getBoundingClientRect(),x=event.clientX,y=event.clientY,baseTime=this.timeAt(x),row=this.ui.mode==='waveform'?0:Math.floor((y-bounds.top)/this.trackHeight()),clipElement=event.target.closest('[data-clip]'),clipId=clipElement?.dataset.clip;
    if(this.ui.automation&&event.altKey&&this.ui.mode==='multitrack'){event.preventDefault();this.addAutomationAt(event);return;}
    const found=clipId?findClip(this.store.state,clipId):null;
    if(this.ui.tool==='razor'&&found){event.preventDefault();const time=this.snapTime(baseTime,event.shiftKey),at=this.ui.mode==='waveform'?found.clip.start+time:time;this.store.execute('Razor split',state=>splitClips(state,at,[clipId]));return;}
    if(this.ui.tool==='hand'||event.button===1){event.preventDefault();const view=[this.ui.viewStart,this.ui.viewEnd],pps=this.pps();this.pointerGesture(event,move=>{const offset=(move.clientX-x)/pps;this.ui.viewStart=Math.max(0,view[0]-offset);this.ui.viewEnd=this.ui.viewStart+view[1]-view[0];this.renderTimeline();this.updateOverviewWindow();},()=>{});return;}
    const range=this.ui.tool==='range'||(!found&&event.shiftKey)||this.ui.mode==='waveform';
    if(range){
      event.preventDefault();if(found&&!this.store.state.selectedClipIds.includes(clipId))this.store.select(found.track.id,[clipId]);
      let anchor=this.snapTime(baseTime,event.shiftKey),spectral=this.ui.spectral&&this.ui.mode==='waveform'&&this.isSpectralY(y),initialFrequency=spectral?this.frequencyAtY(y):null,moved=false;
      this.store.state.selection={start:anchor,end:anchor};this.ui.spectralBand=null;
      this.pointerGesture(event,move=>{moved=Math.abs(move.clientX-x)>2||Math.abs(move.clientY-y)>2;const time=clamp(this.snapTime(this.timeAt(move.clientX),move.shiftKey),0,this.duration()),start=Math.min(anchor,time),end=Math.max(anchor,time);this.store.state.selection={start,end};if(spectral){const frequency=this.frequencyAtY(move.clientY);this.ui.spectralBand={start,end,low:Math.min(initialFrequency,frequency),high:Math.max(initialFrequency,frequency)};}this.renderRange();},()=>{if(!moved)this.engine.seek(clamp(anchor,0,this.duration())).catch(e=>this.error(e));this.renderRange();});this.renderRange();return;
    }
    if(!found){event.preventDefault();const track=this.store.state.tracks[clamp(row,0,this.store.state.tracks.length-1)];if(track)this.store.select(track.id,[]);this.store.state.selection={start:0,end:0};this.seek(baseTime);return;}
    event.preventDefault();
    if(event.ctrlKey||event.metaKey){const ids=this.store.state.selectedClipIds.includes(clipId)?this.store.state.selectedClipIds.filter(id=>id!==clipId):[...this.store.state.selectedClipIds,clipId];this.store.select(found.track.id,ids);return;}
    const now=performance.now(),last=this.lastClipDown;this.lastClipDown={id:clipId,time:now,x,y};
    if(!event.target.closest('[data-edge],[data-fade]')&&last?.id===clipId&&now-last.time<420&&Math.hypot(x-last.x,y-last.y)<5){this.lastClipDown=null;this.store.select(found.track.id,[clipId]);this.setMode('waveform');return;}
    if(!this.store.state.selectedClipIds.includes(clipId))this.store.select(found.track.id,[clipId]);
    if(found.clip.locked){this.toast('This clip is locked. Use Clip → Unlock clip.');return;}
    const edge=event.target.closest('[data-edge]')?.dataset.edge,fade=event.target.closest('[data-fade]')?.dataset.fade,before=clone(this.store.state),initial=findClip(before,clipId).clip,pps=this.pps();let moved=false;
    const ids=[...this.store.state.selectedClipIds],selected=before.tracks.flatMap((t,i)=>t.clips.filter(c=>ids.includes(c.id)&&!c.locked).map(c=>({trackIndex:i,clip:c}))),initialRow=before.tracks.findIndex(t=>t.id===found.track.id);
    this.pointerGesture(event,move=>{
      const delta=(move.clientX-x)/pps;if(Math.abs(move.clientX-x)<2&&Math.abs(move.clientY-y)<2&&!moved)return;moved=true;this.lastClipDown=null;this.store.state=clone(before);
      const current=findClip(this.store.state,clipId).clip;
      if(edge){const snapped=this.snapTime((edge==='left'?initial.start:clipEnd(initial))+delta,move.shiftKey,ids),d=snapped-(edge==='left'?initial.start:clipEnd(initial));trimClip(current,edge,d,this.assets.get(current.assetId).buffer.duration);}
      else if(fade){current[fade]=clamp(initial[fade]+(fade==='fadeIn'?delta:-delta),0,current.duration/2);}
      else{
        const minStart=Math.min(...selected.map(s=>s.clip.start)),d=Math.max(-minStart,this.snapTime(initial.start+delta,move.shiftKey,ids)-initial.start),targetRow=Math.floor((move.clientY-bounds.top)/this.trackHeight());
        const minIndex=Math.min(...selected.map(s=>s.trackIndex)),maxIndex=Math.max(...selected.map(s=>s.trackIndex)),rowDelta=clamp(targetRow-initialRow,-minIndex,before.tracks.length-1-maxIndex);
        for(const selectedClip of selected){const from=this.store.state.tracks[selectedClip.trackIndex],index=from.clips.findIndex(c=>c.id===selectedClip.clip.id),c=from.clips.splice(index,1)[0];c.start=selectedClip.clip.start+d;this.store.state.tracks[selectedClip.trackIndex+rowDelta].clips.push(c);}
        this.store.state.selectedTrackId=this.store.state.tracks[initialRow+rowDelta].id;
      }
      this.renderTimeline();
    },()=>{if(moved){try{this.store.commitFrom(before,edge?'Trim clip':fade?'Adjust clip fade':'Move clips');}catch(error){this.error(error);}}});
  }
  pointerGesture(event,move,end){
    this.drag={pointerId:event.pointerId};document.body.classList.add('dragging');
    const onMove=e=>{if(e.pointerId===event.pointerId){e.preventDefault();try{move(e);}catch(error){cleanup();this.error(error);}}};
    const onEnd=e=>{if(e.pointerId===event.pointerId){cleanup();end(e);}};
    const cleanup=()=>{window.removeEventListener('pointermove',onMove);window.removeEventListener('pointerup',onEnd);window.removeEventListener('pointercancel',onEnd);this.drag=null;document.body.classList.remove('dragging');};
    window.addEventListener('pointermove',onMove,{passive:false});window.addEventListener('pointerup',onEnd);window.addEventListener('pointercancel',onEnd);
  }
  onRulerDown(event){
    if(event.button!==0||event.target.closest('[data-marker-jump]'))return;event.preventDefault();const anchor=this.snapTime(this.timeAt(event.clientX),event.shiftKey),x=event.clientX;let moved=false;
    this.pointerGesture(event,move=>{if(Math.abs(move.clientX-x)>3)moved=true;if(moved){const t=this.snapTime(this.timeAt(move.clientX),move.shiftKey);this.store.state.selection={start:Math.min(anchor,t),end:Math.max(anchor,t)};this.ui.spectralBand=null;this.renderRange();}},()=>{this.seek(clamp(moved?this.store.state.selection.start:anchor,0,this.duration())).catch(e=>this.error(e));});
  }
  onOverviewDown(event){
    event.preventDefault();const rect=$('navigator').getBoundingClientRect(),duration=this.duration()*1.06,span=this.span();
    const pan=e=>{const t=clamp((e.clientX-rect.left)/rect.width,0,1)*duration;if(span>=duration){this.seek(t);return;}this.ui.viewStart=clamp(t-span/2,0,Math.max(0,duration-span));this.ui.viewEnd=this.ui.viewStart+span;this.renderTimeline();this.updateOverviewWindow();};pan(event);this.pointerGesture(event,pan,()=>{});
  }
  onWheel(event){
    if(event.ctrlKey||event.metaKey){event.preventDefault();const time=this.timeAt(event.clientX);this.zoom(Math.exp(-event.deltaY*.005),time);}
    else if(event.shiftKey||Math.abs(event.deltaX)>Math.abs(event.deltaY)){event.preventDefault();const delta=(event.deltaX||event.deltaY)/this.pps(),span=this.span();this.ui.viewStart=clamp(this.ui.viewStart+delta,0,Math.max(0,this.extent()-span));this.ui.viewEnd=this.ui.viewStart+span;this.renderTimeline();this.updateOverviewWindow();}
  }
  isSpectralY(clientY){if(!this.items?.length)return false;const item=this.items[0],y=clientY-$('timeline-scroll').getBoundingClientRect().top;return y>item.fullY+21+(item.fullHeight-23)*.46;}
  frequencyAtY(clientY){const item=this.items[0],asset=this.assets.get(item.clip.assetId),max=Math.min(20000,asset.buffer.sampleRate/2),top=item.fullY+21+(item.fullHeight-23)*.46,dh=(item.fullHeight-23)*.54,y=clientY-$('timeline-scroll').getBoundingClientRect().top;return clamp(30*Math.pow(max/30,1-clamp((y-top)/dh,0,1)),30,max);}
  addAutomationAt(event){
    const bounds=$('lane-wrap').getBoundingClientRect(),h=this.trackHeight(),row=Math.floor((event.clientY-bounds.top)/h),track=this.store.state.tracks[row];if(!track)return;
    const time=this.snapTime(this.timeAt(event.clientX),event.shiftKey),value=clamp(12-((event.clientY-bounds.top-row*h)-25)/(h-33)*72,-60,12);
    this.store.execute('Add automation point',state=>{const t=state.tracks[row];if(!t.automation.length)t.automation=[{time:0,value:0},{time:sessionEnd(state),value:0}];const existing=t.automation.find(p=>Math.abs(p.time-time)<.001);if(existing)existing.value=value;else t.automation.push({time,value});t.automation.sort((a,b)=>a.time-b.time);});
  }
  onAutomationDown(event){
    const target=event.target.closest('[data-auto-track]');if(!target)return;event.preventDefault();event.stopPropagation();const before=clone(this.store.state),trackId=target.dataset.autoTrack,index=+target.dataset.autoIndex,row=before.tracks.findIndex(t=>t.id===trackId),bounds=$('lane-wrap').getBoundingClientRect(),h=this.trackHeight();
    this.pointerGesture(event,move=>{this.store.state=clone(before);const point=this.store.state.tracks[row].automation[index];point.time=this.snapTime(this.timeAt(move.clientX),move.shiftKey);point.value=clamp(12-((move.clientY-bounds.top-row*h)-25)/(h-33)*72,-60,12);this.renderAutomation();},()=>this.store.commitFrom(before,'Adjust automation point'));
  }
  onKey(event){
    if($('dialog').open)return;
    const editable=event.target.closest('input,textarea,select,[contenteditable=true]');if(editable){if(event.key==='Escape')event.target.blur();return;}
    const mod=event.ctrlKey||event.metaKey,key=event.key.toLowerCase();let command=null;
    if(mod){if(key==='z')command=event.shiftKey?'redo':'undo';else if(key==='y')command='redo';else if(key==='s')command='save';else if(key==='i'||key==='o')command='import';else if(key==='e')command='export';else if(key==='k')command='split';else if(key==='d')command='duplicate';else if(key==='c')command='copy';else if(key==='x')command='cut';else if(key==='v')command='paste';else if(key==='a')command='select-all';else if(key==='n')command='new';}
    else if(key===' '){command='play';}else if(key==='escape'){this.closeMenu();command=this.engine.playing?'stop':'clear-selection';}else if(key==='home')command='start';else if(key==='end')command='end';else if(key==='delete'||key==='backspace')command=event.shiftKey?'ripple-delete':'delete';else if(key==='+'||key==='=')command='zoom-in';else if(key==='-')command='zoom-out';else if(key==='f')command='fit';else if(key==='s')command='snap';else if(key==='l')command='loop';else if(key==='m')command='add-marker';else if(key==='r'&&event.shiftKey)command='record';else if(key==='?')command='shortcuts';else if(key==='arrowleft'||key==='arrowright'){event.preventDefault();const delta=(key==='arrowleft'?-1:1)*(event.shiftKey?5:60/this.store.state.tempo);this.seek(clamp(this.engine.position+delta,0,this.duration()));return;}else if(['v','t','r','h'].includes(key)){event.preventDefault();this.setTool({v:'move',t:'range',r:'razor',h:'hand'}[key]);return;}
    if(command){event.preventDefault();this.action(command).catch(error=>this.error(error));}
  }
  openMenu(name,anchor){
    const menus={
      File:[['New session…','new','new','⌘ N'],['Open / import audio…','import','folder','⌘ I'],['Save portable project…','save','save','⌘ S'],['Restore local autosave','restore','reset',''],null,['Export mixdown…','export','export','⌘ E'],null,['Open demo session…','demo','music','']],
      Edit:[['Undo','undo','undo','⌘ Z'],['Redo','redo','redo','⌘ ⇧ Z'],null,['Cut','cut','cut','⌘ X'],['Copy','copy','copy','⌘ C'],['Paste at playhead','paste','paste','⌘ V'],['Duplicate clips','duplicate','copy','⌘ D'],null,['Delete','delete','trash','⌫'],['Ripple delete clips','ripple-delete','trash','⇧ ⌫'],['Select all','select-all','range','⌘ A'],['Clear time selection','clear-selection','x','Esc']],
      Multitrack:[['Add audio track','add-track','plus',''],['Rename selected track…','rename-track','tracks',''],['Remove selected track…','remove-track','trash',''],null,['Open mixer','mixer','sliders',''],['Show gain automation','automation','eq',''],['Crossfade overlapping clips','crossfade','crossfade',''],null,['Add marker','add-marker','marker','M'],['Loop time selection','loop-selection','loop','L'],['Session settings…','session','settings','']],
      Clip:[['Open waveform editor','waveform','wave',''],['Split at playhead','split','razor','⌘ K'],['Duplicate','duplicate','copy','⌘ D'],['Trim to time selection','trim-selection','range',''],['Toggle clip lock','lock','lock',''],null,['Normalize to −1 dBFS','process-normalize','normalize',''],['Reverse audio','process-reverse','reverse',''],['Fade in selection','process-fade-in','fade',''],['Fade out selection','process-fade-out','fade',''],null,['Clip properties','properties','info','']],
      Effects:[['Add track effect…','add-effect','plus',''],['Toggle effects rack','rack-power','power',''],null,['Amplify…','gain','speaker',''],['Normalize to −1 dBFS','process-normalize','normalize',''],['Match RMS to −18 dBFS','process-match-rms','sliders',''],['Remove DC offset','process-dc','clean',''],['Noise gate…','noise-gate','clean',''],['Silence selection','process-silence','stop',''],null,['Spectral attenuation…','spectral-process','spectrum',''],['Frequency analysis','analysis','spectrum','']],
      View:[['Multitrack editor','multitrack','tracks',''],['Waveform editor','waveform','wave',''],['Toggle spectral display','spectral','spectrum',''],null,['Zoom in','zoom-in','plus','+'],['Zoom out','zoom-out','minus','−'],['Fit session','fit','fit','F'],['Toggle snapping','snap','magnet','S'],null,['Mixer','mixer','sliders',''],['Frequency analysis','analysis','spectrum',''],['Markers','markers','marker',''],['Clip properties','properties','info','']],
      Help:[['Keyboard shortcuts','shortcuts','keyboard','?'],['About Sonora Studio','about','info','']]
    };
    const popup=$('menu-popup');if(!popup.hidden&&popup.dataset.menu===name){this.closeMenu();return;}
    const rect=anchor.getBoundingClientRect();this.showMenu(menus[name],rect.left,rect.bottom+4);popup.dataset.menu=name;anchor.classList.add('active');
  }
  showMenu(items,x,y){
    const popup=$('menu-popup');popup.dataset.menu='';popup.innerHTML=items.map(item=>!item?'<div class="menu-separator"></div>':`<button class="menu-item" data-action="${item[1]}">${icon(item[2])}<span>${item[0]}</span><kbd>${item[3]||''}</kbd></button>`).join('');popup.hidden=false;const width=popup.offsetWidth,height=popup.offsetHeight;popup.style.left=`${Math.max(4,Math.min(x,innerWidth-width-8))}px`;popup.style.top=`${Math.max(4,Math.min(y,innerHeight-height-8))}px`;
  }
  openTrackMenu(anchor){const r=anchor.getBoundingClientRect();this.showMenu([['Rename track…','rename-track','tracks',''],['Add effect…','add-effect','plus',''],['Show gain automation','automation','eq',''],null,['Add audio track','add-track','plus',''],['Remove this track…','remove-track','trash','']],r.left,r.bottom);}
  closeMenu(){$('menu-popup').hidden=true;document.querySelectorAll('[data-menu].active').forEach(b=>b.classList.remove('active'));}
  copyClips(){
    const state=this.store.state,clips=state.tracks.flatMap((track,trackIndex)=>track.clips.filter(c=>state.selectedClipIds.includes(c.id)).map(clip=>({clip:clone(clip),trackIndex})));
    if(!clips.length){this.toast('Select one or more clips to copy.');return;}
    this.ui.clipboard=clips;this.toast(`Copied ${clips.length} clip${clips.length===1?'':'s'}. Paste at the playhead.`);
  }
  pasteClips(){
    const copied=this.ui.clipboard;if(!copied.length){this.toast('The clip clipboard is empty.');return;}
    const origin=Math.min(...copied.map(x=>x.clip.start)),firstTrack=Math.min(...copied.map(x=>x.trackIndex)),at=this.engine.position;
    this.store.execute('Paste clips',state=>{const target=state.tracks.findIndex(t=>t.id===state.selectedTrackId),ids=[];for(const entry of copied){if(!this.assets.has(entry.clip.assetId))continue;const index=target+entry.trackIndex-firstTrack;while(state.tracks.length<=index)state.tracks.push(makeTrack(`Audio ${state.tracks.length+1}`,state.tracks.length));const clip={...clone(entry.clip),id:uid('clip'),start:Math.max(0,at+entry.clip.start-origin),locked:false};state.tracks[index].clips.push(clip);ids.push(clip.id);}state.selectedClipIds=ids;});
  }
  crossfade(){
    let count=0;this.store.execute('Crossfade overlapping clips',state=>{for(const track of state.tracks){const clips=[...track.clips].sort((a,b)=>a.start-b.start);for(let i=1;i<clips.length;i++){const a=clips[i-1],b=clips[i],overlap=clipEnd(a)-b.start;if(overlap>0&&!a.locked&&!b.locked&&(!state.selectedClipIds.length||state.selectedClipIds.includes(a.id)||state.selectedClipIds.includes(b.id))){const duration=Math.min(overlap,a.duration/2,b.duration/2);a.fadeOut=duration;b.fadeIn=duration;count++;}}}});this.toast(count?`Created ${count} linear crossfade${count===1?'':'s'}.`:'Overlap two clips on the same track, then crossfade.');
  }
  selectionInClip(){
    const found=this.focused();if(!found)throw new Error('Select an audio clip first.');const clip=found.clip,range=this.store.state.selection;
    let start=0,end=clip.duration;
    if(range.end-range.start>.00001){const origin=this.ui.mode==='waveform'?0:clip.start;start=Math.max(0,range.start-origin);end=Math.min(clip.duration,range.end-origin);if(end<=start)throw new Error('The time selection does not intersect this clip.');}
    return {...found,start,end,sourceStart:clip.offset+start*clip.rate,sourceEnd:clip.offset+end*clip.rate};
  }
  async processSelection(operation,options={}){
    const selection=this.selectionInClip(),{clip,sourceStart,sourceEnd}=selection;if(clip.locked)throw new Error('Unlock this clip before processing it.');
    const asset=this.assets.get(clip.assetId),originalAssetId=clip.assetId,clipId=clip.id,channels=copyChannels(asset.buffer);
    this.setStatus(`Processing: ${OP_NAMES[operation]||operation}…`);
    const processed=await this.worker.run('process',{channels,sampleRate:asset.buffer.sampleRate,operation,options:{...options,start:sourceStart,end:sourceEnd}},channels.map(c=>c.buffer));
    if(findClip(this.store.state,clipId)?.clip.assetId!==originalAssetId)throw new Error('The clip changed while processing. The result was not applied.');
    const newAsset={id:uid('asset'),name:`${asset.name.replace(/\.[^.]+$/,'')} · ${operation}.wav`,buffer:makeAudioBuffer(processed,asset.buffer.sampleRate)};
    await this.analyzeAsset(newAsset);this.assets.set(newAsset.id,newAsset);
    this.store.execute(OP_NAMES[operation]||operation,state=>{const target=findClip(state,clipId);if(!target||target.clip.assetId!==originalAssetId)throw new Error('The source changed while processing.');target.clip.assetId=newAsset.id;});
    this.ui.selectedAssetId=newAsset.id;this.ui.spectralBand=null;this.renderAll();this.toast(`${OP_NAMES[operation]||operation} applied. Original source preserved.`);this.setStatus('Processing complete. Undo restores the original source.');
  }
  trimSelection(){
    const {clip,start,end}=this.selectionInClip();if(end-start>=clip.duration-.00001){this.toast('Drag a shorter time selection to trim the clip.');return;}if(clip.locked)throw new Error('This clip is locked.');
    this.store.execute('Trim clip to selection',state=>{const c=findClip(state,clip.id).clip;c.offset+=start*c.rate;if(this.ui.mode==='multitrack')c.start+=start;c.duration=end-start;c.fadeIn=Math.min(c.fadeIn,c.duration/2);c.fadeOut=Math.min(c.fadeOut,c.duration/2);state.selection={start:0,end:0};});if(this.ui.mode==='waveform')this.fit();
  }
  async deleteAudioSelection(){
    const {clip,sourceStart,sourceEnd}=this.selectionInClip();if(clip.locked)throw new Error('This clip is locked.');const asset=this.assets.get(clip.assetId),rate=asset.buffer.sampleRate,begin=Math.floor(clip.offset*rate),end=Math.min(asset.buffer.length,Math.ceil((clip.offset+clip.duration*clip.rate)*rate)),cutStart=Math.floor(sourceStart*rate),cutEnd=Math.min(end,Math.ceil(sourceEnd*rate)),length=(cutStart-begin)+(end-cutEnd);
    if(length<=0){this.store.execute('Delete waveform clip',state=>deleteClips(state));return;}
    const channels=Array.from({length:asset.buffer.numberOfChannels},(_,ch)=>{const data=asset.buffer.getChannelData(ch),out=new Float32Array(length);out.set(data.subarray(begin,cutStart));out.set(data.subarray(cutEnd,end),cutStart-begin);return out;});
    const result={id:uid('asset'),name:`${asset.name.replace(/\.[^.]+$/,'')} · edited.wav`,buffer:makeAudioBuffer(channels,rate)};await this.analyzeAsset(result);this.assets.set(result.id,result);
    this.store.execute('Delete audio time selection',state=>{const c=findClip(state,clip.id).clip;c.assetId=result.id;c.offset=0;c.duration=result.buffer.duration/c.rate;state.selection={start:0,end:0};});this.ui.spectralBand=null;this.fit();
  }
  async importFiles(files,drop=null){
    if(!files.length)return;if(this.engine.recording)throw new Error('Stop recording before importing a file.');
    let imported=0;const failures=[];
    for(const file of files){
      try{
        if(file.size>512*1024*1024)throw new Error('Files larger than 512 MB exceed the import safety limit.');
        if(/\.(sonora|json)$/i.test(file.name)){const project=deserializeProject(await file.text());await this.installProject(project);this.toast(`Opened ${project.state.name}.`);continue;}
        this.setStatus(`Decoding ${file.name}…`);const bytes=await file.arrayBuffer();let buffer;
        if(/\.wav(e)?$/i.test(file.name)){
          try{const data=await this.worker.run('decode-wav',{buffer:bytes});buffer=makeAudioBuffer(data.channels,data.sampleRate);}catch{const ctx=await this.engine.ensure();buffer=await ctx.decodeAudioData(bytes.slice(0));}
        }else{const ctx=await this.engine.ensure();try{buffer=await ctx.decodeAudioData(bytes);}catch{throw new Error('The browser cannot decode this format. Convert it to PCM WAV, or use a browser with a matching audio decoder.');}}
        const total=[...this.assets.values()].reduce((sum,a)=>sum+a.buffer.length*a.buffer.numberOfChannels*4,0)+buffer.length*buffer.numberOfChannels*4;if(total>512*1024*1024)throw new Error('Decoded audio would exceed the 512 MB session memory safety limit.');
        const asset={id:uid('asset'),name:file.name,buffer};await this.analyzeAsset(asset);this.assets.set(asset.id,asset);
        this.store.execute(`Import ${file.name}`,state=>{
          let track=drop&&imported===0?state.tracks.find(t=>t.id===drop.trackId):null;
          if(!track&&state.tracks.length===1&&!state.tracks[0].clips.length)track=state.tracks[0];
          if(!track){track=makeTrack(file.name.replace(/\.[^.]+$/,''),state.tracks.length);state.tracks.push(track);}
          if(track.name==='Audio 1')track.name=file.name.replace(/\.[^.]+$/,'');
          const clip=makeClip(asset.id,buffer.duration,drop?.time??0,file.name.replace(/\.[^.]+$/,''));track.clips.push(clip);state.selectedTrackId=track.id;state.selectedClipIds=[clip.id];
        });imported++;
      }catch(error){failures.push(`${file.name}: ${error.message}`);}
    }
    if(imported){this.ui.mode='multitrack';this.ui.spectral=false;this.fit();this.renderAll();this.toast(`Imported ${imported} audio file${imported===1?'':'s'}.`);}
    if(failures.length)this.dialog('Some files could not be imported',failures.map(f=>`<p>${escapeHTML(f)}</p>`).join(''),'Close',async()=>{},false);
    this.setStatus(imported?'Audio imported locally. Nothing was uploaded.':'Ready.');
  }
  async onDrop(event){
    const bounds=$('lane-wrap').getBoundingClientRect(),inside=event.clientX>=bounds.left&&event.clientX<=bounds.right,trackIndex=clamp(Math.floor((event.clientY-bounds.top)/this.trackHeight()),0,this.store.state.tracks.length-1),drop=inside?{trackId:this.store.state.tracks[trackIndex].id,time:this.snapTime(this.timeAt(event.clientX),event.shiftKey)}:null;
    const assetId=event.dataTransfer.getData('application/x-sonora-asset');if(assetId&&this.assets.has(assetId)){
      const asset=this.assets.get(assetId);if(this.ui.mode==='waveform')this.setMode('multitrack');this.store.execute('Insert audio source',state=>{const track=state.tracks.find(t=>t.id===(drop?.trackId||state.selectedTrackId)),clip=makeClip(assetId,asset.buffer.duration,drop?.time??this.engine.position,asset.name.replace(/\.[^.]+$/,''));track.clips.push(clip);state.selectedTrackId=track.id;state.selectedClipIds=[clip.id];});
    }else await this.importFiles([...event.dataTransfer.files],drop);
  }
  async startRecording(){
    if(this.ui.mode==='waveform')this.setMode('multitrack');const track=this.store.state.tracks.find(t=>t.armed)||this.selectedTrack();this.recordTrackId=track.id;
    this.skipAudioRefresh=true;this.store.execute('Arm microphone recording',state=>{state.tracks.forEach(t=>t.armed=t.id===track.id);state.loop.enabled=false;});this.skipAudioRefresh=false;
    if(this.engine.playing)await this.engine.refresh();this.setStatus('Requesting microphone access…');await this.engine.startRecording();this.toast('Recording lossless PCM. Press Record again to stop. Monitoring is off.');this.renderTransport();
  }
  async finishRecording(){
    if(this.stoppingRecord||!this.engine.recording)return;this.stoppingRecord=true;
    try{const recorded=await this.engine.stopRecording();if(!recorded)return;const trackId=this.recordTrackId,asset={id:uid('asset'),name:`Recording ${new Date().toISOString().replace(/[:.]/g,'-')}.wav`,buffer:recorded.buffer};await this.analyzeAsset(asset);this.assets.set(asset.id,asset);
      this.store.execute('Record microphone take',state=>{let track=state.tracks.find(t=>t.id===trackId);if(!track){track=makeTrack('Recording',state.tracks.length);state.tracks.push(track);}const clip=makeClip(asset.id,asset.buffer.duration,recorded.start,`${track.name} · take`);track.clips.push(clip);state.selectedTrackId=track.id;state.selectedClipIds=[clip.id];});this.toast(`Recorded ${formatTime(asset.buffer.duration)} of stereo PCM.`);this.setStatus('Microphone stopped. All capture tracks released.');
    }finally{this.stoppingRecord=false;this.renderTransport();}
  }
  projectData(){return serializeProject(this.store.state,this.assets);}
  readProjectData(text){return deserializeProject(text);}
  async saveProject(){
    if(this.engine.recording)throw new Error('Stop recording before saving the project.');this.setStatus('Packing original audio into a portable project…');await sleep(20);
    const json=serializeProject(this.store.state,this.assets);download(json,`${this.safeFilename(this.store.state.name)}.sonora`,'application/json');this.store.dirty=false;this.renderChrome();try{await this.saveLocalNow();}catch(error){console.warn('Local autosave unavailable:',error.message);}this.toast('Portable project saved, including lossless 32-bit float source audio.');this.setStatus('Project saved.');
  }
  async restoreProject(){const result=await this.storage.load();if(!result){this.toast('No local autosave was found.');return;}await this.installProject(result);this.toast('Local autosave restored.');}
  async installProject(project){
    if(this.engine.recording)await this.finishRecording();this.engine.stop();this.assets.clear();for(const [id,asset]of project.assets)this.assets.set(id,asset);this.ui.mode='multitrack';this.ui.spectral=false;this.ui.spectralBand=null;this.spectralCache.clear();this.store.replace(project.state);await Promise.all([...this.assets.values()].map(a=>this.analyzeAsset(a)));this.ui.selectedAssetId=this.focused()?.clip.assetId||this.assets.keys().next().value;this.fit();this.renderAll();
  }
  autosave(){clearTimeout(this.autosaveTimer);this.autosaveTimer=setTimeout(()=>this.saveLocalNow().catch(error=>{if(!this.autosaveFailed){this.autosaveFailed=true;this.toast(`Local autosave unavailable: ${error.message}. Save a portable project.`,true);}}),1200);}
  async saveLocalNow(){
    if(this.saving){this.autosave();return;}this.saving=true;$('save-state').textContent='Saving locally…';const revision=this.store.revision;
    try{await this.storage.save(clone(this.store.state),new Map(this.assets));$('save-state').textContent='Autosaved';this.autosaveFailed=false;if(revision!==this.store.revision)this.autosave();}
    catch(error){$('save-state').textContent='Autosave unavailable';throw error;}finally{this.saving=false;}
  }
  safeFilename(name){return String(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').slice(0,100)||'Sonora export';}
  applyRackPreset(name){
    const presets={clean:[],warm:[{...makeEffect('eq'),low:2,mid:-1,high:1},makeEffect('compressor'),makeEffect('reverb')],voice:[{...makeEffect('highpass'),frequency:90},{...makeEffect('eq'),low:-2,mid:2,frequency:2500,high:1},{...makeEffect('compressor'),threshold:-24,ratio:3.5}],ambient:[{...makeEffect('eq'),low:-3,high:-1},{...makeEffect('reverb'),mix:.48,decay:3.8},{...makeEffect('delay'),mix:.18,time:.416,feedback:.4}],punch:[{...makeEffect('compressor'),threshold:-16,ratio:4,attack:.02,release:.12},{...makeEffect('distortion'),drive:3,mix:.2}]};
    this.store.execute(`Apply ${name} effects preset`,()=>{this.selectedTrack().effects=presets[name]||[];});
  }
  addEffectDialog(){
    if(this.selectedTrack().effects.length>=16){this.toast('A track supports up to 16 effects.');return;}
    this.dialog('Add a track effect',`<div class="form-field"><label for="effect-type">Effect</label><select id="effect-type" name="type">${Object.entries(EFFECTS).map(([key,fx])=>`<option value="${key}">${fx.name}</option>`).join('')}</select></div><div class="dialog-note">Effects run in the Web Audio graph during playback and offline mixdown. Reorder them in the rack to change the processing chain.</div>`,'Add effect',async form=>{const type=new FormData(form).get('type');this.store.execute(`Add ${EFFECTS[type].short}`,()=>{const fx=makeEffect(type);this.selectedTrack().effects.push(fx);this.ui.effectId=fx.id;});});
  }
  newSessionDialog(){
    this.dialog('New multitrack session',`<p>Create a blank workspace. Save your current project first to retain a portable copy.</p><div class="form-grid"><div class="form-field full"><label>Session name</label><input name="name" value="Untitled session" required maxlength="120"></div><div class="form-field"><label>Tempo</label><input type="number" name="tempo" min="20" max="400" value="120" required></div><div class="form-field"><label>Project sample rate</label><select name="rate"><option value="48000">48,000 Hz</option><option value="44100">44,100 Hz</option><option value="96000">96,000 Hz</option></select></div></div>`,'Create session',async form=>{if(this.engine.recording)await this.finishRecording();this.engine.stop();const data=new FormData(form),state=makeSession();state.name=String(data.get('name'));state.tempo=+data.get('tempo');state.sampleRate=+data.get('rate');this.assets.clear();this.spectralCache.clear();this.ui.mode='multitrack';this.ui.spectral=false;this.ui.selectedAssetId=null;this.ui.viewStart=0;this.ui.viewEnd=30;this.store.replace(state);this.recentHistory=['Created new session'];this.renderAll();});
  }
  sessionDialog(){
    const state=this.store.state;
    this.dialog('Session settings',`<div class="form-grid"><div class="form-field full"><label>Session name</label><input name="name" value="${escapeHTML(state.name)}" maxlength="120" required></div><div class="form-field"><label>Tempo (BPM)</label><input type="number" name="tempo" min="20" max="400" step=".1" value="${state.tempo}" required></div><div class="form-field"><label>Default export rate</label><select name="rate">${[44100,48000,88200,96000].map(r=>`<option value="${r}" ${r===state.sampleRate?'selected':''}>${r.toLocaleString()} Hz</option>`).join('')}</select></div></div><div class="dialog-note">Tempo controls the beat grid; it does not stretch existing audio. Source sample rates are retained. Playback uses the actual AudioContext rate; offline export resamples to the rate you choose.</div>`,'Apply',async form=>{const data=new FormData(form);this.store.execute('Update session settings',s=>{s.name=String(data.get('name'));s.tempo=+data.get('tempo');s.sampleRate=+data.get('rate');});});
  }
  renameTrack(id){const track=this.store.state.tracks.find(t=>t.id===id);if(!track)return;this.dialog('Rename track',`<div class="form-field"><label>Track name</label><input name="name" value="${escapeHTML(track.name)}" maxlength="100" required></div><div class="form-field" style="margin-top:15px"><label>Track color</label><input type="color" name="color" value="${track.color}" style="width:100%"></div>`,'Apply',async form=>{const data=new FormData(form);this.store.execute('Rename / recolor track',state=>{const target=state.tracks.find(t=>t.id===id);target.name=String(data.get('name'));target.color=String(data.get('color'));});});}
  removeTrack(){const track=this.selectedTrack();this.dialog('Remove track',`<p>Remove <strong>${escapeHTML(track.name)}</strong> and its ${track.clips.length} clips from the session?</p><p>The source audio stays in the Files panel. This edit can be undone.</p>`,'Remove track',async()=>{this.store.execute('Remove audio track',state=>{state.tracks=state.tracks.filter(t=>t.id!==track.id);if(!state.tracks.length)state.tracks.push(makeTrack('Audio 1'));state.selectedTrackId=state.tracks[0].id;state.selectedClipIds=[];});});}
  addMarker(){const time=this.ui.mode==='waveform'?this.engine.position+(this.focused()?.clip.start||0):this.engine.position;this.store.execute('Add session marker',state=>{state.markers.push({id:uid('marker'),name:`Marker ${state.markers.length+1}`,time});state.markers.sort((a,b)=>a.time-b.time);});this.toast(`Marker added at ${formatTime(time)}.`);}
  spectralDialog(){
    if(!this.focused()){this.toast('Select an audio clip first.');return;}
    const band=this.ui.spectralBand;
    this.dialog('Spectral attenuation',`<p>Attenuate a frequency band in the selected time range. Processing uses a 2048-point STFT, 75% overlap, square-root Hann windows, and normalized overlap-add.</p><div class="form-grid"><div class="form-field"><label>Low frequency (Hz)</label><input type="number" name="low" min="20" max="20000" step="1" value="${Math.round(band?.low||200)}" required></div><div class="form-field"><label>High frequency (Hz)</label><input type="number" name="high" min="20" max="20000" step="1" value="${Math.round(band?.high||2000)}" required></div><div class="form-field full"><label>Attenuation (dB)</label><input type="number" name="db" min="-90" max="0" step="1" value="-30" required></div></div><div class="dialog-note">This is frequency-band attenuation, not AI source separation or adaptive noise-print restoration. The source remains recoverable through Undo.</div>`,'Process audio',async form=>{const data=new FormData(form),low=+data.get('low'),high=+data.get('high');if(high<=low)throw new Error('The high frequency must be greater than the low frequency.');await this.processSelection('spectral',{low,high,db:+data.get('db')});});
  }
  gateDialog(){this.dialog('Noise gate',`<p>Attenuate low-level material with a smoothed amplitude gate. Select a time range first to limit processing.</p><div class="form-field"><label>Threshold (dBFS)</label><input type="number" name="threshold" min="-90" max="-5" value="-40" required></div><div class="dialog-note">3 ms envelope attack, 80 ms release. This does not remove noise beneath louder signals.</div>`,'Apply gate',async form=>this.processSelection('gate',{threshold:+new FormData(form).get('threshold')}));}
  gainDialog(){this.dialog('Amplify audio',`<div class="form-field"><label>Gain change (dB)</label><input type="number" name="db" min="-90" max="36" step=".1" value="3" required></div><div class="dialog-note">Float sources can exceed full scale. Watch the output sample-peak meter, or normalize when exporting integer PCM.</div>`,'Apply gain',async form=>this.processSelection('gain',{db:+new FormData(form).get('db')}));}
  gotoDialog(){this.dialog('Go to time',`<div class="form-field"><label>Time (seconds or mm:ss.sss)</label><input name="time" value="${formatTime(this.engine.position)}" required></div>`,'Go',async form=>{const text=String(new FormData(form).get('time')),parts=text.split(':').map(Number);if(parts.some(n=>!Number.isFinite(n))||parts.length>3)throw new Error('Enter seconds or a valid timecode.');const time=parts.reduce((sum,n)=>sum*60+n,0);await this.seek(time);});}
  exportDialog(){
    if(this.engine.recording){this.toast('Stop recording before exporting.');return;}
    const selection=this.store.state.selection,hasRange=selection.end-selection.start>.0001,focus=this.focused(),defaultName=this.ui.mode==='waveform'?(focus?.clip.name||this.store.state.name):this.store.state.name;
    this.dialog('Export audio mixdown',`<div class="form-grid"><div class="form-field full"><label>File name</label><input name="filename" value="${escapeHTML(defaultName)}" required maxlength="120"></div><div class="form-field"><label>Range</label><select name="scope"><option value="session" ${this.ui.mode==='multitrack'?'selected':''}>Entire multitrack session</option>${focus?`<option value="clip" ${this.ui.mode==='waveform'?'selected':''}>Selected clip + track effects</option>`:''}${hasRange?'<option value="selection">Selected time range (active editor)</option>':''}</select></div><div class="form-field"><label>Format</label><select name="depth"><option value="24">WAV · 24-bit PCM</option><option value="16">WAV · 16-bit PCM</option><option value="32">WAV · 32-bit float</option></select></div><div class="form-field"><label>Sample rate</label><select name="rate">${[44100,48000,88200,96000].map(rate=>`<option value="${rate}" ${rate===this.store.state.sampleRate?'selected':''}>${rate.toLocaleString()} Hz</option>`).join('')}</select></div><div class="form-field"><label>Channels</label><select name="channels"><option value="2">Stereo</option><option value="1">Mono (L + R) / 2</option></select></div><label class="checkbox-field full" style="grid-column:1/-1"><input name="normalize" type="checkbox">Peak-normalize mix to −1 dBFS</label><label class="checkbox-field full" style="grid-column:1/-1"><input name="dither" type="checkbox" checked>TPDF dither for integer PCM</label><label class="checkbox-field full" style="grid-column:1/-1"><input name="tail" type="checkbox" checked>Include a 2-second effects tail</label></div><div class="dialog-note">Offline render includes clip edits, fades, varispeed, track effects, pan, mute/solo, gain automation and master gain. No network upload.</div>`,'Render & export',async form=>{
      const data=new FormData(form),scope=data.get('scope'),sampleRate=+data.get('rate');let state=clone(this.store.state),start=0,end=sessionEnd(state);
      if(scope==='clip'){const selected=this.focused();if(!selected)throw new Error('No clip is selected.');state.tracks=[{...clone(selected.track),mute:false,solo:false,automation:[],clips:[{...clone(selected.clip),start:0}]}];end=selected.clip.duration;}
      else if(scope==='selection'){state=clone(this.playbackState());start=state.selection.start;end=state.selection.end;}
      const renderer=new AudioEngine(()=>state,this.assets);this.setStatus('Rendering the audio graph offline…');const buffer=await renderer.render({start,end,sampleRate,tail:data.has('tail')?2:0,normalize:data.has('normalize')});
      let channels=copyChannels(buffer);if(+data.get('channels')===1){const mono=new Float32Array(buffer.length);for(let i=0;i<mono.length;i++)mono[i]=(channels[0][i]+channels[1][i])*.5;channels=[mono];}
      const wav=await this.worker.run('wav',{channels,sampleRate,bitDepth:+data.get('depth'),dither:data.has('dither')},channels.map(c=>c.buffer));
      const name=`${this.safeFilename(String(data.get('filename')).replace(/\.wav$/i,''))}.wav`;download(wav,name,'audio/wav');this.toast(`Exported ${name} · ${(wav.byteLength/1024/1024).toFixed(1)} MB.`);this.setStatus('Mixdown exported successfully.');
    });
  }
  shortcutsDialog(){
    const rows=[['Play / pause','Space'],['Stop / clear time selection','Esc'],['Move / time / razor / hand','V / T / R / H'],['Import audio','⌘ / Ctrl I'],['Save project','⌘ / Ctrl S'],['Export mixdown','⌘ / Ctrl E'],['Undo / redo','⌘ Z / ⌘ Shift Z'],['Split at playhead','⌘ / Ctrl K'],['Duplicate selected clips','⌘ / Ctrl D'],['Copy / cut / paste clips','⌘ C / X / V'],['Delete / ripple delete','Delete / Shift Delete'],['Add marker / toggle loop','M / L'],['Record microphone','Shift R'],['Zoom / fit','+ / − / F'],['Snap / temporarily bypass','S / hold Shift'],['Multiselect clips','⌘ / Ctrl-click'],['Pan / pointer-anchored zoom','Shift-wheel / Ctrl-wheel'],['Add / remove automation point','Alt-click / right-click'],['Open waveform editor','Double-click a clip']];
    this.dialog('Keyboard shortcuts',`<table class="shortcuts-table">${rows.map(r=>`<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('')}</table>`,'Done',async()=>{},false);
  }
  aboutDialog(){
    this.dialog('Sonora Studio 1.0',`<p style="font-size:17px;color:#d0e5d5;letter-spacing:-.4px">Audio, in its element.</p><p>A dependency-free, local-first audio workstation built with plain HTML, CSS, JavaScript, WebGPU and Web Audio. The workflow is inspired by traditional multitrack editors, with original branding and interface assets.</p><p><strong>Real engine:</strong> immutable audio sources, transactional edit history, peak pyramids, GPU-instanced waveforms, native audio scheduling, PCM worklet recording, STFT spectral processing, and offline WAV mixdown.</p><p><strong>Scope:</strong> this is an independent implementation, not Adobe Audition or a complete Audition replacement. No VST/AU hosting, SESX import, MP3 encoding, pitch-preserving time stretch, certified LUFS/true-peak analysis, or automatic noise-print restoration.</p><p><strong>Privacy:</strong> audio processing runs on your device. Projects can autosave in this browser’s IndexedDB. Portable .sonora files include the used audio sources. Clearing site data removes autosaves.</p><div class="dialog-note">The demo music is generated mathematically on this device. No Adobe code, artwork, fonts, or recordings are included.</div>`,'Back to the studio',async()=>{},false);
  }
  dialog(title,body,submitLabel,onSubmit,showCancel=true){
    const dialog=$('dialog');if(dialog.open)dialog.close();dialog.innerHTML=`<form id="dialog-form"><div class="dialog-header"><h2>${escapeHTML(title)}</h2><button type="button" class="icon-btn" data-dialog-close title="Close" aria-label="Close dialog">${icon('x')}</button></div><div class="dialog-body">${body}<div class="dialog-error" id="dialog-error" role="alert"></div></div><div class="dialog-footer">${showCancel?'<button type="button" data-dialog-close>Cancel</button>':''}<button type="submit" class="primary" id="dialog-submit">${escapeHTML(submitLabel)}</button></div></form>`;
    dialog.querySelectorAll('[data-dialog-close]').forEach(button=>button.onclick=()=>dialog.close());
    dialog.querySelector('form').onsubmit=async event=>{event.preventDefault();const form=event.currentTarget,button=form.querySelector('#dialog-submit');button.disabled=true;button.textContent='Working…';form.querySelector('#dialog-error').textContent='';try{await onSubmit(form);if(dialog.open)dialog.close();}catch(error){form.querySelector('#dialog-error').textContent=error.message;console.error(error);}finally{if(button.isConnected){button.disabled=false;button.textContent=submitLabel;}}};
    dialog.showModal();const input=dialog.querySelector('input:not([type=checkbox]):not([type=color])');if(input){input.focus();input.select();}
  }
  setStatus(text){$('status-message').textContent=text;$('status-message').title=text;}
  toast(text,error=false){const element=document.createElement('div');element.className=`toast${error?' error':''}`;element.innerHTML=`${icon(error?'alert':'check')}<span>${escapeHTML(text)}</span>`;$('toast-container').append(element);setTimeout(()=>element.remove(),error?9000:4500);}
  error(error){console.error(error);this.toast(error.message||String(error),true);this.setStatus(error.message||String(error));}
}
const app=new SonoraApp();
window.__sonora=app;
app.init().catch(error=>{console.error(error);$('loading-message').textContent=`Unable to start: ${error.message}`;const card=document.querySelector('.loading-card');const button=document.createElement('button');button.className='small-button';button.textContent='Reset local session & reload';button.style.marginTop='20px';button.onclick=()=>{indexedDB.deleteDatabase('sonora-studio');location.reload();};card.append(button);});
