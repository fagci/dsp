"use strict";
/* ============================ Contacts: узел ============================
   Контакты — две таблицы Table (contacts/people и contacts/identities, связь identity.contact → people), логика — contacts-kernels.js.
   Узел: импорт vCard (файл .vcf или текст на вход), контакты телефона (Phone Actions → rec), «узнаёт» собеседников по входящим
   сообщениям Messenger (rec), ищет и сливает дубли; на выходе book — адресная книга для Messenger и Chat (rows). */

const CT_LISTS={people:'contacts/people',idents:'contacts/identities'};
const CT_PROTOS=['phone','email','telegram','matrix','xmpp','irc','nostr','ntfy','aprs','reticulum','bluesky','mastodon'];
const CT_TYPES={
  people:{photo:{t:'photo'},birthday:{t:'date'},note:{t:'long'}},
  idents:{proto:{t:'choice',opts:CT_PROTOS},contact:{t:'link',to:CT_LISTS.people,multi:false},seen:{t:'date'}},
};

async function ctEnsure(n){
  const have=await ListDB.listNames();
  const people=n.p.people||CT_LISTS.people, idents=n.p.idents||CT_LISTS.idents;
  if(!have.includes(people)) await ListDB.setMeta(people,{cols:CT_PEOPLE_COLS.slice(),types:{...CT_TYPES.people}});
  if(!have.includes(idents)) await ListDB.setMeta(idents,{cols:CT_IDENT_COLS.slice(),types:{...CT_TYPES.idents,contact:{t:'link',to:people,multi:false}}});
  return {people,idents};
}
const ctRow=it=>({name:it.name,...(it.fields||{})});
async function ctRead(name){ const items=await ListDB.list(name); return items.map(it=>({id:it.id,row:ctRow(it)})); }
const ctItem=(row,cols)=>{ const f={}; for(const k of cols) if(k!=='name') f[k]=row[k]??''; return {name:String(row.name??''),fields:f}; };
const ctToday=()=>new Date().toISOString().slice(0,10);

