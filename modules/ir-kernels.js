"use strict";
/* ============================ ИК: ядра ============================
   Общий формат — список длительностей в мкс (метка, пауза, метка, …) и несущая в Гц.
   Внутри графа это строка «F:38000 9000 4500 560 …»; irParse понимает и чужие форматы
   (Flipper, Tasmota, Pronto, LIRC, просто числа), irFormat пишет их обратно.
   Кодеки: NEC, NEC-ext, Samsung32, Sony SIRC 12/15/20, RC5, RC6 (режим 0), JVC, Panasonic (Kaseikyo, 48 бит).
   Неизвестный кадр — irAnalyze: кластеры длительностей и общий декодер «расстояние между импульсами». */

const IR_NEAR=(x,r,t=.3)=>x>=r-Math.max(r*t,120) && x<=r+Math.max(r*t,120);
const IR_FORMATS=['wire','raw µs','flipper','flipper .ir','tasmota','pronto'];
const IR_PROTOS=['NEC','NEC-ext','Samsung','Sony12','Sony15','Sony20','RC5','RC6','JVC','Panasonic'];

/* ---------- разбор и запись текстовых форматов ---------- */
function irParse(text){
  const s=String(text||'').trim(); if(!s) return null;
  const tok=s.split(/[\s,]+/).filter(Boolean);
  if(tok.length>=6 && tok[0]==='0000' && tok.every(t=>/^[0-9a-f]{4}$/i.test(t))){      // Pronto
    const w=tok.map(t=>parseInt(t,16)), unit=w[1]*0.241246, once=w[2]*2, rep=w[3]*2, body=w.slice(4);
    const seq=once ? body.slice(0,once) : body.slice(0,rep);
    const dur=seq.map(x=>Math.round(x*unit)).filter(x=>x>0);
    return dur.length>1 ? {freq:Math.round(1e6/unit), dur} : null;
  }
  let freq=0, body=s, m;
  if(/IRsend/i.test(s)){                                                                  // Tasmota: IRsend 38000,9000,4500,…
    const nums=(s.replace(/^[\s\S]*?IRsend\d*/i,'').match(/\d+/g)||[]).map(Number);
    if(nums.length>3 && nums[0]>=30000 && nums[0]<=60000) freq=nums.shift();
    const dur=nums.filter(x=>x>0);
    return dur.length>1 ? {freq:freq||38000, dur} : null;
  }
  if((m=s.match(/\bF:\s*(\d+)/i)) || (m=s.match(/frequency:\s*(\d+)/i))) freq=+m[1];     // Flipper и наш wire
  body=body.replace(/data:/ig,' ').replace(/\b[A-Za-z_]+:\s*[\d.]+/g,' ').replace(/\d+\s+samples/ig,' ');
  const dur=(body.match(/\d+/g)||[]).map(Number).filter(x=>x>0);
  return dur.length>1 ? {freq:freq||38000, dur} : null;
}
function irFormat(fmt,dur,freq=38000){
  const f=Math.round(freq)||38000;
  switch(fmt){
    case 'raw µs': return dur.join(' ');
    case 'flipper': return 'ir tx RAW F:'+f+' DC:33 '+dur.join(' ');
    case 'flipper .ir': return 'name: Cmd\ntype: raw\nfrequency: '+f+'\nduty_cycle: 0.330000\ndata: '+dur.join(' ');
    case 'tasmota': return 'IRsend '+f+','+dur.join(',');
    case 'pronto': {
      const code=Math.max(1,Math.round(1e6/(f*0.241246))), unit=code*0.241246;
      const d=dur.length%2 ? dur.concat(20000) : dur;
      const hex=x=>Math.max(0,Math.min(0xFFFF,Math.round(x))).toString(16).toUpperCase().padStart(4,'0');
      return ['0000',hex(code),hex(d.length/2),'0000',...d.map(x=>hex(x/unit))].join(' ');
    }
    default: return 'F:'+f+' '+dur.join(' ');
  }
}

