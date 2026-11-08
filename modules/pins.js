"use strict";
/* ============================ Pins Out / Pins In / Pins (custom) ============================
   Любой пин графа — наружу и снаружи. Pins Out: на входы (тип val — подойдёт любой провод) подаются iq, spec, sig, num, txt, rec,
   каждому — имя (параметр names). Pins In: те же имена в обратную сторону, выходы val — подавать куда угодно, в том числе num на
   частоту приёмника (у любого узла числовые параметры уже имеют входы-«контролы»), то есть перестройка идёт проводом.
   Pins (custom): оба направления в одном узле, а пины создаёт другая сторона — клиент моста ({t:'make'}, подписка на новое имя,
   первый кадр с новым именем) или узел Pins на другом устройстве по WebRTC (он объявляет свои имена). Список лежит в параметре pins
   («>имя» — вход узла, «<имя» — выход), поэтому сохраняется вместе с патчем; пин с готовыми проводами не пропадает.
   Транспорт: WebSocket к tools/pin-bridge.mjs (ws://127.0.0.1:8766) или WebRTC (канал pins узла WebRTC Data, вход rtc): тогда на
   другом конце такой же узел Pins, и мост не нужен. Кадры и сообщения управления одни и те же в обоих случаях.
   Одна связь на адрес / соединение; данные уходят, только когда на имя кто-то подписан (иначе нагрузка нулевая). Очереди
   ограничены: медленному клиенту выбрасывается старое, а не копится. Формат кадров и тест — pins-kernels.js, tools/test-pins.mjs. */

const PINS_URL='ws://127.0.0.1:8766';
const PINS_RETRY_MS=3000, PINS_BACKLOG=4<<20, PINS_QMAX=64;
const PINS_COUNTS=['1','2','3','4','6','8','12','16'];
const PINS_TRANSPORTS=['WebSocket (pin-bridge)','WebRTC'];
const PINS_LINKS=new Map();                                // ключ → связь, общая для всех узлов Pins на странице

function pinsUrlOf(n){
  const raw=typeof gwUrl==='function' ? gwUrl(n.p.url) : String(n.p.url||'').trim();
  try{ const u=new URL(String(raw).trim()); return u.protocol==='ws:' || u.protocol==='wss:' ? u.toString() : ''; }catch(e){ return ''; }
}
function pinsBlocked(url){
  return location.protocol==='https:' && /^ws:\/\//i.test(url) && !/^ws:\/\/(localhost|127\.|\[::1\])/i.test(url)
    ? 'blocked: an https page can only open wss:// (or ws://localhost)' : '';
}
const pinsRtc=n=>n.p.transport==='WebRTC';

/* ---------- связь ---------- */
const pinsReady=L=>L.kind==='rtc' ? !!(L.rn && L.rn.pnsOpen) : !!(L.ws && L.ws.readyState===1);
function pinsSend(L,d){                                     // d — строка или Uint8Array
  if(!pinsReady(L)) return false;
  if(L.kind==='rtc'){ if(!rtcPinsSend(L.rn,d)){ if(typeof d!=='string') L.drops++; return false; } }
  else{
    if(typeof d!=='string' && L.ws.bufferedAmount>PINS_BACKLOG){ L.drops++; return false; }       // клиент не успевает — старое не копим
    L.ws.send(d);
  }
  if(typeof d!=='string') L.tx+=d.length;                    // в счёт идут кадры, не служебные сообщения
  return true;
}
const pinsCtl=(L,o)=>pinsSend(L,JSON.stringify(o));

function pinsAnnounce(L){
  if(!pinsReady(L)) return;
  const out=[], inn=[];
  for(const n of L.refs){
    out.push(...n.sNames.map((name,k)=>({name,kind:n.sSt[k].kind||'',fc:n.sSt[k].fc||0,sr:n.sSt[k].sr||0})));
    inn.push(...n.rNames.map(name=>({name})));
  }
  pinsCtl(L,{t:'pins',out,in:inn});
  // что хотим получать мы: у моста это подписка, у WebRTC — want (другой конец шлёт только это)
  const names=[...new Set([...L.refs].flatMap(n=>n.rNames))];
  pinsCtl(L,{t:L.kind==='rtc' ? 'want' : 'sub',names});
  L.annDirty=false;
}

