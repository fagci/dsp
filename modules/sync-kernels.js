"use strict";
/* ============================ Ядро синхронизации устройств ============================
   Без DOM и сети: хэш и ключ пары, план слияния двух манифестов, протокол обмена поверх упорядоченного канала.
   Запись = id вида «вид:uid» (f — файл, t — запись Table, m — колонки списка) + время правки m + метка удаления d.
   Побеждает более поздняя правка; удаление побеждает правку, сделанную до него. Хранилище подаётся адаптером
   {manifest(), get(id), apply(head,blob), del(id,t)}. Проверяется tools/test-sync.mjs. */

const SY_CHUNK=16384, SY_BATCH=1500;

function syHash(s){                                    // cyrb53, 53 бита в base36
  let h1=0xdeadbeef, h2=0x41c6ce57;
  for(let i=0;i<s.length;i++){ const c=s.charCodeAt(i); h1=Math.imul(h1^c,2654435761); h2=Math.imul(h2^c,1597334677); }
  h1=Math.imul(h1^(h1>>>16),2246822507)^Math.imul(h2^(h2>>>13),3266489909);
  h2=Math.imul(h2^(h2>>>16),2246822507)^Math.imul(h1^(h1>>>13),3266489909);
  return (4294967296*(2097151&h2)+(h1>>>0)).toString(36);
}
// uid записи без метки: по содержимому, поэтому одинаковые записи на двух устройствах получают один uid
const syLegacyUid=(...parts)=>'c'+syHash(parts.join('\u0001'));
const syUid=()=>[...crypto.getRandomValues(new Uint8Array(8))].map(b=>b.toString(16).padStart(2,'0')).join('');

// ключ пары: 128 бит, base32 без похожих знаков, группами
const SY_ALPHA='0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function syKeyGen(){
  const b=crypto.getRandomValues(new Uint8Array(16)); let bits=0, n=0, s='';
  for(const x of b){ bits=(bits<<8)|x; n+=8; while(n>=5){ s+=SY_ALPHA[(bits>>>(n-5))&31]; n-=5; } bits&=(1<<n)-1; }
  if(n) s+=SY_ALPHA[(bits<<(5-n))&31];
  return s.match(/.{1,5}/g).join('-');
}
function syKeyNorm(s){
  const k=String(s||'').toUpperCase().replace(/O/g,'0').replace(/[IL]/g,'1').replace(/[^0-9A-Z]/g,'');
  return k.length===26 && [...k].every(c=>SY_ALPHA.includes(c)) ? k.match(/.{1,5}/g).join('-') : null;
}

// local, remote: Map id → {m,d,s}. Что забрать у соседа и что удалить у себя
function syPlan(local,remote,maxBytes=Infinity){
  const want=[], del=[]; let skipped=0;
  for(const [id,r] of remote){
    const l=local.get(id);
    if(r.d){                                           // у соседа удалено
      if(l && !l.d && r.d>l.m) del.push([id,r.d]);
      continue;
    }
    if(l && l.d && l.d>=r.m) continue;                 // у нас удалено позже его правки: он удалит сам
    if(!l || l.d || r.m>l.m){
      if(r.s>maxBytes) skipped++; else want.push(id);
    }
  }
  return {want,del,skipped};
}

class SySession{
  // send(x) — строка или ArrayBuffer, промис завершается, когда канал готов принять следующее
  constructor(store,send,o={}){
    this.st=store; this.send=send; this.maxBytes=o.maxBytes||Infinity; this.on=o.on||(()=>{});
    this.round=''; this.rman=null; this.rx=null; this.inflight=new Set();
    this.q=Promise.resolve(); this.sq=Promise.resolve();
    this.stat={pending:0,got:0,deleted:0,skipped:0,errors:0,rounds:0,bytes:0};
  }
  async start(){ this.round=Math.random().toString(36).slice(2,8); this.stat.rounds++; await this.sendMan(this.round); }
  async sendMan(r){
    const all=[...await this.st.manifest()];
    for(let i=0;i<all.length || i===0;i+=SY_BATCH)
      await this.send(JSON.stringify({t:'man',r,i,last:i+SY_BATCH>=all.length,items:all.slice(i,i+SY_BATCH).map(([id,e])=>[id,e.m,e.d||0,e.s||0])}));
  }
  onMessage(data){ return this.q=this.q.then(()=>this.handle(data)).catch(e=>{ this.stat.errors++; this.on(this.stat,e); }); }
  async handle(data){
    if(typeof data!=='string'){ if(this.rx){ this.rx.parts.push(data); this.stat.bytes+=data.byteLength; } return; }
    const m=JSON.parse(data);
    if(m.t==='man'){
      if(m.i===0 || !this.rman || this.rman.r!==m.r) this.rman={r:m.r,items:new Map()};
      for(const [id,mm,d,s] of m.items) this.rman.items.set(id,{m:mm,d,s});
      if(!m.last) return;
      const rem=this.rman; this.rman=null;
      if(this.round!==m.r){ this.round=m.r; await this.sendMan(m.r); }       // ответный манифест
      const plan=syPlan(await this.st.manifest(),rem.items,this.maxBytes);
      for(const [id,t] of plan.del){ await this.st.del(id,t); this.stat.deleted++; }
      this.stat.skipped+=plan.skipped;
      const want=plan.want.filter(id=>!this.inflight.has(id));
      for(const id of want) this.inflight.add(id);
      this.stat.pending+=want.length;
      for(let i=0;i<want.length;i+=SY_BATCH) await this.send(JSON.stringify({t:'want',ids:want.slice(i,i+SY_BATCH)}));
      this.on(this.stat);
    } else if(m.t==='want'){
      this.sq=this.sq.then(()=>this.serve(m.ids)).catch(()=>{});
    } else if(m.t==='item'){
      this.rx={id:m.id,head:m.head,parts:[]};
    } else if(m.t==='end'){
      const rx=this.rx; this.rx=null; if(!rx) return;
      try{ await this.st.apply(rx.head,rx.parts.length ? new Blob(rx.parts) : null); this.stat.got++; }
      catch(e){ this.stat.errors++; }
      this.settle(rx.id);
    } else if(m.t==='miss'){
      this.settle(m.id);
    }
  }
  settle(id){ if(this.inflight.delete(id)) this.stat.pending--; this.on(this.stat); }
  async serve(ids){
    for(const id of ids){
      const it=await this.st.get(id);
      if(!it){ await this.send(JSON.stringify({t:'miss',id})); continue; }
      await this.send(JSON.stringify({t:'item',id,head:it.head}));
      if(it.blob) for(let o=0;o<it.blob.size;o+=SY_CHUNK) await this.send(await it.blob.slice(o,o+SY_CHUNK).arrayBuffer());
      await this.send(JSON.stringify({t:'end',id}));
    }
  }
}
