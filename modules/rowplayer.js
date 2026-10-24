"use strict";
/* ============================ ROW PLAYER ============================ */
// Проигрывание строк списка по одной: по триггеру, таймеру, паузе из колонки, меткам времени или
// пройденному пути (ход — seqProcess из modules/sequencer.js). Хранение и правка списка — узел Table.
// Строки приходят проводом rows (Table, поиск, любой набор записей) либо ссылкой на список в
// хранилище (вход list от Table или параметр list): так набор не копируется по проводу, а плеер
// видит правки списка сам.

const RP_READ_MS=1000;                                 // чтение списка из хранилища после правок — не чаще
const RP_FIXED=new Set([...SEQ_FIXED,'rows','list','mid','span']);

// колонки набора записей: объединение ключей в порядке появления
function rpKeys(rows){
  const keys=[], seen=new Set();
  for(let i=0;i<rows.length && i<500;i++) for(const k in rows[i]) if(!seen.has(k)){ seen.add(k); keys.push(k); }
  return keys;
}
function rpPorts(n){
  const used=new Set(RP_FIXED);
  n.cols=n.headers.map(h=>{ let port=h; while(used.has(port)) port+='_'; used.add(port); return {h,port}; });
}
// метки времени и координаты — по текущим строкам и параметрам
function rpDerive(n){
  const p=n.p;
  n._dk=[p.tcol,p.latCol,p.lonCol].join('|');
  n.timeCol=seqFind(n.headers,p.tcol,SEQ_TIME_COLS);
  n.latCol=seqFind(n.headers,p.latCol,SEQ_LAT_COLS);
  n.lonCol=seqFind(n.headers,p.lonCol,SEQ_LON_COLS);
  n.tt=null;
  if(n.timeCol){ let prev=0; n.tt=n.rows.map(r=>{ const v=seqTime(r[n.timeCol]); if(v!=null) prev=v; return prev; }); }
  n.geo=!!(n.latCol && n.lonCol);
}
// порты полей изменились вместе со списком: провода к исчезнувшим уходят (как в Table)
function rpRebuild(n){
  if(!n.el || n.disposed || Graph.map[n.id]!==n) return;
  const vo=new Set(portsOf(n,'outs').map(q=>q.n));
  Graph.edges.filter(e=>e.from===n.id && !vo.has(e.fp)).forEach(delEdge);
  rebuildNode(n); markTopoDirty();
}
// новый набор строк; позиция сохраняется, пока она в пределах набора (список дописывают на ходу)
function rpApply(n,rows,cols){
  const was=n.rows.length;
  n.rows=rows; n.headers=cols.slice();
  rpPorts(n); rpDerive(n);
  if(cols.length && !tblSame(cols,n.p.cols)){ n.p.cols=cols.slice(); rpRebuild(n); }
  if(!was || n.idx>=rows.length) seqReset(n);
}
function rpSource(n,I){
  const wire=Array.isArray(I.rows) ? I.rows : null;
  if(wire){
    n.readTok++;                                       // чтение по ссылке, начатое раньше, не нужно
    if(n.src!==wire){ n.src=wire; n.listName=''; n.err=''; rpApply(n,wire,rpKeys(wire)); }
    return;
  }
  if(n.src){ n.src=null; n.listName=''; rpApply(n,[],n.headers); }
  const name=tblCanon(String(typeof I.list==='string' && I.list ? I.list : n.p.list||'').trim());
  if(!name){ if(n.listName){ n.listName=''; rpApply(n,[],n.headers); } n.err=''; return; }
  if(tblKind(name)==='patch'){ n.err='a list inside a patch is not in storage: wire its rows'; return; }
  const now=performance.now();
  if(name===n.listName && (n.listRev===ListDB.rev || now-n.listAt<RP_READ_MS)) return;
  const fresh=name!==n.listName, tok=++n.readTok;
  n.listName=name; n.listRev=ListDB.rev; n.listAt=now;
  tblReadList(n,name).then(t=>{
    if(tok!==n.readTok || n.disposed) return;
    n.err='';
    rpApply(n,t.rows,t.cols);
    if(fresh) seqReset(n);                             // другой список — с начала
  }).catch(e=>{ if(tok===n.readTok) n.err='storage: '+(e.message||e); });
}

const rpOuts=n=>{
  const o=[{n:'rec',t:'rec'},{n:'text',t:'txt'},{n:'row',t:'num'},{n:'count',t:'num'},{n:'next',t:'num'},
    {n:'done',t:'num'},{n:'dist',t:'num'},{n:'bearing',t:'num'},{n:'progress',t:'num'}];
  if(tblCol(n.headers||[],TBL_LO)) o.push({n:'mid',t:'num'},{n:'span',t:'num'});
  return o.concat((n.cols||[]).map(c=>({n:c.port,t:'val'})));
};
const rpIf=(...a)=>n=>a.includes(n.p.advance);

