"use strict";
/* ============================ Передача файлов по любому упорядоченному каналу ============================
   Без DOM и сети. Канал — функция send(x) (x: строка или ArrayBuffer; промис завершается, когда можно слать дальше) и вызов
   onMessage(x) на приёме. Формат тот же, что у файлового канала узла WebRTC Data: строка JSON {t:'file',xid,name,mime,size,…}
   → куски ArrayBuffer → {t:'end',xid}; {t:'cancel',xid} с любой стороны. Лишние поля заголовка (например c — имя канала)
   доходят до приёмника как есть. Проверяется tools/test-xfer.mjs. */

const XF_CHUNK=16384;
class XferPort {
  // o.maxBytes — больше не принимаем; o.accept(meta) — false отклоняет файл; o.onFile(meta,blob) — файл получен; o.on() — состояние изменилось
  constructor(send,o={}){
    this.send=send; this.maxBytes=o.maxBytes||Infinity; this.accept=o.accept||(()=>true); this.onFile=o.onFile||(()=>{}); this.on=o.on||(()=>{});
    this.txQ=[]; this.tx=null; this.rx=null; this.dead=false;
    this.stat={sent:0,got:0,refused:0,prog:0,msg:''};
  }
  enqueue(blob,name,mime,extra){                       // extra — доп. поля заголовка
    if(this.dead) return false;
    this.txQ.push({xid:Math.random().toString(36).slice(2,10),blob,name,mime:mime||blob.type||'application/octet-stream',extra:extra||{}});
    this.pump(); return true;
  }
  say(m){ this.stat.msg=m; this.on(); }
  async pump(){
    if(this.tx || !this.txQ.length) return;
    const t=this.tx=this.txQ.shift();
    try{
      await this.send(JSON.stringify({...t.extra,t:'file',xid:t.xid,name:t.name,mime:t.mime,size:t.blob.size}));
      for(let off=0;off<t.blob.size && !t.cancel && !this.dead;off+=XF_CHUNK){
        await this.send(await t.blob.slice(off,off+XF_CHUNK).arrayBuffer());
        this.stat.prog=Math.min(1,(off+XF_CHUNK)/t.blob.size); this.say('sending '+t.name+' '+Math.round(this.stat.prog*100)+'%');
      }
      if(!t.cancel && !this.dead){ await this.send(JSON.stringify({t:'end',xid:t.xid})); this.stat.sent++; this.say('sent '+t.name); }
    }catch(e){ this.say('send failed: '+e.message); }
    this.stat.prog=0; if(this.tx===t) this.tx=null;
    if(!this.dead) this.pump();
  }
  onMessage(d){
    if(typeof d!=='string'){                           // кусок текущего приёма
      const r=this.rx; if(!r || r.skip) return;
      r.parts.push(d); r.got+=d.byteLength; this.stat.prog=r.size ? r.got/r.size : 0; return;
    }
    let m; try{ m=JSON.parse(d); }catch(e){ return; }
    if(!m) return;
    if(m.t==='file'){
      const {t,xid,size,...meta}=m; meta.size=+size||0;
      if(meta.size>this.maxBytes || this.accept(meta)===false){
        this.stat.refused++; this.rx={xid,skip:true,parts:[],got:0,size:0};
        this.send(JSON.stringify({t:'cancel',xid})).catch(()=>{}); this.say('refused '+meta.name); return;
      }
      this.rx={xid,meta,parts:[],got:0,size:meta.size}; this.stat.prog=0; this.say('receiving '+meta.name+'…');
    } else if(m.t==='end' && this.rx && this.rx.xid===m.xid){
      const r=this.rx; this.rx=null; this.stat.prog=0;
      if(!r.skip){ this.stat.got++; this.say('received '+r.meta.name); this.onFile(r.meta,new Blob(r.parts,{type:r.meta.mime||'application/octet-stream'})); }
    } else if(m.t==='cancel'){
      if(this.tx && this.tx.xid===m.xid){ this.tx.cancel=true; this.say('declined by the other side: '+this.tx.name); }
      if(this.rx && this.rx.xid===m.xid){ this.rx=null; this.say('transfer cancelled'); }
    }
  }
  close(){ this.dead=true; this.txQ=[]; if(this.tx) this.tx.cancel=true; this.rx=null; }
}
