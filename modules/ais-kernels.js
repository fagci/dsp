"use strict";
/* ============================ AIS (морской, 161.975 / 162.025 МГц) ============================
   Ядро IQK (страница и воркер), без DOM. ЧМ → звук; GMSK 9600 Бод (BT 0.4, девиация ±2.4 кГц).
   Поток: NRZI (0 — смена уровня), HDLC: флаг 0x7E, вставка нуля после пяти единиц, FCS CRC-16 X.25
   (полином 0x8408 зеркально, начальное 0xFFFF, остаток 0xF0B8). Байты идут младшим битом вперёд,
   поля сообщения — старшим вперёд, поэтому внутри каждого байта порядок битов разворачивается.
   Тактовая фаза не отслеживается: 8 сдвигов решётки по ⅛ бита, кадр принимается по CRC.
   Порог — скользящее среднее звука по 40 символам вокруг решения (уход частоты передатчика). */

const AIS_BAUD=9600, AIS_PH=8, AIS_W=40, AIS_MAXBITS=1300, AIS_CLIP=9000;
const AIS_STATUS=['under way (engine)','at anchor','not under command','restricted manoeuvrability','constrained by draught',
  'moored','aground','fishing','under way (sailing)','','','','','','AIS-SART','undefined'];

// CRC-16 X.25 по битам во времени передачи: остаток 0xF0B8 у кадра вместе с FCS
function aisCrcBits(b,len){
  let r=0xFFFF;
  for(let i=0;i<len;i++){ const fb=(r^b[i])&1; r>>=1; if(fb) r^=0x8408; }
  return r;
}
// биты во времени ↔ биты поля (старший вперёд): внутри байта порядок обратный
const aisFlip=i=>(i&~7)+7-(i&7);
function aisLogical(t,len){
  const o=new Uint8Array(len);
  for(let i=0;i<len;i++){ const j=aisFlip(i); if(j<len) o[j]=t[i]; }
  return o;
}
function aisU(b,p,n){ let v=0; for(let i=0;i<n;i++) v=v*2+(p+i<b.length ? b[p+i] : 0); return v; }
function aisS(b,p,n){ const v=aisU(b,p,n); return v>=Math.pow(2,n-1) ? v-Math.pow(2,n) : v; }
function aisTxt(b,p,n){                              // 6-битный ASCII; «@» — конец
  let s='';
  for(let i=0;i+6<=n;i+=6){ const v=aisU(b,p+i,6); s+=String.fromCharCode(v<32 ? v+64 : v); }
  return s.replace(/@.*$/,'').replace(/\s+$/,'');
}
function aisLat(v){ v/=600000; return v>=-90 && v<=90 ? +v.toFixed(6) : null; }
function aisLon(v){ v/=600000; return v>=-180 && v<=180 ? +v.toFixed(6) : null; }
function aisShipType(c){
  if(!c) return '';
  const d=c%10, g=Math.floor(c/10);
  if(g===3) return ['fishing','towing','towing (large)','dredging','diving','military','sailing','pleasure craft'][d]||'';
  if(g===5) return ['pilot','search and rescue','tug','port tender','anti-pollution','law enforcement','','','medical','non-combatant'][d]||'';
  return ({2:'WIG',4:'high-speed craft',6:'passenger',7:'cargo',8:'tanker',9:'other'})[g]||'';
}
function aisColor(c){
  const g=Math.floor((c||0)/10);
  return ({3:'#f0a030',4:'#e0e050',5:'#ff6060',6:'#4aa0ff',7:'#4cd080',8:'#e05a5a',9:'#a0a0a0'})[g]||null;
}

