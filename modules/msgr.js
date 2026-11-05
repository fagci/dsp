"use strict";
/* ============================ Messenger: узел ============================
   Один узел на тринадцать каналов связи — Nostr, ntfy, Matrix, Telegram (бот), IRC, XMPP, APRS-IS, почта (IMAP/SMTP), SMS (приложение DSP на Android), Reticulum/LXMF, ленты Mastodon и Bluesky, RSS / Atom. Протоколы — msgr-kernels.js
   и msgr-session.js (те же файлы грузит Node-мост tools/node/bridge.mjs). Из страницы напрямую: Nostr (реле wss://),
   ntfy, Matrix, Telegram, IRC по WebSocket (wss://). IRC по TCP (ircs://) и XMPP — через TCP-шлюз (поле bridge: Node-мост или приложение на телефоне).
   rec → Chat: {t, proto, dir, from, to, text}; свои сообщения приходят с from = nick — в Chat «my name» поставь тот же ник. */

const MG_KEEP=300;
const MG_DEF_SERVER={nostr:'wss://relay.damus.io wss://nos.lol',ntfy:'https://ntfy.sh'};
function mgNodeLog(n,dir,m){
  const row={t:m.t || Date.now(),proto:n.p.proto,dir,from:dir==='out' ? String(n.p.nick||'me') : String(m.from||''),to:m.to||'',text:String(m.text),id:m.id||''};
  if(m.atts && m.atts.length){
    row.atts=m.atts.map(a=>({name:a.name,mime:a.mime,size:a.size||((a.bytes||[]).length||0)}));
    row.text=(row.text?row.text+' ':'')+row.atts.map(a=>'[file: '+a.name+(a.size?' · '+(a.size/1024).toFixed(0)+' KB':'')+']').join(' ');
  }
  if(m.thread) row.thread=m.thread;
  if(m.post) Object.assign(row,m.post);                                      // ленты: имя, ссылка, теги, язык, картинка, счётчики
  if(m.kind && m.kind!=='message'){ row.kind=m.kind; row.comment=m.comment||''; if(m.lat!=null){ row.lat=m.lat; row.lon=m.lon; row.symbol=m.symbol; row.name=row.id=row.from; } }   // APRS: станции — на Map
  n.log.push(row); if(n.log.length>MG_KEEP) n.log.shift();
  n.recQ.push(row); if(n.recQ.length>2000) n.recQ.shift();
  n.lastRow=row; n.fresh++; n.count++;
}
function mgNodeStop(n){
  if(n.sess){ try{ n.sess.close(); }catch(e){} n.sess=null; }
  n.ok=false; n.status='disconnected';
}
function mgNodeStart(n){
  mgNodeStop(n);
  const p=n.p, proto=p.proto;
  const rawBridge=String(p.bridge||'').trim();
  if(rawBridge[0]==='@' && gwErr(rawBridge)){ n.status=gwErr(rawBridge); return; }
  const bridge=gwUrl(rawBridge) + (p.bridgeToken && /^wss?:/i.test(rawBridge) ? '?token='+encodeURIComponent(p.bridgeToken) : '');      // bridgeToken — из старых патчей; новый путь — токен в Settings → Devices
  const cfg={server:'',channel:String(p.channel||'').trim(),user:'',pass:'',
    nick:String(p.nick||'dsp').trim() || 'dsp',appKey:(()=>{ try{ return (window.DspApp && DspApp.appKey && DspApp.appKey()) || ''; }catch(e){ return ''; } })(),history:+p.history||0,retry:!!p.reconnect,via:p.via,proxyUrl:p.proxy && typeof Net!=='undefined' ? u=>Net.url(u) : null,smtp:'',pollMs:(+p.poll||30)*1000,bridge,insecure:!!p.plain,cache:n.mxCache};
  const acct=String(p.account||'').trim();
  if(acct){                                                          // учётка — единственный источник сервера, логина и пароля
    const cr=(typeof Cred!=='undefined' && Cred.get(acct))||null;
    if(!cr){ n.status='credential «'+acct+'» not found — add it in Settings → Credentials or with «＋ new…» here'; return; }
    if(cr.server) cfg.server=cr.server;
    if(cr.user) cfg.user=cr.user;
    if(cr.pass) cfg.pass=cr.pass;
    if(cr.smtp) cfg.smtp=cr.smtp;
  }
  if(!cfg.server) cfg.server=MG_DEF_SERVER[proto]||'';
  if(proto==='reticulum' && !cfg.pass.trim()){
    try{ cfg.pass=mgHex(mgRandom(64));
      if(acct && typeof Cred!=='undefined'){ Cred.upsert({name:acct,pass:cfg.pass}); n.status='new Reticulum identity made — kept in the «'+acct+'» credential'; }
      else n.status='new Reticulum identity for this session only — keep it: make a credential and pick it in «account»';
    }catch(e){ n.status='no secure random generator'; return; }
  }
  if(proto==='reticulum') cfg.key=cfg.pass;
  if(proto==='nostr'){ cfg.key=cfg.pass; if(!cfg.key){ try{ if(!n.eph) n.eph=mgHex(mgNostrGenKey()); cfg.key=n.eph; }catch(e){ n.status='no secure random generator'; return; } } }
  const inApp=(()=>{ try{ return !!(window.DspApp && DspApp.appKey); }catch(e){ return false; } })();
  if(p.via==='auto' && inApp && !cfg.bridge) cfg.phone={url:'ws://127.0.0.1:8765',key:cfg.appKey};   // внутри приложения свои сокеты; чужой шлюз — только по явному адресу
  n.warn=netInsecure(cfg.server) || (cfg.bridge && netInsecure(cfg.bridge)) ? NET_INSECURE_MSG : '';
  n.sess=mgConnect(proto,cfg,{
    msg:m=>{ if(m.delay && !cfg.history) return; mgNodeSaveAtts(n,m); mgNodeLog(n,m.self ? 'out' : 'in',m); },
    status:(t,s)=>{ n.status=t; n.ok=s==='up'; if(s==='fatal') n.sess=null; },
  });
}
function mgNodeSend(n,text,to){
  text=String(text||'').trim(); if(!text) return;
  if(!n.sess){ n.status='not connected — press Connect'; return; }
  (async()=>{
    if(!to && n.book && n.book.length && text[0]==='@'){                     // адресная книга: @alias → @адрес из контактов
      const m=/^@(\S+)\s?/.exec(text), addr=m ? mgAddrResolve(n.book,m[1]) : '';
      if(addr) text='@'+addr+text.slice(m[0].length);
    }
    let atts=null;
    const ref=String(n.p.attach||'').trim();
    if(n.p.proto==='email' && ref){
      atts=await mgLoadAtts(ref);
      if(!atts) n.status='attachment «'+ref+'» not found in Files';
    }
    return n.sess.send(text,to||undefined,atts||undefined);
  })().then(ok=>{ if(!ok && n.sess && !/not sent|not found/.test(n.status)) n.status+=' · not sent'; });
}
/* вложение из Files: имя или id файла → [{name, mime, bytes}] */
async function mgLoadAtts(ref){
  if(typeof FileStore==='undefined') return null;
  let rec=null;
  if(/^\d+$/.test(ref)) rec=await FileStore.get(+ref).catch(()=>null);
  if(!rec){
    const dirs=[null];
    try{ for(const f of await FileStore.listFolders('files',null)) dirs.push(f.id); }catch(e){}
    for(const d of dirs){
      try{ rec=(await FileStore.list('files',d)).find(x=>x.name===ref)||null; }catch(e){}
      if(rec) break;
    }
  }
  if(!rec||!rec.blob) return null;
  return [{name:rec.name,mime:rec.mime||'application/octet-stream',bytes:new Uint8Array(await rec.blob.arrayBuffer())}];
}
/* входящие вложения — в папку mail/ хранилища Files */
function mgNodeSaveAtts(n,m){
  if(!m.atts || !m.atts.length || typeof FileStore==='undefined') return;
  (async()=>{
    try{
      const path=mgAttPath(n.p.attPath,m,n.p.proto);                 // по шаблону «mail/{from}»: вложенные папки создаются по пути
      let dir=null;
      for(const name of path){
        let f=(await FileStore.listFolders('files',dir?dir.id:null).catch(()=>[])).find(x=>x.name===name);
        if(!f) f=await FileStore.addFolder('files',name,dir?dir.id:null).catch(()=>null);
        if(!f){ dir=null; break; }
        dir=f;
      }
      for(const a of m.atts){
        const blob=new Blob([a.bytes],{type:a.mime});
        await FileStore.put({space:'files',folderId:dir?dir.id:null,name:a.name,mime:a.mime,blob,
          meta:{from:m.fromAddr||m.from||'',subject:m.subject||'',t:m.t||Date.now()}});
      }
      n.status='saved '+m.atts.length+' attachment(s) → Files/'+path.join('/');
    }catch(e){ n.status='attachment save failed: '+e.message; }
  })();
}

