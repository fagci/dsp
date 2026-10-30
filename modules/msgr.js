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
  const bridge=String(p.bridge||'').trim() + (p.bridgeToken && /^wss?:/i.test(p.bridge||'') ? '?token='+encodeURIComponent(p.bridgeToken) : '');
  const cfg={server:String(p.server||'').trim() || MG_DEF_SERVER[proto] || '',channel:String(p.channel||'').trim(),user:String(p.user||'').trim(),pass:String(p.pass||''),
    nick:String(p.nick||'dsp').trim() || 'dsp',appKey:(()=>{ try{ return (window.DspApp && DspApp.appKey && DspApp.appKey()) || ''; }catch(e){ return ''; } })(),history:+p.history||0,retry:!!p.reconnect,via:p.via,proxyUrl:p.proxy && typeof Net!=='undefined' ? u=>Net.url(u) : null,smtp:String(p.smtp||'').trim(),pollMs:(+p.poll||30)*1000,bridge,insecure:!!p.plain,cache:n.mxCache};
  if(proto==='reticulum' && !cfg.pass.trim()){ try{ cfg.pass=mgHex(mgRandom(64)); p.pass=cfg.pass; n.status='new Reticulum identity made — it is kept in the «password» field'; }catch(e){ n.status='no secure random generator'; return; } }
  if(proto==='reticulum') cfg.key=cfg.pass;
  if(proto==='nostr'){ cfg.key=cfg.pass; if(!cfg.key){ try{ if(!n.eph) n.eph=mgHex(mgNostrGenKey()); cfg.key=n.eph; }catch(e){ n.status='no secure random generator'; return; } } }
  const inApp=(()=>{ try{ return !!(window.DspApp && DspApp.appKey); }catch(e){ return false; } })();
  if(p.via==='auto' && inApp && !cfg.bridge) cfg.phone={url:'ws://127.0.0.1:8765',key:cfg.appKey};   // внутри приложения свои сокеты; чужой шлюз — только по явному адресу
  n.warn=netInsecure(cfg.server) || (cfg.bridge && netInsecure(cfg.bridge)) ? NET_INSECURE_MSG : '';
  n.sess=mgConnect(proto,cfg,{
    msg:m=>{ if(m.delay && !cfg.history) return; mgNodeLog(n,m.self ? 'out' : 'in',m); },
    status:(t,s)=>{ n.status=t; n.ok=s==='up'; if(s==='fatal') n.sess=null; },
  });
}
function mgNodeSend(n,text,to){
  text=String(text||'').trim(); if(!text) return;
  if(!n.sess){ n.status='not connected — press Connect'; return; }
  Promise.resolve(n.sess.send(text,to||undefined)).then(ok=>{ if(!ok && n.sess && !/not sent/.test(n.status)) n.status+=' · not sent'; });
}

