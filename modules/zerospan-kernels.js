"use strict";
/* ======================= ZERO-SPAN — ядро ======================= */
// Огибающая на одной частоте от времени, без DOM: node tools/test-zerospan.mjs.
// IQ → сдвиг на off → два однополюсных ФНЧ (RBW) → мощность, усреднённая по D отсчётам → дБ в кольцо точек.
// Триггер по уровню (rise / fall) с предзаписью: кадр из ZS_NW точек вокруг события.

const ZS_NW=800, ZS_RING=16384;                      // точек в кадре; кольцо длиннее двух кадров

function zsNew(){
  return {cr:1,ci:0,a1r:0,a1i:0,a2r:0,a2i:0,acc:0,cnt:0,ring:new Float32Array(ZS_RING),total:0,prev:-200,
    frame:null,trigIdx:-1,nTrig:0,pend:-1,trigAt:0,dead:0,lastCap:0,armed:true,auto:false,key:''};
}
// отсчётов на точку: ZS_NW точек на развёртку
const zsDecim=(sr,sweepMs)=>Math.max(1,Math.round(sr*sweepMs/1000/ZS_NW));

// блок IQ → новые точки огибающей; p={sr,off,rbw,sweepMs,mode:'free'|'rise'|'fall',level,tpos(0..1),auto}
// Смена параметров, влияющих на кольцо (sr, D), сбрасывает накопленное. Возвращает число новых точек.
function zsPush(st,re,im,p){
  const D=zsDecim(p.sr,p.sweepMs), key=p.sr+'|'+D;
  if(st.key!==key){ st.key=key; st.total=0; st.acc=0; st.cnt=0; st.frame=null; st.pend=-1; st.trigIdx=-1; st.lastCap=0; st.prev=-200; }
  const L=re.length, w=-2*Math.PI*p.off/p.sr, wr=Math.cos(w), wi=Math.sin(w);
  const al=p.rbw>=p.sr/2 ? 1 : 1-Math.exp(-Math.PI*p.rbw/p.sr);   // полюс на ±rbw/2; два полюса — ≈ −3 дБ на 0.64·rbw
  let cr=st.cr, ci=st.ci, a1r=st.a1r, a1i=st.a1i, a2r=st.a2r, a2i=st.a2i, acc=st.acc, cnt=st.cnt, np=0;
  const pre=Math.round((p.tpos??.5)*ZS_NW), post=ZS_NW-pre;
  for(let i=0;i<L;i++){
    const xr=re[i], xi=im?im[i]:0;
    const yr=xr*cr-xi*ci, yi=xr*ci+xi*cr;
    const t=cr*wr-ci*wi; ci=cr*wi+ci*wr; cr=t;
    a1r+=al*(yr-a1r); a1i+=al*(yi-a1i); a2r+=al*(a1r-a2r); a2i+=al*(a1i-a2i);
    acc+=a2r*a2r+a2i*a2i;
    if(++cnt===D){
      const db=10*Math.log10(acc/D+1e-20); acc=0; cnt=0; np++;
      const k=st.total;
      st.prev=k>0 ? st.ring[(k-1)%ZS_RING] : -200;
      st.ring[k%ZS_RING]=db; st.total=k+1;
      if(p.mode!=='free' && st.armed){
        if(st.pend>0){ if(--st.pend===0) zsCapture(st,pre,post); }
        else if(st.dead>0) st.dead--;
        else if(k>=pre+2){
          const lv=p.level, hit=p.mode==='rise' ? st.prev<lv && db>=lv : st.prev>=lv && db<lv;
          if(hit){ st.trigAt=k; st.pend=post; if(post===0) zsCapture(st,pre,post); }
        }
      }
    }
  }
  if(Math.abs(cr*cr+ci*ci-1)>1e-3){ const g=1/Math.sqrt(cr*cr+ci*ci); cr*=g; ci*=g; }
  st.cr=cr; st.ci=ci; st.a1r=a1r; st.a1i=a1i; st.a2r=a2r; st.a2i=a2i; st.acc=acc; st.cnt=cnt;
  if(p.mode==='free') zsSnapshot(st);
  else if(p.auto && st.total-st.lastCap>2*ZS_NW && st.total>=ZS_NW) zsSnapshot(st);   // авто: нет события — свободный кадр
  return np;
}
function zsCapture(st,pre,post){
  const f=new Float32Array(ZS_NW), s=st.trigAt-pre;
  for(let i=0;i<ZS_NW;i++) f[i]=st.ring[(s+i)%ZS_RING];
  st.frame=f; st.trigIdx=pre; st.nTrig++; st.pend=-1; st.lastCap=st.total; st.dead=pre; st.auto=false;
}
function zsSnapshot(st){
  if(st.total<ZS_NW) return;
  const f=new Float32Array(ZS_NW), s=st.total-ZS_NW;
  for(let i=0;i<ZS_NW;i++) f[i]=st.ring[(s+i)%ZS_RING];
  st.frame=f; st.trigIdx=-1; st.auto=true;
}