// всё прочитанное и записанное — через очередь: два импорта подряд не должны читать список до записи первого
function ctQueue(n,fn){
  n.q=(n.q||Promise.resolve()).then(fn).catch(e=>{ n.status='error: '+(e&&e.message||e); });
  return n.q;
}
async function ctImportCards(n,cards){
  const L=await ctEnsure(n);
  const idents=await ctRead(L.idents);
  const E=(await ctRead(L.people)).map(p=>({id:p.id,row:p.row,dirty:false,isNew:false}));      // записи в памяти: старые и новые вперемешку
  const newI=[], known=new Set(idents.map(x=>ctStr(x.row.key)||ctKey(x.row.proto,x.row.addr)));
  let added=0, merged=0;
  for(const c of cards){
    const found=ctFindPerson(E.map(e=>e.row),c);
    let who;
    if(found){                                                  // уже есть (по телефону / почте): дополняем поля, не дублируем
      const e=E.find(x=>ctStr(x.row.name)===found), m=ctMergeTwo(e.row,ctPersonRow(c));
      if(JSON.stringify(m)!==JSON.stringify(e.row)){ e.row=m; if(!e.isNew){ e.dirty=true; merged++; } }
      who=found;
    } else {
      const row=ctPersonRow(c); row.name=ctUniqueName(new Set(E.map(e=>ctStr(e.row.name))),row.name,'vcard');
      E.push({id:null,row,dirty:false,isNew:true}); added++; who=row.name;
    }
    for(const r of ctIdentRows({...c,name:who})) if(!known.has(r.key)){ known.add(r.key); newI.push(r); }
  }
  for(const e of E) if(e.dirty){ const it=ctItem(e.row,CT_PEOPLE_COLS); await ListDB.update(e.id,{name:it.name,fields:it.fields,value:''}); }
  const newP=E.filter(e=>e.isNew).map(e=>ctItem(e.row,CT_PEOPLE_COLS));
  if(newP.length) await ListDB.addMany(L.people,newP);
  if(newI.length) await ListDB.addMany(L.idents,newI.map(r=>ctItem(r,CT_IDENT_COLS)));
  n.book=null;
  return {added,merged,idents:newI.length};
}
// собеседники из сообщений: неизвестный адрес → новый человек с этим адресом (имя уникально; по имени люди не сливаются)
async function ctLearn(n,recs){
  const L=await ctEnsure(n);
  const idents=await ctRead(L.idents), people=await ctRead(L.people);
  const known=new Set(idents.map(x=>ctStr(x.row.key)||ctKey(x.row.proto,x.row.addr)));
  const names=new Set(people.map(p=>ctStr(p.row.name))), newP=[], newI=[];
  const who_=[];                                                       // отправители сообщений и люди из ростеров — одним списком
  for(const r of recs){ if(r&&r.kind==='roster') who_.push(...ctFromRoster(r)); else { const w=ctFromRec(r); if(w) who_.push(w); } }
  for(const w of who_){
    if(known.has(w.key)) continue;
    known.add(w.key);
    const who=ctUniqueName(names,w.name,w.proto); names.add(who);                // каждый новый адрес — отдельный человек; сливать — только по общему телефону / адресу кнопкой
    newP.push(ctItem({name:who,note:'from '+w.proto},CT_PEOPLE_COLS));
    newI.push(ctItem({proto:w.proto,addr:w.addr,name:w.name,contact:who,seen:ctToday(),key:w.key},CT_IDENT_COLS));
  }
  if(newP.length) await ListDB.addMany(L.people,newP);
  if(newI.length){ await ListDB.addMany(L.idents,newI); n.book=null; n.learned=(n.learned||0)+newI.length; }
  return newI.length;
}
async function ctDupes(n,doMerge){
  const L=await ctEnsure(n);
  const people=await ctRead(L.people), idents=await ctRead(L.idents);
  const P=people.map(p=>p.row), I=idents.map(i=>i.row);
  const groups=ctDupGroups(P,I);
  if(!doMerge) return {groups};
  let n_=0;
  for(const g of groups){
    const plan=ctMergePlan(P,I,g); if(!plan) continue;
    const t=people.find(p=>ctStr(p.row.name)===plan.target), it=ctItem(plan.person,CT_PEOPLE_COLS);
    await ListDB.update(t.id,{name:it.name,fields:it.fields,value:''});
    await ListDB.removeMany(people.filter(p=>plan.remove.includes(ctStr(p.row.name))).map(p=>p.id));
    for(const m of plan.idents){
      const old=idents.find(i=>(ctStr(i.row.key)||ctKey(i.row.proto,i.row.addr))===(ctStr(m.key)||ctKey(m.proto,m.addr)) && i.row.contact!==m.contact);
      if(old){ const x=ctItem(m,CT_IDENT_COLS); await ListDB.update(old.id,{name:x.name,fields:x.fields,value:''}); }
    }
    n_++;
  }
  n.book=null;
  return {groups,merged:n_};
}
async function ctRefreshBook(n){
  n.bookAt=Date.now();
  try{
    const L=await ctEnsure(n);
    const people=(await ctRead(L.people)).map(p=>p.row), idents=(await ctRead(L.idents)).map(p=>p.row);
    n.book=ctBook(people,idents); n.counts={people:people.length,idents:idents.length};
  }catch(e){ n.book=n.book||[]; n.status='error: '+(e&&e.message||e); }
}
function ctPickFile(cb){
  const inp=document.createElement('input'); inp.type='file'; inp.accept='.vcf,.vcard,text/vcard,text/x-vcard'; inp.multiple=true;
  inp.addEventListener('change',async()=>{ for(const f of inp.files) cb(await f.text(),f.name); });
  inp.click();
}
function ctImportText(n,text,label){
  return ctQueue(n,async()=>{
    const cards=ctVcardParse(text);
    if(!cards.length){ n.status=(label||'text')+': no vCards found'; return; }
    const r=await ctImportCards(n,cards);
    n.status=(label||'vCard')+': '+r.added+' new, '+r.merged+' completed, '+r.idents+' addresses';
  });
}