// сообщение (биты полей, длина без FCS) → поля; null — тип не разбирается
function aisParse(b){
  const type=aisU(b,0,6);
  if(type<1 || type>27 || b.length<38) return null;
  const m={type, repeat:aisU(b,6,2), mmsi:aisU(b,8,30)};
  const spd=(v,k)=>v===1023 ? null : +(v/k).toFixed(1);
  if(type<=3){
    if(b.length<137) return null;
    m.status=aisU(b,38,4); m.sog=spd(aisU(b,50,10),10);
    m.lon=aisLon(aisS(b,61,28)); m.lat=aisLat(aisS(b,89,27));
    const c=aisU(b,116,12); m.cog=c>=3600 ? null : c/10;
    const h=aisU(b,128,9); m.hdg=h>359 ? null : h;
  } else if(type===4 || type===11){
    if(b.length<134) return null;
    m.year=aisU(b,38,14); m.month=aisU(b,52,4); m.day=aisU(b,56,5); m.hour=aisU(b,61,5); m.min=aisU(b,66,6); m.sec=aisU(b,72,6);
    m.lon=aisLon(aisS(b,79,28)); m.lat=aisLat(aisS(b,107,27));
    m.base=true;
  } else if(type===5){
    if(b.length<422) return null;
    m.imo=aisU(b,40,30); m.callsign=aisTxt(b,70,42); m.name=aisTxt(b,112,120); m.shiptype=aisU(b,232,8);
    m.bow=aisU(b,240,9); m.stern=aisU(b,249,9); m.port=aisU(b,258,6); m.stbd=aisU(b,264,6);
    m.eta=[aisU(b,274,4),aisU(b,278,5),aisU(b,283,5),aisU(b,288,6)]; m.draught=aisU(b,294,8)/10; m.dest=aisTxt(b,302,120);
  } else if(type===9){
    if(b.length<133) return null;
    m.alt=aisU(b,38,12)===4095 ? null : aisU(b,38,12); m.sog=aisU(b,50,10)===1023 ? null : aisU(b,50,10);
    m.lon=aisLon(aisS(b,61,28)); m.lat=aisLat(aisS(b,89,27));
    const c=aisU(b,116,12); m.cog=c>=3600 ? null : c/10;
    m.sar=true;
  } else if(type===18 || type===19){
    if(b.length<139) return null;
    m.sog=spd(aisU(b,46,10),10);
    m.lon=aisLon(aisS(b,57,28)); m.lat=aisLat(aisS(b,85,27));
    const c=aisU(b,112,12); m.cog=c>=3600 ? null : c/10;
    const h=aisU(b,124,9); m.hdg=h>359 ? null : h;
    m.classB=true;
    if(type===19){
      if(b.length<301) return null;
      m.name=aisTxt(b,143,120); m.shiptype=aisU(b,263,8);
      m.bow=aisU(b,271,9); m.stern=aisU(b,280,9); m.port=aisU(b,289,6); m.stbd=aisU(b,295,6);
    }
  } else if(type===21){
    if(b.length<272) return null;
    m.aton=aisU(b,38,5); m.name=aisTxt(b,43,120);
    m.lon=aisLon(aisS(b,164,28)); m.lat=aisLat(aisS(b,192,27));
    m.bow=aisU(b,219,9); m.stern=aisU(b,228,9); m.port=aisU(b,237,6); m.stbd=aisU(b,243,6);
    m.offPos=aisU(b,259,1); m.virtual=aisU(b,269,1);
    if(b.length>272) m.name+=aisTxt(b,272,Math.floor((b.length-272)/6)*6);
  } else if(type===24){
    if(b.length<162) return null;
    m.part=aisU(b,38,2);
    if(m.part===0) m.name=aisTxt(b,40,120);
    else { m.shiptype=aisU(b,40,8); m.callsign=aisTxt(b,90,42);
      m.bow=aisU(b,132,9); m.stern=aisU(b,141,9); m.port=aisU(b,150,6); m.stbd=aisU(b,156,6); }
  } else return {type, repeat:m.repeat, mmsi:m.mmsi};   // остальные типы: только адрес
  return m;
}

