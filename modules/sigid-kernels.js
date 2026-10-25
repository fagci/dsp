"use strict";
/* ============================ sigid: слабые сигналы и нужная полоса (ядро) ============================
   sidWeakFind — поиск сигнала в шуме по спектру мощности pw и полу шума fl: отношение pw/fl сглаживается окнами
   разной ширины (согласованный фильтр: чем шире сигнал, тем глубже он «вытягивается» из шума), порог — в σ, а σ берётся
   по самому спектру (медиана и MAD сглаженного ряда: сигналов в полосе мало, шум коррелирован между бинами).
   sidNeedBw — какую полосу приёма поставить сигналу: из каталога сигналов, иначе измеренная ширина + запас,
   округлённая вверх до стандартной ширины канала. */
const SID_WIDTHS=[3,8,24,64,192,512];
const SID_STD_BW=[300,500,1e3,2.4e3,3e3,6e3,8.33e3,9e3,10e3,12.5e3,15e3,20e3,25e3,30e3,50e3,100e3,150e3,200e3,250e3,300e3,500e3,1e6,1.5e6,2e6,3e6,5e6,8e6,10e6,20e6];
function sidStdBw(bw){ for(const s of SID_STD_BW) if(s>=bw) return s; return bw; }
// ia..ib — область поиска (бины, включительно); возвращает [{a,b,z,snr}] по убыванию z: snr — отношение сигнал/шум в полосе, дБ
function sidWeakFind(pw,fl,ia,ib,zthr,widths){
  const out=[], n=ib-ia+1;
  if(n<16) return out;
  const cs=new Float64Array(n+1);
  for(let i=0;i<n;i++){ const f=fl[ia+i]; cs[i+1]=cs[i]+(f>0 ? pw[ia+i]/f : 1); }
  const cut=new Float32Array(n);
  for(const W of (widths||SID_WIDTHS)){
    const m=n-W+1; if(m<16) continue;
    const s=new Float32Array(m);
    for(let j=0;j<m;j++) s[j]=(cs[j+W]-cs[j])/W;
    const srt=Float32Array.from(s).sort(), med=srt[m>>1];
    const dev=new Float32Array(m); for(let j=0;j<m;j++) dev[j]=Math.abs(s[j]-med);
    dev.sort();
    // хвост шума у узких окон тяжелее гауссова (хи-квадрат): σ растёт на отношение фактического 99-го процентиля к гауссову, не больше чем вдвое
    const sg0=Math.max(1.4826*dev[m>>1],1e-6), tail=Math.min(2,Math.max(1,(srt[Math.min(m-1,Math.floor(.99*m))]-med)/(2.326*sg0))), sig=sg0*tail;
    for(let j=0;j<m;j++){
      const z=(s[j]-med)/sig;
      if(z<zthr) continue;
      let k=j; while(k+1<m && (s[k+1]-med)/sig>=zthr) k++;       // плато порога — один пик
      let pj=j; for(let t=j;t<=k;t++) if(s[t]>s[pj]) pj=t;
      const zp=(s[pj]-med)/sig, a=ia+j, b=ia+k+W-1;
      out.push({a:ia+pj, b:ia+pj+W-1, a0:a, b0:b, z:zp, snr:10*Math.log10(Math.max(s[pj]-med,1e-3)), W});
      j=k;
    }
  }
  // сильнейшие первыми; пересекающиеся — один сигнал (берём с большим z)
  out.sort((x,y)=>y.z-x.z);
  const keep=[];
  for(const c of out) if(!keep.some(k=>c.a<=k.b0 && c.b>=k.a0)) keep.push(c);
  return keep;
}
// вид сигнала sigid → режим демодулятора USB SDR; '' — нечем слушать (цифровой: нужен IQ и декодер из каталога)
const SID_DEMOD={NFM:'NFM',WFM:'WFM',AM:'AM',USB:'USB',LSB:'LSB',SSB:'USB',CW:'USB',CAR:'AM'};
function sidDemodOf(t){ return SID_DEMOD[t]||''; }
// g: {obw, fc}; cat — запись каталога сигналов (или null). Возвращает нужную ширину приёма, Гц
function sidNeedBw(obw,cat){
  if(cat && cat.bw>0) return Math.max(cat.bw,0);
  return sidStdBw(obw*1.1);
}
// уточнить границы найденного окна [a,b] по уровню 30% высоты сглаженного превышения над шумом; бины, включительно
function sidRefine(pw,fl,ia,ib,a,b,snrDb){
  const W=b-a+1, w2=Math.max(1,W>>3), lo=Math.max(ia,a-W), hi=Math.min(ib,b+W), n=hi-lo+1;
  if(n<w2+2) return [a,b];
  const cs=new Float64Array(n+1);
  for(let i=0;i<n;i++){ const f=fl[lo+i]; cs[i+1]=cs[i]+(f>0 ? pw[lo+i]/f : 1); }
  const sm=i=>{ const i0=Math.max(0,i-(w2>>1)), i1=Math.min(n,i0+w2); return (cs[i1]-cs[i0])/Math.max(1,i1-i0); };
  let base=0; { const c0=Math.max(0,a-lo), c1=Math.min(n,b-lo+1); base=(cs[c1]-cs[c0])/Math.max(1,c1-c0); }
  const thr=1+(base-1)*.3, mid=((a+b)>>1)-lo;
  if(!(thr>1)) return [a,b];
  let l=mid, r=mid;
  while(l>0 && sm(l-1)>=thr) l--;
  while(r<n-1 && sm(r+1)>=thr) r++;
  return r-l+1>=2 ? [lo+l,lo+r] : [a,b];
}
