"use strict";
/* ============================ Мессенджеры: ядро протоколов ============================
   Чистая логика без DOM — общая для страницы (modules/msgr.js) и Node-моста (tools/node/bridge.mjs).
   Нужен mcSha256 из meshcore-kernels.js (грузится раньше). Разбор — tools/test-msgr.mjs.
   • Nostr: подпись Шнорра BIP-340 на secp256k1 (BigInt), события NIP-01, bech32 (npub / nsec).
   • IRC: разбор строк и клиент (регистрация, PING, PRIVMSG, ACTION, смена ника при 433).
   • XMPP: потоковый разбор XML и клиент (STARTTLS, SASL PLAIN, bind, MUC) — транспорт снаружи.
   • Разбор ответов ntfy / Matrix / Telegram. */

// ---------- байты ----------
const mgHex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
function mgUnhex(s){ s=String(s).trim(); if(!/^([0-9a-f]{2})*$/i.test(s)) return null; const o=new Uint8Array(s.length/2); for(let i=0;i<o.length;i++) o[i]=parseInt(s.substr(i*2,2),16); return o; }
const mgUtf8=s=>new TextEncoder().encode(s);
function mgCat(...a){ let n=0; for(const x of a) n+=x.length; const o=new Uint8Array(n); let p=0; for(const x of a){ o.set(x,p); p+=x.length; } return o; }
const mgBig=b=>BigInt('0x'+(mgHex(b)||'0'));
const mgB32=v=>mgUnhex(v.toString(16).padStart(64,'0'));
function mgB64(bytes){ let s=''; for(const b of bytes) s+=String.fromCharCode(b); return btoa(s); }
function mgRandom(n){
  const g=typeof crypto!=='undefined' && crypto.getRandomValues ? crypto : null;
  if(!g) throw new Error('no secure random generator');
  return g.getRandomValues(new Uint8Array(n));
}
// управляющие символы в строке протокола — это впрыск команд (IRC: \r\n), режем
const mgLine=s=>String(s).replace(/[\r\n\0]+/g,' ');

// ---------- secp256k1 + BIP-340 ----------
const MG_P=0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
const MG_N=0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const MG_G=[0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n,0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n,1n];
const mgMod=(a,m=MG_P)=>{ const r=a%m; return r>=0n ? r : r+m; };
function mgInv(a,m=MG_P){
  let r0=mgMod(a,m), r1=m, s0=1n, s1=0n;
  while(r1){ const q=r0/r1; [r0,r1]=[r1,r0-q*r1]; [s0,s1]=[s1,s0-q*s1]; }
  return mgMod(s0,m);
}
function mgPow(b,e,m=MG_P){ let r=1n; b=mgMod(b,m); while(e>0n){ if(e&1n) r=r*b%m; b=b*b%m; e>>=1n; } return r; }
// точки в якобиевых координатах [X,Y,Z], бесконечность — null
function mgDbl(P){
  if(!P) return null;
  const [X,Y,Z]=P; if(Y===0n) return null;
  const A=X*X%MG_P, B=Y*Y%MG_P, C=B*B%MG_P, D=mgMod(2n*((X+B)*(X+B)-A-C)), E=3n*A%MG_P, F=E*E%MG_P, X3=mgMod(F-2n*D);
  return [X3,mgMod(E*(D-X3)-8n*C),2n*Y*Z%MG_P];
}
function mgAdd(P,Q){
  if(!P) return Q; if(!Q) return P;
  const [X1,Y1,Z1]=P, [X2,Y2,Z2]=Q;
  const Z1Z1=Z1*Z1%MG_P, Z2Z2=Z2*Z2%MG_P, U1=X1*Z2Z2%MG_P, U2=X2*Z1Z1%MG_P, S1=Y1*Z2%MG_P*Z2Z2%MG_P, S2=Y2*Z1%MG_P*Z1Z1%MG_P;
  const H=mgMod(U2-U1), r=mgMod(2n*(S2-S1));
  if(H===0n) return r===0n ? mgDbl(P) : null;
  const I=4n*H*H%MG_P, J=H*I%MG_P, V=U1*I%MG_P, X3=mgMod(r*r-J-2n*V);
  return [X3,mgMod(r*(V-X3)-2n*S1*J),mgMod(((Z1+Z2)*(Z1+Z2)-Z1Z1-Z2Z2)*H)];
}
function mgMul(k,P){
  let R=null; const bits=k.toString(2);
  for(let i=0;i<bits.length;i++){ R=mgDbl(R); if(bits[i]==='1') R=mgAdd(R,P); }
  return R;
}
function mgAff(P){ if(!P) return null; const zi=mgInv(P[2]), z2=zi*zi%MG_P; return [P[0]*z2%MG_P,P[1]*z2%MG_P*zi%MG_P]; }
function mgLift(x){                                       // точка с чётным y по x
  if(x>=MG_P) return null;
  const c=mgMod(x*x*x+7n), y=mgPow(c,(MG_P+1n)/4n);
  if(y*y%MG_P!==c) return null;
  return [x,(y&1n) ? MG_P-y : y,1n];
}
function mgTagged(tag,...parts){ const t=mgSha(mgUtf8(tag)); return mgSha(mgCat(t,t,...parts)); }
const mgSha=b=>mcSha256(b);

