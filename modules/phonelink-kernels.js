"use strict";
/* ============================ Приложение DSP: команды Bluetooth, сети и автоматизации ============================
   Сборка команд по параметрам узлов (GATT / RFCOMM / реклама, TCP / UDP / ping / DNS / raw, режимы скана BLE),
   разбор значений характеристик по UUID, строки для readout. Без DOM — проверяется в tools/test-phonelink.mjs.
   Протокол и ограничения: tools/android/README.md. Зависит от ble-kernels.js (bleDecode) и dnsq-kernels.js (dnsQuery). */

const PL_HEX=/^[0-9a-f\s:,_-]*$/i;
const plHex=s=>String(s||'').replace(/0x/ig,'').replace(/[\s:,_-]/g,'').toLowerCase();
const plAddr=s=>/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(String(s||'').trim()) ? String(s).trim().toUpperCase() : '';
const plIsHex=s=>{ const h=plHex(s); return h.length>0 && h.length%2===0 && PL_HEX.test(String(s)); };

// ---------- BLE: скан (то, чего нет в Web Bluetooth) ----------
// параметры узла Phone sensors → объект настроек скана для сообщения подписки: {sub:[…], ble:{…}}
function plScanOpts(p){
  const o={};
  if(p.bleMode && p.bleMode!=='low_latency') o.mode=p.bleMode;
  if(p.bleLegacy==='extended only') o.legacy=false;
  if(p.blePhy && p.blePhy!=='all') o.phy=p.blePhy;
  if(p.bleMatch && p.bleMatch!=='default') o.match=p.bleMatch;
  if(+p.bleDelay>0) o.delay=Math.round(+p.bleDelay);
  const name=String(p.bleName||'').trim(); if(name) o.name=name;
  const addr=plAddr(p.bleAddr); if(addr) o.addr=addr;
  const uuid=String(p.bleUuid||'').trim(); if(uuid) o.uuid=uuid;
  const mfr=String(p.bleMfr||'').trim().replace(/^0x/i,''); if(/^[0-9a-f]{1,4}$/i.test(mfr)) o.mfr=mfr;
  return Object.keys(o).length ? o : null;
}

