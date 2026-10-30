"use strict";
/* ============================ Мессенджеры: сессии ============================
   Один интерфейс на все каналы: mgConnect(proto, cfg, cb) → {send(text,to), close()}.
   Работает и в странице, и в Node-мосте (tools/node/bridge.mjs) — транспорт подставляется через cfg.io:
   {ws(url) → WebSocket, fetch, tcp(host,port,tls,h) → {write,upgrade(done),close}}, по умолчанию — глобальные.
   proto: nostr | ntfy | matrix | telegram | irc | xmpp | aprs | email | sms | reticulum.
   cfg:   server, channel, user, pass, nick, key (Nostr), token, history (сек), verify, retry, bridge, via, io.
   cb:    msg({from,to,text,t,self,…}), status(text, state), state: connecting | up | down | warn | fatal.
   Свои сообщения приходят обратно тем же msg с self:true (от сервера или, где сервер не возвращает, локально). */

const MG_RETRY_MS=3000;
const mgIo=cfg=>({ws:u=>new WebSocket(u),fetch:(...a)=>fetch(...a),tcp:cfg.phone ? mgPhoneTcp(cfg.phone) : null,...(cfg.io||{})});
const mgAuthHdr=cfg=>{
  if(cfg.token) return {authorization:'Bearer '+cfg.token};
  if(cfg.user && cfg.pass) return {authorization:'Basic '+mgB64(mgUtf8(cfg.user+':'+cfg.pass))};
  return {};
};
const mgTrim=s=>String(s||'').replace(/\/+$/,'');
const mgNone={send:()=>false,close(){}};

/* ---------- TCP/TLS через приложение DSP на Android (NetHub.kt: tcp.connect {tls|starttls}, tcp.starttls, tcp.send, tcp.close) ----------
   Даёт сессиям IRC / XMPP / APRS-IS / почты тот же io.tcp, что у Node-моста, — без Node: сокеты открывает телефон, а TLS — системный Android.
   ph: {url, key, io}. Команды приложение выполняет в пуле потоков, порядок не гарантирован — поэтому tcp.send ждёт ответ на каждый кусок. */
function mgPhoneTcp(ph){
  return (host,port,tls,h,o)=>{
    o=o||{}; const bin=!!o.binary, io=mgIo({io:ph.io});
    const stub={write(){},close(){},upgrade(){}};
    let u; try{ u=new URL(String(ph.url||'').trim() || 'ws://127.0.0.1:8765'); }catch(e){ setTimeout(()=>h.close('bad address of the phone app'),0); return stub; }
    if(ph.key && /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/.test(u.hostname) && !u.searchParams.has('k')) u.searchParams.set('k',ph.key);
    let ws; try{ ws=io.ws(u.toString()); }catch(e){ setTimeout(()=>h.close(e.message),0); return stub; }
    const ns=new NetSock(x=>ws.send(JSON.stringify(x)));
    const dec=new TextDecoder();
    let conn=null, dead=false, chain=Promise.resolve();
    const fail=err=>{ if(dead) return; dead=true; try{ ws.close(); }catch(e){} h.close(err||''); };
    ns.hooks.add(r=>{
      if(conn===null || r.conn!==conn || r.proto==='udp') return;
      if(r.ev==='data'){
        if(bin){ let t=''; for(let i=0;i<r.hex.length;i+=2) t+=String.fromCharCode(parseInt(r.hex.substr(i,2),16)); h.data(t); }
        else h.data(dec.decode(mgUnhex(r.hex),{stream:true}));
      } else if(r.ev==='close') fail('');
    });
    ws.onopen=()=>{
      ws.send(JSON.stringify({sub:['net']}));
      ns.call('tcp.connect',{host,port,timeout:15000,tls:!!tls,starttls:!tls},25000,r=>{ conn=r.conn; })
        .then(()=>{ if(!dead && h.open) h.open(); },e=>fail(e.reply && e.reply.err==='forbidden' ? 'the phone app refused the socket: open this page inside the app, or tick «Let any page use actions» in the app Settings' : e.message));
    };
    ws.onmessage=e=>{ let r; try{ r=JSON.parse(String(e.data)); }catch(x){ return; } ns.feed(r); };
    ws.onerror=()=>{};
    ws.onclose=()=>fail('phone app connection closed');
    return {
      write(s){
        const bytes=bin ? Uint8Array.from(s,c=>c.charCodeAt(0)&255) : mgUtf8(s);
        chain=chain.then(async()=>{ for(let i=0;i<bytes.length;i+=32768) await ns.call('tcp.send',{conn,hex:mgHex(bytes.subarray(i,i+32768))}); }).catch(e=>fail(e.message));
      },
      close(){ dead=true; if(conn!==null) ns.call('tcp.close',{conn}).catch(()=>{}); setTimeout(()=>{ try{ ws.close(); }catch(e){} },150); },
      upgrade(done){ chain=chain.then(()=>ns.call('tcp.starttls',{conn,sni:host},20000)).then(()=>done(),e=>fail(e.message)); },
    };
  };
}

