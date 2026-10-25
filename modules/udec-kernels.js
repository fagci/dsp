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
  {id:'ismRx',      proto:'ISM',    kind:'ism',      bands:[[300e6,320e6],[430e6,436e6],[863e6,870e6],[900e6,930e6]], p:{mod:'OOK', bw:'100000', snr:12, reset:12000, minBits:16, raw:true, dedup:1000}},
  {id:'acarsRx',    proto:'ACARS',  kind:'acars',    bands:[[129e6,137e6]], p:{fix:true}},
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
];
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
// Подсказка, на которую декодер молчит giveUp мс, считается ложной.
// подсказка → запись реестра: строка (id / proto / kind без регистра), запись с полями decoder / kind / type, массив — по первому подходящему
function udecFind(h){
  if(h==null) return null;
  if(Array.isArray(h)){ for(const x of h){ const r=udecFind(x); if(r) return r; } return null; }
  if(typeof h==='object') return udecFind(h.decoder) || udecFind(h.kind) || udecFind(h.type) || udecFind(h.proto);
  const s=String(h).trim().toLowerCase();
  if(!s) return null;
  return UDEC_REG.find(r=>r.id.toLowerCase()===s || r.proto.toLowerCase()===s || r.kind===s || r.alias?.includes(s)) || null;
}
IQK.udec={
  init(n){ n.chs=[]; n.chId=0; n.hintId=null; n.hintT=0; n.hintBad=null; n.kids=new Map(); n.st='search'; n.lock=null; n.lastRec=0; n.counts={}; n.last=null; n.recent=[]; n.ui=null; },
  kid(n,r){
    let k=n.kids.get(r.proto);
    if(!k){ k={p:{...r.p}, out:{}, id:r.id}; IQK[r.id].init(k); if(r.post){ k.post={}; UDEC_POST[r.post].init(k.post); } n.kids.set(r.proto,k); }
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
    const recs=[], text=[], rows=[];
    for(const ch of n.chs){
      let x=null;
      if(s && ch.seen===now){
        x=IQK.iqShift.process(ch.sh,{in:s,freq:ch.f}).out;
        if(x && ch.dc) x=IQK.iqDecim.process(ch.dc,{in:x}).out;
      }
      const hint=ch.dec || I.hint;
      const o=this.step(ch.sub,x,hint,now);
      if(o.rec) for(const r of o.rec) recs.push({...r, f:ch.f, ch:ch.id});
      if(o.text) for(const l of String(o.text).split('\n')) if(l) text.push('['+Math.round(ch.f/1e3)/1e3+'] '+l);
      rows.push({ch:ch.id, f:ch.f, bw:ch.bw, st:ch.sub.ui?.st||'', proto:o.proto||'', hint:ch.dec||'', counts:ch.sub.ui?.counts||{}, ago:ch.sub.ui?.ago??null, sr:x?.sr||0, M:ch.M});
    }
    for(const t of text) n.recent.push(t);
    if(n.recent.length>12) n.recent.splice(0,n.recent.length-12);
    n.ui={multi:true, st:'multi', rows, recent:n.recent.slice(-8), counts:{}, act:[], none:!s, nsig:want.length};
    return {rec:recs.length ? recs : null, text:text.length ? text.join('\n') : null, proto:'', locked:rows.some(r=>r.st==='lock'||r.st==='hint'||r.st==='manual') ? 1 : 0, count:rows.length};
  },
  step(n,s,hintIn,now){
    const P=n.p;
    const manual=P.mode==='manual' ? UDEC_REG.find(r=>r.proto===P.proto) : null, h=udecFind(hintIn);
    // ложная подсказка: подсказанный декодер молчит дольше giveUp мс — подсказку не слушаем, пока она не сменится (sigid мог ошибиться)
    if((h?.proto||null)!==n.hintId){ n.hintId=h?.proto||null; n.hintT=now; n.hintBad=null; }
    if(h && !manual && n.hintBad!==h.proto && now-Math.max(n.hintT,n.lastRec)>(+P.giveUp||8000)) n.hintBad=h.proto;
    const hint=h && n.hintBad!==h.proto ? h : null;
    let act, st;
    if(manual){ act=[manual]; st='manual'; n.lock=null; }
    else if(hint){ act=[hint]; st='hint'; n.lock=null; }
    else if(n.lock && now-n.lastRec<=(+P.hold||6000)){ act=[n.lock]; st='lock'; }
    else {
      n.lock=null; st='search';
      // частота потока известна — слушают только декодеры её диапазонов (не нашлось ни одного — все: частота могла быть задана неточно)
      const fc=s?.fc||0, byBand=fc>0 ? UDEC_REG.filter(r=>!r.bands || r.bands.some(b=>fc>=b[0] && fc<=b[1])) : [];
      // декодер, которому не хватает полосы потока (ADS-B ≥ 2 МС/с), не слушает; не осталось ни одного — слушают все подходящие по полосе
      const sr=s?.sr||0, fit=l=>sr ? l.filter(r=>!r.minSr || sr>=r.minSr) : l;
      act=fit(byBand.length ? byBand : UDEC_REG);
      if(!act.length) act=fit(UDEC_REG);
      if(!act.length) act=UDEC_REG;
    }
    n.st=st;
    for(const pr of [...n.kids.keys()]) if(!act.some(r=>r.proto===pr)) n.kids.delete(pr);    // не нужен — состояние долой: вернётся чистым
    const recs=[], text=[];
    if(s) for(const r of act){
      const k=this.kid(n,r);
      let o; try{ o=IQK[r.id].process(k,{in:s},{}) || {}; }catch(e){ o={}; k.err=e.message; }
      const got=Array.isArray(o.rec) ? o.rec : o.rec ? [o.rec] : [];
      // адаптер из двух частей: кадры первой — на вход второй; живость — по кадрам, на выход — итоговые записи
      const outRecs=r.post && got.length ? UDEC_POST[r.post].run(k.post,got,P,now) : got;
      if(got.length){
        for(const x of outRecs) recs.push({...x, proto:x.proto||r.proto, decoder:r.id});
        n.counts[r.proto]=(n.counts[r.proto]||0)+got.length;
        n.last=r.proto; n.lastRec=now;
        if(st==='search') n.lock=r;                      // кто заговорил первым — тот и остаётся
        else if(st==='lock') n.lock=r;
      }
      if(o.text) for(const line of String(o.text).split('\n')) if(line) text.push('['+r.proto+'] '+line);
    }
    if(st==='lock' && recs.length) n.lastRec=now;
    for(const t of text) n.recent.push(t);
    if(n.recent.length>12) n.recent.splice(0,n.recent.length-12);
    const lead=n.lock || act[0];
    const kid1=act.length===1 ? n.kids.get(act[0].proto) : null, kui=kid1?.ui || null, info=kid1?.post && UDEC_POST[act[0].post]?.info ? UDEC_POST[act[0].post].info(kid1.post) : '';
    n.ui={st, act:act.map(r=>r.proto), proto:n.lock?.proto || (st==='hint'||st==='manual' ? act[0].proto : ''), last:n.last,
      hintBad:n.hintBad, counts:{...n.counts}, ago:n.lastRec? now-n.lastRec : null, recent:n.recent.slice(-8), kid:kui, info, none:!s};
    return {rec:recs.length ? recs : null, text:text.length ? text.join('\n') : null,
      proto:n.ui.proto, locked:n.lock || st==='hint' || st==='manual' ? 1 : 0};
  }};
