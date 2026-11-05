"use strict";
/* ============================ Учётки (Credentials): хранилище и окно в Settings ============================
   Cred.get('почта') → {name,user,pass}. Список — LS 'dsp-creds' (как токены устройств 'dsp.gwtok': не входит в бэкап
   и не светится в патчах — пароли живут только в этом браузере). Логика — creds-kernels.js. */

const CR_KEY='dsp-creds';
// грузится раньше presets.js (где LS): узлы из автосохранения стартуют сразу и должны видеть список учёток
const crLs={ get(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }, set(k,v){ try{ localStorage.setItem(k,v); }catch(e){} } };
const Cred={
  list(){ try{ return crClean(JSON.parse(crLs.get(CR_KEY)||'[]')); }catch(e){ return []; } },
  save(list){ crLs.set(CR_KEY,JSON.stringify(crClean(list))); Cred.names(); },
  get(name){ const c=crFind(this.list(),name); return c ? {name:c.name,user:c.user,pass:c.pass} : null; },
  upsert(rec){                                                     // добавить или обновить поля учётки с таким именем
    const list=this.list(), i=list.findIndex(c=>c.name.toLowerCase()===String(rec.name||'').trim().toLowerCase());
    if(i>=0) list[i]={...list[i],...rec}; else list.push(rec);
    this.save(list);
  },
  names(){                                                           // подсказки для полей «account»
    let dl=document.getElementById('crNames'); if(!dl){ dl=document.createElement('datalist'); dl.id='crNames'; document.body.append(dl); }
    dl.textContent=''; for(const c of this.list()){ const o=document.createElement('option'); o.value=c.name; dl.append(o); }
    window.dispatchEvent(new Event('cred-changed'));                 // открытые параметры с dev:true перерисуются
  },
};

// окно «Credentials» в панели настроек (стили — общие с Devices: #crBox в селекторах styles.css)
(()=>{
  const box=document.getElementById('crBox'); if(!box) return;
  const listEl=box.querySelector('.crList'), mk=(tag,cls,txt)=>{ const e=document.createElement(tag); if(cls) e.className=cls; if(txt!=null) e.textContent=txt; return e; };
  let rows=[];                                                       // [{name,user,pass}]
  const load=()=>{ rows=Cred.list().map(c=>({...c})); };
  const store=()=>Cred.save(rows);
  function draw(){
    listEl.textContent='';
    rows.forEach((r,i)=>{
      const card=mk('div','gwRow'), top=mk('div','gwTop');
      const name=mk('input'); name.value=r.name; name.placeholder='name'; name.title='the name nodes use in «account»'; name.maxLength=24;
      const del=mk('button',null,'✕'); del.title='remove';
      const type=mk('select','crType');
      for(const t of CR_TYPES){ const o=document.createElement('option'); o.value=o.textContent=t; type.append(o); }
      type.value=CR_TYPES.includes(r.type)?r.type:'custom';
      const user=mk('input'); user.value=r.user; user.placeholder='login / user'; user.spellcheck=false; user.autocomplete='off';
      const pass=mk('input'); pass.type='text'; pass.className='gwTok'; pass.name='dsp-credential-password'; pass.setAttribute('data-lpignore','true'); pass.setAttribute('data-1p-ignore','true'); pass.value=r.pass; pass.placeholder='password / token'; pass.autocomplete='off'; pass.spellcheck=false;
      const srv=mk('input'); srv.value=r.server; srv.spellcheck=false; srv.autocomplete='off';
      const smtp=mk('input'); smtp.value=r.smtp; smtp.spellcheck=false; smtp.autocomplete='off';
      const hint=()=>{ const ex=CR_EXAMPLE[type.value]||CR_EXAMPLE.custom;                    // пример под выбранный тип
        srv.placeholder=ex.server ? 'server — '+ex.server : 'server — empty (the token goes to password)';
        smtp.hidden=type.value!=='email';
        if(type.value==='email') smtp.placeholder='SMTP — '+(ex.smtp||'smtps://smtp.example.org:465'); };
      const res=mk('div','gwRes');
      name.onchange=()=>{ r.name=name.value.trim(); if(!CR_NAME.test(r.name)){ res.textContent='⚠ the name: letters, digits, _ . - (up to 24)'; return; } res.textContent=''; store(); };
      user.onchange=()=>{ r.user=user.value.trim(); store(); };
      pass.onchange=()=>{ r.pass=pass.value; store(); };
      srv.onchange=()=>{ r.server=srv.value.trim(); store(); };
      smtp.onchange=()=>{ r.smtp=smtp.value.trim(); store(); };
      type.onchange=()=>{ r.type=type.value; hint(); store(); };
      del.onclick=()=>{ rows.splice(i,1); store(); draw(); };
      top.append(name,type,del); card.append(top,srv,user,pass,smtp,res); hint(); listEl.append(card);
    });
    if(!rows.length) listEl.append(mk('p',null,'No accounts yet. Add a server + login once — Messenger and other nodes take it by name in «account» (the server, user and password are filled), the secrets stay in this browser (not in patches, shares or backups).'));
  }
  box.querySelector('.crAdd').onclick=()=>{ let k=rows.length+1; while(rows.some(r=>r.name==='acct'+k)) k++; rows.push({name:'acct'+k,user:'',pass:''}); store(); draw(); };
  load(); draw(); Cred.names();
})();