/* ---------- Nostr: реле по WebSocket, канал = хэштег (тег t) ---------- */
function mgOpenNostr(cfg,c){
  const io=mgIo(cfg), relays=String(cfg.server||'').split(/[\s,]+/).filter(r=>/^wss?:\/\//i.test(r));
  const chan=String(cfg.channel||'').trim().replace(/^#/,'');
  if(!relays.length){ c.down('Nostr: enter a relay address wss://…',true); return mgNone; }
  if(!chan){ c.down('Nostr: enter a channel (hashtag)',true); return mgNone; }
  let sk=null;
  if(String(cfg.key||'').trim()){ sk=mgNostrKey(cfg.key); if(!sk){ c.down('Nostr: the key must be nsec1… or 64 hex digits',true); return mgNone; } }
  else sk=mgNostrGenKey();
  const me=mgHex(mgSchnorrPub(sk)), seen=new Set(), sub='dsp'+mgHex(mgRandom(4));
  const since=Math.floor(Date.now()/1000)-Math.max(0,cfg.history|0);
  let closed=false, lastErr='';
  const note=()=>{ const up=conns.filter(r=>r.up).length; c.status('relays '+up+'/'+conns.length+(lastErr ? ' · '+lastErr : '')+' · '+mgNpub(me).slice(0,16)+'…',up ? 'up' : 'connecting'); };
  function frame(text){
    const f=mgNostrFrame(text); if(!f) return;
    if(f.type==='EVENT'){
      const ev=f.a[2]; if(!ev || typeof ev.id!=='string' || seen.has(ev.id)) return;
      const t=mgNostrText(ev,chan); if(!t) return;                       // чужой канал — без дорогой проверки подписи
      if(cfg.verify!==false && !mgNostrVerify(ev)) return;
      seen.add(ev.id); if(seen.size>5000) seen.delete(seen.values().next().value);
      c.msg({id:ev.id,from:t.from,text:t.text,t:(+ev.created_at||0)*1000,self:ev.pubkey===me});
    } else if(f.type==='OK' && f.a[2]===false) lastErr='rejected: '+String(f.a[3]||'').slice(0,60), note();
    else if(f.type==='NOTICE') lastErr=String(f.a[1]||'').slice(0,60), note();
  }
  const conns=relays.map(url=>{
    const r={url,ws:null,up:false,t:null};
    r.go=()=>{
      if(closed) return;
      let ws; try{ ws=io.ws(url); }catch(e){ lastErr=e.message; r.t=setTimeout(r.go,5000); return; }
      r.ws=ws;
      ws.onopen=()=>{ r.up=true; try{ ws.send(mgNostrReq(sub,chan,since)); }catch(e){} note(); };
      ws.onmessage=e=>frame(String(e.data));
      ws.onerror=()=>{ lastErr='relay error'; };
      ws.onclose=()=>{ r.up=false; r.ws=null; note(); if(!closed) r.t=setTimeout(r.go,5000); };
    };
    return r;
  });
  conns.forEach(r=>r.go()); note();
  return {
    send(text){
      const ev=mgNostrSign(sk,{created_at:Math.floor(Date.now()/1000),kind:1,tags:[['t',chan.toLowerCase()],['nick',String(cfg.nick||'dsp')],['client','dsp']],content:String(text)});
      let n=0; for(const r of conns) if(r.up && r.ws){ try{ r.ws.send(JSON.stringify(['EVENT',ev])); n++; }catch(e){} }
      return n>0;
    },
    close(){ closed=true; for(const r of conns){ clearTimeout(r.t); const ws=r.ws; if(ws){ ws.onopen=ws.onmessage=ws.onerror=ws.onclose=null; try{ ws.close(); }catch(e){} } } },
  };
}

/* ---------- ntfy: поток JSON по HTTP, публикация POST ---------- */
function mgOpenNtfy(cfg,c){
  const io=mgIo(cfg), server=mgTrim(cfg.server||'https://ntfy.sh'), topic=String(cfg.channel||'').trim();
  if(!topic){ c.down('ntfy: enter a topic',true); return mgNone; }
  const base=server+'/'+encodeURIComponent(topic), sid='dsp-'+mgHex(mgRandom(4)), ac=new AbortController();
  let closed=false, last='';
  const since=Math.floor(Date.now()/1000)-Math.max(0,cfg.history|0);
  (async()=>{
    try{
      const r=await io.fetch(base+'/json?since='+(last||since),{headers:mgAuthHdr(cfg),signal:ac.signal});
      if(!r.ok){ c.down('ntfy: HTTP '+r.status,r.status===401 || r.status===403 || r.status===404); return; }
      c.status('subscribed to '+topic,'up');
      const rd=r.body.getReader(), dec=new TextDecoder(), st={};
      for(;;){
        const {done,value}=await rd.read(); if(done) break;
        for(const l of mgLines(st,dec.decode(value,{stream:true}))){
          const m=mgNtfyLine(l); if(!m) continue;
          last=m.id; c.msg({...m,self:m.tags.includes(sid)});
        }
      }
      if(!closed) c.down('ntfy: stream ended',false);
    }catch(e){ if(!closed) c.down('ntfy: '+e.message,false); }
  })();
  return {
    async send(text){
      const nick=String(cfg.nick||'dsp'), hdr={...mgAuthHdr(cfg),tags:sid,title:/^[\x20-\x7e]*$/.test(nick) ? nick : '=?UTF-8?B?'+mgB64(mgUtf8(nick))+'?='};
      try{ const r=await io.fetch(base,{method:'POST',body:String(text),headers:hdr}); if(!r.ok) c.status('ntfy: send failed, HTTP '+r.status,'warn'); return r.ok; }
      catch(e){ c.status('ntfy: '+e.message,'warn'); return false; }
    },
    close(){ closed=true; try{ ac.abort(); }catch(e){} },
  };
}

/* ---------- Matrix: /sync (long poll) и send ---------- */
function mgOpenMatrix(cfg,c){
  const io=mgIo(cfg), hs=mgTrim(cfg.server), ac=new AbortController(), cache=cfg.cache||{};
  if(!/^https?:\/\//i.test(hs)){ c.down('Matrix: enter the homeserver address https://…',true); return mgNone; }
  let closed=false, token=cfg.token || (!cfg.user ? cfg.pass : '') || cache.token || '', me=cache.userId||'', room=String(cfg.channel||'').trim(), txn=0;
  const api=p=>hs+'/_matrix/client/v3'+p;
  const call=async(method,path,body)=>{
    const r=await io.fetch(api(path),{method,signal:ac.signal,headers:{...(token ? {authorization:'Bearer '+token} : {}),...(body ? {'content-type':'application/json'} : {})},body:body ? JSON.stringify(body) : undefined});
    let j=null; try{ j=await r.json(); }catch(e){}
    return {ok:r.ok,status:r.status,j:j||{}};
  };
  (async()=>{
    try{
      if(!token){
        if(!cfg.user || !cfg.pass){ c.down('Matrix: enter a user and password, or an access token in the password field',true); return; }
        c.status('logging in…','connecting');
        const r=await call('POST','/login',{type:'m.login.password',identifier:{type:'m.id.user',user:cfg.user},password:cfg.pass,initial_device_display_name:'DSP workbench'});
        if(!r.ok){ c.down('Matrix: login refused — '+(r.j.error||r.status),r.status!==429 && r.status<500); return; }
        token=r.j.access_token; me=r.j.user_id||''; cache.token=token; cache.userId=me;
      }
      if(!me){
        const r=await call('GET','/account/whoami');
        if(!r.ok){ cache.token=''; c.down('Matrix: token refused — '+(r.j.error||r.status),r.status===401 || r.status===403); return; }
        me=r.j.user_id; cache.userId=me;
      }
      if(room){
        const r=await call('POST','/join/'+encodeURIComponent(room),{});
        if(!r.ok){ c.down('Matrix: cannot join '+room+' — '+(r.j.error||r.status),r.status===403 || r.status===404); return; }
        room=r.j.room_id||room;
      }
      c.status('connected as '+me+(room ? ', room '+room : ''),'up');
      const filter=encodeURIComponent(JSON.stringify({room:{...(room ? {rooms:[room]} : {}),timeline:{limit:50,types:['m.room.message']},state:{types:[]},ephemeral:{types:[]},account_data:{types:[]}},presence:{types:[]},account_data:{types:[]}}));
      let next=null, first=true;
      while(!closed){
        const r=await call('GET','/sync?filter='+filter+'&timeout='+(first ? 0 : 25000)+(next ? '&since='+encodeURIComponent(next) : ''));
        if(!r.ok){ if(r.status===401){ cache.token=''; c.down('Matrix: token expired',true); } else c.down('Matrix: sync '+r.status+' '+(r.j.error||''),false); return; }
        const s=mgMatrixSync(r.j,room,me); next=s.next || next;
        if(first){ first=false; if(!(cfg.history|0)) continue; }          // первый ответ — недавняя история: пропускаем, если не просили
        for(const m of s.msgs) c.msg(m);
      }
    }catch(e){ if(!closed) c.down('Matrix: '+e.message,false); }
  })();
  return {
    async send(text){
      if(!room){ c.status('Matrix: set the room (!id:server or #alias:server) to send','warn'); return false; }
      try{
        const r=await call('PUT','/rooms/'+encodeURIComponent(room)+'/send/m.room.message/dsp'+Date.now()+'_'+(++txn),{msgtype:'m.text',body:String(text)});
        if(!r.ok) c.status('Matrix: send failed — '+(r.j.error||r.status),'warn');
        return r.ok;
      }catch(e){ c.status('Matrix: '+e.message,'warn'); return false; }
    },
    close(){ closed=true; try{ ac.abort(); }catch(e){} },
  };
}

/* ---------- Telegram Bot API: getUpdates (long poll) и sendMessage ---------- */
function mgOpenTelegram(cfg,c){
  const io=mgIo(cfg), token=String(cfg.token || cfg.pass || '').trim(), ac=new AbortController();
  if(!token){ c.down('Telegram: enter the bot token (from @BotFather) in the password field',true); return mgNone; }
  const base=mgTrim(cfg.server && /^https?:/i.test(cfg.server) ? cfg.server : 'https://api.telegram.org')+'/bot'+token+'/';
  let closed=false, lastChat=null, offset=0, ignored=0, botName='';
  const call=async(m,params)=>{
    const r=await io.fetch(base+m,{method:'POST',signal:ac.signal,headers:{'content-type':'application/json'},body:JSON.stringify(params||{})});
    let j=null; try{ j=await r.json(); }catch(e){}
    return j || {ok:false,error_code:r.status,description:'HTTP '+r.status};
  };
  (async()=>{
    try{
      const me=await call('getMe');
      if(!me.ok){ c.down('Telegram: '+(me.description||'error'),me.error_code===401 || me.error_code===404); return; }
      botName=me.result.username; c.status('connected as @'+botName+' — write to the bot','up');
      while(!closed){
        const r=await call('getUpdates',{timeout:25,offset,allowed_updates:['message','channel_post']});
        if(!r.ok){ c.down('Telegram: '+(r.description||'getUpdates failed'),r.error_code===401); return; }
        const u=mgTgUpdates(r,cfg.channel);
        offset=Math.max(offset,u.next); if(u.last!==null) lastChat=u.last;
        if(u.skipped){ ignored+=u.skipped; c.status('Telegram: @'+botName+' · '+ignored+' message(s) from other chats ignored — the channel «'+cfg.channel+'» is a chat filter, clear it to receive from all chats','up'); }
        for(const m of u.msgs) c.msg(m);
      }
    }catch(e){ if(!closed) c.down('Telegram: '+e.message,false); }
  })();
  return {
    async send(text,to){
      const chat=String(to || cfg.channel || lastChat || '').trim();
      if(!chat){ c.status('Telegram: no chat yet — write to the bot first, or set the channel (chat id / @name)','warn'); return false; }
      try{
        for(const part of mgSplit(text,3500)){
          const r=await call('sendMessage',{chat_id:/^-?\d+$/.test(chat) ? +chat : chat,text:part});
          if(!r.ok){ c.status('Telegram: '+(r.description||'send failed'),'warn'); return false; }
        }
        c.msg({from:String(cfg.nick||'me'),to:chat,text:String(text),t:Date.now(),self:true,local:true});
        return true;
      }catch(e){ c.status('Telegram: '+e.message,'warn'); return false; }
    },
    close(){ closed=true; try{ ac.abort(); }catch(e){} },
  };
}

/* ---------- IRC: WebSocket (ws:// wss://) или TCP через io.tcp (irc:// ircs://) ---------- */
function mgOpenIrc(cfg,c){
  const io=mgIo(cfg), srv=String(cfg.server||'').trim();
  const chans=String(cfg.channel||'').split(/[\s,]+/).filter(Boolean).map(x=>/^[#&+!]/.test(x) ? x : '#'+x);
  let link=null, closed=false;
  const cl=mgIrcClient({nick:cfg.nick||cfg.user||'dsp',user:cfg.user,pass:cfg.pass,channels:chans,
    write:l=>{ try{ link.write(l); }catch(e){} },onMsg:m=>c.msg(m),
    onStatus:(t,s)=>{ if(s==='fatal') c.down(t,true); else if(s==='down') c.down(t,false); else c.status(t,s); }});
  if(/^wss?:\/\//i.test(srv)){
    let ws; try{ ws=io.ws(srv); }catch(e){ c.down('IRC: '+e.message,true); return mgNone; }
    link={write:l=>ws.send(l),close:()=>{ ws.onopen=ws.onmessage=ws.onerror=ws.onclose=null; try{ ws.close(); }catch(e){} }};
    ws.onopen=()=>cl.start();
    ws.onmessage=e=>{ const s=String(e.data); cl.feed(s.endsWith('\n') ? s : s+'\r\n'); };
    ws.onerror=()=>{};
    ws.onclose=()=>{ if(!closed) c.down('IRC: connection closed',false); };
  } else {
    const m=/^(ircs?):\/\/([^/:]+)(?::(\d+))?\/?$/i.exec(srv);
    if(!m){ c.down('IRC: server must be wss://host/path, or ircs://host:6697 / irc://host:6667 through the Node bridge',true); return mgNone; }
    if(!io.tcp){ c.down('IRC over TCP needs the Node bridge (tools/node/bridge.mjs): set its address',true); return mgNone; }
    const tls=m[1].toLowerCase()==='ircs';
    let raw=null;
    link={write:l=>raw.write(l+'\r\n'),close:()=>raw.close()};
    raw=io.tcp(m[2],+m[3] || (tls ? 6697 : 6667),tls,{
      open:()=>cl.start(),data:s=>cl.feed(s),close:err=>{ if(!closed) c.down('IRC: '+(err || 'connection closed'),false); }});
  }
  return {
    send(text,to){
      if(!cl.ready){ c.status('IRC: not registered yet','warn'); return false; }
      const dst=to || chans[0]; if(!cl.send(text,dst)) return false;
      c.msg({from:cl.nick,to:dst,text:String(text),t:Date.now(),self:true,local:true}); return true;
    },
    close(){ closed=true; cl.quit(); try{ link.close(); }catch(e){} },
  };
}

/* ---------- XMPP: TCP через io.tcp (xmpp:// — STARTTLS, xmpps:// — сразу TLS) ---------- */
function mgOpenXmpp(cfg,c){
  const io=mgIo(cfg), jid=String(cfg.user||'').trim(), at=jid.indexOf('@');
  if(at<1){ c.down('XMPP: enter the account as user@domain in the user field',true); return mgNone; }
  const user=jid.slice(0,at), domain=jid.slice(at+1).split('/')[0], srv=String(cfg.server||'').trim() || 'xmpp://'+domain;
  const m=/^(xmpps?):\/\/([^/:]+)(?::(\d+))?\/?$/i.exec(srv);
  if(!m){ c.down('XMPP: server must be xmpp://host:5222 (STARTTLS) or xmpps://host:5223',true); return mgNone; }
  if(!io.tcp){ c.down('XMPP needs the Node bridge (tools/node/bridge.mjs): set its address',true); return mgNone; }
  const secure=m[1].toLowerCase()==='xmpps', room=String(cfg.channel||'').trim(), nick=String(cfg.nick||user);
  let closed=false, link=null, cl=null;
  link=io.tcp(m[2],+m[3] || (secure ? 5223 : 5222),secure,{
    open:()=>cl.start(),data:s=>cl.feed(s),close:err=>{ if(!closed) c.down('XMPP: '+(err || 'connection closed'),false); }});
  cl=mgXmppClient({domain,user,pass:cfg.pass,resource:cfg.resource||'dsp',room,nick,secure,insecure:!!cfg.insecure,
    write:s=>{ try{ link.write(s); }catch(e){} },tls:done=>link.upgrade(done),onMsg:x=>{ if(!x.delay || cfg.history) c.msg(x); },
    onStatus:(t,s)=>{ if(s==='fatal'){ c.down(t,true); try{ link.close(); }catch(e){} } else if(s==='down') c.down(t,false); else c.status(t,s); }});
  return {
    send(text,to){
      const dst=String(to||room||'').trim();
      if(!cl.send(text,dst)) return false;
      if(!(room && dst.split('/')[0]===room)) c.msg({from:jid,to:dst,text:String(text),t:Date.now(),self:true,local:true});   // личное сервер не возвращает
      return true;
    },
    close(){ closed=true; cl.quit(); try{ link.close(); }catch(e){} },
  };
}

/* ---------- APRS-IS: TCP через io.tcp (aprs://host:14580). Сообщения «@CALL текст», позиции станций идут записями с lat/lon ---------- */
function mgOpenAprs(cfg,c){
  const io=mgIo(cfg), call=String(cfg.user||cfg.nick||'').trim().toUpperCase();
  if(!/^[A-Z0-9]{1,6}(-\d{1,2})?$/.test(call)){ c.down('APRS-IS: enter your callsign in the user field (N0CALL-7)',true); return mgNone; }
  const m=/^(?:aprs:\/\/)?([^/:]+)(?::(\d+))?\/?$/i.exec(String(cfg.server||'').trim() || 'rotate.aprs2.net:14580');
  if(!m){ c.down('APRS-IS: server must be aprs://host:14580',true); return mgNone; }
  if(!io.tcp){ c.down('APRS-IS needs the Node bridge (tools/node/bridge.mjs): set its address',true); return mgNone; }
  const filter=String(cfg.channel||'').trim() || 'g/'+call;
  let closed=false, raw=null, buf='';
  const cl=mgAprsClient({call,pass:cfg.pass,filter,ackMs:cfg.ackMs,write:l=>{ try{ raw.write(l+'\r\n'); }catch(e){} },onMsg:x=>c.msg(x),
    onStatus:(t,s)=>{ if(s==='fatal') c.down(t,true); else c.status(t,s); }});
  raw=io.tcp(m[1],+m[2] || 14580,false,{
    open:()=>cl.start(),
    data:s=>{ buf+=s; let i; while((i=buf.indexOf('\n'))>=0){ const l=buf.slice(0,i).replace(/\r$/,''); buf=buf.slice(i+1); if(l) cl.line(l); } },
    close:err=>{ if(!closed) c.down('APRS-IS: '+(err || 'connection closed'),false); }});
  return {
    send(text,to){
      text=String(text||''); const a=/^@([A-Za-z0-9-]{1,9})\s+([\s\S]+)$/.exec(text);
      if(a){ to=a[1]; text=a[2]; }
      if(!cl.send(text,to)) return false;
      c.msg({from:call,to:String(to).toUpperCase(),text,t:Date.now(),self:true,local:true,kind:'message'}); return true;
    },
    close(){ closed=true; cl.stop(); try{ raw.close(); }catch(e){} },
  };
}

/* ---------- Email: приём по IMAP (опрос раз в pollMs), отправка по SMTP; оба — TCP через io.tcp (imaps:// imap:// smtps:// smtp://) ---------- */
const mgUrl=(u,defs)=>{ const m=/^(imaps?|smtps?):\/\/([^/:]+)(?::(\d+))?\/?$/i.exec(String(u||'').trim()); if(!m) return null; const sec=/s$/i.test(m[1]); return {host:m[2],port:+m[3] || defs[sec ? 1 : 0],secure:sec}; };
function mgOpenEmail(cfg,c){
  const io=mgIo(cfg), imap=cfg.server ? mgUrl(cfg.server,[143,993]) : null, smtp=cfg.smtp ? mgUrl(cfg.smtp,[587,465]) : null;
  if(cfg.server && (!imap || !/^imap/i.test(cfg.server))){ c.down('Email: server must be imaps://host:993 (or imap://host:143)',true); return mgNone; }
  if(cfg.smtp && (!smtp || !/^smtp/i.test(cfg.smtp))){ c.down('Email: smtp must be smtps://host:465 (or smtp://host:587, STARTTLS)',true); return mgNone; }
  if(!imap && !smtp){ c.down('Email: enter the IMAP server (to receive) and/or the SMTP server (to send)',true); return mgNone; }
  if(!cfg.user || !cfg.pass){ c.down('Email: enter the user and password (an app password for Gmail and the like)',true); return mgNone; }
  if(!io.tcp){ c.down('Email needs the Node bridge (tools/node/bridge.mjs): set its address',true); return mgNone; }
  const me=/@/.test(cfg.nick||'') ? cfg.nick : /@/.test(cfg.user) ? cfg.user : '';
  let closed=false, raw=null, cl=null, timer=null;
  if(imap){
    raw=io.tcp(imap.host,imap.port,imap.secure,{
      open:()=>cl.start(),data:x=>cl.feed(x),close:err=>{ if(!closed) c.down('IMAP: '+(err || 'connection closed'),false); }},{binary:true});
    cl=mgImapClient({user:cfg.user,pass:cfg.pass,box:cfg.channel||'INBOX',history:cfg.history|0,secure:imap.secure,insecure:!!cfg.insecure,
      write:x=>{ try{ raw.write(x); }catch(e){} },tls:done=>raw.upgrade(done),onMsg:m=>c.msg(m),
      onStatus:(t,s)=>{ if(s==='fatal') c.down('IMAP: '+t,true); else c.status(t+(smtp ? '' : ' · receive only'),s); }});
    timer=setInterval(()=>cl.poll(),Math.max(1000,cfg.pollMs||30000));
    setTimeout(()=>cl && cl.poll(),1500);
  } else c.status('send only (no IMAP server)','up');
  return {
    send(text,to){
      text=String(text||''); const a=/^@(\S+@\S+)\s+([\s\S]+)$/.exec(text);
      if(a){ to=a[1]; text=a[2]; }
      to=String(to||'').trim();
      if(!smtp){ c.status('Email: enter the SMTP server to send','warn'); return Promise.resolve(false); }
      if(!/^[^\s@<>]+@[^\s@<>]+$/.test(to)){ c.status('Email: address a message as «@name@host text» or with the «to» input','warn'); return Promise.resolve(false); }
      if(!me){ c.status('Email: the sender is unknown — make the user (or nick) an address','warn'); return Promise.resolve(false); }
      const nl=text.indexOf('\n'), subject=nl>0 ? text.slice(0,nl).trim() : 'DSP message', body=nl>0 ? text.slice(nl+1) : text;
      return new Promise(res=>{
        let h=null, cli=null;
        h=io.tcp(smtp.host,smtp.port,smtp.secure,{
          open:()=>{},data:x=>cli.feed(x),close:err=>cli.abort()},{binary:true});
        cli=mgSmtpClient({host:smtp.host,user:cfg.user,pass:cfg.pass,from:me,to,subject,body,secure:smtp.secure,insecure:!!cfg.insecure,
          write:x=>{ try{ h.write(x); }catch(e){} },tls:done=>h.upgrade(done),
          done:err=>{ try{ h.close(); }catch(e){} if(err){ c.status('SMTP: '+err,'warn'); res(false); } else { c.msg({from:me,to,subject,text:(nl>0 ? '['+subject+'] ' : '')+body,t:Date.now(),self:true,local:true,kind:'mail'}); res(true); } }});
      });
    },
    close(){ closed=true; clearInterval(timer); if(cl) cl.quit(); try{ raw && raw.close(); }catch(e){} },
  };
}

/* ---------- SMS: через приложение DSP на Android (tools/android): сокет телефона, подписка sms и команда sms.send ---------- */
// Работает только со страницы самого приложения: ключ (?k=) знает лишь она. Входящие — записи {src:'sms',dir:'in',addr,body}.
function mgOpenSms(cfg,c){
  const io=mgIo(cfg);
  let u; try{ u=new URL(String(cfg.server||'').trim() || 'ws://127.0.0.1:8765'); }catch(e){ c.down('SMS: bad address of the phone app',true); return mgNone; }
  if(u.protocol!=='ws:' && u.protocol!=='wss:'){ c.down('SMS: the address must start with ws://',true); return mgNone; }
  if(cfg.appKey && /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/.test(u.hostname) && !u.searchParams.has('k')) u.searchParams.set('k',cfg.appKey);
  let ws, closed=false, seq=0; const wait=new Map();
  try{ ws=io.ws(u.toString()); }catch(e){ c.down('SMS: '+e.message,false); return mgNone; }
  ws.onopen=()=>{ ws.send(JSON.stringify({sub:['sms']})); c.status('connected to the phone app, waiting for SMS','up'); };
  ws.onerror=()=>{};
  ws.onclose=()=>{ for(const w of wait.values()){ clearTimeout(w.t); w.res(false); } wait.clear(); if(!closed) c.down('SMS: phone app connection closed',false); };
  ws.onmessage=e=>{
    let r; try{ r=JSON.parse(String(e.data)); }catch(x){ return; }
    if(r.src==='sms' && r.dir==='in') c.msg({from:String(r.addr||'?'),to:'me',text:String(r.body||''),t:+r.t || Date.now(),id:String(r.id||'')});
    else if(r.src==='cmd' && wait.has(r.id)){
      const w=wait.get(r.id); wait.delete(r.id); clearTimeout(w.t);
      if(!r.ok) c.status('SMS: '+(r.err==='permission' ? 'allow SMS for the DSP app on the phone, then repeat' : r.err==='forbidden' ? 'only the page of the DSP app may send SMS' : r.err==='rate' ? 'too many SMS (5 a minute)' : (r.msg || r.err || 'send failed')),'warn');
      w.res(!!r.ok);
    } else if(r.src==='bridge' && (r.level==='warn' || r.level==='error')) c.status('phone app: '+r.msg,'warn');
  };
  return {
    send(text,to){
      text=String(text||''); const a=/^@(\+?[0-9][0-9 ()-]{2,19})\s+([\s\S]+)$/.exec(text);
      if(a){ to=a[1]; text=a[2]; }
      to=String(to||'').trim();
      if(!/^\+?[0-9][0-9 ()-]{2,19}$/.test(to)){ c.status('SMS: address a message as «@+79001234567 text» or with the «to» input','warn'); return Promise.resolve(false); }
      if(ws.readyState!==1) return Promise.resolve(false);
      const id=++seq;
      return new Promise(res=>{
        wait.set(id,{res:ok=>{ if(ok) c.msg({from:String(cfg.nick||'me'),to,text,t:Date.now(),self:true,local:true}); res(ok); },t:setTimeout(()=>{ wait.delete(id); c.status('SMS: the phone did not answer','warn'); res(false); },30000)});
        ws.send(JSON.stringify({cmd:'sms.send',id,to,text}));
      });
    },
    close(){ closed=true; for(const w of wait.values()) clearTimeout(w.t); wait.clear(); ws.onopen=ws.onmessage=ws.onerror=ws.onclose=null; try{ ws.close(); }catch(e){} },
  };
}

/* ---------- Шлюз TCP: один адрес — и Node-мост, и приложение DSP на телефоне. Тип определяется по приветствию ---------- */
//   {ev:'hello'} — tools/node/bridge.mjs: протокол целиком живёт на мосте (mgOpenRemote);
//   {src:'bridge', level:'hello'} — приложение DSP: протокол идёт в странице, а сокеты и TLS даёт телефон (mgPhoneTcp).
function mgOpenGateway(proto,cfg,c){
  const io=mgIo({io:cfg.io}), url=String(cfg.bridge||'').trim();
  if(!/^wss?:\/\//i.test(url)){ c.down('Gateway: the address must start with ws:// or wss://',true); return mgNone; }
  let probe, inner=null, closed=false;
  try{ probe=io.ws(url); }catch(e){ c.down('Gateway: '+e.message,false); return mgNone; }
  const timer=setTimeout(()=>{ if(!inner && !closed) c.down('Gateway '+url+' does not greet — it must be the DSP app (ws://phone:8765) or tools/node/bridge.mjs (ws://host:8777)',false); },6000);
  const stop=()=>{ probe.onopen=probe.onmessage=probe.onerror=probe.onclose=null; try{ probe.close(); }catch(e){} };
  probe.onerror=()=>{};
  probe.onclose=()=>{ if(!inner && !closed){ clearTimeout(timer); c.down('Gateway: connection closed',false); } };
  probe.onmessage=e=>{
    if(inner || closed) return;
    let j; try{ j=JSON.parse(String(e.data)); }catch(x){ return; }
    const kind=j.ev==='hello' ? 'node' : j.src==='bridge' && j.level==='hello' ? 'phone' : '';
    if(!kind) return;
    clearTimeout(timer); stop();
    if(kind==='node') inner=mgOpenRemote(proto,cfg,c);
    else { c.status('gateway: DSP app on '+(j.host||'a phone'),'connecting'); inner=MG_OPEN[proto]({...cfg,phone:{url,key:cfg.appKey,io:cfg.io}},c); }
  };
  return {
    send:(text,to)=>inner ? inner.send(text,to) : false,
    close(){ closed=true; clearTimeout(timer); stop(); if(inner) try{ inner.close(); }catch(e){} },
  };
}

/* ---------- Reticulum + LXMF: узел Reticulum по TCP (TCPServerInterface любого transport-узла), rns://host:port — через io.tcp ---------- */
// key — приватный ключ личности: 128 hex-знаков (как у RNS: X25519 + Ed25519); channel — получатель по умолчанию (адрес или имя из анонсов);
// сообщение: «@имя-или-адрес текст». Протокол — rns-kernels.js (проверен против настоящих rnsd и LXMF).
function mgOpenRns(cfg,c){
  const io=mgIo(cfg), m=/^(?:rns|reticulum|tcp):\/\/([^/:]+):(\d+)\/?$/i.exec(String(cfg.server||'').trim());
  if(!m){ c.down('Reticulum: server must be rns://host:port — the TCP server interface of a Reticulum node',true); return mgNone; }
  if(!io.tcp){ c.down('Reticulum needs TCP: use the DSP app on a phone or the Node bridge (tools/node/bridge.mjs)',true); return mgNone; }
  let prv=null;
  const keyHex=String(cfg.key||cfg.pass||'').trim();
  if(keyHex){ prv=mgUnhex(keyHex); if(!prv || prv.length!==64){ c.down('Reticulum: the identity key is 128 hex digits (64 bytes)',true); return mgNone; } }
  let closed=false, raw=null, node=null, heardAt=0;
  const toBin=b=>{ let t=''; for(let i=0;i<b.length;i+=8192) t+=String.fromCharCode.apply(null,b.subarray(i,i+8192)); return t; };
  try{
    node=new RnsNode({prv,name:cfg.nick||'dsp',announceMs:cfg.announceMs,pathWaitMs:cfg.pathWaitMs,
      write:b=>{ try{ raw.write(toBin(b)); }catch(e){} },
      onMsg:x=>c.msg({from:x.from,to:x.to,text:x.text,t:x.t,id:x.id,unverified:x.unverified}),
      onStatus:(t,s)=>c.status(t,s),
      onPeer:()=>{ const n=Date.now(); if(n-heardAt>5000){ heardAt=n; c.status('Reticulum <'+node.destHex+'> · '+node.peers.size+' LXMF address(es) heard','up'); } }});
  }catch(e){ c.down('Reticulum: '+e.message,true); return mgNone; }
  raw=io.tcp(m[1],+m[2],false,{
    open:()=>{ node.start().catch(e=>c.down('Reticulum: '+e.message+(/Web Crypto|X25519|Ed25519|algorithm/i.test(e.message) ? ' (needs a browser with X25519 and Ed25519 in Web Crypto: Chrome 137+, Firefox 130+, Safari 17+)' : ''),true)); },
    data:s=>{ const b=new Uint8Array(s.length); for(let i=0;i<s.length;i++) b[i]=s.charCodeAt(i)&255; node.feed(b); },
    close:err=>{ if(!closed) c.down('Reticulum: '+(err || 'connection closed'),false); }},{binary:true});
  return {
    async send(text,to){
      text=String(text||''); const a=/^@(\S+)\s+([\s\S]+)$/.exec(text);
      if(a){ to=a[1]; text=a[2]; }
      to=String(to||cfg.channel||'').trim();
      if(!to){ c.status('Reticulum: address a message as «@name text» or «@<32-digit address> text», or set the default recipient in the channel field','warn'); return false; }
      if(!node.id){ c.status('Reticulum: still starting','warn'); return false; }
      const ok=await node.send(text,to);
      if(ok) c.msg({from:String(cfg.nick||'me'),to,text,t:Date.now(),self:true,local:true});
      return ok;
    },
    close(){ closed=true; if(node) node.stop(); try{ raw.close(); }catch(e){} },
  };
}

/* ---------- сессия на Node-мосте: те же сообщения, но протокол живёт на стороне моста ---------- */
function mgOpenRemote(proto,cfg,c){
  const io=mgIo(cfg), url=String(cfg.bridge||'').trim();
  if(!/^wss?:\/\//i.test(url)){ c.down('Node bridge: address must start with ws:// or wss://',true); return mgNone; }
  let ws, closed=false;
  try{ ws=io.ws(url); }catch(e){ c.down('Node bridge: '+e.message,false); return mgNone; }
  const {io:_i,cache:_c,bridge:_b,via:_v,...plain}=cfg;
  ws.onopen=()=>{ c.status('bridge connected, opening '+proto+'…','connecting'); ws.send(JSON.stringify({op:'open',proto,cfg:plain})); };
  ws.onmessage=e=>{
    let j; try{ j=JSON.parse(String(e.data)); }catch(x){ return; }
    if(j.ev==='msg' && j.m) c.msg(j.m);
    else if(j.ev==='status'){ if(j.state==='fatal') c.down(j.text,true); else c.status(j.text,j.state||'up'); }       // повторы делает сам мост
  };
  ws.onerror=()=>{};
  ws.onclose=()=>{ if(!closed) c.down('Node bridge: connection closed',false); };
  return {
    send(text,to){ if(ws.readyState!==1) return false; ws.send(JSON.stringify({op:'send',text:String(text),to:to||''})); return true; },
    close(){ closed=true; ws.onopen=ws.onmessage=ws.onerror=ws.onclose=null; try{ ws.send(JSON.stringify({op:'close'})); }catch(e){} try{ ws.close(); }catch(e){} },
  };
}

const MG_OPEN={nostr:mgOpenNostr,ntfy:mgOpenNtfy,matrix:mgOpenMatrix,telegram:mgOpenTelegram,irc:mgOpenIrc,xmpp:mgOpenXmpp,aprs:mgOpenAprs,email:mgOpenEmail,sms:mgOpenSms,reticulum:mgOpenRns};
const mgNeedsTcp=(proto,cfg)=>proto==='xmpp' || proto==='aprs' || proto==='email' || proto==='reticulum' || (proto==='irc' && !/^wss?:\/\//i.test(String(cfg.server||'').trim()));

// cfg.via: 'auto' (мост — только где нужен TCP), 'page' (всё из страницы), 'bridge' (всё через мост); cfg.retry — переподключаться
function mgConnect(proto,cfg,cb){
  // TCP: свой сокет телефона (cfg.phone) главнее моста; via 'bridge' — всё через Node-мост
  const remote=cfg.via==='bridge' || ((cfg.via||'auto')==='auto' && cfg.bridge && !cfg.phone && mgNeedsTcp(proto,cfg));
  const open=remote ? (cfg2,c)=>mgOpenGateway(proto,cfg2,c) : MG_OPEN[proto];
  let h=null, timer=null, dead=false, gen=0;
  const out={
    send:(text,to)=>h ? h.send(text,to) : false,
    close(){ dead=true; clearTimeout(timer); const x=h; h=null; if(x) try{ x.close(); }catch(e){} },
  };
  if(!open){ cb.status('unknown protocol '+proto,'fatal'); return out; }
  const go=()=>{
    if(dead) return;
    const my=++gen; cb.status('connecting…','connecting');
    const c={
      msg:m=>{ if(my===gen && !dead) cb.msg(m); },
      status:(t,s)=>{ if(my===gen && !dead) cb.status(t,s); },
      down:(why,fatal)=>{
        if(my!==gen || dead || c.done) return;                       // сокет шлёт error и close подряд — реагируем один раз
        c.done=true;
        const x=h; h=null; if(x) try{ x.close(); }catch(e){}
        if(fatal || !cfg.retry){ cb.status(why,fatal ? 'fatal' : 'down'); return; }
        cb.status(why+' — reconnecting…','down'); clearTimeout(timer); timer=setTimeout(go,cfg.retryMs||MG_RETRY_MS);
      },
    };
    try{ h=open(cfg,c); }catch(e){ c.down(proto+': '+e.message,false); }
  };
  go();
  return out;
}
