"use strict";
/* ============================ HEX Field Finder: ядро ============================
   Набор пакетов (одной длины) → кандидаты в поля: что лежит по какому смещению. Без DOM, проверка: node tools/test-hexscan.mjs.
   Подход — статистика по столбцу значений (смещение × ширина × порядок байт × знак) и несколько проверок правдоподобия:
     time     — Unix-время (с / мс), все значения в 2001–2045; со временем приёма пакетов — разница почти постоянна
     coord    — значения в градусах (деление на 10^k, 60, 360, 3600…, двоичные доли 360/2^n) кучкуются в узком окне и меняются плавно
     float    — float32 / float64 в тех же рамках
     counter  — шаг +1 (+k) между соседними пакетами; const — одно значение; enum — мало различных значений
     length   — значение = размер пакета − константа; checksum — CRC / сумма хвоста по предыдущим байтам (список hexSum)
     text     — печатный ASCII;  bcd — только цифры в тетрадах;  random — биты уравновешены (шифр, хэш, сжатие)
   Случайные байты проходят проверку «в диапазоне» легко, поэтому для координат и времени опора — на кучность и плавность,
   а не на попадание в диапазон. Результат — таблица кандидатов с оценкой 0…1 и заготовка схемы для HEX Structure.
   Если почти все байты случайны и контрольной суммы нет, вывод: «похоже на шифрование» — искать в нём нечего. */

const HSC_T0=946684800, HSC_T1=2398291200;                      // Unix-время: 2000-01-01 … 2045-12-31
const HSC_DIV=[1,10,100,1e3,1e4,1e5,1e6,1e7,60,360,3600,36000,6e4,6e5,3.6e6,3.6e7];

const hscMed=a=>{ const s=a.slice().sort((x,y)=>x-y), n=s.length; return n&1 ? s[n>>1] : (s[n/2-1]+s[n/2])/2; };
const hscQ=(s,q)=>s[Math.min(s.length-1,Math.floor(q*(s.length-1)+.5))];
function hscRead(d,off,w,le){ let v=0; for(let i=0;i<w;i++) v=v*256+d[off+(le ? w-1-i : i)]; return v; }
function hscCol(rows,off,w,le,signed){
  const o=new Float64Array(rows.length), half=Math.pow(2,8*w-1), full=Math.pow(2,8*w);
  for(let i=0;i<rows.length;i++){ let v=hscRead(rows[i],off,w,le); if(signed && v>=half) v-=full; o[i]=v; }
  return o;
}
// столбец байтов: уравновешены ли все 8 бит и сколько различных значений ждали бы от случайных данных
function hscRandomByte(rows,off){
  const n=rows.length, ones=new Array(8).fill(0), seen=new Set();
  for(const r of rows){ const b=r[off]; seen.add(b); for(let k=0;k<8;k++) ones[k]+=(b>>k)&1; }
  let zmax=0; for(const c of ones) zmax=Math.max(zmax,Math.abs(c/n-.5)*2*Math.sqrt(n));
  const exp=256*(1-Math.pow(255/256,n));
  return {random:n>=16 && zmax<3.5 && seen.size>=.8*exp, distinct:seen.size, zmax};
}

function hscCandidate(group,off,w,kind,score,label,extra){ return Object.assign({group,off,w,kind,score:+Math.max(0,Math.min(1,score)).toFixed(3),label},extra||{}); }

// ряд значений в порядке приёма: доля шагов и плавность (медиана |Δ| относительно разброса)
function hscSteps(vals,mod){
  const n=vals.length; let inc=0, same=0; const steps=[];
  for(let i=1;i<n;i++){ let d=vals[i]-vals[i-1]; if(mod) d=((d%mod)+mod)%mod; steps.push(d); if(d===1) inc++; if(d===0) same++; }
  return {inc:inc/(n-1), same:same/(n-1), steps};
}