function mgSchnorrPub(sk){                                // sk — 32 байта → x-координата (32 байта) или null
  const d=mgBig(sk); if(d<=0n || d>=MG_N) return null;
  return mgB32(mgAff(mgMul(d,MG_G))[0]);
}
function mgSchnorrSign(msg,sk,aux){
  const d0=mgBig(sk); if(d0<=0n || d0>=MG_N) throw new Error('bad private key');
  const P=mgAff(mgMul(d0,MG_G)), d=(P[1]&1n) ? MG_N-d0 : d0, px=mgB32(P[0]);
  const a=aux||new Uint8Array(32), tag=mgTagged('BIP0340/aux',a), t=mgB32(d^mgBig(tag));
  const k0=mgMod(mgBig(mgTagged('BIP0340/nonce',t,px,msg)),MG_N); if(k0===0n) throw new Error('bad nonce');
  const R=mgAff(mgMul(k0,MG_G)), k=(R[1]&1n) ? MG_N-k0 : k0, rx=mgB32(R[0]);
  const e=mgMod(mgBig(mgTagged('BIP0340/challenge',rx,px,msg)),MG_N);
  return mgCat(rx,mgB32(mgMod(k+e*d,MG_N)));
}
function mgSchnorrVerify(sig,msg,pk){
  if(sig.length!==64 || pk.length!==32) return false;
  const P=mgLift(mgBig(pk)); if(!P) return false;
  const r=mgBig(sig.subarray(0,32)), s=mgBig(sig.subarray(32));
  if(r>=MG_P || s>=MG_N) return false;
  const e=mgMod(mgBig(mgTagged('BIP0340/challenge',sig.subarray(0,32),pk,msg)),MG_N);
  const eP=mgMul(e,P), nP=eP ? [eP[0],MG_P-eP[1],eP[2]] : null;           // s·G − e·P
  const R=mgAff(mgAdd(mgMul(s,MG_G),nP));
  return !!R && (R[1]&1n)===0n && R[0]===r;
}

// ---------- bech32 (npub / nsec) ----------
const MG_BECH='qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function mgBechPoly(v){
  const G=[0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3]; let c=1;
  for(const x of v){ const b=c>>>25; c=((c&0x1ffffff)<<5)^x; for(let i=0;i<5;i++) if((b>>i)&1) c^=G[i]; }
  return c;
}
const mgBechHrp=h=>[...Array.from(h,c=>c.charCodeAt(0)>>5),0,...Array.from(h,c=>c.charCodeAt(0)&31)];
function mgConvBits(data,from,to,pad){
  let acc=0, bits=0; const out=[], max=(1<<to)-1;
  for(const v of data){
    if(v<0 || v>>from) return null;
    acc=(acc<<from)|v; bits+=from;
    while(bits>=to){ bits-=to; out.push((acc>>bits)&max); }
    acc&=(1<<bits)-1;
  }
  if(pad){ if(bits) out.push((acc<<(to-bits))&max); }
  else if(bits>=from || (acc<<(to-bits))&max) return null;
  return out;
}
function mgBechEnc(hrp,bytes){
  const d=mgConvBits(bytes,8,5,true), pm=mgBechPoly([...mgBechHrp(hrp),...d,0,0,0,0,0,0])^1;
  return hrp+'1'+[...d,...[0,1,2,3,4,5].map(i=>(pm>>(5*(5-i)))&31)].map(x=>MG_BECH[x]).join('');
}
function mgBechDec(s){
  s=String(s).trim().toLowerCase(); const i=s.lastIndexOf('1');
  if(i<1 || s.length<i+7) return null;
  const hrp=s.slice(0,i), d=[];
  for(const c of s.slice(i+1)){ const v=MG_BECH.indexOf(c); if(v<0) return null; d.push(v); }
  if(mgBechPoly([...mgBechHrp(hrp),...d])!==1) return null;
  const b=mgConvBits(d.slice(0,-6),5,8,false);
  return b ? {hrp,bytes:Uint8Array.from(b)} : null;
}

