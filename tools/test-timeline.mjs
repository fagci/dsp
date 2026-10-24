// Timeline: события, фильтр, дорожки, периоды, задержки (modules/timeline-kernels.js)
import fs from 'fs'; import path from 'path'; import vm from 'vm';
const root=new URL('../',import.meta.url).pathname;
const ctx={}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root,'modules/timeline-kernels.js'),'utf8')+
  ';this.k={tlEvents,tlFilter,tlLanes,tlMerge,tlStats,tlLag,tlLinks,tlCrossed,tlActive,tlFmt,tlStep,tlDur,tlKeyCol,tlRk,tlEd0,tlEdSize,tlEdParse,tlEdClone,tlApply,tlReconcile,tlRaw,tlPatch,tlSnap,tlMarksParse,tlMarksStr,tlFxParse,tlFxLane,tlFxRun,tlMixClip,tlMono,tlIqSpan,tlGate,tlCsv};',ctx);
const {tlEvents,tlFilter,tlLanes,tlMerge,tlStats,tlLag,tlLinks,tlCrossed,tlActive,tlFmt,tlStep,tlDur,tlKeyCol,tlRk,tlEd0,tlEdSize,tlEdParse,tlEdClone,tlApply,tlReconcile,tlRaw,tlPatch,tlSnap,tlMarksParse,tlMarksStr,tlFxParse,tlFxLane,tlFxRun,tlMixClip,tlMono,tlIqSpan,tlGate,tlCsv}=ctx.k; let bad=0;
const ok=(n,c)=>{ console.log((c?'ok   ':'FAIL ')+n); if(!c) bad++; };
const near=(a,b,e=1e-9)=>a!=null && Math.abs(a-b)<=e;

// маяк раз в 100 мс по 5 мс, один пропущен (t в мс от эпохи)
const T0=1.7e12, rows=[];
for(let i=0;i<20;i++){ if(i===7) continue; rows.push({t:T0+i*100+(i%2?1:-1),dur:5,freq:433.92,src:'A',kind:'beacon',rssi:-60-i}); }
for(let i=0;i<3;i++) rows.push({t:T0+50+i*400,dur:12,freq:868.1,src:'B',kind:'req',rssi:-80});
for(let i=0;i<3;i++) rows.push({t:T0+50+i*400+30,dur:8,freq:868.1,src:'B',kind:'ack',rssi:-82});

let m=tlEvents(rows,{});
ok('auto: columns, unit ms (epoch), seconds inside',m.ok && m.cols.t==='t' && m.cols.dur==='dur' && m.cols.rssi==='rssi' && m.unit==='ms' && near(m.ev[0].t1-m.ev[0].t0,.005));
ok('events sorted by start',m.ev.every((e,i)=>!i || m.ev[i-1].t0<=e.t0));
ok('unit by hand',near(tlEvents([{t:2,dur:500}],{unit:'ms'}).ev[0].t1,.5));
ok('origin = first start, absolute time recoverable',near(m.origin,(T0-1)/1000,1e-6) && near(m.ev[0].t0,0));
const e2=tlEvents([{time:1.5,end:2.25}],{}); ok('end column → duration, seconds as is',e2.unit==='s' && near(e2.ev[0].t1-e2.ev[0].t0,.75));
ok('errors are texts',tlEvents([],{}).err==='no rows' && tlEvents([{a:1}],{}).err.includes('time') && tlEvents([{t:'x'}],{}).err.length>0);

let lanes=tlLanes(m.ev,'src');
ok('lanes by column',lanes.length===2 && lanes[0].name==='A' && lanes[0].ev.length===19);
ok('lanes by several columns',tlLanes(m.ev,'src,kind').map(l=>l.name).join('|')==='A · beacon|B · req|B · ack');
ok('no column → one lane',tlLanes(m.ev,'').length===1);

