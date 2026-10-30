"use strict";
/* ============================ Устройства (мосты): хранилище и окно в Settings ============================
   Gw.resolve('@телефон') → ws://192.168.0.101:8765/?token=… . Список — LS 'dsp-gateways' (имя + адрес), токены — LS 'dsp.gwtok'
   (как ключ синхронизации: не входит в бэкап). Логика — gateways-kernels.js. */

const GW_KEY='dsp-gateways', GW_TOK='dsp.gwtok';
const Gw={
  list(){ try{ return gwClean(JSON.parse(LS.get(GW_KEY)||'[]')); }catch(e){ return []; } },
  tokens(){ try{ const t=JSON.parse(LS.get(GW_TOK)||'{}'); return t && typeof t==='object' ? t : {}; }catch(e){ return {}; } },
  save(list,tokens){
    list=gwClean(list); LS.set(GW_KEY,JSON.stringify(list));
    const tk={}; for(const d of list){ const t=(tokens||{})[d.name.toLowerCase()]; if(t) tk[d.name.toLowerCase()]=t; }
    LS.set(GW_TOK,JSON.stringify(tk)); Gw.names();
  },
  resolve(s){ return gwResolve(this.list(),this.tokens(),s).url; },
  err(s){ return gwResolve(this.list(),this.tokens(),s).err||''; },
  // «@имя» в поле CORS proxy → шаблон адреса прокси этого устройства (должно быть Node-мост)
  proxyTemplate(s){ const n=gwRef(s), d=n!==null && gwFind(this.list(),n); return d ? gwProxyTemplate(d,this.tokens()[d.name.toLowerCase()]) : ''; },
  names(){                                                           // подсказки для полей адреса
    let dl=document.getElementById('gwNames'); if(!dl){ dl=document.createElement('datalist'); dl.id='gwNames'; document.body.append(dl); }
    dl.textContent=''; for(const d of this.list()){ const o=document.createElement('option'); o.value='@'+d.name; o.label=d.url; dl.append(o); }
  },
  // проверка: подключиться и прочитать приветствие → {ok, kind, text}
  probe(d,token){
    return new Promise(res=>{
      const url=gwAddToken(phoneUrlFor(d.url),token); let ws, done=false, t;
      const fin=r=>{ if(done) return; done=true; clearTimeout(t); try{ ws.close(); }catch(e){} res(r); };
      try{ ws=new WebSocket(url); }catch(e){ return res({ok:false,text:e.message}); }
      t=setTimeout(()=>fin({ok:false,text:'no greeting in 5 s — is it a DSP app / Node bridge?'}),5000);
      ws.onerror=()=>{ fin({ok:false,text:'cannot connect (address, port, firewall, token?)'}); };
      ws.onclose=()=>fin({ok:false,text:'closed at once — wrong token or Origin not allowed?'});
      ws.onmessage=e=>{ let j; try{ j=JSON.parse(String(e.data)); }catch(x){ return; } const k=gwKind(j); if(k) fin({ok:true,kind:k,text:GW_KIND_TEXT[k]+(j.host ? ' · '+j.host : '')}); };
    });
  },
};
function phoneUrlFor(u){ try{ const x=new URL(String(u).trim()); return x.protocol==='ws:'||x.protocol==='wss:' ? x.toString() : ''; }catch(e){ return ''; } }
const gwUrl=s=>{ const t=String(s||'').trim(); return t[0]==='@' ? Gw.resolve(t) : t; };    // адрес из поля узла: «@имя» раскрывается, остальное как есть
const gwErr=s=>{ const t=String(s||'').trim(); return t[0]==='@' ? Gw.err(t) : ''; };

// окно «Devices» в панели настроек
(()=>{
  const box=document.getElementById('gwBox'); if(!box) return;
  const listEl=box.querySelector('.gwList'), mk=(tag,cls,txt)=>{ const e=document.createElement(tag); if(cls) e.className=cls; if(txt!=null) e.textContent=txt; return e; };
  let rows=[];                                                       // [{name,url,token}]
  const load=()=>{ const tk=Gw.tokens(); rows=Gw.list().map(d=>({...d,token:tk[d.name.toLowerCase()]||''})); };
  const store=()=>{ const tk={}; for(const r of rows) if(r.token) tk[r.name.toLowerCase()]=r.token; Gw.save(rows.map(({name,url})=>({name,url})),tk); };
  function draw(){
    listEl.textContent='';
    rows.forEach((r,i)=>{
      const card=mk('div','gwRow'), top=mk('div','gwTop');
      const name=mk('input'); name.value=r.name; name.placeholder='name'; name.title='the name nodes use: @'+(r.name||'name'); name.maxLength=24;
      const test=mk('button',null,'Test'), del=mk('button',null,'✕'); del.title='remove'; test.title='connect and read the greeting';
      const url=mk('input'); url.value=r.url; url.placeholder='ws://192.168.0.101:8765   or   ws://host:8777'; url.spellcheck=false;
      const tok=mk('input'); tok.type='password'; tok.value=r.token; tok.placeholder='token (kept only in this browser)'; tok.autocomplete='off';
      const res=mk('div','gwRes');
      name.onchange=()=>{ r.name=name.value.trim(); if(!GW_NAME.test(r.name)){ res.textContent='⚠ the name: letters, digits, _ . - (up to 24)'; return; } store(); };
      url.onchange=()=>{ r.url=url.value.trim(); store(); };
      tok.onchange=()=>{ r.token=tok.value.trim(); store(); };
      del.onclick=()=>{ rows.splice(i,1); store(); draw(); };
      test.onclick=async()=>{ res.textContent='…'; const x=await Gw.probe(r,r.token); res.textContent=(x.ok ? '✓ ' : '⚠ ')+x.text; };
      top.append(name,test,del); card.append(top,url,tok,res); listEl.append(card);
    });
    if(!rows.length) listEl.append(mk('p',null,'No devices yet. Add a phone (the DSP app), a Raspberry Pi or a PC with the Node bridge — then any node takes «@name» in its address field.'));
  }
  box.querySelector('.gwAdd').onclick=()=>{ let k=rows.length+1; while(rows.some(r=>r.name==='device'+k)) k++; rows.push({name:'device'+k,url:'ws://',token:''}); store(); draw(); };
  load(); draw(); Gw.names();
})();

