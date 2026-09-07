import {encodeWav,decodeWav} from './dsp.js';
import {copyChannels,makeAudioBuffer} from './worker-client.js';
import {validateSession,isIdentifier} from './model.js';
export function download(data,name,type='application/octet-stream'){
  const blob=data instanceof Blob?data:new Blob([data],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
}
function toBase64(buffer){let text='';const bytes=new Uint8Array(buffer);for(let i=0;i<bytes.length;i+=32768)text+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(text);}
function fromBase64(text){const raw=atob(text),out=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);return out.buffer;}
export function serializeProject(state,assets){
  const used=new Set(state.tracks.flatMap(t=>t.clips.map(c=>c.assetId))),packed=[];
  for(const id of used){const asset=assets.get(id);if(!asset)throw new Error('Cannot save: a source asset is missing.');packed.push({id,name:asset.name,wav:toBase64(encodeWav(copyChannels(asset.buffer),asset.buffer.sampleRate,32))});}
  return JSON.stringify({application:'Sonora Studio',version:1,savedAt:new Date().toISOString(),session:state,assets:packed});
}
export function deserializeProject(text){
  if(text.length>512*1024*1024)throw new Error('Project files are limited to 512 MB.');
  const packed=JSON.parse(text);if(packed.application!=='Sonora Studio'||packed.version!==1||!Array.isArray(packed.assets)||packed.assets.length>256)throw new Error('This is not a supported Sonora Studio project.');
  const assets=new Map();let bytes=0;
  for(const a of packed.assets){if(!isIdentifier(a.id)||typeof a.wav!=='string'||assets.has(a.id))throw new Error('Invalid project audio asset.');bytes+=a.wav.length;if(bytes>512*1024*1024)throw new Error('Project audio exceeds the memory safety limit.');const decoded=decodeWav(fromBase64(a.wav));assets.set(a.id,{id:a.id,name:String(a.name||'Audio').slice(0,150),buffer:makeAudioBuffer(decoded.channels,decoded.sampleRate)});}
  validateSession(packed.session,assets);return {state:packed.session,assets};
}
export class LocalProjectStorage {
  constructor(){this.db=null;}
  async open(){if(this.db)return this.db;if(!globalThis.indexedDB)throw new Error('Browser project storage is unavailable.');this.db=await new Promise((resolve,reject)=>{const req=indexedDB.open('sonora-studio',1);req.onupgradeneeded=()=>{req.result.createObjectStore('session');req.result.createObjectStore('audio',{keyPath:'id'});};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});return this.db;}
  async save(state,assets){
    const db=await this.open(),used=new Set(state.tracks.flatMap(t=>t.clips.map(c=>c.assetId)));
    await new Promise((resolve,reject)=>{const tx=db.transaction(['session','audio'],'readwrite');tx.objectStore('session').put(structuredClone(state),'last');const store=tx.objectStore('audio');store.clear();for(const id of used){const asset=assets.get(id);store.put({id,name:asset.name,sampleRate:asset.buffer.sampleRate,channels:copyChannels(asset.buffer)});}tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Autosave was aborted.'));});
  }
  async load(){
    const db=await this.open();const result=await new Promise((resolve,reject)=>{const tx=db.transaction(['session','audio'],'readonly'),s=tx.objectStore('session').get('last'),a=tx.objectStore('audio').getAll();tx.oncomplete=()=>resolve({state:s.result,audio:a.result});tx.onerror=()=>reject(tx.error);});
    if(!result.state)return null;const assets=new Map();for(const a of result.audio)assets.set(a.id,{id:a.id,name:a.name,buffer:makeAudioBuffer(a.channels,a.sampleRate)});validateSession(result.state,assets);return {state:result.state,assets};
  }
}
