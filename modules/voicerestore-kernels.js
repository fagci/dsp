"use strict";
/* ============================ Восстановление «бубнящей» речи — чистая логика ============================
   Речь после ФНЧ/узкополосного канала звучит глухо: съедены верха (согласные, «с», «ш»), раздут низ (гул, бубнение). Здесь два шага в одном
   спектральном проходе (STFT, окно √Ханна, перекрытие 75 %):
   1) слепой эквалайзер: долговременный спектр активной речи по 1/3-октавным полосам сравнивается с типовым спектром речи (форма LTASS),
      полосы поправляются к нему (подъём не выше maxBoost, спад не выше 12 дБ); полосы у шумового пола не поднимаются — иначе вырастет шум;
   2) достройка полосы: выше найденной частоты среза недостающий верх строится сдвигом нижней октавы вверх (точная тонкая структура
      не восстанавливается, это «правдоподобный» верх по форме спектра речи), громкость — по форме LTASS.
   Нужен fft() из core-dsp.js. Тест tools/test-voicerestore.mjs. */

// типовой долговременный спектр речи, дБ относительно 500 Гц (форма по Byrne et al. 1994, 1/3-октавные уровни, округлено)
const VR_TMPL=[[50,-24],[80,-14],[125,-6],[250,0],[500,0],[1000,-6],[2000,-11],[4000,-17],[8000,-23],[16000,-31]];
function vrTmpl(f){
  if(f<=VR_TMPL[0][0]) return VR_TMPL[0][1];
  for(let i=1;i<VR_TMPL.length;i++){
    const a=VR_TMPL[i-1], b=VR_TMPL[i];
    if(f<=b[0]) return a[1]+(b[1]-a[1])*Math.log(f/a[0])/Math.log(b[0]/a[0]);
  }
  return VR_TMPL[VR_TMPL.length-1][1];
}
// полосы по бинам: примерно 1/3 октавы, но не уже двух бинов; возвращает {edges, centers(Гц)}
function vrBands(N,sr){
  const H=N>>1, edges=[1];
  let k=1; while(k<H){ k=Math.min(H,Math.max(k+2,Math.round(k*Math.pow(2,1/3)))); edges.push(k); }
  const centers=[]; for(let b=0;b<edges.length-1;b++) centers.push((edges[b]+edges[b+1]-1)/2*sr/N);
  return {edges,centers};
}

// потоковый STFT: fn(re,im,idx) правит спектр кадра (бины 0…N/2) на месте; задержка N отсчётов
function vrStft(N,fn){
  const hop=N>>2, win=new Float64Array(N);
  for(let i=0;i<N;i++) win[i]=Math.sqrt(.5*(1-Math.cos(2*Math.PI*i/N)));
  const ib=new Float64Array(N), ola=new Float64Array(N), re=new Float64Array(N), im=new Float64Array(N);
  let have=0, idx=0, outq=new Float32Array(N*4), no=hop;
  return {N,hop, latency:N,
    push(x){
      const n=x.length;
      let i=0;
      while(i<n){
        const take=Math.min(hop-have,n-i);
        // ib хранит последние N отсчётов; новые hop встают в конец
        if(have===0) ib.copyWithin(0,hop,N);
        for(let k=0;k<take;k++) ib[N-hop+have+k]=x[i+k];
        have+=take; i+=take;
        if(have===hop){
          have=0;
          for(let k=0;k<N;k++){ re[k]=ib[k]*win[k]; im[k]=0; }
          fft(re,im);
          fn(re,im,idx++);
          for(let k=1;k<N>>1;k++){ re[N-k]=re[k]; im[N-k]=-im[k]; }
          im[0]=0; im[N>>1]=0;
          for(let k=0;k<N;k++) im[k]=-im[k];
          fft(re,im);
          const s=1/N*.5;                                   // ifft: 1/N; сумма √Хэнн² по 4 сдвигам = 2
          for(let k=0;k<N;k++) ola[k]+=re[k]*s*win[k];
          if(no+hop>outq.length){ const b=new Float32Array(outq.length*2); b.set(outq.subarray(0,no)); outq=b; }
          for(let k=0;k<hop;k++) outq[no+k]=ola[k];
          no+=hop;
          ola.copyWithin(0,hop,N); ola.fill(0,N-hop,N);
        }
      }
      const out=new Float32Array(n), k=Math.min(no,n);
      out.set(outq.subarray(0,k)); outq.copyWithin(0,k,no); no-=k;
      return out;
    },
    reset(){ ib.fill(0); ola.fill(0); have=0; idx=0; no=hop; }};
}

