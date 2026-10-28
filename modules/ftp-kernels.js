"use strict";
/* FTP (RFC 959 + 2428 / 3659 в минимуме) поверх сокетов приложения: сервер над vfs (http-kernels.js) и клиент.
   Сервер держит один порт для пассивных соединений данных на все сессии (приложение даёт всего 4 сервера).
   Без DOM — tools/test-ftp.mjs. */

const FTP_MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function ftpLsLine(f){
  const d=new Date(f.mtime||0), z=n=>String(n).padStart(2,'0');
  const date=FTP_MON[d.getUTCMonth()]+' '+String(d.getUTCDate()).padStart(2,' ')+' '+z(d.getUTCHours())+':'+z(d.getUTCMinutes());
  return (f.dir ? 'drwxr-xr-x' : '-rw-r--r--')+' 1 dsp dsp '+String(f.size||0).padStart(10,' ')+' '+date+' '+f.name;
}
const ftpMdtm=ms=>{ const d=new Date(ms||0), z=(n,w=2)=>String(n).padStart(w,'0'); return d.getUTCFullYear()+z(d.getUTCMonth()+1)+z(d.getUTCDate())+z(d.getUTCHours())+z(d.getUTCMinutes())+z(d.getUTCSeconds()); };
const ftpPeerIp=p=>String(p||'').replace(/:\d+$/,'');

