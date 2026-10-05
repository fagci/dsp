"use strict";
/* ============================ File Log ============================
   Потоковая дозапись текста и записей в файл на диске (File System Access API: Chrome / Edge). Данные createWritable() попадают в файл
   только при close(), поэтому дозапись фиксируется периодически: открыть с keepExistingData, встать в конец, записать, закрыть.
   При падении вкладки теряется не больше последнего периода. */

const FL_MAX=5e6;                                           // потолок буфера в символах — если файл не успевает, самое старое отбрасывается
function flCsvCell(v){
  if(v===undefined || v===null) return '';
  if(typeof v==='object') v=JSON.stringify(v);
  const s=String(v); return /[",\r\n;]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s;
}
async function flChoose(n){
  if(!window.showSaveFilePicker){ n.err='needs Chrome / Edge (File System Access)'; return; }
  if(n.picking) return; n.picking=true;
  try{
    const ext={'text lines':'txt','JSON lines (rec)':'jsonl','CSV (rec)':'csv'}[n.p.format];
    const h=await window.showSaveFilePicker({suggestedName:'log-'+new Date().toISOString().slice(0,10)+'.'+ext,types:[{description:'Log',accept:{'text/plain':['.'+ext]}}]});
    n.handle=h; n.size=(await h.getFile()).size; n.cols=null; n.err=''; n.name=h.name;
  }catch(e){ n.err=e.name==='AbortError' ? 'file not chosen' : 'cannot open: '+e.message; }
  n.picking=false;
}
async function flFlush(n){
  if(!n.handle || n.busy || !n.buf.length) return;
  n.busy=true;
  const text=n.buf.join(''), cnt=n.pendingLines; n.buf=[]; n.bufLen=0; n.pendingLines=0;
  try{
    const w=await n.handle.createWritable({keepExistingData:true});
    await w.seek(n.size); await w.write(text); await w.close();
    n.size+=new TextEncoder().encode(text).length; n.written+=cnt; n.lastOk=Date.now(); n.err='';
  }catch(e){
    n.err='write failed: '+e.message; n.buf.unshift(text); n.bufLen+=text.length; n.pendingLines+=cnt;   // вернуть в начало, попробуем в следующий раз
  }
  n.busy=false;
}
function flPush(n,s,lines){
  n.buf.push(s); n.bufLen+=s.length; n.pendingLines+=lines;
  while(n.bufLen>FL_MAX && n.buf.length>1){ n.bufLen-=n.buf.shift().length; n.dropped++; }
}
const flStamp=n=>n.p.stamp ? new Date().toISOString()+' ' : '';
def({ id:'fileLog', title:'File Log', cat:'Output', kw:'file log write append disk save csv jsonl text stream record logger long running file system access',
  ins:[{n:'text',t:'txt'},{n:'rec',t:'rec'}],
  outs:[{n:'lines',t:'num'},{n:'ok',t:'num'}], readout:true,
  params:[{n:'format',t:'select',opts:['text lines','JSON lines (rec)','CSV (rec)'],d:'text lines',label:'what is written (text — the text wire; JSON / CSV — the rec wire)'},
          {n:'columns',t:'text',d:'',label:'CSV columns (empty — those of the first record; t is added as the time)'},
          {n:'stamp',t:'check',d:false,label:'time stamp in front of every text line'},
          {n:'commit',t:'range',min:1,max:300,step:1,d:10,label:'commit to the file every, s'},
          {n:'on',t:'check',d:true,label:'write'},
          {n:'choose',t:'button',label:'Choose file…',fn:n=>flChoose(n)},
          {n:'now',t:'button',label:'Commit now',fn:n=>flFlush(n)}],
  init:n=>{ n.handle=null; n.name=''; n.size=0; n.buf=[]; n.bufLen=0; n.pendingLines=0; n.written=0; n.dropped=0; n.busy=false; n.picking=false;
            n.cols=null; n.lastText=undefined; n.lastCommit=0; n.lastOk=0; n.err=''; },
  dispose:n=>{ flFlush(n); },
  process(n,I){
    if(n.handle && n.p.on){
      const fmt=n.p.format;
      if(fmt==='text lines'){
        if(typeof I.text==='string' && I.text!==n.lastText){
          n.lastText=I.text;
          const ls=I.text.split(/\r?\n/).filter(l=>l.length); if(ls.length) flPush(n,ls.map(l=>flStamp(n)+l+'\n').join(''),ls.length);
        }
      } else {
        const recs=recList(I.rec);
        if(recs.length){
          if(fmt==='JSON lines (rec)') flPush(n,recs.map(r=>JSON.stringify(r)+'\n').join(''),recs.length);
          else {
            if(!n.cols){
              const given=String(n.p.columns||'').split(/[\s,;]+/).filter(Boolean);
              n.cols=given.length ? given : ['t',...Object.keys(recs[0]).filter(k=>k!=='t')];
              if(n.size===0) flPush(n,n.cols.map(flCsvCell).join(',')+'\n',0);        // шапка — только в пустой файл
            }
            flPush(n,recs.map(r=>n.cols.map(c=>flCsvCell(c==='t' && r.t!==undefined ? new Date(r.t).toISOString() : r[c])).join(',')+'\n').join(''),recs.length);
          }
        }
      }
      const now=performance.now();
      if(now-n.lastCommit>=n.p.commit*1000){ n.lastCommit=now; flFlush(n); }
    }
    return {lines:n.written,ok:n.handle && !n.err ? 1 : 0};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const t=(n.handle ? n.name+' · '+Math.round(n.size/1024*10)/10+' kB · written '+n.written+' · waiting '+n.pendingLines+(n.dropped ? ' · dropped '+n.dropped : '') : 'no file: press «Choose file…»')+(n.err ? '\n⚠ '+n.err : '');
    if(r.textContent!==t) r.textContent=t; }
});
