"use strict";
/* ============================ ADS-B / Mode S 1090 МГц ============================
   ADS-B Demodulator (IQ-блок, ядро в iq-kernels.js): IQ ≥ 2 МС/с → кадры с верной CRC (rec: raw, df, icao, rssi).
   ADS-B Decoder: кадры (rec или текст AVR "*8D…;" — например, из dump1090 по сети) → таблица бортов
   и записи для карты: позиция (CPR), высота, скорость, курс, позывной, squawk. */

defIQ({ id:'adsbDemod', title:'ADS-B Demodulator', cat:'Modulation',
  ins:[{n:'in',t:'iq'}], outs:[{n:'rec',t:'rec'},{n:'rate',t:'num'}],
  params:[{n:'thr',t:'range',min:1,max:12,step:.5,d:6,label:'preamble: pulses over the gaps, dB'},
          {n:'fix',t:'select',opts:['off','1 bit','2 weak bits'],d:'1 bit',label:'fix errors in DF17/18 (2 weak bits — more range, rare ghosts)'}]},
  n=>{ const u=n.ui; if(!u) return 'no input';
    return (u.sr<1.9e6 ? 'needs ≥ 2 MS/s! · ' : '')+u.frames+' frames · '+u.rate.toFixed(1)+'/s · '+u.fixed+' fixed · '+u.known+' aircraft'; });