// ---------- Nostr ----------
function mgNostrKey(s){                                   // nsec1… или 64 hex → 32 байта, иначе null
  s=String(s||'').trim(); if(!s) return null;
  if(/^nsec1/i.test(s)){ const d=mgBechDec(s); return d && d.hrp==='nsec' && d.bytes.length===32 ? d.bytes : null; }
  const b=/^[0-9a-f]{64}$/i.test(s) ? mgUnhex(s) : null;
  return b && mgSchnorrPub(b) ? b : null;
}
function mgNostrGenKey(){ for(;;){ const k=mgRandom(32); if(mgSchnorrPub(k)) return k; } }
const mgNpub=pkHex=>mgBechEnc('npub',mgUnhex(pkHex));
const mgNostrId=ev=>mgHex(mgSha(mgUtf8(JSON.stringify([0,ev.pubkey,ev.created_at,ev.kind,ev.tags,ev.content]))));
function mgNostrSign(sk,o){
  const ev={pubkey:mgHex(mgSchnorrPub(sk)),created_at:o.created_at,kind:o.kind,tags:o.tags||[],content:o.content};
  ev.id=mgNostrId(ev);
  let aux; try{ aux=mgRandom(32); }catch(e){ aux=new Uint8Array(32); }
  ev.sig=mgHex(mgSchnorrSign(mgUnhex(ev.id),sk,aux));
  return ev;
}
function mgNostrVerify(ev){
  if(!ev || typeof ev.id!=='string' || typeof ev.pubkey!=='string' || typeof ev.sig!=='string' || !Array.isArray(ev.tags) || typeof ev.content!=='string') return false;
  if(mgNostrId(ev)!==ev.id) return false;
  const id=mgUnhex(ev.id), pk=mgUnhex(ev.pubkey), sig=mgUnhex(ev.sig);
  return !!(id && pk && sig && mgSchnorrVerify(sig,id,pk));
}
// канал — хэштег (тег t): kind 1, ответы и чужие хэштеги отбираются фильтром реле
const mgNostrReq=(sub,chan,since)=>JSON.stringify(['REQ',sub,{kinds:[1],'#t':[String(chan).toLowerCase()],since}]);
function mgNostrFrame(text){
  let a; try{ a=JSON.parse(text); }catch(e){ return null; }
  if(!Array.isArray(a) || typeof a[0]!=='string') return null;
  return {type:a[0],a};
}
function mgNostrText(ev,chan){                              // событие → {from,text} или null (не наш канал)
  if(ev.kind!==1 || !Array.isArray(ev.tags)) return null;
  const want=String(chan).toLowerCase();
  if(!ev.tags.some(t=>Array.isArray(t) && t[0]==='t' && String(t[1]).toLowerCase()===want)) return null;
  const nick=ev.tags.find(t=>Array.isArray(t) && t[0]==='nick' && typeof t[1]==='string');
  return {from:nick ? nick[1].slice(0,64) : mgNpub(ev.pubkey).slice(0,12),text:ev.content};
}

