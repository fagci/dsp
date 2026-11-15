"use strict";
/* ============================ GPS L1 C/A: IQ-блоки (ядра для воркера острова) ============================
   gpsSky — «небо» без эфира: IQ с несущей 1575.42 МГц по выдуманному созвездию (передатчик-зеркало приёмника).
            Сигнал нельзя излучать в эфир: орбиты и эфемериды вымышлены.
   gpsRx  — приёмник: IQ → поиск PRN → слежение → биты и эфемериды → позиция раз в секунду.
   Логика — в gps-kernels.js (проверяется node tools/test-gps.mjs); здесь только поток и расписание.
   Частота дискретизации: fs/1000 — степень двойки (1.024 / 2.048 / 4.096 МС/с), центр — 1575.42 МГц. */

const GPS_SR_OPTS=['1024000','2048000','4096000'];
const _gpsPow2=sr=>{ const N=Math.round(sr/1000); return N>=1024 && N<=4096 && !(N&(N-1)) && Math.abs(sr-N*1000)<1; };

// выдуманное созвездие, видимое из точки rcv; возвращает [{prn,eph,el}] по убыванию высоты
function gpsPickSats(rcv,tow,count,toe){
  const all=[]; for(let s=0;s<24;s++){ const e=gpsDemoEph(s,toe), p=gpsSatPos(e,tow), ea=gpsElAz(rcv,[p.x,p.y,p.z]); all.push({prn:s+1,eph:e,el:ea.el,az:ea.az}); }
  all.sort((a,b)=>b.el-a.el);
  let use=all.filter(a=>a.el>10); if(use.length<4) use=all.filter(a=>a.el>0);
  return use.slice(0,Math.max(4,count|0));
}

IQK.gpsSky={
  init(n){ n.key=''; n.gen=null; n.k=0; n.msAcc=0; n.ui=null; n.t=0; },
  process(n,I,ctx){
    const p=n.p, sr=+p.sr||2048000, s=iqStream(n,'iq',sr,1575.42e6);
    if(!_gpsPow2(sr)){ n.ui={err:'sample rate: 1.024 / 2.048 / 4.096 MS/s'}; return {iq:s,fc:1575.42e6,rec:null}; }
    const lat=typeof I.lat==='number'?I.lat:+p.lat, lon=typeof I.lon==='number'?I.lon:+p.lon;
    const key=[sr,lat.toFixed(5),lon.toFixed(5),p.alt,p.nsat,p.cn0,p.cycle].join('|');
    if(key!==n.key){
      n.key=key; const toe=1792, tow0=1799, rcv=gpsGeo2Ecef(lat,lon,+p.alt||0), sats=gpsPickSats(rcv,tow0,+p.nsat||6,toe);
      const sigma=Math.sqrt(sr/(2*Math.pow(10,(+p.cn0||46)/10)));
      n.gen=gpsSynth({fs:sr,tow0,rcv,noise:sigma,seed:7,sats:sats.map((a,i)=>({prn:a.prn,eph:a.eph,amp:0.7+0.3*Math.sin(a.el*Math.PI/180),phi:i,
        cycle:/^full/.test(p.cycle||'')?[1,2,3,4,5]:[1,2,3]}))});
      n.k=0; n.msAcc=0; n.sats=sats; n.truth=[lat,lon,+p.alt||0];
    }
    n.msAcc+=1000*ctx.block/ctx.sr;
    let made=0; while(n.msAcc>=1 && made<400){ const b=n.gen.block(n.k++); iqPush(s,b.re,b.im); n.msAcc-=1; made++; }
    const now=Date.now(); let rec=null;
    if(now-n.t>1000){ n.t=now; rec=[{t:now,src:'GPS',id:'truth',label:'true position (generator)',lat:n.truth[0],lon:n.truth[1],alt:n.truth[2],color:'#ff6b6b'}]; }
    n.ui={sats:n.sats.map(a=>'PRN'+a.prn+' '+a.el.toFixed(0)+'°').join(' · '),t:n.k/1000};
    return {iq:s,fc:1575.42e6,rec};
  }
};

