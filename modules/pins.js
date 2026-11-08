"use strict";
/* ============================ Pins Out / Pins In ============================
   Любой пин графа — наружу и снаружи. Pins Out: на входы (тип val — подойдёт любой провод) подаются iq, spec, sig, num, txt, rec,
   каждому — имя (параметр names). Pins In: те же имена в обратную сторону, выходы val — подавать куда угодно, в том числе num на
   частоту приёмника (у любого узла числовые параметры уже имеют входы-«контролы»), то есть перестройка идёт проводом.
   Транспорт — WebSocket к tools/pin-bridge.mjs (ws://127.0.0.1:8766) или любому, кто говорит кадрами pins-kernels.js.
   Одна связь на адрес; данные уходят, только когда на имя кто-то подписан (иначе нагрузка нулевая). Очереди ограничены: медленному
   клиенту выбрасывается старое, а не копится. Формат кадров и тест — pins-kernels.js, tools/test-pins.mjs. */

const PINS_URL='ws://127.0.0.1:8766';
const PINS_RETRY_MS=3000, PINS_BACKLOG=4<<20, PINS_QMAX=64;
const PINS_COUNTS=['1','2','3','4','6','8','12','16'];
const PINS_LINKS=new Map();                                // адрес → связь, общая для всех узлов Pins на странице

function pinsUrlOf(n){
  const raw=typeof gwUrl==='function' ? gwUrl(n.p.url) : String(n.p.url||'').trim();
  try{ const u=new URL(String(raw).trim()); return u.protocol==='ws:' || u.protocol==='wss:' ? u.toString() : ''; }catch(e){ return ''; }
}
function pinsBlocked(url){
  return location.protocol==='https:' && /^ws:\/\//i.test(url) && !/^ws:\/\/(localhost|127\.|\[::1\])/i.test(url)
    ? 'blocked: an https page can only open wss:// (or ws://localhost)' : '';
}

function pinsAnnounce(L){
  if(!L.ws || L.ws.readyState!==1) return;
  const out=[], inn=[];
  for(const n of L.refs){
    (n.isIn ? inn : out).push(...n.names.map((name,k)=>n.isIn ? {name} : {name,kind:n.kinds[k]||'',fc:n.fcs[k]||0,sr:n.srs[k]||0}));
  }
  L.ws.send(JSON.stringify({t:'pins',out,in:inn}));
  L.annDirty=false;
}
function pinsOpen(L){
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
    if(L.refs.size) L.timer=setTimeout(()=>pinsOpen(L),PINS_RETRY_MS);
  };
  ws.onmessage=e=>{
    if(typeof e.data==='string'){
      let j; try{ j=JSON.parse(e.data); }catch(x){ return; }
      if(j && j.t==='want' && Array.isArray(j.names)){ L.all=j.names.includes('*'); L.want=new Set(j.names.map(String)); L.gen++; }
      return;
    }
    const f=pinDecode(new Uint8Array(e.data));
    if(!f) return;
    L.rx+=e.data.byteLength;
    for(const n of L.refs){
      if(!n.isIn) continue;
      const k=n.names.indexOf(f.name); if(k<0) continue;
      const q=n.qs[k]; q.push(f);
      if(q.length>PINS_QMAX){ q.shift(); n.dropped++; }
    }
  };
}
function pinsAcquire(n,url){
  let L=PINS_LINKS.get(url);
  if(!L){ L={url,ws:null,state:'',want:new Set(),all:false,gen:0,refs:new Set(),timer:null,rx:0,tx:0,drops:0,annDirty:false}; PINS_LINKS.set(url,L); }
  L.refs.add(n); n.lk=L; L.annDirty=true;
  if(!L.ws && !L.timer) pinsOpen(L);
  return L;
}
function pinsRelease(n){
  const L=n.lk; n.lk=null;
  if(!L) return;
  L.refs.delete(n);
  if(L.refs.size){ L.annDirty=true; return; }
  clearTimeout(L.timer); L.timer=null;
  const ws=L.ws; L.ws=null;
  if(ws){ ws.onopen=ws.onclose=ws.onerror=ws.onmessage=null; try{ ws.close(); }catch(e){} }
  PINS_LINKS.delete(L.url);
}
function pinsSend(L,u8){
  const ws=L.ws;
  if(!ws || ws.readyState!==1) return false;
  if(ws.bufferedAmount>PINS_BACKLOG){ L.drops++; return false; }       // клиент не успевает — старое не копим
  ws.send(u8); L.tx+=u8.length; return true;
}
const pinsWanted=(L,name)=>L.all || L.want.has(name);