/* ---------- биты ---------- */
const irBytes=b=>{ const o=[]; for(let i=0;i+7<b.length;i+=8){ let v=0; for(let k=0;k<8;k++) v|=b[i+k]<<k; o.push(v); } return o; };   // LSB first
const irBitsOf=(v,n,msb)=>Array.from({length:n},(_,k)=>msb ? (v>>(n-1-k))&1 : (v>>k)&1);
const irHex=a=>a.map(v=>v.toString(16).toUpperCase().padStart(2,'0')).join(' ');
function irPdRead(d,i,n,m,s0,s1){                                                        // n бит «расстоянием»: метка m, пауза s0 / s1
  const b=[];
  for(let k=0;k<n;k++){
    const mk=d[i+2*k], sp=d[i+2*k+1];
    if(mk===undefined || sp===undefined || !IR_NEAR(mk,m)) return null;
    if(IR_NEAR(sp,s1)) b.push(1); else if(IR_NEAR(sp,s0)) b.push(0); else return null;
  }
  return b;
}
function irPdWrite(h,m,s0,s1,b,trail=true){
  const d=h ? h.slice() : [];
  for(const x of b) d.push(m, x ? s1 : s0);
  if(trail) d.push(m);
  return d;
}
function irRuns(levels,unit){                                                            // уровни полубитов → длительности (первая — метка)
  const d=[]; let cur=levels[0], n=0;
  for(const l of levels){ if(l===cur) n++; else { d.push(n*unit); cur=l; n=1; } }
  d.push(n*unit);
  return levels[0]===1 ? d : d.slice(1);
}
function irUnits(d,i,unit,maxN){                                                         // длительности → уровни полубитов (с метки), хвост-пауза обрывает
  const u=[]; let lv=1;
  for(;i<d.length;i++,lv^=1){
    const n=Math.round(d[i]/unit);
    if(n<1 || n>maxN || !IR_NEAR(d[i],n*unit,.3)){ if(lv===0 && d[i]>maxN*unit) break; return null; }
    for(let k=0;k<n;k++) u.push(lv);
  }
  return u;
}
function irManch(u,i,n,oneIsMarkFirst){                                                  // n манчестерских бит; пустой хвост дополняем паузой
  const b=[];
  for(let k=0;k<n;k++){
    const a=u[i+2*k], c=u[i+2*k+1]===undefined ? 0 : u[i+2*k+1];
    if(a===undefined) return null;
    if(a===c) return null;
    b.push((a===1)===oneIsMarkFirst ? 1 : 0);
  }
  return b;
}

/* ---------- декодеры ---------- */
const irMsb=b=>b.reduce((v,x)=>v*2+x,0);
function irDecode(d){
  const n=d.length, R=(proto,o)=>({proto,...o});
  if(n<3) return null;
  const hd=(a,b)=>IR_NEAR(d[0],a) && IR_NEAR(d[1],b);
  const pd=(a,b,cnt,m,s0,s1,fn)=>{                                                        // заголовок + cnt бит «расстоянием»; fn(байты) → результат или null
    if(!hd(a,b)) return null;
    const bits=irPdRead(d,2,cnt,m,s0,s1); return bits ? fn(irBytes(bits)) : null;
  };
  const tries=[
    ()=>IR_NEAR(d[0],9000) && IR_NEAR(d[1],2250) && IR_NEAR(d[2],560) && n<=4 ? R('NEC',{repeat:true}) : null,
    ()=>pd(9000,4500,32,560,560,1690,B=>(B[2]^B[3])!==255 ? null :
          (B[0]^B[1])===255 ? R('NEC',{addr:B[0],cmd:B[2],bits:32,hex:irHex(B)}) : R('NEC-ext',{addr:B[0]|B[1]<<8,cmd:B[2],bits:32,hex:irHex(B)})),
    ()=>pd(4500,4500,32,560,560,1690,B=>B[0]!==B[1] || (B[2]^B[3])!==255 ? null : R('Samsung',{addr:B[0],cmd:B[2],bits:32,hex:irHex(B)})),
    ()=>pd(8400,4200,16,526,526,1574,B=>R('JVC',{addr:B[0],cmd:B[1],bits:16,hex:irHex(B)})),
    ()=>pd(3456,1728,48,432,432,1296,B=>(B[2]^B[3]^B[4])!==B[5] ? null :
          R(B[0]===0x02 && B[1]===0x20 ? 'Panasonic' : 'Kaseikyo',{addr:B[2]|B[3]<<8,cmd:B[4],bits:48,hex:irHex(B)})),
    ()=>{                                                                                 // Sony SIRC
      if(!hd(2400,600)) return null;
      const b=[];
      for(let i=2;i<n;i+=2){
        if(IR_NEAR(d[i],600)) b.push(0); else if(IR_NEAR(d[i],1200)) b.push(1); else return null;
        if(i+1>=n || !IR_NEAR(d[i+1],600)) break;
      }
      if(b.length!==12 && b.length!==15 && b.length!==20) return null;
      return R('Sony'+b.length,{addr:irMsb(b.slice(7).reverse()),cmd:irMsb(b.slice(0,7).reverse()),bits:b.length,hex:b.length+'-bit'});
    },
    ()=>{                                                                                 // RC6, режим 0
      if(!hd(2666,889)) return null;
      const u=irUnits(d,2,444,6); if(!u || u[0]!==1 || u[1]!==0) return null;
      const mode=irManch(u,2,3,true), tr=u.slice(8,12), b=irManch(u,12,16,true);
      if(!mode || !b || tr.length<4 || tr[0]===tr[2] || tr[0]!==tr[1] || tr[2]!==tr[3]) return null;
      return R('RC6',{addr:irMsb(b.slice(0,8)),cmd:irMsb(b.slice(8)),mode:irMsb(mode),toggle:tr[0],bits:16,hex:'mode '+irMsb(mode)});
    },
    ()=>{                                                                                 // RC5 / RC5X
      if(!IR_NEAR(d[0],889) && !IR_NEAR(d[0],1778)) return null;
      const u=irUnits(d,0,889,2); if(!u) return null;
      u.unshift(0);
      const b=irManch(u,0,14,false); if(!b || b[0]!==1) return null;
      return R(b[1]?'RC5':'RC5X',{addr:irMsb(b.slice(3,8)),cmd:irMsb(b.slice(8))|((b[1]^1)<<6),toggle:b[2],bits:14,hex:b[1]?'':'field 0'});
    }];
  for(const t of tries){ const r=t(); if(r) return r; }
  return null;
}
function irDescribe(r){
  if(!r) return '';
  if(r.repeat) return r.proto+' repeat';
  const h=v=>'0x'+v.toString(16).toUpperCase().padStart(2,'0');
  return r.proto+' addr '+h(r.addr)+' cmd '+h(r.cmd)+(r.toggle!==undefined ? ' t'+r.toggle : '')+(r.hex ? ' ['+r.hex+']' : '');
}