/* ---------- разбор кадра ---------- */
function adsbBytes(hex){
  const L=hex.length>>1, b=new Uint8Array(L);
  for(let i=0;i<L;i++) b[i]=parseInt(hex.substr(2*i,2),16);
  return b;
}
// биты from..to (с 1, включительно) кадра
function adsbGet(b,from,to){
  let v=0;
  for(let i=from-1;i<to;i++) v=v*2+((b[i>>3]>>(7-(i&7)))&1);
  return v;
}
// код Гиллхема → высота, 100 фт (null — неверный код)
function adsbGillham(a){
  let five=0, one=0;
  if((a&0xFFFF8889) || (a&0xF0)===0) return null;
  if(a&0x10) one^=7; if(a&0x20) one^=3; if(a&0x40) one^=1;
  if((one&5)===5) one^=2;
  if(one>5) return null;
  if(a&0x0002) five^=0xFF; if(a&0x0004) five^=0x7F;
  if(a&0x1000) five^=0x3F; if(a&0x2000) five^=0x1F; if(a&0x4000) five^=0x0F;
  if(a&0x0100) five^=0x07; if(a&0x0200) five^=0x03; if(a&0x0400) five^=0x01;
  if(five&1) one=6-one;
  return five*5+one-13;
}
// 13-битное поле ID/AC → раскладка Mode A (A4A2A1 B4B2B1 C4C2C1 D4D2D1)
function adsbId13(f){
  let h=0;
  if(f&0x1000) h|=0x0010; if(f&0x0800) h|=0x1000; if(f&0x0400) h|=0x0020; if(f&0x0200) h|=0x2000;
  if(f&0x0100) h|=0x0040; if(f&0x0080) h|=0x4000; if(f&0x0020) h|=0x0100; if(f&0x0010) h|=0x0001;
  if(f&0x0008) h|=0x0200; if(f&0x0004) h|=0x0002; if(f&0x0002) h|=0x0400; if(f&0x0001) h|=0x0004;
  return h;
}
function adsbSquawk(f){ const h=adsbId13(f); return [12,8,4,0].map(s=>(h>>s)&7).join(''); }
// AC13 (DF0/4/16/20), фт
function adsbAc13(f){
  if(!f || (f&0x40)) return null;                    // нет данных / метры
  if(f&0x10) return (((f&0x1F80)>>2)|((f&0x20)>>1)|(f&0xF))*25-1000;
  const g=adsbGillham(adsbId13(f)); return g==null ? null : g*100;
}
// AC12 (ADS-B, TC 9-18), фт
function adsbAc12(f){ return adsbAc13(((f&0xFC0)<<1)|(f&0x3F)); }
function adsbCall(b,from){
  let s='';
  for(let k=0;k<8;k++) s+=ADSB_CS[adsbGet(b,from+6*k,from+6*k+5)];
  return /#/.test(s) ? null : s.trim() || null;
}
function adsbSurfSpeed(m){
  if(m===1) return 0; if(m>=2 && m<=8) return 0.125*(m-1); if(m<=12) return 1+(m-9)*0.25;
  if(m<=38) return 2+(m-13)*0.5; if(m<=93) return 15+(m-39); if(m<=108) return 70+(m-94)*2;
  if(m<=123) return 100+(m-109)*5; if(m===124) return 175; return null;
}
// кадр → {icao, df, поля…}; позиции — сырыми CPR (cpr:{odd, lat, lon, surf})
function adsbParse(b){
  const df=b[0]>>3, nb=b.length, m={df};
  if(df===17 || df===18){
    const cf=b[0]&7;
    if(df===18 && cf>2) return null;
    m.icao=((df===18 && cf!==0) ? '~' : '')+modesHex(b.subarray(1,4),3);
    const tc=adsbGet(b,33,37);
    m.tc=tc;
    if(tc>=1 && tc<=4){ m.flight=adsbCall(b,41); m.cat=String.fromCharCode(0x45-tc)+adsbGet(b,38,40); }
    else if(tc>=5 && tc<=8){
      const mv=adsbGet(b,38,44); m.gs=adsbSurfSpeed(mv); m.ground=true;
      if(adsbGet(b,45,45)) m.track=adsbGet(b,46,52)*360/128;
      m.cpr={odd:adsbGet(b,54,54), lat:adsbGet(b,55,71)/131072, lon:adsbGet(b,72,88)/131072, surf:true};
    } else if((tc>=9 && tc<=18) || (tc>=20 && tc<=22)){
      const a=adsbGet(b,41,52);
      if(tc<=18){ const alt=adsbAc12(a); if(alt!=null) m.alt=alt; }
      else if(a) m.altGnss=Math.round(a*3.28084);
      m.ground=false;
      m.cpr={odd:adsbGet(b,54,54), lat:adsbGet(b,55,71)/131072, lon:adsbGet(b,72,88)/131072, surf:false};
    } else if(tc===19){
      const st=adsbGet(b,38,40);
      if(st===1 || st===2){
        const k=st===2 ? 4 : 1, ve=adsbGet(b,47,56), vn=adsbGet(b,58,67);
        if(ve && vn){
          const e=(ve-1)*k*(adsbGet(b,46,46) ? -1 : 1), nn=(vn-1)*k*(adsbGet(b,57,57) ? -1 : 1);
          m.gs=Math.round(Math.hypot(e,nn)); m.track=Math.round(cprMod(Math.atan2(e,nn)*180/Math.PI,360)*10)/10;
        }
      } else if(st===3 || st===4){
        if(adsbGet(b,46,46)) m.hdg=Math.round(adsbGet(b,47,56)*3600/1024)/10;
        const as=adsbGet(b,58,67); if(as) m[adsbGet(b,57,57) ? 'tas' : 'ias']=(as-1)*(st===4 ? 4 : 1);
      }
      const vr=adsbGet(b,70,78);
      if(vr) m.vr=(vr-1)*64*(adsbGet(b,69,69) ? -1 : 1);
    } else if(tc===28 && adsbGet(b,38,40)===1){
      m.squawk=adsbSquawk(adsbGet(b,44,56));
      const em=adsbGet(b,41,43); if(em) m.emerg=['','general','medical','fuel','comm','hijack','downed','reserved'][em];
    }
    return m;
  }
  if(nb<7) return null;
  m.icao=modesHex(b.subarray(1,4),3);
  if(df===11) return m;
  const res=modesResidual(b,nb);                     // адрес в CRC
  m.icao=res.toString(16).toUpperCase().padStart(6,'0');
  if(df===0 || df===4 || df===16 || df===20){ const alt=adsbAc13(adsbGet(b,20,32)); if(alt!=null) m.alt=alt; }
  if(df===5 || df===21) m.squawk=adsbSquawk(adsbGet(b,20,32));
  if(df===0 || df===4 || df===5 || df===20 || df===21){ const fs=adsbGet(b,6,8); if(fs===1 || fs===3) m.ground=true; else if(fs===0 || fs===2) m.ground=false; }
  if((df===20 || df===21) && b[4]===0x20){ const f=adsbCall(b,41); if(f) m.flight=f; }   // Comm-B BDS 2,0
  return m;
}

