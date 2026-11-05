"use strict";
/* ============================ Учётки (Credentials): хранилище и окно в Settings ============================
   Cred.get('почта') → {name,type,server,user,pass,smtp}. Список — LS 'dsp-creds' (как токены устройств 'dsp.gwtok': не входит в бэкап
   и не светится в патчах — пароли живут только в этом браузере). Логика — creds-kernels.js. */

const CR_KEY='dsp-creds';
// грузится раньше presets.js (где LS): узлы из автосохранения стартуют сразу и должны видеть список учёток
const crLs={ get(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }, set(k,v){ try{ localStorage.setItem(k,v); }catch(e){} } };
const Cred={
  list(){ try{ return crClean(JSON.parse(crLs.get(CR_KEY)||'[]')); }catch(e){ return []; } },
  save(list){ crLs.set(CR_KEY,JSON.stringify(crClean(list))); Cred.names(); },
  get(name){ return crFind(this.list(),name); },
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

// Выбор учётки в параметре узла (cred:true): список + «✎» правка на месте + форма «＋ new…» (создать, править, удалить, зарегистрировать).
// Тип по умолчанию — протокол узла (xmpp → xmpp, а не email); где сервер это позволяет (xmpp, matrix), учётку можно создать на нём тут же:
// галка «register» включает n.regNext, и при Connect узел сначала регистрирует, потом входит (msgr-session.js).
function crPickEl(n,s){
  const mk=(tag,cls,txt)=>{ const e=document.createElement(tag); if(cls) e.className=cls; if(txt!=null) e.textContent=txt; return e; };
  const NONE='\u0000none', NEW='\u0000new';
  const box=mk('div','credpick'), top=mk('div','cr-top'), sel=mk('select'), edit=mk('button','cr-edit','✎'), form=mk('div','credform');
  form.hidden=true; edit.type='button'; edit.title='edit this account here';
  const fType=mk('select'); for(const x of CR_TYPES){ const o=mk('option',null,x); o.value=x; fType.append(o); }
  const inp=(ph,type)=>{ const i=mk('input'); i.type=type||'text'; i.placeholder=ph||''; i.spellcheck=false; i.autocomplete='off'; i.addEventListener('keydown',e=>e.stopPropagation()); return i; };
  const fName=inp('name'), fSrv=inp(''), fUser=inp(''), fPass=inp('','text'), fSmtp=inp('smtps://smtp.example.org:465');
  fName.maxLength=24; fPass.className='gwTok'; fPass.name='dsp-credential-password'; fPass.setAttribute('data-lpignore','true'); fPass.setAttribute('data-1p-ignore','true');
  const fReg=mk('input'); fReg.type='checkbox';
  const regRow=mk('label','cr-wide cr-reg'); regRow.append(fReg,mk('span',null,' create this account on the server when connecting (open registration; with e-mail or captcha — register on its website first)'));
  const res=mk('div','cr-wide cr-res'), save=mk('button','credsave','Save'), cancel=mk('button',null,'Cancel'), del=mk('button','cr-del','Delete');
  save.type=cancel.type=del.type='button';
  const btns=mk('div','cr-wide cr-btns'); btns.append(del,cancel,save);
  const row=(lab,el)=>{ const l=mk('label',null,lab); return [l,el]; };
  const smtpL=mk('label',null,'SMTP');
  form.append(...row('type',fType),...row('name',fName),...row('server',fSrv),...row('login',fUser),...row('password',fPass),smtpL,fSmtp,regRow,res,btns);
  let editing=null;                                                   // имя правимой учётки; null — новая
  const hints=()=>{
    const t=fType.value, ex=CR_EXAMPLE[t]||CR_EXAMPLE.custom, h=CR_HINT[t]||CR_HINT.custom;
    fSrv.placeholder=ex.server ? ex.server : 'empty';
    fUser.placeholder=h.user; fPass.placeholder=h.pass;
    smtpL.hidden=fSmtp.hidden=t!=='email'; if(t==='email') fSmtp.placeholder=ex.smtp||'smtps://smtp.example.org:465';
    regRow.hidden=!(CR_REGISTER.includes(t) && !editing);
  };
  fType.addEventListener('change',hints);
  const close=()=>{ form.hidden=true; editing=null; res.textContent=''; };
  const open=rec=>{
    editing=rec ? rec.name : null;
    fType.value=rec ? (CR_TYPES.includes(rec.type) ? rec.type : 'custom') : crTypeFor(s.credType,n.p.proto);
    fName.value=rec ? rec.name : crFreeName(Cred.list(),fType.value); fName.readOnly=!!rec; fName.title=rec ? 'the name is what nodes refer to; to rename, make a new account' : '';
    fSrv.value=rec ? rec.server : ''; fUser.value=rec ? rec.user : ''; fPass.value=rec ? rec.pass : ''; fSmtp.value=rec ? rec.smtp : ''; fReg.checked=false;
    del.hidden=!rec; res.textContent=''; hints(); form.hidden=false;
    fSrv.focus();
  };
  save.addEventListener('click',e=>{ e.stopPropagation();
    const rec={name:fName.value.trim(),type:fType.value,server:fSrv.value.trim(),user:fUser.value.trim(),pass:fPass.value,smtp:fSmtp.value.trim()};
    if(!CR_NAME.test(rec.name)){ res.textContent='⚠ the name: letters, digits, _ . - (up to 24)'; return; }
    if(!rec.server && !rec.user && !rec.pass){ res.textContent='⚠ fill at least a server, a login or a password'; return; }
    if(!editing && crFind(Cred.list(),rec.name)){ res.textContent='⚠ an account «'+rec.name+'» already exists — pick it in the list and press ✎'; return; }
    if(fReg.checked && !editing){
      if(!rec.user || !rec.pass){ res.textContent='⚠ to register, fill the login and the password: they become the new account'; return; }
      n.regNext=true; n.status='account saved — press Connect: it is created on the server first, then the node logs in';
    }
    Cred.upsert(rec); n.p[s.n]=rec.name; close(); s.fn && s.fn(n); render(); });
  cancel.addEventListener('click',e=>{ e.stopPropagation(); close(); render(); });
  del.addEventListener('click',e=>{ e.stopPropagation(); if(!editing || !confirm('Delete the account «'+editing+'» from this browser? Nodes that use it will have no login.')) return;
    const gone=editing; Cred.save(Cred.list().filter(c=>c.name!==gone)); if(n.p[s.n]===gone) n.p[s.n]=''; close(); s.fn && s.fn(n); render(); });
  edit.addEventListener('click',e=>{ e.stopPropagation(); const c=crFind(Cred.list(),n.p[s.n]); if(c) open(c); });
  const render=()=>{
    const v=String(n.p[s.n]??''), list=Cred.list().filter(c=>s.credType ? c.type===s.credType : c.type!=='proxy'), hit=v && crFind(list,v);
    sel.textContent='';
    const add=(val,txt)=>{ const o=mk('option',null,txt); o.value=val; sel.append(o); };
    add(NONE,'— (params below)');
    for(const c of list) add(c.name,c.name+'  ·  '+(c.server||c.user||'no server'));
    if(v && !hit) add(v,v+' ?');
    add(NEW,'＋ new…');
    sel.value=form.hidden ? (hit ? hit.name : NONE) : (editing ? (hit ? hit.name : NONE) : NEW);
    edit.hidden=!hit || !form.hidden;
  };
  sel.addEventListener('change',()=>{
    if(sel.value===NEW){ open(null); return; }
    close(); n.p[s.n]=sel.value===NONE ? '' : sel.value; s.fn && s.fn(n); render(); });
  render();
  (n.set||(n.set={}))[s.n]=v=>{ if(v!=null) n.p[s.n]=v; render(); };
  box._render=render;
  const wr=new WeakRef(box), h=()=>{ const b=wr.deref(); if(!b) window.removeEventListener('cred-changed',h); else if(form.hidden) b._render(); };
  window.addEventListener('cred-changed',h);                         // список учёток изменили в Settings — выбор в открытых узлах обновляется
  top.append(sel,edit); box.append(top);
  return {box,form};                                                 // форма — отдельным элементом строки: на всю ширину узла, под списком
}
