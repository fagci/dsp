"use strict";
/* ============================ Network Links: логика без DOM ============================
   Мост приложения (net.list / net.sockets / net.watch, запись ev:'networks') отдаёт сети телефона и открытые сокеты с байтами.
   Здесь: скорости по приращению счётчиков, привязка сокетов к сетям, строки для модуля Graph (вход rows), текст и записи для графа.
   Проверяется: node tools/test-netlinks.mjs */

const NLK_COL={wifi:'#6fd0ff',cell:'#ffb14d',eth:'#7dff9a',vpn:'#c79bff',bt:'#6f8cff',usb:'#ff7d9a',aware:'#6fe0d0',lowpan:'#aaa',other:'#8a979c'};
const NLK_HIST=60;                                     // точек истории скорости на сокет

/** «wifi#101» → 101; «default» и всё непонятное → null. */
function nlkNetId(label){ const m=/#(\d+)$/.exec(String(label||'')); return m ? +m[1] : null; }

/** Скорости сокетов (байт/с) по двум снимкам счётчиков; state хранит прошлый снимок и историю — {last:Map, t, hist:Map}. */
function nlkRates(state,socks,now){
  const dt=state.t ? Math.max(.05,(now-state.t)/1000) : 0, rates=new Map(), last=new Map();
  for(const s of socks){
    const p=state.last.get(s.id), rx=+s.rx||0, tx=+s.tx||0;
    const r=p && dt ? {rx:Math.max(0,(rx-p.rx)/dt),tx:Math.max(0,(tx-p.tx)/dt)} : {rx:0,tx:0};
    rates.set(s.id,r); last.set(s.id,{rx,tx});
    let h=state.hist.get(s.id); if(!h){ h=[]; state.hist.set(s.id,h); }
    h.push(r.rx+r.tx); if(h.length>NLK_HIST) h.shift();
  }
  for(const id of [...state.hist.keys()]) if(!last.has(id)) state.hist.delete(id);     // закрытые сокеты забываем
  state.last=last; state.t=now;
  return rates;
}
const nlkNew=()=>({last:new Map(),t:0,hist:new Map()});

function nlkSpeed(b){ b=+b||0; return b<1000 ? Math.round(b)+' B/s' : b<1e6 ? (b/1e3).toFixed(1)+' kB/s' : (b/1e6).toFixed(2)+' MB/s'; }
function nlkBytes(b){ b=+b||0; return b<1024 ? b+' B' : b<1048576 ? (b/1024).toFixed(1)+' kB' : (b/1048576).toFixed(1)+' MB'; }
function nlkKbps(k){ k=+k||0; return !k ? '' : k>=1000 ? Math.round(k/1000)+' Mbit/s' : k+' kbit/s'; }

/** К какой сети относится сокет: по метке «wifi#101»; «default» — к сети системы (default:true). null — сети уже нет. */
function nlkNetOf(nets,s){
  const id=nlkNetId(s.net);
  if(id!=null) return nets.find(n=>n.id===id)||null;
  return nets.find(n=>n.default)||null;
}

const NLK_GLYPH={'tcp':'→','tcp-server':'◉','udp':'≋'};

/** Таблица текстом (выход text и строка состояния). */
function nlkText(nets,socks,rates){
  const L=[];
  for(const n of nets) L.push((n.default ? '★ ' : '  ')+(n.kind+'#'+n.id).padEnd(10)+(n.iface||'?').padEnd(9)+(n.ips[0]||'-').padEnd(16)+(n.validated ? 'ok' : 'no internet').padEnd(12)+(n.metered ? 'metered ' : '')+nlkKbps(n.down));
  if(socks.length) L.push('');
  for(const s of socks){ const r=rates.get(s.id)||{rx:0,tx:0};
    L.push(((NLK_GLYPH[s.kind]||'·')+' #'+s.id).padEnd(8)+String(s.net).padEnd(11)+String(s.addr).padEnd(24)+'↓'+nlkSpeed(r.rx)+' ↑'+nlkSpeed(r.tx)+' · '+nlkBytes(s.rx)+' / '+nlkBytes(s.tx)); }
  return L.join('\n');
}

/** Записи для графа: по строке на сеть и на сокет. */
function nlkRows(nets,socks,rates){
  const out=[];
  for(const n of nets) out.push({src:'netlink',ev:'net',id:n.id,kind:n.kind,iface:n.iface,ips:n.ips,dns:n.dns,gateway:n.gateway,validated:n.validated,metered:n.metered,default:n.default,down:n.down,up:n.up});
  for(const s of socks){ const r=rates.get(s.id)||{rx:0,tx:0}; out.push({src:'netlink',ev:'sock',id:s.id,kind:s.kind,addr:s.addr,net:s.net,server:s.server??null,age:s.age,rx:s.rx,tx:s.tx,rx_bps:Math.round(r.rx),tx_bps:Math.round(r.tx)}); }
  return out;
}

/** Что изменилось между двумя наборами сетей — для записей ev:'change' (подключилась / пропала / стала по умолчанию / потеряла интернет). */
function nlkDiff(a,b){
  const out=[], A=new Map(a.map(n=>[n.id,n])), B=new Map(b.map(n=>[n.id,n]));
  for(const [id,n] of B){ const o=A.get(id);
    if(!o) out.push({what:'up',id,kind:n.kind});
    else { if(o.validated!==n.validated) out.push({what:n.validated ? 'online' : 'offline',id,kind:n.kind}); if(!o.default && n.default) out.push({what:'default',id,kind:n.kind}); if(o.ips.join()!==n.ips.join()) out.push({what:'addr',id,kind:n.kind}); } }
  for(const [id,n] of A) if(!B.has(id)) out.push({what:'down',id,kind:n.kind});
  return out;
}

/** Топология для модуля Graph (вход rows): телефон → сети → сокеты; принятые соединения — под своим сервером. Цвет и толщина связи — скорость.
 *  cache (Map) хранит прошлые строки: неизменившаяся строка — тот же объект, Graph не разбирает её заново и не перестраивает раскладку. */
function nlkGraph(nets,socks,rates,cache){
  const out=[], seen=new Set();
  const put=(key,row)=>{ const j=JSON.stringify(row), c=cache.get(key); seen.add(key); if(c && c.j===j){ out.push(c.row); return; } cache.set(key,{j,row}); out.push(row); };
  const lg=v=>Math.log10(1+(+v||0));
  put('n:phone',{id:'phone',label:'phone',shape:'box',color:'#d8e2e6',size:20,group:'phone'});
  for(const n of nets){
    const col=NLK_COL[n.kind]||NLK_COL.other, id='net:'+n.id;
    put('n:'+id,{id,label:(n.default ? '★ ' : '')+n.kind+' #'+n.id+'\n'+(n.iface||'?')+(n.ips[0] ? ' '+n.ips[0] : ''),shape:'hexagon',color:col,size:14+Math.min(10,lg(n.down)*2),group:n.kind,
      note:'dns '+(n.dns.join(', ')||'-')+' · gateway '+(n.gateway||'-')+(n.validated ? '' : ' · no internet')+(n.metered ? ' · metered' : '')});
    put('e:phone>'+id,{from:'phone',to:id,label:nlkKbps(n.down),color:col,dashes:n.validated ? '' : 'dash',weight:n.default ? 4 : 2});
  }
  const ids=new Set(socks.map(s=>s.id));
  for(const s of socks){
    const r=rates.get(s.id)||{rx:0,tx:0}, v=r.rx+r.tx, act=v>0, id='sock:'+s.id;
    put('n:'+id,{id,label:(NLK_GLYPH[s.kind]||'·')+' '+s.addr,shape:s.kind==='tcp-server' ? 'diamond' : s.kind==='udp' ? 'triangle' : 'dot',
      color:act ? '#7dff9a' : '#8a979c',size:6+Math.min(12,lg(v)*2.5),group:s.kind,note:s.net+' · '+nlkBytes(s.rx)+' down / '+nlkBytes(s.tx)+' up'});
    let from='phone';
    if(s.server!=null && ids.has(s.server)) from='sock:'+s.server;
    else { const n=nlkNetOf(nets,s); if(n) from='net:'+n.id; }
    put('e:'+from+'>'+id,{from,to:id,label:act ? nlkSpeed(v) : '',color:act ? '#7dff9a' : '#55616a',dashes:act ? '' : 'dash',weight:1+Math.round(lg(v)*1.5)});
  }
  for(const k of [...cache.keys()]) if(!seen.has(k)) cache.delete(k);
  return out;
}
