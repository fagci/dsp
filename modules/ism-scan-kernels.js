"use strict";
/* ============================ ISM Scanner: ядро ============================
   Весь диапазон приёма (RTL-SDR 2.4 МС/с — вся полоса 433,05–434,79 МГц и ещё 0,5 МГц) → полифазный банк каналов
   (как IQ Channelizer, но выходы всех каналов сразу, без выбора слотов: пакет датчика короче интервала выбора) →
   на каждый канал свой детектор импульсов rtl_433 (wasm, vendor/rtl433.wasm: OOK + FSK, все слайсеры и декодеры устройств) →
   очередь записей и неопознанных пакетов (разбор с бюджетом времени за такт) → дедуп между соседними каналами и повторами.
   Неопознанные пакеты уходят в общий анализатор (ismAnalyze, ism-kernels.js): кодирование, тайминги, биты, hex. */

const ISM_RT={p:null, mod:null, err:''};
function ismRtLoad(){
  if(ISM_RT.p || ISM_RT.mod) return ISM_RT.p;
  ISM_RT.p=fetch('vendor/rtl433.wasm').then(r=>{ if(!r.ok) throw new Error('HTTP '+r.status); return r.arrayBuffer(); })
    .then(b=>WebAssembly.compile(b)).then(m=>{ ISM_RT.mod=m; return true; })
    .catch(e=>{ ISM_RT.err=String(e && e.message || e); return false; });
  return ISM_RT.p;
}

const ismNow=()=>typeof performance!=='undefined' ? performance.now() : Date.now();
const ISM_META=new Set(['mod','freq','freq2','rssi','snr','noise','protocol']);
const ISM_SENSOR=/_C$|_F$|humidity|rain|wind|pressure|power|energy|moisture|depth|lux|uv|temperature|co2|pm2|noise|distance|volume|flow|weight/i;
// запись страницы из события rtl_433: поля rtl_433 остаются как есть, id (числовой) уходит в dev, id — ключ устройства
function ismRecFromEvent(e,stamp){
  const fields={};
  for(const k in e) if(!ISM_META.has(k)) fields[k]=e[k];
  const ch=fields.channel!=null ? '/'+fields.channel : '';
  const key=fields.model+':'+(fields.id!=null ? fields.id : '')+ch;
  const rec={t:Date.now(), src:'ISM', mod:e.mod==='FSK' ? 'FSK' : 'OOK', proto:fields.model, kind:Object.keys(fields).some(k=>ISM_SENSOR.test(k)) ? 'sensor' : 'device'};
  for(const k in fields) if(k!=='model') rec[k==='id' ? 'dev' : k]=fields[k];
  rec.id=key;
  const parts=[];
  for(const k in fields){
    if(k==='model') continue;
    let v=fields[k]; if(typeof v==='number' && !Number.isInteger(v)) v=+v.toFixed(3);
    if(typeof v==='string' && v.length>24) v=v.slice(0,24)+'…';
    parts.push(k+' '+v);
  }
  rec.text=fields.model+' '+parts.join(' · ');
  rec.freq=Math.round(e.freq*1e6);
  rec.rssi=e.rssi; rec.snr=e.snr; rec.noise=e.noise;
  if(e.protocol!=null) rec.rtl=e.protocol;
  rec.stamp=stamp;
  return rec;
}
// неопознанный пакет импульсов {mod, sr, p:[импульс, пауза, …]} → запись через общий анализатор или null
function ismRecFromPulses(u,minBits){
  const k=1e6/u.sr, E=[];
  for(let i=0;i<u.p.length;i++) E.push(u.p[i]*k);
  const G=E.pop();                                      // последняя пауза — тишина после пакета
  const an=ismAnalyze(E,G);
  let d=an ? ismDecode(an) : null;
  if(!d){
    const mn=Math.min(...E), mx=Math.max(...E);
    d={proto:'unknown', kind:'unknown', id:'?:'+E.length, hex:'', bitlen:0, text:E.length+' pulses '+Math.round(mn)+'…'+Math.round(mx)+' µs, no structure'};
  } else if(d.kind==='unknown' && d.bitlen<minBits) return null;
  const rec={t:Date.now(), src:'ISM', mod:u.mod, ...d};
  rec.freq=Math.round(u.freq); rec.rssi=u.rssi; rec.snr=u.snr; rec.noise=u.noise;
  if(an){ rec.pulses=an.pulses; rec.enc=an.mod; if(an.short) rec.short=Math.round(an.short); if(an.long) rec.long=Math.round(an.long); if(an.gap) rec.gap=Math.round(an.gap); }
  return rec;
}