// ---------- ntfy / Matrix / Telegram: разбор ответов ----------
// построчный разбор потока (JSON-lines / SSE): состояние хранит хвост
function mgLines(st,chunk){
  st.buf=(st.buf||'')+chunk; const out=[]; let i;
  while((i=st.buf.indexOf('\n'))>=0){ const l=st.buf.slice(0,i).replace(/\r$/,''); st.buf=st.buf.slice(i+1); if(l) out.push(l); }
  return out;
}
function mgNtfyLine(line){                                 // → {id,from,text,t} для event=message, иначе null
  let j; try{ j=JSON.parse(line); }catch(e){ return null; }
  if(!j || j.event!=='message' || typeof j.message!=='string') return null;
  return {id:String(j.id||''),from:String(j.title||'ntfy'),text:j.message,t:(+j.time||0)*1000,tags:j.tags||[],prio:j.priority};
}
function mgMatrixSync(j,room,self){                         // → {next,msgs:[{id,from,room,text,t,self}]}
  const out=[], rooms=(j && j.rooms && j.rooms.join) || {};
  for(const rid of Object.keys(rooms)){
    if(room && rid!==room) continue;
    for(const ev of (rooms[rid].timeline && rooms[rid].timeline.events) || []){
      const c=ev.content;
      if(ev.type!=='m.room.message' || !c || typeof c.body!=='string') continue;
      if(c.msgtype && !/^m\.(text|notice|emote)$/.test(c.msgtype)) continue;
      const who=String(ev.sender||'');
      out.push({id:String(ev.event_id||''),from:who.replace(/^@/,'').replace(/:.*$/,'')||who,room:rid,text:c.msgtype==='m.emote' ? '* '+c.body : c.body,
        t:+ev.origin_server_ts||0,self:!!self && who===self});
    }
  }
  return {next:j && j.next_batch,msgs:out};
}
function mgTgUpdates(j,chat){                               // → {next,msgs,last:chat_id}
  const out=[]; let next=0, last=null;
  const want=String(chat||'').trim().toLowerCase();
  for(const u of (j && j.result) || []){
    next=Math.max(next,(u.update_id|0)+1);
    const m=u.message || u.channel_post; if(!m || typeof m.text!=='string') continue;
    const c=m.chat||{};
    if(want && String(c.id)!==want && String(c.username||'').toLowerCase()!==want.replace(/^@/,'')) continue;
    const f=m.from||{};
    out.push({id:String(u.update_id),from:f.username||f.first_name||c.title||String(c.id),room:String(c.id),text:m.text,t:(+m.date||0)*1000,chat:c.title||c.username||''});
    last=c.id;
  }
  return {next,msgs:out,last};
}

// ---------- IRC ----------
function mgIrcParse(line){
  let tags=null;
  if(line[0]==='@'){ const i=line.indexOf(' '); tags=line.slice(1,i<0 ? undefined : i); line=i<0 ? '' : line.slice(i+1).trimStart(); }
  let prefix='';
  if(line[0]===':'){ const i=line.indexOf(' '); prefix=line.slice(1,i<0 ? undefined : i); line=i<0 ? '' : line.slice(i+1).trimStart(); }
  let trailing=null; const ti=line.indexOf(' :');
  if(ti>=0){ trailing=line.slice(ti+2); line=line.slice(0,ti); }
  const p=line.split(' ').filter(Boolean), cmd=(p.shift()||'').toUpperCase();
  if(trailing!==null) p.push(trailing);
  return {tags,prefix,nick:prefix.split('!')[0],cmd,params:p};
}
function mgIrcFmt(...a){
  a=a.map(mgLine);
  const last=a.length-1;
  if(last>0 && (a[last]==='' || a[last].includes(' ') || a[last][0]===':')) a[last]=':'+a[last];
  return a.join(' ');
}
// разбивка длинного текста: строка IRC ≤ 512 байт, оставляем запас на префикс
function mgSplit(text,max){
  const out=[];
  for(const part of String(text).split(/\r?\n/)){
    let s=part;
    while(mgUtf8(s).length>max){ let k=Math.min(s.length,max); while(k>1 && mgUtf8(s.slice(0,k)).length>max) k--; out.push(s.slice(0,k)); s=s.slice(k); }
    if(s.trim()) out.push(s);
  }
  return out;
}
// o: {nick,user,real,pass,channels[],write(line),onMsg(m),onStatus(text,state)}
function mgIrcClient(o){
  let nick=mgLine(o.nick||'dsp').replace(/\s+/g,'_'), buf='', ready=false;
  const w=(...a)=>o.write(mgIrcFmt(...a));
  const self={
    get nick(){ return nick; },
    get ready(){ return ready; },
    start(){
      if(o.pass) w('PASS',o.pass);
      w('NICK',nick); w('USER',o.user||nick,'0','*',o.real||nick);
      o.onStatus('registering as '+nick+'…','connecting');
    },
    feed(chunk){
      buf+=chunk; let i;
      while((i=buf.indexOf('\n'))>=0){ const l=buf.slice(0,i).replace(/\r$/,''); buf=buf.slice(i+1); if(l) self.line(l); }
    },
    line(l){
      const m=mgIrcParse(l), p=m.params;
      if(m.cmd==='PING') w('PONG',...p);
      else if(m.cmd==='001'){
        ready=true; o.onStatus('connected as '+nick,'up');
        for(const c of o.channels||[]) w('JOIN',c);
      }
      else if(m.cmd==='433' || m.cmd==='432'){ nick=(nick+'_').slice(0,30); w('NICK',nick); }
      else if(m.cmd==='464'){ o.onStatus('password refused','fatal'); }
      else if(m.cmd==='PRIVMSG' && p.length>=2){
        let text=p[1];
        const act=/^\x01ACTION (.*?)\x01?$/.exec(text);
        if(act) text='* '+m.nick+' '+act[1];
        else if(text[0]==='\x01') return;                            // другие CTCP (VERSION, PING…) не показываем
        o.onMsg({from:m.nick,to:p[0],text,t:Date.now(),self:m.nick===nick});
      }
      else if(m.cmd==='NOTICE' && p.length>=2 && m.prefix.includes('!')) o.onMsg({from:m.nick,to:p[0],text:p[1],t:Date.now(),notice:true});
      else if(m.cmd==='JOIN' && m.nick===nick) o.onStatus('joined '+p[0],'up');
      else if(m.cmd==='ERROR') o.onStatus('server: '+(p[0]||'error'),'down');
      else if(/^4\d\d$/.test(m.cmd) && p.length) o.onStatus(m.cmd+' '+p.slice(1).join(' '),'warn');
    },
    send(text,to){
      to=mgLine(to||(o.channels||[])[0]||''); if(!to) return false;
      for(const s of mgSplit(text,400)) w('PRIVMSG',to,s);
      return true;
    },
    quit(){ try{ w('QUIT','bye'); }catch(e){} },
  };
  return self;
}

