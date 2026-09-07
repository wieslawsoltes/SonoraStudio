import {clamp,dbToGain,gainToDb,sessionEnd,fadeGain,automationDb,uid} from './model.js';
import {makeAudioBuffer} from './worker-client.js';
export const EFFECTS = {
  eq:{name:'Parametric equalizer',short:'Parametric EQ',defaults:{low:0,mid:0,high:0,frequency:1200},controls:[['low','Low shelf',-24,24,.1,'dB'],['mid','Mid band',-24,24,.1,'dB'],['frequency','Mid frequency',100,10000,10,'Hz'],['high','High shelf',-24,24,.1,'dB']]},
  compressor:{name:'Dynamics compressor',short:'Compressor',defaults:{threshold:-22,ratio:3,attack:.01,release:.18},controls:[['threshold','Threshold',-60,0,.5,'dB'],['ratio','Ratio',1,20,.1,':1'],['attack','Attack',.001,.2,.001,'s'],['release','Release',.02,1,.01,'s']]},
  reverb:{name:'Convolution reverb',short:'Studio Reverb',defaults:{mix:.18,decay:1.8},controls:[['mix','Wet mix',0,1,.01,''],['decay','Decay',.1,5,.1,'s']]},
  delay:{name:'Stereo echo',short:'Analog Delay',defaults:{mix:.2,time:.278,feedback:.3},controls:[['time','Delay time',.01,2,.001,'s'],['feedback','Feedback',0,.85,.01,''],['mix','Wet mix',0,1,.01,'']]},
  highpass:{name:'High-pass filter',short:'High-pass Filter',defaults:{frequency:80},controls:[['frequency','Cutoff',20,5000,1,'Hz']]},
  lowpass:{name:'Low-pass filter',short:'Low-pass Filter',defaults:{frequency:8000},controls:[['frequency','Cutoff',200,20000,10,'Hz']]},
  distortion:{name:'Saturation',short:'Saturation',defaults:{drive:8,mix:.3},controls:[['drive','Drive',0,50,.5,''],['mix','Wet mix',0,1,.01,'']]}
};
export const makeEffect=type=>({id:uid('fx'),type,enabled:true,...EFFECTS[type].defaults});
const impulseCache=new Map();
function impulse(context,seconds){
  const key=`${context.sampleRate}:${seconds}`;if(impulseCache.has(key))return impulseCache.get(key);
  const length=Math.ceil(context.sampleRate*seconds),buffer=context.createBuffer(2,length,context.sampleRate);
  let seed=534132;const noise=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return(seed>>>0)/2147483648-1;};
  for(let ch=0;ch<2;ch++){const d=buffer.getChannelData(ch);for(let i=0;i<length;i++){const t=i/context.sampleRate;d[i]=noise()*Math.pow(1-i/length,2.8)*Math.min(1,t*300);}}
  if(impulseCache.size>12)impulseCache.delete(impulseCache.keys().next().value);impulseCache.set(key,buffer);return buffer;
}
function effectChain(context,input,effects,nodes){
  const add=node=>(nodes.push(node),node);let current=input;
  for(const fx of effects){
    if(!fx.enabled)continue;
    if(fx.type==='eq'){
      const low=add(context.createBiquadFilter()),mid=add(context.createBiquadFilter()),high=add(context.createBiquadFilter());
      low.type='lowshelf';low.frequency.value=120;low.gain.value=fx.low;
      mid.type='peaking';mid.frequency.value=fx.frequency;mid.Q.value=.9;mid.gain.value=fx.mid;
      high.type='highshelf';high.frequency.value=6000;high.gain.value=fx.high;
      current.connect(low);low.connect(mid);mid.connect(high);current=high;
    }else if(fx.type==='compressor'){
      const node=add(context.createDynamicsCompressor());node.threshold.value=fx.threshold;node.knee.value=12;node.ratio.value=fx.ratio;node.attack.value=fx.attack;node.release.value=fx.release;current.connect(node);current=node;
    }else if(fx.type==='highpass'||fx.type==='lowpass'){
      const node=add(context.createBiquadFilter());node.type=fx.type;node.frequency.value=Math.min(fx.frequency,context.sampleRate*.49);node.Q.value=.707;current.connect(node);current=node;
    }else if(['delay','reverb','distortion'].includes(fx.type)){
      const sum=add(context.createGain()),dry=add(context.createGain()),wet=add(context.createGain());
      dry.gain.value=1-fx.mix;wet.gain.value=fx.mix;current.connect(dry);dry.connect(sum);wet.connect(sum);
      if(fx.type==='reverb'){
        const convolver=add(context.createConvolver());convolver.buffer=impulse(context,fx.decay);current.connect(convolver);convolver.connect(wet);
      }else if(fx.type==='delay'){
        const delay=add(context.createDelay(2.1)),feedback=add(context.createGain()),filter=add(context.createBiquadFilter());
        delay.delayTime.value=fx.time;feedback.gain.value=fx.feedback;filter.type='lowpass';filter.frequency.value=4500;
        current.connect(delay);delay.connect(wet);delay.connect(filter);filter.connect(feedback);feedback.connect(delay);
      }else{
        const shaper=add(context.createWaveShaper()),curve=new Float32Array(4097),drive=1+fx.drive*.3,normal=Math.tanh(drive);
        for(let i=0;i<curve.length;i++)curve[i]=Math.tanh((i/(curve.length-1)*2-1)*drive)/normal;
        shaper.curve=curve;shaper.oversample='2x';current.connect(shaper);shaper.connect(wet);
      }
      current=sum;
    }
  }
  return current;
}
function buildGraph(context,state,metering=true){
  const nodes=[],add=node=>(nodes.push(node),node),master=add(context.createGain()),output=add(context.createGain());
  master.gain.value=dbToGain(state.masterGain);master.connect(output);output.connect(context.destination);
  const tracks=new Map(),solo=state.tracks.some(t=>t.solo);
  for(const track of state.tracks){
    const input=add(context.createGain()),pan=add(context.createStereoPanner()),fader=add(context.createGain()),automation=add(context.createGain());
    const end=effectChain(context,input,track.effects,nodes);end.connect(pan);pan.connect(fader);fader.connect(automation);automation.connect(master);
    pan.pan.value=track.pan;fader.gain.value=track.mute||(solo&&!track.solo)?0:dbToGain(track.gain);
    let analyser=null;if(metering){analyser=add(context.createAnalyser());analyser.fftSize=1024;automation.connect(analyser);}
    tracks.set(track.id,{input,pan,fader,automation,analyser});
  }
  let analyser=null,left=null,right=null;
  if(metering){
    analyser=add(context.createAnalyser());analyser.fftSize=4096;analyser.smoothingTimeConstant=.75;master.connect(analyser);
    const splitter=add(context.createChannelSplitter(2));master.connect(splitter);
    left=add(context.createAnalyser());right=add(context.createAnalyser());left.fftSize=right.fftSize=2048;splitter.connect(left,0);splitter.connect(right,1);
  }
  return {tracks,master,output,nodes,analyser,left,right};
}
function scheduleRange(context,graph,state,assets,from,to,when,sources){
  if(to<=from)return;
  for(const track of state.tracks){
    const node=graph.tracks.get(track.id);if(!node)continue;
    // Linear interpolation in dB is exponential in amplitude. This keeps seeks
    // consistent with full-range playback; the validated gain is always positive.
    const points=track.automation||[];
    node.automation.gain.setValueAtTime(dbToGain(automationDb(points,from)),when);
    for(const point of points)if(point.time>from&&point.time<to)node.automation.gain.exponentialRampToValueAtTime(dbToGain(point.value),when+point.time-from);
    if(points.length)node.automation.gain.exponentialRampToValueAtTime(dbToGain(automationDb(points,to)),when+to-from);
    for(const clip of track.clips){
      const begin=Math.max(from,clip.start),end=Math.min(to,clip.start+clip.duration);
      if(end<=begin)continue;
      const asset=assets.get(clip.assetId);if(!asset)continue;
      const source=context.createBufferSource(),gain=context.createGain(),local=begin-clip.start,duration=end-begin,at=when+begin-from;
      source.buffer=asset.buffer;source.playbackRate.value=clip.rate;
      gain.gain.setValueAtTime(fadeGain(clip,local),at);
      const breaks=[clip.fadeIn,clip.duration-clip.fadeOut,clip.duration].filter(t=>t>local&&t<local+duration).sort((a,b)=>a-b);
      for(const point of breaks)gain.gain.linearRampToValueAtTime(fadeGain(clip,point),at+point-local);
      gain.gain.linearRampToValueAtTime(fadeGain(clip,local+duration),at+duration);
      source.connect(gain);gain.connect(node.input);sources?.add(source);
      source.onended=()=>{source.disconnect();gain.disconnect();sources?.delete(source);};
      const offset=clip.offset+local*clip.rate,available=Math.max(0,asset.buffer.duration-offset),sourceDuration=Math.min(available,duration*clip.rate);
      if(sourceDuration>0){source.start(at,offset,sourceDuration);source.stop(at+duration+.00001);}else{source.disconnect();gain.disconnect();sources?.delete(source);}
    }
  }
}
export class AudioEngine extends EventTarget {
  constructor(getState,assets){
    super();this.getState=getState;this.assets=assets;this.context=null;this.graph=null;this.sources=new Set();this.playing=false;this.heldPosition=0;this.anchorPosition=0;this.anchorTime=0;this.timer=0;this.generation=0;
    this.meterData=new Float32Array(2048);this.trackData=new Float32Array(1024);this.recording=null;this.loop=null;this.workletReady=false;
  }
  async ensure(){
    if(!this.context){this.context=new AudioContext({latencyHint:'interactive',sampleRate:48000});this.context.onstatechange=()=>this.dispatchEvent(new Event('contextchange'));}
    if(this.context.state!=='running')await this.context.resume();return this.context;
  }
  get position(){
    if(!this.playing||!this.context)return this.heldPosition;
    const elapsed=Math.max(0,this.context.currentTime-this.anchorTime),position=this.anchorPosition+elapsed;
    if(this.loop&&position>=this.loop.end)return this.loop.start+(position-this.loop.end)%(this.loop.end-this.loop.start);
    return position;
  }
  async play(from=this.heldPosition){
    const token=++this.generation,context=await this.ensure();if(token!==this.generation)return;
    this.halt(false);const state=this.getState();this.anchorPosition=Math.max(0,from);this.heldPosition=this.anchorPosition;
    this.anchorTime=context.currentTime+.035;this.graph=buildGraph(context,state,true);this.playing=true;
    this.graph.output.gain.setValueAtTime(0,context.currentTime);this.graph.output.gain.linearRampToValueAtTime(1,this.anchorTime);
    this.loop=state.loop?.enabled?{...state.loop}:null;
    if(this.loop&&from>=this.loop.end){this.anchorPosition=this.loop.start;this.heldPosition=this.loop.start;}
    this.endTime=sessionEnd(state);
    const firstEnd=this.loop?this.loop.end:this.endTime;
    scheduleRange(context,this.graph,state,this.assets,this.anchorPosition,firstEnd,this.anchorTime,this.sources);
    this.nextLoopTime=this.anchorTime+firstEnd-this.anchorPosition;
    this.timer=setInterval(()=>this.pump(),25);this.dispatchEvent(new Event('transport'));
  }
  pump(){
    if(!this.playing)return;
    if(this.loop){
      let guard=0;while(this.context.currentTime+.2>=this.nextLoopTime&&guard++<10){scheduleRange(this.context,this.graph,this.getState(),this.assets,this.loop.start,this.loop.end,this.nextLoopTime,this.sources);this.nextLoopTime+=this.loop.end-this.loop.start;}
    }else if(this.position>=this.endTime&&!this.recording){this.pause();this.heldPosition=this.endTime;this.dispatchEvent(new Event('ended'));}
    if(this.recording&&this.recording.frames>this.context.sampleRate*900)this.dispatchEvent(new Event('recordlimit'));
  }
  halt(keepPosition=true){
    if(keepPosition)this.heldPosition=this.position;this.playing=false;clearInterval(this.timer);
    const graph=this.graph;this.graph=null;
    if(graph){const now=this.context.currentTime;graph.output.gain.cancelScheduledValues(now);graph.output.gain.setValueAtTime(graph.output.gain.value,now);graph.output.gain.linearRampToValueAtTime(0,now+.012);for(const source of this.sources){try{source.stop(now+.015);}catch{}}const oldSources=this.sources;this.sources=new Set();setTimeout(()=>{for(const node of graph.nodes)try{node.disconnect();}catch{}oldSources.clear();},80);}
  }
  pause(){this.generation++;this.halt(true);this.dispatchEvent(new Event('transport'));}
  stop(position=0){this.generation++;this.halt(false);this.heldPosition=Math.max(0,position);this.dispatchEvent(new Event('transport'));}
  async seek(position){position=clamp(position,0,14400);if(this.playing)await this.play(position);else{this.heldPosition=position;this.dispatchEvent(new Event('transport'));}}
  async refresh(){if(this.playing)await this.play(this.position);}
  updateMix(){
    if(!this.graph)return;const state=this.getState(),now=this.context.currentTime,solo=state.tracks.some(t=>t.solo);
    this.graph.master.gain.setTargetAtTime(dbToGain(state.masterGain),now,.012);
    for(const track of state.tracks){const node=this.graph.tracks.get(track.id);if(node){node.fader.gain.setTargetAtTime(track.mute||(solo&&!track.solo)?0:dbToGain(track.gain),now,.012);node.pan.pan.setTargetAtTime(track.pan,now,.012);}}
  }
  meters(){
    const read=node=>{if(!node)return {peak:0,rms:0};const data=this.meterData;node.getFloatTimeDomainData(data);let peak=0,sum=0;for(const value of data){peak=Math.max(peak,Math.abs(value));sum+=value*value;}return {peak,rms:Math.sqrt(sum/data.length)};};
    const tracks={};if(this.graph)for(const [id,node] of this.graph.tracks){node.analyser.getFloatTimeDomainData(this.trackData);let peak=0;for(const x of this.trackData)peak=Math.max(peak,Math.abs(x));tracks[id]=peak;}
    return {left:read(this.graph?.left),right:read(this.graph?.right),tracks};
  }
  async render({start=0,end=null,sampleRate=48000,tail=0,normalize=false}={}){
    const state=structuredClone(this.getState());end=end??sessionEnd(state);const duration=end-start+tail;
    if(duration<=0)throw new Error('Choose a non-empty export range.');
    const frames=Math.ceil(duration*sampleRate);if(frames*8>512*1024*1024)throw new Error('This mixdown needs over 512 MB. Export a shorter selection.');
    const context=new OfflineAudioContext(2,frames,sampleRate),graph=buildGraph(context,state,false);
    scheduleRange(context,graph,state,this.assets,start,end,0,null);
    const buffer=await context.startRendering();
    if(normalize){let peak=0;for(let ch=0;ch<buffer.numberOfChannels;ch++)for(const x of buffer.getChannelData(ch))peak=Math.max(peak,Math.abs(x));if(peak>0){const scale=dbToGain(-1)/peak;for(let ch=0;ch<buffer.numberOfChannels;ch++){const d=buffer.getChannelData(ch);for(let i=0;i<d.length;i++)d[i]*=scale;}}}
    return buffer;
  }
  async startRecording(){
    if(this.recording)throw new Error('Recording is already active.');
    if(!navigator.mediaDevices?.getUserMedia)throw new Error('Microphone capture requires localhost or HTTPS and a supported browser.');
    const context=await this.ensure();
    if(!this.workletReady){await context.audioWorklet.addModule(new URL('./recorder-worklet.js',import.meta.url));this.workletReady=true;}
    const stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:2,echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
    try{
      const source=context.createMediaStreamSource(stream),node=new AudioWorkletNode(context,'sonora-recorder',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[2]}),silent=context.createGain();silent.gain.value=0;
      const recording={stream,source,node,silent,chunks:[],frames:0,start:this.position,sampleRate:context.sampleRate,resolveFlush:null};this.recording=recording;
      node.port.onmessage=({data})=>{if(data.done){recording.resolveFlush?.();return;}recording.chunks.push(data.channels);recording.frames+=data.channels[0].length;let peak=0;for(const channel of data.channels)for(const value of channel)peak=Math.max(peak,Math.abs(value));recording.inputPeak=peak;};
      source.connect(node);node.connect(silent);silent.connect(context.destination);
      if(!this.playing)await this.play(recording.start);
      const captureTime=Math.max(context.currentTime+256/context.sampleRate,this.anchorTime);
      recording.start=this.anchorPosition+Math.max(0,captureTime-this.anchorTime);
      node.port.postMessage({command:'start',frame:Math.ceil(captureTime*context.sampleRate)});
      this.dispatchEvent(new Event('recording'));return recording.start;
    }catch(error){stream.getTracks().forEach(t=>t.stop());this.recording=null;throw error;}
  }
  async stopRecording(){
    const r=this.recording;if(!r)return null;
    await new Promise(resolve=>{r.resolveFlush=resolve;r.node.port.postMessage('flush');setTimeout(resolve,1000);});
    this.recording=null;r.source.disconnect();r.node.disconnect();r.silent.disconnect();r.stream.getTracks().forEach(t=>t.stop());this.pause();
    if(!r.frames)throw new Error('The microphone returned no audio frames.');
    const channels=[new Float32Array(r.frames),new Float32Array(r.frames)];let p=0;
    for(const chunk of r.chunks){channels[0].set(chunk[0],p);channels[1].set(chunk[1],p);p+=chunk[0].length;}
    this.dispatchEvent(new Event('recording'));return {buffer:makeAudioBuffer(channels,r.sampleRate),start:r.start};
  }
  async dispose(){if(this.recording)await this.stopRecording();this.stop();await this.context?.close();}
}
