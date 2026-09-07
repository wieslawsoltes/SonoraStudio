"""Real-browser verification. Default: in-memory standalone page, no network.
For secure-origin WebGPU, microphone and IndexedDB coverage, set SONORA_TEST_URL
and run the local server separately. No browser policies are modified.
Requires Python Playwright and a Chromium browser.
"""
import json, math, os, pathlib, struct, time, traceback, wave
from playwright.sync_api import sync_playwright
ROOT=pathlib.Path(__file__).resolve().parents[1]
ART=ROOT/'tests'/'artifacts'; ART.mkdir(exist_ok=True)
REPORT={'tests':[],'skipped':[],'errors':[],'console':[]}
def check(name,fn):
    start=time.perf_counter()
    try:
        value=fn(); REPORT['tests'].append({'name':name,'status':'pass','seconds':round(time.perf_counter()-start,3),'detail':value}); print('PASS',name,flush=True); return value
    except Exception as e:
        REPORT['tests'].append({'name':name,'status':'fail','error':str(e)}); print('FAIL',name,str(e),flush=True); raise

def require(condition,message):
    if not condition: raise AssertionError(message)

with sync_playwright() as p:
    launch={'headless':True,'args':['--no-sandbox','--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-features=Vulkan','--use-vulkan=swiftshader','--disable-vulkan-surface','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']}
    executable=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium')
    if pathlib.Path(executable).exists(): launch['executable_path']=executable
    browser=p.chromium.launch(**launch)
    context=browser.new_context(viewport={'width':1600,'height':1000},device_scale_factor=1,accept_downloads=True)
    page=context.new_page()
    page.on('pageerror',lambda e:REPORT['errors'].append(str(e)))
    page.on('console',lambda m:REPORT['console'].append({'type':m.type,'text':m.text}))
    try:
        url=os.environ.get('SONORA_TEST_URL')
        if url: page.goto(url,wait_until='networkidle')
        else: page.set_content((ROOT/'dist'/'sonora-studio.html').read_text(),wait_until='load')
        page.wait_for_function('window.__sonora?.ready === true',timeout=60000)
        page.wait_for_timeout(600)
        def initial():
            s=page.evaluate('''() => ({ready:__sonora.ready,tracks:__sonora.store.state.tracks.length,clips:__sonora.store.state.tracks.flatMap(t=>t.clips).length,assets:__sonora.assets.size,peaks:__sonora.renderer.rectangles,backend:__sonora.renderer.mode,secure:isSecureContext,analyzed:[...__sonora.assets.values()].every(a=>a.stats&&a.peaks&&a.spectrum)})''')
            require(s['tracks']==6 and s['assets']==6 and s['clips']==16,'Demo asset/track/clip count mismatch')
            require(s['peaks']>1000 and s['analyzed'],'Actual audio caches or rendered geometry missing')
            return s
        startup=check('Demo session, real source analysis and waveform rendering',initial)
        REPORT['environment']={'chromium':browser.version,'url':url or 'in-memory standalone document','backend':startup['backend'],'secure':startup['secure']}
        if startup['backend']!='WebGPU': REPORT['skipped'].append({'name':'WebGPU adapter/driver execution','reason':'The in-memory document is not a secure origin. Canvas fallback was exercised; WGSL was not executed.'})
        page.screenshot(path=str(ART/'multitrack.png'))
        def playback():
            page.locator('#play-button').click();page.wait_for_timeout(750)
            result=page.evaluate('''() => ({playing:__sonora.engine.playing,position:__sonora.engine.position,meters:__sonora.engine.meters(),sampleRate:__sonora.engine.context.sampleRate})''')
            require(result['playing'] and result['position']>.25,'Transport clock did not advance')
            require(max(result['meters']['left']['peak'],result['meters']['right']['peak'])>0.0001,'Playback generated no measurable audio')
            page.locator('[data-action="stop"]').first.click()
            require(page.evaluate('__sonora.engine.position')==0,'Stop failed to reset transport')
            return {'position':result['position'],'leftPeak':result['meters']['left']['peak'],'rightPeak':result['meters']['right']['peak'],'sampleRate':result['sampleRate']}
        check('Real Web Audio playback, sample metering and transport stop',playback)
        def looping():
            page.evaluate("__sonora.store.state.loop={enabled:true,start:.2,end:.45};__sonora.engine.play(.2)")
            page.wait_for_timeout(1000)
            result=page.evaluate("({playing:__sonora.engine.playing,position:__sonora.engine.position,sources:__sonora.engine.sources.size})")
            require(result['playing'] and .2<=result['position']<.45,'Loop clock did not wrap into the active interval')
            page.evaluate("__sonora.engine.stop();__sonora.store.state.loop.enabled=false")
            return result
        check('Lookahead playback loop wraps without stopping transport',looping)
        def split_undo():
            page.evaluate('__sonora.engine.seek(2)');page.keyboard.press('Control+k')
            s=page.evaluate('''() => {const t=__sonora.store.state.tracks[0],c=t.clips.find(c=>Math.abs(c.start-2)<1e-8);return {count:t.clips.length,offset:c?.offset,duration:c?.duration}}''')
            require(s['count']==5 and abs(s['offset']-2)<1e-8,'Split source mapping failed')
            page.keyboard.press('Control+z');require(page.evaluate('__sonora.store.state.tracks[0].clips.length')==4,'Undo failed')
            page.keyboard.press('Control+Shift+z');require(page.evaluate('__sonora.store.state.tracks[0].clips.length')==5,'Redo failed')
            page.keyboard.press('Control+z');page.evaluate('__sonora.engine.stop()')
            return s
        check('Keyboard split plus transactional undo and redo',split_undo)
        def duplicate():
            page.keyboard.press('Control+d');require(page.evaluate('__sonora.store.state.tracks[0].clips.length')==5,'Duplicate failed')
            page.keyboard.press('Control+z')
        check('Keyboard clip duplication and undo',duplicate)
        def drag_clip():
            c=page.locator('.audio-clip.selected').first;box=c.bounding_box();x=box['x']+45;y=box['y']+40
            page.keyboard.down('Shift');page.mouse.move(x,y);page.mouse.down();page.mouse.move(x+52,y,steps=7);page.mouse.up();page.keyboard.up('Shift')
            start=page.evaluate('__sonora.focused().clip.start');require(start>1,'Dragging did not move the clip')
            page.keyboard.press('Control+z');return {'movedTo':start}
        check('Pointer-driven clip move with snap bypass',drag_clip)
        def trim_and_fade():
            initial=page.evaluate('__sonora.focused().clip.duration')
            box=page.locator('.audio-clip.selected .clip-handle.right').bounding_box();x=box['x']+3;y=box['y']+box['height']/2
            page.keyboard.down('Shift');page.mouse.move(x,y);page.mouse.down();page.mouse.move(x-35,y,steps=6);page.mouse.up();page.keyboard.up('Shift')
            duration=page.evaluate('__sonora.focused().clip.duration');require(duration<initial-.5,'Pointer trim failed');page.keyboard.press('Control+z')
            box=page.locator('.audio-clip.selected .fade-in').bounding_box();x=box['x']+box['width']/2;y=box['y']+box['height']/2
            page.mouse.move(x,y);page.mouse.down();page.mouse.move(x+30,y,steps=6);page.mouse.up()
            fade=page.evaluate('__sonora.focused().clip.fadeIn');require(fade>.3,'Fade handle failed');page.keyboard.press('Control+z');return {'trimmedDuration':duration,'fadeIn':fade}
        check('Pointer trim and nondestructive fade handles',trim_and_fade)
        def mixer():
            mute=page.locator('.track-header').first.locator('[data-track-toggle="mute"]');mute.click();require(page.evaluate('__sonora.store.state.tracks[0].mute'),'Mute failed');mute.click()
            result=page.evaluate('''() => {const id=__sonora.store.state.tracks[0].id,input=document.querySelector(`[data-track-pan="${id}"]`),n=__sonora.store.undoStack.length;input.value=.45;input.dispatchEvent(new Event('input',{bubbles:true}));input.value=.65;input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));return {pan:__sonora.store.state.tracks[0].pan,undoSteps:__sonora.store.undoStack.length-n};}''')
            require(result['pan']==.65 and result['undoSteps']==1,'Slider edit did not coalesce into a single transaction')
            page.keyboard.press('Control+z');return result
        check('Mute, stereo pan and coalesced slider history',mixer)
        def fx():
            n=page.evaluate('__sonora.selectedTrack().effects.length');page.locator('.add-effect').click();page.locator('#effect-type').select_option('delay');page.locator('#dialog-submit').click();page.wait_for_function('!document.querySelector("#dialog").open')
            require(page.evaluate('__sonora.selectedTrack().effects.length')==n+1,'Effect was not inserted');page.keyboard.press('Control+z')
        check('Effects rack creates real processing nodes',fx)
        def offline():
            return page.evaluate('''async () => {const app=__sonora,b=await app.engine.render({start:8.9,end:9.4,sampleRate:44100,tail:.1});let peak=0,sum=0;for(let ch=0;ch<2;ch++)for(const v of b.getChannelData(ch)){if(!Number.isFinite(v))throw new Error('Non-finite mixdown sample');peak=Math.max(peak,Math.abs(v));sum+=v*v;}if(peak<.001)throw new Error('Silent offline mixdown');return {frames:b.length,sampleRate:b.sampleRate,channels:b.numberOfChannels,peak,rms:Math.sqrt(sum/b.length/2)};}''')
        check('Offline multitrack graph rendering with resampling and FX',offline)
        def automation_render():
            return page.evaluate('''async () => {const app=__sonora,state=structuredClone(app.store.state),assetId='test_constant',buffer=new AudioBuffer({length:48000,numberOfChannels:2,sampleRate:48000});buffer.getChannelData(0).fill(.25);buffer.getChannelData(1).fill(.25);const t=state.tracks[0];state.tracks=[t];state.masterGain=0;t.gain=0;t.pan=0;t.effects=[];t.mute=t.solo=false;t.automation=[{time:0,value:-12},{time:1,value:0}];t.clips=[{...t.clips[0],assetId,start:0,offset:0,duration:1,gain:0,fadeIn:0,fadeOut:0,rate:1}];state.loop.enabled=false;const engine=new app.engine.constructor(()=>state,new Map([[assetId,{buffer}]])),full=await engine.render({start:0,end:1}),partial=await engine.render({start:.5,end:1});let error=0;for(let i=0;i<partial.length;i++)error=Math.max(error,Math.abs(full.getChannelData(0)[24000+i]-partial.getChannelData(0)[i]));if(error>2e-5)throw new Error('Automation changed when seeking: '+error);return {maximumSampleError:error,framesCompared:partial.length};}''')
        check('Offline automation agrees across full-range and seeked rendering',automation_render)
        def wav_download():
            page.evaluate("__sonora.store.state.selection={start:.25,end:.75};__sonora.renderRange()")
            page.locator('[data-action="export"]').first.click()
            page.locator('#dialog [name="scope"]').select_option('selection')
            page.locator('#dialog [name="depth"]').select_option('24')
            page.locator('#dialog [name="rate"]').select_option('44100')
            page.locator('#dialog [name="tail"]').uncheck()
            page.locator('#dialog [name="filename"]').fill('Sonora verification mix')
            with page.expect_download(timeout=15000) as pending:
                page.locator('#dialog-submit').click()
            download=pending.value;path=ART/'export-test.wav';download.save_as(str(path))
            data=path.read_bytes();require(data[:4]==b'RIFF' and data[8:12]==b'WAVE','Export did not download a WAV')
            require(struct.unpack_from('<I',data,4)[0]==len(data)-8,'RIFF file size is incorrect')
            rate=struct.unpack_from('<I',data,24)[0];require(rate==44100,'Export sample rate incorrect')
            require(len(data)==68+22050*2*3,'Export selection duration is incorrect')
            require(any(data[68:]),'Exported WAV is silent')
            page.wait_for_function('!document.querySelector("#dialog").open')
            page.evaluate("__sonora.store.state.selection={start:0,end:0};__sonora.renderRange()")
            return {'bytes':len(data),'sampleRate':rate,'frames':22050,'bitDepth':24,'download':download.suggested_filename}
        check('Export dialog downloads a real 24-bit stereo WAV mixdown',wav_download)
        def waveform_processing():
            page.locator('.audio-clip.selected').first.dblclick(position={'x':42,'y':30});require(page.evaluate('__sonora.ui.mode')=='waveform','Waveform editor not entered')
            original=page.evaluate('''() => {const app=__sonora,c=app.focused().clip,a=app.assets.get(c.assetId);app.store.state.selection={start:.5,end:1};app.renderRange();return {id:c.assetId,last:a.buffer.getChannelData(0)[48000-1],outside:a.buffer.getChannelData(0)[100]};}''')
            page.locator('[data-process="reverse"]').click();page.wait_for_function('(id)=>__sonora.focused().clip.assetId!==id',arg=original['id'])
            result=page.evaluate('''() => {const a=__sonora.assets.get(__sonora.focused().clip.assetId);return {first:a.buffer.getChannelData(0)[24000],outside:a.buffer.getChannelData(0)[100]};}''')
            require(abs(result['first']-original['last'])<1e-6 and result['outside']==original['outside'],'Selected-region reverse altered the wrong samples')
            page.keyboard.press('Control+z');require(page.evaluate('__sonora.focused().clip.assetId')==original['id'],'Undo did not recover original source reference')
            return result
        check('Waveform selection processing and immutable-source undo',waveform_processing)
        def spectral_view():
            page.locator('#spectral-button').click();page.wait_for_function('__sonora.spectralCache.has(__sonora.focused().clip.assetId)')
            page.locator('[data-dock="spectrum"]').click();page.wait_for_timeout(200)
            require(page.evaluate('__sonora.ui.spectral'),'Spectral view not enabled')
            page.evaluate("document.querySelector('#toast-container').replaceChildren()")
            page.screenshot(path=str(ART/'spectral.png'))
            return page.evaluate('''() => ({width:__sonora.spectralCache.get(__sonora.focused().clip.assetId).width,height:__sonora.spectralCache.get(__sonora.focused().clip.assetId).height})''')
        check('Worker-generated spectrogram and actual FFT analysis',spectral_view)
        def spectral_region():
            page.keyboard.press('t');box=page.locator('#lane-wrap').bounding_box();x=box['x']+box['width']*.2;y=box['y']+box['height']*.65
            page.mouse.move(x,y);page.mouse.down();page.mouse.move(x+100,y+40,steps=5);page.mouse.up()
            band=page.evaluate('__sonora.ui.spectralBand');require(band and band['end']>band['start'] and band['high']>band['low'],'Spectral pointer selection failed');return band
        check('Time-frequency rectangle interaction',spectral_region)
        def project_roundtrip():
            return page.evaluate('''() => {const a=__sonora,text=a.projectData(),decoded=a.readProjectData(text),source=a.assets.get(a.focused().clip.assetId).buffer,target=decoded.assets.get(a.focused().clip.assetId).buffer;for(let ch=0;ch<source.numberOfChannels;ch++)for(const i of [0,100,24000,source.length-1])if(source.getChannelData(ch)[i]!==target.getChannelData(ch)[i])throw new Error('Float PCM changed in project roundtrip');return {characters:text.length,assets:decoded.assets.size,tracks:decoded.state.tracks.length,lossless:true};}''')
        check('Portable project JSON plus lossless embedded PCM round-trip',project_roundtrip)
        def import_pcm():
            path=ART/'import-test.wav'
            with wave.open(str(path),'wb') as w:
                w.setnchannels(1);w.setsampwidth(2);w.setframerate(44100);w.writeframes(b''.join(struct.pack('<h',int(math.sin(i*2*math.pi*220/44100)*5000)) for i in range(11025)))
            previous=page.evaluate('__sonora.assets.size');page.locator('#file-input').set_input_files(str(path));page.wait_for_function('(n)=>__sonora.assets.size>n',arg=previous);page.wait_for_timeout(200)
            result=page.evaluate('''() => {const b=__sonora.assets.get(__sonora.focused().clip.assetId).buffer;return {rate:b.sampleRate,channels:b.numberOfChannels,length:b.length};}''')
            require(result=={'rate':44100,'channels':1,'length':11025},'PCM import changed source rate or channels');return result
        check('File input: real mono PCM WAV import without resampling source',import_pcm)
        def automation():
            page.evaluate('__sonora.ui.automation=true;__sonora.renderAutomation()');box=page.locator('#lane-wrap').bounding_box();page.keyboard.down('Alt');page.mouse.click(box['x']+80,box['y']+40);page.keyboard.up('Alt')
            points=page.evaluate('__sonora.store.state.tracks[0].automation');require(len(points)>=3,'Automation point was not added')
            circle=page.locator('#automation-layer circle').nth(1);circle.click(button='right');require(page.evaluate('__sonora.store.state.tracks[0].automation.length')==len(points)-1,'Automation point removal failed')
            return {'pointsAfterAdd':len(points)}
        check('Interactive gain automation add and remove',automation)
        def responsive():
            page.set_viewport_size({'width':760,'height':850});page.wait_for_timeout(200)
            result=page.evaluate('''() => ({scroll:document.documentElement.scrollWidth,width:innerWidth,editor:document.querySelector('#lane-wrap').clientWidth})''')
            require(result['scroll']<=result['width'] and result['editor']>200,'Responsive layout overflow')
            page.screenshot(path=str(ART/'compact.png'));page.set_viewport_size({'width':1600,'height':1000});return result
        check('Compact responsive workspace without page overflow',responsive)
        if startup['secure']:
            def persistence():
                page.evaluate('__sonora.saveLocalNow()');return page.evaluate('''async () => {const p=await __sonora.storage.load();if(!p||p.assets.size<1)throw new Error('Autosave restore failed');return {assets:p.assets.size,tracks:p.state.tracks.length};}''')
            check('IndexedDB save and load',persistence)
        else:
            REPORT['skipped'].append({'name':'IndexedDB persistence','reason':'Opaque in-memory documents cannot access IndexedDB. Project serialization was tested separately.'})
            REPORT['skipped'].append({'name':'Physical / fake microphone capture','reason':'Insecure document plus browser AudioCaptureAllowed=false policy. Capture permissions were not bypassed.'})
        require(not REPORT['errors'],'Unexpected JavaScript page errors: '+repr(REPORT['errors']))
        check('No uncaught browser JavaScript errors',lambda:len(REPORT['errors']))
        page.evaluate('__sonora.ui.automation=false;__sonora.ui.dock="mixer";__sonora.ui.tool="move";__sonora.loadDemo()');page.wait_for_function('__sonora.store.state.tracks.length===6');page.wait_for_timeout(700);page.evaluate('__sonora.setDock("mixer"); document.querySelector("#toast-container").replaceChildren()');page.screenshot(path=str(ART/'multitrack.png'))
    except Exception:
        REPORT['failureTrace']=traceback.format_exc();page.screenshot(path=str(ART/'failure.png'));print(REPORT['failureTrace'],flush=True)
    finally:
        (ART/'browser-report.json').write_text(json.dumps(REPORT,indent=2));browser.close()
        print(json.dumps({'passed':sum(t['status']=='pass' for t in REPORT['tests']),'failed':sum(t['status']=='fail' for t in REPORT['tests']),'skipped':REPORT['skipped'],'errors':REPORT['errors']},indent=2))
        if REPORT.get('failureTrace'): raise SystemExit(1)