// ---------- GATT / Bluetooth ----------
const PL_GATT_ACTIONS=['connect','disconnect','discover','read','write','notify on','notify off','mtu','rssi','priority','phy','list','bonded','bond','unbond','uuids','rfcomm connect','rfcomm send','rfcomm close','rfcomm listen','adv start','adv stop'];
// I — значения со входов (приоритетнее полей узла): {addr, svc, chr, data}
function plGattCmd(p,I={}){
  const addr=plAddr(I.addr||p.addr), svc=String(I.svc||p.svc||'').trim(), chr=String(I.chr||p.chr||'').trim();
  const data=I.data!=null && I.data!=='' ? String(I.data) : String(p.data||'');
  const need=(...k)=>{ for(const x of k){ if(x==='addr' && !addr) return 'addr: AA:BB:CC:DD:EE:FF'; if(x==='uuid' && (!svc||!chr)) return 'svc and chr UUIDs are needed'; } return ''; };
  const payload=()=>{
    if(p.wfmt==='text') return data ? {text:data} : null;
    return plIsHex(data) ? {hex:plHex(data)} : null;
  };
  let e;
  switch(p.action){
    case 'connect': return (e=need('addr')) ? {error:e} : {cmd:'gatt.connect',addr,phy:p.phy||'1m',mtu:+p.mtu||0,read:!!p.autoRead,notify:!!p.autoNotify,max:+p.readMax||0,auto:!!p.autoConn};
    case 'disconnect': return (e=need('addr')) ? {error:e} : {cmd:'gatt.disconnect',addr};
    case 'discover': return (e=need('addr')) ? {error:e} : {cmd:'gatt.discover',addr,read:!!p.autoRead,notify:!!p.autoNotify,max:+p.readMax||0};
    case 'read': return (e=need('addr','uuid')) ? {error:e} : {cmd:'gatt.read',addr,svc,chr};
    case 'write': { if(e=need('addr','uuid')) return {error:e}; const w=payload(); return w ? {cmd:'gatt.write',addr,svc,chr,...w,resp:!!p.resp} : {error:p.wfmt==='text' ? 'nothing to write' : 'data: hex bytes'}; }
    case 'notify on': case 'notify off': return (e=need('addr','uuid')) ? {error:e} : {cmd:'gatt.notify',addr,svc,chr,on:p.action==='notify on'};
    case 'mtu': return (e=need('addr')) ? {error:e} : {cmd:'gatt.mtu',addr,mtu:+p.mtu||247};
    case 'rssi': return (e=need('addr')) ? {error:e} : {cmd:'gatt.rssi',addr};
    case 'priority': return (e=need('addr')) ? {error:e} : {cmd:'gatt.priority',addr,mode:p.prio||'high'};
    case 'phy': return (e=need('addr')) ? {error:e} : {cmd:'gatt.phy',addr,phy:p.phy||'1m'};
    case 'list': return {cmd:'gatt.list'};
    case 'bonded': return {cmd:'bt.bonded'};
    case 'bond': return (e=need('addr')) ? {error:e} : {cmd:'bt.bond',addr};
    case 'unbond': return (e=need('addr')) ? {error:e} : {cmd:'bt.unbond',addr};
    case 'uuids': return (e=need('addr')) ? {error:e} : {cmd:'bt.uuids',addr};
    case 'rfcomm connect': return (e=need('addr')) ? {error:e} : {cmd:'bt.connect',addr,...(p.uuid ? {uuid:String(p.uuid).trim()} : {}),secure:!!p.secure};
    case 'rfcomm send': { if(e=need('addr')) return {error:e}; const w=payload(); return w ? {cmd:'bt.send',addr,...w} : {error:'nothing to send'}; }
    case 'rfcomm close': return {cmd:'bt.close',...(addr ? {addr} : {})};
    case 'rfcomm listen': return {cmd:'bt.listen',name:'DSP',...(p.uuid ? {uuid:String(p.uuid).trim()} : {}),secure:!!p.secure};
    case 'adv start': return plAdvCmd(p);
    case 'adv stop': return {cmd:'ble.adv.stop'};
  }
  return {error:'unknown action'};
}
// реклама: advName, advUuids «180d, fe95», advMfr «004c=0215…», advSvc «fe95=0102», mode / power / connectable / ext / phy
function plAdvCmd(p){
  const c={cmd:'ble.adv.start',name:!!p.advName,mode:p.advMode||'balanced',power:p.advPower||'medium',connectable:!!p.advConn,ext:!!p.advExt,phy:p.advExt ? (p.phy||'1m') : '1m',timeout:+p.advTimeout||0};
  const uu=String(p.advUuids||'').split(/[,\s]+/).filter(Boolean); if(uu.length) c.uuids=uu;
  const kv=s=>{ const o={}; for(const part of String(s||'').split(/[;\n]+/)){ const m=/^\s*([0-9a-f-]+)\s*[=:]\s*([0-9a-f\s]*)$/i.exec(part); if(m && plIsHex(m[2]||'00')) o[m[1].toLowerCase()]=plHex(m[2]); } return Object.keys(o).length ? o : null; };
  const mfr=kv(p.advMfr), svc=kv(p.advSvc); if(mfr) c.mfr=mfr; if(svc) c.svc=svc;
  return c;
}