function hscGroup(rows,times,group,L,o){
  const n=rows.length, out=[];
  const rnd=new Array(L), distinct=new Array(L);
  for(let i=0;i<L;i++){ const r=hscRandomByte(rows,i); rnd[i]=r.random; distinct[i]=r.distinct; }
  const used=new Uint8Array(L);                                   // байты, объяснённые константой / текстом / суммой
  // --- константы и перечисления по байтам
  for(let i=0;i<L;i++) if(distinct[i]===1){
    out.push(hscCandidate(group,i,1,'const',.9,'constant 0x'+rows[0][i].toString(16).padStart(2,'0'),{value:rows[0][i]})); used[i]=1; }
  // --- текст
  for(let i=0;i<L;i++){
    let p=0; for(const r of rows) if(r[i]>=32 && r[i]<127) p++;
    if(distinct[i]>1 && p>=.95*n && n>=8){
      let j=i; while(j+1<L){ let q=0; for(const r of rows) if(r[j+1]>=32 && r[j+1]<127) q++; if(q>=.95*n && distinct[j+1]>1) j++; else break; }
      const w=j-i+1;
      out.push(hscCandidate(group,i,w,'text',Math.min(.95,.5+.1*w),'ASCII text',{example:String.fromCharCode(...rows[0].subarray(i,i+w))}));
      for(let k=i;k<=j;k++) used[k]=1;
      i=j;
    }
  }
  // --- числа разной ширины
  const order=times && times.length===n ? Array.from(rows.keys()).sort((a,b)=>times[a]-times[b]) : Array.from(rows.keys());
  for(const w of [1,2,3,4,6,8]) for(let off=0;off+w<=L;off++) for(const le of (w===1 ? [false] : [false,true])) for(const signed of (w<=4 ? [false,true] : [false])){
    if(signed && w===1) continue;
    const raw=hscCol(rows,off,w,le,signed);
    const col=Array.from(order,i=>raw[i]), ds=new Set(col).size;
    if(ds===1) continue;
    const med=hscMed(col), sorted=col.slice().sort((x,y)=>x-y);
    const base={w,le,signed};
    // счётчик
    if(w<=4 && n>=8 && !signed){
      const st=hscSteps(col,Math.pow(2,8*w));
      if(st.inc>=.9) out.push(hscCandidate(group,off,w,'counter',.55+.4*st.inc-.01*w,'counter (+1 per packet)',{...base,example:col[0]}));
      else if(ds>3 && st.same<.2){
        const k=hscMed(st.steps);
        if(k>1 && k<256 && st.steps.filter(x=>x===k).length>=.9*st.steps.length) out.push(hscCandidate(group,off,w,'counter',.5+.3*(st.steps.filter(x=>x===k).length/st.steps.length)-.01*w,'counter (+'+k+' per packet)',{...base,example:col[0]}));
      }
    }
    // время
    if(w===4 && !signed){
      let inr=0; for(const v of col) if(v>=HSC_T0 && v<=HSC_T1) inr++;
      if(inr>=.95*n && n>=8 && ds>=Math.min(8,n/4)){
        let score=.6+.15*Math.min(1,n/50), note='';
        if(times && times.length===n){
          const dif=order.map((idx,k)=>col[k]-times[idx]/1000), md=hscMed(dif), mad=hscMed(dif.map(x=>Math.abs(x-md)));
          if(mad<=2){ score=.97; note=' · '+(Math.abs(md)<2 ? 'equals capture time' : 'capture time '+(md>0 ? '+' : '')+md.toFixed(0)+' s'); }
        }
        out.push(hscCandidate(group,off,w,'time',score,'Unix time, s'+note,{...base,example:new Date(col[0]*1000).toISOString()}));
      }
    }
    if((w===6 || w===8) && !signed){
      let inr=0; for(const v of col) if(v>=HSC_T0*1000 && v<=HSC_T1*1000) inr++;
      if(inr>=.95*n && n>=8 && ds>=Math.min(8,n/4)) out.push(hscCandidate(group,off,w,'time',.75,'Unix time, ms',{...base,example:new Date(col[0]).toISOString(),scale:.001}));
    }
    // градусы
    if(w>=2 && w<=4 && n>=12 && ds>=Math.min(20,.15*n)){            // мало различных значений — идентификатор, не координата
      let best=null, bestBin=null;
      const scales=[];
      for(const d of HSC_DIV) scales.push([1/d,'÷'+d]);
      const full=Math.pow(2,8*w);
      scales.push([360/full,'×360/2^'+8*w],[180/full,'×180/2^'+8*w],[90/full,'×90/2^'+8*w]);
      if(signed){ scales.push([180/(full/2),'×180/2^'+(8*w-1)],[90/(full/2),'×90/2^'+(8*w-1)]); }
      for(const [sc,name] of scales){
        const deg=sorted.map(v=>v*sc), lo=hscQ(deg,.1), hi=hscQ(deg,.9), spread=hi-lo, m=hscQ(deg,.5);
        const amax=Math.max(Math.abs(deg[0]),Math.abs(deg[deg.length-1])), range=full*sc;        // весь диапазон поля в градусах
        if(amax>360.5 || range<90 || amax<.03*(signed ? range/2 : range) || spread>.1*range || spread>15 || Math.abs(m)<5 || ds<4) continue;  // кучность — относительно диапазона поля
        const kind=amax<=90 ? 'coord' : amax<=180 ? 'lon' : 'angle';
        // плавность во времени: пакеты одного трека не прыгают
        const dd=col.map(v=>v*sc); let sm=0; if(n>=20){ const st=[]; for(let i=1;i<n;i++) st.push(Math.abs(dd[i]-dd[i-1])); sm=hscMed(st)/Math.max(spread,1e-9); }
        let score=.4+.2*Math.min(1,n/60)+.1*Math.min(1,(.1*range-spread)/(.1*range));
        if(n>=20) score+=sm<.25 ? .1 : sm>.5 ? -.2 : 0;
        score+=.05*(w-2);                                     // окно шире — больше байт объяснено; соседние узкие окна того же поля слабее
        // двойки степеней и круглые ширины чаще у настоящих координат: штраф за целые счётчики, прижатые к нулю
        const cand=hscCandidate(group,off,w,kind,score,(kind==='coord' ? 'latitude / longitude' : kind==='lon' ? 'longitude' : 'angle 0–360')+' (degrees, '+name+')',{...base,scale:sc,median:+m.toFixed(5),spread:+spread.toFixed(3),smooth:n>=20 ? +sm.toFixed(2) : null,example:+(dd[0]).toFixed(6)});
        if(name[0]==='×'){ if(!bestBin || cand.score>bestBin.score) bestBin=cand; } else if(!best || cand.score>best.score) best=cand;
      }
      if(best) out.push(best);
      if(bestBin) out.push(bestBin);
    }
    // перечисление / идентификатор
    if(w<=3 && ds>=2 && ds<=Math.max(6,Math.min(24,n/4)) && n>=12 && Array.from({length:w},(_,k)=>distinct[off+k]>1).every(Boolean)) out.push(hscCandidate(group,off,w,'enum',.4+.2*(1-ds/24),'identifier / enum ('+ds+' values)',{...base,example:col[0]}));
  }
  // --- float
  for(const w of [4,8]) for(let off=0;off+w<=L;off++) for(const le of [false,true]){
    const col=new Array(n); let ok=0;
    for(let i=0;i<n;i++){ const dv=new DataView(rows[i].buffer,rows[i].byteOffset+off,w); col[i]=w===4 ? dv.getFloat32(0,le) : dv.getFloat64(0,le); if(isFinite(col[i]) && Math.abs(col[i])<=360 && Math.abs(col[i])>1e-3) ok++; }
    if(ok<.95*n || n<12) continue;
    const s=col.slice().sort((x,y)=>x-y), spread=hscQ(s,.9)-hscQ(s,.1), m=hscQ(s,.5);
    if(spread>15 || spread<1e-6 || Math.abs(m)<5) continue;
    out.push(hscCandidate(group,off,w,Math.abs(s[0])<=90 && Math.abs(s[n-1])<=90 ? 'coord' : 'angle',.6+.1*Math.min(1,n/60),'float'+8*w+' degrees',{w,le,float:true,median:+m.toFixed(5),spread:+spread.toFixed(3),example:col[0]}));
  }
  // --- контрольная сумма в конце
  const sums=Object.keys(typeof HEX_CRC!=='undefined' ? HEX_CRC : {}).concat(['inet16','xor8','sum8']);
  let crcFound=null;
  for(const w of [1,2,3,4]) if(L-w>=2) for(const le of (w===1 ? [false] : [false,true])){
    for(const name of sums){
      const sm=hexSum(name); if(!sm || sm.w!==8*w) continue;
      for(const from of [0]){
        let ok=0; for(const r of rows){ const v=sm.f(r,from,L-w), got=hscRead(r,L-w,w,le); if(v===got) ok++; }
        if(ok>=.95*n){ crcFound=hscCandidate(group,L-w,w,'checksum',.97,name+' over bytes '+from+'…'+(L-w-1),{le,sum:name,from}); break; }
      }
      if(crcFound) break;
    }
    if(crcFound) break;
  }
  if(crcFound){ out.push(crcFound); for(let k=crcFound.off;k<L;k++) used[k]=1; }
  // --- BCD
  for(let off=0;off+1<=L;off++){
    let ok=0; for(const r of rows) if((r[off]>>4)<=9 && (r[off]&15)<=9) ok++;
    if(ok===n && n>=16 && distinct[off]>1 && !rnd[off] && distinct[off]<=60) out.push(hscCandidate(group,off,1,'bcd',.4,'BCD digits',{example:rows[0][off].toString(16).padStart(2,'0')}));
  }
  // --- случайные участки
  let nonConst=0, rndCnt=0;
  for(let i=0;i<L;i++) if(distinct[i]>1){ nonConst++; if(rnd[i]) rndCnt++; }
  for(let i=0;i<L;i++) if(rnd[i] && !used[i]){
    let j=i; while(j+1<L && rnd[j+1] && !used[j+1]) j++;
    out.push(hscCandidate(group,i,j-i+1,'random',.5,'high entropy: encrypted, hash or compressed',{})); i=j;
  }
  return {candidates:out, nonConst, rndCnt, crc:crcFound};
}