const A=lanes[0].ev, s=tlStats(A,{rssi:'rssi'});
ok('period = median start-to-start (100 ms)',near(s.period,.1,2.5e-3) && s.n===19);
ok('duration, duty',near(s.dur,.005,1e-9) && near(s.duty,19*.005/(s.t1-s.t0),1e-9));
ok('missed repeat is counted, still periodic',s.miss===1 && s.ok>=.9);
ok('jitter small (±1 ms of 100)',s.jitter>0 && s.jitter<.03);
ok('rssi stats',near(s.rssi_max,-60) && near(s.rssi_min,-79));
const r=tlStats(rows.slice(0,0).concat([{t:0,dur:1},{t:1,dur:1},{t:2.7,dur:1},{t:7,dur:1}].map((x,i)=>tlEvents([x],{unit:'s'}).ev[0])),{});
ok('irregular intervals: low ok-score',r.ok<.5);
ok('single event: no period',tlStats(A.slice(0,1),{}).period===null);

const f=tlFilter('kind=req,ack src=B'); const sel=m.ev.filter(f);
ok('filter: = with alternatives, two terms',sel.length===6);
ok('filter: numbers',m.ev.filter(tlFilter('rssi<-80')).length===m.ev.filter(e=>e.row.rssi<-80).length && m.ev.filter(tlFilter('freq=868.1')).length===6);
ok('filter: bare word, !=, ~, wildcard',m.ev.filter(tlFilter('beac')).length===19 && m.ev.filter(tlFilter('src!=A')).length===6 && m.ev.filter(tlFilter('kind~^a')).length===3 && m.ev.filter(tlFilter('kind=b*')).length===19);
ok('empty filter → null',tlFilter('')===null && tlFilter('  ')===null);

const req=tlLanes(m.ev,'kind').find(l=>l.name==='req').ev, ack=tlLanes(m.ev,'kind').find(l=>l.name==='ack').ev;
const lag=tlLag(req,ack,.2);
ok('lag request → ack = 30 ms',lag.n===3 && near(lag.med,.03,1e-6));
ok('lag beyond max is dropped',tlLag(req,ack,.01).n===0);

const mg=tlMerge(A,.02);
ok('merge: gap smaller than period keeps events apart',mg.length===19);
const burst=tlMerge([0,.003,.006,.5,.503].map((t,i)=>({i,t0:t,t1:t+.002,row:{}})),.005);
ok('merge: packets of one transmission → burst',burst.length===2 && burst[0].n===3 && near(burst[0].t1,.008) && burst[1].n===2);

const links=tlLinks(m.ev,'src');
ok('links by key across lanes',links.length===2 && links.find(l=>l.key==='B').n===6);
ok('link with empty key skipped',tlLinks([{t0:0,t1:0,row:{src:''}}],'src').length===0);

const evs=A, t=evs[3].t0;
ok('crossed: (a,b]',tlCrossed(evs,evs[2].t0,evs[4].t0).length===2 && tlCrossed(evs,t,t).length===0);
ok('active at t',tlActive(evs,t+.002).length===1 && tlActive(evs,t+.05).length===0);

ok('formats',tlFmt(1.5,.1)==='1.5s' && tlFmt(.0125,.001)==='12.5ms' && tlFmt(125,1)==='2m05s' && tlStep(10,5)===2 && tlDur(.0123)==='12.3 ms' && tlDur(null)==='—');