class FtpServer{
  // opt: user, pass (пусто — вход без пароля), write, host (адрес в ответе на PASV), pasvPort (по умолчанию порт управления + 1), onLog(rec)
  constructor(ns,vfs,opt={}){ this.ns=ns; this.vfs=vfs; this.opt=opt; this.ctl=null; this.data=null; this.waiters=[]; this.active=new Set(); this.stats={sessions:0,files:0,tx:0,rx:0}; }
  async start(port,lan=true){
    this.ctl=await this.ns.listen(port,c=>this._session(c),lan);
    try{ this.data=await this.ns.listen(this.opt.pasvPort||(this.ctl.port+1),c=>this._dataIn(c),lan); }
    catch(e){ await this.ctl.close(); this.ctl=null; throw e; }
    return {port:this.ctl.port,dataPort:this.data.port};
  }
  async stop(){ for(const s of [this.ctl,this.data]) if(s) await s.close(); this.ctl=this.data=null; for(const c of [...this.active]) await c.close(); this.active.clear(); for(const w of this.waiters.splice(0)) w.res(null); }
  _dataIn(c){
    const i=this.waiters.findIndex(w=>w.ip===ftpPeerIp(c.peer));
    if(i<0){ c.close(); return; }
    const [w]=this.waiters.splice(i,1); clearTimeout(w.timer); w.res(c);
  }
  _awaitData(ip,ms=15000){ return new Promise(res=>{ const w={ip,res,timer:setTimeout(()=>{ const k=this.waiters.indexOf(w); if(k>=0) this.waiters.splice(k,1); res(null); },ms)}; this.waiters.push(w); }); }
  _log(r){ this.opt.onLog?.(r); }
  async _session(c){
    this.active.add(c); this.stats.sessions++;
    const ip=ftpPeerIp(c.peer);
    const S={cwd:'/',user:null,ok:!this.opt.user,type:'A',rest:0,rnfr:null,pasv:false,port:null};
    const say=(code,text)=>c.write(code+' '+text+'\r\n');
    const abs=p=>vfsNorm(p && p[0]==='/' ? p : S.cwd+'/'+(p||''));
    try{
      await say(220,'DSP FTP ready');
      for(;;){
        const line=await c.readLine(300000); if(line==null) break;
        const sp=line.indexOf(' '), cmd=(sp<0 ? line : line.slice(0,sp)).toUpperCase(), arg=sp<0 ? '' : line.slice(sp+1).trim();
        if(cmd==='QUIT'){ await say(221,'bye'); break; }
        if(cmd==='USER'){ S.user=arg; S.ok=!this.opt.user; await say(this.opt.user ? 331 : 230,this.opt.user ? 'password required' : 'logged in'); continue; }
        if(cmd==='PASS'){
          if(!this.opt.user || (S.user===this.opt.user && arg===(this.opt.pass||''))){ S.ok=true; await say(230,'logged in'); }
          else await say(530,'login incorrect');
          continue;
        }
        if(cmd==='FEAT'){ await c.write('211-Features:\r\n UTF8\r\n SIZE\r\n MDTM\r\n REST STREAM\r\n EPSV\r\n MLST type*;size*;modify*;\r\n211 End\r\n'); continue; }
        if(cmd==='SYST'){ await say(215,'UNIX Type: L8'); continue; }
        if(cmd==='NOOP'){ await say(200,'ok'); continue; }
        if(cmd==='OPTS'){ await say(200,'ok'); continue; }
        if(!S.ok){ await say(530,'log in first'); continue; }
        try{
          switch(cmd){
            case 'PWD': case 'XPWD': await say(257,'"'+S.cwd+'" is the current directory'); break;
            case 'CWD': case 'XCWD': { const p=abs(arg), st=await this.vfs.stat(p); if(st && st.dir){ S.cwd=p; await say(250,'ok'); } else await say(550,'not a directory'); break; }
            case 'CDUP': case 'XCUP': S.cwd=vfsSplit(S.cwd)[0]; await say(250,'ok'); break;
            case 'TYPE': S.type=/^I/i.test(arg) ? 'I' : 'A'; await say(200,'type '+S.type); break;
            case 'MODE': case 'STRU': await say(200,'ok'); break;
            case 'PASV': case 'EPSV': {
              if(!this.data) { await say(425,'no data port'); break; }
              S.port=null; S.pasv=true;
              const p=this.data.port, host=(this.opt.host||'127.0.0.1').split('.');
              if(cmd==='PASV') await say(227,'Entering Passive Mode ('+host.join(',')+','+(p>>8)+','+(p&255)+')');
              else await say(229,'Entering Extended Passive Mode (|||'+p+'|)');
              S.dataP=this._awaitData(ip);                           // соединение придёт до команды передачи или после неё
              break;
            }
            case 'PORT': { const n=arg.split(',').map(Number); if(n.length!==6 || n.some(x=>!(x>=0&&x<=255))){ await say(501,'bad PORT'); break; } S.port={host:n.slice(0,4).join('.'),port:n[4]*256+n[5]}; S.pasv=false; await say(200,'ok'); break; }
            case 'EPRT': { const m=/^\|1\|([\d.]+)\|(\d+)\|$/.exec(arg); if(!m){ await say(501,'bad EPRT'); break; } S.port={host:m[1],port:+m[2]}; S.pasv=false; await say(200,'ok'); break; }
            case 'REST': S.rest=Math.max(0,parseInt(arg,10)||0); await say(350,'restarting at '+S.rest); break;
            case 'LIST': case 'NLST': case 'MLSD': {
              const flags=/^-/.test(arg) ? '' : arg, p=abs(flags), st=await this.vfs.stat(p);
              if(!st){ await say(550,'not found'); break; }
              const items=st.dir ? await this.vfs.list(p) : [{...st}];
              const text=items.map(f=>cmd==='NLST' ? f.name : cmd==='MLSD' ? 'type='+(f.dir ? 'dir' : 'file')+';size='+f.size+';modify='+ftpMdtm(f.mtime)+'; '+f.name : ftpLsLine(f)).join('\r\n')+(items.length ? '\r\n' : '');
              await this._send(c,S,say,nsEnc(text),ip,150,'listing');
              break;
            }
            case 'RETR': {
              const p=abs(arg), st=await this.vfs.stat(p);
              if(!st || st.dir){ await say(550,'not a file'); break; }
              const bytes=await this.vfs.read(p,S.rest||0); S.rest=0;
              if(await this._send(c,S,say,bytes,ip,150,'file')){ this.stats.files++; this.stats.tx+=bytes.length; this._log({ev:'download',path:p,bytes:bytes.length,peer:c.peer}); }
              break;
            }
            case 'STOR': case 'APPE': {
              if(!this.opt.write){ await say(550,'read only'); break; }
              const p=abs(arg), st=await this.vfs.stat(p);
              if(st && st.dir){ await say(550,'is a directory'); break; }
              const dc=await this._dataConn(S,say,ip,150); if(!dc) break;
              const got=await dc.readAll(600000).catch(()=>null); await dc.close();
              if(got==null){ await say(426,'transfer aborted'); break; }
              const old=cmd==='APPE' && st ? await this.vfs.read(p) : S.rest && st ? (await this.vfs.read(p)).subarray(0,S.rest) : null; S.rest=0;
              const all=old ? nsCat([old,got]) : got;
              await this.vfs.write(p,all);
              await say(226,'stored'); this.stats.files++; this.stats.rx+=got.length; this._log({ev:'upload',path:p,bytes:got.length,peer:c.peer});
              this.opt.onUpload?.(p,all);
              break;
            }
            case 'DELE': case 'RMD': case 'XRMD': {
              if(!this.opt.write){ await say(550,'read only'); break; }
              const p=abs(arg), st=await this.vfs.stat(p);
              if(!st || (cmd==='DELE')===st.dir){ await say(550,'not found'); break; }
              await this.vfs.remove(p); this._log({ev:'delete',path:p,peer:c.peer}); await say(250,'deleted'); break;
            }
            case 'MKD': case 'XMKD': { if(!this.opt.write){ await say(550,'read only'); break; } const p=abs(arg); await this.vfs.mkdir(p); await say(257,'"'+p+'" created'); break; }
            case 'RNFR': { const p=abs(arg); if(await this.vfs.stat(p)){ S.rnfr=p; await say(350,'ok, now RNTO'); } else await say(550,'not found'); break; }
            case 'RNTO': { if(!this.opt.write || !S.rnfr){ await say(503,'RNFR first'); break; } await this.vfs.rename(S.rnfr,abs(arg)); S.rnfr=null; await say(250,'renamed'); break; }
            case 'SIZE': { const st=await this.vfs.stat(abs(arg)); if(st && !st.dir) await say(213,String(st.size)); else await say(550,'not a file'); break; }
            case 'MDTM': { const st=await this.vfs.stat(abs(arg)); if(st && !st.dir) await say(213,ftpMdtm(st.mtime)); else await say(550,'not a file'); break; }
            case 'ABOR': await say(226,'ok'); break;
            case 'STAT': await say(211,'DSP FTP'); break;
            default: await say(502,'not implemented: '+cmd);
          }
        }catch(e){ if(!c.open) break; await say(550,String(e.message||e).slice(0,100)); }
      }
    }catch(e){ /* обрыв */ }
    this.active.delete(c); c.close();
  }
  // соединение данных: пассивное (уже ждёт) или активное (подключаемся к клиенту)
  async _dataConn(S,say,ip,code){
    let dc=null;
    if(S.pasv && S.dataP){ await say(code,'opening data connection'); dc=await S.dataP; S.dataP=null; S.pasv=false; }
    else if(S.port){ await say(code,'opening data connection'); try{ dc=await this.ns.connect(S.port.host,S.port.port,8000); }catch(e){} S.port=null; }
    else { await say(425,'use PASV or PORT first'); return null; }
    if(!dc) await say(425,'cannot open data connection');
    return dc;
  }
  async _send(c,S,say,bytes,ip,code){
    const dc=await this._dataConn(S,say,ip,code); if(!dc) return false;
    try{ await dc.write(bytes); await dc.close(); await say(226,'transfer complete'); return true; }
    catch(e){ await dc.close(); await say(426,'transfer aborted'); return false; }
  }
}

