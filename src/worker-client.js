export class DSPWorker {
  constructor(){
    this.worker=new Worker(new URL('./worker.js',import.meta.url),{type:'module'});
    this.pending=new Map();this.nextId=0;
    this.worker.onmessage=({data})=>{const p=this.pending.get(data.id);if(!p)return;this.pending.delete(data.id);data.error?p.reject(new Error(data.error)):p.resolve(data.result);};
    this.worker.onerror=error=>{for(const p of this.pending.values())p.reject(new Error(error.message||'Audio worker failed.'));this.pending.clear();};
  }
  run(type,payload,transfer=[]){return new Promise((resolve,reject)=>{const id=++this.nextId;this.pending.set(id,{resolve,reject});this.worker.postMessage({id,type,payload},transfer);});}
  dispose(){this.worker.terminate();for(const p of this.pending.values())p.reject(new Error('Worker closed.'));this.pending.clear();}
}
export function copyChannels(buffer){return Array.from({length:buffer.numberOfChannels},(_,i)=>buffer.getChannelData(i).slice());}
export function makeAudioBuffer(channels,sampleRate){const buffer=new AudioBuffer({numberOfChannels:channels.length,length:channels[0].length,sampleRate});channels.forEach((c,i)=>buffer.copyToChannel(c,i));return buffer;}