// ---------- значения характеристик ----------
// по UUID: формат, масштаб, единица (самые частые; полный справочник — список Table «Reference/Bluetooth UUIDs»)
const PL_CHR={
  '2a19':['battery %',1,'%'],'2a37':['heart rate (bpm)',1,'bpm'],'2a1c':['temperature (°C)',1,'°C'],'2a1e':['temperature (°C)',1,'°C'],'2a6e':['int16 LE',.01,'°C'],'2a6f':['uint16 LE',.01,'%'],
  '2a6d':['uint32 LE',.001,'hPa'],'2a07':['int8',1,'dBm'],'2a01':['uint16 LE',1,''],'2a21':['uint16 LE',1,'s'],'2a76':['uint8',1,''],'2a77':['uint16 LE',.1,'W/m²'],
  '2a00':['text',1,''],'2a24':['text',1,''],'2a25':['text',1,''],'2a26':['text',1,''],'2a27':['text',1,''],'2a28':['text',1,''],'2a29':['text',1,''],
  '6e400002-b5a3-f393-e0a9-e50e24dcca9e':['text',1,''],'6e400003-b5a3-f393-e0a9-e50e24dcca9e':['text',1,''],'ffe1':['text',1,''],
};
// hex → {value, text, hex}; fmt — из BLE_FORMATS или «text» / «auto» (по таблице выше, иначе только hex); scale — множитель
function plDecode(hex,fmt,uuid,scale){
  const h=plHex(hex), n=h.length>>1, u8=new Uint8Array(n);
  for(let i=0;i<n;i++) u8[i]=parseInt(h.substr(i*2,2),16);
  let f=fmt, k=scale, unit='';
  if(!f || f==='auto'){ const t=PL_CHR[String(uuid||'').toLowerCase()]; if(t){ f=t[0]; k=k ?? t[1]; unit=t[2]; } else f='hex only'; }
  const o={hex:h,text:'',value:null,unit};
  if(f==='text'){ try{ o.text=new TextDecoder('utf-8').decode(u8).replace(/\0+$/,''); }catch(e){ o.text=''; } return o; }
  if(typeof bleDecode==='function'){
    const r=bleDecode(new DataView(u8.buffer),f);
    if(r.value!==null) o.value=r.value*(k==null||k===''||isNaN(+k) ? 1 : +k);
  }
  return o;
}

// ---------- записи моста → строки ----------
function plLine(r){
  const f=(v,d)=>typeof v==='number' ? v.toFixed(d) : '—';
  switch(r.src){
    case 'gatt': switch(r.ev){
      case 'connected': return 'gatt '+r.addr+' connected';
      case 'disconnected': return 'gatt '+r.addr+' disconnected (status '+r.status+')';
      case 'services': return 'gatt '+r.addr+': '+r.n+' services, '+r.chars+' characteristics';
      case 'char': return 'gatt '+r.svc+' / '+r.chr+' ['+(r.props||[]).join(',')+']';
      case 'read': return 'read '+r.chr+' = '+r.hex+(r.status ? ' (status '+r.status+')' : '');
      case 'notify': return 'notify '+r.chr+' = '+r.hex;
      case 'write': return 'write '+r.chr+(r.status ? ' failed ('+r.status+')' : ' ok');
      case 'mtu': return 'mtu '+r.mtu;
      case 'rssi': return 'rssi '+r.rssi+' dBm';
      default: return 'gatt '+r.ev;
    }
    case 'btlink': return 'rfcomm '+r.ev+' '+(r.addr||'')+(r.hex ? ' '+r.hex.slice(0,40) : '');
    case 'btdev': return 'paired '+r.addr+' '+(r.name||'')+' ('+r.type+')';
    case 'net': switch(r.ev){
      case 'open': case 'accept': return r.proto+' '+r.ev+' #'+r.conn+' '+(r.peer||'');
      case 'data': return r.proto+' #'+r.conn+' '+(r.peer ? r.peer+' ' : '')+r.n+' B: '+String(r.text||'').replace(/[^\x20-\x7e]/g,'.').slice(0,60);
      case 'close': return r.proto+' closed '+(r.conn!=null ? '#'+r.conn : 'server '+r.server);
      case 'ping': return r.ok ? 'ping '+r.host+' '+f(r.ms,1)+' ms ttl '+(r.ttl??'—')+' seq '+r.seq : 'ping '+r.host+' '+(r.info||'no reply');
      default: return 'net '+r.ev;
    }
    case 'speech': return (r.final ? '' : '… ')+r.text;
    case 'sys': return 'sys '+r.ev+(r.pkg ? ' '+r.pkg : '')+(r.title ? ': '+r.title : '')+(r.state!=null ? ' '+r.state : '')+(r.on!=null ? ' '+r.on : '');
    case 'uitext': return 'ui '+r.text;
    case 'app': return 'app '+r.pkg+' '+r.label;
  }
  return null;
}