def({ id:'rowplayer', title:'Row Player', cat:'Sources', kw:'table list rows playback sequencer replay track gps trigger dwell time distance csv',
  ins:[{n:'rows',t:'bands'},{n:'list',t:'txt'},{n:'trig',t:'val'},{n:'row',t:'val'},{n:'t',t:'num'}],
  outs:rpOuts,
  readout:true, tall:true, w:260,
  params:[
    {n:'list',t:'text',d:'',label:'list (storage)',tip:'name of a list in the browser DB or a built-in one (presets/…), e.g. «radio/airband»; the rows are read from storage and follow its edits. The wire on rows overrides it; the list input overrides this field'},
    {n:'advance',t:'select',opts:['rate','dwell','time','distance'],d:'rate',label:'advance',tip:'rate — rows/s; dwell — each row is held for its dwell column; time — by the time column; distance — along the lat / lon points at the set speed. A pulse on trig always steps to the next row'},
    {n:'order',t:'select',opts:['sequential','ping-pong','random','shuffle'],d:'sequential'},
    {n:'rate',t:'range',min:0,max:50,step:.1,d:0,label:'rows/s',if:rpIf('rate','dwell','distance')},
    {n:'speed',t:'range',min:0,max:1000,step:.1,d:50,label:'speed',if:rpIf('distance')},
    {n:'unit',t:'select',opts:['km/h','m/s','knots'],d:'km/h',label:'speed unit',if:rpIf('distance')},
    {n:'tscale',t:'range',min:.01,max:1000,step:.01,log:true,d:1,label:'time ×',if:rpIf('time')},
    {n:'loop',t:'check',d:true},
    {n:'interp',t:'check',d:false,label:'interpolate',if:rpIf('distance')},
    {n:'initial',t:'check',d:true,label:'first row at start'},
    {n:'reset',t:'button',label:'Reset',fn:n=>seqReset(n)},
    {n:'first',t:'num',min:1,max:1e6,step:1,d:1,adv:true,label:'first row'},
    {n:'last',t:'num',min:0,max:1e6,step:1,d:0,adv:true,label:'last row (0=end)'},
    {n:'tcol',t:'text',d:'',adv:true,label:'time col (auto)',if:rpIf('time')},
    {n:'dwellCol',t:'text',d:'dwell',adv:true,label:'dwell col, s',if:rpIf('dwell')},
    {n:'speedCol',t:'text',d:'speed',adv:true,label:'speed col',if:rpIf('distance')},
    {n:'latCol',t:'text',d:'',adv:true,label:'lat col (auto)',if:rpIf('distance')},
    {n:'lonCol',t:'text',d:'',adv:true,label:'lon col (auto)',if:rpIf('distance')},
    {n:'textCol',t:'text',d:'',adv:true,label:'text col (row)',tip:'column that goes to the text output; empty — the whole row'},
  ],
  init:n=>{
    n.p.cols=Array.isArray(n.p.cols) ? n.p.cols : [];
    n.rows=[]; n.headers=n.p.cols.slice();             // порты нужны до чтения списка: их задаёт сохранённый p.cols
    n.src=null; n.listName=''; n.listRev=-1; n.listAt=0; n.readTok=0; n.err='';
    n.trigPrev=0; n.rowPrev=null; n.pulse=0; n.pick=null;
    rpPorts(n); rpDerive(n); seqReset(n);
  },
  process(n,I){
    rpSource(n,I);
    const p=n.p;
    if(n._dk!==[p.tcol,p.latCol,p.lonCol].join('|')) rpDerive(n);
    const o=seqProcess(n,I);
    if(!n.started) for(const c of n.cols) delete o[c.port];      // ничего не выдано — поля не выдаём (как Table)
    else if(n.cur){
      const lc=tblCol(n.headers,TBL_LO), hc=tblCol(n.headers,TBL_HI);
      if(lc){
        const lo=tblHz(n.cur[lc]), hi=hc ? tblHz(n.cur[hc]) : lo;
        if(isFinite(lo)){ const h=isFinite(hi) ? Math.max(lo,hi) : lo; o.mid=(lo+h)/2; o.span=h-lo; }
      }
    }
    return o;
  },
  draw(n){
    const r=n.el.querySelector('.readout'); if(!r) return;
    const N=n.rows.length, src=n.src ? 'rows wire' : n.listName;
    const warn=n.err ? n.err : !src ? 'no source: wire rows or set a list' : !N ? 'no rows' :
      n.p.advance==='time' && !n.tt ? 'no time column' : n.p.advance==='distance' && !n.geo ? 'no lat/lon columns' : '';
    const t=warn ? '⚠ '+warn : src+' · row '+(n.idx+1)+'/'+N+' · '+n.p.advance+(n.done?' · done':'')+
      (n.cur?'\n'+n.headers.slice(0,6).map(h=>h+': '+recFmt(n.cur[h])).join('\n'):'');
    if(r.textContent!==t) r.textContent=t;
  },
  dispose:n=>{ n.disposed=true; n.readTok++; }
});
defGroups('rowplayer',[
  {n:'Source', p:'list'},
  {n:'Playback', p:'advance order rate speed unit tscale interp loop initial reset'},
  {n:'Range', p:'first last', open:false},
  {n:'Columns', p:'tcol dwellCol speedCol latCol lonCol textCol', open:false}]);
