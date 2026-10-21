// Timeline: события, фильтр, дорожки, периоды, задержки (modules/timeline-kernels.js)
import fs from 'fs'; import path from 'path'; import vm from 'vm';
const root=new URL('../',import.meta.url).pathname;
const ctx={}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root,'modules/timeline-kernels.js'),'utf8')+
  ';this.k={tlEvents,tlFilter,tlLanes,tlMerge,tlStats,tlLag,tlLinks,tlCrossed,tlActive,tlFmt,tlStep,tlDur};',ctx);
const {tlEvents,tlFilter,tlLanes,tlMerge,tlStats,tlLag,tlLinks,tlCrossed,tlActive,tlFmt,tlStep,tlDur}=ctx.k; let bad=0;
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
if(bad){ console.log(bad+' failed'); process.exit(1); } console.log('all ok');