/* ---------- правка ---------- */
const src=[{id:'a',t:100,dur:2,lane:'X'},{id:'b',t:105,dur:1,lane:'X'},{id:'c',t:110,dur:3,lane:'Y'}];
const kc=tlKeyCol(src,''); ok('key column found (id)',kc==='id' && tlKeyCol([{a:1}],'')===null && tlKeyCol(src,'lane')==='lane');
const mm=tlEvents(src,{});
let ed=tlEd0();
ed.p[tlRk(src[1],1,kc)]=tlPatch(mm,mm.ev[1].t0+1.5,mm.ev[1].t1+1.5,false);
ed.d['k:c']=1; ed.a.push({id:'n1',t:120,dur:1,lane:'Y'});
let ap=tlApply(src,ed,kc);
ok('apply: patch, delete, add (keys parallel)',ap.rows.length===3 && ap.rows[1].t===106.5 && ap.rows[1].dur===1 && ap.keys.join()==='k:a,k:b,n:0' && ap.rows[0]===src[0] && src[1].t===105);
ok('patch writes seconds back in column units',tlPatch(tlEvents([{t:5000,dur:200}],{unit:'ms'}),1.5,1.7,false).t===5000+1500 && tlPatch(tlEvents([{t:5000,dur:200}],{unit:'ms'}),1.5,1.7,false).dur===200);
ok('patch: end column and point event',tlPatch(tlEvents([{t:1,end:3}],{}),0,3,false).end===4 && tlPatch(tlEvents([{t:1},{t:2}],{}),0,2,true).dur===2 && !('dur' in tlPatch(tlEvents([{t:1},{t:2}],{}),0,2,false)));
ok('raw time of an epoch ms table keeps precision',tlRaw(tlEvents([{t:1.7e12,dur:5},{t:1.7e12+100,dur:5}],{}),.1)===1.7e12+100);
const ed2=tlEdClone(ed); ok('reconcile: only the already-equal field is dropped (duration), the moved start stays',tlReconcile(src,ed2,kc) && tlEdSize(ed2)===3 && !('dur' in ed2.p['k:b']) && ed2.p['k:b'].t===106.5);
const srcB=[{id:'a',t:100,dur:2,lane:'X'},{id:'b',t:106.5,dur:1,lane:'X'},{id:'n1',t:120,dur:1,lane:'Y'}];   // Table accepted edited
ok('reconcile: accepted edits are dropped',tlReconcile(srcB,ed2,kc) && tlEdSize(ed2)===0);
ok('without a key column rows are keyed by index',tlRk({x:1},4,null)==='#4' && tlApply([{t:1},{t:2}],{p:{'#1':{t:9}},d:{},a:[]},null).rows[1].t===9);
ok('edits survive JSON',tlEdSize(tlEdParse(JSON.stringify(ed)))===3 && tlEdSize(tlEdParse('garbage'))===0);

ok('snap to the nearest candidate within tolerance',tlSnap(1.04,[0,1,2],.05)===1 && tlSnap(1.2,[0,1,2],.05)===1.2 && tlSnap(1.96,[0,1,2],.05)===2 && tlSnap(5,[],.1)===5);
const mk=tlMarksParse('[{"t":2,"label":"b"},{"t":1,"label":"a"},{"t":"x"}]'); ok('marks: sorted, junk dropped, round trip',mk.length===2 && mk[0].label==='a' && tlMarksParse(tlMarksStr(mk)).length===2 && tlMarksParse('oops').length===0);