// ---------- XML (поток XMPP) ----------
const mgXmlEsc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
function mgXmlUnesc(s){
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,(_,e)=>{
    if(e[0]==='#'){ const c=e[1]==='x' || e[1]==='X' ? parseInt(e.slice(2),16) : +e.slice(1); try{ return String.fromCodePoint(c); }catch(x){ return ''; } }
    return {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[e.toLowerCase()];
  });
}
const mgLocal=n=>n.slice(n.indexOf(':')+1);
// on(ev,node): 'open' — корень потока, 'stanza' — полный элемент первого уровня, 'close' — конец потока
function mgXmlParser(on){
  let buf='', stack=[], opened=false;
  return chunk=>{
    buf+=chunk;
    for(;;){
      if(!buf) return;
      if(buf[0]!=='<'){
        const i=buf.indexOf('<');
        const t=i<0 ? buf : buf.slice(0,i);
        if(i<0 && /&[^;]{0,10}$/.test(t)) return;                       // сущность оборвалась на границе чанка
        if(stack.length) stack[stack.length-1].text+=mgXmlUnesc(t);
        buf=i<0 ? '' : buf.slice(i); continue;
      }
      if(buf.startsWith('<!--')){ const e=buf.indexOf('-->'); if(e<0) return; buf=buf.slice(e+3); continue; }
      if(buf.startsWith('<![CDATA[')){ const e=buf.indexOf(']]>'); if(e<0) return; if(stack.length) stack[stack.length-1].text+=buf.slice(9,e); buf=buf.slice(e+3); continue; }
      let q='', end=-1;
      for(let i=1;i<buf.length;i++){ const c=buf[i]; if(q){ if(c===q) q=''; } else if(c==='"' || c==="'") q=c; else if(c==='>'){ end=i; break; } }
      if(end<0) return;
      const tag=buf.slice(1,end); buf=buf.slice(end+1);
      if(tag[0]==='?' || tag[0]==='!') continue;
      if(tag[0]==='/'){
        const name=tag.slice(1).trim();
        if(!stack.length){ if(opened){ opened=false; on('close',null); } continue; }
        const node=stack.pop();
        if(stack.length) stack[stack.length-1].kids.push(node); else on('stanza',node);
        continue;
      }
      const self=tag.endsWith('/'), body=self ? tag.slice(0,-1) : tag;
      const m=/^([^\s/]+)/.exec(body); if(!m) continue;
      const node={name:m[1],attrs:{},kids:[],text:''};
      for(const a of body.slice(m[1].length).matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) node.attrs[a[1]]=mgXmlUnesc(a[2]!==undefined ? a[2] : a[3]);
      if(!opened && !stack.length && mgLocal(node.name)==='stream'){ opened=true; on('open',node); continue; }
      if(self){ if(stack.length) stack[stack.length-1].kids.push(node); else on('stanza',node); }
      else stack.push(node);
    }
  };
}
const mgKid=(n,name)=>n.kids.find(k=>mgLocal(k.name)===name);
const mgKids=(n,name)=>n.kids.filter(k=>mgLocal(k.name)===name);

