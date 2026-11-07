"use strict";
/* HTTP/1.x (+ SIP, RTSP) для HEX Structure (поле t:'http') и Packet Analyzer — без DOM, проверяется в tools/test-httpdis.mjs.
   hxTryParse(байты, opt) → {msg, used} | {need:true} | null (не HTTP); msg.rows — строки с границами в байтах (для подсветки).
   Content-Length, chunked, ответ «до закрытия» (opt.flush), форма / JSON / multipart / куки / Basic-авторизация.
   hxRec(msg) — плоская запись (method, path, status, h.<заголовок>, q.<параметр>, form.<поле>, json.<путь>, cookie.<имя>…).
   hxBuild(spec) — обратно в байты (Content-Length считается сам). */

const HX_METHOD=/^(GET|POST|PUT|HEAD|DELETE|OPTIONS|PATCH|CONNECT|TRACE|PROPFIND|PROPPATCH|MKCOL|COPY|MOVE|LOCK|UNLOCK|REPORT|PURGE|M-SEARCH|NOTIFY|SUBSCRIBE|UNSUBSCRIBE|INVITE|ACK|BYE|CANCEL|REGISTER|MESSAGE|INFO|PRACK|REFER|UPDATE|PUBLISH|SETUP|PLAY|PAUSE|TEARDOWN|DESCRIBE|ANNOUNCE|RECORD|REDIRECT|GET_PARAMETER|SET_PARAMETER)$/;
const HX_MAXHEAD=65536;
const hxStr=(b,a,z)=>{ let s=''; for(let i=a;i<z;i++) s+=String.fromCharCode(b[i]); return s; };
const hxUtf8=s=>{ try{ return decodeURIComponent(escape(s)); }catch(e){ return s; } };       // latin1-строка байтов → текст UTF-8
const hxUrlDec=s=>{ s=String(s).replace(/\+/g,' '); try{ return decodeURIComponent(s); }catch(e){ return s; } };
const HX_REASON={100:'Continue',101:'Switching Protocols',200:'OK',201:'Created',202:'Accepted',204:'No Content',206:'Partial Content',301:'Moved Permanently',302:'Found',303:'See Other',304:'Not Modified',307:'Temporary Redirect',308:'Permanent Redirect',400:'Bad Request',401:'Unauthorized',403:'Forbidden',404:'Not Found',405:'Method Not Allowed',408:'Request Timeout',409:'Conflict',413:'Payload Too Large',415:'Unsupported Media Type',418:"I'm a teapot",429:'Too Many Requests',500:'Internal Server Error',501:'Not Implemented',502:'Bad Gateway',503:'Service Unavailable',504:'Gateway Timeout'};

