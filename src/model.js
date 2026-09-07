/** The document model is deliberately independent of the DOM and Web Audio. */
export const COLORS = ['#70d5b2','#71bfea','#b49bef','#e1b478','#de8cb0','#89bfce','#d4cf80','#8ea6ec'];
export const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));
export const dbToGain = db => Math.pow(10, db / 20);
export const gainToDb = gain => gain > 0 ? 20 * Math.log10(gain) : -120;
export const uid = (prefix = 'id') => `${prefix}_${typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16).padStart(8, '0')).join('')}`;
export const clone = value => structuredClone(value);
export const isIdentifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export const clipEnd = clip => clip.start + clip.duration;
export const sessionEnd = state => Math.max(1, ...state.tracks.flatMap(t => t.clips.map(clipEnd)));
export function formatTime(seconds, precision = 3) {
  const value = Number(seconds);
  const scale = 10 ** precision;
  const s = Math.round(Math.max(0, Number.isFinite(value) ? value : 0) * scale) / scale;
  const mins = Math.floor(s / 60);
  return `${String(mins).padStart(2, '0')}:${(s % 60).toFixed(precision).padStart(precision ? precision + 3 : 2, '0')}`;
}
export function makeTrack(name = 'Audio track', index = 0) {
  return { id: uid('track'), name, color: COLORS[index % COLORS.length], gain: 0, pan: 0,
    mute: false, solo: false, armed: false, effects: [], clips: [], automation: [] };
}
export function makeClip(assetId, duration, start = 0, name = 'Audio clip') {
  return { id: uid('clip'), assetId, name, start, offset: 0, duration, gain: 0,
    fadeIn: 0.008, fadeOut: 0.015, rate: 1, locked: false };
}
export function makeSession() {
  const track = makeTrack('Audio 1');
  return { format: 'sonora-studio', version: 1, name: 'Untitled session', sampleRate: 48000, tempo: 108,
    masterGain: -3, tracks: [track], markers: [], selectedTrackId: track.id, selectedClipIds: [],
    selection: { start: 0, end: 0 }, loop: { enabled: false, start: 0, end: 8.888889 } };
}
export function findClip(state, id) {
  for (const track of state.tracks) {
    const clip = track.clips.find(c => c.id === id);
    if (clip) return { track, clip };
  }
  return null;
}
export function validateSession(state, assets = null) {
  if (!state || state.format !== 'sonora-studio' || state.version !== 1) throw new Error('Unsupported Sonora project format.');
  if (!Array.isArray(state.tracks) || state.tracks.length < 1 || state.tracks.length > 128) throw new Error('A session must contain 1–128 tracks.');
  state.name = String(state.name || 'Untitled session').slice(0, 120);
  state.tempo = clamp(state.tempo, 20, 400);
  state.masterGain = clamp(state.masterGain, -90, 12);
  if (![44100,48000,88200,96000].includes(state.sampleRate)) state.sampleRate = 48000;
  const ids = new Set();
  let count = 0;
  for (const track of state.tracks) {
    if (!isIdentifier(track.id) || ids.has(track.id)) throw new Error('Duplicate or invalid track identifier.');
    ids.add(track.id);
    track.name = String(track.name || 'Audio').slice(0, 100);
    track.color = /^#[a-f\d]{6}$/i.test(track.color) ? track.color : COLORS[0];
    track.gain = clamp(track.gain, -90, 12); track.pan = clamp(track.pan, -1, 1);
    track.mute = !!track.mute; track.solo = !!track.solo; track.armed = !!track.armed;
    track.effects = Array.isArray(track.effects) ? track.effects.slice(0, 16) : [];
    const ranges = {
      eq: {low:[-24,24],mid:[-24,24],high:[-24,24],frequency:[100,10000]},
      compressor: {threshold:[-60,0],ratio:[1,20],attack:[0.001,0.2],release:[0.02,1]},
      reverb: {mix:[0,1],decay:[0.1,5]}, delay: {mix:[0,1],time:[0.01,2],feedback:[0,0.85]},
      highpass: {frequency:[20,5000]}, lowpass: {frequency:[200,20000]}, distortion: {drive:[0,50],mix:[0,1]}
    };
    track.effects = track.effects.filter(f => f && Object.hasOwn(ranges,f.type));
    for (const effect of track.effects) {
      effect.id ||= uid('fx'); if(!isIdentifier(effect.id)||ids.has(effect.id))throw new Error('Duplicate or invalid effect identifier.');ids.add(effect.id); effect.enabled = effect.enabled !== false;
      for (const [key, [lo, hi]] of Object.entries(ranges[effect.type])) effect[key] = clamp(effect[key], lo, hi);
    }
    track.automation = Array.isArray(track.automation) ? track.automation.slice(0, 1000)
      .filter(p => Number.isFinite(p.time) && Number.isFinite(p.value))
      .map(p => ({time:clamp(p.time,0,14400),value:clamp(p.value,-60,12)})).sort((a,b)=>a.time-b.time) : [];
    if (!Array.isArray(track.clips)) throw new Error('Invalid track clip collection.');
    for (const clip of track.clips) {
      if (++count > 10000) throw new Error('The project exceeds 10,000 clips.');
      if (!isIdentifier(clip.id) || ids.has(clip.id)) throw new Error('Duplicate or invalid clip identifier.');
      ids.add(clip.id);
      if(!isIdentifier(clip.assetId))throw new Error('Invalid audio asset identifier.');
      clip.name = String(clip.name || 'Audio clip').slice(0, 150);
      clip.start = clamp(clip.start, 0, 14400);
      clip.offset = clamp(clip.offset, 0, 14400);
      clip.rate = clamp(clip.rate || 1, 0.25, 4);
      clip.duration = clamp(clip.duration, 0.001, 14400 - clip.start);
      clip.gain = clamp(clip.gain, -90, 24);
      clip.fadeIn = clamp(clip.fadeIn, 0, clip.duration / 2);
      clip.fadeOut = clamp(clip.fadeOut, 0, clip.duration / 2);
      clip.locked = !!clip.locked;
      const asset = assets?.get(clip.assetId);
      if (assets && !asset) throw new Error(`Missing audio for “${clip.name}”.`);
      if (asset) {
        const duration = asset.buffer?.duration ?? asset.duration;
        if (clip.offset >= duration) throw new Error(`Clip “${clip.name}” starts outside its source.`);
        clip.duration = Math.min(clip.duration, (duration - clip.offset) / clip.rate);
        clip.fadeIn = Math.min(clip.fadeIn, clip.duration / 2);
        clip.fadeOut = Math.min(clip.fadeOut, clip.duration / 2);
      }
    }
  }
  state.selectedTrackId = state.tracks.some(t=>t.id===state.selectedTrackId) ? state.selectedTrackId : state.tracks[0].id;
  state.selectedClipIds = Array.isArray(state.selectedClipIds) ? state.selectedClipIds.filter(id=>findClip(state,id)) : [];
  state.markers = Array.isArray(state.markers) ? state.markers.slice(0,1000).map(m=>{if(!m||typeof m!=='object')throw new Error('Invalid marker.');const id=String(m.id||uid('marker'));if(!isIdentifier(id)||ids.has(id))throw new Error('Duplicate or invalid marker identifier.');ids.add(id);return {id,time:clamp(m.time,0,14400),name:String(m.name||'Marker').slice(0,100)};}).sort((a,b)=>a.time-b.time) : [];
  state.selection ||= {start:0,end:0};
  state.selection.start = clamp(state.selection.start,0,14400);
  state.selection.end = clamp(state.selection.end,state.selection.start,14400);
  state.loop ||= {enabled:false,start:0,end:8};
  state.loop.start=clamp(state.loop.start,0,14399.95);
  state.loop.end=clamp(state.loop.end,state.loop.start+.05,14400);
  state.loop.enabled=!!state.loop.enabled;
  return state;
}
export class SessionStore extends EventTarget {
  constructor(state, assets) { super(); this.state=validateSession(state,assets); this.assets=assets; this.undoStack=[]; this.redoStack=[]; this.dirty=false; this.revision=0; }
  notify(label='Selection', kind='document') { this.revision++; this.dispatchEvent(new CustomEvent('change',{detail:{label,kind}})); }
  execute(label, mutation) {
    const before=clone(this.state);
    try { mutation(this.state); validateSession(this.state,this.assets); }
    catch(error) { this.state=before; throw error; }
    this.commitFrom(before,label);
  }
  commitFrom(before,label) {
    try { validateSession(this.state,this.assets); } catch(error) { this.state=before; this.notify('Edit rejected'); throw error; }
    if (JSON.stringify(before)===JSON.stringify(this.state)) return;
    this.undoStack.push({label,state:before}); if(this.undoStack.length>100) this.undoStack.shift();
    this.redoStack=[]; this.dirty=true; this.notify(label);
  }
  select(trackId, clipIds=[]) { if(this.state.selectedTrackId===trackId&&clipIds.length===this.state.selectedClipIds.length&&clipIds.every((id,i)=>id===this.state.selectedClipIds[i]))return; this.state.selectedTrackId=trackId; this.state.selectedClipIds=clipIds; this.notify('Selection','selection'); }
  undo() { const item=this.undoStack.pop(); if(!item)return; this.redoStack.push({label:item.label,state:clone(this.state)}); this.state=item.state; this.dirty=true; this.notify(`Undo ${item.label}`); }
  redo() { const item=this.redoStack.pop(); if(!item)return; this.undoStack.push({label:item.label,state:clone(this.state)}); this.state=item.state; this.dirty=true; this.notify(`Redo ${item.label}`); }
  replace(state) { this.state=validateSession(state,this.assets);this.undoStack=[];this.redoStack=[];this.dirty=false;this.notify('Open session'); }
}
export function splitClips(state, time, ids = state.selectedClipIds) {
  const created=[];
  for (const track of state.tracks) {
    for (const clip of [...track.clips]) {
      if ((ids.length && !ids.includes(clip.id)) || clip.locked || time<=clip.start+.001 || time>=clipEnd(clip)-.001) continue;
      const leftDuration=time-clip.start;
      const right={...clone(clip),id:uid('clip'),start:time,offset:clip.offset+leftDuration*clip.rate,duration:clip.duration-leftDuration,fadeIn:0};
      clip.duration=leftDuration;clip.fadeOut=0;clip.fadeIn=Math.min(clip.fadeIn,leftDuration/2);
      right.fadeOut=Math.min(right.fadeOut,right.duration/2);
      track.clips.push(right);created.push(right.id);
    }
  }
  if(created.length)state.selectedClipIds=created;
  return created;
}
export function deleteClips(state, ripple=false) {
  for(const track of state.tracks) {
    const deleted=track.clips.filter(c=>state.selectedClipIds.includes(c.id)&&!c.locked).sort((a,b)=>a.start-b.start);
    if(ripple) {
      // Merge overlapping cut spans so an overlap is never subtracted twice.
      const spans=[];
      for(const c of deleted){const last=spans.at(-1); if(last&&c.start<=last[1])last[1]=Math.max(last[1],clipEnd(c));else spans.push([c.start,clipEnd(c)]);}
      for(const c of track.clips) if(!deleted.includes(c)) c.start=Math.max(0,c.start-spans.reduce((sum,[a,b])=>sum+Math.max(0,Math.min(c.start,b)-a),0));
    }
    track.clips=track.clips.filter(c=>!deleted.includes(c));
  }
  state.selectedClipIds=[];
}
export function duplicateClips(state) {
  const selected=state.tracks.flatMap(t=>t.clips.filter(c=>state.selectedClipIds.includes(c.id)));
  if(!selected.length)return;
  const start=Math.min(...selected.map(c=>c.start)),end=Math.max(...selected.map(clipEnd));
  const ids=[];
  for(const track of state.tracks)for(const c of [...track.clips])if(selected.includes(c)){const copy={...clone(c),id:uid('clip'),start:c.start+end-start,locked:false};track.clips.push(copy);ids.push(copy.id);}
  state.selectedClipIds=ids;
}
export function trimClip(clip, edge, delta, assetDuration) {
  if(clip.locked)return;
  if(edge==='left') {
    delta=clamp(delta,Math.max(-clip.offset/clip.rate,-clip.start),clip.duration-.005);
    clip.start+=delta;clip.offset+=delta*clip.rate;clip.duration-=delta;
  } else {
    clip.duration=clamp(clip.duration+delta,.005,(assetDuration-clip.offset)/clip.rate);
  }
  clip.fadeIn=Math.min(clip.fadeIn,clip.duration/2);clip.fadeOut=Math.min(clip.fadeOut,clip.duration/2);
}
export function automationDb(points,time) {
  if(!points?.length)return 0;
  if(time<=points[0].time)return points[0].value;
  for(let i=1;i<points.length;i++)if(time<=points[i].time){const a=points[i-1],b=points[i];return a.value+(b.value-a.value)*(time-a.time)/Math.max(1e-9,b.time-a.time);}
  return points.at(-1).value;
}
export function fadeGain(clip, localTime) {
  if(localTime<0||localTime>clip.duration)return 0;
  return dbToGain(clip.gain)*Math.min(1,clip.fadeIn?localTime/clip.fadeIn:1)*Math.min(1,clip.fadeOut?(clip.duration-localTime)/clip.fadeOut:1);
}