// ---------------- приёмник ----------------
IQK.gpsRx={
  init(n){ n.key=''; n.ch=[]; n.gi=0; n.cool=0; n.scan=0; n.fixes=[]; n.ui=null; n.lastFix=0; n.fix=null; n.status='waiting for IQ'; n.ringN=0; n.nacq=0; n.x0=null; n.reason=''; },
  reset(n){ n.ch=[]; n.gi=0; n.cool=0; n.fixes=[]; n.fix=null; n.ringN=0; n.x0=null; n.lastFix=0; n.reason=''; },
  process(n,I){
    const none={rec:null,text:null,lat:null,lon:null,alt:null,nsat:0,pdop:null};
    const s=iqIn(I,'in');
    if(!s){ n.ui=null; return none; }
    if(n.p.on===false){ this.reset(n); n.key=''; n.ui={err:'off'}; return none; }
    if(!_gpsPow2(s.sr)){ n.ui={err:'needs fs/1000 = 1024, 2048 or 4096 (1.024 / 2.048 / 4.096 MS/s), got '+(s.sr/1e6).toFixed(3)}; return none; }
    if(s.chunks.length && !s.chunks[0].im){ n.ui={err:'needs a complex IQ stream'}; return none; }
    const N=Math.round(s.sr/1000), R=40*N;
    if(n.key!==String(s.sr)){ n.key=String(s.sr); this.reset(n); n.fs=s.sr; n.N=N; n.ringRe=new Float32Array(R); n.ringIm=new Float32Array(R); }
    let total=0;
    for(const c of s.chunks){
      if(c.tag){ this.reset(n); }
      const re=c.re, im=iqChunkIm(c), L=re.length; total+=L;
      for(const h of n.ch) gpsTrackPush(h.tr,{re,im});
      // кольцо последних 40 мс — для поиска и «догонки» нового канала
      if(L>=R){ n.ringRe.set(re.subarray(L-R)); n.ringIm.set(im.subarray(L-R)); }
      else { n.ringRe.copyWithin(0,L); n.ringIm.copyWithin(0,L); n.ringRe.set(re,R-L); n.ringIm.set(im,R-L); }
      n.ringN=Math.min(R,n.ringN+L); n.gi+=L;
    }
    n.cool-=total;
    const maxSat=Math.max(4,+n.p.maxSat||8);
    // —— обслуживание каналов ——
    for(const h of n.ch){
      const tr=h.tr;
      if(tr.ne>1500 && tr.lock<0.2){ if(!h.weakFrom) h.weakFrom=n.gi; else if(n.gi-h.weakFrom>n.fs*1.5) h.dead=true; } else h.weakFrom=0;
      if(!h.eph && tr.ne-h.navAt>=500){ h.navAt=tr.ne; const nav=gpsChannelNav(tr); if(nav.ok){ h.frames=nav.frames.length; if(nav.eph&&nav.ref){ h.eph=nav.eph; h.refAbs=nav.ref.epoch; h.refTsv=nav.ref.tsv; } } }
    }
    n.ch=n.ch.filter(h=>!h.dead);
    // —— поиск: один PRN за раз, не чаще раза в 250 мс потока ——
    if(n.cool<=0 && n.ch.length<maxSat && n.ringN>=12*N){
      n.cool=n.fs*0.25;
      let prn=0; for(let k=0;k<32;k++){ const c=(n.scan+k)%32+1; if(!n.ch.some(h=>h.prn===c)){ prn=c; n.scan=c; break; } }
      if(prn){
        const v=n.ringN, off=n.gi-v, sRe=n.ringRe.slice(R-v), sIm=n.ringIm.slice(R-v);
        const a=gpsAcquire({re:sRe,im:sIm},n.fs,prn,{ms:10,step:333,maxd:(+n.p.maxd||5)*1000,thr:+n.p.thr||5}); n.nacq++;
        if(a.found){
          const tr=gpsTrackNew(prn,n.fs,a,{keep:50000}); gpsTrackPush(tr,{re:sRe,im:sIm});
          n.ch.push({prn,tr,off,acq:a,navAt:0,frames:0,eph:null,weakFrom:0,born:n.gi,dead:false});
        }
      }
    }
    // —— позиция раз в секунду потока ——
    let rec=null,text=null,out={lat:null,lon:null,alt:null,nsat:0,pdop:null};
    if(n.gi-n.lastFix>=n.fs && n.gi>0){
      n.lastFix=n.gi;
      const list=n.ch.filter(h=>h.eph&&h.tr.S.length>200).map(h=>({prn:h.prn,S:h.tr.S,fs:n.fs,off:h.off,drop:h.tr.drop,ref:{epoch:h.refAbs,tsv:h.refTsv},eph:h.eph}));
      if(list.length>=4){
        const fx=gpsSolve(gpsPseudoranges(list),n.x0?{x0:n.x0}:{});
        if(fx.ok && fx.pdop<15 && fx.rms<60 && Math.abs(fx.h)<20000){
          n.x0=[fx.x,fx.y,fx.z]; n.fixes.push(fx); const A=Math.max(1,+n.p.avg||1); while(n.fixes.length>A) n.fixes.shift();
          let x=0,y=0,z=0; for(const f of n.fixes){ x+=f.x; y+=f.y; z+=f.z; } x/=n.fixes.length; y/=n.fixes.length; z/=n.fixes.length;
          const g=gpsEcef2Geo(x,y,z); n.fix={lat:g.lat,lon:g.lon,h:g.h,pdop:fx.pdop,rms:fx.rms,n:list.length,cb:fx.cb,t:Date.now(),k:n.fixes.length};
          const h0=n.ch.find(h=>h.prn===list[0].prn), tow=h0.refTsv+(h0.tr.S.length-1+h0.tr.drop-h0.refAbs)*0.001; rec=[{t:Date.now(),src:'GPS',id:'gps-sdr',label:'GPS fix (SDR)',lat:g.lat,lon:g.lon,alt:g.h,sats:list.length,pdop:+fx.pdop.toFixed(2),color:'#4ade80'}];
          text=gpsNmeaGGA({lat:g.lat,lon:g.lon,h:g.h,pdop:fx.pdop},tow,list.length);
          out={lat:g.lat,lon:g.lon,alt:g.h,nsat:list.length,pdop:fx.pdop};
        } else if(fx.ok){ n.reason='fix rejected: PDOP '+fx.pdop.toFixed(1)+', residual '+fx.rms.toFixed(0)+' m'; }
      } else n.reason=list.length+' of 4 satellites with ephemeris';
    }
    const now=n.fix;
    n.ui={fs:n.fs,N,nacq:n.nacq,fix:now,reason:n.reason,
      rows:n.ch.map(h=>({prn:h.prn,dopp:h.tr.carrierHz(),lock:h.tr.lock,ratio:h.acq.ratio,sec:h.tr.ne/1000,frames:h.frames,eph:!!h.eph})),
      scan:n.scan,gi:n.gi};
    return {rec,text,lat:out.lat,lon:out.lon,alt:out.alt,nsat:out.nsat||n.ch.filter(h=>h.eph).length,pdop:out.pdop};
  }
};
