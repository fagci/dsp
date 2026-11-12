"use strict";
/* ============================ Контроллер репитера: DTMF-команды ============================
   Repeater Controller — логика репитера: PTT по несущей (COS) с хвостом, таймаут передатчика, позывной по таймеру и в конце передачи,
   DTMF-команды с паролем (связь с другими узлами, экстренный режим, отключение), блокировка после неверных паролей.
   Repeater Command — зеркало: собирает последовательность DTMF команды (в Transmit DTMF) для проверки без эфира.
   Вход digit — выход digit DTMF: Receive, cos — несущая (gate, squelch или active у CTCSS / DCS Decoder). Автомат и пара
   разбор ↔ сборка — repctl-kernels.js (tools/test-repctl.mjs). Сам звук (позывной Морзе или голосом) собирается из выхода id. */

const rcShow=(n,t)=>{ const r=n.el && n.el.querySelector('.readout'); if(r && r.textContent!==t) r.textContent=t; };

def({ id:'repCtl', title:'Repeater Controller', cat:'Protocols', readout:true, tall:true, w:340,
  kw:'repeater controller dtmf command ptt cos tot hang id emergency link net skywarn ares',
  ins:[{n:'digit',t:'num'},{n:'cos',t:'num'}],
  outs:[{n:'ptt',t:'num'},{n:'id',t:'num'},{n:'emergency',t:'num'},{n:'linked',t:'num'},{n:'text',t:'txt'},{n:'rec',t:'rec'}],
  params:[{n:'pass',t:'text',d:'1234',label:'control password (digits)'},
          {n:'hang',t:'range',min:0,max:10,step:.1,d:2,label:'hang time after the carrier, s'},
          {n:'tot',t:'range',min:0,max:600,step:5,d:180,label:'time-out timer, s (0 — off)'},
          {n:'idEvery',t:'range',min:0,max:1800,step:10,d:600,label:'station ID every, s (0 — off)'},
          {n:'idMin',t:'range',min:0,max:300,step:5,d:30,label:'ID at the end of a transmission if the last was ≥ this long ago, s'},
          {n:'digitTimeout',t:'range',min:1,max:20,step:.5,d:5,label:'pause between the digits of a command, s'},
          {n:'lockout',t:'range',min:10,max:600,step:10,d:60,label:'lock after 3 wrong passwords, s'},
          {n:'minMs',t:'range',min:10,max:200,step:5,d:40,label:'a digit counts after, ms'},
          {n:'needCos',t:'check',d:true,label:'PTT only with the carrier (cos); unwired cos = always on'}],
  init:n=>{ n.st=null; n.key=''; n.log=[]; n.idPulse=0; n.rev=0; },
  process(n,I){
    const p=n.p, key=[p.pass,p.hang,p.tot,p.idEvery,p.idMin,p.digitTimeout,p.lockout,p.minMs,p.needCos].join('|');
    if(n.key!==key){ n.key=key; const old=n.st; n.st=rcNew({pass:String(p.pass).replace(/\D/g,'')||'0000', hang:+p.hang, tot:+p.tot, idEvery:+p.idEvery, idMin:+p.idMin,
      digitTimeout:+p.digitTimeout, lockout:+p.lockout, minMs:+p.minMs, needCos:!!p.needCos});
      if(old){ n.st.linked=old.linked; n.st.emergency=old.emergency; n.st.disabled=old.disabled; } }
    const st=n.st, dt=BLOCK/Eng.sr;
    const ev=rcStep(st,dt,typeof I.digit==='number' ? I.digit : -1,typeof I.cos==='number' ? I.cos : 1);
    const recs=[]; let idHit=0, text=null;
    for(const e of ev){
      if(e.kind==='id') idHit=1;
      const rec={t:Date.now(), src:'REPCTL', id:'REPCTL', ...e}; recs.push(rec);
      n.log.push(new Date().toISOString().slice(11,19)+' '+e.text); if(n.log.length>12) n.log.shift(); n.rev++;
    }
    if(recs.length) text=recs.map(r=>r.text).join('\n');
    return {ptt:st.ptt ? 1 : 0, id:idHit, emergency:st.emergency ? 1 : 0, linked:st.linked.size, text, rec:recs.length ? recs : null};
  },
  drawKey:n=>n.rev+'|'+(n.st&&n.st.ptt)+'|'+(n.st&&n.st.buf),
  draw(n){ const st=n.st; if(!st) return;
    rcShow(n,(st.ptt ? '● PTT' : '○ idle')+(st.emergency ? ' · EMERGENCY' : '')+(st.disabled ? ' · DISABLED' : '')+(st.lock ? ' · TOT' : '')+(st.lockT>0 ? ' · locked '+Math.ceil(st.lockT)+' s' : '')+
      '\nlinked: '+(st.linked.size ? [...st.linked].join(' ') : '—')+(st.buf ? '\ntyping: '+st.buf : '')+(n.log.length ? '\n'+n.log.slice(-8).join('\n') : '\nwait for *'+n.p.pass+' cmd #')); }
});

def({ id:'repCmd', title:'Repeater Command (DTMF)', cat:'Protocols', readout:true, w:300,
  kw:'repeater command dtmf generator encoder link emergency password',
  ins:[{n:'go',t:'num'}], outs:[{n:'text',t:'txt'},{n:'go',t:'num'},{n:'rec',t:'rec'}],
  params:[{n:'cmd',t:'select',opts:['link','unlink','emergency on','emergency off','id now','disable','enable'],d:'link',label:'command'},
          {n:'args',t:'text',d:'05',label:'node for link / unlink (digits; unlink without — all)'},
          {n:'pass',t:'text',d:'1234',label:'control password'},
          {n:'send',t:'button',label:'Make',fn:n=>{ n.want=true; }}],
  init:n=>{ n.want=false; n.prevGo=0; n.pulse=0; n.last=''; },
  process(n,I){
    const go=I.go||0; if(go>.5 && n.prevGo<=.5) n.want=true; n.prevGo=go;
    let text=null, out=0, rec=null;
    if(n.pulse>0){ n.pulse--; }
    else if(n.want){
      n.want=false;
      const s=rcBuild(n.p.cmd,n.p.args,String(n.p.pass).replace(/\D/g,''));
      if(s){ text=s; out=1; n.pulse=2; n.last=n.p.cmd+(n.p.args && /link/.test(n.p.cmd) ? ' '+n.p.args : '')+' → '+s;
        rec={t:Date.now(), src:'REPCMD', id:'REPCMD', kind:'command', cmd:n.p.cmd, args:n.p.args, text:s}; }
    }
    return {text, go:out, rec};
  },
  draw(n){ rcShow(n,n.last||'press Make: a DTMF command for the controller (test source)'); }
});