// сертификаты: свой центр (ключ — в IndexedDB и не извлекается) и серверные сертификаты для мостов (cert-kernels.js)
const GwCert={
  db(){ return new Promise((ok,bad)=>{ const q=indexedDB.open('dsp-certs',1); q.onupgradeneeded=()=>q.result.createObjectStore('kv'); q.onsuccess=()=>ok(q.result); q.onerror=()=>bad(q.error); }); },
  async get(k){ const d=await this.db(); return new Promise((ok,bad)=>{ const r=d.transaction('kv').objectStore('kv').get(k); r.onsuccess=()=>ok(r.result); r.onerror=()=>bad(r.error); }); },
  async put(k,v){ const d=await this.db(); return new Promise((ok,bad)=>{ const t=d.transaction('kv','readwrite'); t.objectStore('kv').put(v,k); t.oncomplete=()=>ok(); t.onerror=()=>bad(t.error); }); },
  async ca(create){                                              // → {der, pem, key, subject, ski} из хранилища, при необходимости — новый (ограниченный локальными именами)
    const s=await this.get('ca');
    if(s) return {...s,constrained:true};
    if(!create) return null;
    const ca=await certNewCA({name:'DSP workbench CA ('+location.hostname+')',extractable:false});
    await this.put('ca',{der:ca.der,pem:ca.pem,key:ca.key,subject:ca.subject,ski:ca.ski}); return ca;
  },
};
(()=>{
  const box=document.querySelector('#gwBox .gwCert'); if(!box) return;
  const names=box.querySelector('.gwCertNames'), res=box.querySelector('.gwCertRes');
  const link=(name,text,type)=>{ const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([text],{type:type||'application/x-pem-file'})); a.download=name; a.textContent='⬇ '+name; return a; };
  const say=(t,warn)=>{ res.textContent=''; const d=document.createElement('div'); d.textContent=(warn ? '⚠ ' : '')+t; res.append(d); };
  box.querySelector('.gwCertMake').onclick=async()=>{
    const parts=names.value.split(/[\s,;]+/).filter(Boolean), ips=parts.filter(x=>cdIp(x)), dns=parts.filter(x=>!cdIp(x));
    if(!parts.length){ say('Type the names and IP addresses of the server first (pi.lan 192.168.0.5).',true); return; }
    const bad=dns.find(d=>!/^[A-Za-z0-9.-]+$/.test(d)); if(bad){ say('«'+bad+'» is not a host name.',true); return; }
    try{
      const ca=await GwCert.ca(true), leaf=await certNewLeaf(ca,{dns,ips}), base=(dns[0]||ips[0]).replace(/[^A-Za-z0-9.-]/g,'_');
      say('Certificate for '+[...dns,...ips].join(', ')+' — valid one year, signed by your CA. Give the two files to the server (for the Node bridge: --cert / --key), trust the CA on this device.');
      res.append(link(base+'.crt',leaf.chainPem),link(base+'.key',leaf.keyPem),link('dsp-ca.crt',ca.pem,'application/x-x509-ca-cert'));
      const w=document.createElement('div'); w.textContent='The .key file is the server\'s secret: keep it on the server only.'; res.append(w);
    }catch(e){ say(e.message,true); }
  };
  box.querySelector('.gwCertCa').onclick=async()=>{
    const ca=await GwCert.ca(false);
    if(!ca){ say('No CA yet — it is made together with the first certificate.'); return; }
    say('Your CA (made in this browser; its private key never leaves it and cannot be exported). It may sign only local names (localhost, .local, .lan, .home.arpa, .internal) and private networks, so a leaked CA cannot vouch for a public site. Trust it where wss:// / https:// of your bridges must open: Chrome / Edge → Settings → Privacy and security → Security → Manage certificates → Authorities → Import; Android → Settings → Security → Install a certificate → CA certificate; iOS → install the profile, then Settings → General → About → Certificate Trust Settings; Linux / macOS / Windows — the system keychain / certificate manager.');
    res.append(link('dsp-ca.crt',ca.pem,'application/x-x509-ca-cert'));
    const f=document.createElement('button'); f.textContent='Forget this CA'; f.onclick=async()=>{ if(confirm('Forget the CA? Certificates it signed keep working, but new ones will need a new CA that must be trusted again.')){ const d=await GwCert.db(); d.transaction('kv','readwrite').objectStore('kv').delete('ca'); say('The CA is forgotten.'); } }; res.append(f);
  };
})();