// конец заголовков (индекс первого байта тела) или -1
function hxFindHead(b){
  const lim=Math.min(b.length,HX_MAXHEAD);
  for(let i=0;i<lim;i++){
    if(b[i]===10){ if(b[i+1]===10) return i+2; if(b[i+1]===13 && b[i+2]===10) return i+3; }
  }
  return -1;
}
function hxStart(line){                                                              // HTTP, RTSP и SIP похожи: строка запроса / статуса и заголовки
  let m=/^([A-Z][A-Z_-]{1,15}) (\S+) (HTTP|RTSP|SIP)\/(\d(?:\.\d)?)$/.exec(line);
  if(m && HX_METHOD.test(m[1])) return {kind:'request',method:m[1],target:m[2],proto:m[3],version:m[4]};
  m=/^(HTTP|RTSP|SIP)\/(\d(?:\.\d)?) (\d{3})(?: (.*))?$/.exec(line);
  if(m) return {kind:'response',proto:m[1],version:m[2],status:+m[3],reason:m[4]||''};
  return null;
}
const hxLooksStart=b=>{ const s=hxStr(b,0,Math.min(b.length,16)); return /^[A-Z_-]{0,15}$/.test(s) || /^(HTTP|RTSP|SIP)\//.test(s) || /^[A-Z][A-Z_-]{1,15} /.test(s); };

// chunked: {body, used} | null (нужно больше данных) | false (битый формат); o — начало первого куска
function hxChunked(b,o){
  const parts=[]; let total=0;
  for(;;){
    let e=o; while(e<b.length && b[e]!==10) e++;
    if(e>=b.length) return null;
    const line=hxStr(b,o,e).trim().split(';')[0];
    if(!/^[0-9a-fA-F]+$/.test(line)) return false;
    const sz=parseInt(line,16); o=e+1;
    if(sz===0){                                                                       // трейлеры до пустой строки
      for(;;){ let e2=o; while(e2<b.length && b[e2]!==10) e2++; if(e2>=b.length) return null; const t=hxStr(b,o,e2).replace(/\r$/,''); o=e2+1; if(t==='') break; }
      break;
    }
    if(o+sz>b.length) return null;
    parts.push(b.subarray(o,o+sz)); total+=sz; o+=sz;
    if(o>=b.length) return null;
    if(b[o]===13){ o++; if(o>=b.length) return null; }
    if(b[o]!==10) return false;
    o++;
  }
  const body=new Uint8Array(total); let k=0; for(const p of parts){ body.set(p,k); k+=p.length; }
  return {body,used:o};
}

function hxQuery(s,out,pre){
  for(const kv of String(s||'').split('&')){
    if(!kv) continue;
    const i=kv.indexOf('='), k=hxUrlDec(i<0 ? kv : kv.slice(0,i)), v=i<0 ? '' : hxUrlDec(kv.slice(i+1));
    out[pre+k]= (pre+k) in out ? out[pre+k]+', '+v : v;
  }
}
function hxFlat(o,pre,out,depth){
  if(Object.keys(out).length>300) return;
  if(o===null || typeof o!=='object'){ out[pre]=o; return; }
  if(depth>6){ out[pre]=JSON.stringify(o).slice(0,200); return; }
  if(Array.isArray(o)){ out[pre+'.length']=o.length; o.forEach((v,i)=>hxFlat(v,pre+'['+i+']',out,depth+1)); return; }
  for(const k of Object.keys(o)) hxFlat(o[k],pre+'.'+k,out,depth+1);
}
function hxMultipart(body,boundary){
  const s=hxStr(body,0,body.length), parts=[], sep='--'+boundary;
  for(const chunk of s.split(sep).slice(1)){
    if(chunk.startsWith('--')) break;
    const c=chunk.replace(/^\r?\n/,''), i=c.search(/\r?\n\r?\n/);
    if(i<0) continue;
    const hd=c.slice(0,i), m=/^\r?\n\r?\n/.exec(c.slice(i)), val=c.slice(i+m[0].length).replace(/\r?\n$/,'');
    const dis=/content-disposition:[^\n]*/i.exec(hd), nm=dis && /\bname="([^"]*)"/.exec(dis[0]), fn=dis && /filename="([^"]*)"/.exec(dis[0]), ct=/content-type:\s*([^\r\n]+)/i.exec(hd);
    parts.push({name:nm ? nm[1] : '',filename:fn ? fn[1] : '',ctype:ct ? ct[1].trim() : '',size:val.length,text:fn ? '' : hxUtf8(val).slice(0,1000)});
  }
  return parts;
}
const hxIsText=(ct,b)=>{
  if(/^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|x-ndjson)|[^;]*\+(json|xml))/i.test(ct||'')) return true;
  if(ct && /^(image|audio|video|font)\/|octet-stream|zip|gzip|pdf/i.test(ct)) return false;
  let bad=0; const n=Math.min(b.length,200); for(let i=0;i<n;i++){ const x=b[i]; if(x<9 || (x>13 && x<32) || x===127) bad++; }
  return n>0 && bad<n/20;
};