/* ---------- CPR ---------- */
function cprGlobal(e,o,latest){
  const dE=360/60, dO=360/59, j=Math.floor(59*e.lat-60*o.lat+0.5);
  let lE=dE*(cprMod(j,60)+e.lat), lO=dO*(cprMod(j,59)+o.lat);
  if(lE>=270) lE-=360; if(lO>=270) lO-=360;
  if(Math.abs(lE)>90 || Math.abs(lO)>90 || cprNL(lE)!==cprNL(lO)) return null;
  const odd=latest===o, lat=odd ? lO : lE, nl=cprNL(lat), ni=Math.max(nl-(odd?1:0),1);
  const mm=Math.floor(e.lon*(nl-1)-o.lon*nl+0.5);
  let lon=(360/ni)*(cprMod(mm,ni)+(odd ? o.lon : e.lon));
  if(lon>=180) lon-=360;
  return {lat, lon};
}
function cprLocal(c,rlat,rlon){
  const span=c.surf ? 90 : 360, dlat=span/(c.odd ? 59 : 60);
  const j=Math.floor(rlat/dlat)+Math.floor(0.5+cprMod(rlat,dlat)/dlat-c.lat);
  const lat=dlat*(j+c.lat);
  if(Math.abs(lat)>90) return null;
  const dlon=span/Math.max(cprNL(lat)-c.odd,1);
  const mm=Math.floor(rlon/dlon)+Math.floor(0.5+cprMod(rlon,dlon)/dlon-c.lon);
  let lon=dlon*(mm+c.lon);
  if(lon>=180) lon-=360; if(lon<-180) lon+=360;
  return {lat, lon};
}

/* ---------- декодер ---------- */
// цвет по высоте (как у tar1090): земля — серый, низко — оранжевый, высоко — фиолетовый
function adsbColor(a){
  if(a.ground) return '#9aa0a6';
  if(a.alt==null) return '#e0b23c';
  const h=20+280*clamp(a.alt/40000,0,1);
  return 'hsl('+h.toFixed(0)+',85%,58%)';
}
const ADSB_REC_KEYS=['flight','alt','altGnss','gs','track','hdg','ias','tas','vr','squawk','cat','emerg','rssi','ground'];

def({ id:'adsbDecode', title:'ADS-B Decoder', cat:'Decoders',
  ins:[{n:'rec',t:'rec'},{n:'text',t:'txt'},{n:'lat',t:'num'},{n:'lon',t:'num'}],
  outs:[{n:'rec',t:'rec'},{n:'count',t:'num'},{n:'msgs',t:'num'},{n:'range',t:'num'}],
  readout:true, tall:true, w:540, resize:true,
  params:[{n:'ttl',t:'range',min:10,max:600,step:10,d:60,label:'keep aircraft, s'},
          {n:'rlat',t:'num',d:0,label:'receiver latitude (or lat input / My Position)'},
          {n:'rlon',t:'num',d:0,label:'receiver longitude'},
          {n:'maxKm',t:'range',min:50,max:1000,step:10,d:450,label:'reject positions farther than, km'},
          {n:'noPos',t:'check',d:false,label:'list aircraft without position'},
          {n:'clr',t:'button',label:'Clear',fn:n=>{ n.ac.clear(); n.msgs=0; n.maxRange=0; }}],
  init:n=>{ n.ac=new Map(); n.msgs=0; n.lastText=null; n.maxRange=0; n.lastPrune=0; },
  process(n,I){
    const now=Date.now(), ref=adsbRef(n,I), changed=new Set();
    for(const r of recList(I.rec)) if(r && r.raw) adsbFeed(n,r.raw,r.t||now,r.rssi,ref,changed);
    if(typeof I.text==='string' && I.text!==n.lastText){
      n.lastText=I.text;
      for(const line of I.text.split(/[\r\n;]+/)){
        const h=line.replace(/^@[0-9a-f]{12}/i,'').replace(/[^0-9a-f]/gi,'');
        if(h.length===14 || h.length===28) adsbFeed(n,h,now,null,ref,changed);
      }
    }
    if(now-n.lastPrune>1000){ n.lastPrune=now;
      for(const [k,a] of n.ac) if(now-a.seen>n.p.ttl*1000) n.ac.delete(k); }
    const recs=[];
    for(const k of changed){
      const a=n.ac.get(k); if(!a || a.lat==null) continue;
      const r={t:a.seen, id:k, label:a.flight||k, lat:a.lat, lon:a.lon, icon:'plane', color:adsbColor(a), src:'ADS-B', icao:k, msgs:a.msgs};
      for(const f of ADSB_REC_KEYS) if(a[f]!=null) r[f]=a[f];
      if(a.track!=null || a.hdg!=null) r.heading=a.track ?? a.hdg;
      if(a.gs!=null) r.speed=a.gs;
      recs.push(r);
    }
    return {rec:recs.length ? recs : null, count:n.ac.size, msgs:n.msgs, range:n.maxRange ? +n.maxRange.toFixed(1) : null};
  },
  draw(n){ n.el.querySelector('.readout').textContent=adsbTable(n); }});

