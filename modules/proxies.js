"use strict";
/* ============================ Прокси: хранилище и окно в Settings → Network ============================
   Список (LS 'dsp-proxies': имя, вид cors / bridge / socks) и общий прокси (LS 'dsp-proxy' — имя из списка). Логика — proxy-kernels.js,
   использование — Net в presets.js. Грузится раньше presets.js (где LS), поэтому свои обёртки gwLs (gateways.js). */

const Px={
  // старая строка «CORS proxy» (шаблон или «@имя») при первом чтении становится записью списка
  list(){
    let raw=gwLs.get('dsp-proxies');
    if(raw===null){ const m=pxMigrate(gwLs.get('dsp-proxy')); if(m.list.length){ gwLs.set('dsp-proxies',JSON.stringify(m.list)); gwLs.set('dsp-proxy',m.def); } raw=JSON.stringify(m.list); }
    try{ return pxClean(JSON.parse(raw)); }catch(e){ return []; } },
  def(){ const v=(gwLs.get('dsp-proxy')||'').trim(), e=pxFind(this.list(),v); return e ? e.name : ''; },
  save(list,def){ list=pxClean(list); gwLs.set('dsp-proxies',JSON.stringify(list)); gwLs.set('dsp-proxy',pxFind(list,def) ? pxFind(list,def).name : ''); window.dispatchEvent(new Event('px-changed')); },
  // проверка: один запрос через прокси → {ok,text}
  async test(e){
    const tpl=pxTemplate(e,Gw.list(),Gw.tokens()); if(!tpl) return {ok:false,text:pxProblem(e,Gw.list(),typeof Cred!=='undefined' ? Cred.list() : []) || 'not configured'};
    const ac=new AbortController(), t=setTimeout(()=>ac.abort(),8000);
    try{ const r=await fetch(pxApply(tpl,'https://example.com/'),{signal:ac.signal,cache:'no-store'}); return {ok:r.ok,text:'HTTP '+r.status+(r.ok ? ' — the proxy answers' : r.status===401 ? ' — token?' : r.status===403 ? ' — refused (origin, host list?)' : '')}; }
    catch(x){ return {ok:false,text:x.name==='AbortError' ? 'no answer in 8 s' : 'cannot reach it (address, port, firewall, https page → http proxy?)'}; }
    finally{ clearTimeout(t); } },
};

(()=>{
  const box=document.getElementById('pxBox'); if(!box) return;
  const listEl=box.querySelector('.pxList'), defSel=document.getElementById('proxy'), mk=(tag,cls,txt)=>{ const e=document.createElement(tag); if(cls) e.className=cls; if(txt!=null) e.textContent=txt; return e; };
  const TYPE_TEXT={cors:'CORS proxy (nginx, Worker…)',bridge:'bridge (Android / Node)',socks:'SOCKS / HTTP proxy (through a bridge)'};
  let rows=[], def='';
  const load=()=>{ rows=Px.list(); def=Px.def(); };
  const store=()=>Px.save(rows,def);
  const option=(sel,v,t)=>{ const o=mk('option',null,t); o.value=v; sel.append(o); };
  function fillDef(){
    defSel.textContent=''; option(defSel,'','none — nodes go direct');
    for(const p of rows) if(p.name) option(defSel,p.name,p.name+'  ·  '+p.type);
    defSel.value=def;
  }
  function draw(){
    listEl.textContent=''; const devs=Gw.list(), creds=typeof Cred!=='undefined' ? Cred.list().filter(c=>c.type==='proxy') : [];
    rows.forEach((r,i)=>{
      const card=mk('div','gwRow'), top=mk('div','gwTop'), res=mk('div','gwRes');
      const name=mk('input'); name.value=r.name; name.placeholder='name'; name.maxLength=24; name.title='the name a node takes in its «proxy» field';
      const type=mk('select'); for(const t of PX_TYPES) option(type,t,TYPE_TEXT[t]); type.value=r.type;
      const test=mk('button',null,'Test'), del=mk('button',null,'✕'); del.title='remove'; test.title='one request through this proxy';
      const say=()=>{ const p=pxProblem(r,devs,creds); res.textContent=p ? '⚠ '+p : ''; };
      name.onchange=()=>{ const v=name.value.trim(), was=r.name; if(!pxNameOk(v) || rows.some(x=>x!==r && x.name.toLowerCase()===v.toLowerCase())){ res.textContent='⚠ the name: letters, digits, _ . - (up to 24), not auto / off, not used yet'; name.value=was; return; } if(def===was) def=v; r.name=v; store(); fillDef(); };
      type.onchange=()=>{ r.type=type.value; if(r.type==='cors') delete r.dev; else delete r.url; if(r.type!=='socks') delete r.cred; store(); draw(); fillDef(); };
      del.onclick=()=>{ if(def===r.name) def=''; rows.splice(i,1); store(); draw(); fillDef(); };
      test.onclick=async()=>{ res.textContent='…'; const x=await Px.test(r); res.textContent=(x.ok ? '✓ ' : '⚠ ')+x.text; };
      top.append(name,type,test,del); card.append(top);
      if(r.type==='cors'){
        const url=mk('input'); url.value=r.url||''; url.placeholder='https://proxy.example/?url={url}'; url.spellcheck=false; url.title='«{url}» is replaced by the encoded address; without it the address is appended as is';
        url.onchange=()=>{ r.url=url.value.trim(); store(); say(); }; card.append(url);
      } else {
        const dev=mk('select'); option(dev,'','— bridge from Devices —');
        for(const d of devs) option(dev,d.name,'@'+d.name+'  '+d.url.replace(/^wss?:\/\//,'').replace(/[?#].*$/,''));
        if(r.dev && !devs.some(d=>d.name.toLowerCase()===String(r.dev).replace(/^@/,'').toLowerCase())) option(dev,r.dev,r.dev+' ?');
        dev.value=String(r.dev||'').replace(/^@/,''); if(dev.value!==String(r.dev||'').replace(/^@/,'')) dev.value=r.dev||'';
        dev.onchange=()=>{ r.dev=dev.value; store(); say(); }; card.append(dev);
        if(r.type==='socks'){
          const cr=mk('select'); option(cr,'','— proxy credential —');
          for(const c of creds) option(cr,c.name,'proxy: '+c.name+'  ·  '+c.server);
          if(r.cred && !creds.some(c=>c.name===r.cred)) option(cr,r.cred,r.cred+' ?');
          cr.value=r.cred||''; cr.onchange=()=>{ r.cred=cr.value; store(); say(); }; cr.title='a credential of type «proxy» (Credentials): socks5://… or http://…';
          card.append(cr);
        }
      }
      card.append(res); say(); listEl.append(card);
    });
    if(!rows.length) listEl.append(mk('p',null,'No proxies yet. Add one: a CORS proxy of your own, a bridge from Devices, or a SOCKS proxy that a bridge opens.'));
  }
  box.querySelector('.pxAdd').onclick=()=>{ let k=rows.length+1; while(rows.some(r=>r.name==='proxy'+k)) k++; rows.push({name:'proxy'+k,type:'cors',url:''}); if(!def) def='proxy'+k; store(); draw(); fillDef(); };
  defSel.onchange=()=>{ def=defSel.value; store(); };
  load(); draw(); fillDef();
  const redraw=()=>{ load(); draw(); fillDef(); };
  window.addEventListener('gw-changed',redraw); window.addEventListener('cred-changed',redraw);          // устройства / учётки изменились — выбор обновится
  if(window.DspApp){ box.hidden=true; defSel.closest('label').hidden=true; }                         // в приложении Android прокси не нужен (см. presets.js, Net)
})();