// разбор одного сообщения с начала b. opt.flush — данных больше не будет (неполное тело отдаём как есть); opt.head — ответ на HEAD
function hxTryParse(b,opt){
  opt=opt||{};
  if(!(b instanceof Uint8Array)) b=Uint8Array.from(b);
  const end=hxFindHead(b);
  if(end<0){ if(b.length>=HX_MAXHEAD || !b.length || !hxLooksStart(b)) return null; return opt.flush ? null : {need:true}; }
  const lines=hxStr(b,0,end).split(/\r?\n/), st=hxStart(lines[0]);
  if(!st) return null;
  const rows=[], hlist=[], h={}; let off=lines[0].length+(b[lines[0].length]===13 ? 2 : 1);
  rows.push({k:'start',v:lines[0],a:0,z:off});
  for(let i=1;i<lines.length;i++){
    const l=lines[i], len=l.length+(b[off+l.length]===13 ? 2 : 1);
    if(l!==''){
      if(/^[ \t]/.test(l) && hlist.length) hlist[hlist.length-1][1]+=' '+l.trim();
      else{ const c=l.indexOf(':'); if(c>0){ hlist.push([l.slice(0,c).trim(),l.slice(c+1).trim()]); rows.push({k:'h.'+l.slice(0,c).trim().toLowerCase(),v:l.slice(c+1).trim(),a:off,z:off+len}); } }
    }
    off+=len;
  }
  for(const [k,v] of hlist){ const key=k.toLowerCase(); h[key]= key in h ? h[key]+(key==='set-cookie' ? '\n' : ', ')+v : v; }
  let body=new Uint8Array(0), used=end, complete=true;
  const noBody= st.kind==='response' && (st.status<200 || st.status===204 || st.status===304 || opt.head);
  if(!noBody){
    if(/chunked/i.test(h['transfer-encoding']||'')){
      const r=hxChunked(b,end);
      if(r===null){ if(!opt.flush) return {need:true}; body=b.subarray(end); used=b.length; complete=false; }
      else if(r===false){ body=b.subarray(end); used=b.length; complete=false; }
      else{ body=r.body; used=r.used; }
    } else if(h['content-length']!==undefined && /^\d+$/.test(h['content-length'].trim())){
      const n=+h['content-length'];
      if(end+n>b.length){ if(!opt.flush) return {need:true}; body=b.subarray(end); used=b.length; complete=false; }
      else{ body=b.subarray(end,end+n); used=end+n; }
    } else if(st.kind==='response'){                                                   // длина неизвестна — до закрытия соединения
      if(!opt.flush) return {need:true};
      body=b.subarray(end); used=b.length; complete=false;
    }
  }
  const m=Object.assign({},st,{headers:h,headerList:hlist,body:body.slice(),complete,rows,len:used,headLen:end});
  m.ctype=(h['content-type']||'').split(';')[0].trim().toLowerCase(); m.enc=h['content-encoding']||'';
  m.host=h.host||'';
  if(st.kind==='request'){
    const q=st.target.indexOf('?'), hs=st.target.indexOf('#');
    m.path=hxUrlDec((q<0 ? st.target : st.target.slice(0,q)).split('#')[0]); m.queryStr=q<0 ? '' : st.target.slice(q+1,hs>q ? hs : undefined);
    m.url=(m.host ? m.host : '')+m.path+(m.queryStr ? '?'+m.queryStr : '');
  }
  m.bodyText= body.length && hxIsText(m.ctype,body) ? hxUtf8(hxStr(body,0,Math.min(body.length,65536))) : '';
  m.form={}; m.json={}; m.parts=[]; m.cookie={};
  if(m.bodyText && m.ctype==='application/x-www-form-urlencoded') hxQuery(m.bodyText,m.form,'');
  if(m.bodyText && (/json/.test(m.ctype) || /^\s*[\[{]/.test(m.bodyText))){ try{ hxFlat(JSON.parse(m.bodyText),'json',m.json,0); if(!Object.keys(m.json).length) m.json={}; }catch(e){ /* не JSON */ } }
  const mb=/multipart\/[^;]+;.*boundary="?([^";]+)"?/i.exec(h['content-type']||'');
  if(mb && body.length) m.parts=hxMultipart(body,mb[1]);
  for(const c of String(h.cookie||'').split(/;\s*/)){ const i=c.indexOf('='); if(i>0) m.cookie[c.slice(0,i)]=c.slice(i+1); }
  for(const c of String(h['set-cookie']||'').split('\n')){ const i=c.indexOf('='), j=c.indexOf(';'); if(i>0 && c) m.cookie[c.slice(0,i)]=c.slice(i+1,j<0 ? undefined : j); }
  const au=/^Basic\s+(\S+)/i.exec(h.authorization||'');
  if(au){ try{ const d=atob(au[1]), i=d.indexOf(':'); m.user=i<0 ? d : d.slice(0,i); m.pass=i<0 ? '' : d.slice(i+1); }catch(e){ /* не base64 */ } }
  if(body.length) rows.push({k:'body',v:m.bodyText ? m.bodyText.slice(0,200) : body.length+' bytes',a:end,z:used});
  return {msg:m,used};
}

