/** Deterministic DSP shared by the worker and the Node test suite. */
export function buildPeaks(channels, baseBlock=128) {
  return channels.map(data=>{
    const levels=[]; let block=baseBlock;
    let min=new Float32Array(Math.ceil(data.length/block)),max=new Float32Array(min.length);
    for(let b=0;b<min.length;b++){let lo=1,hi=-1;for(let i=b*block,end=Math.min(data.length,(b+1)*block);i<end;i++){lo=Math.min(lo,data[i]);hi=Math.max(hi,data[i]);}min[b]=lo;max[b]=hi;}
    levels.push({block,min,max});
    while(min.length>1){const nmin=new Float32Array(Math.ceil(min.length/2)),nmax=new Float32Array(nmin.length);for(let i=0;i<nmin.length;i++){nmin[i]=Math.min(min[i*2],min[i*2+1]??min[i*2]);nmax[i]=Math.max(max[i*2],max[i*2+1]??max[i*2]);}block*=2;min=nmin;max=nmax;levels.push({block,min,max});}
    return levels;
  });
}
export function statistics(channels) {
  let sum=0,peak=0,dc=0,count=0,clipped=0;
  for(const data of channels)for(const x of data){sum+=x*x;peak=Math.max(peak,Math.abs(x));dc+=x;count++;if(Math.abs(x)>=1)clipped++;}
  return {peak,rms:Math.sqrt(sum/Math.max(1,count)),dc:dc/Math.max(1,count),clipped,samples:channels[0]?.length||0,channels:channels.length};
}
export class FFT {
  constructor(size=2048){
    if(size<2||(size&(size-1)))throw new Error('FFT size must be a power of two.');
    this.size=size;this.reverse=new Uint32Array(size);
    const bits=Math.log2(size);
    for(let i=0;i<size;i++){let n=i,r=0;for(let j=0;j<bits;j++){r=(r<<1)|(n&1);n>>>=1;}this.reverse[i]=r;}
  }
  transform(real,imag,inverse=false){
    const n=this.size;
    if(real.length!==n||imag.length!==n)throw new Error('FFT buffer length mismatch.');
    for(let i=0;i<n;i++){const j=this.reverse[i];if(j>i){[real[i],real[j]]=[real[j],real[i]];[imag[i],imag[j]]=[imag[j],imag[i]];}}
    for(let length=2;length<=n;length*=2){const angle=(inverse?2:-2)*Math.PI/length,wr0=Math.cos(angle),wi0=Math.sin(angle);for(let i=0;i<n;i+=length){let wr=1,wi=0;for(let j=0;j<length/2;j++){const a=i+j,b=a+length/2,tr=real[b]*wr-imag[b]*wi,ti=real[b]*wi+imag[b]*wr;real[b]=real[a]-tr;imag[b]=imag[a]-ti;real[a]+=tr;imag[a]+=ti;const next=wr*wr0-wi*wi0;wi=wr*wi0+wi*wr0;wr=next;}}}
    if(inverse)for(let i=0;i<n;i++){real[i]/=n;imag[i]/=n;}
  }
}
export function spectrum(channels,sampleRate,size=2048){
  const fft=new FFT(size),r=new Float64Array(size),im=new Float64Array(size),out=new Float32Array(size/2);
  const data=channels[0],frames=Math.min(32,Math.max(1,Math.floor(data.length/size)));
  for(let f=0;f<frames;f++){
    const start=Math.floor((data.length-size)*f/Math.max(1,frames-1));im.fill(0);
    for(let i=0;i<size;i++)r[i]=(data[start+i]||0)*(.5-.5*Math.cos(2*Math.PI*i/(size-1)));
    fft.transform(r,im);
    for(let k=0;k<out.length;k++)out[k]+=(r[k]*r[k]+im[k]*im[k])/(size*size/16*frames);
  }
  for(let k=0;k<out.length;k++)out[k]=10*Math.log10(Math.max(1e-12,out[k]));
  return {bins:out,sampleRate,size};
}
export function spectrogram(channels,sampleRate,width=900,height=256){
  const size=2048,fft=new FFT(size),r=new Float64Array(size),im=new Float64Array(size),data=channels[0];
  width=Math.max(8,Math.min(1400,width));height=Math.max(32,Math.min(512,height));
  const pixels=new Uint8ClampedArray(width*height*4),nyquist=Math.min(20000,sampleRate/2);
  const stops=[[0,8,10,18],[.2,29,20,61],[.4,100,33,109],[.58,190,57,101],[.76,244,124,64],[1,254,235,147]];
  for(let x=0;x<width;x++){
    const center=Math.floor(x/(width-1)*data.length),start=center-size/2;im.fill(0);
    for(let i=0;i<size;i++)r[i]=(data[start+i]||0)*(.5-.5*Math.cos(2*Math.PI*i/(size-1)));
    fft.transform(r,im);
    for(let y=0;y<height;y++){
      const freq=30*Math.pow(nyquist/30,1-y/(height-1)),bin=Math.max(1,Math.min(size/2-1,Math.round(freq*size/sampleRate)));
      const magnitude=20*Math.log10(Math.max(1e-9,Math.hypot(r[bin],im[bin])/(size/4)));
      const v=Math.max(0,Math.min(1,(magnitude+95)/85));let j=1;while(j<stops.length-1&&v>stops[j][0])j++;
      const a=stops[j-1],b=stops[j],t=(v-a[0])/(b[0]-a[0]),p=(y*width+x)*4;
      for(let c=0;c<3;c++)pixels[p+c]=a[c+1]+(b[c+1]-a[c+1])*t;pixels[p+3]=255;
    }
  }
  return {width,height,pixels};
}
function spectralProcess(data,sampleRate,start,end,low,high,db){
  const n=2048,hop=512,fft=new FFT(n),window=new Float64Array(n),real=new Float64Array(n),imag=new Float64Array(n);
  const out=new Float64Array(data.length),weight=new Float64Array(data.length),factor=Math.pow(10,db/20);
  for(let i=0;i<n;i++)window[i]=Math.sqrt(.5-.5*Math.cos(2*Math.PI*i/n));
  const first=Math.floor((start-n)/hop)*hop,last=Math.min(data.length,end+n);
  for(let pos=first;pos<last;pos+=hop){
    imag.fill(0);for(let i=0;i<n;i++)real[i]=(data[pos+i]||0)*window[i];fft.transform(real,imag);
    for(let k=0;k<n;k++){
      const freq=Math.min(k,n-k)*sampleRate/n,transition=Math.max(30,(high-low)*.05);
      const mix=Math.min(1,Math.max(0,(freq-low+transition)/transition),Math.max(0,(high+transition-freq)/transition));
      const gain=1+(factor-1)*mix;real[k]*=gain;imag[k]*=gain;
    }
    fft.transform(real,imag,true);
    for(let i=0;i<n;i++){const p=pos+i;if(p>=0&&p<data.length){out[p]+=real[i]*window[i];weight[p]+=window[i]*window[i];}}
  }
  const result=data.slice(),edge=Math.max(1,Math.min(sampleRate*.01,(end-start)/4));
  for(let i=start;i<end;i++){const wet=Math.min(1,(i-start)/edge,(end-1-i)/edge);if(weight[i]>1e-10)result[i]=data[i]*(1-wet)+out[i]/weight[i]*wet;}
  return result;
}
export function processAudio(channels,sampleRate,operation,options={}){
  const length=channels[0].length;
  const start=Math.max(0,Math.min(length,Math.floor((options.start||0)*sampleRate))),end=Math.max(start,Math.min(length,Math.ceil((options.end??length/sampleRate)*sampleRate)));
  const result=channels.map(c=>c.slice());
  let peak=0,sum=0,count=0;
  for(const c of result)for(let i=start;i<end;i++){peak=Math.max(peak,Math.abs(c[i]));sum+=c[i]*c[i];count++;}
  const normalization=operation==='normalize'?Math.pow(10,(options.target??-1)/20)/Math.max(peak,1e-10):
    operation==='match-rms'?Math.min(Math.pow(10,(options.target??-18)/20)/Math.max(Math.sqrt(sum/Math.max(count,1)),1e-10),.99/Math.max(peak,1e-10)):1;
  for(let ch=0;ch<result.length;ch++){
    const c=result[ch];
    if(operation==='spectral'){result[ch]=spectralProcess(c,sampleRate,start,end,Math.max(20,options.low||80),Math.min(sampleRate/2,options.high||1000),Math.max(-90,Math.min(0,options.db??-30)));continue;}
    if(operation==='reverse'){for(let i=start,j=end-1;i<j;i++,j--)[c[i],c[j]]=[c[j],c[i]];continue;}
    let dc=0;if(operation==='dc'){for(let i=start;i<end;i++)dc+=c[i];dc/=Math.max(1,end-start);}
    let envelope=0,gate=1;const threshold=Math.pow(10,(options.threshold??-40)/20),attack=Math.exp(-1/(sampleRate*.003)),release=Math.exp(-1/(sampleRate*.08));
    for(let i=start;i<end;i++){
      const t=(i-start)/Math.max(1,end-start-1);
      switch(operation){
        case 'normalize':case 'match-rms':c[i]*=normalization;break;
        case 'gain':c[i]*=Math.pow(10,(options.db??3)/20);break;
        case 'silence':c[i]=0;break;
        case 'fade-in':c[i]*=t;break;
        case 'fade-out':c[i]*=1-t;break;
        case 'dc':c[i]-=dc;break;
        case 'gate':{const a=Math.abs(c[i]);envelope=(a>envelope?attack:release)*envelope+(1-(a>envelope?attack:release))*a;const target=envelope<threshold?0:1;gate+=(target-gate)*(target>gate?.01:.001);c[i]*=gate;break;}
        default:throw new Error(`Unknown audio operation: ${operation}`);
      }
      if(!Number.isFinite(c[i]))c[i]=0;
    }
  }
  return result;
}
export function encodeWav(channels,sampleRate,bitDepth=24,dither=false){
  if(!channels.length||channels.length>32)throw new Error('WAV requires 1–32 channels.');
  if(![16,24,32].includes(bitDepth))throw new Error('Supported WAV depths are 16, 24, and 32-bit float.');
  const frames=channels[0].length,count=channels.length,bytes=bitDepth/8,size=frames*count*bytes;
  if(channels.some(c=>c.length!==frames))throw new Error('WAV channel lengths differ.');
  if(!Number.isInteger(sampleRate)||sampleRate<8000||sampleRate>384000)throw new Error('WAV sample rate is outside 8–384 kHz.');
  const floating=bitDepth===32,extended=bitDepth===24||count>2,fmtSize=extended?40:floating?18:16;
  const headerSize=12+8+fmtSize+(floating?12:0)+8,paddedSize=size+(size&1);
  if(headerSize+paddedSize-8>0xffffffff)throw new Error('The file exceeds the RIFF/WAV 4 GB limit.');
  const buffer=new ArrayBuffer(headerSize+paddedSize),view=new DataView(buffer);let p=0;
  const text=s=>{for(const ch of s)view.setUint8(p++,ch.charCodeAt(0));};
  text('RIFF');view.setUint32(p,buffer.byteLength-8,true);p+=4;text('WAVE');text('fmt ');view.setUint32(p,fmtSize,true);p+=4;
  view.setUint16(p,extended?65534:floating?3:1,true);p+=2;view.setUint16(p,count,true);p+=2;view.setUint32(p,sampleRate,true);p+=4;
  view.setUint32(p,sampleRate*count*bytes,true);p+=4;view.setUint16(p,count*bytes,true);p+=2;view.setUint16(p,bitDepth,true);p+=2;
  if(extended){
    view.setUint16(p,22,true);p+=2;view.setUint16(p,bitDepth,true);p+=2;
    view.setUint32(p,count===1?4:count===2?3:0,true);p+=4;
    view.setUint32(p,floating?3:1,true);p+=4;
    for(const byte of [0,0,16,0,128,0,0,170,0,56,155,113])view.setUint8(p++,byte);
  }else if(floating){view.setUint16(p,0,true);p+=2;}
  if(floating){text('fact');view.setUint32(p,4,true);p+=4;view.setUint32(p,frames,true);p+=4;}
  text('data');view.setUint32(p,size,true);p+=4;
  let seed=0x12345678;const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/4294967296;};
  for(let i=0;i<frames;i++)for(let ch=0;ch<count;ch++){
    let x=Number.isFinite(channels[ch][i])?channels[ch][i]:0;
    if(bitDepth===32){view.setFloat32(p,x,true);p+=4;continue;}
    const max=bitDepth===16?32767:8388607,min=-max-1;
    if(dither)x+=(random()-random())/(max+1);
    const n=Math.max(min,Math.min(max,Math.round(x*(max+1))));
    if(bitDepth===16){view.setInt16(p,n,true);p+=2;}else{view.setUint8(p++,n&255);view.setUint8(p++,(n>>8)&255);view.setUint8(p++,(n>>16)&255);}
  }
  return buffer;
}
export function decodeWav(buffer){
  const v=new DataView(buffer),text=(p,n)=>String.fromCharCode(...new Uint8Array(buffer,p,n));
  if(buffer.byteLength<44||text(0,4)!=='RIFF'||text(8,4)!=='WAVE')throw new Error('Not a RIFF/WAVE file.');
  let p=12,format=0,channels=0,sampleRate=0,bits=0,offset=-1,length=0,align=0;
  while(p+8<=v.byteLength){const id=text(p,4),size=v.getUint32(p+4,true);p+=8;if(p+size>v.byteLength)throw new Error('Truncated WAV file.');
    if(id==='fmt '&&size>=16){format=v.getUint16(p,true);channels=v.getUint16(p+2,true);sampleRate=v.getUint32(p+4,true);align=v.getUint16(p+12,true);bits=v.getUint16(p+14,true);if(format===65534&&size>=40)format=v.getUint16(p+24,true);}
    if(id==='data'){offset=p;length=size;}p+=size+(size&1);
  }
  if(![1,3].includes(format)||!channels||channels>32||sampleRate<8000||sampleRate>384000||offset<0||![8,16,24,32].includes(bits)||(format===3&&bits!==32)||align!==channels*bits/8)throw new Error('Unsupported WAV encoding.');
  const frames=Math.floor(length/align),out=Array.from({length:channels},()=>new Float32Array(frames));p=offset;
  for(let i=0;i<frames;i++)for(let ch=0;ch<channels;ch++){
    let x;if(format===3)x=v.getFloat32(p,true);else if(bits===8)x=(v.getUint8(p)-128)/128;else if(bits===16)x=v.getInt16(p,true)/32768;else if(bits===24){let n=v.getUint8(p)|(v.getUint8(p+1)<<8)|(v.getUint8(p+2)<<16);if(n&0x800000)n|=0xff000000;x=n/8388608;}else x=v.getInt32(p,true)/2147483648;
    out[ch][i]=Number.isFinite(x)?x:0;p+=bits/8;
  }
  return {channels:out,sampleRate};
}