// ---------- сеть ----------
const PL_NET_ACTIONS=['tcp connect','tcp send','tcp close','tcp listen','udp open','udp send','udp close','udp request','ping','traceroute step','dns','net info','raw send'];
// DNS: запрос собирает dnsQuery (dnsq-kernels.js) и отправляется UDP-запросом через приложение
function plNetCmd(p,I={}){
  const host=String(I.host||p.host||'').trim(), port=+(I.port||p.port)||0, conn=+(I.conn||p.conn)||0;
  const data=I.data!=null && I.data!=='' ? String(I.data) : String(p.data||'');
  const payload=()=>{
    if(p.dfmt==='text') return data ? {text:data.replace(/\\r/g,'\r').replace(/\\n/g,'\n').replace(/\\t/g,'\t')} : null;
    return plIsHex(data) ? {hex:plHex(data)} : null;
  };
  switch(p.action){
    case 'tcp connect': return host&&port ? {cmd:'tcp.connect',host,port,timeout:+p.timeout||5000} : {error:'host and port'};
    case 'tcp send': { const w=payload(); return conn&&w ? {cmd:'tcp.send',conn,...w} : {error:conn ? 'nothing to send' : 'conn: the connection number from the «open» record'}; }
    case 'tcp close': return conn ? {cmd:'tcp.close',conn} : {error:'conn'};
    case 'tcp listen': return port ? {cmd:'tcp.listen',port,lan:!!p.lan} : {error:'port (1024…65535)'};
    case 'udp open': return {cmd:'udp.open',port,broadcast:!!p.broadcast};
    case 'udp send': { const w=payload(); return host&&port&&w ? {cmd:'udp.send',host,port,...(conn ? {conn} : {}),broadcast:!!p.broadcast,...w} : {error:'host, port and data'}; }
    case 'udp close': return conn ? {cmd:'udp.close',conn} : {error:'conn'};
    case 'udp request': { const w=payload(); return host&&port&&w ? {cmd:'udp.request',host,port,timeout:+p.timeout||3000,...w} : {error:'host, port and data'}; }
    case 'ping': return host ? {cmd:'ping',host,count:+p.count||4,size:+p.size||56,timeout:Math.max(1,Math.round((+p.timeout||2000)/1000))} : {error:'host'};
    case 'traceroute step': return host ? {cmd:'ping',host,count:1,ttl:Math.max(1,Math.min(64,+I.ttl||+p.ttl||1)),timeout:2} : {error:'host'};
    case 'dns': {
      const name=String(I.host||p.dnsName||host||'').trim(); if(!name) return {error:'name'};
      let q; try{ q=dnsQuery({name,type:p.dnsType||'A',edns:p.dnsEdns ? 1232 : 0,rd:p.dnsRd!==false}); }catch(e){ return {error:e.message}; }
      return {cmd:'udp.request',host:String(p.dnsServer||'@dns').trim(),port:+p.dnsPort||53,hex:Array.from(q,b=>b.toString(16).padStart(2,'0')).join(''),timeout:+p.timeout||3000,_dns:{name,type:p.dnsType||'A'}};
    }
    case 'net info': return {cmd:'net.info'};
    case 'raw send': return plIsHex(data) ? {cmd:'raw.send',hex:plHex(data)} : {error:'data: a complete IPv4 packet in hex'};
  }
  return {error:'unknown action'};
}
// ответ на DNS-запрос (запись {src:'cmd', hex}) → строки rec
function plDnsReply(r,q){
  const h=plHex(r.hex), b=new Uint8Array(h.length>>1); for(let i=0;i<b.length;i++) b[i]=parseInt(h.substr(i*2,2),16);
  const d=dnsParse(b);
  return {parsed:d,rows:dnsRecs(d,r.server).map(x=>({...x,ms:r.ms,src:'dns'}))};
}

