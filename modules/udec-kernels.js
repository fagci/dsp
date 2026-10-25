"use strict";
/* ============================ Universal Decoder (udec): ядро ============================
   Один узел вместо ряда декодеров с переключателем: на входе IQ канала, на выходе общий поток записей rec с полем proto.
   Внутри — реестр декодеров на ядрах IQK (UDEC_REG): у каждого свой объект состояния, создаётся лениво и живёт только пока нужен.
   Режимы: manual — выбранный протокол; hint — протокол подсказан (sigid / Signal Database / таблица каталога сигналов: id декодера,
   имя протокола или вид каталога); auto — без подсказки слушают все сразу, и как только у кого-то пошли записи, остаётся он
   (hold мс после последней записи — и снова поиск); при известной частоте потока (fc) слушают только декодеры её диапазонов (bands). Декодеры только читают входной поток, поэтому делят его без копий.
   В реестр идут только декодеры, которым нужен обычный IQ канала (stdcDecode ждёт символы после PSK Demodulator — не подходит).
   Новый протокол — запись в UDEC_REG (p — параметры по умолчанию ядра: воркер описаний модулей не видит). */
const UDEC_REG=[
  {id:'aisRx',      proto:'AIS',    kind:'ais',      bands:[[156e6,163e6]], p:{ch:'A', ttl:30}},
  {id:'pocsagRx',   proto:'POCSAG', kind:'pocsag',   bands:[[138e6,174e6],[310e6,330e6],[430e6,470e6],[929e6,932e6]], p:{baud:'auto', fix:'2'}},
  {id:'ismRx',      proto:'ISM',    kind:'ism',      bands:[[300e6,320e6],[430e6,436e6],[863e6,870e6],[900e6,930e6]], p:{mod:'OOK', bw:'100000', snr:12, reset:12000, minBits:16, raw:true, dedup:1000}},
  {id:'acarsRx',    proto:'ACARS',  kind:'acars',    bands:[[129e6,137e6]], p:{fix:true}},
  {id:'fskRx',      proto:'DigVoice', kind:'digvoice', alias:['dmr','p25','nxdn','ysf','m17','dstar','d-star','dpmr'], bands:[[136e6,174e6],[300e6,520e6],[764e6,870e6]], p:{proto:'auto'}},
  {id:'mpt1327Rx',  proto:'MPT1327', kind:'mpt1327', bands:[[136e6,174e6],[400e6,470e6]], p:{}},
  {id:'tetraRx',    proto:'TETRA',  kind:'tetra',    bands:[[380e6,470e6]], p:{}},
  {id:'rs41Rx',     proto:'RS41',   kind:'rs41',     bands:[[400e6,406e6]], p:{}},
];
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
  init(n){ n.hintId=null; n.hintT=0; n.hintBad=null; n.kids=new Map(); n.st='search'; n.lock=null; n.lastRec=0; n.counts={}; n.last=null; n.recent=[]; n.ui=null; },
  kid(n,r){
    let k=n.kids.get(r.id);
    if(!k){ k={p:{...r.p}, out:{}, id:r.id}; IQK[r.id].init(k); n.kids.set(r.id,k); }
    return k;
  },
  process(n,I){
    const s=iqIn(I,'in'), now=Date.now(), P=n.p;
    const manual=P.mode==='manual' ? UDEC_REG.find(r=>r.proto===P.proto) : null, h=udecFind(I.hint);
    // ложная подсказка: подсказанный декодер молчит дольше giveUp мс — подсказку не слушаем, пока она не сменится (sigid мог ошибиться)
    if((h?.id||null)!==n.hintId){ n.hintId=h?.id||null; n.hintT=now; n.hintBad=null; }
    if(h && !manual && n.hintBad!==h.id && now-Math.max(n.hintT,n.lastRec)>(+P.giveUp||8000)) n.hintBad=h.id;
    const hint=h && n.hintBad!==h.id ? h : null;
    let act, st;
    if(manual){ act=[manual]; st='manual'; n.lock=null; }
    else if(hint){ act=[hint]; st='hint'; n.lock=null; }
    else if(n.lock && now-n.lastRec<=(+P.hold||6000)){ act=[n.lock]; st='lock'; }
    else {
      n.lock=null; st='search';
      // частота потока известна — слушают только декодеры её диапазонов (не нашлось ни одного — все: частота могла быть задана неточно)
      const fc=s?.fc||0, byBand=fc>0 ? UDEC_REG.filter(r=>!r.bands || r.bands.some(b=>fc>=b[0] && fc<=b[1])) : [];
      act=byBand.length ? byBand : UDEC_REG;
    }
    n.st=st;
    for(const id of [...n.kids.keys()]) if(!act.some(r=>r.id===id)) n.kids.delete(id);    // не нужен — состояние долой: вернётся чистым
    const recs=[], text=[];
    if(s) for(const r of act){
      const k=this.kid(n,r);
      let o; try{ o=IQK[r.id].process(k,{in:s},{}) || {}; }catch(e){ o={}; k.err=e.message; }
      const got=Array.isArray(o.rec) ? o.rec : o.rec ? [o.rec] : [];
      if(got.length){
        for(const x of got) recs.push({...x, proto:x.proto||r.proto, decoder:r.id});
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
    const kui=act.length===1 && n.kids.get(act[0].id)?.ui || null;
    n.ui={st, act:act.map(r=>r.proto), proto:n.lock?.proto || (st==='hint'||st==='manual' ? act[0].proto : ''), last:n.last,
      hintBad:n.hintBad, counts:{...n.counts}, ago:n.lastRec? now-n.lastRec : null, recent:n.recent.slice(-8), kid:kui, none:!s};
    return {rec:recs.length ? recs : null, text:text.length ? text.join('\n') : null,
      proto:n.ui.proto, locked:n.lock || st==='hint' || st==='manual' ? 1 : 0};
  }};
