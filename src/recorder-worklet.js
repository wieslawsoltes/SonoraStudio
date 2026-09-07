/** Lossless PCM capture; no ScriptProcessorNode and no encoded MediaRecorder path. */
class SonoraRecorder extends AudioWorkletProcessor {
  constructor(){super();this.size=4096;this.channels=[new Float32Array(this.size),new Float32Array(this.size)];this.offset=0;this.active=false;this.startFrame=0;
    this.port.onmessage=({data})=>{if(data?.command==='start'){this.startFrame=data.frame;this.active=true;}if(data==='flush'){this.flush();this.active=false;this.port.postMessage({done:true});}};
  }
  flush(){if(!this.offset)return;const data=this.channels.map(c=>c.slice(0,this.offset));this.port.postMessage({channels:data,frame:currentFrame},data.map(c=>c.buffer));this.offset=0;}
  process(inputs,outputs){
    for(const channel of outputs[0]||[])channel.fill(0);
    const input=inputs[0];if(!this.active||!input?.length)return true;
    for(let i=0;i<input[0].length;i++){if(currentFrame+i<this.startFrame)continue;this.channels[0][this.offset]=input[0][i];this.channels[1][this.offset]=input[1]?.[i]??input[0][i];if(++this.offset===this.size)this.flush();}
    return true;
  }
}
registerProcessor('sonora-recorder',SonoraRecorder);