// биты сообщения → предложение NMEA (!AIVDM); длинные — несколькими, по 60 символов
function aisNmea(lb,len,ch,seq){
  const nc=Math.ceil(len/6), fill=nc*6-len;
  let pl='';
  for(let i=0;i<nc;i++){ const v=aisU(lb,i*6,6); pl+=String.fromCharCode(v<40 ? v+48 : v+56); }
  const parts=[]; for(let p=0;p<pl.length;p+=60) parts.push(pl.slice(p,p+60));
  const out=[];
  parts.forEach((s,k)=>{
    const body='AIVDM,'+parts.length+','+(k+1)+','+(parts.length>1 ? seq : '')+','+ch+','+s+','+(k===parts.length-1 ? fill : 0);
    let c=0; for(let i=0;i<body.length;i++) c^=body.charCodeAt(i);
    out.push('!'+body+'*'+c.toString(16).toUpperCase().padStart(2,'0'));
  });
  return out;
}

IQK.aisRx={
  init(n){ n.key=''; n.frames=0; n.msgs=0; n.ships=new Map(); n.recent=[]; n.lastMsg=0; n.seq=0; n.ends=[]; },
  setup(n,s,cplx){
    const M=cplx ? Math.max(1,Math.floor(s.sr/48000)) : 1;
    n.M=M; n.fs=s.sr/M; n.sps=n.fs/AIS_BAUD;
    n.dec=M>1 ? {p:{M:String(M), cut:Math.min(.45,16000/n.fs), tpp:'16'}} : null;
    if(n.dec) IQK.iqDecim.init(n.dec);
    const stop=Math.min(15000,.47*n.fs);
    n.lp=cplx ? kaiserLP(n.fs,Math.min(9500,.6*stop),stop,255) : null;
    if(n.lp){ n.lr=new Float32Array(n.lp.length-1); n.li=new Float32Array(n.lp.length-1); }
    n.pr=0; n.pi=0;
    n.x=new Float32Array(0); n.xb=0; n.tNext=0; n.jj=0;
    n.ph=[]; for(let i=0;i<AIS_PH;i++) n.ph.push({prev:0, ones:0, inF:false, len:0, buf:new Uint8Array(AIS_MAXBITS)});
    n.ends=[];
  },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s){ n.ui=null; return {rec:null, text:null}; }
    const cplx=s.chunks.length ? !!s.chunks[0].im : n.cplx;
    const key=s.sr+'|'+cplx;
    if(key!==n.key){ n.key=key; n.cplx=cplx; this.setup(n,s,cplx); }
    const src=n.dec ? IQK.iqDecim.process(n.dec,{in:s}).out : s;
    const parts=[];
    for(const c of src.chunks){
      let y;
      if(!n.cplx) y=Float32Array.from(c.re);
      else {
        const xr=firRun(n.lp,n.lr,c.re), xi=firRun(n.lp,n.li,iqChunkIm(c)), K=xr.length, k=n.fs/(2*Math.PI);
        y=new Float32Array(K);
        let pr=n.pr, pi=n.pi;
        for(let i=0;i<K;i++){
          const p=xr[i], q=xi[i], v=Math.atan2(q*pr-p*pi, p*pr+q*pi)*k;
          y[i]=v>AIS_CLIP ? AIS_CLIP : v<-AIS_CLIP ? -AIS_CLIP : v; pr=p; pi=q;
        }
        n.pr=pr; n.pi=pi;
      }
      parts.push(y);
    }
    let add=0; for(const p of parts) add+=p.length;
    const nx=new Float32Array(n.x.length+add); nx.set(n.x); let o=n.x.length;
    for(const p of parts){ nx.set(p,o); o+=p.length; }
    n.x=nx;
    const out={recs:[], text:[]};
    this.scan(n,out);
    const now=Date.now(), ttl=(+n.p.ttl||30)*60000;
    for(const [k,v] of n.ships) if(now-v.seen>ttl) n.ships.delete(k);
    n.ui={fs:n.fs, M:n.M, frames:n.frames, msgs:n.msgs, ships:n.ships.size,
      age:n.lastMsg ? now-n.lastMsg : null, recent:n.recent.slice(-8)};
    return {rec:out.recs.length ? out.recs : null, text:out.text.length ? out.text.join('\n') : null};
  },
  scan(n,out){
    const x=n.x, N=x.length, sps=n.sps, P=AIS_PH;
    const S=new Float64Array(N+1);
    for(let i=0;i<N;i++) S[i+1]=S[i]+x[i];
    const integ=t=>{ if(t<=0) return 0; if(t>=N) return S[N]; const a=Math.floor(t); return S[a]+(t-a)*x[a]; };
    const avg=(a,b)=>{ a=Math.max(0,a); b=Math.min(N,b); return b>a ? (integ(b)-integ(a))/(b-a) : 0; };
    const half=AIS_W*sps/2, hw=sps/4, step=sps/P;
    let tj=n.tNext-n.xb;
    if(tj<0) tj=0;
    while(tj+half+hw<N-1){
      const lvl=avg(tj-hw,tj+hw)>avg(tj-half,tj+half) ? 1 : 0;
      this.feed(n,n.ph[n.jj%P],lvl,n.xb+tj+hw,out);
      n.jj++; tj+=step;
    }
    n.tNext=n.xb+tj;
    const keep=Math.floor(tj-half-2*sps);
    if(keep>0){ n.x=x.slice(keep); n.xb+=keep; }
  },
  // один символ одной фазы: NRZI → HDLC
  feed(n,st,lvl,te,out){
    const b=lvl===st.prev ? 1 : 0;
    st.prev=lvl;
    if(b){
      st.ones++;
      if(st.ones>=7){ st.inF=false; st.len=0; }
      else if(st.inF){ if(st.len<AIS_MAXBITS) st.buf[st.len++]=1; else { st.inF=false; st.len=0; } }
    } else {
      if(st.ones===6){
        if(st.inF && st.len-7>=56) this.frame(n,st.buf,st.len-7,te,out);   // без флага: 0 и шесть единиц
        st.inF=true; st.len=0;
      } else if(st.ones!==5 && st.inF){
        if(st.len<AIS_MAXBITS) st.buf[st.len++]=0; else { st.inF=false; st.len=0; }
      }
      st.ones=0;
    }
  },
  frame(n,buf,len,te,out){
    if(aisCrcBits(buf,len)!==0xF0B8) return;
    const L=len-16, t=buf.subarray(0,L);
    let hex=''; for(let i=0;i<L;i+=4) hex+=aisU(t,i,4).toString(16);
    const ends=n.ends, sps=n.sps;
    while(ends.length && te-ends[0].t>2000*sps) ends.shift();
    for(const e of ends) if(e.hex===hex && Math.abs(te-e.t)<4*sps) return;   // тот же кадр с соседней фазы
    ends.push({t:te, hex});
    n.frames++;
    let lb=aisLogical(t,L), m=aisParse(lb);
    if(!m){ const alt=aisParse(t); if(alt){ lb=t; m=alt; } }   // разворот байтов не угадан — поля в порядке приёма
    if(!m) return;
    this.message(n,m,lb,L,out);
  },
  message(n,m,lb,L,out){
    const now=Date.now();
    n.msgs++; n.lastMsg=now;
    out.text.push(...aisNmea(lb,L,n.p.ch||'A',(n.seq=n.seq%9+1)));
    let sh=n.ships.get(m.mmsi);
    if(!sh){ sh={mmsi:m.mmsi, msgs:0, first:now}; n.ships.set(m.mmsi,sh); }
    sh.msgs++; sh.seen=now;
    for(const f of ['name','callsign','shiptype','imo','dest','draught','bow','stern','port','stbd','status','sog','cog','hdg','alt','aton','offPos','virtual'])
      if(m[f]!=null && m[f]!=='') sh[f]=m[f];
    if(m.base) sh.base=true;
    if(m.classB) sh.classB=true;
    if(m.sar) sh.sar=true;
    if(m.type===5 && m.eta) sh.eta=m.eta;
    let pos=false;
    if(m.lat!=null && m.lon!=null){ sh.lat=m.lat; sh.lon=m.lon; sh.posT=now; pos=true; }
    const nm=sh.name||String(m.mmsi);
    n.recent.push(m.mmsi+' · '+('t'+m.type)+' '+nm+(pos ? ' · '+m.lat.toFixed(4)+' '+m.lon.toFixed(4) : '')+(m.sog!=null ? ' · '+m.sog+' kn' : ''));
    if(n.recent.length>20) n.recent.shift();
    if(!pos) return;
    const r={t:now, src:'AIS', id:String(sh.mmsi), mmsi:sh.mmsi, label:nm, lat:sh.lat, lon:sh.lon, msg:m.type};
    r.icon=sh.base ? 'antenna' : sh.aton!=null ? 'diamond' : sh.sar ? 'plane' : 'ship';
    const hd=sh.hdg!=null ? sh.hdg : sh.cog;
    if(hd!=null && sh.sog>0.5) r.heading=hd; else if(sh.hdg!=null) r.heading=sh.hdg;
    if(sh.sog!=null) r.speed=sh.sog;
    if(sh.cog!=null) r.course=sh.cog;
    if(sh.status!=null){ r.status=AIS_STATUS[sh.status]||sh.status; }
    if(sh.callsign) r.callsign=sh.callsign;
    if(sh.imo) r.imo=sh.imo;
    if(sh.shiptype){ r.shiptype=sh.shiptype; const tn=aisShipType(sh.shiptype); if(tn) r.kind=tn; }
    if(sh.dest) r.dest=sh.dest;
    if(sh.bow!=null && (sh.bow+sh.stern)>0) r.length=sh.bow+sh.stern;
    if(sh.port!=null && (sh.port+sh.stbd)>0) r.width=sh.port+sh.stbd;
    if(sh.draught) r.draught=sh.draught;
    if(sh.alt!=null) r.alt=sh.alt;
    if(sh.aton!=null) r.aton=sh.aton;
    const col=aisColor(sh.shiptype); if(col) r.color=col; else if(sh.base) r.color='#ffd84a';
    out.recs.push(r);
  }};

