"use strict";
/* ============================ Messenger: узел ============================
   Один узел на тринадцать каналов связи — Nostr, ntfy, Matrix, Telegram (бот), IRC, XMPP, APRS-IS, почта (IMAP/SMTP), SMS (приложение DSP на Android), Reticulum/LXMF, ленты Mastodon и Bluesky, RSS / Atom. Протоколы — msgr-kernels.js
   и msgr-session.js (те же файлы грузит Node-мост tools/node/bridge.mjs). Из страницы напрямую: Nostr (реле wss://),
   ntfy, Matrix, Telegram, IRC по WebSocket (wss://). IRC по TCP (ircs://) и XMPP — через TCP-шлюз (поле bridge: Node-мост или приложение на телефоне).
   rec → Chat: {t, proto, dir, from, to, text}; свои сообщения приходят с from = nick — в Chat «my name» поставь тот же ник. */

const MG_KEEP=300;
const MG_DEF_SERVER={nostr:'wss://relay.damus.io wss://nos.lol',ntfy:'https://ntfy.sh'};
function mgNodeLog(n,dir,m){
  const row={t:m.t || Date.now(),proto:n.p.proto,dir,from:dir==='out' ? String(n.p.nick||'me') : mgClean(m.from||''),to:m.to||'',text:mgClean(m.text),id:m.id||''};
  if(m.atts && m.atts.length){
    row.atts=m.atts.map(a=>({name:a.name,mime:a.mime,size:a.size||((a.bytes||[]).length||0),...(a.fid!=null ? {fid:a.fid,path:a.path} : {}),...(a.kind ? {kind:a.kind} : {}),...(a.dur ? {dur:a.dur} : {})}));      // fid — номер файла в Files (его берёт Whisper и др.)
    row.text=(row.text?row.text+' ':'')+row.atts.map(a=>'[file: '+a.name+(a.size?' · '+(a.size/1024).toFixed(0)+' KB':'')+']').join(' ');
  }
  if(m.thread) row.thread=m.thread;
  if(m.ref) row.ref=m.ref;                                                    // на что ссылаются реакции (Telegram: чат:сообщение; в остальных — id)
  if(m.fromAddr) row.fromAddr=m.fromAddr;
  if(m.subject) row.subject=m.subject;
  const room=(m.to && /^[#&]/.test(m.to)) ? m.to : (['nostr','ntfy','matrix'].includes(n.p.proto) ? String(n.p.channel||'') : (n.p.proto==='xmpp' && m.to && m.to===String(n.p.channel||'').split('/')[0] ? m.to : ''));
  if(room) row.room=room;                                                  // комната / канал: Chat собирает такие сообщения в один разговор
  if(m.post) Object.assign(row,m.post);                                      // ленты: имя, ссылка, теги, язык, картинка, счётчики
  if(m.kind && m.kind!=='message'){ row.kind=m.kind; row.comment=m.comment||''; if(m.lat!=null){ row.lat=m.lat; row.lon=m.lon; row.symbol=m.symbol; row.name=row.id=row.from; } }   // APRS: станции — на Map
  n.log.push(row); if(n.log.length>MG_KEEP) n.log.shift();
  n.recQ.push(row); if(n.recQ.length>2000) n.recQ.shift();
  n.lastRow=row; n.fresh++; n.count++;
}
// журнал и счётчики узла: сообщения прежнего протокола / канала в новом соединении — мусор
function mgNodeReset(n){ n.log=[]; n.recQ=[]; n.count=0; n.lastRow=null; n.fresh=0; }
const mgNodeSig=n=>[n.p.proto,n.p.account,n.p.channel,n.p.bridge].map(x=>String(x||'')).join('\u0001');
function mgNodeStop(n){
  if(n.sess){ try{ n.sess.close(); }catch(e){} n.sess=null; }
  n.ok=false; n.status='disconnected';
}
function mgNodeStart(n){
  mgNodeStop(n);
  const sig=mgNodeSig(n); if(n.sig!==undefined && n.sig!==sig) mgNodeReset(n); n.sig=sig;      // другой протокол / канал / учётка — журнал с нуля; переподключение к тому же — журнал остаётся
  const p=n.p, proto=p.proto;
  const rawBridge=String(p.bridge||'').trim();
  if(rawBridge[0]==='@' && gwErr(rawBridge)){ n.status=gwErr(rawBridge); return; }
  const bridge=gwUrl(rawBridge) + (p.bridgeToken && /^wss?:/i.test(rawBridge) ? '?token='+encodeURIComponent(p.bridgeToken) : '');      // bridgeToken — из старых патчей; новый путь — токен в Settings → Devices
  const cfg={server:'',channel:String(p.channel||'').trim(),user:'',pass:'',
    nick:String(p.nick||'dsp').trim() || 'dsp',appKey:(()=>{ try{ return (window.DspApp && DspApp.appKey && DspApp.appKey()) || ''; }catch(e){ return ''; } })(),history:+p.history||0,retry:!!p.reconnect,via:p.via,proxyUrl:typeof Net!=='undefined' && Net.uses({p}) ? u=>Net.via({p},u) : null,smtp:'',pollMs:(+p.poll||30)*1000,bridge,insecure:!!p.plain,cache:n.mxCache};
  // прокси: свой (учётка типа proxy) или прокси устройства-моста из Settings → Devices; открывает его только Node-мост — без моста прямой выход не делаем молча
  const pxName=String(p.pxcred||'').trim() || (rawBridge[0]==='@' ? Gw.proxyOf(rawBridge) : '');
  if(pxName){
    const pc=(typeof Cred!=='undefined' && Cred.get(pxName))||null;
    if(!pc || !pc.server){ n.status='proxy «'+pxName+'» not found — add a credential of type «proxy» in Settings → Credentials'; return; }
    if(!bridge){ n.status='a proxy works through the Node bridge: set the gateway (Settings → Devices) — not connecting directly'; return; }
    cfg.proxy={server:pc.server,user:pc.user||'',pass:pc.pass||''}; cfg.via='bridge';
  }
  cfg.receipts_level=({off:0,delivered:1,'delivered + read':2})[String(p.receipts||'delivered')];     // что мы сообщаем собеседникам: ничего / доставлено / доставлено и прочитано
  if(n.regNext) cfg.register=true;                                     // «register this account» в форме учётки: при первом подключении создаём её на сервере
  const acct=String(p.account||'').trim();
  if(acct){                                                          // учётка — единственный источник сервера, логина и пароля
    const cr=(typeof Cred!=='undefined' && Cred.get(acct))||null;
    if(!cr){ n.status='credential «'+acct+'» not found — add it in Settings → Credentials or with «＋ new…» here'; return; }
    if(cr.server) cfg.server=cr.server;
    if(cr.user) cfg.user=cr.user;
    if(cr.pass) cfg.pass=cr.pass;
    if(cr.smtp) cfg.smtp=cr.smtp;
  }
  const own=String(p.server||'').trim();
  if(own) cfg.server=own;                                            // адрес, набранный в самом узле, главнее адреса из учётки (учётка тогда даёт только логин и пароль)
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
    msg:m=>{
      if(m.kind==='status'){ n.recQ.push({t:m.t||Date.now(),proto:p.proto,dir:'in',kind:'status',target:String(m.target||''),state:String(m.state||''),author:String(m.author||''),detail:String(m.detail||''),room:m.room||'',to:m.to||'',text:'',from:String(m.author||''),id:m.id||''}); return; }     // статус доставки / прочтения — событие для Chat
      if(m.kind==='edit' || m.kind==='delete'){ n.recQ.push({t:m.t||Date.now(),proto:p.proto,dir:m.self ? 'out' : 'in',kind:m.kind,target:String(m.target||''),author:String(m.author||''),text:m.kind==='edit' ? String(m.text||'') : '',room:m.room||'',to:m.to||'',from:String(m.author||''),force:!!m.force,id:m.id||''}); return; }     // правка / удаление — событие для Chat, не строка журнала
      if(m.kind==='reaction'){ n.recQ.push({t:m.t||Date.now(),proto:p.proto,dir:m.self ? 'out' : 'in',kind:'reaction',target:String(m.target||''),author:String(m.author||''),emojis:m.emojis||[],op:m.op||'add',room:m.room||'',to:m.to||'',text:'',from:String(m.author||''),id:m.id||''}); return; }     // реакция — событие для Chat, не строка журнала
      if(m.kind==='roster'){ n.recQ.push({t:m.t||Date.now(),proto:p.proto,dir:'in',kind:'roster',contacts:m.contacts||[],text:'',from:''}); n.status='roster: '+(m.contacts||[]).length+' contact(s)'; return; }     // список контактов — в rec (для Contacts), не в чат
      if(m.delay && !cfg.history) return;
      if(m.atts && m.atts.length && typeof FileStore!=='undefined'){      // вложение сначала ложится в Files (получает номер), и только потом запись уходит на выход: по номеру её находят Whisper и другие
        n.saveQ=(n.saveQ||Promise.resolve()).then(()=>mgNodeSaveAtts(n,m)).catch(()=>{}).then(()=>mgNodeLog(n,m.self ? 'out' : 'in',m));
        return;
      }
      mgNodeLog(n,m.self ? 'out' : 'in',m);
    },
    status:(t,s)=>{ n.status=t; n.ok=s==='up'; if(/^registered\b|already registered/.test(t)) n.regNext=false; if(s==='fatal') n.sess=null; },
  });
}
function mgNodeModify(n,r){                                 // правка / удаление / «прочитано» от Chat: {op:'edit'|'delete'|'read', target, text, room, to}
  if(!n.sess){ if(r.op!=='read') n.status='not connected — press Connect'; return; }
  if(r.op==='read'){ try{ Promise.resolve(n.sess.ack ? n.sess.ack(r) : false).catch(()=>{}); }catch(e){} return; }      // молча: протокол без квитанций или настройка не разрешает
  Promise.resolve(n.sess.modify ? n.sess.modify(r) : false).then(ok=>{ if(!ok && !/edit|delete|change|Matrix|Telegram|Nostr|XMPP/.test(n.status||'')) n.status=n.p.proto+': editing and deleting are not supported here'; }).catch(()=>{});
}
function mgNodeReact(n,r){                                  // реакция от Chat: {target, emoji, on, mine, room, to}
  if(!n.sess){ n.status='not connected — press Connect'; return; }
  Promise.resolve(n.sess.react ? n.sess.react(r) : false).then(ok=>{ if(!ok && !/react|reaction|Matrix|Telegram|Nostr|XMPP/.test(n.status||'')) n.status=n.p.proto+': reactions are not supported here'; }).catch(()=>{});
}
function mgNodeSend(n,text,to){
  text=String(text||'').trim(); if(!text && !(n.p.proto==='telegram' && String(n.p.attach||'').trim())) return;      // телеграм: файл можно отправить и без текста
  if(!n.sess){ n.status='not connected — press Connect'; return; }
  (async()=>{
    if(!to && n.book && n.book.length && text[0]==='@'){                     // адресная книга: @alias → @адрес из контактов
      const m=/^@(\S+)\s?/.exec(text), addr=m ? mgAddrResolve(n.book,m[1]) : '';
      if(addr) text='@'+addr+text.slice(m[0].length);
    }
    let atts=null;
    const ref=String(n.p.attach||'').trim();
    if((n.p.proto==='email' || n.p.proto==='telegram') && ref){
      atts=await mgLoadAtts(ref);
      if(!atts) n.status='attachment «'+ref+'» not found in Files';
    }
    return n.sess.send(text,to||undefined,atts||undefined);
  })().then(ok=>{ if(!ok && n.sess && !/not sent|not found/.test(n.status)) n.status+=' · not sent'; });
}
/* записи с вложениями (atts[].fid — номер в Files) → отправка файлов; подпись — поле caption или text записи */
function mgNodeSendFiles(n,input,to){
  if(!n.sess){ n.status='not connected — press Connect'; return; }
  if(n.p.proto!=='telegram' && n.p.proto!=='email'){ n.status=n.p.proto+': sending files is not supported here (telegram, email)'; return; }
  (async()=>{
    for(const r of Array.isArray(input) ? input : [input]){
      if(!r || typeof r!=='object' || !Array.isArray(r.atts)) continue;
      const atts=[];
      for(const a of r.atts){ if(a && a.fid!=null){ const x=await mgLoadAtts(String(a.fid)); if(x) atts.push(...x); } }
      if(!atts.length){ n.status='file not found in Files'; continue; }
      const ok=await n.sess.send(String(r.caption||''),to||r.room||undefined,atts);
      if(!ok && n.sess && !/not sent/.test(n.status)) n.status+=' · not sent';
    }
  })().catch(e=>{ n.status='send files: '+e.message; });
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
  if(!m.atts || !m.atts.length || typeof FileStore==='undefined') return Promise.resolve();
  return (async()=>{
    try{
      const tpl=n.p.proto==='telegram' && (n.p.attPath||'mail/{from}')==='mail/{from}' ? 'telegram/{from}' : n.p.attPath;
      const path=mgAttPath(tpl,m,n.p.proto);                 // по шаблону «mail/{from}»: вложенные папки создаются по пути
      let dir=null;
      for(const name of path){
        let f=(await FileStore.listFolders('files',dir?dir.id:null).catch(()=>[])).find(x=>x.name===name);
        if(!f) f=await FileStore.addFolder('files',name,dir?dir.id:null).catch(()=>null);
        if(!f){ dir=null; break; }
        dir=f;
      }
      for(const a of m.atts){
        const blob=new Blob([a.bytes],{type:a.mime});
        a.fid=await FileStore.put({space:'files',folderId:dir?dir.id:null,name:a.name,mime:a.mime,blob,
          meta:{from:m.fromAddr||m.from||'',subject:m.subject||'',t:m.t||Date.now(),...(m.ref ? {ref:m.ref} : {})}});
        a.path=path.join('/')+'/'+a.name;
      }
      n.status='saved '+m.atts.length+' attachment(s) → Files/'+path.join('/');
    }catch(e){ n.status='attachment save failed: '+e.message; }
  })();
}