// узел ↔ связь: подхватывает смену адреса, включение, имена
function pinsSync(n){
  const key=n.p.names+'|'+n.p.count, count=+n.p.count||2;
  if(key!==n.nkey){
    n.nkey=key; n.names=pinNames(n.p.names,count,n.isIn ? 'in' : 'out');
    n.kinds=[]; n.fcs=[]; n.srs=[]; n.seq=n.names.map(()=>0); n.last=[]; n.qs=n.names.map(()=>[]); n.st=n.names.map(()=>({}));
    if(n.lk) n.lk.annDirty=true;
  }
  const url=n.p.on ? pinsUrlOf(n) : '';
  if(n.lk && n.lk.url!==url) pinsRelease(n);
  if(url && !n.lk) pinsAcquire(n,url);
  if(!n.p.on) n.status='off';
  else if(!url) n.status=(typeof gwErr==='function' && gwErr(n.p.url)) || 'URL must start with ws:// or wss://';
  else n.status=n.lk ? n.lk.state : '';
  if(n.lk && n.lk.annDirty) pinsAnnounce(n.lk);
  return n.lk && n.lk.ws && n.lk.ws.readyState===1 ? n.lk : null;
}

function pinsResize(n){
  const side=n.isIn ? 'outs' : 'ins', valid=new Set(portsOf(n,side).map(p=>p.n));
  Graph.edges.filter(e=>n.isIn ? (e.from===n.id && !valid.has(e.fp)) : (e.to===n.id && !valid.has(e.tp))).forEach(delEdge);
  n.nkey=null; rebuildNode(n); markTopoDirty();
}
const pinsPorts=(n,pre)=>{ const names=pinNames(n.p.names,+n.p.count||2,pre); return names.map((name,k)=>({n:pre+(k+1),t:'val',tip:name})); };
const pinsParams=(isIn)=>[
  {n:'on',t:'check',d:false,label:isIn ? 'receive: connect and take the pins from the bridge' : 'send: connect and publish the pins'},
  {n:'url',t:'text',d:PINS_URL,dev:true,label:'tools/pin-bridge.mjs: ws://127.0.0.1:8766 (other device: ws://IP:8766/?token=…) — or @name from Settings → Devices'},
  {n:'count',t:'select',opts:PINS_COUNTS,d:'2',label:'pins',fn:pinsResize},
  {n:'names',t:'text',d:'',label:'names, comma separated ('+(isIn ? 'in1, in2…' : 'out1, out2…')+' by default) — what clients subscribe to'}];

function pinsDraw(n){
  const r=n.el.querySelector('.readout'); if(!r) return;
  const now=performance.now(), L=n.lk;
  if(now-n.rateT>1000){
    if(L){ n.rate=((n.isIn ? L.rx : L.tx)-n.rateB)/((now-n.rateT)/1000); n.rateB=n.isIn ? L.rx : L.tx; }
    n.rateT=now;
  }
  const on=L && L.ws && L.ws.readyState===1;
  const t=n.status+(on ? ' · '+(n.rate/1024).toFixed(0)+' KB/s'+(L.drops ? ' · dropped '+L.drops : '')+(n.dropped ? ' · lost '+n.dropped : '')+
    (n.isIn ? '' : ' · '+(L.all ? 'all' : L.want.size)+' subscribed') : '')+(n.warn ? '\n⚠ '+n.warn : '');
  if(r.textContent!==t) r.textContent=t;
}
function pinsInit(n,isIn){
  n.isIn=isIn; n.lk=null; n.nkey=null; n.names=[]; n.kinds=[]; n.fcs=[]; n.srs=[]; n.seq=[]; n.last=[]; n.qs=[]; n.st=[]; n.gens=[];
  n.status='off'; n.warn=''; n.dropped=0; n.rate=0; n.rateT=performance.now(); n.rateB=0;
}