// плоская запись для вывода и фильтра
function hxRec(m){
  const r={proto:m.proto,kind:m.kind,version:m.version,complete:m.complete,len:m.len,clen:m.body.length,ctype:m.ctype,enc:m.enc,host:m.host};
  if(m.kind==='request'){ r.method=m.method; r.target=m.target; r.path=m.path; r.url=m.url; if(m.queryStr) hxQuery(m.queryStr,r,'q.'); }
  else{ r.status=m.status; r.reason=m.reason; }
  for(const [k,v] of Object.entries(m.headers)) r['h.'+k]=v;
  for(const [k,v] of Object.entries(m.form)) r['form.'+k]=v;
  Object.assign(r,m.json);
  for(const [k,v] of Object.entries(m.cookie)) r['cookie.'+k]=v;
  if(m.user!==undefined){ r.user=m.user; r.pass=m.pass; }
  if(m.parts.length){ r.parts=m.parts; r.files=m.parts.filter(p=>p.filename).map(p=>p.filename).join(', '); }
  r.body=m.bodyText.slice(0,4096);
  r.head=[m.kind==='request' ? m.method+' '+m.target+' '+m.proto+'/'+m.version : m.proto+'/'+m.version+' '+m.status+' '+m.reason,...m.headerList.map(x=>x[0]+': '+x[1])].join('\n');
  return r;
}
function hxLine(r){
  const sz=r.clen ? ' · '+r.clen+' B' : '';
  return r.kind==='request' ? r.method+' '+(r.host ? r.host : '')+r.target+(r.ctype ? ' ['+r.ctype+']' : '')+sz
    : r.status+' '+(r.reason||HX_REASON[r.status]||'')+(r.ctype ? ' ['+r.ctype+']' : '')+sz;
}

// ---- сборка ----
// spec: {kind, method, target|path, version, status, reason, h:{имя:значение}, body (текст) | json | form:{…}}; Content-Length — сам
function hxBuild(sp){
  const ver=sp.version||'1.1', hd=Object.assign({},sp.h||{});
  let body=sp.body!==undefined && sp.body!==null ? String(sp.body) : '';
  const isRes= sp.kind==='response' || (sp.kind===undefined && sp.status!==undefined && !sp.method);
  const has=k=>Object.keys(hd).some(x=>x.toLowerCase()===k);
  if(sp.form && typeof sp.form==='object'){ body=Object.entries(sp.form).map(([k,v])=>encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&'); if(!has('content-type')) hd['Content-Type']='application/x-www-form-urlencoded'; }
  else if(sp.json!==undefined){ body=typeof sp.json==='string' ? sp.json : JSON.stringify(sp.json); if(!has('content-type')) hd['Content-Type']='application/json'; }
  const enc=new TextEncoder().encode(body);
  if(sp.host && !has('host') && !isRes) hd.Host=sp.host;
  if((enc.length || sp.method==='POST' || sp.method==='PUT' || sp.method==='PATCH') && !has('content-length') && !has('transfer-encoding')) hd['Content-Length']=String(enc.length);
  const pr=sp.proto||'HTTP', first= isRes ? pr+'/'+ver+' '+(sp.status||200)+' '+(sp.reason!==undefined && sp.reason!=='' ? sp.reason : HX_REASON[sp.status||200]||'')
    : (sp.method||'GET')+' '+(sp.target||sp.path||'/')+' '+pr+'/'+ver;
  const head=[first.trimEnd(),...Object.entries(hd).map(([k,v])=>k+': '+v),'',''].join('\r\n');
  const hb=new TextEncoder().encode(head), out=new Uint8Array(hb.length+enc.length);
  out.set(hb); out.set(enc,hb.length); return out;
}