def({ id:'messenger', title:'Messenger (Nostr · ntfy · Matrix · Telegram · IRC · XMPP · APRS · Email · SMS · Reticulum · Mastodon · Bluesky · RSS)', cat:'Sources',
  kw:'messenger chat nostr ntfy matrix telegram bot irc xmpp jabber relay message channel push notify send receive internet',
  ins:[{n:'send',t:'txt'},{n:'to',t:'txt'},{n:'rows',t:'bands'},{n:'react',t:'rec'},{n:'edit',t:'rec'},{n:'file',t:'rec'}], outs:[{n:'rec',t:'rec'},{n:'text',t:'txt'},{n:'from',t:'txt'},{n:'new',t:'num'},{n:'ok',t:'num'}],
  readout:true, tall:true,
  params:[
    {n:'proto',t:'select',opts:['nostr','ntfy','matrix','telegram','irc','xmpp','aprs','email','sms','reticulum','mastodon','bluesky','rss'],d:'nostr',fn:n=>{ mgNodeStop(n); mgNodeReset(n); n.sig=undefined; n.status='not connected'; },label:'protocol'},
    {n:'server',t:'text',d:'',label:'server',tip:'where to connect — nostr: relays wss://… (several, separated by a space; empty — public ones) · ntfy: https://ntfy.sh (empty — that one) · matrix: https://matrix.org · telegram: empty · irc: ircs://irc.libera.chat:6697 or wss://… · xmpp: xmpp://host:5222 (empty — the domain of the login) · aprs: aprs://rotate.aprs2.net:14580 · email: imaps://imap.gmail.com:993 (SMTP — in the account) · mastodon: https://mastodon.social · bluesky: https://public.api.bsky.app · rss: feed addresses https://…, several separated by a space · reticulum: rns://host:port. Typed here it wins over the server of the account (the account then gives only the login and password)',if:n=>n.p.proto!=='sms'},
    {n:'pxcred',t:'text',d:'',cred:true,credType:'proxy',label:'proxy',tip:'proxy — a credential of type «proxy» (socks5://… or http://…): the Node bridge opens everything through it (IRC, XMPP, e-mail, Matrix, Nostr, feeds…). Empty — the proxy of the gateway in Settings → Devices, or the bridge\'s own --proxy',adv:true,if:n=>n.p.proto!=='sms'},
    {n:'account',t:'text',d:'',cred:true,label:'account',tip:'account — a credential (Settings → Credentials) or «＋ new…» right here: it IS the server, the login and the password of the channel. Empty — no auth (Nostr anonymous, ntfy, public feeds; defaults: public relays, ntfy.sh, …)',if:n=>!['sms','rss'].includes(n.p.proto)},
    {n:'channel',t:'text',d:'dsp',label:'channel / room / topic',tip:'channel — nostr: hashtag · ntfy: topic · matrix: room (!id:server or #alias:server) · telegram: only to receive from ONE chat — its id or @name; leave empty for all chats (replies go to the last one) · irc: #channels · xmpp: room@conference.server (empty — direct messages only) · aprs: server filter (g/CALL, m/50, r/lat/lon/km, b/CALL*; empty — messages to you) · email: mailbox (empty — INBOX) · reticulum: the default recipient (32-digit address or a name heard in announces) · mastodon / bluesky: WHAT TO READ — #tags (several: any of them), -#tag drops posts with it, mastodon: «local» / «home» (token), empty — the public timeline; bluesky: @account, a feed link (bsky.app/profile/…/feed/…) or an at:// feed · rss: WORDS — any of them in the title / text / categories, -word drops an item; empty — everything',if:n=>n.p.proto!=='sms'},
    {n:'attach',t:'text',d:'',label:'attach file (email, telegram)',tip:'email, telegram: a file from Files (name or id) sent along with the message; telegram picks the kind by type — .ogg/.opus voice message, other audio, jpeg/png/webp photo, mp4 video, the rest a document (up to 50 MB); the message text becomes the caption (up to 1024 characters)',if:n=>n.p.proto==='email' || n.p.proto==='telegram'},
    {n:'attPath',t:'text',d:'mail/{from}',label:'attachments folder',tip:'email, telegram (voice messages, audio, documents; telegram with the default value uses telegram/{from}): folder in Files for incoming attachments — «/» makes subfolders; {from} address, {name}, {subject}, {date}, {year}, {month}, {thread}, {proto}',adv:true,if:n=>n.p.proto==='email' || n.p.proto==='telegram'},
    {n:'contacts',t:'text',d:'',label:'aliases (Name=addr)',tip:'contacts — extra aliases «Name=address» (comma-separated); wire a Table with name/addr columns into «rows» for a full address book',if:n=>!['mastodon','bluesky','rss'].includes(n.p.proto)},
    {n:'poll',t:'range',min:5,max:600,step:5,d:30,label:'check every, s',tip:'email / mastodon / bluesky / rss: check every, s (mastodon, bluesky: at least 5; rss: at least 60)',if:n=>['email','mastodon','bluesky','rss'].includes(n.p.proto)},
    {n:'nick',t:'text',d:'dsp',label:'nick',tip:'nick (shown to others; in Chat set «my name» the same)',if:n=>['nostr','ntfy','matrix','telegram','irc','xmpp','reticulum'].includes(n.p.proto)},
    {n:'receipts',t:'select',opts:['off','delivered','delivered + read'],d:'delivered',label:'receipts',tip:'what this node tells the other side: delivered — confirms delivery of direct messages when the other client asks (XMPP, XEP-0184); delivered + read — also marks messages as read when you open the conversation in a Chat (Matrix read receipts, XMPP XEP-0333); off — nothing. What others tell you (✓✓, read) is always shown',adv:true,if:n=>['matrix','xmpp'].includes(n.p.proto)},
    {n:'font',t:'range',min:8,max:16,step:1,d:10,label:'font size',tip:'font size of the messages in the node, px',adv:true},
    {n:'history',t:'range',min:0,max:2592000,step:60,d:0,label:'fetch history, s',tip:'also fetch what was said in the last, s (nostr, ntfy, matrix, xmpp; feeds: how far back the first read goes — 0 shows only what comes later)',adv:true,if:n=>['nostr','ntfy','matrix','xmpp','mastodon','bluesky','rss'].includes(n.p.proto)},
    {n:'via',t:'select',opts:['auto','page','bridge'],d:'auto',label:'connection',tip:'where TCP comes from (IRC ircs://, XMPP, APRS-IS, email): auto — the phone itself inside the DSP app, else the gateway below; bridge — always the gateway',adv:true,if:n=>n.p.proto!=='sms'},
    {n:'bridge',t:'text',d:'',dev:true,label:'gateway',tip:'TCP gateway — @name from Settings → Devices (the token stays there), or one address for either: the DSP app on a phone (ws://192.168.0.5:8765; the app must allow other pages) or the Node bridge (ws://127.0.0.1:8777); the type is detected',if:n=>['irc','xmpp','aprs','email','reticulum','rss'].includes(n.p.proto) || n.p.via==='bridge' || !!n.p.bridge || !!n.p.pxcred},
    {n:'plain',t:'check',d:false,label:'plain password (xmpp)',tip:'xmpp: allow a password without TLS (only for a server on your own network)',adv:true,if:n=>n.p.proto==='xmpp'},
    {n:'proxy',t:'check',d:false,label:'via CORS proxy (rss, telegram files)',tip:'rss: through the CORS proxy from Settings (a Node bridge in the gateway field needs none) · telegram: voice messages and files are downloaded from a host without CORS headers — in the DSP app the phone does it, in a browser only this proxy helps',adv:true,if:n=>n.p.proto==='rss' || n.p.proto==='telegram'},
    {n:'reconnect',t:'check',d:true,label:'reconnect',adv:true},
    {n:'autoConnect',t:'check',d:false,label:'connect at start',tip:'connect when the patch starts',adv:true},
    {n:'text',t:'text',d:'',label:'message'},
    {n:'go',t:'button',label:'Send',fn:n=>mgNodeSend(n,n.p.text)},
    {n:'connect',t:'button',label:'Connect',fn:n=>mgNodeStart(n)},
    {n:'disconnect',t:'button',label:'Disconnect',fn:n=>mgNodeStop(n)},
    {n:'clear',t:'button',label:'Clear log',fn:n=>{ mgNodeReset(n); }},
  ],
  init:n=>{ n.regNext=false; n.sess=null; n.ok=false; n.status='not connected'; n.warn=''; n.log=[]; n.recQ=[]; n.lastRow=null; n.fresh=0; n.count=0; n.lastSend=''; n.lastTo='';
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
    if(I.edit && I.edit!==n.lastEdit){ n.lastEdit=I.edit; for(const r of Array.isArray(I.edit) ? I.edit : [I.edit]) if(r && typeof r==='object') mgNodeModify(n,r); }
    if(I.react && I.react!==n.lastReact){ n.lastReact=I.react; for(const r of Array.isArray(I.react) ? I.react : [I.react]) if(r && typeof r==='object') mgNodeReact(n,r); }
    if(I.file && I.file!==n.lastFile){ n.lastFile=I.file; mgNodeSendFiles(n,I.file,typeof I.to==='string' ? I.to : ''); }      // файлы из Files по записям (Record Audio, Record Video, камера…): отправить в чат
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
    const fs=Math.max(8,Math.min(16,+n.p.font||10))+'px'; if(r.style.fontSize!==fs) r.style.fontSize=fs;      // 12 px у общего .readout.tall — для сообщений крупно
    if(r.textContent!==t) r.textContent=t; }
});
