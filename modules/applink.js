"use strict";
/* ============================ Связь страницы с мостом приложения Android ============================
   Одно WebSocket-соединение на страницу к ws://127.0.0.1:8765 (с ключом приложения): команды с ответом (NetSock.call) и записи моста.
   Подписка — net (сокеты) и ai (модели на телефоне: прогресс загрузки, сегменты распознавания). AppLink.on(fn) — записи не-net.
   Нужны NetSock (netsock-kernels.js) и phoneUrl (phoneact-kernels.js). Вне приложения (нет DspApp) ok === false, и ничего не открывается. */
const AppLink={
  ns:null, p:null, hooks:new Set(),
  get ok(){ return typeof DspApp!=='undefined'; },
  link(){
    if(this.ns) return Promise.resolve(this.ns);
    if(this.p) return this.p;
    return this.p=new Promise((res,rej)=>{
      let key=''; try{ key=(window.DspApp && DspApp.appKey && DspApp.appKey()) || ''; }catch(e){}
      const url=phoneUrl('ws://127.0.0.1:8765',key); if(!url){ this.p=null; return rej(new Error('no bridge address')); }
      let ws; try{ ws=new WebSocket(url); }catch(e){ this.p=null; return rej(e); }
      const ns=new NetSock(m=>{ if(ws.readyState!==1) throw new Error('bridge is not connected'); ws.send(JSON.stringify(m)); });
      ns.xhooks=new Set([r=>{ for(const h of this.hooks) try{ h(r); }catch(e){} }]);
      ws.onopen=()=>{ ws.send(JSON.stringify({sub:['net','ai']})); this.ns=ns; this.p=null; res(ns); };
      ws.onerror=()=>{ if(!this.ns){ this.p=null; rej(new Error('the app bridge is not reachable')); } };
      ws.onclose=()=>{ if(this.ns===ns) this.ns=null; };
      ws.onmessage=e=>{ if(typeof e.data!=='string') return; let j; try{ j=JSON.parse(e.data); }catch(x){ return; } for(const r of Array.isArray(j) ? j : [j]) ns.feed(r); };
    });
  },
  async call(cmd,args,ms){ const ns=await this.link(); return ns.call(cmd,args||{},ms==null ? 15000 : ms); },
  on(fn){ this.hooks.add(fn); return ()=>this.hooks.delete(fn); }};