// другая сторона просит создать пин (или мы увидели имя, которого нет): откладываем, чтобы не перестраивать узел посреди обработки
function pinsGrow(L,dir,name){
  name=pinxName(name);
  if(!name || PINX_RESERVED.has(name)) return;
  for(const n of L.refs) if((dir==='send' ? n.sNames : n.rNames).includes(name)) return;
  const key=dir+'|'+name;
  if(L.growQ.has(key)) return;
  L.growQ.add(key);
  setTimeout(()=>{
    L.growQ.delete(key);
    for(const n of L.refs){
      if(n.type!=='pinsx' || !n.p.grow) continue;
      const t=pinxWith(n.p.pins,dir,name);
      if(t!==null){ n.p.pins=t; pinsResize(n); }
      return;
    }
  },0);
}

function pinsRecv(L,data){
  if(typeof data==='string'){
    let j; try{ j=JSON.parse(data); }catch(x){ return; }
    if(!j) return;
    if(j.t==='want' && Array.isArray(j.names)){
      L.all=j.names.includes('*'); L.want=new Set(j.names.map(String)); L.gen++;
      for(const nm of L.want) if(nm!=='*') pinsGrow(L,'send',nm);          // просят имя, которого у нас нет — вход для него
    }else if(j.t==='make' && typeof j.name==='string') pinsGrow(L,j.dir==='sub' ? 'send' : 'recv',j.name);
    else if(j.t==='pins'){                                                    // другая сторона объявила свои имена
      for(const p of Array.isArray(j.out) ? j.out : []) if(p && p.name) pinsGrow(L,'recv',p.name);
      for(const p of Array.isArray(j.in) ? j.in : []) if(p && p.name) pinsGrow(L,'send',p.name);
    }
    return;
  }
  const f=pinDecode(data instanceof Uint8Array ? data : new Uint8Array(data));
  if(!f) return;
  L.rx+=data.byteLength;
  let got=false;
  for(const n of L.refs){
    const k=n.rNames.indexOf(f.name); if(k<0) continue;
    got=true;
    const q=n.rSt[k].q; q.push(f);
    if(q.length>PINS_QMAX){ q.shift(); n.dropped++; }
  }
  if(!got) pinsGrow(L,'recv',f.name);
}

function pinsOpenWs(L){
  clearTimeout(L.timer); L.timer=null;
  if(!L.refs.size) return;
  const bad=pinsBlocked(L.url); if(bad){ L.state=bad; return; }
  L.state='connecting…';
  let ws; try{ ws=new WebSocket(L.url); }catch(e){ L.state='error: '+e.message; return; }
  ws.binaryType='arraybuffer'; L.ws=ws;
  ws.onopen=()=>{ L.state='connected'; ws.send(JSON.stringify({t:'hello',role:'graph'})); pinsAnnounce(L); };
  ws.onerror=()=>{ if(L.ws===ws && L.state!=='connected') L.state='no connection — is node tools/pin-bridge.mjs running?'; };
  ws.onclose=()=>{
    if(L.ws!==ws) return;
    L.ws=null; L.want=new Set(); L.all=false; L.gen++;
    if(L.state==='connected') L.state='closed';
    if(L.refs.size) L.timer=setTimeout(()=>pinsOpenWs(L),PINS_RETRY_MS);
  };
  ws.onmessage=e=>pinsRecv(L,e.data);
}
// WebRTC: следим за открытием канала у узла WebRTC Data
function pinsPollRtc(L){
  const rn=L.rn;
  if(rn.pnsEv===L.ev) return;
  L.ev=rn.pnsEv;
  L.want=new Set(); L.all=false; L.gen++;
  L.state=rn.pnsOpen ? 'connected' : 'waiting for the WebRTC link';
  if(rn.pnsOpen) pinsAnnounce(L);
}