def({ id:'messenger', title:'Messenger (Nostr · ntfy · Matrix · Telegram · IRC · XMPP · APRS · Email · SMS · Reticulum · Mastodon · Bluesky · RSS)', cat:'Sources',
  kw:'messenger chat nostr ntfy matrix telegram bot irc xmpp jabber relay message channel push notify send receive internet',
  ins:[{n:'send',t:'txt'},{n:'to',t:'txt'},{n:'rows',t:'bands'}], outs:[{n:'rec',t:'rec'},{n:'text',t:'txt'},{n:'from',t:'txt'},{n:'new',t:'num'},{n:'ok',t:'num'}],
  readout:true, tall:true,
  params:[
    {n:'proto',t:'select',opts:['nostr','ntfy','matrix','telegram','irc','xmpp','aprs','email','sms','reticulum','mastodon','bluesky','rss'],d:'nostr',label:'channel of communication'},
    {n:'account',t:'text',d:'',cred:true,label:'account — a credential (Settings → Credentials) or «＋ new…» right here: it IS the server, the login and the password of the channel. Empty — no auth (Nostr anonymous, ntfy, public feeds; defaults: public relays, ntfy.sh, …)'},
    {n:'channel',t:'text',d:'dsp',label:'channel — nostr: hashtag · ntfy: topic · matrix: room (!id:server or #alias:server) · telegram: only to receive from ONE chat — its id or @name; leave empty for all chats (replies go to the last one) · irc: #channels · xmpp: room@conference.server (empty — direct messages only) · aprs: server filter (g/CALL, m/50, r/lat/lon/km, b/CALL*; empty — messages to you) · email: mailbox (empty — INBOX) · reticulum: the default recipient (32-digit address or a name heard in announces) · mastodon / bluesky: WHAT TO READ — #tags (several: any of them), -#tag drops posts with it, mastodon: «local» / «home» (token), empty — the public timeline; bluesky: @account, a feed link (bsky.app/profile/…/feed/…) or an at:// feed · rss: WORDS — any of them in the title / text / categories, -word drops an item; empty — everything'},
    {n:'attach',t:'text',d:'',label:'email: a file from Files (name or id) attached to what is sent'},
    {n:'attPath',t:'text',d:'mail/{from}',label:'email: folder in Files for incoming attachments — «/» makes subfolders; {from} address, {name}, {subject}, {date}, {year}, {month}, {thread}, {proto}',adv:true},
    {n:'contacts',t:'text',d:'',label:'contacts — extra aliases «Name=address» (comma-separated); wire a Table with name/addr columns into «rows» for a full address book'},
    {n:'poll',t:'range',min:5,max:600,step:5,d:30,label:'email / mastodon / bluesky / rss: check every, s (mastodon, bluesky: at least 5; rss: at least 60)'},
    {n:'nick',t:'text',d:'dsp',label:'nick (shown to others; in Chat set «my name» the same)'},
    {n:'history',t:'range',min:0,max:2592000,step:60,d:0,label:'also fetch what was said in the last, s (nostr, ntfy, matrix, xmpp; feeds: how far back the first read goes — 0 shows only what comes later)'},
    {n:'via',t:'select',opts:['auto','page','bridge'],d:'auto',label:'where TCP comes from (IRC ircs://, XMPP, APRS-IS, email): auto — the phone itself inside the DSP app, else the gateway below; bridge — always the gateway'},
    {n:'bridge',t:'text',d:'',dev:true,label:'TCP gateway — @name from Settings → Devices (the token stays there), or one address for either: the DSP app on a phone (ws://192.168.0.5:8765; the app must allow other pages) or the Node bridge (ws://127.0.0.1:8777); the type is detected'},
    {n:'plain',t:'check',d:false,label:'xmpp: allow a password without TLS (only for a server on your own network)'},
    {n:'proxy',t:'check',d:false,label:'rss: through the CORS proxy from Settings (a Node bridge in the gateway field needs none)'},
    {n:'reconnect',t:'check',d:true,label:'reconnect'},
    {n:'autoConnect',t:'check',d:false,label:'connect when the patch starts'},
    {n:'text',t:'text',d:'',label:'message'},
    {n:'go',t:'button',label:'Send',fn:n=>mgNodeSend(n,n.p.text)},
    {n:'connect',t:'button',label:'Connect',fn:n=>mgNodeStart(n)},
    {n:'disconnect',t:'button',label:'Disconnect',fn:n=>mgNodeStop(n)},
  ],
  init:n=>{ n.sess=null; n.ok=false; n.status='not connected'; n.warn=''; n.log=[]; n.recQ=[]; n.lastRow=null; n.fresh=0; n.count=0; n.lastSend=''; n.lastTo='';
            n.eph=''; n.mxCache={}; n.auto=false; n.contacts=null; n.lastContacts=undefined; n.book=[]; },
  dispose:n=>mgNodeStop(n),
  process(n,I){
    if(n.p.autoConnect && !n.auto){ n.auto=true; mgNodeStart(n); }
    if(Array.isArray(I.rows) && I.rows!==n.lastContacts){ n.lastContacts=I.rows; n.contacts=I.rows; }
    const book=[];
    for(const r of Array.isArray(n.contacts)?n.contacts:[]) if(r&&typeof r==='object') book.push(r);      // адресная книга: строки из «rows»…
    for(const pair of String(n.p.contacts||'').split(/[,;]/)){                                            // …и «Name=address» из параметра
      const i=pair.indexOf('='); if(i<1) continue;
      const nm=pair.slice(0,i).trim(), ad=pair.slice(i+1).trim();
      if(nm&&ad) book.push({name:nm,addr:ad});
    }
    n.book=book;
    const send=typeof I.send==='string' ? I.send : '';
    if(send && send!==n.lastSend) mgNodeSend(n,send,typeof I.to==='string' ? I.to : '');
    n.lastSend=send;
    const rec=n.recQ.length ? n.recQ.splice(0) : null, fresh=n.fresh; n.fresh=0;
    const r=n.lastRow;
    return {rec,text:fresh && r ? r.text : null,from:r ? r.from : null,new:fresh,ok:n.ok ? 1 : 0};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    let t=(n.warn && !n.ok ? '⚠ '+n.warn+'\n' : '')+n.p.proto+' · '+n.status+' · messages '+n.count;
    for(const row of n.log.slice(-8)){ const who=(row.dir==='out' && row.to) ? row.to : row.from;      // исходящее — с адресатом, не с собой
      t+='\n'+(row.dir==='out' ? '→ ' : '')+(who ? who+': ' : '')+((row.kind==='position' || row.kind==='status' ? (row.lat!=null ? '📍 '+row.lat.toFixed(4)+','+row.lon.toFixed(4)+' ' : '')+row.comment : row.text).slice(0,200)); }
    if(r.textContent!==t) r.textContent=t; }
});
