// modules/airdiary-kernels.js: занятость «час × частота», всплески, маяки, несущие, суточные повторы, хранение (без DOM)
import fs from 'fs';
import vm from 'vm';
const g={module:{exports:{}},Date,Math,Map,Set,Float32Array,Float64Array,Int32Array,Uint8Array,JSON,Object,Array,Number,String,isFinite,Infinity,NaN}; vm.createContext(g);
vm.runInContext(fs.readFileSync(new URL('../modules/airdiary-kernels.js',import.meta.url),'utf8'),g);
const K=g.module.exports; let bad=0;
const ok=(n,c)=>{ console.log((c?'ok   ':'FAIL ')+n); if(!c) bad++; };

const N=400, F0=100e6, BIN=10e3;                       // 4 МГц, бин = ячейка 10 кГц
const hz=i=>F0+i*BIN;
const O={res:BIN,slotMin:60,thr:10,confirm:2,hold:400,gap:1,contMs:10000,minBursts:6,regular:.7,tol:.1,minDays:3,maxTracks:400};
const frame=(st,now,on,db=-60)=>{                       // on — номера бинов с сигналом
  const lv=new Float32Array(N).fill(-90); for(const b of on) lv[b]=db;
  return K.adFrame(st,N,hz,i=>lv[i],{...O,now});
};