function pinsAcquire(n,kind,key,src){
  let L=PINS_LINKS.get(key);
  if(!L){
    L={kind,key,url:kind==='ws' ? src : '',rn:kind==='rtc' ? src : null,ws:null,state:'',want:new Set(),all:false,gen:0,refs:new Set(),timer:null,
       rx:0,tx:0,drops:0,annDirty:false,growQ:new Set(),ev:-1};
    PINS_LINKS.set(key,L);
    if(kind==='rtc'){ L.state='waiting for the WebRTC link'; src.pnsH=d=>pinsRecv(L,d); }
  }
  L.refs.add(n); n.lk=L; L.annDirty=true;
  if(kind==='ws' && !L.ws && !L.timer) pinsOpenWs(L);
  return L;
}
function pinsRelease(n){
  const L=n.lk; n.lk=null;
  if(!L) return;
  L.refs.delete(n);
  if(L.refs.size){ L.annDirty=true; return; }
  clearTimeout(L.timer); L.timer=null;
  if(L.kind==='rtc'){ if(L.rn && L.rn.pnsH) L.rn.pnsH=null; }
  else{ const ws=L.ws; L.ws=null; if(ws){ ws.onopen=ws.onclose=ws.onerror=ws.onmessage=null; try{ ws.close(); }catch(e){} } }
  PINS_LINKS.delete(L.key);
}
const pinsWanted=(L,name)=>L.all || L.want.has(name);

/* ---------- узел ↔ связь ---------- */
// имена и состояние пинов; у Out / In — из names + count, у custom — из строки pins. Состояние переносится по имени
function pinsNames(n){
  const count=+n.p.count||2, key=n.type==='pinsx' ? n.p.pins : n.p.names+'|'+count;
  if(key===n.nkey) return;
  n.nkey=key;
  let s=[], r=[], sid=[], rid=[];
  if(n.type==='pinsout'){ s=pinNames(n.p.names,count,'out'); sid=s.map((_,k)=>'in'+(k+1)); }
  else if(n.type==='pinsin'){ r=pinNames(n.p.names,count,'in'); rid=r.map((_,k)=>'out'+(k+1)); }
  else{ const x=pinxParse(n.p.pins); s=sid=x.send; r=rid=x.recv; }
  const so=new Map(n.sNames.map((nm,k)=>[nm,n.sSt[k]])), ro=new Map(n.rNames.map((nm,k)=>[nm,n.rSt[k]]));
  n.sNames=s; n.sIds=sid; n.sSt=s.map(nm=>so.get(nm)||{seq:0});
  n.rNames=r; n.rIds=rid; n.rSt=r.map(nm=>ro.get(nm)||{q:[]});
  if(n.lk) n.lk.annDirty=true;
}
function pinsSync(n,I){
  pinsNames(n);
  let key='', src=null;
  if(n.p.on){
    if(pinsRtc(n)){ const rn=rtcLinked(I && I.rtc); if(rn){ key='rtc:'+rn.id; src=rn; } }
    else{ const url=pinsUrlOf(n); if(url){ key='ws:'+url; src=url; } }
  }
  if(n.lk && n.lk.key!==key) pinsRelease(n);
  if(key && !n.lk) pinsAcquire(n,pinsRtc(n) ? 'rtc' : 'ws',key,src);
  const L=n.lk;
  if(L && L.kind==='rtc') pinsPollRtc(L);
  if(!n.p.on) n.status='off';
  else if(pinsRtc(n) && !L) n.status='wire WebRTC Data → rtc';
  else if(!L) n.status=(typeof gwErr==='function' && gwErr(n.p.url)) || 'URL must start with ws:// or wss://';
  else n.status=L.state;
  if(L && L.annDirty) pinsAnnounce(L);
  return L && pinsReady(L) ? L : null;
}

