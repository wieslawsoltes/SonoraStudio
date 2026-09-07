const SHADER = /* wgsl */`
struct View { size: vec2f, pad: vec2f };
@group(0) @binding(0) var<uniform> view: View;
struct Output { @builtin(position) position: vec4f, @location(0) color: vec4f };
@vertex fn vs(@builtin(vertex_index) vertex: u32, @location(0) rect: vec4f, @location(1) color: vec4f) -> Output {
  let corners = array<vec2f, 6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1));
  let p = mix(rect.xy, rect.zw, corners[vertex]);
  var out: Output;
  out.position = vec4f(p.x/view.size.x*2-1,1-p.y/view.size.y*2,0,1);
  out.color = color;
  return out;
}
@fragment fn fs(input: Output) -> @location(0) vec4f { return input.color; }
`;
export class WaveRenderer extends EventTarget {
  constructor(canvas){super();this.canvas=canvas;this.mode='Starting';this.device=null;this.context=null;this.capacity=0;this.buffer=null;this.rectangles=0;this.lastMs=0;this.ready=false;this.disposed=false;}
  async init(){
    try{
      if(!navigator.gpu)throw new Error('WebGPU is unavailable');
      const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});if(!adapter)throw new Error('No WebGPU adapter');
      this.device=await adapter.requestDevice();this.context=this.canvas.getContext('webgpu');if(!this.context)throw new Error('WebGPU canvas is unavailable');
      const format=navigator.gpu.getPreferredCanvasFormat();this.context.configure({device:this.device,format,alphaMode:'premultiplied'});
      const module=this.device.createShaderModule({label:'Sonora • instanced min/max waveform',code:SHADER});
      const compilation=await module.getCompilationInfo();const errors=compilation.messages.filter(m=>m.type==='error');if(errors.length)throw new Error(errors.map(m=>m.message).join('\n'));
      this.pipeline=await this.device.createRenderPipelineAsync({label:'Sonora waveform pipeline',layout:'auto',vertex:{module,entryPoint:'vs',buffers:[{arrayStride:32,stepMode:'instance',attributes:[{shaderLocation:0,offset:0,format:'float32x4'},{shaderLocation:1,offset:16,format:'float32x4'}]}]},fragment:{module,entryPoint:'fs',targets:[{format,blend:{color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}}]},primitive:{topology:'triangle-list'}});
      this.uniform=this.device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
      this.bindGroup=this.device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniform}}]});
      this.mode='WebGPU';this.ready=true;
      this.device.lost.then(info=>{if(!this.disposed){this.reason=info.message||'GPU device lost';this.fallback();}});
      this.device.addEventListener('uncapturederror',event=>{console.error('Sonora WebGPU:',event.error);this.reason=event.error.message;this.fallback();});
    }catch(error){this.reason=error.message;this.fallback();}
    this.dispatchEvent(new Event('backend'));return this;
  }
  fallback(){
    if(this.mode==='Canvas 2D')return;
    if(this.context){const replacement=this.canvas.cloneNode(false);this.canvas.replaceWith(replacement);this.canvas=replacement;this.context=null;}
    this.ctx=this.canvas.getContext('2d',{alpha:true});this.mode='Canvas 2D';this.ready=true;this.dispatchEvent(new Event('backend'));
  }
  render(data,width,height){
    if(!this.ready||width<=0||height<=0)return;const t=performance.now(),dpr=Math.min(window.devicePixelRatio||1,2.5);
    const w=Math.max(1,Math.round(width*dpr)),h=Math.max(1,Math.round(height*dpr));
    if(this.canvas.width!==w||this.canvas.height!==h){this.canvas.width=w;this.canvas.height=h;}
    this.rectangles=data.length/8;
    if(this.mode==='WebGPU'){
      try{
        if(data.byteLength>this.capacity){this.buffer?.destroy();this.capacity=Math.max(4096,2**Math.ceil(Math.log2(data.byteLength)));this.buffer=this.device.createBuffer({label:'Sonora waveform instances',size:this.capacity,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});}
        if(data.length)this.device.queue.writeBuffer(this.buffer,0,data);
        this.device.queue.writeBuffer(this.uniform,0,new Float32Array([width,height,0,0]));
        const encoder=this.device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[{view:this.context.getCurrentTexture().createView(),clearValue:{r:0,g:0,b:0,a:0},loadOp:'clear',storeOp:'store'}]});
        if(data.length){pass.setPipeline(this.pipeline);pass.setBindGroup(0,this.bindGroup);pass.setVertexBuffer(0,this.buffer);pass.draw(6,this.rectangles);}
        pass.end();this.device.queue.submit([encoder.finish()]);
      }catch(error){this.reason=error.message;this.fallback();this.render(data,width,height);}
    }else{
      const c=this.ctx;c.setTransform(dpr,0,0,dpr,0,0);c.clearRect(0,0,width,height);let last='';
      for(let i=0;i<data.length;i+=8){const color=`rgba(${Math.round(data[i+4]*255)},${Math.round(data[i+5]*255)},${Math.round(data[i+6]*255)},${data[i+7]})`;if(color!==last){c.fillStyle=color;last=color;}c.fillRect(data[i],data[i+1],Math.max(.7,data[i+2]-data[i]),Math.max(.7,data[i+3]-data[i+1]));}
    }
    this.lastMs=performance.now()-t;
  }
  dispose(){this.disposed=true;this.buffer?.destroy();this.uniform?.destroy();this.device?.destroy();}
}
export function hexRgb(color){return [parseInt(color.slice(1,3),16)/255,parseInt(color.slice(3,5),16)/255,parseInt(color.slice(5,7),16)/255];}
export function peakAt(asset,channel,start,end,samplesPerPixel){
  const raw=asset.buffer.getChannelData(Math.min(channel,asset.buffer.numberOfChannels-1)),levels=asset.peaks?.[Math.min(channel,asset.buffer.numberOfChannels-1)];
  start=Math.max(0,Math.floor(start));end=Math.min(raw.length,Math.max(start+1,Math.ceil(end)));
  let min=0,max=0;
  if(levels&&samplesPerPixel>=128){let level=levels[0];for(const item of levels){if(item.block>samplesPerPixel)break;level=item;}
    for(let i=Math.floor(start/level.block),stop=Math.min(level.min.length,Math.ceil(end/level.block));i<stop;i++){min=Math.min(min,level.min[i]);max=Math.max(max,level.max[i]);}
  }else for(let i=start;i<end;i++){min=Math.min(min,raw[i]);max=Math.max(max,raw[i]);}
  return [min,max];
}
export function waveformGeometry(items,assets,width,height){
  const values=[];
  for(const item of items){
    const asset=assets.get(item.clip.assetId);if(!asset)continue;
    const {clip,x,y,w,h,color,viewStart,pixelsPerSecond}=item,rgb=hexRgb(color),channels=Math.min(2,asset.buffer.numberOfChannels);
    const x0=Math.max(0,Math.ceil(x)),x1=Math.min(width,Math.floor(x+w));if(x1<=x0||y>height||y+h<0)continue;
    const channelHeight=h/channels,amplitude=channelHeight*.41,gain=Math.pow(10,clip.gain/20)*(item.displayScale||1),spp=asset.buffer.sampleRate*clip.rate/pixelsPerSecond;
    for(let ch=0;ch<channels;ch++){
      const center=y+ch*channelHeight+channelHeight/2;
      for(let px=x0;px<x1;px++){
        const local=(px-x)/pixelsPerSecond,sample=(clip.offset+local*clip.rate)*asset.buffer.sampleRate;
        let [lo,hi]=peakAt(asset,ch,sample,sample+spp,spp);
        const fade=Math.min(1,clip.fadeIn?Math.max(0,local)/clip.fadeIn:1,clip.fadeOut?Math.max(0,clip.duration-local)/clip.fadeOut:1);
        lo*=gain*fade;hi*=gain*fade;
        values.push(px,Math.max(y,center-Math.min(1,hi)*amplitude),px+1,Math.min(y+h,Math.max(center+.55,center-Math.max(-1,lo)*amplitude)),...rgb,.9);
      }
    }
  }
  return new Float32Array(values);
}