def({ id:'messenger', title:'Messenger (Nostr · ntfy · Matrix · Telegram · IRC · XMPP · APRS · Email · SMS · Reticulum · Mastodon · Bluesky · RSS)', cat:'Sources',
  kw:'messenger chat nostr ntfy matrix telegram bot irc xmpp jabber relay message channel push notify send receive internet',
  ins:[{n:'send',t:'txt'},{n:'to',t:'txt'}], outs:[{n:'rec',t:'rec'},{n:'text',t:'txt'},{n:'from',t:'txt'},{n:'new',t:'num'},{n:'ok',t:'num'}],
  readout:true, tall:true,
  params:[
    {n:'proto',t:'select',opts:['nostr','ntfy','matrix','telegram','irc','xmpp','aprs','email','sms','reticulum','mastodon','bluesky','rss'],d:'nostr',label:'channel of communication'},
    {n:'server',t:'text',d:'',label:'server — nostr: relays wss://… (several, space-separated; empty: public ones) · ntfy: https://… (empty: ntfy.sh) · matrix: https://homeserver · irc: wss://host/path, or ircs://host:6697 / irc://… via the bridge · xmpp: xmpp://host:5222, empty — by the domain of the account (bridge) · aprs: aprs://host:14580 (empty — rotate.aprs2.net, bridge) · email: IMAP imaps://host:993 or imap://host:143 (to receive; bridge) · sms: the phone app, empty — ws://127.0.0.1:8765 · reticulum: rns://host:port — the TCP server interface of a Reticulum node (needs TCP) · mastodon: instance https://… (empty — mastodon.social) · bluesky: empty — public.api.bsky.app (bsky.social after a login) · rss: feed addresses https://… (RSS, Atom, JSON Feed — several, separated by a space)'},
    {n:'channel',t:'text',d:'dsp',label:'channel — nostr: hashtag · ntfy: topic · matrix: room (!id:server or #alias:server) · telegram: only to receive from ONE chat — its id or @name; leave empty for all chats (replies go to the last one) · irc: #channels · xmpp: room@conference.server (empty — direct messages only) · aprs: server filter (g/CALL, m/50, r/lat/lon/km, b/CALL*; empty — messages to you) · email: mailbox (empty — INBOX) · reticulum: the default recipient (32-digit address or a name heard in announces) · mastodon / bluesky: WHAT TO READ — #tags (several: any of them), -#tag drops posts with it, mastodon: «local» / «home» (token), empty — the public timeline; bluesky: @account, a feed link (bsky.app/profile/…/feed/…) or an at:// feed · rss: WORDS — any of them in the title / text / categories, -word drops an item; empty — everything'},
    {n:'user',t:'text',d:'',label:'user — bluesky: your handle (needed only for the search by #tag) · matrix: login · xmpp: account user@domain · aprs: your callsign (N0CALL-7) · email: login, usually the address · irc / ntfy: optional'},
    {n:'pass',t:'text',d:'',label:'password / token (saved with the patch!) — nostr: nsec or hex key (empty — a new anonymous key each session) · matrix: password or access token · telegram: bot token from @BotFather · ntfy: token'},
    {n:'smtp',t:'text',d:'',label:'email: SMTP smtps://host:465 or smtp://host:587 (STARTTLS) — to send; a message is «@name@host subject line⏎text» or the «to» input'},
    {n:'poll',t:'range',min:5,max:600,step:5,d:30,label:'email / mastodon / bluesky / rss: check every, s (mastodon, bluesky: at least 5; rss: at least 60)'},
    {n:'nick',t:'text',d:'dsp',label:'nick (shown to others; in Chat set «my name» the same)'},
    {n:'history',t:'range',min:0,max:2592000,step:60,d:0,label:'also fetch what was said in the last, s (nostr, ntfy, matrix, xmpp; feeds: how far back the first read goes — 0 shows only what comes later)'},
    {n:'via',t:'select',opts:['auto','page','bridge'],d:'auto',label:'where TCP comes from (IRC ircs://, XMPP, APRS-IS, email): auto — the phone itself inside the DSP app, else the gateway below; bridge — always the gateway'},
    {n:'bridge',t:'text',d:'',label:'TCP gateway — one address for either: the DSP app on a phone (ws://192.168.0.5:8765; the app must allow other pages) or the Node bridge (ws://127.0.0.1:8777); the type is detected'},
    {n:'bridgeToken',t:'text',d:'',label:'gateway token (the app token or --token of the bridge; saved with the patch!)'},
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
            n.eph=''; n.mxCache={}; n.auto=false; },
  dispose:n=>mgNodeStop(n),
  process(n,I){
    if(n.p.autoConnect && !n.auto){ n.auto=true; mgNodeStart(n); }
    const send=typeof I.send==='string' ? I.send : '';
    if(send && send!==n.lastSend) mgNodeSend(n,send,typeof I.to==='string' ? I.to : '');
    n.lastSend=send;
    const rec=n.recQ.length ? n.recQ.splice(0) : null, fresh=n.fresh; n.fresh=0;
    const r=n.lastRow;
    return {rec,text:fresh && r ? r.text : null,from:r ? r.from : null,new:fresh,ok:n.ok ? 1 : 0};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    let t=(n.warn && !n.ok ? '⚠ '+n.warn+'\n' : '')+n.p.proto+' · '+n.status+' · messages '+n.count;
    for(const row of n.log.slice(-8)) t+='\n'+(row.dir==='out' ? '→ ' : '')+(row.from ? row.from+': ' : '')+(row.kind==='position' || row.kind==='status' ? (row.lat!=null ? '📍 '+row.lat.toFixed(4)+','+row.lon.toFixed(4)+' ' : '')+row.comment : row.text).slice(0,200);
    if(r.textContent!==t) r.textContent=t; }
});
