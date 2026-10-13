"use strict";
/* ============================ КАТАЛОГ ПУБЛИЧНЫХ SDR НА КАРТЕ ============================
   Список KiwiSDR / SpyServer (по URL через CORS-прокси из настроек или из файла) → записи для узла Map.
   Клик по точке (sel карты → select) выбирает приёмник; выход server идёт на вход server модуля KiwiSDR. */

const SDRDIR_URLS={
  kiwisdr:'https://rx.linkfanel.net/kiwisdr_com.js',
  spyserver:'https://airspy.com/directory/status.json'
};

function sdrdirLoadText(n,text,src){
  try{
    const list=sdParse(text,n.p.kind);
    if(!list.length) throw new Error('no receivers with coordinates found');
    n.list=list; n.src=src; n.msg=''; n.key='';
    geoPut('sdrdir-'+n.p.kind,{list,src}).catch(e=>{ n.msg='not saved: '+e.message; });
  }catch(e){ n.msg='error: '+e.message; }
}
async function sdrdirDownload(n){
  const url=String(n.p.url||'').trim() || SDRDIR_URLS[n.p.kind];
  n.msg='downloading…';
  try{
    const r=await fetch(Net.url(url)); if(!r.ok) throw new Error('HTTP '+r.status);
    sdrdirLoadText(n,await r.text(),url.replace(/^https?:\/\//,'').split('/')[0]);
  }catch(e){ n.msg='download failed: '+e.message+' — the site may block cross-origin requests: set a CORS proxy in Settings or load the file'; }
}
function sdrdirRestore(n){
  geoGet('sdrdir-'+n.p.kind).then(v=>{ if(v && v.list && n.p.kind===n.kindLoaded){ n.list=v.list; n.src=v.src; n.key=''; } }).catch(()=>{});
}

def({ id:'sdrdir', title:'SDR Receivers Directory', cat:'Geo', kw:'kiwisdr spyserver websdr remote receivers map list directory',
  ins:[{n:'select',t:'rec'}],                          // клик на карте (выход sel)
  outs:[{n:'rows',t:'bands'},{n:'server',t:'txt'},{n:'name',t:'txt'},{n:'count',t:'num'}], readout:true,
  params:[{n:'kind',t:'select',opts:['kiwisdr','spyserver'],d:'kiwisdr',label:'receivers',
           fn:n=>{ n.list=[]; n.src=''; n.key=''; n.kindLoaded=n.p.kind; sdrdirRestore(n); }},
          {n:'free',t:'check',d:false,label:'only with free slots'},
          {n:'q',t:'text',d:'',label:'filter: name / place / host'},
          {n:'file',t:'file',accept:'.json,.js,.html,.txt,application/json,text/html,text/plain',label:'Load list from file',
           fn:(n,f)=>{ const rd=new FileReader(); rd.onload=()=>sdrdirLoadText(n,String(rd.result),f.name); rd.readAsText(f); }},
          {n:'dl',t:'button',label:'Download list',fn:n=>sdrdirDownload(n)},
          {n:'url',t:'text',d:'',label:'list URL (empty — default for the chosen kind)',adv:true},
          {n:'clr',t:'button',label:'Forget list',fn:n=>{ n.list=[]; n.src=''; n.key=''; geoPut('sdrdir-'+n.p.kind,null).catch(()=>{}); },adv:true}],
  init:n=>{ n.list=[]; n.src=''; n.msg=''; n.key=''; n.rowsOut=null; n.sel=null; n.shown=0; n.kindLoaded=n.p.kind; sdrdirRestore(n); },
  process(n,I){
    for(const r of recList(I.select)){
      const id=String(r.id||'').replace(/^n:/,'');
      const x=n.list.find(e=>'sdr:'+e.id===id); if(x) n.sel=x;
    }
    const key=[n.list.length,n.src,n.p.kind,n.p.free,n.p.q,n.sel&&n.sel.id].join('|');
    if(key!==n.key){
      n.key=key;
      const f=sdFilter(n.list,{free:n.p.free,q:n.p.q});
      n.shown=f.length;
      n.rowsOut=f.map(r=>({...r, id:'sdr:'+r.id, icon:'◉', size:r===n.sel ? 10 : 6, ...(r===n.sel?{color:'#ffd84a'}:{})}));
    }
    return {rows:n.rowsOut, server:n.sel?n.sel.server:null, name:n.sel?n.sel.name:null, count:n.shown};
  },
  draw(n){
    const r=n.el.querySelector('.readout'); if(!r) return;
    r.textContent=(n.msg ? n.msg+'\n' : '')+(n.list.length ? n.src+' · '+n.list.length+' receivers · shown '+n.shown+'\n' : '')+
      (n.sel ? '▶ '+n.sel.name+'\n  '+n.sel.server+(n.sel.users!=null?' · users '+n.sel.users+(n.sel.usersMax!=null?'/'+n.sel.usersMax:''):'')+'\n' : '')+(n.list.length?'':'download the list or load a file (JSON from the directory, or the kiwisdr.com/public page saved as HTML)');
  }});