if(typeof module!=='undefined') module.exports={plGattCmd,plNetCmd,plScanOpts,plDecode,plLine,plAdvCmd,plDnsReply};

// ---------- автоматизация, речь, управление ----------
const PL_SYS_ACTIONS=['speech start','speech stop','vol get','vol set','vol ringer','tts speak','tts stop','clip set','clip get',
  'media play/pause','media next','media prev','screen wake','toast','app list','app launch','intent broadcast','intent service','intent activity',
  'ui tap','ui swipe','ui back','ui home','ui recents','ui click','ui text','ui screen'];
// I: {text, pkg, x, y, x2, y2} со входов (приоритетнее полей узла)
function plSysCmd(p,I={}){
  const text=I.text!=null && I.text!=='' ? String(I.text) : String(p.text||'');
  const pkg=String(I.pkg||p.pkg||'').trim();
  switch(p.action){
    case 'speech start': return {cmd:'speech.start',lang:String(p.lang||'').trim(),partial:p.partial!==false,offline:!!p.offline};
    case 'speech stop': return {cmd:'speech.stop'};
    case 'vol get': return {cmd:'vol.get',stream:p.stream||'music'};
    case 'vol set': return {cmd:'vol.set',stream:p.stream||'music',...(p.volPct!=null && p.volPct!=='' ? {pct:+p.volPct} : {level:+p.volLevel||0}),ui:!!p.volUi};
    case 'vol ringer': return {cmd:'vol.ringer',mode:p.ringer||'normal'};
    case 'tts speak': return text ? {cmd:'tts.speak',text,lang:String(p.lang||'').trim(),rate:+p.rate||1,pitch:+p.pitch||1,queue:!!p.queue} : {error:'text'};
    case 'tts stop': return {cmd:'tts.stop'};
    case 'clip set': return text ? {cmd:'clip.set',text} : {error:'text'};
    case 'clip get': return {cmd:'clip.get'};
    case 'media play/pause': return {cmd:'media',key:'toggle'};
    case 'media next': return {cmd:'media',key:'next'};
    case 'media prev': return {cmd:'media',key:'prev'};
    case 'screen wake': return {cmd:'screen.wake',ms:+p.wakeMs||5000};
    case 'toast': return text ? {cmd:'toast',text} : {error:'text'};
    case 'app list': return {cmd:'app.list',q:String(p.q||''),limit:+p.limit||200};
    case 'app launch': return pkg ? {cmd:'app.launch',pkg,root:!!p.root} : {error:'pkg: package name (from app.list)'};
    case 'intent broadcast': case 'intent service': case 'intent activity': {
      const ia=String(p.intentAction||'').trim(), id=String(p.intentData||'').trim();
      return ia||id||pkg ? {cmd:'intent',kind:p.action.split(' ')[1],action:ia,data:id,pkg,root:!!p.root} : {error:'action, data or pkg'};
    }
    case 'ui tap': return {cmd:'ui.tap',x:+(I.x??p.x)||0,y:+(I.y??p.y)||0};
    case 'ui swipe': return {cmd:'ui.swipe',x:+(I.x??p.x)||0,y:+(I.y??p.y)||0,x2:+(I.x2??p.x2)||0,y2:+(I.y2??p.y2)||0,ms:+p.swipeMs||300};
    case 'ui back': return {cmd:'ui.global',action:'back'};
    case 'ui home': return {cmd:'ui.global',action:'home'};
    case 'ui recents': return {cmd:'ui.global',action:'recents'};
    case 'ui click': return text ? {cmd:'ui.click',text} : {error:'text: the button\'s visible label'};
    case 'ui text': return text ? {cmd:'ui.text',text} : {error:'text'};
    case 'ui screen': return {cmd:'ui.screen'};
  }
  return {error:'unknown action'};
}

if(typeof module!=='undefined') Object.assign(module.exports,{plSysCmd,PL_SYS_ACTIONS});
