"use strict";
/* ============================ Universal Decoder (udec): ядро ============================
   Один узел вместо ряда декодеров с переключателем: на входе IQ канала, на выходе общий поток записей rec с полем proto.
   Внутри — реестр декодеров на ядрах IQK (UDEC_REG): у каждого свой объект состояния, создаётся лениво и живёт только пока нужен.
   Режимы: manual — выбранный протокол; hint — протокол подсказан (sigid / Signal Database / таблица каталога сигналов: id декодера,
   имя протокола или вид каталога); auto — без подсказки слушают все сразу, и как только у кого-то пошли записи, остаётся он
   (hold мс после последней записи — и снова поиск); при известной частоте потока (fc) слушают только декодеры её диапазонов (bands). Декодеры только читают входной поток, поэтому делят его без копий.
   В реестр идут только декодеры, которым нужен обычный IQ канала (stdcDecode ждёт символы после PSK Demodulator — не подходит).
   Новый протокол — запись в UDEC_REG (p — параметры по умолчанию ядра: воркер описаний модулей не видит). */
const UDEC_DEC=[1,2,3,4,5,8,10,16,20,25,32,40,50,64];       // коэффициенты IQ Decimator
const UDEC_REG=[
  {id:'aisRx',      proto:'AIS',    kind:'ais',      bands:[[156e6,163e6]], p:{ch:'A', ttl:30}},
  {id:'pocsagRx',   proto:'POCSAG', kind:'pocsag',   bands:[[138e6,174e6],[310e6,330e6],[430e6,470e6],[929e6,932e6]], p:{baud:'auto', fix:'2'}},
  // ISM: узкий декодер слушает только ±bw/2 у центра потока — для узкого канала; широкий поток (всё окно SDR, вся полоса LPD 433.05–434.79)
  // разбирает ISM Scanner (rtl_433): режет окно на каналы, на каждом детектор и декодеры rtl_433. Выбор — по частоте дискретизации потока
  {id:'ismRx',      proto:'ISM',    kind:'ism',      bands:[[300e6,320e6],[430e6,436e6],[863e6,870e6],[900e6,930e6]], maxSr:600e3, p:{mod:'OOK', bw:'100000', snr:12, reset:12000, minBits:16, raw:true, dedup:1000}},
  {id:'ismScan',    proto:'ISM (wideband)', kind:'ism', variant:true, alias:['ism433','lpd','rtl_433','rtl433'], bands:[[300e6,320e6],[430e6,436e6],[863e6,870e6],[900e6,930e6]], minSr:600e3,
    p:{plan:'4', gain:'auto', dc:'subtract', snr:20, devs:'default', only:'', minp:8, raw:true, minBits:16, dedup:1000}},
  {id:'acarsRx',    proto:'ACARS',  kind:'acars',    bands:[[129e6,137e6]], p:{fix:true}},
  {id:'aeroRx',     proto:'Aero',   kind:'aero',     alias:['inmarsat','inmarsat aero','jaero','satcom'], bands:[[1525e6,1559e6]], minSr:8e3, p:{baud:'600'}},
  {id:'vdl2Rx',     proto:'VDL2',   kind:'vdl2',     alias:['vdlm2','vdl'], bands:[[136e6,137e6]], minSr:48e3, p:{}},
  {id:'fskRx',      proto:'DigVoice', kind:'digvoice', alias:['dmr','p25','nxdn','ysf','m17','dstar','d-star','dpmr'], bands:[[136e6,174e6],[300e6,520e6],[764e6,870e6]], p:{proto:'auto'}},
  {id:'mpt1327Rx',  proto:'MPT1327', kind:'mpt1327', bands:[[136e6,174e6],[400e6,470e6]], p:{}},
  {id:'tetraRx',    proto:'TETRA',  kind:'tetra',    bands:[[380e6,470e6]], p:{}},
  {id:'rs41Rx',     proto:'RS41',   kind:'rs41',     bands:[[400e6,406e6]], p:{}},
  // адаптеры: декодер из двух частей. ADS-B — демодулятор кадров + таблица бортов (adsb-kernels.js), на выходе записи самолётов для карты; нужен поток ≥ 2 МС/с
  {id:'adsbDemod',  proto:'ADS-B',  kind:'adsb',     bands:[[1085e6,1095e6]], minSr:1.9e6, post:'adsb', p:{thr:6, fix:'1 bit'}},
  // LoRa: у декодера параметры сети — по записи на типовую настройку (SF, ширина, слово синхронизации)
  {id:'loraRx',     proto:'LoRaWAN', kind:'lorawan', variant:true, alias:['lora125'], bands:[[433e6,435e6],[863e6,870e6],[902e6,928e6]], minSr:125e3,
    p:{sf:'7', bw:'125000', sync:'34', hdr:'explicit', ldro:'auto', len:16, cr:'4/5', crc:true, thr:9, bad:true, invert:false}},
  {id:'loraRx',     proto:'Meshtastic', kind:'meshtastic', variant:true, alias:['lora','longfast','meshair'], bands:[[433e6,435e6],[863e6,870e6],[902e6,928e6]], minSr:250e3,
    p:{sf:'11', bw:'250000', sync:'2B', hdr:'explicit', ldro:'auto', len:16, cr:'4/5', crc:true, thr:9, bad:true, invert:false}},
  // видео: аналоговое ТВ. TV Decoder ждёт уже демодулированный сигнал, поэтому адаптер из двух ступеней (pre): TV Demodulator → TV Decoder; картинка уходит на video,
  // живость — по захвату синхронизации. FM — FPV 5.8 ГГц и спутниковое, AM (negative) — эфирное ТВ (на частоту несущей изображения)
  {id:'tvDecode',   proto:'Analog TV (FM)', kind:'fpv', liveImg:true, alias:['atv','fm-tv','fpv'], bands:[[1000e6,1400e6],[5645e6,5945e6]], minSr:6e6,
    pre:{id:'tvDemod', p:{mode:'FM', dev:8e6, bw:5e6, inv:false}},
    p:{std:'auto', sync:'auto', trim:0, width:'600', invert:'auto', interlace:'weave', color:true, bright:0, contrast:1, hshift:0, vshift:0}},
  {id:'tvDecode',   proto:'Analog TV (AM)', kind:'atvam', liveImg:true, variant:true, alias:['pal','ntsc','secam','tv','analogtv'], bands:[[48e6,862e6]], minSr:6e6,
    pre:{id:'tvDemod', p:{mode:'AM (negative)', dev:8e6, bw:5e6, inv:false}},
    p:{std:'auto', sync:'auto', trim:0, width:'600', invert:'auto', interlace:'weave', color:true, bright:0, contrast:1, hshift:0, vshift:0}},
  // звук и «главные» декодеры (main:true): у них нет ядра в воркере — работают только в главном потоке (udec-audio.js). Канал → децимация до aud.asr → демодулятор aud.mode →
  // блоки звука по aud.blk → MOD[id].process (Eng.sr и BLOCK подменяются на время блока). stages — цепочка блоков (выход via первого — вход следующего), rd — как читать выход.
  // needFc: без известной частоты потока (fc) не слушает — слишком много демодуляторов и ложных срабатываний; по подсказке и вручную работает всегда
  {id:'sameRx',     proto:'SAME/EAS', kind:'same', main:true, needFc:true, alias:['eas','nwr','noaa'], bands:[[162.4e6,162.55e6]], minSr:12e3, rd:'rec',
    aud:{mode:'FM', dev:5000, asr:12000, blk:512}, p:{wait:4}},
  {id:'selcalRx',   proto:'SELCAL', kind:'selcal', main:true, needFc:true, bands:[[2.8e6,23.4e6]], minSr:8e3, rd:'rec',
    aud:{mode:'USB', bw:3000, asr:8000, blk:512}, p:{code:'', shift:0, thr:.35}},
  {id:'morseRx',    proto:'Morse', kind:'morse', main:true, needFc:true, alias:['cw'], bands:[[190e3,535e3],[1.8e6,30e6],[50e6,54e6]], minSr:4e3, rd:'tail', gate:'morse', idle:2000, maxLen:40,
    aud:{mode:'ENV', asr:4000, blk:64, feed:'level'}, p:{thr:.5, auto:true, minRun:20}},
  {id:'dtmfRx',     proto:'DTMF', kind:'dtmf', main:true, needFc:true, bands:[[26e6,30e6],[136e6,174e6],[400e6,470e6]], minSr:8e3, rd:'tail', gate:'dtmf', idle:800, maxLen:16,
    aud:{mode:'FM', dev:3000, asr:8000, blk:160}, p:{thr:6, minMs:40}},
  // aFSK: частоты и скорость afskRx находит сам; код — Baudot (RTTY, основной случай) или ASCII
  {id:'afskRx',     proto:'RTTY', kind:'rtty', main:true, needFc:true, alias:['baudot','ita2'], bands:[[1.8e6,30e6],[144e6,148e6],[430e6,440e6]], minSr:12e3, rd:'tail', gate:'afsk',
    aud:{mode:'USB', bw:3000, asr:12000, blk:512}, p:{fmin:300, fmax:3000, baudMin:20, baudMax:300, code:'Baudot (RTTY)', invert:false}, over:['code']},
  {id:'afskRx',     proto:'aFSK (ASCII)', kind:'afsk', main:true, needFc:true, variant:true, alias:['afsk','ascii-fsk'], bands:[[1.8e6,30e6],[144e6,148e6],[430e6,440e6]], minSr:12e3, rd:'tail', gate:'afsk',
    aud:{mode:'USB', bw:3000, asr:12000, blk:512}, p:{fmin:300, fmax:3000, baudMin:20, baudMax:300, code:'ASCII 8N1', invert:false}},
  {id:'ax25Rx',     proto:'AX.25/APRS', kind:'ax25', main:true, needFc:true, alias:['aprs','packet','bell202'], bands:[[144e6,146e6],[161.9e6,162.1e6],[430e6,440e6]], minSr:12e3, rd:'ax25',
    aud:{mode:'FM', dev:3000, asr:12000, blk:512},
    stages:[{id:'fsk', p:{f0:1200, shift:1000, bw:600, invert:false, center:false}, via:'soft'}, {id:'ax25Rx', p:{baud:1200, nrzi:true, inv:false, ax25:true}}], p:{}},
  {id:'wwv',        proto:'WWV/CHU', kind:'wwv', main:true, needFc:true, alias:['wwvh','chu','timecode'], bands:[[2.4e6,2.6e6],[3.3e6,3.35e6],[4.9e6,5.1e6],[7.8e6,7.9e6],[9.9e6,10.1e6],[14.6e6,14.7e6],[14.9e6,15.1e6],[19.9e6,20.1e6]], minSr:8e3, rd:'wwv',
    aud:{mode:'AM', asr:8000, blk:256}, p:{station:'WWV/CHU 1000Hz', keep:20}},
  // слоты по 15 с (UTC): декодер ждёт границу слота, поэтому без частоты (диал) и подсказки не слушает. Диал — частота потока: сигнал на нём, тоны выше (USB)
  {id:'ft8Rx',      proto:'FT8', kind:'ft8', main:true, needFc:true, bands:[[1.838e6,1.845e6],[3.570e6,3.578e6],[5.355e6,5.362e6],[7.071e6,7.078e6],[10.133e6,10.140e6],[14.071e6,14.078e6],[18.097e6,18.104e6],[21.071e6,21.078e6],[24.912e6,24.919e6],[28.071e6,28.078e6],[50.310e6,50.318e6]], minSr:12e3, rd:'rec',
    aud:{mode:'USB', bw:3000, asr:12000, blk:512}, p:{fmin:200, fmax:2800, top:20, thr:1.6, keep:12, side:'USB', tones:false, decode:true, budget:800, freq:0}, over:['side']},
  {id:'js8Rx',      proto:'JS8Call', kind:'js8', main:true, needFc:true, alias:['js8'], bands:[[1.841e6,1.846e6],[3.577e6,3.581e6],[7.077e6,7.081e6],[10.129e6,10.133e6],[14.077e6,14.081e6],[18.103e6,18.107e6],[21.077e6,21.081e6],[24.921e6,24.925e6],[28.077e6,28.081e6]], minSr:12e3, rd:'rec',
    aud:{mode:'USB', bw:3000, asr:12000, blk:512}, p:{fmin:200, fmax:2800, top:8, thr:1.6, keep:12, tones:false, decode:true, dict:true, budget:800}},
  // Olivia: тоны / полоса — как у передатчика, поэтому по записи на типовую настройку
  {id:'oliviaRx',   proto:'Olivia 8/250', kind:'olivia', main:true, needFc:true, alias:['olivia8'], bands:[[1.8e6,30e6]], minSr:8e3, rd:'tail', gate:'olivia',
    aud:{mode:'USB', bw:3000, asr:12000, blk:512}, p:{tones:'8', bw:'250', f0:1000}},
  {id:'oliviaRx',   proto:'Olivia 16/500', kind:'olivia16', main:true, needFc:true, variant:true, alias:['olivia16'], bands:[[1.8e6,30e6]], minSr:8e3, rd:'tail', gate:'olivia',
    aud:{mode:'USB', bw:3000, asr:12000, blk:512}, p:{tones:'16', bw:'500', f0:1000}},
  // акустический модем: несущая и длина тона — как у передатчика; в поиске не участвует (нет признака, по которому его можно было бы узнать)
  {id:'tbskRx',     proto:'TBSK', kind:'tbsk', main:true, auto:false, alias:['tbskmodem'], minSr:24e3, rd:'rec',
    aud:{mode:'FM', dev:5000, asr:24000, blk:512}, p:{fc:4800, cycle:10, th:.2, det:.4, max:0}},
  // GSM: IQ напрямую (ему нужен поток ≥ 1.06 МС/с)
  {id:'gsmRx',      proto:'GSM', kind:'gsm', main:true, needFc:true, bands:[[869e6,894e6],[925e6,960e6],[1805e6,1880e6],[1930e6,1990e6]], minSr:1.06e6, rd:'rec',
    p:{afc:true, debug:false, allts:false, ids:'hash'}},
  // Meteor-M LRPT: PSK Demodulator → CCSDS Decoder; кадры VC5 собираются в картинку МСУ-МР (на выход video), записи — кадры без самих байт
  {id:'ccsdsDecode', proto:'Meteor LRPT', kind:'lrpt', needFc:true, alias:['meteor','ccsds','lrptimage'], bands:[[137e6,138e6]], minSr:150e3, post:'lrpt',
    pre:{id:'pskDemod', p:{mode:'OQPSK', rate:72000, alpha:.6, bw:.005, pull:10000}},
    p:{nrzm:true, rs:'RS (255,223)'}},
  // маршрут без декодирования: DVB разбирает «DVB Receiver (IQ)» — узел главного потока со своим пулом воркеров (leandvb), в ядре он жить не может.
  // Узел по подсказке (dvbs / dvbt / dvbsoft) или вручную отдаёт IQ канала на выход iq — его и подключают к DVB Receiver; сам такой протокол в поиске не участвует
  {id:null, route:'dvbsoft', proto:'DVB', kind:'dvb', alias:['dvbs','dvbs2','dvbt','dvbt2','dvbsoft','dvb-s','dvb-s2','dvb-t2'], bands:[[174e6,862e6],[10.7e9,12.75e9]], minSr:2e6, p:{}},
];
const UDEC_LIVE=UDEC_REG.filter(r=>!r.route);       // кто реально декодирует (маршруты — нет)
// main-декодер работает, только если рядом мост (udec-audio.js) и модули страницы: в воркере острова их нет
const udecRun=r=>!r.main || (typeof UDEC_AUDIO!=='undefined' && UDEC_AUDIO.ready());
// узлу нужен главный поток: включён параметр audio или вручную выбран main-декодер (см. mainWhen в udec.js)
const udecMainWhen=n=>!!n.p.audio || (n.p.mode==='manual' && !!UDEC_REG.find(r=>r.proto===n.p.proto)?.main);
// вторая часть адаптера: записи первой (кадры) → итоговые записи. state — свой на экземпляр; params узла udec — P
const UDEC_POST={
  adsb:{
    init(k){ k.ac=new Map(); k.msgs=0; k.maxRange=0; k.lastPrune=0; k.p={maxKm:0}; },
    run(k,frames,P,now){
      const ref=(+P.rlat || +P.rlon) ? {lat:+P.rlat, lon:+P.rlon} : null, changed=new Set();
      for(const r of frames) if(r && r.raw) adsbFeed(k,r.raw,r.t||now,r.rssi,ref,changed);
      if(now-k.lastPrune>1000){ k.lastPrune=now; for(const [a,v] of k.ac) if(now-v.seen>60000) k.ac.delete(a); }
      return adsbRecs(k,changed);
    },
    info(k){ return 'aircraft '+k.ac.size+' · frames '+k.msgs; }
  }
};
// Meteor LRPT: кадры CCSDS (VCDU) → пакеты VC5 → сегменты МСУ-МР (lrpt-msumr.js) → композит RGB в ImageData (раз в 2 с); холста нет — работает и в воркере
UDEC_POST.lrpt={
  init(k){ k.im=msuNew(); k.st={}; k.frames=0; k.img=null; k.imgNew=false; k.imgT=0; },
  run(k,frames,P,now){
    const out=[];
    for(const r of frames){
      if(!r || !r.vcdu) continue;
      k.frames++;
      if(r.vcid===5) for(const p of msuDemux(k.st,r.vcdu)) msuAdd(k.im,p);
      const {vcdu,...rest}=r; out.push(rest);
    }
    if(k.im.rows && now-k.imgT>2000 && out.length){ k.imgT=now; k.img=udecLrptImage(k.im); k.imgNew=true; }
    return out;
  },
  info(k){ return 'frames '+k.frames+' · image lines '+k.im.rows*8; }
};
function udecLrptImage(im){
  const W=MSU_W, H=im.rows*8, d=new Uint8ClampedArray(W*H*4), m=[1,1,0];       // «RGB 221» как в LRPT Image
  for(let r=0;r<im.rows;r++){
    const rows=m.map(c=>im.ch.get(c)?.rows.get(r));
    for(let i=0;i<W*8;i++){ const o=4*(r*W*8+i); d[o]=rows[0] ? rows[0][i] : 0; d[o+1]=rows[1] ? rows[1][i] : 0; d[o+2]=rows[2] ? rows[2][i] : 0; d[o+3]=255; }
  }
  return {w:W, h:H, data:typeof ImageData==='function' ? new ImageData(d,W,H) : {data:d, width:W, height:H}};
}
// Подсказка, на которую декодер молчит giveUp мс, считается ложной.
function udecCopyIq(n,s){
  const o=iqStream(n,'iq',s.sr,s.fc);
  for(const c of s.chunks) iqPush(o,Float32Array.from(c.re),c.im ? Float32Array.from(c.im) : null,c.tag);
  return o;
}
// подсказка → запись реестра: строка (id / proto / kind без регистра), запись с полями decoder / kind / type, массив — по первому подходящему
function udecFind(h){
  if(h==null) return null;
  if(Array.isArray(h)){ for(const x of h){ const r=udecFind(x); if(r) return r; } return null; }
  if(typeof h==='object') return udecFind(h.decoder) || udecFind(h.kind) || udecFind(h.type) || udecFind(h.proto);
  const s=String(h).trim().toLowerCase();
  if(!s) return null;
  return udecFindAll(s)[0] || null;
}
// все записи под подсказкой-строкой (у ISM их две: узкая и широкая — выбор по ширине потока, udecFit)
function udecFindAll(h){
  if(h==null) return [];
  if(Array.isArray(h)){ for(const x of h){ const r=udecFindAll(x); if(r.length) return r; } return []; }
  if(typeof h==='object'){ for(const k of ['decoder','kind','type','proto']){ const r=udecFindAll(h[k]); if(r.length) return r; } return []; }
  const s=String(h).trim().toLowerCase();
  if(!s) return [];
  const m=r=>(r.id||'').toLowerCase()===s || r.proto.toLowerCase()===s || r.kind===s || r.alias?.includes(s);
  const out=UDEC_REG.filter(m);
  // id декодера называет одну запись; если оно у нескольких (две настройки LoRa, ТВ) — первая и все с тем же видом
  return out;
}
// подходит ли декодер потоку по частоте дискретизации (sr неизвестна — подходит)
const udecFit=(r,sr)=>!sr || ((!r.minSr || sr>=r.minSr) && (!r.maxSr || sr<=r.maxSr));
IQK.udec={
  init(n){ n.chs=[]; n.chId=0; n.hintId=null; n.hintT=0; n.hintBad=null; n.kids=new Map(); n.st='search'; n.lock=null; n.lastRec=0; n.counts={}; n.last=null; n.recent=[]; n.ui=null; },
  kid(n,r){
    let k=n.kids.get(r.proto);
    if(!k){ k={p:{...r.p}, out:{}, id:r.id}; if(!r.main) IQK[r.id].init(k); if(r.post){ k.post={}; UDEC_POST[r.post].init(k.post); }
      if(r.pre){ k.pre={p:{...r.pre.p}}; IQK[r.pre.id].init(k.pre); } n.kids.set(r.proto,k); }
    return k;
  },
  // вход sigs (метки sigid) — режим нескольких каналов: каждому сигналу свой сдвиг, децимация и своя логика выбора; иначе один канал
  process(n,I){
    const s=iqIn(I,'in'), now=Date.now();
    if(Array.isArray(I.sigs)) return this.multi(n,s,I,now);
    return this.step(n,s,I.hint,now);
  },
  multi(n,s,I,now){
    const P=n.p, maxCh=Math.max(1,+P.maxCh||4), hold=+P.chHold||8000;
    n.chs=n.chs||[];
    const want=I.sigs.filter(b=>b && isFinite(b.f) && b.f>0).sort((a,b)=>(b.db??-200)-(a.db??-200)).slice(0,maxCh);
    const seen=new Set();
    if(s) for(const g of want){
      const bw=g.nbw>0 ? g.nbw : Math.max(g.hi-g.lo,0) || 25e3;
      let ch=n.chs.find(c=>!seen.has(c) && Math.abs(c.f-g.f)<=Math.max(5e3,.5*bw,.5*c.bw));
      if(!ch){
        if(n.chs.length>=maxCh) continue;
        ch={f:g.f, bw, id:++n.chId||(n.chId=1), sh:{p:{offset:0}}, dc:null, M:0, sub:{p:P}, t:now};
        IQK.iqShift.init(ch.sh); IQK.udec.init(ch.sub); n.chs.push(ch);
      }
      seen.add(ch); ch.f=g.f; ch.bw=bw; ch.seen=now; ch.dec=g.dec||'';
      // децимация: выход ≥ 2.5 ширины канала, но не уже 48 кС/с; ширина потока декодера всё равно уйдёт внутрь (AIS, POCSAG…)
      const target=Math.min(s.sr,Math.max(48e3,2.5*bw)), M=UDEC_DEC.reduce((m,d)=>s.sr/d>=target ? d : m,1);
      if(M!==ch.M){ ch.M=M; ch.dc=M>1 ? {p:{M:String(M), cut:.4, tpp:'16'}} : null; if(ch.dc) IQK.iqDecim.init(ch.dc); }
      ch.sr=s.sr;
    }
    n.chs=n.chs.filter(c=>now-(c.seen||c.t)<=hold);
    const recs=[], text=[], rows=[], voices=[], outIdx=Math.max(1,Math.min(n.chs.length||1,+P.outCh||1))-1;
    let iq=null, video=null;
    for(const [ci,ch] of n.chs.entries()){
      let x=null;
      if(s && ch.seen===now){
        x=IQK.iqShift.process(ch.sh,{in:s,freq:ch.f}).out;
        if(x && ch.dc) x=IQK.iqDecim.process(ch.dc,{in:x}).out;
      }
      const hint=ch.dec || I.hint;
      ch.sub.wantIq=!!P.passIq && ci===outIdx;           // IQ вырезанного канала — только выбранного (outCh): копия стоит
      const o=this.step(ch.sub,x,hint,now);
      if(o.rec) for(const r of o.rec) recs.push({...r, f:ch.f, ch:ch.id});
      if(o.voice) for(const v of o.voice) voices.push({...v, f:ch.f, ch:ch.id});
      if(ci===outIdx){ iq=o.iq; video=o.video; }
      if(o.text) for(const l of String(o.text).split('\n')) if(l) text.push('['+Math.round(ch.f/1e3)/1e3+'] '+l);
      rows.push({ch:ch.id, f:ch.f, bw:ch.bw, st:ch.sub.ui?.st||'', proto:o.proto||'', hint:ch.dec||'', counts:ch.sub.ui?.counts||{}, ago:ch.sub.ui?.ago??null, sr:x?.sr||0, M:ch.M});
    }
    for(const t of text) n.recent.push(t);
    if(n.recent.length>12) n.recent.splice(0,n.recent.length-12);
    n.ui={multi:true, st:'multi', rows, recent:n.recent.slice(-8), counts:{}, act:[], none:!s, nsig:want.length};
    return {rec:recs.length ? recs : null, text:text.length ? text.join('\n') : null, voice:voices.length ? voices : null, video, iq, proto:'', locked:rows.some(r=>r.st==='lock'||r.st==='hint'||r.st==='manual') ? 1 : 0, count:rows.length};
  },
  step(n,s,hintIn,now){
    const P=n.p;
    n.tick=(n.tick|0)+1;                                // номер такта: мост (udec-audio.js) считает общую цепочку «децимация + демодулятор» раз за такт
    // подсказка с учётом ширины потока: «ism» на окне 1–2.4 МС/с — широкий ISM Scanner, на узком канале — ISM 433 Decoder
    const hs=udecFindAll(hintIn), h=hs.find(r=>udecFit(r,s?.sr||0)) || hs[0] || null;
    const manual=P.mode==='manual' ? UDEC_REG.find(r=>r.proto===P.proto) : null;
    // ложная подсказка: подсказанный декодер молчит дольше giveUp мс — подсказку не слушаем, пока она не сменится (sigid мог ошибиться)
    if((h?.proto||null)!==n.hintId){ n.hintId=h?.proto||null; n.hintT=now; n.hintBad=null; }
    // main-декодеры не в счёт: их подсказка явная, молчать они могут сколько угодно (SAME — неделями, FT8 — слот 15 с), а откат к поиску оставил бы узел глухим (без fc они в поиске не слушают)
    if(h && !h.main && !manual && n.hintBad!==h.proto && now-Math.max(n.hintT,n.lastRec)>(+P.giveUp||8000)) n.hintBad=h.proto;
    const hint=h && n.hintBad!==h.proto ? h : null;
    let act, st;
    if(manual){ act=[manual]; st='manual'; n.lock=null; }
    else if(hint){ act=[hint]; st='hint'; n.lock=null; }
    else if(n.lock && now-n.lastRec<=(+P.hold||6000)){ act=[n.lock]; st='lock'; }
    else {
      n.lock=null; st='search';
      // частота потока известна — слушают только декодеры её диапазонов (не нашлось ни одного — все: частота могла быть задана неточно)
      // auto:false (TBSK) в поиске не участвует; needFc (звуковые, FT8, GSM…) — только когда частота потока известна
      const fc=s?.fc||0, live=UDEC_LIVE.filter(r=>r.auto!==false && udecRun(r)), blind=live.filter(r=>!r.needFc);
      const byBand=fc>0 ? live.filter(r=>!r.bands || r.bands.some(b=>fc>=b[0] && fc<=b[1])) : [];
      // декодер, которому не хватает полосы потока (ADS-B ≥ 2 МС/с), не слушает; не осталось ни одного — слушают все подходящие по полосе
      const sr=s?.sr||0, fit=l=>l.filter(r=>udecFit(r,sr));
      act=fit(byBand.length ? byBand : blind);
      if(!act.length) act=fit(blind);
      if(!act.length) act=blind;
    }
    n.st=st;
    for(const pr of [...n.kids.keys()]) if(!act.some(r=>r.proto===pr)) n.kids.delete(pr);    // не нужен — состояние долой: вернётся чистым
    const recs=[], text=[], voices=[], route=act.find(r=>r.route)||null;
    let video=null, needMain=false;
    if(s) for(const r of act){
      if(r.route) continue;                                // маршрут: декодера в ядре нет
      if(r.main && !udecRun(r)){ needMain=true; continue; }   // в воркере острова мост недоступен: узел сам переедет в главный поток (udec.js)
      const k=this.kid(n,r);
      let o;
      try{
        if(r.main) o=UDEC_AUDIO.run(n,k,r,s,now) || {};
        else {
          let feed=s;
          if(r.pre){ feed=(IQK[r.pre.id].process(k.pre,{in:s},{}) || {}).out; }     // ступень перед декодером (TV Demodulator)
          o=feed ? IQK[r.id].process(k,{in:feed},{}) || {} : {};
        }
      }catch(e){ o={}; k.err=e.message; }
      const got=Array.isArray(o.rec) ? o.rec : o.rec ? [o.rec] : [];
      // адаптер из двух частей: кадры первой — на вход второй; живость — по кадрам, на выход — итоговые записи
      const outRecs=r.post && got.length ? UDEC_POST[r.post].run(k.post,got,P,now) : got;
      // видео: картинка декодера (аналоговое ТВ) уходит на video; живость — по захвату синхронизации
      if(r.liveImg && o.img) video=o.img;
      if(k.post?.imgNew){ video=k.post.img; k.post.imgNew=false; }       // картинка адаптера (Meteor LRPT)
      // неопознанные пакеты (kind unknown) — выводятся, но захват не дают: чужой всплеск (AIS) у ISM-сканера тоже «пакет импульсов»
      const alive=got.some(x=>x && x.kind!=='unknown') || (r.liveImg && (o.lock>0 || !!o.img));
      if(alive){
        for(const x of outRecs) recs.push({...x, proto:x.proto||r.proto, decoder:r.id});
        n.counts[r.proto]=(n.counts[r.proto]||0)+(got.length || (o.img ? 1 : 0));
        n.last=r.proto; n.lastRec=now;
        if(st==='search') n.lock=r;                      // кто заговорил первым — тот и остаётся
        else if(st==='lock') n.lock=r;
      }
      // звук: кадры голоса декодера (DMR / P25 / NXDN / TETRA…) — на выход voice, дальше Vocoder (mbelib) → звук
      if(o.voice){ const vl=Array.isArray(o.voice) ? o.voice : [o.voice]; for(const v of vl) voices.push({...v, proto:v.proto||r.proto, decoder:r.id}); }
      if(o.text) for(const line of String(o.text).split('\n')) if(line) text.push('['+r.proto+'] '+line);
    }
    // IQ канала на выход: по параметру passIq, а у маршрута — всегда (его и подключают к DVB Receiver). Копия: буферы входа уходят дальше по графу
    const wantIq=n.wantIq ?? !!P.passIq;
    const iq=s && (wantIq || route) ? udecCopyIq(n,s) : null;
    if(st==='lock' && recs.length) n.lastRec=now;
    for(const t of text) n.recent.push(t);
    if(n.recent.length>12) n.recent.splice(0,n.recent.length-12);
    const lead=n.lock || act[0];
    const kid1=act.length===1 ? n.kids.get(act[0].proto) : null, kui=kid1?.ui || null, info=kid1?.post && UDEC_POST[act[0].post]?.info ? UDEC_POST[act[0].post].info(kid1.post) : '';
    n.ui={st, act:act.map(r=>r.proto), route:route?.route||'', proto:n.lock?.proto || (st==='hint'||st==='manual' ? act[0].proto : ''), last:n.last,
      hintBad:n.hintBad, counts:{...n.counts}, ago:n.lastRec? now-n.lastRec : null, recent:n.recent.slice(-8), kid:kui, info, none:!s, needMain};
    return {rec:recs.length ? recs : null, text:text.length ? text.join('\n') : null, voice:voices.length ? voices : null, video, iq,
      proto:n.ui.proto, locked:n.lock || st==='hint' || st==='manual' ? 1 : 0};
  }};