// ---------- XMPP ----------
// o: {domain,user (локальная часть),pass,resource,room (МUC, необязательно),nick,secure (канал уже TLS),insecure (разрешить пароль без TLS),
//     write(str),tls(done) — перейти на TLS и вызвать done(),onMsg(m),onStatus(text,state)}
function mgXmppClient(o){
  let px, tlsDone=!!o.secure, authed=false, jid='', iq=0, ready=false, closed=false;
  const nick=mgLine(o.nick||o.user||'dsp'), room=o.room ? String(o.room).trim() : '';
  const w=s=>{ if(!closed) o.write(s); };
  const stream=()=>{
    px=mgXmlParser(on);
    w("<?xml version='1.0'?><stream:stream to='"+mgXmlEsc(o.domain)+"' xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' version='1.0'>");
  };
  function features(f){
    if(!tlsDone){
      if(mgKid(f,'starttls')){ w("<starttls xmlns='urn:ietf:params:xml:ns:xmpp-tls'/>"); return; }
      if(!o.insecure){ o.onStatus('server offers no STARTTLS — the password would travel in clear text','fatal'); closed=true; return; }
    }
    if(!authed){
      const mech=mgKid(f,'mechanisms'), has=mech && mgKids(mech,'mechanism').some(m=>m.text.trim()==='PLAIN');
      if(!has){ o.onStatus('server does not offer SASL PLAIN','fatal'); closed=true; return; }
      w("<auth xmlns='urn:ietf:params:xml:ns:xmpp-sasl' mechanism='PLAIN'>"+mgB64(mgUtf8('\0'+o.user+'\0'+o.pass))+'</auth>');
      return;
    }
    w("<iq type='set' id='bind1'><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'><resource>"+mgXmlEsc(o.resource||'dsp')+'</resource></bind></iq>');
  }
  function message(s){
    const body=mgKid(s,'body'); if(!body || !body.text) return;
    const from=s.attrs.from||'', type=s.attrs.type||'chat', bare=from.split('/')[0], res=from.includes('/') ? from.slice(from.indexOf('/')+1) : '';
    const delay=!!mgKid(s,'delay');
    o.onMsg({from:type==='groupchat' ? (res||bare) : bare,to:type==='groupchat' ? bare : jid.split('/')[0],text:body.text,t:Date.now(),
      self:type==='groupchat' && res===nick,delay,id:s.attrs.id||''});
  }
  function on(ev,node){
    if(ev==='close'){ if(!closed){ closed=true; o.onStatus('stream closed by the server','down'); } return; }
    if(ev!=='stanza') return;
    const name=mgLocal(node.name);
    if(name==='features') features(node);
    else if(name==='proceed'){ o.onStatus('upgrading to TLS…','connecting'); o.tls(()=>{ tlsDone=true; stream(); }); }
    else if(name==='success'){ authed=true; stream(); }
    else if(name==='failure'){ o.onStatus('login refused'+(node.kids[0] ? ': '+mgLocal(node.kids[0].name) : ''),'fatal'); closed=true; }
    else if(name==='iq'){
      const t=node.attrs.type;
      if(node.attrs.id==='bind1'){
        if(t==='result'){
          const b=mgKid(node,'bind'), j=b && mgKid(b,'jid'); jid=j ? j.text.trim() : o.user+'@'+o.domain;
          w('<presence/>');
          if(room) w("<presence to='"+mgXmlEsc(room+'/'+nick)+"'><x xmlns='http://jabber.org/protocol/muc'><history maxstanzas='0'/></x></presence>");
          ready=true; o.onStatus('connected as '+jid+(room ? ', room '+room : ''),'up');
        } else { o.onStatus('could not bind a resource','fatal'); closed=true; }
      } else if(t==='get' || t==='set'){
        if(node.kids.some(k=>mgLocal(k.name)==='ping')) w("<iq type='result' id='"+mgXmlEsc(node.attrs.id||'')+"' to='"+mgXmlEsc(node.attrs.from||o.domain)+"'/>");
        else w("<iq type='error' id='"+mgXmlEsc(node.attrs.id||'')+"' to='"+mgXmlEsc(node.attrs.from||o.domain)+"'><error type='cancel'><service-unavailable xmlns='urn:ietf:params:xml:ns:xmpp-stanzas'/></error></iq>");
      }
    }
    else if(name==='message'){ if(node.attrs.type!=='error') message(node); }
    else if(name==='presence' && node.attrs.type==='error' && room && (node.attrs.from||'').startsWith(room)){
      const e=mgKid(node,'error'); o.onStatus('room refused: '+(e && e.kids[0] ? mgLocal(e.kids[0].name) : 'error'),'warn');
    }
  }
  return {
    get ready(){ return ready; },
    start(){ o.onStatus('opening stream…','connecting'); stream(); },
    feed(s){ if(!closed) px(s); },
    send(text,to){
      to=String(to||room||'').trim(); if(!to || !ready) return false;
      const type=room && to.split('/')[0]===room ? 'groupchat' : 'chat';
      w("<message type='"+type+"' to='"+mgXmlEsc(to)+"' id='m"+(++iq)+"'><body>"+mgXmlEsc(mgSplit(text,2000).join('\n'))+'</body></message>');
      return true;
    },
    quit(){ try{ w('</stream:stream>'); }catch(e){} closed=true; },
  };
}