/* ---------- клиент ---------- */
function ftpParseList(text){
  const out=[];
  for(const raw of text.split(/\r?\n/)){
    const l=raw.trimEnd(); if(!l) continue;
    let m;
    if((m=/^type=([^;]*);(?:[^ ]*;)* (.+)$/i.exec(l))){                        // MLSD
      const f={name:m[2],dir:/dir/i.test(m[1]),size:0,mtime:0};
      const sz=/size=(\d+)/i.exec(l); if(sz) f.size=+sz[1];
      out.push(f);
    } else if((m=/^([dl-])[rwxsStT-]{9}\+?\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\w{3}\s+\d+\s+[\d:]+)\s+(.+)$/.exec(l))){   // unix
      out.push({name:m[4].replace(/ -> .*$/,''),dir:m[1]==='d',size:+m[2],date:m[3]});
    } else if((m=/^(\d\d-\d\d-\d\d)\s+(\d\d:\d\d[AP]M)\s+(<DIR>|\d+)\s+(.+)$/.exec(l))){                          // DOS
      out.push({name:m[4],dir:m[3]==='<DIR>',size:m[3]==='<DIR>' ? 0 : +m[3],date:m[1]+' '+m[2]});
    } else out.push({name:l.trim(),dir:false,size:0});
  }
  return out.filter(f=>f.name!=='.' && f.name!=='..');
}

