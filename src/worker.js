import {buildPeaks,statistics,spectrum,spectrogram,processAudio,encodeWav,decodeWav} from './dsp.js';
import {makeDemo} from './synth.js';
const transferables=value=>{const buffers=new Set();const visit=x=>{if(ArrayBuffer.isView(x))buffers.add(x.buffer);else if(x instanceof ArrayBuffer)buffers.add(x);else if(x&&typeof x==='object')for(const v of Object.values(x))visit(v);};visit(value);return [...buffers];};
self.onmessage=({data})=>{
  const {id,type,payload}=data;
  try{
    let result;
    switch(type){
      case 'demo':result=makeDemo(payload.sampleRate);break;
      case 'analyze':result={peaks:buildPeaks(payload.channels),stats:statistics(payload.channels),spectrum:spectrum(payload.channels,payload.sampleRate)};break;
      case 'spectrogram':result=spectrogram(payload.channels,payload.sampleRate,payload.width,payload.height);break;
      case 'process':result=processAudio(payload.channels,payload.sampleRate,payload.operation,payload.options);break;
      case 'wav':result=encodeWav(payload.channels,payload.sampleRate,payload.bitDepth,payload.dither);break;
      case 'decode-wav':result=decodeWav(payload.buffer);break;
      default:throw new Error(`Unknown worker request: ${type}`);
    }
    self.postMessage({id,result},transferables(result));
  }catch(error){self.postMessage({id,error:error.message});}
};
