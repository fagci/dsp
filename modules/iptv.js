"use strict";
/* ============================ IPTV: поток по сети → bin ============================
   HTTP-поток MPEG-TS или HLS (media / master playlist с сегментами .ts) → bin для TS → Video.
   Плейлист M3U со списком каналов выходит записями на rows (Table). Нужен CORS на сервере или прокси из настроек. */

function ipLog(n,s){ n.status=s; n.dirty=true; }
function ipStop(n){
  n.want=false; n.gen=(n.gen||0)+1;
  try{ n.abort?.abort(); }catch(e){}
  n.abort=null; clearTimeout(n.timer);
}
function ipPush(n,d){ n.rx.push(d); n.rxLen+=d.length; n.bytes+=d.length; }
const ipFetch=(n,u,o)=>fetch(n.p.proxy ? Net.url(u) : u,{cache:'no-store',...o});
const ipSleep=(n,ms)=>new Promise(r=>{ n.timer=setTimeout(r,ms); });

function ipSetChannels(n,items){
  n.chans=items; n.rows=items.map((c,i)=>({...c,n:i+1,kind:'tv'}));
  ipLog(n,items.length+' channels — pick one with «channel» or a Table row');
}
async function ipOpen(n,url){
  ipStop(n);
  url=String(url||'').trim();
  if(!/^https?:\/\//i.test(url)){ ipLog(n,'URL must start with http:// or https://'); return; }
  n.want=true; n.url=url; n.segsDone=0; n.last=null; n.listOnly=false; n.variant='';
  n.rx=[]; n.rxLen=0; n.stream=(n.stream||0)+1;                   // новый поток: хвост прошлого не отдавать, потребителю сообщить
  const g=n.gen, ac=n.abort=new AbortController();
  n.warn= typeof netInsecure==='function' && netInsecure(url) && !n.p.proxy ? NET_INSECURE_MSG : '';
  try{ await ipRun(n,url,g,ac); }
  catch(e){
    if(g!==n.gen) return;
    ipLog(n,'error: '+e.message+(e instanceof TypeError ? ' (no CORS headers on the server, or blocked — try «use CORS proxy»)' : ''));
  }
  if(g===n.gen && n.want && n.p.reconnect && !n.listOnly){ ipLog(n,n.status+' — reconnecting…'); n.timer=setTimeout(()=>{ if(g===n.gen) ipOpen(n,url); },3000); }
}
async function ipRun(n,url,g,ac){
  ipLog(n,'connecting…');
  const r=await ipFetch(n,url,{signal:ac.signal});
  if(!r.ok) throw new Error('HTTP '+r.status);
  const rd=r.body.getReader(), ct=(r.headers.get('content-type')||'').toLowerCase();
  let first=await rd.read();
  if(first.done || !first.value?.length) throw new Error('empty answer');
  const head=first.value[0];
  if(head===0x23 /* # */ || /mpegurl/.test(ct) || /\.m3u8?(\?|$)/i.test(url)){
    const parts=[first.value];
    for(;;){ const x=await rd.read(); if(x.done) break; parts.push(x.value); }
    let len=0; for(const p of parts) len+=p.length;
    const all=new Uint8Array(len); let o=0; for(const p of parts){ all.set(p,o); o+=p.length; }
    return ipPlaylist(n,new TextDecoder().decode(all),r.url||url,g,ac);
  }
  ipLog(n,'streaming'); n.live=true;
  let x=first;
  for(;;){
    if(g!==n.gen) return;
    if(x.value) ipPush(n,x.value);
    while(n.rxLen>8e6 && g===n.gen) await ipSleep(n,100);       // потребитель не успевает: держим TCP
    x=await rd.read();
    if(x.done) break;
  }
  ipLog(n,'stream ended'); n.live=false;
}
async function ipPlaylist(n,text,base,g,ac){
  const pl=iptvParse(text,base);
  if(pl.kind==='none') throw new Error('not a playlist and not a transport stream');
  if(pl.kind==='channels'){
    ipSetChannels(n,pl.items); n.listOnly=true; n.live=false;
    if(+n.p.channel>0) ipChannel(n,+n.p.channel);
    return;
  }
  if(pl.kind==='master'){
    const v=iptvPick(pl.items,n.p.quality);
    if(!v) throw new Error('empty master playlist');
    n.variant=(v.h ? v.h+'p · ' : '')+Math.round(v.bw/1000)+' kbit/s';
    const r=await ipFetch(n,v.url,{signal:ac.signal});
    if(!r.ok) throw new Error('variant: HTTP '+r.status);
    return ipPlaylist(n,await r.text(),r.url||v.url,g,ac);
  }
  // media playlist: опрос списка и сегменты по очереди; сегменты берём не дальше чем на 1.5 сегмента вперёд от темпа воспроизведения
  let cur=pl; n.hlsT0=performance.now(); n.hlsDur=0;
  for(;;){
    if(g!==n.gen) return;
    if(cur.fmp4) throw new Error('fMP4 / CMAF segments are not supported (only MPEG-TS)');
    if(cur.encrypted) throw new Error('encrypted HLS (AES-128) is not supported');
    const todo=iptvNew(cur.segs,n.last,2);
    n.live=!cur.end;
    for(const s of todo){
      if(g!==n.gen) return;
      for(;;){
        const ahead=n.hlsDur*1000-(performance.now()-n.hlsT0);
        if(ahead<0) n.hlsT0=performance.now()-n.hlsDur*1000;        // поток отстал: темп отсчитываем заново
        if(ahead<=cur.target*1500 || g!==n.gen) break;
        await ipSleep(n,200);
      }
      if(g!==n.gen) return;
      const r=await ipFetch(n,s.url,{signal:ac.signal});
      if(!r.ok) throw new Error('segment '+s.seq+': HTTP '+r.status);
      ipPush(n,new Uint8Array(await r.arrayBuffer()));
      n.last=s.seq; n.segsDone++; n.hlsDur+=s.dur||cur.target;
      ipLog(n,(cur.end ? 'VOD' : 'live')+(n.variant ? ' · '+n.variant : '')+' · segment '+s.seq);
    }
    if(cur.end && !todo.length){ ipLog(n,'finished'); n.want=false; return; }
    if(!todo.length) await ipSleep(n,Math.max(1000,cur.target*500));
    const r=await ipFetch(n,base,{signal:ac.signal});
    if(!r.ok) throw new Error('playlist: HTTP '+r.status);
    cur=iptvParse(await r.text(),r.url||base);
    if(cur.kind!=='media') throw new Error('playlist changed type');
  }
}
// номер (с 1), id / название канала или адрес
function ipFind(n,v){
  const L=n.chans||[];
  if(typeof v==='number' || /^\d+$/.test(String(v).trim())) return +v;
  const s=String(v).trim().toLowerCase();
  let i=L.findIndex(c=>c.id && c.id.toLowerCase()===s || c.name.toLowerCase()===s || c.url===v);
  if(i<0) i=L.findIndex(c=>c.name.toLowerCase().includes(s));
  return i+1;
}
function ipStep(n,d){
  const L=n.chans?.length; if(!L) return;
  ipChannel(n,(((n.cur||0)-1+d+L)%L)+1);
}
function ipChannel(n,i){
  const c=n.chans?.[i-1]; n.cur=i;
  if(!c){ ipLog(n,'no channel '+i+' in the list'); return; }
  n.name=c.name; ipOpen(n,c.url);
}

def({ id:'iptv', title:'IPTV', cat:'Sources', kw:'iptv tv television stream m3u m3u8 hls playlist channels mpeg ts http live', readout:true, always:true, resize:true, w:340,
  ins:[{n:'url',t:'txt'},{n:'channel',t:'val'},{n:'next',t:'num'}],
  outs:[{n:'bin',t:'bin'},{n:'rows',t:'bands'},{n:'name',t:'txt'},{n:'live',t:'num'},{n:'kbps',t:'num'}],
  params:[{n:'url',t:'text',d:'',label:'URL: TS stream (http), HLS .m3u8 or an M3U channel list'},
          {n:'play',t:'button',label:'Play',fn:n=>ipOpen(n,n.p.url)},
          {n:'prev',t:'button',label:'◀ Previous channel',fn:n=>ipStep(n,-1)},
          {n:'nextb',t:'button',label:'Next channel ▶',fn:n=>ipStep(n,1)},
          {n:'stop',t:'button',label:'Stop',fn:n=>{ ipStop(n); n.rx=[]; n.rxLen=0; ipLog(n,'stopped'); }},
          {n:'file',t:'file',accept:'.m3u,.m3u8,audio/x-mpegurl,application/vnd.apple.mpegurl',fn:async(n,f)=>{
              const pl=iptvParse(await f.text(),'');
              if(pl.kind==='channels'){ ipStop(n); ipSetChannels(n,pl.items); }
              else ipLog(n,'the file is not a channel list'); }},
          {n:'channel',t:'num',d:0,min:0,step:1,label:'channel number in the list (0 — none)'},
          {n:'quality',t:'select',opts:['highest','lowest','first'],d:'highest',label:'HLS: variant of a master playlist'},
          {n:'reconnect',t:'check',d:true,label:'reconnect a dropped stream'},
          {n:'proxy',t:'check',d:false,label:'through the CORS proxy from Settings'}],
  init(n){ n.rx=[]; n.rxLen=0; n.bytes=0; n.status='enter a URL and press Play'; n.chans=null; n.rows=null; n.name=''; n.warn='';
    n.rate=0; n.rateAt=performance.now(); n.rateB=0; n.inUrl=''; n.inCh=''; n.nxPrev=false; n.cur=0; n.live=false; n.gen=0; n.want=false; n.variant=''; n.listOnly=false; },
  dispose:n=>{ ipStop(n); },
  process(n,I){
    if(typeof I.url==='string' && I.url && I.url!==n.inUrl){ n.inUrl=I.url; setMod(n,'url',I.url); ipOpen(n,I.url); }
    const cv=I.channel, ck= cv==null || cv==='' || cv===0 ? '' : String(cv);
    if(ck && ck!==n.inCh){
      if(/^https?:\/\//i.test(ck)){ n.inCh=ck; setMod(n,'url',ck); ipOpen(n,ck); }
      else if(n.chans){ n.inCh=ck; const i=ipFind(n,cv); if(i>0){ setMod(n,'channel',i); n.pcPrev=i; ipChannel(n,i); } else ipLog(n,'no channel «'+ck+'» in the list'); }
    }else if(!ck) n.inCh='';
    const nx=(I.next||0)>.5; if(nx && !n.nxPrev) ipStep(n,1); n.nxPrev=nx;
    const pc=+n.p.channel|0;
    if(pc>0 && pc!==n.pcPrev && n.chans){ n.pcPrev=pc; ipChannel(n,pc); }
    let bin=null;
    if(n.rx.length){
      const d=new Uint8Array(n.rxLen); let o=0; for(const c of n.rx){ d.set(c,o); o+=c.length; }
      n.rx=[]; n.rxLen=0; bin=binObj(d,n.name,'video/mp2t'); bin.stream=n.stream;
    }
    return {bin, rows:n.rows, name:n.name, live:n.live ? 1 : 0, kbps:n.rate/1000}; },
  draw(n){
    const r=n.el.querySelector('.readout'); if(!r) return;
    const now=performance.now();
    if(now-n.rateAt>1000){ n.rate=(n.bytes-n.rateB)*8/((now-n.rateAt)/1000); n.rateB=n.bytes; n.rateAt=now; }
    const t=(n.name ? n.name+'\n' : '')+n.status+(n.want ? ' · '+(n.rate/1e6).toFixed(2)+' Mbit/s' : '')+(n.warn ? '\n'+n.warn : '');
    if(r.textContent!==t) r.textContent=t; }
});