class FtpClient{
  constructor(ns){ this.ns=ns; this.c=null; this.host=''; this.feat=''; }
  async _reply(ms=15000){
    let first=await this.c.readLine(ms); if(first==null) throw new Error('connection closed');
    const m=/^(\d{3})([ -])(.*)$/.exec(first); if(!m) throw new Error('bad reply: '+first);
    let text=m[3];
    if(m[2]==='-') for(;;){ const l=await this.c.readLine(ms); if(l==null) throw new Error('connection closed'); text+='\n'+l.replace(/^\d{3}[ -]/,''); if(l.startsWith(m[1]+' ')) break; }
    return {code:+m[1],text};
  }
  async cmd(line,ms){ await this.c.write(line+'\r\n'); return this._reply(ms); }
  async _expect(line,ok,ms){ const r=await this.cmd(line,ms); if(!ok.includes(Math.floor(r.code/100)) && !ok.includes(r.code)) throw Object.assign(new Error(r.code+' '+r.text),{code:r.code}); return r; }
  async connect(host,port=21,user='anonymous',pass='dsp@'){
    this.host=host; this.c=await this.ns.connect(host,port,8000);
    const hi=await this._reply(); if(hi.code!==220) throw new Error(hi.code+' '+hi.text);
    const u=await this.cmd('USER '+user);
    if(u.code===331){ const p=await this.cmd('PASS '+pass); if(p.code!==230) throw new Error(p.code+' '+p.text); }
    else if(u.code!==230) throw new Error(u.code+' '+u.text);
    await this.cmd('TYPE I'); return hi.text;
  }
  async _data(){
    const e=await this.cmd('EPSV');
    const host=this.host; let port;               // адрес из ответа PASV не берём (как curl): сервер за NAT назовёт чужой
    if(e.code===229){ const m=/\(\|\|\|(\d+)\|\)/.exec(e.text); if(!m) throw new Error('bad EPSV: '+e.text); port=+m[1]; }
    else {
      const p=await this._expect('PASV',[2]), m=/(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(p.text);
      if(!m) throw new Error('bad PASV: '+p.text);
      port=+m[5]*256+ +m[6];
    }
    return this.ns.connect(host,port,8000);
  }
  async list(path=''){
    const dc=await this._data();
    const r=await this.cmd('LIST'+(path ? ' '+path : '')); if(Math.floor(r.code/100)!==1){ await dc.close(); throw new Error(r.code+' '+r.text); }
    const body=await dc.readAll(60000); await dc.close(); await this._reply();
    return ftpParseList(nsDec(body));
  }
  async get(path,onProgress){
    const dc=await this._data();
    const r=await this.cmd('RETR '+path); if(Math.floor(r.code/100)!==1){ await dc.close(); throw new Error(r.code+' '+r.text); }
    const body=await dc.readAll(600000); await dc.close(); const e=await this._reply();
    if(e.code!==226 && e.code!==250) throw new Error(e.code+' '+e.text);
    return body;
  }
  async put(path,bytes){
    if(typeof bytes==='string') bytes=nsEnc(bytes);
    const dc=await this._data();
    const r=await this.cmd('STOR '+path); if(Math.floor(r.code/100)!==1){ await dc.close(); throw new Error(r.code+' '+r.text); }
    await dc.write(bytes); await dc.close(); const e=await this._reply();
    if(e.code!==226 && e.code!==250) throw new Error(e.code+' '+e.text);
  }
  del(path){ return this._expect('DELE '+path,[2]); }
  rmd(path){ return this._expect('RMD '+path,[2]); }
  mkd(path){ return this._expect('MKD '+path,[2]); }
  cwd(path){ return this._expect('CWD '+path,[2]); }
  async pwd(){ const r=await this._expect('PWD',[2]); const m=/"([^"]*)"/.exec(r.text); return m ? m[1] : '/'; }
  async size(path){ const r=await this._expect('SIZE '+path,[2]); return +r.text; }
  async rename(a,b){ await this._expect('RNFR '+a,[3]); await this._expect('RNTO '+b,[2]); }
  async quit(){ try{ await this.cmd('QUIT',3000); }catch(e){} await this.c.close(); }
}