// opts: {sr, strength 0…1, extend 0…1, boom Гц, maxBoost дБ, adapt с}; возвращает {push(x), info, set(opts), reset()}
function vrRestore(o){
  const sr=o.sr, N=sr>=32000 ? 1024 : 512, H=N>>1, hop=N>>2;
  const {edges,centers}=vrBands(N,sr), B=centers.length, binHz=sr/N;
  const bandOf=new Int32Array(H+1); for(let b=0;b<B;b++) for(let k=edges[b];k<edges[b+1];k++) bandOf[k]=b; bandOf[0]=0; bandOf[H]=B-1;
  const T=centers.map(vrTmpl);
  const ref=[]; for(let b=0;b<B;b++) if(centers[b]>=400 && centers[b]<=1600) ref.push(b);
  const Tref=ref.reduce((s,b)=>s+T[b],0)/Math.max(1,ref.length);
  const ltas=new Float64Array(B), nf=new Float64Array(B).fill(1e-12), P=new Float64Array(B), gdb=new Float64Array(B), gs=new Float64Array(H+1).fill(1);
  const k300=Math.round(300/binHz), k3400=Math.min(H-1,Math.round(3400/binHz));
  const info={cutoff:0, active:0, conf:0, boost:0, boostHz:0};
  let nfE=1e-12, act=0, frames=0;
  const p=Object.assign({strength:.7,extend:.5,boom:80,maxBoost:18,adapt:3},o);
  const fn=(re,im)=>{
    frames++;
    // мощность по полосам
    for(let b=0;b<B;b++){ let s=0; for(let k=edges[b];k<edges[b+1];k++) s+=re[k]*re[k]+im[k]*im[k]; P[b]=s/(edges[b+1]-edges[b]); }
    // шумовой пол: падает сразу, растёт медленно
    for(let b=0;b<B;b++) nf[b]=P[b]<nf[b] ? P[b]+1e-15 : nf[b]*1.002;
    let E=0; for(let k=k300;k<=k3400;k++) E+=re[k]*re[k]+im[k]*im[k];
    nfE=E<nfE ? E+1e-15 : nfE*1.002;
    const active=E>nfE*4 && E>1e-9;
    const a=Math.exp(-hop/sr/Math.max(.3,p.adapt));
    if(active){ act++; for(let b=0;b<B;b++) ltas[b]=ltas[b]===0 ? P[b] : ltas[b]*a+P[b]*(1-a); }
    const need=1.0*sr/hop;                                  // секунда активной речи — полная уверенность
    const conf=Math.min(1,act/need); info.conf=conf; info.active=active?1:0;
    // целевая поправка по полосам
    let Lref=0; for(const b of ref) Lref+=10*Math.log10(ltas[b]+1e-20); Lref/=Math.max(1,ref.length);
    let cutB=-1, deadB=-1; info.boost=0;
    for(let b=0;b<B;b++){
      const snr=10*Math.log10((ltas[b]+1e-20)/(nf[b]+1e-20));
      // «мёртвая» полоса: провал относительно типового спектра больше, чем может поднять эквалайзер, — её нужно достраивать
      const deficit=(T[b]-Tref)-(10*Math.log10(ltas[b]+1e-20)-Lref);
      if(deadB<0 && ltas[b]>0 && centers[b]>800 && deficit>p.maxBoost+6) deadB=b;
      const w=Math.min(1,Math.max(0,(snr-3)/12));
      let g=((T[b]-Tref)-(10*Math.log10(ltas[b]+1e-20)-Lref))*p.strength*conf;
      g=g>0 ? Math.min(g,p.maxBoost)*w : Math.max(g,-12);
      gdb[b]=gdb[b]*.8+g*.2;
      if(gdb[b]>info.boost){ info.boost=gdb[b]; info.boostHz=centers[b]; }
    }
    if(deadB>0) cutB=deadB-1;
    // по бинам: линейная интерполяция по центрам полос, сглаживание во времени
    for(let k=1;k<H;k++){
      const b=bandOf[k], f=k*binHz; let b0=b, b1=b;
      if(f<centers[b]) b0=Math.max(0,b-1); else b1=Math.min(B-1,b+1);
      const t=b1===b0 ? 0 : (f-centers[b0])/(centers[b1]-centers[b0]);
      let g=gdb[b0]+(gdb[b1]-gdb[b0])*Math.min(1,Math.max(0,t));
      if(p.boom>0){ const r=f/p.boom; g+=-10*Math.log10(1+Math.pow(1/Math.max(r,1e-3),4)); }     // подрезка низа: 24 дБ/окт ниже boom
      const lin=Math.pow(10,g/20);
      gs[k]=gs[k]*.6+lin*.4;
    }
    for(let k=1;k<H;k++){ re[k]*=gs[k]; im[k]*=gs[k]; }
    // достройка верха выше среза
    const nyq=Math.min(sr/2,8000);
    if(cutB>=0 && p.extend>0 && active && conf>.3){
      const kc=Math.min(H-2,edges[cutB+1]), fc=kc*binHz;
      info.cutoff=fc;
      if(fc<nyq*.85 && kc>=8){
        const d=Math.max(2,kc>>1), kmax=Math.min(H-1,Math.round(Math.min(sr/2*.98,12000)/binHz));
        // мощность в полосе кадра, на которую опираемся, и в полосе чуть выше среза — достраиваем только недостающее
        for(let k=kc;k<=kmax;k++){
          let s=k; while(s>=kc) s-=d;
          if(s<2) continue;
          const m=Math.hypot(re[s],im[s]); if(m<=0) continue;
          const dest=Math.hypot(re[k],im[k]);
          const want=m*Math.pow(10,(vrTmpl(k*binHz)-vrTmpl(s*binHz))/20)*p.extend*.7*gs[s];
          if(want>dest){ const c=(want-dest)/m; re[k]+=re[s]*c; im[k]+=im[s]*c; }
        }
      }
    }else if(cutB>=0) info.cutoff=edges[cutB+1]*binHz;
  };
  const st=vrStft(N,fn);
  return {info, N, latency:N/sr, push:x=>st.push(x), reset(){ st.reset(); ltas.fill(0); nf.fill(1e-12); gdb.fill(0); gs.fill(1); act=0; frames=0; nfE=1e-12; },
          set(q){ Object.assign(p,q); }};
}