/* ---------- кодеры ---------- */
const IR_FREQ={NEC:38000,'NEC-ext':38000,Samsung:38000,Sony12:40000,Sony15:40000,Sony20:40000,RC5:36000,RC6:36000,JVC:38000,Panasonic:37000};
function irEncode(proto,addr,cmd,opt={}){
  addr|=0; cmd|=0;
  const freq=IR_FREQ[proto]; if(!freq) return null;
  let dur;
  switch(proto){
    case 'NEC':
      if(opt.repeat){ dur=[9000,2250,560]; break; }
      dur=irPdWrite([9000,4500],560,560,1690,[...irBitsOf(addr&255,8),...irBitsOf(~addr&255,8),...irBitsOf(cmd&255,8),...irBitsOf(~cmd&255,8)]); break;
    case 'NEC-ext':
      dur=irPdWrite([9000,4500],560,560,1690,[...irBitsOf(addr&255,8),...irBitsOf((addr>>8)&255,8),...irBitsOf(cmd&255,8),...irBitsOf(~cmd&255,8)]); break;
    case 'Samsung':
      dur=irPdWrite([4500,4500],560,560,1690,[...irBitsOf(addr&255,8),...irBitsOf(addr&255,8),...irBitsOf(cmd&255,8),...irBitsOf(~cmd&255,8)]); break;
    case 'JVC':
      dur=irPdWrite([8400,4200],526,526,1574,[...irBitsOf(addr&255,8),...irBitsOf(cmd&255,8)]); break;
    case 'Panasonic': {
      const B=[0x02,0x20,addr&255,(addr>>8)&255,cmd&255]; B.push(B[2]^B[3]^B[4]);
      dur=irPdWrite([3456,1728],432,432,1296,B.flatMap(v=>irBitsOf(v,8))); break; }
    case 'Sony12': case 'Sony15': case 'Sony20': {
      const nb=+proto.slice(4), b=[...irBitsOf(cmd&127,7),...irBitsOf(addr,nb-7)];
      dur=[2400,600]; b.forEach((x,i)=>{ dur.push(x?1200:600); if(i<nb-1) dur.push(600); }); break; }
    case 'RC5': {
      const b=[1,(cmd>>6)&1^1,opt.toggle?1:0,...irBitsOf(addr&31,5,true),...irBitsOf(cmd&63,6,true)];
      dur=irRuns([0,...b.flatMap(x=>x?[0,1]:[1,0]).slice(1)],889); break; }
    case 'RC6': {
      const tg=opt.toggle?1:0, b=[...irBitsOf(+opt.mode||0,3,true),null,...irBitsOf(addr&255,8,true),...irBitsOf(cmd&255,8,true)];
      const lv=[];
      for(const x of [1,...b]){
        if(x===null){ lv.push(...(tg?[1,1,0,0]:[0,0,1,1])); continue; }
        lv.push(...(x?[1,0]:[0,1]));
      }
      dur=[2666,889,...irRuns(lv,444)]; break; }
  }
  return {freq,dur};
}
const irNum=s=>{ const v=Number(s); return Number.isFinite(v) ? v : parseInt(s,16)||0; };
function irEncodeText(text){                                                              // «NEC 0x04 0x08», «Sony12 1 21», «RC5 5 12 t», «NEC rep»
  const t=String(text||'').trim().split(/[\s,]+/).filter(Boolean); if(!t.length) return null;
  let name=t[0].toLowerCase();
  if(name==='sirc' || name==='sony') name=(irNum(t[1])>255 ? 'sony20' : irNum(t[1])>31 ? 'sony15' : 'sony12');
  const key=IR_PROTOS.find(p=>p.toLowerCase()===name.replace(/^sirc/,'sony')); if(!key) return null;
  const rest=t.slice(1), flags=rest.filter(x=>/^[a-z]/i.test(x) && !/^0x/i.test(x));
  const nums=rest.filter(x=>!flags.includes(x)).map(irNum);
  return irEncode(key,nums[0]||0,nums[1]||0,{repeat:flags.some(f=>/^r(ep|pt)/i.test(f)),toggle:flags.includes('t')||nums[2]===1,mode:nums[2]});
}