def({ id:'contacts', title:'Contacts (people · addresses in Tables)', cat:'Sources',
  kw:'contacts address book people phone vcard vcf import telegram email matrix merge duplicates identities messenger',
  ins:[{n:'rec',t:'rec'},{n:'vcf',t:'txt'}], outs:[{n:'book',t:'bands'},{n:'people',t:'num'},{n:'new',t:'num'}],
  readout:true,
  params:[
    {n:'people',t:'text',d:CT_LISTS.people,label:'Table list with people (name, phones, emails, org, birthday, tags, note, photo)',adv:true},
    {n:'idents',t:'text',d:CT_LISTS.idents,label:'Table list with addresses (proto, addr, name, contact → people)',adv:true},
    {n:'learn',t:'check',d:true,label:'learn people from incoming messages and rosters (rec ← Messenger; XMPP and Matrix contact lists): an unknown address becomes a new person'},
    {n:'imp',t:'button',label:'Import vCard…',fn:n=>ctPickFile((t,name)=>ctImportText(n,t,name))},
    {n:'dup',t:'button',label:'Find duplicates',fn:n=>ctQueue(n,async()=>{ const r=await ctDupes(n,false); n.status=r.groups.length ? r.groups.length+' duplicate group(s): '+r.groups.slice(0,5).map(g=>g.join(' = ')).join('; ') : 'no duplicates'; })},
    {n:'merge',t:'button',label:'Merge duplicates',fn:n=>ctQueue(n,async()=>{ const r=await ctDupes(n,true); n.status=r.merged ? 'merged '+r.merged+' group(s)' : 'no duplicates'; })},
    {n:'open',t:'button',label:'Create the lists',fn:n=>ctQueue(n,async()=>{ const L=await ctEnsure(n); n.status='lists ready: '+L.people+', '+L.idents+' — open them in a Table'; })},
  ],
  init:n=>{ n.q=null; n.book=null; n.bookAt=0; n.counts={people:0,idents:0}; n.status='ready'; n.lastRec=undefined; n.lastVcf=undefined; n.learned=0; n.busy=false; n.fresh=0; },
  process(n,I){
    if(I.rec!==undefined && I.rec!==n.lastRec){
      n.lastRec=I.rec;
      const recs=(Array.isArray(I.rec) ? I.rec : [I.rec]).filter(r=>r && typeof r==='object');
      const ph=recs.map(ctFromPhoneRec).filter(Boolean);
      if(ph.length) ctQueue(n,async()=>{ const r=await ctImportCards(n,ph); n.status='phone: '+r.added+' new, '+r.merged+' completed'; n.fresh+=r.added; });
      if(n.p.learn!==false && recs.length) ctQueue(n,async()=>{ const k=await ctLearn(n,recs); n.fresh+=k; if(k) n.status='learned '+k+' new address(es)'; });
    }
    if(typeof I.vcf==='string' && I.vcf!==n.lastVcf){ n.lastVcf=I.vcf; if(I.vcf.trim()) ctImportText(n,I.vcf,'input'); }
    if(!n.book || Date.now()-n.bookAt>5000){ if(!n.busy){ n.busy=true; ctRefreshBook(n).finally(()=>{ n.busy=false; }); } }
    const fresh=n.fresh; n.fresh=0;
    return {book:n.book||[],people:n.counts.people,new:fresh};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const t='people '+n.counts.people+' · addresses '+n.counts.idents+' · book '+(n.book?n.book.length:0)+'\n'+n.status;
    if(r.textContent!==t) r.textContent=t; }
});
