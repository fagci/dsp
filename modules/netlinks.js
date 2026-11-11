"use strict";
/* ============================ Network Links (приложение DSP) ============================
   Какие сети есть у телефона (Wi-Fi, мобильная, Ethernet, VPN…) и что через них сейчас идёт: открытые сокеты и серверы с привязкой
   к сети и скоростью. Схему рисует модуль Graph: выход rows (телефон → сети → сокеты и серверы, цвет и подпись связи — скорость) подключают к его входу rows.
   Мост: net.watch (запись ev:'networks' при каждом изменении) и net.sockets раз в poll мс. Логика — netlinks-kernels.js
   (node tools/test-netlinks.mjs); связь с мостом — netsvc.js. Параметр net:"wifi|cell|eth|vpn|<номер>" есть у tcp.connect / tcp.listen / udp.* / ping. */

function nlkLink(n){
  if(n.ns || n.nsP || Date.now()<n.retry) return;
  n.retry=Date.now()+3000;
  nsvLink(n).then(async ns=>{
    n.hook=r=>{
      if(r.src!=='net' || r.ev!=='networks') return;
      nlkApply(n,r.nets||[],r.socks||n.socks);
    };
    ns.hooks.add(n.hook);
    const r=await ns.call('net.watch',{on:true},8000);
    nlkApply(n,r.nets||[],r.socks||[]);
    clearInterval(n.timer); n.timer=setInterval(()=>nlkPoll(n),Math.max(250,+n.p.poll||1000));
    n.status='watching';
  }).catch(e=>{ n.nsP=null; n.status='no bridge: '+(e.message||e); });
}
async function nlkPoll(n){
  if(!n.ns){ clearInterval(n.timer); n.timer=0; return; }
  try{ const r=await n.ns.call('net.sockets',{},4000); nlkApply(n,n.nets,r.socks||[]); }catch(e){ n.status='poll: '+(e.message||e); }
}
function nlkApply(n,nets,socks){
  const ch=nlkDiff(n.nets,nets);
  if(n.have) for(const c of ch) nsvPush(n,{src:'netlink',ev:'change',...c});
  n.have=true; n.nets=nets; n.socks=socks; n.stale=false;
  n.rates=nlkRates(n.rs,socks,performance.now());
  n.text=nlkText(nets,socks,n.rates); n.graph=nlkGraph(nets,socks,n.rates,n.gcache);
  if(ch.length || n.p.emit==='every update') for(const row of nlkRows(nets,socks,n.rates)) nsvPush(n,row);
  if(ch.length) n.pulse=2;
}
function nlkDispose(n){
  clearInterval(n.timer); n.timer=0;
  if(n.ns && n.hook) n.ns.hooks.delete(n.hook);
  if(n.ns) try{ n.ns.call('net.watch',{on:false},1000).catch(()=>{}); }catch(e){}
  nsvDrop(n);
}
def({ id:'netlinks', title:'Network Links (DSP app)', cat:'Sources', kw:'networks wifi cellular mobile ethernet vpn multipath sockets servers connections traffic active bind interface map diagram graph',
  ins:[], outs:[{n:'rows',t:'bands'},{n:'rec',t:'rec'},{n:'text',t:'txt'},{n:'nets',t:'num'},{n:'socks',t:'num'},{n:'wifi',t:'num'},{n:'cell',t:'num'},{n:'rx',t:'num'},{n:'tx',t:'num'},{n:'new',t:'num'}],
  readout:true, tall:true,
  params:[
    {n:'url',t:'text',d:NSV_URL,label:'bridge of the DSP app'},
    {n:'poll',t:'range',min:250,max:5000,step:250,d:1000,label:'counters refresh, ms (changes of networks arrive at once)'},
    {n:'emit',t:'select',opts:['changes','every update'],d:'changes',label:'rec output: only changes (network up / down / default / online) or the full list on every update'}],
  init:n=>{ n.nsP=null; n.ns=null; n.ws=null; n.recQ=[]; n.status='connecting…'; n.warn=''; n.retry=0; n.timer=0; n.hook=null; n.nets=[]; n.socks=[]; n.have=false; n.stale=false; n.pulse=0; n.rs=nlkNew(); n.rates=new Map(); n.text=''; n.graph=[]; n.gcache=new Map(); },
  dispose:nlkDispose,
  process(n){
    if(!n.ns){ if(n.have) n.stale=true; nlkLink(n); }
    const pl=n.pulse>0 ? 1 : 0; if(n.pulse>0) n.pulse--;
    const rec=n.recQ.length ? n.recQ.splice(0) : null;
    let rx=0, tx=0; for(const r of n.rates.values()){ rx+=r.rx; tx+=r.tx; }
    const up=k=>n.nets.some(x=>x.kind===k && x.validated) ? 1 : 0;
    return {rows:n.graph,rec,text:n.text,nets:n.nets.length,socks:n.socks.length,wifi:up('wifi'),cell:up('cell'),rx,tx,new:pl};
  },
  draw(n){
    const r=n.el.querySelector('.readout'); if(!r) return;
    const t=(n.warn&&!n.ns ? '⚠ '+n.warn+'\n' : '')+(n.stale ? 'bridge lost — the last known state (stale)' : n.status)+'\n'+n.text;
    if(r.textContent!==t) r.textContent=t;
  }});