/* ---------- неизвестный кадр ---------- */
function irClusters(a,tol=.25){                                                           // группы близких значений: [{c: центр, n: сколько}]
  const s=a.slice().sort((x,y)=>x-y), out=[];
  for(const v of s){ const g=out[out.length-1]; if(g && v<=g.hi*(1+tol)){ g.sum+=v; g.n++; g.hi=v; } else out.push({sum:v,n:1,hi:v}); }
  return out.map(g=>({c:Math.round(g.sum/g.n),n:g.n}));
}
function irAnalyze(d){
  const mk=d.filter((_,i)=>i%2===0), sp=d.filter((_,i)=>i%2===1);
  const o={marks:irClusters(mk), spaces:irClusters(sp), bits:null};
  // «расстояние между импульсами»: заголовок (если есть), метка, две паузы; длинные паузы режут кадр на части
  const body=d.slice(2), bm=body.filter((_,i)=>i%2===0), bs=body.filter((_,i)=>i%2===1);
  const hasHdr=d[0]>2*(irClusters(bm).sort((a,b)=>b.n-a.n)[0]?.c||1e9)*0.9 && d[0]>1500;
  const src=hasHdr ? {h:d.slice(0,2),b:body} : {h:[],b:d};
  const mm=irClusters(src.b.filter((_,i)=>i%2===0)).sort((a,b)=>b.n-a.n)[0];
  const ss=irClusters(src.b.filter((_,i)=>i%2===1)).filter(c=>c.n>=2).sort((a,b)=>a.c-b.c);
  if(mm && ss.length>=2){
    const s0=ss[0].c, s1=ss.find(c=>c.c>s0*1.5)?.c;
    if(s1){
      const bits=[], seg=[]; let cur=[];
      for(let i=0;i+1<src.b.length;i+=2){
        if(!IR_NEAR(src.b[i],mm.c,.5)){ cur=null; break; }
        const sp=src.b[i+1];
        if(IR_NEAR(sp,s1,.2)){ cur.push(1); bits.push(1); } else if(IR_NEAR(sp,s0,.2)){ cur.push(0); bits.push(0); }
        else { if(cur.length) seg.push(cur); cur=[]; }
      }
      if(cur){ if(cur.length) seg.push(cur);
        o.pd={header:src.h,mark:mm.c,zero:s0,one:s1,parts:seg.map(g=>({bits:g.length,hex:irHex(irBytes(g.concat(Array((8-g.length%8)%8).fill(0))))}))}; }
    }
  }
  return o;
}
function irAnalyzeText(d){
  const a=irAnalyze(d), f=c=>c.filter(x=>x.n>=1).map(x=>x.c+'×'+x.n).join(' ');
  let s=d.length+' pulses, '+Math.round(d.reduce((x,y)=>x+y,0)/1000)+' ms\nmarks '+f(a.marks)+'\nspaces '+f(a.spaces);
  if(a.pd) s+='\npulse-distance: '+(a.pd.header.length ? 'header '+a.pd.header.join('/')+', ' : '')+'mark '+a.pd.mark+', 0 = '+a.pd.zero+', 1 = '+a.pd.one+
    '\n'+a.pd.parts.map(p=>p.bits+' bits LSB first: '+p.hex).join('\n');
  return s;
}

if(typeof module!=='undefined') module.exports={irParse,irFormat,irDecode,irDescribe,irEncode,irEncodeText,irAnalyze,irAnalyzeText,IR_NEAR,IR_FORMATS,IR_PROTOS};