/* ---- генератор: движение четырёх судов, базовая станция и знак навигации ---- */
function aisPut(b,p,n,v){                           // поле в биты старшим вперёд; v — целое со знаком
  if(v<0) v+=Math.pow(2,n);
  for(let i=n-1;i>=0;i--){ b[p+i]=v%2; v=Math.floor(v/2); }
}
function aisPutTxt(b,p,n,s){
  for(let i=0;i<n/6;i++){
    const c=i<s.length ? s.charCodeAt(i) : 64;
    aisPut(b,p+i*6,6,c>=64 ? c-64 : c);
  }
}
function aisBuild(type,f){
  const lenOf={1:168,4:168,5:424,18:168,21:272,24:168}, b=new Uint8Array(lenOf[type]);
  aisPut(b,0,6,type); aisPut(b,8,30,f.mmsi);
  const pos=(p,x,y)=>{ aisPut(b,p,28,Math.round(x*600000)); aisPut(b,p+28,27,Math.round(y*600000)); };
  if(type===1){
    aisPut(b,38,4,f.status|0); aisPut(b,42,8,-128); aisPut(b,50,10,Math.round(f.sog*10)); aisPut(b,60,1,1);
    pos(61,f.lon,f.lat); aisPut(b,116,12,Math.round(f.cog*10)); aisPut(b,128,9,Math.round(f.hdg)); aisPut(b,137,6,f.sec|0);
  } else if(type===4){
    aisPut(b,38,14,2025); aisPut(b,52,4,6); aisPut(b,56,5,15); aisPut(b,61,5,12); aisPut(b,66,6,30); aisPut(b,72,6,0);
    aisPut(b,78,1,1); pos(79,f.lon,f.lat); aisPut(b,134,4,1);
  } else if(type===5){
    aisPut(b,38,2,0); aisPut(b,40,30,f.imo); aisPutTxt(b,70,42,f.callsign); aisPutTxt(b,112,120,f.name); aisPut(b,232,8,f.shiptype);
    aisPut(b,240,9,f.bow); aisPut(b,249,9,f.stern); aisPut(b,258,6,f.port); aisPut(b,264,6,f.stbd); aisPut(b,270,4,1);
    aisPut(b,274,4,6); aisPut(b,278,5,20); aisPut(b,283,5,8); aisPut(b,288,6,0); aisPut(b,294,8,Math.round(f.draught*10));
    aisPutTxt(b,302,120,f.dest);
  } else if(type===18){
    aisPut(b,46,10,Math.round(f.sog*10)); aisPut(b,56,1,1); pos(57,f.lon,f.lat); aisPut(b,112,12,Math.round(f.cog*10));
    aisPut(b,124,9,Math.round(f.hdg)); aisPut(b,133,6,f.sec|0);
  } else if(type===21){
    aisPut(b,38,5,f.aton); aisPutTxt(b,43,120,f.name); aisPut(b,163,1,1); pos(164,f.lon,f.lat);
    aisPut(b,219,9,2); aisPut(b,228,9,2); aisPut(b,237,6,2); aisPut(b,243,6,2); aisPut(b,249,4,1); aisPut(b,253,6,f.sec|0);
  } else if(type===24){
    aisPut(b,38,2,f.part);
    if(f.part===0) aisPutTxt(b,40,120,f.name);
    else { aisPut(b,40,8,f.shiptype); aisPutTxt(b,90,42,f.callsign); aisPut(b,132,9,f.bow); aisPut(b,141,9,f.stern); aisPut(b,150,6,f.port); aisPut(b,156,6,f.stbd); }
  }
  return b;
}
// биты сообщения → биты в эфире: порядок в байте, FCS, вставка нулей, NRZI-уровни ±1 с преамбулой и флагами
function aisAirBits(lb){
  const L=lb.length, t=new Uint8Array(L+16);
  for(let i=0;i<L;i++) t[i]=lb[aisFlip(i)];
  const fcs=aisCrcBits(t,L)^0xFFFF;
  for(let k=0;k<16;k++) t[L+k]=(fcs>>k)&1;
  const bits=[];
  for(let i=0;i<24;i++) bits.push(i&1);              // преамбула 0101…
  const flag=[0,1,1,1,1,1,1,0];
  bits.push(...flag);
  let ones=0;
  for(let i=0;i<t.length;i++){ bits.push(t[i]); if(t[i]){ if(++ones===5){ bits.push(0); ones=0; } } else ones=0; }
  bits.push(...flag);
  for(let i=0;i<8;i++) bits.push(0);
  return bits;
}
// биты → частота (Гц) по отсчётам: NRZI, гауссов фильтр BT 0.4, девиация ±2400 Гц
function aisFreq(bits,sr){
  const spb=sr/AIS_BAUD, pad=3, total=Math.ceil((bits.length+2*pad)*spb), nrz=new Float32Array(total);
  let lvl=1;
  for(let i=0;i<bits.length;i++){
    if(!bits[i]) lvl=-lvl;
    const a=Math.round((i+pad)*spb), b=Math.round((i+pad+1)*spb);
    for(let k=a;k<b && k<total;k++) nrz[k]=lvl;
  }
  for(let k=Math.round(pad*spb)-1;k>=0;k--) nrz[k]=nrz[Math.round(pad*spb)];
  for(let k=Math.round((bits.length+pad)*spb);k<total;k++) nrz[k]=nrz[Math.round((bits.length+pad)*spb)-1];
  const sg=Math.sqrt(Math.log(2))/(2*Math.PI*0.4)*spb, H=Math.ceil(4*sg), g=new Float32Array(2*H+1);
  let sum=0;
  for(let k=-H;k<=H;k++){ g[k+H]=Math.exp(-k*k/(2*sg*sg)); sum+=g[k+H]; }
  const f=new Float32Array(total);
  for(let i=0;i<total;i++){
    let a=0;
    for(let k=-H;k<=H;k++){ const j=i+k; a+=g[k+H]*nrz[j<0 ? 0 : j>=total ? total-1 : j]; }
    f[i]=2400*a/sum;
  }
  return f;
}
const AIS_SIM=[
  {mmsi:271000101, name:'DEMO CARGO', callsign:'TC1001', imo:9000001, shiptype:70, bow:120, stern:30, port:12, stbd:12, draught:8.5, dest:'ISTANBUL',
    lat:41.060, lon:29.050, sog:11.5, cog:200, hdg:200},
  {mmsi:271000102, name:'DEMO TANKER', callsign:'TC1002', imo:9000002, shiptype:80, bow:160, stern:40, port:15, stbd:15, draught:11.2, dest:'AMBARLI',
    lat:41.010, lon:29.020, sog:8.2, cog:20, hdg:22},
  {mmsi:271000103, name:'DEMO FERRY', callsign:'TC1003', imo:9000003, shiptype:60, bow:50, stern:15, port:8, stbd:8, draught:3.1, dest:'KADIKOY',
    lat:41.020, lon:28.990, sog:14.0, cog:100, hdg:100},
  {mmsi:271000104, name:'DEMO SAILOR', callsign:'TC1004', imo:0, shiptype:36, bow:8, stern:3, port:2, stbd:2, draught:1.8, dest:'',
    lat:41.000, lon:29.030, sog:5.0, cog:300, hdg:300, classB:true}];