IQK.ismScan={
  init(n){
    n.key=''; n.rt=null; n.recent=[]; n.q=[]; n.seen=new Map(); n.ts=0;
    n.st={pk:0, dec:0, unk:0, dups:0, drop:0, busy:0, ticks:0};
    n.devKey=''; n.sp=null;
    ismRtLoad();
  },
  // полифазный банк: N каналов с шагом sr/N, вывод каждого — sr/D, D=N/2 (перекрытие 2: ровная полоса до края канала)
  setup(n,s){
    const sr=s.sr, P=n.p;
    // плана два: перекрытие 4 — каналы шагом ≤ 80 кГц с полосой ±100 кГц (сигнал целиком в одном канале), выход 4·sr/N;
    // перекрытие 2 — шаг ≤ 150 кГц, вдвое дешевле, но сигнал между каналами делится пополам
    const ov=P.plan==='2' ? 2 : 4;
    let N=0;
    if(sr<=500e3) N=1;
    else if(P.N && P.N!=='auto') N=+P.N;
    else { N=4; while(N<128 && sr/N>(ov===4 ? 80e3 : 150e3)) N*=2; }
    n.N=N; n.ov=ov; n.D=N===1 ? 1 : N/ov; n.sr=sr; n.srOut=Math.round(sr/n.D);
    if(N>1){
      n.h=iqChanProto(N,16,ov); n.H=N*16-1; n.hrev=Float32Array.from(n.h).reverse();
      n.hr=new Float32Array(n.H); n.hi=new Float32Array(n.H);
      n.ph=n.D-1; n.nAbs=0; n.ur=new Float32Array(N); n.ui_=new Float32Array(N);
      n.twc=new Float32Array(N); n.tws=new Float32Array(N);
      for(let m=0;m<N;m++){ n.twc[m]=Math.cos(-2*Math.PI*m/N); n.tws[m]=Math.sin(-2*Math.PI*m/N); }
    }
    n.pw=new Float64Array(N); n.chn=new Float64Array(N); n.hold=new Float64Array(N); n.pkc=new Float64Array(N); n.fed=0; n.pk=0; n.frames=0; n.t=0; n.last=0; n.gain=1; n.gT=0; n.agcN=0;
    n.dcR=0; n.dcI=0;
    n.buf=[]; n.ch=[];
    n.rt=new Rt433(ISM_RT.mod);
    n.devKey='';
    for(let c=0;c<N;c++){
      const off=N===1 ? 0 : iqChanOff(c,N,sr);
      { const h=n.rt.chan(n.srOut,(s.fc||0)+off,true); n.rt.hint(h,true); n.ch.push(h); }
    }
  },
  applyParams(n){
    const P=n.p, key=[P.devs,P.only,P.minp,P.raw].join('|');
    if(key===n.devKey) return;
    n.devKey=key;
    const only=String(P.only||'').split(/[,;\s]+/).filter(Boolean).map(x=>x.toLowerCase());
    for(const d of n.rt.devices()){
      let on=P.devs==='all' ? d.disabled<2 : !d.disabled;
      if(only.length) on=only.some(x=>/^\d+$/.test(x) ? +x===d.proto : d.name.toLowerCase().includes(x));
      n.rt.setDevice(d.i,on);
    }
    for(const ch of n.ch) n.rt.levels(ch,-30,9);
    n.lvl=null;
    n.rt.minPulses(+P.minp||8);
    n.rt.unknown(P.raw!==false);
  },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s || !s.sr){ n.ui=null; return {rec:null,spec:null,active:0}; }
    if(!ISM_RT.mod){ n.ui={loading:true, err:ISM_RT.err}; return {rec:null,spec:null,active:0}; }
    const key=s.sr+'|'+n.p.N+'|'+n.p.plan;
    if(key!==n.key){ n.key=key; this.setup(n,s); }
    this.applyParams(n);
    const t0=ismNow();
    const N=n.N, D=n.D, sr=s.sr, fc=s.fc||0, P=n.p;
    if(n.lastFc!==fc){ n.lastFc=fc; for(let c=0;c<N;c++) n.rt.setFreq(n.ch[c],fc+(N===1 ? 0 : iqChanOff(c,N,sr))); }
    const dcMode=P.dc, skip0=dcMode==='skip' && N>1;
    const sm=N>1 && N%4===0 ? iqSimd() : null;
    const dcA=1/(n.srOut*.05), ev=[];
    for(const c of s.chunks){
      const xr=c.re, xi=iqChunkIm(c), Kc=xr.length;
      if(N===1){                                       // узкий вход: один канал как есть
        const iq=new Int16Array(2*Kc), g=n.gain*32767;
        for(let i=0;i<Kc;i++){
          let a=xr[i]*g, b=xi[i]*g;
          const m=Math.max(Math.abs(a),Math.abs(b)); if(m>32767){ const q=32767/m; a*=q; b*=q; }   // ограничение с сохранением фазы (иначе ложный ЧМ-сигнал)
          iq[2*i]=a; iq[2*i+1]=b;
          n.pw[0]+=xr[i]*xr[i]+xi[i]*xi[i];
        }
        n.frames+=Kc;
        n.rt.feed16(n.ch[0],iq,Kc);
        continue;
      }
      const cnt=n.ph<Kc ? Math.floor((Kc-1-n.ph)/D)+1 : 0;
      const H=n.H, h=n.h, NP=N*16;
      let br, bi, ur=n.ur, ui=n.ui_, f32=null, oX=0, oY=0, oU=0, oV=0;
      if(sm){
        oX=NP; oY=oX+H+Kc; oU=oY+H+Kc; oV=oU+N;
        f32=simdAlloc(sm,oV+N);
        f32.set(n.hrev,0); f32.set(n.hr,oX); f32.set(xr,oX+H); f32.set(n.hi,oY); f32.set(xi,oY+H);
        ur=f32.subarray(oU,oU+N); ui=f32.subarray(oV,oV+N);
      } else {
        br=new Float32Array(H+Kc); br.set(n.hr); br.set(xr,H);
        bi=new Float32Array(H+Kc); bi.set(n.hi); bi.set(xi,H);
      }
      while(n.buf.length<N) n.buf.push(null);
      for(let k=0;k<N;k++) if(!n.buf[k] || n.buf[k].length<2*cnt) n.buf[k]=new Int16Array(2*Math.max(cnt,256));
      const g=n.gain*32767, pw=n.pw, pkc=n.pkc, twc=n.twc, tws=n.tws, bufs=n.buf, sub=dcMode==='subtract';
      let pk=n.pk, dcR=n.dcR, dcI=n.dcI;
      let j=n.ph;
      for(let f=0;f<cnt;f++,j+=D){
        if(sm) sm.poly(0,(oX+j)*4,(oY+j)*4,oU*4,oV*4,N,16);
        else iqChanPoly(h,br,bi,ur,ui,H+j,N,16);
        fft(ui,ur);
        const r=(n.nAbs+j)%N;
        let m=0, f2=2*f;
        for(let k=0;k<N;k++){
          const wr=twc[m], wi=tws[m];
          let zr=ur[k]*wr-ui[k]*wi, zi=ur[k]*wi+ui[k]*wr;
          m+=r; if(m>=N) m-=N;
          const p2=zr*zr+zi*zi; pw[k]+=p2; if(p2>pk) pk=p2; if(p2>pkc[k]) pkc[k]=p2;
          if(k===0 && sub){ dcR+=dcA*(zr-dcR); dcI+=dcA*(zi-dcI); zr-=dcR; zi-=dcI; }
          let a=zr*g, b=zi*g;
          if(a>32767 || a<-32767 || b>32767 || b<-32767){ const mx=Math.max(Math.abs(a),Math.abs(b)), q=32767/mx; a*=q; b*=q; }
          const o=bufs[k]; o[f2]=a; o[f2+1]=b;
        }
        n.frames++;
      }
      n.pk=pk; n.dcR=dcR; n.dcI=dcI;
      n.ph=j-Kc; n.nAbs+=Kc;
      if(sm){ n.hr.set(f32.subarray(oX+Kc,oX+Kc+H)); n.hi.set(f32.subarray(oY+Kc,oY+Kc+H)); }
      else { n.hr.set(br.subarray(Kc)); n.hi.set(bi.subarray(Kc)); }
      // тихие каналы в детектор не подаются: канал «спит», пока его пик в чанке не поднялся над шумом; после сигнала 30 мс подают всё
      if(cnt){
        const dt=Kc/sr;
        for(let k=skip0 ? 1 : 0;k<N;k++){
          const nz=n.chn[k];
          if(nz>0 && pkc[k]<nz*4 && n.hold[k]<=0){ pkc[k]=0; continue; }
          if(nz>0 && pkc[k]>=nz*4) n.hold[k]=.03; else n.hold[k]-=dt;
          pkc[k]=0;
          n.rt.feed16(n.ch[k],n.buf[k],cnt); n.fed++;
        }
      }
    }
    n.t+=s.chunks.reduce((a,c)=>a+c.re.length,0);
    // мощность каналов и автоусиление: шум (медиана по каналам) приводится к ~300 отсчётам int16
    // усиление движется к цели не быстрее ~1 дБ за чанк: скачок посреди пакета обрывает его
    if(n.gT && n.gT!==n.gain){ const st=Math.pow(10,1/20); n.gain=n.gT>n.gain ? Math.min(n.gT,n.gain*st) : Math.max(n.gT,n.gain/st); }
    if(n.frames && n.t-n.last>=sr*(n.agcN ? .1 : .02)){
      n.last=n.t;
      const pc=new Float64Array(N);
      for(let k=0;k<N;k++){ pc[k]=n.pw[k]/n.frames; n.pw[k]=0; }
      n.frames=0;
      const pk=n.pk; n.pk=0;
      for(let k=0;k<N;k++) n.chn[k]=n.chn[k]>0 ? Math.min(pc[k],n.chn[k]*1.3) : pc[k];   // нижняя огибающая мощности канала — его шум
      const sorted=Float64Array.from(pc).sort();
      let noise=sorted[N>>1]||sorted[N-1]||1e-30;
      if(N===1){ n.nzT=n.nzT && n.nzT<noise ? n.nzT*1.03 : noise; noise=n.nzT; }   // один канал: шум — нижняя огибающая мощности (сигнал не должен его поднимать)
      if(P.gain==='auto' && noise>1e-14){
        let want=Math.min(31.6,300/(32767*Math.sqrt(noise)));   // шум ≈ 300 отсчётов int16, но не более +30 дБ
        if(pk>0) want=Math.min(want,24000/(32767*Math.sqrt(pk)));   // но самый сильный сигнал не выше ~0,7 шкалы
        if(!n.agcN++) n.gain=want;                              // первая оценка — сразу
        n.gT=want;
      } else if(P.gain!=='auto') n.gain=Math.pow(10,(+P.gain||0)/20);
      const mag=new Float32Array(N), freqs=new Float64Array(N), half=N>>1;
      for(let i=0;i<N;i++){ const k=N===1 ? 0 : (i+half)%N; mag[i]=Math.sqrt(pc[k]); freqs[i]=fc+(N===1 ? 0 : iqChanOff(k,N,sr)); }
      n.sp={mag, sr, size:N, freqs, rev:(n.rev=(n.rev|0)+1)};
      n.noiseDb=10*Math.log10(noise+1e-30);
      // нижняя граница импульса для rtl_433 — на snr дБ выше шума: оценка модуля rtl_433 (mag_est) ≈ 0,446 · rms отсчётов int16
      const mn=.446*Math.sqrt(noise)*n.gain*32767*Math.pow(10,(+P.snr||14)/20);
      const lv=20*Math.log10(Math.max(mn,1))-84.2884;
      if(n.lvl==null || Math.abs(lv-n.lvl)>1){ n.lvl=lv; for(const ch of n.ch) n.rt.levels(ch,lv,9); }
    }
    for(const e of n.rt.take()) n.q.push({e});
    for(const u of n.rt.takeUnknown()) n.q.push({u});
    // очередь: за такт разбирается не больше бюджета времени; при переполнении сначала теряются неопознанные
    const recs=this.drain(n,ismNow());
    n.st.ticks++;
    const t1=ismNow();
    n.st.busy+=t1-t0;
    const act=n.sp ? Array.from(n.sp.mag).filter(v=>v*v>Math.pow(10,(n.noiseDb||-90)/10)*10).length : 0;
    n.ui={N, chW:sr/N, srOut:n.srOut, gain:20*Math.log10(n.gain), nz:n.noiseDb, dev:n.rt.nDev, q:n.q.length, st:{...n.st}, age:n.lastPkt ? Date.now()-n.lastPkt : null, recent:n.recent.slice(-10), act, load:n.st.ticks ? n.st.busy/n.st.ticks : 0};
    return {rec:recs.length ? recs : null, spec:n.sp, active:act};
  },
  drain(n,t0){
    const P=n.p, recs=[], budget=6, minBits=+P.minBits||16, dedupS=(+P.dedup||0)/1000;
    if(n.q.length>300){                                 // перегрузка: теряются самые старые неопознанные, расшифрованное — нет
      const before=n.q.length, ev=n.q.filter(x=>x.e), unk=n.q.filter(x=>x.u);
      n.q=ev.concat(unk.slice(Math.max(0,unk.length-Math.max(0,300-ev.length))));
      n.st.drop+=before-n.q.length;
    }
    const now=n.t/(n.sr||1);
    while(n.q.length){
      if(ismNow()-t0>budget && n.q.length>20) break;
      const it=n.q.shift();
      let rec=null;
      if(it.e){
        const k=JSON.stringify(it.e,(kk,v)=>ISM_META.has(kk) ? undefined : v);
        const last=n.seen.get(k);
        n.st.pk++;
        if(last!==undefined && now-last<dedupS){ n.seen.set(k,now); n.st.dups++; continue; }
        n.seen.set(k,now);
        rec=ismRecFromEvent(it.e); n.st.dec++;
      } else {
        n.st.pk++;
        rec=ismRecFromPulses(it.u,minBits);
        if(!rec) continue;
        const k='u|'+(rec.hex||rec.id), last=n.seen.get(k);
        if(last!==undefined && now-last<dedupS){ n.seen.set(k,now); n.st.dups++; continue; }
        n.seen.set(k,now);
        n.st.unk++;
      }
      if(n.seen.size>400) for(const [kk,v] of n.seen) if(now-v>60) n.seen.delete(kk);
      n.lastPkt=Date.now();
      n.recent.push(((rec.freq||0)/1e6).toFixed(3)+' '+rec.mod+' '+rec.text); if(n.recent.length>30) n.recent.shift();
      recs.push(rec);
    }
    return recs;
  }};