// узел → наружу: что подписано и изменилось
function pinsTx(n,L,I){
  const eng=typeof Eng!=='undefined' ? Eng.sr : 0;
  for(let k=0;k<n.sNames.length;k++){
    const name=n.sNames[k], st=n.sSt[k], v=I[n.sIds[k]];
    if(v==null || !pinsWanted(L,name)){ st.last=undefined; continue; }
    if(st.gen!==L.gen){ st.gen=L.gen; st.last=undefined; st.rev=undefined; }              // кто-то подписался заново — отправим текущее
    const c=pinClassify(v,eng);
    if(!c) continue;
    if(c.kind===PIN_JSON){ if(st.last===v) continue; st.last=v; }                           // числа — по изменению, записи — каждая новая
    else if(c.rev!==undefined){ if(st.rev===c.rev) continue; st.rev=c.rev; }
    const kn=PIN_KIND_NAME[c.kind];
    if(st.kind!==kn || st.sr!==c.sr || st.fc!==c.fc){ st.kind=kn; st.sr=c.sr; st.fc=c.fc; L.annDirty=true; }
    for(const f of pinFrames(name,c,st.seq)) if(pinsSend(L,f)) st.seq=(st.seq+1)>>>0;
  }
}
// снаружи → на выходы узла
function pinsRx(n,res){
  for(let k=0;k<n.rNames.length;k++){
    const st=n.rSt[k], fr=st.q.splice(0), key=n.rIds[k];
    let iq=null;
    for(const f of fr){
      st.kind=PIN_KIND_NAME[f.kind];
      if(f.kind===PIN_JSON){ st.val=f.data; st.once=typeof f.data==='object' && f.data!==null; }
      else if(f.kind===PIN_SIG){
        if(!st.ring) st.ring=new PinRing(Math.max(4800,Math.round(Eng.sr)));
        if(f.sr && Math.abs(f.sr-Eng.sr)>1) n.warn='"'+f.name+'": sample rate '+f.sr+' ≠ engine '+Eng.sr;
        st.ring.push(f.data);
      }else if(f.kind===PIN_IQ){
        const m=f.data.length>>1, re=new Float32Array(m), im=new Float32Array(m);
        for(let i=0;i<m;i++){ re[i]=f.data[2*i]; im[i]=f.data[2*i+1]; }
        const s=iqStream(n,key,f.sr,f.fc);
        let tag=null;
        if(st.seq!==undefined && f.seq!==((st.seq+1)>>>0)) tag='gap';
        if(st.fc!==undefined && f.fc!==st.fc) tag='retune';
        st.seq=f.seq; st.fc=f.fc; iqPush(s,re,im,tag); iq=s; st.iqs=s;
      }else{ const sp=pinSpecOf(f); sp.rev=(st.rev=(st.rev|0)+1); st.spec=sp; }
    }
    if(st.kind==='sig' && st.ring) res[key]=st.ring.pull(buf(n,key));
    else if(st.kind==='iq' && st.iqs){ if(!iq) iq=iqStream(n,key,st.iqs.sr,st.iqs.fc); res[key]=iq; }
    else if(st.kind==='spec') res[key]=st.spec;
    else if(st.kind==='json'){ res[key]=st.val; if(st.once) st.val=undefined; }
  }
}