// ---- маяк: 200 мс каждые 5 с, кадры по 50 мс, 3 минуты ----
{
  const st=K.adNew(), t0=new Date(2026,10,12,9,0,0).getTime(); const recs=[];
  for(let k=0;k<3600;k++){ const t=t0+k*50, ph=(t-t0)%5000; const r=frame(st,t,ph<200?[100]:[]); recs.push(...r.recs); }
  const bc=recs.filter(r=>r.kind==='beacon');
  ok('маяк найден: одна запись new', bc.length>=1 && bc[0].status==='new' && bc[0].src==='AIRDIARY' && recs.every(r=>r.kind!=='continuous'));
  ok('маяк: период ≈ 5 с, регулярность ≥ 90 %, скважность < 10 %', Math.abs(bc[0].period-5)<.1 && bc[0].regular>=90 && bc[0].duty<10);
  ok('маяк: частота и номер', Math.abs(bc[0].freq-hz(100))<=BIN && bc[0].id===String(Math.round(hz(100)/BIN)*BIN));
  ok('маяк: одна дорожка, всплесков ≥ 30', st.tracks.length===1 && st.tracks[0].bursts.length>=30);
  const upd=recs.filter(r=>r.kind==='beacon' && r.status==='update').length;
  ok('обновления редки (удвоение числа всплесков), а не каждый всплеск', upd<=5);
  const bs=st.bursts; ok('всплески для Timeline: t, dur, freq', bs.length>=30 && bs[0].dur>=100 && bs[0].dur<=400 && Math.abs(bs[0].freq-hz(100))<=BIN);
  const tr=K.adTrackRows(st); ok('таблица передатчиков: kind beacon, период 5', tr.length===1 && tr[0].kind==='beacon' && Math.abs(tr[0].period-5)<.1);
}
// ---- несущая ----
{
  const st=K.adNew(), t0=1e12; const recs=[];
  for(let k=0;k<400;k++) recs.push(...frame(st,t0+k*50,[250]).recs);       // 20 с сплошь
  const c=recs.filter(r=>r.kind==='continuous');
  ok('сплошная несущая: одна запись continuous после contMs', c.length===1 && c[0].duty===100);
  ok('несущая — не маяк', recs.every(r=>r.kind!=='beacon'));
}
// ---- случайные вспышки не считаются периодическими ----
{
  const st=K.adNew(), t0=1e12; let s=12345; const rnd=()=>{ s=(s*1103515245+12345)&0x7fffffff; return s/0x7fffffff; };
  let on=0, recs=[];
  for(let k=0;k<6000;k++){ const t=t0+k*50; if(on<=0 && rnd()<.01) on=2+Math.floor(rnd()*8); recs.push(...frame(st,t,on>0?[60]:[]).recs); on--; }
  ok('случайные всплески — не маяк и не periodic', recs.every(r=>r.kind!=='beacon' && r.kind!=='periodic') && st.tracks[0].bursts.length>10);
}
// ---- «каждый день в 9 часов» ----
const daily=()=>{
  const st=K.adNew(), recs=[];
  for(let d=0; d<5; d++){
    const t=new Date(2026,10,8+d,9,0,0).getTime();
    for(let k=0;k<40;k++) recs.push(...frame(st,t+k*100,[300]).recs);        // 4 с сигнала
    recs.push(...frame(st,t+8000,[]).recs);                                    // тишина — всплеск закрыт
    recs.push(...frame(st,new Date(2026,10,8+d,15,0,0).getTime(),[]).recs);   // кадр «днём» — слот без сигнала
  }
  return {st,recs};
};
{
  const {st,recs}=daily(); const d=recs.filter(r=>r.kind==='daily');
  ok('суточный повтор: ровно одна запись, час 9, дней ≥ 3', d.length===1 && d[0].hour===9 && d[0].days>=3);
  ok('до третьего дня не объявлялся', d[0].t>=new Date(2026,10,10,9,0,0).getTime());
  const h=K.adHeat(st,{mode:'hour',days:30,now:new Date(2026,10,12,16,0,0).getTime(),cols:600});
  const col=Math.round((hz(300)-h.f0)/(h.step*h.res));
  ok('карта: 24 строки по часам', h.rows.length===24 && h.rows[9].label==='09:00' && h.rows[0].label==='00:00');
  ok('карта: занято в 9:00 на частоте сигнала и пусто в 10:00', h.rows[9].occ[col]>.8 && h.rows[10].occ[col]===0);
  ok('карта: в 15:00 кадры были, а сигнала нет — ноль', h.rows[15].frames>0 && h.rows[15].occ[col]===0);
  ok('карта: уровень в ячейке = −60 дБ', Math.abs(h.rows[9].db[col]+60)<.01);
  const hd=K.adHeat(st,{mode:'day',days:30,now:new Date(2026,10,12,16,0,0).getTime()});
  ok('карта по дням: 5 строк с датами', hd.rows.length===5 && hd.rows[0].label==='2026-11-08' && hd.rows[4].label==='2026-11-12');
  const rows=K.adHeatRows(h,.05); ok('строки для Table: when, freq, occ', rows.length>=1 && rows.every(r=>/^\d\d:00$/.test(r.when)) && rows.some(r=>r.when==='09:00' && Math.abs(r.freq-hz(300))<=BIN && r.occ>80));
  // сохранение и загрузка
  const sv=JSON.parse(JSON.stringify(K.adSave(st))), st2=K.adNew(); ok('загрузка', K.adLoad(st2,sv) && st2.slots.size===st.slots.size && st2.tracks.length===st.tracks.length);
  const h2=K.adHeat(st2,{mode:'hour',days:30,now:new Date(2026,10,12,16,0,0).getTime(),cols:600});
  ok('карта после загрузки та же', JSON.stringify([...h2.rows[9].occ.slice(col-2,col+3)])===JSON.stringify([...h.rows[9].occ.slice(col-2,col+3)]));
  ok('суточный вид помнится после загрузки (не объявится второй раз)', (()=>{ const r=[]; r.push(...K.adTrackRows(st2).map(x=>x.hour)); return r[0]===9; })());
  ok('мусор не загружается', !K.adLoad(K.adNew(),null) && !K.adLoad(K.adNew(),{v:2}));
}
// ---- смена диапазона SDR не размывает занятость ----
{
  const st=K.adNew(), t0=new Date(2026,10,12,10,0,0).getTime();
  for(let k=0;k<20;k++) frame(st,t0+k*100,[100]);                              // 20 кадров, сигнал на бине 100
  const lv=new Float32Array(N).fill(-90);
  for(let k=0;k<20;k++) K.adFrame(st,N,i=>F0+10e6+i*BIN,i=>lv[i],{...O,now:t0+3000+k*100});   // 20 кадров на другом участке (+10 МГц)
  const h=K.adHeat(st,{mode:'hour',days:7,now:t0+9000,cols:2000}), col=Math.round((hz(100)-h.f0)/(h.step*h.res));
  ok('другой участок не разбавляет долю: 100 % на своём', Math.abs(h.rows[10].occ[col]-1)<1e-6);
  const far=Math.round((F0+10e6+100*BIN-h.f0)/(h.step*h.res)); ok('на другом участке — ноль', h.rows[10].occ[far]===0);
}
// ---- забывание и смена сетки ----
{
  const st=K.adNew(), now=new Date(2026,10,20,12,0,0).getTime();
  frame(st,now-10*86400000,[100]); frame(st,now,[100]);
  ok('два слота', st.slots.size===2); K.adPrune(st,now,7); ok('старше days — забыты', st.slots.size===1);
  frame(st,now+1000,[100]); st.res=O.res*2; const r=K.adFrame(st,N,hz,i=>-90,{...O,now:now+2000}); ok('смена ширины ячейки — история в другой мере сброшена', st.res===O.res && st.slots.size===1);
}
// ---- пустые и странные кадры ----
{
  const st=K.adNew(); ok('N<2 и res=0 не падают', K.adFrame(st,1,hz,()=>-90,{...O,now:1}).active.length===0 && K.adFrame(st,N,hz,()=>-90,{...O,res:0,now:1}).recs.length===0);
  ok('NaN в уровнях пропускаются', K.adFrame(st,N,hz,i=>i%2?NaN:-90,{...O,now:2}).occ===0);
  ok('карта пустого дневника — null', K.adHeat(K.adNew(),{mode:'hour',now:1})===null);
}
console.log(bad?'FAILED':'all ok'); process.exit(bad?1:0);