def({ id:'pinsout', title:'Pins Out', cat:'Data', kw:'expose publish export stream iq spectrum websocket bridge remote api gnuradio openwebrx output pins',
  ins:n=>pinsPorts(n,'in'), outs:[], readout:true,
  params:pinsParams(false),
  init:n=>pinsInit(n,false),
  dispose:pinsRelease,
  process(n,I){
    const L=pinsSync(n), eng=typeof Eng!=='undefined' ? Eng.sr : 0;
    if(!L) return {};
    for(let k=0;k<n.names.length;k++){
      const name=n.names[k], v=I['in'+(k+1)];
      if(v==null || !pinsWanted(L,name)) { n.last[k]=undefined; continue; }
      if(n.gens[k]!==L.gen){ n.gens[k]=L.gen; n.last[k]=undefined; n.st[k].rev=undefined; }           // кто-то подписался заново — отправим текущее
      const c=pinClassify(v,eng);
      if(!c) continue;
      if(c.kind===PIN_JSON){ if(n.last[k]===v) continue; n.last[k]=v; }                 // числа — по изменению, записи — каждая новая
      else if(c.rev!==undefined){ if(n.st[k].rev===c.rev) continue; n.st[k].rev=c.rev; }
      const kn=PIN_KIND_NAME[c.kind];
      if(n.kinds[k]!==kn || n.srs[k]!==c.sr || n.fcs[k]!==c.fc){ n.kinds[k]=kn; n.srs[k]=c.sr; n.fcs[k]=c.fc; L.annDirty=true; }
      for(const f of pinFrames(name,c,n.seq[k])) if(pinsSend(L,f)) n.seq[k]=(n.seq[k]+1)>>>0;
    }
    return {}; },
  draw:pinsDraw });

def({ id:'pinsin', title:'Pins In', cat:'Data', kw:'inject import receive stream iq spectrum websocket bridge remote api gnuradio control retune input pins',
  ins:[], outs:n=>pinsPorts(n,'out'), readout:true, always:true,
  params:pinsParams(true),
  init:n=>pinsInit(n,true),
  dispose:pinsRelease,
  process(n){
    const L=pinsSync(n), res={};
    if(!L) return res;
    n.warn='';
    for(let k=0;k<n.names.length;k++){
      const st=n.st[k], fr=n.qs[k].splice(0), key='out'+(k+1);
      let iq=null;
      for(const f of fr){
        n.kinds[k]=PIN_KIND_NAME[f.kind];
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
          st.seq=f.seq; st.fc=f.fc; iqPush(s,re,im,tag); iq=s;
          st.iqs=s;
        }else{
          const sp=pinSpecOf(f); sp.rev=(st.rev=(st.rev|0)+1); st.spec=sp;
        }
      }
      if(n.kinds[k]==='sig' && st.ring) res[key]=st.ring.pull(buf(n,key));
      else if(n.kinds[k]==='iq' && st.iqs){ if(!iq){ iq=iqStream(n,key,st.iqs.sr,st.iqs.fc); } res[key]=iq; }
      else if(n.kinds[k]==='spec') res[key]=st.spec;
      else if(n.kinds[k]==='json'){ res[key]=st.val; if(st.once) st.val=undefined; }
    }
    return res; },
  draw:pinsDraw });