function aisSimMessage(n){
  const g=n.ais, k=g.k++, v=AIS_SIM[k%AIS_SIM.length], st=g.ships[v.mmsi]||(g.ships[v.mmsi]={...v});
  if(k%7===5) return aisBuild(4,{mmsi:2710001, lat:41.0925, lon:29.0615});
  if(k%7===6) return aisBuild(21,{mmsi:992711001, name:'DEMO BUOY', aton:1, lat:41.035, lon:29.005, sec:k%60});
  // судно уходит по курсу: 1 с эфира ≈ 60 с движения, чтобы след было видно на карте
  const dt=60, d=st.sog*0.514444*dt/1852/60;
  st.lat+=d*Math.cos(st.cog*Math.PI/180); st.lon+=d*Math.sin(st.cog*Math.PI/180)/Math.cos(st.lat*Math.PI/180);
  st.cog=(st.cog+(k%3-1)*2+360)%360; st.hdg=st.cog;
  const f={...st, sec:(k*7)%60};
  if(k%4===1) return aisBuild(5,f);
  if(st.classB) return k%8===3 ? aisBuild(24,{...f,part:k%16===3 ? 0 : 1}) : aisBuild(18,f);
  return aisBuild(1,f);
}
function aisGenerate(n,sr,N){
  let g=n.ais;
  if(!g || g.sr!==sr) g=n.ais={sr, k:0, ships:{}, buf:null, pos:0, gap:Math.round(sr*.2)};
  const re=new Float32Array(N), im=new Float32Array(N);
  for(let i=0;i<N;i++){
    if(!g.buf){
      if(g.gap>0){ g.gap--; continue; }
      g.f=aisFreq(aisAirBits(aisSimMessage(n)),sr); g.buf=g.f; g.pos=0; g.ph=g.ph||0;
    }
    g.ph+=2*Math.PI*g.buf[g.pos]/sr;
    re[i]=Math.cos(g.ph); im[i]=Math.sin(g.ph);
    if(++g.pos>=g.buf.length){ g.buf=null; g.gap=Math.round(sr*(0.35+0.4*((g.k*0.618)%1))); g.ph%=2*Math.PI; }
  }
  return [re,im];
}