// измерения кадра: dt — секунд на точку, thr — порог, дБ (для импульсов; без него — середина размаха)
function zsMeasure(f,dt,thr){
  if(!f) return null;
  let mx=-Infinity, mn=Infinity, s=0;
  for(const v of f){ if(v>mx) mx=v; if(v<mn) mn=v; s+=Math.pow(10,v/10); }
  const r={peak:mx, min:mn, mean:10*Math.log10(s/f.length+1e-20), width:NaN, period:NaN, duty:NaN, rise:NaN};
  if(mx-mn<3) return r;
  const th=Number.isFinite(thr)&&thr>mn&&thr<mx ? thr : (mx+mn)/2, up=[], dn=[];
  for(let i=1;i<f.length;i++){
    if(f[i-1]<th && f[i]>=th) up.push(i-1+(th-f[i-1])/((f[i]-f[i-1])||1));
    else if(f[i-1]>=th && f[i]<th) dn.push(i-1+(f[i-1]-th)/((f[i-1]-f[i])||1));
  }
  const u0=up[0];
  if(u0!=null){
    const d0=dn.find(x=>x>u0);
    if(d0!=null) r.width=(d0-u0)*dt;
    if(up.length>1) r.period=(up[1]-u0)*dt;
    if(r.period>0 && r.width>0) r.duty=r.width/r.period;
    // фронт 10…90 % по линейной мощности: назад от порога до 10 %, вперёд до 90 %
    const pmn=Math.pow(10,mn/10), pmx=Math.pow(10,mx/10), p10=10*Math.log10(pmn+.1*(pmx-pmn)), p90=10*Math.log10(pmn+.9*(pmx-pmn));
    let i=Math.floor(u0), a=null, b=null;
    while(i>0 && f[i]>=p10) i--;                       // порог триггера мог лежать выше 10 % — сначала выходим под них
    for(i++;i<f.length;i++) if(f[i]>=p10){ a=i-1+(p10-f[i-1])/((f[i]-f[i-1])||1); break; }
    if(a!=null) for(;i<f.length;i++) if(f[i]>=p90){ b=i-1+(p90-f[i-1])/((f[i]-f[i-1])||1); break; }
    if(a!=null && b!=null && b>a) r.rise=(b-a)*dt;
  }
  return r;
}
// формат времени: 1.5 ms, 200 µs, 300 ns
function zsFmtT(s){
  if(!Number.isFinite(s)) return '—';
  const a=Math.abs(s);
  return a>=1 ? s.toFixed(2)+' s' : a>=1e-3 ? (s*1e3).toFixed(a>=1e-2?1:2)+' ms' : a>=1e-6 ? (s*1e6).toFixed(a>=1e-5?0:1)+' µs' : (s*1e9).toFixed(0)+' ns';
}
