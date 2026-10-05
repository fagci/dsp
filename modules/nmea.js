"use strict";
/* ============================ NMEA 0183 ============================
   NMEA Parser: строки GNSS-приёмников, эхолотов, ветромеров, компасов и AIS (!AIVDM) → записи и числа.
   Разбор — чистые функции nmea*; узел собирает эпоху (GGA + RMC + VTG приходят отдельными строками)
   в одну запись и отдаёт её, когда сменилось время или прошло 300 мс. AIS-часть — из ais-kernels.js. */

const NMEA_SYS={GP:'GPS', GL:'GLONASS', GA:'Galileo', GB:'BeiDou', BD:'BeiDou', GQ:'QZSS', GI:'NavIC', GN:'GNSS'};
const NMEA_FIX=['no fix','GPS','DGPS','PPS','RTK fixed','RTK float','estimated','manual','simulation'];

function nmeaCs(s){ let c=0; for(let i=0;i<s.length;i++) c^=s.charCodeAt(i); return c; }
function nmeaNum(s){ if(s==null || s==='') return null; const v=Number(s); return isFinite(v) ? v : null; }
function nmeaCoord(v,h,max){                           // ddmm.mmmm / dddmm.mmmm
  const x=nmeaNum(v); if(x==null || !h) return null;
  const d=Math.floor(x/100), r=d+(x-d*100)/60, s=(h==='S' || h==='W') ? -1 : 1;
  return r<=max ? +(s*r).toFixed(6) : null;
}
function nmeaTime(s){                                  // hhmmss.ss → секунды суток
  const m=/^(\d\d)(\d\d)(\d\d(?:\.\d+)?)$/.exec(s||''); if(!m) return null;
  return +m[1]*3600+ +m[2]*60+ +m[3];
}
const nmeaHms=t=>{ const h=Math.floor(t/3600), m=Math.floor(t%3600/60), s=Math.floor(t%60);
  return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0'); };
function nmeaDate(s){                                  // ddmmyy → гггг-мм-дд (год 80…99 — 19xx)
  const m=/^(\d\d)(\d\d)(\d\d)$/.exec(s||''); if(!m) return null;
  return (+m[3]<80 ? '20' : '19')+m[3]+'-'+m[2]+'-'+m[1];
}

// строка → {bang, talker, type, f, cs:'ok'|'bad'|'none'}; null — не NMEA
function nmeaSplit(line){
  const m=/([$!])([A-Z0-9]{2}[A-Z0-9]{3}|P[A-Z0-9]{2,}|[A-Z]{5})([^*\r\n$!]*)(?:\*([0-9A-Fa-f]{2}))?/.exec(line);
  if(!m) return null;
  const id=m[2], body=id+m[3];
  const r={bang:m[1]==='!', f:m[3].replace(/^,/,'').split(','), cs:'none'};
  if(id[0]==='P'){ r.talker='P'; r.type=id; r.f=m[3].replace(/^,/,'').split(','); }
  else { r.talker=id.slice(0,2); r.type=id.slice(2); }
  if(m[4]!==undefined) r.cs=nmeaCs(body)===parseInt(m[4],16) ? 'ok' : 'bad';
  return r;
}

// предложение → поля; null — тип не разбирается
function nmeaDecode(s){
  const f=s.f, o={type:s.type, talker:s.talker};
  const lat=(a,b)=>nmeaCoord(f[a],f[b],90), lon=(a,b)=>nmeaCoord(f[a],f[b],180);
  switch(s.type){
    case 'GGA':
      o.time=nmeaTime(f[0]); o.lat=lat(1,2); o.lon=lon(3,4); o.fixq=nmeaNum(f[5]); o.sats=nmeaNum(f[6]);
      o.hdop=nmeaNum(f[7]); o.alt=nmeaNum(f[8]); o.geoid=nmeaNum(f[10]); o.valid=o.fixq>0 && o.lat!=null && o.lon!=null; return o;
    case 'RMC':
      o.time=nmeaTime(f[0]); o.valid=f[1]==='A'; o.lat=lat(2,3); o.lon=lon(4,5); o.sog=nmeaNum(f[6]); o.cog=nmeaNum(f[7]);
      o.date=nmeaDate(f[8]); o.valid=o.valid && o.lat!=null && o.lon!=null;
      { const v=nmeaNum(f[9]); if(v!=null) o.magvar=f[10]==='W' ? -v : v; } return o;
    case 'GLL':
      o.lat=lat(0,1); o.lon=lon(2,3); o.time=nmeaTime(f[4]); o.valid=f[5]==='A' && o.lat!=null && o.lon!=null; return o;
    case 'VTG': o.cog=nmeaNum(f[0]); o.sog=nmeaNum(f[4]); o.kmh=nmeaNum(f[6]); return o;
    case 'GSA':
      o.mode=f[0]; o.fix3d=nmeaNum(f[1]); o.prn=f.slice(2,14).filter(x=>x!=='').map(Number);
      o.pdop=nmeaNum(f[14]); o.hdop=nmeaNum(f[15]); o.vdop=nmeaNum(f[16]); return o;
    case 'GSV': {
      o.total=+f[0]; o.num=+f[1]; o.inView=nmeaNum(f[2]); o.sat=[];
      const odd=(f.length-3)%4===1;                    // NMEA 4.10: в конце id сигнала
      const end=odd ? f.length-1 : f.length;
      for(let i=3;i+3<end;i+=4){
        if(f[i]==='') continue;
        o.sat.push({prn:+f[i], el:nmeaNum(f[i+1]), az:nmeaNum(f[i+2]), snr:nmeaNum(f[i+3])});
      }
      if(odd) o.sig=f[f.length-1]; return o; }
    case 'ZDA': o.time=nmeaTime(f[0]); if(f[1] && f[2] && f[3]) o.date=f[3]+'-'+f[2].padStart(2,'0')+'-'+f[1].padStart(2,'0'); return o;
    case 'HDT': o.hdg=nmeaNum(f[0]); return o;
    case 'HDM': o.hdm=nmeaNum(f[0]); return o;
    case 'HDG': o.hdm=nmeaNum(f[0]); return o;
    case 'DBT': o.depth=nmeaNum(f[2]); if(o.depth==null && nmeaNum(f[0])!=null) o.depth=+(f[0]*0.3048).toFixed(2); return o;
    case 'DPT': o.depth=nmeaNum(f[0]); return o;
    case 'MWV': o.wdir=nmeaNum(f[0]); o.wref=f[1]; o.wspd=nmeaNum(f[2]);
      { const k={K:1/3.6, M:1, N:0.514444}[f[3]]; if(o.wspd!=null && k) o.wspd=+(o.wspd*k).toFixed(2); else o.wspd=null; } return o;
    case 'MTW': o.temp=nmeaNum(f[0]); return o;
    case 'VDM': case 'VDO': return o;
    case 'TXT': o.text=f.slice(3).join(',').trim(); return o;
  }
  return null;
}
// !AIVDM: фрагмент → {count,num,seq,ch,payload,fill}
function nmeaAivdm(s){
  const f=s.f;
  return {count:+f[0], num:+f[1], seq:f[2], ch:f[3], payload:f[4]||'', fill:+f[5]||0};
}
function nmeaUnarmor(pl,fill){
  const bits=[];
  for(const ch of pl){ let v=ch.charCodeAt(0)-48; if(v>40) v-=8; if(v<0 || v>63) return null; for(let i=5;i>=0;i--) bits.push((v>>i)&1); }
  return Uint8Array.from(bits.slice(0,Math.max(0,bits.length-fill)));
}

def({ id:'nmea', lazy:'proc', title:'NMEA Parser', cat:'Data', kw:'nmea gps gnss gga rmc ais aivdm sonar depth wind compass serial',
  ins:[{n:'text',t:'txt'},{n:'go',t:'num'}],
  outs:[{n:'rec',t:'rec'},{n:'sat',t:'rec'},{n:'lat',t:'num'},{n:'lon',t:'num'},{n:'alt',t:'num'},{n:'sog',t:'num'},{n:'cog',t:'num'},
        {n:'hdg',t:'num'},{n:'sats',t:'num'},{n:'hdop',t:'num'},{n:'depth',t:'num'},{n:'wspd',t:'num'},{n:'wdir',t:'num'},{n:'temp',t:'num'},{n:'go',t:'num'}],
  readout:true, tall:true, w:420, resize:true,
  params:[{n:'cs',t:'select',opts:['if present','required','ignore'],d:'if present',label:'checksum'},
          {n:'id',t:'text',d:'gps',label:'record id of the receiver'},
          {n:'ttl',t:'range',min:1,max:120,step:1,d:30,label:'AIS: forget a vessel after, min'}],
  init:n=>{ n.lastText=undefined; n.ok=0; n.bad=0; n.skip=0; n.fix={}; n.pend=null; n.lastTime=null; n.out={};
            n.used=new Set(); n.gsv={}; n.frag={}; n.last=''; n.ais={p:{ch:'A'}, ships:new Map(), recent:[], msgs:0, lastMsg:0, seq:0};
            n.satCount=0; n.inView=0; n.lines=[]; },
  process(n,I){
    const now=Date.now();
    const goOn=typeof I.go==='number' && I.go>=0.5;
    const fresh=typeof I.text==='string' && (I.text!==n.lastText || goOn);
    const recs=[], sats=[], aisOut={recs:[],text:[]};
    let go=0;
    if(typeof I.text==='string') n.lastText=I.text;
    if(fresh) for(const ln of I.text.split(/[\r\n]+/)){ if(ln.trim()) go+=nmeaLine(n,ln,now,recs,sats,aisOut); }
    if(n.pend && now-n.pend.at>300){ recs.push(nmeaFlush(n)); }
    for(const [k,v] of n.ais.ships) if(now-v.seen>(+n.p.ttl||30)*60000) n.ais.ships.delete(k);
    recs.push(...aisOut.recs);
    const o=n.out;
    return {rec:recs.length ? recs : null, sat:sats.length ? sats : null,
      lat:o.lat ?? null, lon:o.lon ?? null, alt:o.alt ?? null, sog:o.sog ?? null, cog:o.cog ?? null, hdg:o.hdg ?? null,
      sats:o.sats ?? null, hdop:o.hdop ?? null, depth:o.depth ?? null, wspd:o.wspd ?? null, wdir:o.wdir ?? null, temp:o.temp ?? null,
      go:go ? 1 : 0};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const o=n.out, f=(v,d)=>v==null ? '—' : (+v).toFixed(d);
    let t=n.ok+' sentences'+(n.bad ? ', '+n.bad+' with a bad checksum' : '')+(n.skip ? ', '+n.skip+' skipped' : '');
    if(o.lat!=null) t+='\nfix: '+f(o.lat,5)+', '+f(o.lon,5)+'  alt '+f(o.alt,1)+' m  '+(n.fix.fixName||'')+(o.sats!=null ? '  sats '+o.sats : '')+(o.hdop!=null ? '  hdop '+o.hdop : '');
    if(o.sog!=null || o.cog!=null) t+='\nspeed '+f(o.sog,1)+' kn  course '+f(o.cog,1)+'°'+(o.hdg!=null ? '  heading '+f(o.hdg,0)+'°' : '');
    if(n.fix.utc) t+='\nUTC '+(n.fix.date ? n.fix.date+' ' : '')+n.fix.utc;
    if(n.inView) t+='\nsatellites: '+n.satCount+' in view'+(n.used.size ? ', '+n.used.size+' used' : '');
    if(o.depth!=null) t+='\ndepth '+f(o.depth,1)+' m';
    if(o.wspd!=null) t+='\nwind '+f(o.wspd,1)+' m/s '+f(o.wdir,0)+'°';
    if(o.temp!=null) t+='\nwater '+f(o.temp,1)+' °C';
    if(n.ais.msgs) t+='\nAIS: '+n.ais.msgs+' messages, '+n.ais.ships.size+' vessels';
    if(n.lines.length) t+='\n'+n.lines.slice(-5).join('\n');
    if(r.textContent!==t) r.textContent=t; }
});

// одна строка; возвращает 1, если принято предложение
function nmeaLine(n,line,now,recs,sats,aisOut){
  const s=nmeaSplit(line);
  if(!s) return 0;
  const cs=n.p.cs;
  if(cs!=='ignore' && s.cs==='bad'){ n.bad++; return 0; }
  if(cs==='required' && s.cs==='none'){ n.bad++; return 0; }
  if(s.bang){
    if(s.type!=='VDM' && s.type!=='VDO'){ n.skip++; return 0; }
    n.ok++; nmeaAis(n,s,aisOut); return 1;
  }
  const d=nmeaDecode(s);
  if(!d){ n.skip++; return 0; }
  n.ok++;
    const o=n.out, fx=n.fix;
  const pos=d.valid && (d.type==='GGA' || d.type==='RMC' || d.type==='GLL');
  if(pos){
    if(n.pend && n.lastTime!==null && d.time!=null && d.time!==n.lastTime) recs.push(nmeaFlush(n));
    n.lastTime=d.time;
    fx.lat=o.lat=d.lat; fx.lon=o.lon=d.lon;
    if(!n.pend) n.pend={at:now};
  }
  if(d.time!=null) fx.utc=nmeaHms(d.time);
  if(d.date) fx.date=d.date;
  switch(d.type){
    case 'GGA':
      if(d.valid){ if(d.alt!=null) fx.alt=o.alt=d.alt; fx.fixName=NMEA_FIX[d.fixq]||String(d.fixq); fx.fixq=d.fixq; }
      if(d.sats!=null) fx.sats=o.sats=d.sats;
      if(d.hdop!=null) fx.hdop=o.hdop=d.hdop;
      if(d.geoid!=null) fx.geoid=d.geoid;
      break;
    case 'RMC':
      if(d.valid){ if(d.sog!=null) fx.sog=o.sog=d.sog; if(d.cog!=null) fx.cog=o.cog=d.cog; }
      break;
    case 'VTG':
      if(d.sog!=null) fx.sog=o.sog=d.sog;
      if(d.cog!=null) fx.cog=o.cog=d.cog;
      break;
    case 'GSA': for(const p of d.prn) n.used.add(p); if(d.hdop!=null && fx.hdop==null) o.hdop=d.hdop; fx.pdop=d.pdop; fx.vdop=d.vdop; break;
    case 'GSV': {
      let g=n.gsv[s.talker+(d.sig||'')];
      if(d.num===1 || !g) g=n.gsv[s.talker+(d.sig||'')]=[];
      g.push(...d.sat);
      if(d.num===d.total){
        const sys=NMEA_SYS[s.talker]||s.talker;
        for(const x of g) sats.push({t:now, src:'NMEA', sys, prn:x.prn, el:x.el, az:x.az, snr:x.snr, used:n.used.has(x.prn) ? 1 : 0});
        n.satCount=g.length; n.inView=d.inView;
        n.gsv[s.talker+(d.sig||'')]=[];
      }
      break; }
    case 'HDT': if(d.hdg!=null) fx.hdg=o.hdg=d.hdg; break;
    case 'HDM': case 'HDG': if(d.hdm!=null && fx.hdg==null) o.hdg=d.hdm; break;
    case 'DBT': case 'DPT': if(d.depth!=null) o.depth=d.depth; break;
    case 'MWV': if(d.wspd!=null){ o.wspd=d.wspd; o.wdir=d.wdir; } break;
    case 'MTW': if(d.temp!=null) o.temp=d.temp; break;
    case 'TXT': if(d.text){ n.lines.push('TXT '+d.text.slice(0,60)); if(n.lines.length>5) n.lines.shift(); } break;
  }
  return 1;
}
function nmeaFlush(n){
  const fx=n.fix, id=String(n.p.id||'gps');
  const r={t:Date.now(), src:'NMEA', id, label:id, lat:fx.lat, lon:fx.lon, icon:'triangle'};
  if(fx.alt!=null) r.alt=fx.alt;
  if(fx.sog!=null) r.speed=fx.sog;
  if(fx.cog!=null){ r.course=fx.cog; if(fx.sog>0.5) r.heading=fx.cog; }
  if(fx.hdg!=null) r.heading=fx.hdg;
  if(fx.sats!=null) r.sats=fx.sats;
  if(fx.hdop!=null) r.hdop=fx.hdop;
  if(fx.fixName) r.fix=fx.fixName;
  if(fx.utc) r.utc=fx.utc;
  if(fx.date) r.date=fx.date;
  n.pend=null;
  return r;
}
// !AIVDM / !AIVDO: фрагменты по (seq, канал) → биты → сообщение AIS → запись судна
function nmeaAis(n,s,out){
  const a=nmeaAivdm(s);
  if(!(a.count>=1) || !(a.num>=1) || a.num>a.count) return;
  const key=a.seq+'|'+a.ch;
  let fr=n.frag[key];
  if(a.num===1 || !fr || fr.next!==a.num) fr=n.frag[key]={next:1, pl:'', count:a.count};
  if(a.num!==fr.next) return;
  fr.pl+=a.payload; fr.next++;
  if(a.num<a.count) return;
  delete n.frag[key];
  const lb=nmeaUnarmor(fr.pl,a.fill);
  if(!lb) return;
  const m=aisParse(lb);
  if(m) IQK.aisRx.message(n.ais,m,lb,lb.length,out);
}