function adsbRef(n,I){
  if(typeof I.lat==='number' && typeof I.lon==='number' && isFinite(I.lat) && isFinite(I.lon)) return {lat:I.lat, lon:I.lon};
  if(n.p.rlat || n.p.rlon) return {lat:+n.p.rlat, lon:+n.p.rlon};
  if(GeoMe.lat!=null) return {lat:GeoMe.lat, lon:GeoMe.lon};
  return null;
}
function adsbFeed(n,hex,t,rssi,ref,changed){
  const b=adsbBytes(hex);
  if((b[0]>>3===17 || b[0]>>3===18) && modesResidual(b,b.length)) return;
  const m=adsbParse(b);
  if(!m) return;
  n.msgs++;
  let a=n.ac.get(m.icao);
  if(!a){ a={icao:m.icao, msgs:0, first:t}; n.ac.set(m.icao,a); }
  a.msgs++; a.seen=t;
  if(rssi!=null) a.rssi=rssi;
  for(const f of ['flight','cat','alt','altGnss','gs','track','hdg','ias','tas','vr','squawk','emerg','ground']) if(m[f]!=null) a[f]=m[f];
  if(m.cpr) adsbPos(n,a,m.cpr,t,ref);
  changed.add(m.icao);
}
// позиция: глобально по паре чёт/нечет (≤10 с), иначе локально от прошлой позиции (≤30 с) или приёмника
function adsbPos(n,a,c,t,ref){
  c.t=t;
  a[c.odd ? 'cprO' : 'cprE']=c;
  const e=a.cprE, o=a.cprO;
  let p=null, how='';
  if(!c.surf && e && o && !e.surf && !o.surf && Math.abs(e.t-o.t)<=10000){ p=cprGlobal(e,o,c); how='global'; }
  if(!p && a.lat!=null && t-a.posT<=30000){ p=cprLocal(c,a.lat,a.lon); how='local'; }
  if(!p && c.surf && ref){ p=cprLocal(c,ref.lat,ref.lon); how='ref'; }
  if(!p) return;
  if(a.lat!=null && t-a.posT<=30000){                // скачок быстрее ~1000 узлов — ошибка
    const km=geoDist(a.lat,a.lon,p.lat,p.lon), dt=Math.max(1,(t-a.posT)/1000);
    if(km>0.5+dt*0.52) return;
  }
  if(ref){ const km=geoDist(ref.lat,ref.lon,p.lat,p.lon); if(km>n.p.maxKm) return; if(km>n.maxRange) n.maxRange=km; a.dist=km; }
  a.lat=+p.lat.toFixed(5); a.lon=+p.lon.toFixed(5); a.posT=t; a.posHow=how;
}
function adsbTable(n){
  const now=Date.now(), rows=[...n.ac.values()].filter(a=>n.p.noPos || a.lat!=null).sort((x,y)=>y.seen-x.seen);
  const pad=(v,w)=>String(v ?? '').padEnd(w).slice(0,w), num=(v,w,d=0)=>(v==null ? '' : Number(v).toFixed(d)).padStart(w);
  let s=n.ac.size+' aircraft · '+rows.filter(a=>a.lat!=null).length+' with position · '+n.msgs+' msgs'+
    (n.maxRange ? ' · max '+n.maxRange.toFixed(0)+' km' : '')+'\n';
  s+='ICAO    Flight   Sqwk    Alt   Spd  Hdg      Lat      Lon  Msgs  Age\n';
  for(const a of rows.slice(0,40))
    s+=pad(a.icao,7)+' '+pad(a.flight,8)+' '+pad(a.squawk,4)+' '+(a.ground ? '   gnd' : num(a.alt,6))+' '+num(a.gs,5)+' '+
      num(a.track ?? a.hdg,4)+' '+num(a.lat,8,3)+' '+num(a.lon,8,3)+' '+num(a.msgs,5)+' '+num((now-a.seen)/1000,4)+'\n';
  return s;
}
