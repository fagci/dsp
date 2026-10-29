"use strict";
/* ============================ Traceroute / MTR (приложение DSP) ============================
   Путь до узла: какие маршрутизаторы стоят между телефоном и адресом и сколько на каждом уходит времени. Браузер так не умеет (ICMP, TTL):
   мост приложения делает пробы системным ping с растущим TTL (команда net.trace, без root). Несколько раундов — режим mtr: потери и разброс по каждому узлу.
   Логика — traceroute-kernels.js (node tools/test-traceroute.mjs); связь с мостом — netsvc.js. */

function traceStop(n){ n.stopReq=true; if(n.busy) n.status='stopping after this pass…'; }
function traceRun(n){
  const host=String(n.hostIn||n.p.host||'').trim();
  if(!host){ n.status='set the address (a host name or an IPv4 address)'; return; }
  n.stopReq=false;
  nsvClientRun(n,async ns=>{
    const rounds=Math.max(1,Math.min(100,+n.p.rounds||1)), max=Math.max(1,Math.min(64,+n.p.max||30)), wait=Math.max(1,Math.min(5,+n.p.timeout||2));
    const tok='t'+Date.now().toString(36)+Math.floor(Math.random()*1e6).toString(36), st=trcNew();
    let ctx=trcCtx(), round=0;
    const hook=r=>{
      if(r.ev!=='trace' || r.run!==tok) return;
      trcAdd(st,r);
      nsvPush(n,trcHopRec(ctx,host,r,round));
      n.status='round '+round+'/'+rounds+' · hop '+r.hop+' '+(r.ok ? r.ip+(r.ms!=null ? ' · '+r.ms+' ms' : '') : '*');
      n.outText=trcText(st,host);
    };
    ns.hooks.add(hook);
    let last=null;
    try{
      for(round=1;round<=rounds && !n.stopReq;round++){
        ctx=trcCtx(); st.rounds=round;
        last=await ns.call('net.trace',{host,max,timeout:wait,silent:Math.max(1,+n.p.silent||5),run:tok},(max*(wait+2)+10)*1000);
        for(const row of trcRows(st,host)) nsvPush(n,row);
        n.hops=st.hops.size;
        if(round<rounds && !n.stopReq) await new Promise(r=>setTimeout(r,Math.max(0,+n.p.interval||0)));
      }
    } finally { ns.hooks.delete(hook); }
    const rows=trcRows(st,host), end=rows[rows.length-1];
    return {status:(st.reached ? 'reached '+(end?.ip||host) : 'no answer from the destination')+' in '+rows.length+' hops'+(st.rounds>1 ? ' · '+st.rounds+' rounds' : ''),text:trcText(st,host),code:rows.length};
  });
}
def({ id:'traceroute', title:'Traceroute / MTR (DSP app)', cat:'Sources', kw:'traceroute tracert mtr path route hops ttl icmp ping latency loss router network internet isp',
  ins:[{n:'go',t:'num'},{n:'host',t:'txt'}], outs:[...NSV_CLI_OUTS,{n:'hops',t:'num'}], readout:true, tall:true,
  params:[
    {n:'url',t:'text',d:NSV_URL,label:'bridge of the DSP app'},
    {n:'host',t:'text',d:'8.8.8.8',label:'destination: IPv4 address or a name (the «host» input overrides)'},
    {n:'rounds',t:'range',min:1,max:100,step:1,d:1,label:'rounds (1 — a plain traceroute; more — mtr: loss and spread per hop)'},
    {n:'interval',t:'range',min:0,max:10000,step:100,d:500,label:'pause between rounds, ms'},
    {n:'max',t:'range',min:1,max:64,step:1,d:30,label:'max hops'},
    {n:'timeout',t:'range',min:1,max:5,step:1,d:2,label:'wait for one hop, s'},
    {n:'silent',t:'range',min:1,max:64,step:1,d:5,label:'give up after this many silent hops in a row'},
    {n:'run',t:'button',label:'Run',fn:n=>traceRun(n)},
    {n:'stop',t:'button',label:'Stop',fn:n=>traceStop(n)}],
  init:n=>{ n.nsP=null; n.ns=null; n.ws=null; n.recQ=[]; n.busy=false; n.status='idle'; n.ok=0; n.code=0; n.pulse=0; n.outBin=null; n.outText=null; n.prevGo=0; n.hostIn=''; n.cliSrc='net'; n.warn=''; n.hops=0; n.stopReq=false; },
  dispose:n=>nsvDrop(n),
  process(n,I){
    n.hostIn=typeof I.host==='string' ? I.host : '';
    const go=(I.go||0)>.5; if(go && !n.prevGo) traceRun(n); n.prevGo=go;
    return {...nsvClientOut(n),hops:n.hops}; },
  draw:nsvClientDraw });