/* ---------- эффекты дорожек ---------- */
const fxr=tlFxParse('A*: gain=-6 lp=3000\n# comment\nB: solo hp=200 echo=250,.4\nC: mute'), fm=tlFxLane(fxr,['A1','B','C']);
ok('fx: masks, gain in dB',fm.get('A1').lp===3000 && near(fm.get('A1').lin,Math.pow(10,-.3),1e-9) && fm.get('B').echo.ms===250 && fm.get('B').echo.fb===.4);
ok('fx: solo silences the others, mute silences',fm.get('B').silent===false && fm.get('A1').silent===true && fm.get('C').silent===true);
ok('fx: mute without solo',tlFxLane(tlFxParse('X: mute'),['X','Y']).get('X').silent===true && tlFxLane(tlFxParse('X: mute'),['X','Y']).get('Y').silent===false);
{ const sr=48000, x=new Float32Array(4800), y=new Float32Array(4800);
  for(let i=0;i<x.length;i++){ x[i]=Math.sin(2*Math.PI*200*i/sr); y[i]=Math.sin(2*Math.PI*8000*i/sr); }
  const rms=a=>Math.sqrt(a.slice(2400).reduce((s,v)=>s+v*v,0)/2400);
  const lp=Float32Array.from(y); tlFxRun({lp:1000},{},lp,sr); const hp=Float32Array.from(x); tlFxRun({hp:2000},{},hp,sr);
  ok('fx: low-pass cuts 8 kHz, high-pass cuts 200 Hz',rms(lp)<.05 && rms(hp)<.05 && rms(x)>.6);
  const g=Float32Array.from(x); tlFxRun({lin:.5},{},g,sr); ok('fx: gain',near(g[100],x[100]*.5,1e-6));
  const e=new Float32Array(2000); e[0]=1; const st={}; tlFxRun({echo:{ms:10,fb:.5}},st,e,sr);
  ok('fx: echo repeats after the delay with feedback',near(e[480],1,1e-6) && near(e[960],.5,1e-6) && e[100]===0); }

/* ---------- микс ---------- */
{ const sr=1000, buf=new Float32Array(2000).fill(.5), dst=new Float32Array(100);
  tlMixClip(dst,{buf,sr,t0:1,t1:1.05,off:0,lin:2},1,1.1);
  ok('mix: clip occupies its own span, gain applied',near(dst[10],1,1e-9) && dst[60]===0 && dst[49]===1);
  const d2=new Float32Array(100); tlMixClip(d2,{buf,sr,t0:0,t1:1,off:0,lin:1,fi:.5,fo:0},0,1);
  ok('mix: fade-in ramps',d2[0]===0 && near(d2[25],.25,1e-9) && near(d2[60],.5,1e-9));
  const ramp=Float32Array.from({length:100},(_,i)=>i), d3=new Float32Array(10); tlMixClip(d3,{buf:ramp,sr:100,t0:0,t1:1,off:.1,lin:1},0,.1);
  ok('mix: file offset and linear interpolation',near(d3[0],10,1e-9) && near(d3[5],15,1e-9));
  const d4=new Float32Array(10); tlMixClip(d4,{buf:ramp,sr:100,t0:0,t1:1,off:0,lin:1},0,.2); ok('mix: speed ×2 reads twice as fast',near(d4[5],10,1e-9));
  ok('mono mix averages channels',near(tlMono([Float32Array.of(1,1),Float32Array.of(0,-1)])[1],0)); }

/* ---------- IQ ---------- */
ok('iq span: consecutive blocks join without gaps',(()=>{ const a=tlIqSpan(0,.1,0,0,1000,5000), b=tlIqSpan(.1,.2,0,0,1000,5000); return a[1]===b[0] && a[0]===0 && b[1]===200; })());
ok('iq span: offset, clipping to the file, outside',tlIqSpan(0,.1,0,1,1000,5000)[0]===1000 && tlIqSpan(0,.1,0,4.95,1000,5000)[1]===5000 && tlIqSpan(-1,-.5,0,0,1000,5000)===null && tlIqSpan(0,.1,0,9,1000,5000)===null);

/* ---------- сигнал → события ---------- */
{ const st={}, x=new Float32Array(100); x.fill(1,10,30); x.fill(1,90,100);
  const a=tlGate(st,x,.5,.1), b=tlGate(st,new Float32Array(100),.5,.1);
  ok('gate: finished pulses with start and length, one stays open between blocks',a.length===1 && a[0].i0===10 && a[0].n===20 && b.length===1 && b[0].i0===90 && b[0].n===10 && st.pos===200); }

ok('csv quoting',tlCsv([{a:1,b:'x,y'},{a:2,c:'q"r'}])==='a,b,c\n1,"x,y",\n2,,"q""r"\n');
if(bad){ console.log(bad+' failed'); process.exit(1); } console.log('all ok');