/* packets: [{d:Uint8Array, t?:мс}] (или просто Uint8Array); opts: {minN, group:'length'|'all'} */
function hexScan(packets,opts){
  opts=opts||{};
  const minN=opts.minN||12, groups=new Map();
  for(const p of packets){
    const d=p instanceof Uint8Array ? p : p.d, t=p instanceof Uint8Array ? undefined : p.t;
    if(!d || !d.length) continue;
    const key=opts.group==='all' ? 'all' : String(d.length);
    if(!groups.has(key)) groups.set(key,{rows:[],times:[]});
    const g=groups.get(key); g.rows.push(d); g.times.push(t);
  }
  // пакеты одной длины бывают разных видов: частая раскладка нулевых байт (заполнение, пустые поля) выделяет вид в свою группу
  for(const [key,g] of Array.from(groups)){
    if(g.rows.length<2*minN || g.rows[0].length>128) continue;
    const sig=g.rows.map(r=>Array.from(r,b=>b ? '1' : '0').join('')), cnt=new Map();
    for(const x of sig) cnt.set(x,(cnt.get(x)||0)+1);
    const freq=Array.from(cnt).filter(([x,c])=>c>=Math.max(minN,.15*g.rows.length) && x.includes('0')).sort((a,b)=>b[1]-a[1]);
    if(freq.length<2 && !(freq.length===1 && freq[0][1]<.9*g.rows.length) || freq.reduce((a,[,c])=>a+c,0)<.15*g.rows.length) continue;
    const keep={rows:[],times:[]};
    groups.delete(key);
    for(const [x,c] of freq){ const ng={rows:[],times:[]}; sig.forEach((y,i)=>{ if(y===x){ ng.rows.push(g.rows[i]); ng.times.push(g.times[i]); } }); groups.set(key+' zeros '+x.replace(/1/g,'.').replace(/0/g,'0'),ng); }
    const used=new Set(freq.map(f=>f[0]));
    sig.forEach((y,i)=>{ if(!used.has(y)){ keep.rows.push(g.rows[i]); keep.times.push(g.times[i]); } });
    if(keep.rows.length) groups.set(key+' other',keep);
  }
  const res=[];
  for(const [key,g] of groups){
    if(g.rows.length<minN) continue;
    const L=opts.group==='all' ? Math.min(...g.rows.map(r=>r.length)) : g.rows[0].length;
    if(L>(opts.maxLen||512)) continue;
    const hasT=g.times.every(t=>typeof t==='number' && isFinite(t));
    const r=hscGroup(g.rows,hasT ? g.times : null,key,L,opts);
    r.candidates.sort((a,b)=>(b.score-a.score) || (b.w-a.w));
    const share=r.nonConst ? r.rndCnt/r.nonConst : 0;
    const strong=r.candidates.filter(c=>c.score>=.6 && !['random','const'].includes(c.kind));
    res.push({group:key,n:g.rows.length,len:L,candidates:r.candidates,randomShare:+share.toFixed(2),
      verdict:r.nonConst===0 ? 'identical packets' : share>=.8 && !r.crc && !strong.length ? 'looks random: encrypted, compressed or noise' : strong.length ? 'structure found' : 'no confident structure'});
  }
  res.sort((a,b)=>b.n-a.n);
  return res;
}