// ---------- APRS-IS ----------
// Пароль APRS-IS (passcode) — общеизвестная свёртка позывного. Сами его не подставляем: выход в эфир/сеть под позывным — для его владельца.
function mgAprsPass(call){
  call=String(call).toUpperCase().split('-')[0]; let h=0x73e2;
  for(let i=0;i<call.length;i+=2){ h^=call.charCodeAt(i)<<8; if(i+1<call.length) h^=call.charCodeAt(i+1); }
  return h&0x7fff;
}
const mgB91=s=>{ let v=0; for(const c of s) v=v*91+(c.charCodeAt(0)-33); return v; };
// 'SRC>DST,PATH:payload' → {src,dst,path,kind,…}; kind: message | ack | rej | position | status | other; null — не пакет (комментарий сервера)
function mgAprsParse(line){
  line=String(line).replace(/[\r\n]+$/,'');
  const i=line.indexOf(':'); if(i<0 || line[0]==='#') return null;
  const head=line.slice(0,i), pl=line.slice(i+1), g=head.indexOf('>'); if(g<1 || !pl) return null;
  const parts=head.slice(g+1).split(','), r={src:head.slice(0,g),dst:parts[0],path:parts.slice(1),kind:'other',raw:line};
  const t=pl[0];
  if(t===':'){
    const m=/^:(.{9}):([\s\S]*)$/.exec(pl); if(!m) return r;
    r.to=m[1].trim(); let text=m[2];
    const ack=/^(ack|rej)([^\s{]{1,5})\s*$/.exec(text);
    if(ack){ r.kind=ack[1]; r.id=ack[2]; return r; }
    const b=/\{([^{]{1,5})$/.exec(text); if(b){ r.id=b[1]; text=text.slice(0,b.index); }
    r.kind='message'; r.text=text; return r;
  }
  if(t==='>'){ r.kind='status'; r.text=pl.slice(1); return r; }
  if(t==='!' || t==='=' || t==='/' || t==='@'){
    const body=t==='!' || t==='=' ? pl.slice(1) : pl.slice(8);
    let m=/^(\d{2})([\d ]{2}\.[\d ]{2})([NS])(.)(\d{3})([\d ]{2}\.[\d ]{2})([EW])(.)([\s\S]*)$/.exec(body);
    if(m){
      const f=s=>+s.replace(/ /g,'0');
      r.lat=(+m[1]+f(m[2])/60)*(m[3]==='S' ? -1 : 1); r.lon=(+m[5]+f(m[6])/60)*(m[7]==='W' ? -1 : 1);
      r.symbol=m[4]+m[8]; r.text=m[9]; r.kind='position'; return r;
    }
    m=/^([\/\\A-Za-j])([!-{]{4})([!-{]{4})(.)([\s\S]{2})([\s\S])([\s\S]*)$/.exec(body);   // сжатый вид
    if(m){ r.lat=90-mgB91(m[2])/380926; r.lon=-180+mgB91(m[3])/190463; r.symbol=m[1]+m[4]; r.text=m[7]; r.kind='position'; }
    return r;
  }
  return r;
}
const mgAprsPad=c=>String(c).toUpperCase().padEnd(9).slice(0,9);
const mgAprsMsg=(src,to,text,id)=>src+'>APDSP,TCPIP*::'+mgAprsPad(to)+':'+mgLine(text)+(id ? '{'+id : '');
const mgAprsAck=(src,to,id)=>src+'>APDSP,TCPIP*::'+mgAprsPad(to)+':ack'+id;
// o: {call,pass (passcode; пусто или -1 — только приём),filter,write(line),onMsg,onStatus,ackMs,tries}
function mgAprsClient(o){
  const call=String(o.call||'').trim().toUpperCase();
  const pass=/^\d+$/.test(String(o.pass||'').trim()) ? String(o.pass).trim() : '-1';
  let n=0, ready=false; const wait=new Map();
  const tx=pass!=='-1';
  const self={
    get ready(){ return ready; },
    get canSend(){ return tx; },
    start(){
      o.write('user '+mgLine(call)+' pass '+pass+' vers DSP 1'+(o.filter ? ' filter '+mgLine(o.filter) : ''));
      o.onStatus('logging in as '+call+'…','connecting');
    },
    feed(){ },
    line(l){
      if(l[0]==='#'){
        const m=/logresp (\S+) (verified|unverified)/.exec(l);
        if(m){ ready=true; o.onStatus('logged in as '+m[1]+' ('+m[2]+(m[2]==='unverified' ? ' — receive only' : '')+')'+(o.filter ? ', filter '+o.filter : ''),'up'); }
        return;
      }
      const p=mgAprsParse(l); if(!p) return;
      if(p.kind==='ack' || p.kind==='rej'){
        if(p.to===call && wait.has(p.id)){ clearTimeout(wait.get(p.id).t); wait.delete(p.id); o.onStatus('message '+p.id+' '+(p.kind==='ack' ? 'delivered' : 'rejected by '+p.src),'up'); }
        return;
      }
      if(p.kind==='message'){
        if(p.to===call && p.id) o.write(mgAprsAck(call,p.src,p.id));       // подтверждаем получение
        o.onMsg({from:p.src,to:p.to,text:p.text,t:Date.now(),id:p.id||'',kind:'message',direct:p.to===call,self:p.src===call});
      } else if(p.kind==='position') o.onMsg({from:p.src,text:'',comment:p.text,lat:p.lat,lon:p.lon,symbol:p.symbol,t:Date.now(),kind:'position'});
      else if(p.kind==='status') o.onMsg({from:p.src,text:'',comment:p.text,t:Date.now(),kind:'status'});
    },
    send(text,to){
      if(!tx){ o.onStatus('APRS-IS: receive only — enter the passcode to send','warn'); return false; }
      to=String(to||'').trim().toUpperCase();
      if(!/^[A-Z0-9]{1,6}(-\d{1,2})?$/.test(to)){ o.onStatus('APRS-IS: address a message as «@CALL text» or with the «to» input','warn'); return false; }
      for(const part of mgSplit(text,67)){
        const id=String(++n%100000);
        o.write(mgAprsMsg(call,to,part,id));
        const line=mgAprsMsg(call,to,part,id);
        const e={left:o.tries||3}; wait.set(id,e);
        const again=()=>{ if(!wait.has(id)) return; if(--e.left<=0){ wait.delete(id); o.onStatus('message '+id+' to '+to+' not acknowledged','warn'); return; } o.write(line); e.t=setTimeout(again,o.ackMs||30000); };
        e.t=setTimeout(again,o.ackMs||30000);
      }
      return true;
    },
    stop(){ for(const e of wait.values()) clearTimeout(e.t); wait.clear(); },
  };
  return self;
}