function pinsResize(n){
  const vi=new Set(portsOf(n,'ins').map(p=>p.n)), vo=new Set(portsOf(n,'outs').map(p=>p.n));
  Graph.edges.filter(e=>(e.to===n.id && !vi.has(e.tp)) || (e.from===n.id && !vo.has(e.fp))).forEach(delEdge);
  n.nkey=null; rebuildNode(n); markTopoDirty();
}
const pinsPorts=(n,pre,dflt)=>pinNames(n.p.names,+n.p.count||2,dflt).map((name,k)=>({n:pre+(k+1),t:'val',tip:name}));
const RTC_PIN={n:'rtc',t:'rtc'};
const pinsParams=(kind)=>[
  {n:'on',t:'check',d:false,label:{pinsout:'send: connect and publish the pins',pinsin:'receive: connect and take the pins',pinsx:'connect (the other side creates the pins)'}[kind]},
  {n:'transport',t:'select',opts:PINS_TRANSPORTS,d:PINS_TRANSPORTS[0],label:'transport: tools/pin-bridge.mjs (scripts, GNU Radio, other tabs) or WebRTC (wire WebRTC Data → rtc: the other end is a Pins node, no bridge)'},
  {n:'url',t:'text',d:PINS_URL,dev:true,label:'bridge: ws://127.0.0.1:8766 (other device: ws://IP:8766/?token=…) — or @name from Settings → Devices'},
  ...(kind==='pinsx'
    ? [{n:'pins',t:'text',d:'',fn:pinsResize,label:'pins: ">name" — input (graph → out), "<name" — output (in → graph), comma separated. The other side adds its own'},
       {n:'grow',t:'check',d:true,label:'let the other side create pins (subscribe to a new name, send a new name, {"t":"make"}, a Pins node over WebRTC)'}]
    : [{n:'count',t:'select',opts:PINS_COUNTS,d:'2',label:'pins',fn:pinsResize},
       {n:'names',t:'text',d:'',label:'names, comma separated ('+(kind==='pinsin' ? 'in1, in2…' : 'out1, out2…')+' by default) — what clients subscribe to'}])];

function pinsDraw(n){
  const r=n.el.querySelector('.readout'); if(!r) return;
  const now=performance.now(), L=n.lk;
  if(now-n.rateT>1000){
    if(L){ const b=L.rx+L.tx; n.rate=(b-n.rateB)/((now-n.rateT)/1000); n.rateB=b; }
    n.rateT=now;
  }
  const on=L && pinsReady(L);
  const t=n.status+(on ? ' · '+(n.rate/1024).toFixed(0)+' KB/s'+(L.drops ? ' · dropped '+L.drops : '')+(n.dropped ? ' · lost '+n.dropped : '')+
    (n.sNames.length ? ' · '+(L.all ? 'all' : L.want.size)+' subscribed' : '') : '')+(n.warn ? '\n⚠ '+n.warn : '');
  if(r.textContent!==t) r.textContent=t;
}
function pinsInit(n){
  n.lk=null; n.nkey=null; n.sNames=[]; n.sIds=[]; n.sSt=[]; n.rNames=[]; n.rIds=[]; n.rSt=[];
  n.status='off'; n.warn=''; n.dropped=0; n.rate=0; n.rateT=performance.now(); n.rateB=0;
}

const PINS_KW='expose publish export import inject stream iq spectrum websocket webrtc bridge remote api gnuradio openwebrx pins control retune';
def({ id:'pinsout', title:'Pins Out', cat:'Data', kw:PINS_KW,
  ins:n=>[...pinsPorts(n,'in','out'),RTC_PIN], outs:[], readout:true,
  params:pinsParams('pinsout'),
  init:pinsInit, dispose:pinsRelease,
  process(n,I){ const L=pinsSync(n,I); if(L) pinsTx(n,L,I); return {}; },
  draw:pinsDraw });

def({ id:'pinsin', title:'Pins In', cat:'Data', kw:PINS_KW,
  ins:[RTC_PIN], outs:n=>pinsPorts(n,'out','in'), readout:true, always:true,
  params:pinsParams('pinsin'),
  init:pinsInit, dispose:pinsRelease,
  process(n,I){
    const L=pinsSync(n,I), res={};
    n.warn='';
    if(L) pinsRx(n,res);
    return res; },
  draw:pinsDraw });

def({ id:'pinsx', title:'Pins (custom)', cat:'Data', kw:PINS_KW+' custom dynamic create',
  ins:n=>[RTC_PIN,...pinxParse(n.p.pins).send.map(name=>({n:name,t:'val',tip:name}))],
  outs:n=>pinxParse(n.p.pins).recv.map(name=>({n:name,t:'val',tip:name})), readout:true, always:true,
  params:pinsParams('pinsx'),
  init:pinsInit, dispose:pinsRelease,
  process(n,I){
    const L=pinsSync(n,I), res={};
    n.warn='';
    if(L){ pinsTx(n,L,I); pinsRx(n,res); }
    return res; },
  draw:pinsDraw });