// кандидаты → заготовка схемы HEX Structure (без пересечений: лучшие по оценке, остальное — байты)
function hexScanPick(group,minScore){
  minScore=minScore==null ? .6 : minScore;
  const take=[], busy=new Uint8Array(group.len);
  for(const c of group.candidates){
    if(c.score<minScore || c.kind==='random') continue;
    let clash=false; for(let k=c.off;k<c.off+c.w;k++) if(busy[k]) clash=true;
    if(clash) continue;
    for(let k=c.off;k<c.off+c.w;k++) busy[k]=1;
    take.push(c);
  }
  return take.sort((a,b)=>a.off-b.off);
}
function hexScanSchema(group,minScore){
  const L=group.len, take=hexScanPick(group,minScore);
  const fields=[], push=f=>fields.push(f);
  const gap=(a,b)=>{ if(b>a) push({n:'f'+a,t:'bytes',len:b-a}); };
  let pos=0;
  const names={coord:0,lon:0,angle:0,time:0,counter:0,enum:0,text:0,const:0,checksum:0,bcd:0};
  for(const c of take){
    gap(pos,c.off);
    const nm=c.kind+(names[c.kind]++ ? names[c.kind] : '');
    const endian=c.le ? 'le' : undefined, ty=(c.signed ? 'i' : 'u')+8*c.w;
    if(c.kind==='const'){ push({n:'c'+c.off,t:'u8',fmt:'hex'}); }
    else if(c.kind==='text'){ push({n:nm,t:'str',len:c.w}); }
    else if(c.kind==='checksum'){ push(Object.assign({n:'crc',t:'u'+8*c.w,fmt:'hex',calc:c.sum,to:'crc'},endian ? {endian} : {})); }
    else if(c.float){ push(Object.assign({n:nm,t:'f'+8*c.w},endian ? {endian} : {})); }
    else if(c.kind==='time' && c.w===4) push(Object.assign({n:nm,t:'u32',fmt:'time'},endian ? {endian} : {}));
    else if(c.kind==='time') push(Object.assign({n:nm,t:'u'+8*c.w,scale:c.scale,unit:'s',prec:3},endian ? {endian} : {}));
    else if(c.kind==='coord' || c.kind==='lon' || c.kind==='angle') push(Object.assign({n:nm,t:ty,scale:c.scale,unit:'°',prec:5},endian ? {endian} : {}));
    else push(Object.assign({n:nm,t:ty},endian ? {endian} : {}));
    pos=c.off+c.w;
  }
  gap(pos,L);
  return {name:'scan-'+group.group, fields};
}
