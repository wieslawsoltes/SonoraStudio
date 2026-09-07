/** Original, deterministic demo music. No recordings, downloads, or licensed assets. */
export function makeDemo(sampleRate=48000){
  const bpm=108,beat=60/bpm,bar=beat*4,phrase=bar*4,twopi=2*Math.PI;
  let seed=761923;const noise=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/2147483648-1;};
  const midi=n=>440*Math.pow(2,(n-69)/12);
  const create=(name,duration,fn)=>{const n=Math.ceil(duration*sampleRate),l=new Float32Array(n),r=new Float32Array(n);for(let i=0;i<n;i++){const [a,b]=fn(i/sampleRate,i);const edge=Math.min(1,i/250,(n-1-i)/250);l[i]=a*edge;r[i]=b*edge;}return {name,channels:[l,r],sampleRate};};
  const chords=[[60,63,67,70],[56,60,63,67],[63,67,70,74],[58,62,65,69]];
  const keys=create('Analog keys.wav',phrase,(t)=>{
    const chord=chords[Math.min(3,Math.floor(t/bar))],step=Math.floor(t/(beat/2)),local=t%(beat/2),note=chord[[0,2,1,3,2,1,3,2][step%8]],f=midi(note+12);
    const env=(1-Math.exp(-local*160))*Math.exp(-local*6.8),bell=(Math.sin(twopi*f*t)+.22*Math.sin(twopi*f*2.001*t)+.08*Math.sin(twopi*f*3*t))*.22*env;
    let pad=0;for(const n of chord)pad+=Math.sin(twopi*midi(n)*t)*.011;
    const swell=Math.min(1,(t%bar)*4,(bar-t%bar)*4);return [bell+pad*swell,bell*(.87+.1*Math.sin(t*.7))+pad*swell];
  });
  const bass=create('Velvet sub.wav',phrase,(t)=>{
    const roots=[36,32,39,34],step=Math.floor(t/beat),local=t%beat,f=midi(roots[Math.min(3,Math.floor(t/bar))]);
    const env=(1-Math.exp(-local*80))*Math.exp(-local*3.5)*Math.min(1,(beat-local)*50);
    const x=(Math.sin(twopi*f*t)+.15*Math.sin(twopi*f*2*t))*.33*env*(step%4===3?.65:1);return [x,x];
  });
  let kickPhase=0,prevNoise=0;
  const drums=create('808 drum machine.wav',phrase,(t)=>{
    const local=t%beat,step=Math.floor(t/beat),sub=t%(beat/2),rnd=noise();
    if(local<1/sampleRate*1.1)kickPhase=0;kickPhase+=twopi*(44+110*Math.exp(-local*40))/sampleRate;
    const kick=Math.sin(kickPhase)*Math.exp(-local*15)*.54;
    const snare=step%2===1?((rnd-prevNoise*.55)*Math.exp(-local*24)*.21+Math.sin(twopi*175*local)*Math.exp(-local*35)*.1):0;
    const hat=(rnd-prevNoise)*Math.exp(-sub*90)*.038;prevNoise=rnd;
    return [kick+snare+hat,kick+snare+hat*.8];
  });
  let lp=0;
  const atmosphere=create('Night air.wav',phrase*2,(t)=>{
    lp+=.008*(noise()-lp);const chord=chords[Math.min(3,Math.floor((t%phrase)/bar))];let l=0,r=0;
    for(const n of chord){const f=midi(n);l+=(Math.sin(twopi*f*t)+.3*Math.sin(twopi*f*2*t))*.018;r+=(Math.sin(twopi*f*1.001*t)+.3*Math.sin(twopi*f*2.001*t))*.018;}
    const swell=.35+.65*Math.pow(Math.sin(Math.PI*(t%bar)/bar),2);return [l*swell+lp*.1,r*swell+lp*.1];
  });
  let last=0;
  const percussion=create('Orbit percussion.wav',phrase,(t)=>{
    const s=Math.floor(t/(beat/4)),local=t%(beat/4),n=noise(),hp=n-last;last=n;
    const x=hp*Math.exp(-local*130)*.055*(s%4===2?1:.4),click=Math.sin(twopi*(750+Math.sin(s)*130)*local)*Math.exp(-local*95)*.045*(s%3===0?1:0);
    return [x+click*.4,x*.65+click];
  });
  let filtered=0;
  const transition=create('Reverse bloom.wav',bar*2,(t)=>{
    const p=t/(bar*2);filtered+=(.03+p*.2)*(noise()-filtered);const env=Math.pow(p,2)*Math.min(1,(1-p)*30);
    const x=(filtered*.19+Math.sin(twopi*(300*t+200*t*t))*.022)*env;return [x,x*.8+Math.sin(twopi*601*t)*.007*env];
  });
  return {bpm,bar,phrase,assets:[keys,bass,drums,atmosphere,percussion,transition]};
}
