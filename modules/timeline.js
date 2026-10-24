"use strict";
/* ============================ Timeline ============================
   Строки Table (вход rows) как интервалы на оси времени. Дорожки — по колонке (частота, абонент, тип пакета, track…),
   цвет — по другой колонке, высота полоски — по rssi, фильтр, склейка пакетов в выходы в эфир, период / длительность /
   скважность / джиттер по дорожке или по выделенному отрезку, задержки ответа от опорных событий, связь по признаку.
   Воспроизведение: плейхед идёт по оси, начавшиеся события уходят на rec, звук из колонки file (Files) — по желанию.
   Хранилище — Table: сюда строки приходят, наружу уходят выбранные строки (rows), итоги по дорожкам (stats) и — после правки мышью —
   все строки с правками (edited) и только изменённые (diff). Правки лежат поверх строк (параметр edits), пока Table их не приняла.
   Клипы: звук из Files микшируется по дорожкам (эффекты — параметр lanefx) на выход audio, IQ-файлы идут на выход iq.
   Живые входы: rec (записи), gate (сигнал → события). Метки на оси — marks.
   Ядро — timeline-kernels.js, проверка: node tools/test-timeline.mjs */

const TL_COLORS=['#4da3ff','#ff9f4a','#5fd38d','#e46bd0','#f2d24b','#8e8cf5','#4fd0d0','#f26b6b'];
const TL_RND=v=>v==null ? null : Math.round(v*1e6)/1e6;

/* ---------- модель ---------- */
function tlBuild(n,rows,extra){
  const p=n.p, m=tlEvents(rows,{t:p.tcol,dur:p.dcol,unit:p.unit,rssi:p.rssi,file:p.file});
  if(!m.ok) return {ok:false,err:m.err};
  const f=tlFilter([p.filter,extra].filter(Boolean).join(' '));
  const ev=f ? m.ev.filter(f) : m.ev;
  if(!ev.length) return {ok:false,err:'no events match the filter',m};
  const by=String(p.by||'').trim().toLowerCase()==='none' ? '' : String(p.by||'').trim() ||
    TL_LANE.map(c=>m.cols.all.find(x=>x.toLowerCase()===c)).find(Boolean) || '';
  const gap=Math.max(0,+p.gap||0)*1e-3, lanes=tlLanes(ev,by).map(l=>{
    const tx=tlMerge(l.ev,gap); let maxd=0; for(const e of tx) if(e.t1-e.t0>maxd) maxd=e.t1-e.t0;
    return {name:l.name,ev:l.ev,tx,maxd};
  });
  for(const l of lanes){ l.maxdRaw=0; for(const e of l.ev) if(e.t1-e.t0>l.maxdRaw) l.maxdRaw=e.t1-e.t0; }
  const rc=m.cols.rssi; let rlo=Infinity, rhi=-Infinity;
  if(rc) for(const e of ev){ const v=tlNum(e.row[rc]); if(v!==null){ if(v<rlo) rlo=v; if(v>rhi) rhi=v; } }
  const refF=tlFilter(p.ref), refEv=refF ? ev.filter(refF) : null;
  if(refEv) for(const l of lanes) l.isRef=l.ev.every(refF);
  let tmax=0; for(const l of lanes) for(const e of l.tx) if(e.t1>tmax) tmax=e.t1;
  return {ok:true, m, ev, lanes, by, gap, tmax, rlo, rhi:rhi>rlo ? rhi : rlo+1, refEv, gen:(n._gen=(n._gen||0)+1), nraw:rows.length, keys:n.keys, kc:n.kc, idx:null};
}
const tlKey=n=>[n.p.tcol,n.p.dcol,n.p.unit,n.p.rssi,n.p.file,n.p.filter,n.p.by,n.p.gap,n.p.ref,n.p.key].join('\0');
const tlEk=(T,e)=>T.keys ? T.keys[e.i] : tlRk(e.row,e.i,T.kc);                  // ключ исходной строки события
function tlIdx(n){                                                              // ключ → {дорожка, событие}
  const T=n.tl; if(!T || !T.ok) return null;
  if(!T.idx){ const m=new Map(); for(const l of T.lanes) for(const e of l.ev) m.set(tlEk(T,e),{l,e}); T.idx=m; }
  return T.idx;
}

// события выбранных дорожек в отрезке (если он есть)
function tlScope(n){
  const T=n.tl; if(!T || !T.ok) return [];
  const r=n.range, out=[];
  T.lanes.forEach(l=>{
    if(n.solo!=null && l.name!==n.solo) return;
    out.push(r ? {l,tx:l.tx.filter(e=>e.t0>=r.a && e.t0<=r.b)} : {l,tx:l.tx});
  });
  return out;
}
function tlCompute(n){                                           // итоги по дорожкам и выходные ряды — один раз на смену модели / отрезка / дорожки
  const T=n.tl, key=T && T.ok ? T.gen+'|'+n.solo+'|'+(n.range ? n.range.a+'~'+n.range.b : '')+'|'+n.p.tol+'|'+n.p.lagmax : '';
  if(n._ck===key) return; n._ck=key;
  if(!key){ n.stats=[]; n.outRows=null; n.sum=null; return; }
  const sc=tlScope(n), rc=T.m.cols.rssi, tol=(+n.p.tol||10)/100, lagmax=(+n.p.lagmax||0)*1e-3;
  const stats=[], all=[];
  for(const {l,tx} of sc){
    const s=tlStats(tx,{tol,rssi:rc});
    if(T.refEv && !l.isRef){ const g=tlLag(T.refEv,tx,lagmax); s.lag=g.med; s.lag_std=g.std; s.lag_n=g.n; }
    stats.push(Object.assign({lane:l.name},...Object.keys(s).map(k=>({[k]:TL_RND(s[k])}))));
    for(const e of tx) for(const q of e.parts||[e]) all.push(q);
  }
  all.sort((a,b)=>a.t0-b.t0);
  n.stats=stats; n.outRows=all.map(e=>e.row);
  const flat=sc.flatMap(x=>x.tx).sort((a,b)=>a.t0-b.t0);
  n.sum=sc.length===1 ? stats[0] : tlStats(flat,{tol,rssi:rc});
  n.sumLanes=sc.length;
}

/* ---------- файлы из Files ---------- */
async function tlFindFile(ref){
  if(typeof FileStore==='undefined') return null;
  const id=tlNum(ref);
  if(id!==null){ const r=await FileStore.get(id); if(r) return r; }
  const name=String(ref).toLowerCase();
  for(const sp of FS_SPACES){ const hit=(await FileStore.listAll(sp)).find(f=>String(f.name).toLowerCase()===name); if(hit) return hit; }
  return null;
}
async function tlPlayFile(n,row,dur){
  const fc=n.tl && n.tl.m.cols.file, ref=fc ? row[fc] : null;
  if(ref==null || ref==='') return;
  const rec=await tlFindFile(ref);
  if(!rec || !rec.blob || !/^(audio|video)\//.test(rec.blob.type||rec.mime||'')) return;
  const url=URL.createObjectURL(rec.blob), a=new Audio(url), off=tlNum(row.off ?? row.offset);
  (n.auds||(n.auds=new Set())).add(a);
  const done=()=>{ n.auds.delete(a); URL.revokeObjectURL(url); };
  a.onended=a.onerror=done;
  if(off) a.currentTime=off;
  if(n.p.trim && dur>.01) setTimeout(()=>{ a.pause(); done(); },dur*1000);
  a.play().catch(done);
}
const tlStopAudio=n=>{ if(n.auds) for(const a of n.auds) a.pause(); n.auds=null; };

/* ---------- звук и IQ клипов ----------
   Файл из колонки file раскладывается один раз: звук (аудио / видео) декодируется в моно на частоте движка, IQ читается кусками
   по требованию. Когда плейхед идёт, клипы под ним микшируются по дорожкам (усиление gain, fadein / fadeout / fade, смещение off в
   файле, эффекты дорожки из lanefx) на выход audio; первый IQ-клип отдаёт отсчёты на выход iq. */
const TL_IQCH=1<<17, TL_AUDMAX=4e7;
function tlAsset(n,ref){
  const k=String(ref); let a=n.ast.get(k);
  if(!a){
    a={st:'load',kind:null,msg:'',use:0};
    n.ast.set(k,a);
    tlLoadAsset(a,k,+n.p.iqrate||0).then(()=>tlTrimAssets(n)).catch(e=>{ a.st='err'; a.msg=String(e && e.message || e); });
  }
  a.use=performance.now(); return a;
}
async function tlLoadAsset(a,ref,defRate){
  const rec=await tlFindFile(ref);
  if(!rec || !rec.blob){ a.st='err'; a.msg='not found in Files'; return; }
  const name=String(rec.name||''), mime=rec.blob.type||rec.mime||'';
  const isIq=!!(rec.meta && rec.meta.iq) || (typeof IQF_EXT!=='undefined' && IQF_EXT.test(name));
  if(!isIq && (/^(audio|video)\//.test(mime) || /\.(wav|mp3|ogg|oga|opus|flac|m4a|aac|webm|mp4|mkv)$/i.test(name))){
    if(rec.blob.size>200e6) throw new Error('file is larger than 200 MB');
    const au=await new OfflineAudioContext(1,1,Eng.sr||48000).decodeAudioData(await rec.blob.arrayBuffer());
    const chs=[]; for(let c=0;c<au.numberOfChannels;c++) chs.push(au.getChannelData(c));
    a.buf=Float32Array.from(tlMono(chs)); a.sr=au.sampleRate; a.kind='audio'; a.st='ready';
  } else{
    if(typeof iqParseFiles==='undefined') throw new Error('IQ files are not supported here');
    const src=await iqParseFiles([iqfAsFile(rec)],'auto');
    if(!(src.rate>0) && !(defRate>0)) throw new Error('the file has no sample rate — set «sample rate of raw IQ files»');
    a.src=src; a.bps=IQP_BPS[src.dtype]; a.total=Math.floor(src.size/a.bps); a.sr=src.rate>0 ? src.rate : defRate; a.chunks=new Map(); a.kind='iq'; a.st='ready';
  }
}
function tlTrimAssets(n){                                          // звука в памяти не больше TL_AUDMAX отсчётов: лишнее — давно не игравшее
  let tot=0; for(const a of n.ast.values()) if(a.buf) tot+=a.buf.length;
  if(tot<=TL_AUDMAX) return;
  for(const [k,a] of [...n.ast].filter(([,a])=>a.buf).sort((x,y)=>x[1].use-y[1].use)){ if(tot<=TL_AUDMAX) break; tot-=a.buf.length; n.ast.delete(k); }
}
function tlWarm(n){                                                // файлы клипов — в память до того, как плейхед до них дойдёт
  const T=n.tl, fc=T && T.ok && T.m.cols.file; if(!fc || n._warm===T.gen) return; n._warm=T.gen;
  const seen=new Set();
  for(const e of T.ev){ const f=e.row[fc]; if(f==null || f==='') continue; seen.add(String(f)); if(seen.size>=48) break; }
  for(const f of seen) tlAsset(n,f);
  let c=0;
  for(const e of T.ev){                                              // первый кусок IQ каждого клипа читается заранее — начало не теряется
    const f=e.row[fc]; if(f==null || f==='' || ++c>400) continue;
    const as=n.ast.get(String(f));
    if(as && as.st==='ready' && as.kind==='iq') tlIqChunk(as,Math.floor((tlNum(e.row.off ?? e.row.offset)||0)*as.sr/TL_IQCH));
  }
}
// клипы дорожки, чьи интервалы пересекают (a,b]; endOf(e) — конец клипа (или -Infinity, если играть нечего)
function tlOverlap(l,a,b,endOf){
  const ev=l.ev, out=[];
  for(let i=tlBound(ev,b)-1,k=0;i>=0 && k<256;i--,k++){ const e=ev[i]; if(a-e.t0>900) break; if(endOf(e)>a) out.push(e); }
  return out;
}
function tlClipEnd(n,e,as){                                        // обрезка по длине события или файл целиком (точка и событие без длины)
  const d=e.t1-e.t0, off=tlNum(e.row.off ?? e.row.offset)||0;
  if(n.p.trim && d>.01) return e.t1;
  const len=as && as.st==='ready' ? (as.kind==='iq' ? as.total/as.sr : as.buf.length/as.sr) : 0;
  return e.t0+Math.max(0,len-off);
}
function tlMixBlock(n,T,adv){
  const p=n.p, out=buf(n,'audio'), fc=T.m.cols.file; out.fill(0);
  if(!fc || !adv || !(adv[1]>adv[0]) || adv[1]-adv[0]>2) return out;
  const sr=Eng.sr, a=adv[0], b=adv[1], lb=n.lbuf && n.lbuf.length===BLOCK ? n.lbuf : (n.lbuf=new Float32Array(BLOCK));
  for(const l of T.lanes){
    const fx=n.fxm.get(l.name)||{}, st=n.fxs.get(l.name) || n.fxs.set(l.name,{}).get(l.name);
    lb.fill(0); let any=false;
    if(!fx.silent){
      const ovl=tlOverlap(l,a,b,e=>{ const f=e.row[fc]; if(f==null || f==='') return -Infinity;
        const as=tlAsset(n,f); return as.st==='ready' && as.kind==='audio' ? tlClipEnd(n,e,as) : -Infinity; });
      for(const e of ovl){
        const as=tlAsset(n,e.row[fc]), r=e.row, gdb=tlNum(r.gain), fade=tlNum(r.fade);
        tlMixClip(lb,{buf:as.buf,sr:as.sr,t0:e.t0,t1:tlClipEnd(n,e,as),off:tlNum(r.off ?? r.offset)||0,
          lin:gdb===null ? 1 : Math.pow(10,gdb/20),fi:tlNum(r.fadein ?? fade)||0,fo:tlNum(r.fadeout ?? fade)||0},a,b);
        any=true;
      }
    }
    if(any || st.eb) tlFxRun(fx,st,lb,sr);
    if(!fx.silent) for(let i=0;i<BLOCK;i++) out[i]+=lb[i];
  }
  const g=Math.pow(10,(+p.master||0)/20);
  for(let i=0;i<BLOCK;i++){ const v=out[i]*g; out[i]=v>1 ? 1 : v<-1 ? -1 : v; }
  return out;
}
function tlIqChunk(as,c){
  let ch=as.chunks.get(c);
  if(!ch){
    ch={v:null}; as.chunks.set(c,ch);
    const a=c*TL_IQCH, b=Math.min(as.total,a+TL_IQCH);
    if(a>=as.total) ch.v={re:new Float32Array(0),im:new Float32Array(0)};
    else as.src.blob.slice(as.src.off+a*as.bps,as.src.off+b*as.bps).arrayBuffer()
      .then(bf=>{ const [re,im]=iqpDecode(bf,as.src.dtype); ch.v={re,im}; })
      .catch(()=>{ ch.v={re:new Float32Array(0),im:new Float32Array(0)}; });
    if(as.chunks.size>12) for(const k of as.chunks.keys()){ if(k!==c){ as.chunks.delete(k); break; } }
  }
  return ch;
}
function tlIqRead(as,lo,hi){                                       // null — куски ещё читаются (следующий блок возьмёт)
  const re=new Float32Array(hi-lo), im=new Float32Array(hi-lo), c1=Math.floor((hi-1)/TL_IQCH);
  for(let c=Math.floor(lo/TL_IQCH);c<=c1;c++){
    const ch=tlIqChunk(as,c); if(!ch.v) return null;
    const base=c*TL_IQCH, s0=Math.max(lo,base), s1=Math.min(hi,base+ch.v.re.length);
    if(s1>s0){ re.set(ch.v.re.subarray(s0-base,s1-base),s0-lo); im.set(ch.v.im.subarray(s0-base,s1-base),s0-lo); }
  }
  if((c1+1)*TL_IQCH<as.total) tlIqChunk(as,c1+1);                  // упреждающее чтение
  return {re,im};
}
function tlIqBlock(n,T,adv){
  const fc=T.m.cols.file; if(!fc || !adv || !(adv[1]>adv[0]) || adv[1]-adv[0]>2) return null;
  const a=adv[0], b=adv[1];
  for(const l of T.lanes){
    const ovl=tlOverlap(l,a,b,e=>{ const f=e.row[fc]; if(f==null || f==='') return -Infinity;
      const as=tlAsset(n,f); return as.st==='ready' && as.kind==='iq' ? tlClipEnd(n,e,as) : -Infinity; });
    for(const e of ovl){
      const as=tlAsset(n,e.row[fc]), off=tlNum(e.row.off ?? e.row.offset)||0;
      const sp=tlIqSpan(a,Math.min(b,tlClipEnd(n,e,as)),e.t0,off,as.sr,as.total); if(!sp) continue;
      const blk=tlIqRead(as,sp[0],sp[1]); if(!blk) continue;
      const fq=tlNum(e.row.fc ?? e.row.fcenter), cap=as.src.captures && as.src.captures[0];
      const s=iqStream(n,'iq',as.sr,fq!==null ? fq : cap ? cap.freq : 0);
      iqPush(s,blk.re,blk.im); return s;
    }
  }
  return null;
}

/* ---------- живые входы ---------- */
const tlHasTime=(r,want)=>{ for(const k in r){ const l=k.toLowerCase(); if(TL_T.includes(l) || (want && l===String(want).toLowerCase())) return true; } return false; };
function tlLiveIn(n,I){
  let ch=false;
  const rc=I.rec;
  if(rc && rc!==n.lastRec){
    n.lastRec=rc;
    for(const r of Array.isArray(rc) ? rc : [rc]) if(r && typeof r==='object'){ const q=Object.assign({},r); if(!tlHasTime(q,n.p.tcol)) q.t=Date.now(); n.live.push(q); ch=true; }
  }
  if(I.gate && I.gate.length){
    const g=tlGate(n.gst,I.gate,+n.p.gthr||.5,.05);
    if(g.length){ const now=Date.now(), end=n.gst.pos, sr=Eng.sr;
      for(const o of g){ n.live.push({t:Math.round(now-(end-o.i0)/sr*1000), dur:Math.round(o.n/sr*1e6)/1e3, lane:String(n.p.glane||'gate')}); ch=true; } }
  }
  const mx=Math.max(100,+n.p.livemax||20000);
  if(n.live.length>mx){ n.live.splice(0,n.live.length-mx); ch=true; }
  if(ch) n.liveRev=(n.liveRev|0)+1;
}
function tlSrc(n,rowsIn){                                          // строки Table + живые события одним набором (тот же массив, пока ничего не изменилось)
  if(!n.live.length) return rowsIn;
  if(!rowsIn){ if(n.liveB!==n.liveRev){ n.liveArr=n.live.slice(); n.liveB=n.liveRev; } return n.liveArr; }
  if(n.cat && n.catIn===rowsIn && n.catLen===rowsIn.length && n.catRev===n.liveRev) return n.cat;
  n.cat=rowsIn.concat(n.live); n.catIn=rowsIn; n.catLen=rowsIn.length; n.catRev=n.liveRev; return n.cat;
}

/* ---------- правка мышью ---------- */
const tlByCols=T=>String(T.by||'').split(',').map(s=>s.trim()).filter(Boolean);
const tlNewId=n=>'tl'+Date.now().toString(36)+(n._idc=(n._idc|0)+1).toString(36);
function tlEdSave(n,hist){                                         // правки → параметр edits (сохраняется с патчем); hist — шаг истории
  n.edRev=(n.edRev|0)+1;
  const s=tlEdSize(n.ed) ? JSON.stringify(n.ed) : '';
  n.p.edits=n._edSaved=s;
  if(hist){ n.eh.length=n.ei+1; n.eh.push(s); if(n.eh.length>100) n.eh.shift(); n.ei=n.eh.length-1; } else n.eh[n.ei]=s;
}
function tlEdit(n,fn){ const ed=tlEdClone(n.ed); fn(ed); n.ed=ed; tlEdSave(n,true); redraw(n); }
function tlUndo(n,d){
  const j=n.ei+d; if(j<0 || j>=n.eh.length) return;
  n.ei=j; n.ed=tlEdParse(n.eh[j]); n.edRev=(n.edRev|0)+1; n.p.edits=n._edSaved=n.eh[j]; n.sel.clear(); n.pick=null; redraw(n);
}
function tlSetPatch(ed,rk,patch){
  if(rk[0]==='n'){ const j=+rk.slice(2); ed.a[j]=Object.assign({},ed.a[j],patch); }
  else ed.p[rk]=Object.assign(ed.p[rk]||{},patch);
}
function tlSelItems(n){                                            // выделенные события (по ключам) с дорожками
  const T=n.tl, ix=tlIdx(n), out=[]; if(!ix) return out;
  for(const rk of n.sel){ const h=ix.get(rk); if(h) out.push({rk,e:h.e,l:h.l,li:T.lanes.indexOf(h.l)}); }
  return out;
}
function tlOpDelete(n){
  const rks=[...n.sel]; if(!rks.length) return;
  tlEdit(n,ed=>{
    const na=[];
    for(const k of rks){ if(k[0]==='n') na.push(+k.slice(2)); else{ delete ed.p[k]; ed.d[k]=1; } }
    na.sort((x,y)=>y-x).forEach(j=>ed.a.splice(j,1));
  });
  n.sel.clear(); n.pick=null;
}
function tlOpAdd(n,t,li){
  const T=n.tl; if(!T || !T.ok) return;
  const l=T.lanes[clamp(li|0,0,T.lanes.length-1)], row={};
  for(const c of tlByCols(T)) row[c]=l ? l.ev[0].row[c] ?? '' : '';
  const d=Math.max(.001,+n.p.newdur||1);
  Object.assign(row,tlPatch(T.m,Math.max(0,t),Math.max(0,t)+d,true));
  if(T.kc) row[T.kc]=tlNewId(n);
  tlEdit(n,ed=>{ ed.a.push(row); });
  const k='n:'+(n.ed.a.length-1); n.sel=new Set([k]); n.pick={lane:l ? l.name : '',rk:k};
}
// сдвиг / изменение краёв выделенного; dup — копии вместо перемещения
function tlDragCommit(n,d){
  const T=n.tl, m=T.m, cols=tlByCols(T), fresh=[];
  tlEdit(n,ed=>{
    for(const it of d.items){
      let t0=it.e.t0, t1=it.e.t1;
      if(d.kind==='move'){ t0+=d.dt; t1+=d.dt; }
      else if(d.kind==='rl') t0=Math.min(t0+d.dt,t1);
      else t1=Math.max(t1+d.dt,t0);
      t0=Math.max(0,t0); if(t1<t0) t1=t0;
      const patch=tlPatch(m,t0,t1,d.kind!=='move');
      if(d.kind==='move' && d.dl && cols.length){ const tl=T.lanes[clamp(it.li+d.dl,0,T.lanes.length-1)]; for(const c of cols) patch[c]=tl.ev[0].row[c] ?? ''; }
      if(d.dup){ const row=Object.assign({},it.e.row,patch); if(T.kc) row[T.kc]=tlNewId(n); ed.a.push(row); fresh.push('n:'+(ed.a.length-1)); }
      else tlSetPatch(ed,it.rk,patch);
    }
  });
  if(d.dup){ n.sel=new Set(fresh); n.pick=null; }
}
function tlOpDupHere(n){                                           // Ctrl+D: копии сразу за выделенным
  const items=tlSelItems(n); if(!items.length) return;
  let a=Infinity, b=-Infinity; for(const it of items){ if(it.e.t0<a) a=it.e.t0; if(it.e.t1>b) b=it.e.t1; }
  tlDragCommit(n,{kind:'move',items,dt:Math.max(b-a,.001),dl:0,dup:true});
}
function tlOpField(n){                                             // «колонка=значение» всем выделенным: file, gain, fadein, label…
  const items=tlSelItems(n); if(!items.length){ showToast('select clips first (edit mode)'); return; }
  const s=prompt('Set a column on '+items.length+' selected clip(s): column=value  (e.g. file=beep.wav, gain=-6, fade=0.2)','file=');
  const m=s && /^\s*([\w.]+)\s*=(.*)$/.exec(s); if(!m) return;
  const v=tlNum(m[2]) !== null ? tlNum(m[2]) : m[2].trim();
  tlEdit(n,ed=>{ for(const it of items) tlSetPatch(ed,it.rk,{[m[1]]:v}); });
}

/* ---------- метки ---------- */
function tlMarkSave(n){ n.p.mks=n._mSaved=n.marks.length ? tlMarksStr(n.marks) : ''; }
function tlMarkAdd(n,t,label){
  const m={t:Math.round(t*1e6)/1e6,label:label==null ? 'M'+(n.marks.length+1) : label};
  n.marks.push(m); n.marks.sort((x,y)=>x.t-y.t); n.msel=m; tlMarkSave(n); n._mk=null; redraw(n);
}
function tlMarkDel(n){
  if(!n.msel) return; n.marks=n.marks.filter(x=>x!==n.msel); n.msel=null; tlMarkSave(n); n._mk=null; redraw(n);
}
function tlMarkAt(n,g,x){                                          // метка у точки x (допуск 6 px): свои и внешние
  for(const m of n.marks){ if(Math.abs(tlX(n,g,m.t)-x)<=6) return {m,ext:false}; }
  for(const m of n.xm||[]){ if(Math.abs(tlX(n,g,m.t)-x)<=6) return {m,ext:true}; }
  return null;
}
function tlXMarks(n,rows){                                         // внешние метки (вход marks): строки с временем и label / text / name
  const T=n.tl; n.xm=[]; if(!rows || !rows.length || !T || !T.ok) return;
  const mm=tlEvents(rows,{unit:T.m.unit});
  if(!mm.ok) return;
  n.xm=mm.ev.map(e=>({t:mm.origin+e.t0-T.m.origin,label:String(e.row.label ?? e.row.text ?? e.row.name ?? e.row.note ?? '')}));
}

/* ---------- файлы наружу ---------- */
function tlDownload(blob,name){
  const a=document.createElement('a'), u=URL.createObjectURL(blob);
  a.href=u; a.download=name; document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(u),10000);
}
function tlPng(n){
  const cv=n._cv; if(!cv) return;
  const o=document.createElement('canvas'); o.width=cv.width; o.height=cv.height;
  const x=o.getContext('2d'); x.fillStyle=getComputedStyle(document.body).backgroundColor || '#0e1113'; x.fillRect(0,0,o.width,o.height); x.drawImage(cv,0,0);
  o.toBlob(b=>b && tlDownload(b,'timeline.png'),'image/png');
}
function tlCsvOut(n){
  const rows=n.eff ? n.eff.rows : null; if(!rows || !rows.length){ showToast('no rows'); return; }
  tlDownload(new Blob([tlCsv(rows)],{type:'text/csv'}),'timeline.csv');
}

function tlDiffRows(n,src){                                        // только изменённое: _op = set / add / del и ключ _key
  const ed=n.ed, kc=n.kc, rows=[];
  src.forEach((r,i)=>{
    if(!r || typeof r!=='object') return;
    const k=tlRk(r,i,kc);
    if(ed.d[k]) rows.push(Object.assign({_op:'del',_key:k},r));
    else if(ed.p[k]) rows.push(Object.assign({_op:'set',_key:k},r,ed.p[k]));
  });
  ed.a.forEach((r,j)=>rows.push(Object.assign({_op:'add',_key:'n:'+j},r)));
  return rows;
}

/* ---------- вид ---------- */
function tlFit(n){
  const T=n.tl; if(!T || !T.ok) return;
  const pad=Math.max(T.tmax*.02,1e-4); n.v0=-pad; n.v1=T.tmax+pad; redraw(n);
}
function tlGeo(n,cv){
  const W=cv.width, H=cv.height, T=n.tl, nl=T && T.ok ? T.lanes.length : 1;
  const fs=Math.max(9,Math.min(12,Math.round(H/20))), LAB=Math.min(Math.round(W*.28),36+fs*8), AX=fs+8, pw=Math.max(10,W-LAB-4);
  const lh=Math.max(12,Math.min(60,+n.p.lh||22)), rh=nl*lh<H-AX ? Math.min(60,Math.floor((H-AX)/nl)) : lh;
  const nvis=Math.max(1,Math.floor((H-AX)/rh));
  n.ly=clamp(n.ly|0,0,Math.max(0,nl-nvis));
  return {W,H,fs,LAB,AX,pw,rh,nvis,nl};
}
const tlX=(n,g,t)=>g.LAB+(t-n.v0)/(n.v1-n.v0)*g.pw;
const tlT=(n,g,x)=>n.v0+(x-g.LAB)/g.pw*(n.v1-n.v0);
function tlColor(n,e,li){
  const c=String(n.p.color||'').trim();
  if(!c) return TL_COLORS[li%TL_COLORS.length];
  const v=String(e.row[c]??''), cm=n.cmap||(n.cmap=new Map());
  if(!cm.has(v)) cm.set(v,cm.size);
  return TL_COLORS[cm.get(v)%TL_COLORS.length];
}
function tlHitIn(n,g,x,y,evOf,maxOf){                             // событие под точкой (допуск 4 px по времени)
  const T=n.tl; if(!T || !T.ok || y<g.AX) return null;
  const li=n.ly+Math.floor((y-g.AX)/g.rh), l=T.lanes[li]; if(!l) return {li,e:null};
  const tol=4/g.pw*(n.v1-n.v0), t=tlT(n,g,x), ev=evOf(l);
  let best=null, bd=Infinity;
  for(let i=Math.max(0,tlBound(ev,t-tol-maxOf(l))-1);i<ev.length && ev[i].t0<=t+tol;i++){
    const e=ev[i]; if(e.t1<t-tol) continue;
    const d=t<e.t0 ? e.t0-t : t>e.t1 ? t-e.t1 : 0;
    if(d<=bd){ bd=d; best=e; }                                     // при равенстве — более поздний (лежит сверху)
  }
  return {li,e:best};
}
const tlHit=(n,g,x,y)=>tlHitIn(n,g,x,y,l=>l.tx,l=>l.maxd);        // по всплескам (как нарисовано)
const tlHitRaw=(n,g,x,y)=>tlHitIn(n,g,x,y,l=>l.ev,l=>l.maxdRaw);  // по отдельным строкам (для правки)
function tlPick(n){                                              // выбранное событие после пересборки модели
  const k=n.pick, ix=tlIdx(n); if(!k || !ix) return null;
  const h=ix.get(k.rk); if(!h) return null;
  const tx=h.l.tx;
  for(let j=tlBound(tx,h.e.t0)-1,q=0;j>=0 && q<3;j--,q++){ const x=tx[j]; if(x===h.e || (x.parts && x.parts.includes(h.e))) return {l:h.l,e:x}; }
  return {l:h.l,e:h.e};
}
// значения, к которым притягивается край при перетаскивании: сетка линейки, края других событий, метки, плейхед
function tlSnapList(n,g,skip){
  const T=n.tl, out=[0], span=n.v1-n.v0, step=tlStep(span,Math.max(2,g.pw/70));
  for(let t=Math.ceil(n.v0/step)*step;t<=n.v1;t+=step) out.push(t);
  let c=0;
  for(const l of T.lanes) for(let i=Math.max(0,tlBound(l.ev,n.v0-l.maxdRaw)-1);i<l.ev.length && l.ev[i].t0<=n.v1 && c<6000;i++,c++){
    const e=l.ev[i]; if(skip.has(tlEk(T,e))) continue; out.push(e.t0,e.t1);
  }
  for(const m of n.marks) out.push(m.t);
  if(n.ph!=null) out.push(n.ph);
  return out.sort((a,b)=>a-b);
}

function tlDraw(n,cv,cx){
  tlWire(n,cv);
  const T=n.tl, g=tlGeo(n,cv), {W,H,fs,LAB,AX,pw,rh}=g;
  cx.clearRect(0,0,W,H);
  cx.font=fs+'px monospace'; cx.textBaseline='middle';
  if(!T || !T.ok){ cx.fillStyle=themeColor('--axis'); cx.fillText(T ? T.err : 'wire a Table «rows» output (or «rec» / «gate» for live events)',8,16); return; }
  if(n.v0==null) tlFit(n);
  const v0=n.v0, v1=n.v1, span=v1-v0, axis=themeColor('--axis'), grid=themeColor('--grid'), txt=themeColor('--txt');
  // линейка
  const step=tlStep(span,Math.max(2,pw/70));
  cx.strokeStyle=grid; cx.fillStyle=axis; cx.lineWidth=1; cx.textAlign='center';
  for(let t=Math.ceil(v0/step)*step;t<=v1;t+=step){
    const x=Math.round(tlX(n,g,t))+.5;
    cx.beginPath(); cx.moveTo(x,AX-4); cx.lineTo(x,H); cx.stroke();
    cx.fillText(tlFmt(Math.abs(t)<step*1e-6 ? 0 : t,step),Math.max(LAB+14,Math.min(W-14,x)),AX/2-1);
  }
  const pk=tlPick(n), link=String(n.p.link||'').trim().split(',').map(s=>s.trim()).filter(Boolean);
  const lk=pk && link.length ? link.map(c=>pk.e.row[c]).join('\0') : null;
  const rc=T.m.cols.rssi, rspan=T.rhi-T.rlo, hbar=n.p.rssiH && rc;
  const scope=new Set(n.solo!=null ? [n.solo] : T.lanes.map(l=>l.name));
  const ix=n.sel.size ? tlIdx(n) : null;
  for(let k=0;k<g.nvis;k++){
    const li=n.ly+k, l=T.lanes[li]; if(!l) break;
    const y0=AX+k*rh, inner=rh-4, fx=n.fxm && n.fxm.get(l.name);
    cx.strokeStyle=grid; cx.beginPath(); cx.moveTo(0,y0+rh-.5); cx.lineTo(W,y0+rh-.5); cx.stroke();
    const tag=fx ? (fx.silent ? 'M' : fx.solo ? 'S' : fx.lp || fx.hp || fx.echo || fx.gain!=null ? 'fx' : '') : '';
    cx.textAlign='left'; cx.fillStyle=scope.has(l.name) ? txt : axis;
    cx.fillText(String(l.name).slice(0,Math.floor((LAB-8-(tag ? fs*1.6 : 0))/(fs*.6))),4,y0+rh/2);
    if(tag){ cx.textAlign='right'; cx.fillStyle=tag==='M' ? '#f26b6b' : tag==='S' ? '#f2d24b' : axis; cx.fillText(tag,LAB-3,y0+rh/2); }
    cx.save(); cx.beginPath(); cx.rect(LAB,y0,pw+4,rh); cx.clip();
    const tx=l.tx; let drawn=0;
    for(let i=Math.max(0,tlBound(tx,v0-l.maxd)-1);i<tx.length && tx[i].t0<=v1 && drawn<20000;i++){
      const e=tx[i]; if(e.t1<v0) continue;
      drawn++;
      const x=tlX(n,g,e.t0), w=Math.max(1,tlX(n,g,e.t1)-x);
      let h=inner;
      if(hbar){ const v=tlNum(e.row[rc]); if(v!==null) h=Math.max(3,inner*(.25+.75*clamp((v-T.rlo)/rspan,0,1))); }
      cx.fillStyle=tlColor(n,e,li);
      cx.globalAlpha=scope.has(l.name) && !(fx && fx.silent) ? 1 : .35;
      cx.fillRect(x,y0+2+inner-h,w,h);
      if(lk!==null && link.map(c=>e.row[c]).join('\0')===lk){
        cx.globalAlpha=1; cx.strokeStyle=txt; cx.strokeRect(x-.5,y0+1.5,w+1,rh-3); }
    }
    cx.globalAlpha=1;
    if(ix){                                                        // выделенные клипы: рамка и ручки краёв
      cx.strokeStyle='#fff'; cx.lineWidth=1.5;
      for(let i=Math.max(0,tlBound(l.ev,v0-l.maxdRaw)-1);i<l.ev.length && l.ev[i].t0<=v1;i++){
        const e=l.ev[i]; if(e.t1<v0 || !n.sel.has(tlEk(T,e))) continue;
        const x=tlX(n,g,e.t0), w=Math.max(1,tlX(n,g,e.t1)-x);
        cx.strokeRect(x-.5,y0+1.5,w+1,rh-3);
        if(w>=12){ cx.fillStyle='rgba(255,255,255,.85)'; cx.fillRect(x,y0+3,2,rh-6); cx.fillRect(x+w-2,y0+3,2,rh-6); }
      }
      cx.lineWidth=1;
    }
    cx.restore();
  }
  if(pk){                                                        // выбранное — рамкой на своей дорожке
    const li=T.lanes.indexOf(pk.l), k=li-n.ly;
    if(k>=0 && k<g.nvis){ const x=tlX(n,g,pk.e.t0), w=Math.max(1,tlX(n,g,pk.e.t1)-x), y0=AX+k*rh;
      cx.strokeStyle='#fff'; cx.lineWidth=1.5; cx.strokeRect(x-1,y0+1,w+2,rh-2); cx.lineWidth=1; }
  }
  const d=n.drag;
  if(d && d.moved){                                              // тень перетаскиваемого и линия притяжения
    cx.save(); cx.beginPath(); cx.rect(LAB,AX,pw+4,H-AX); cx.clip();
    for(const it of d.items){
      let t0=it.e.t0, t1=it.e.t1;
      if(d.kind==='move'){ t0+=d.dt; t1+=d.dt; } else if(d.kind==='rl') t0=Math.min(t0+d.dt,t1); else t1=Math.max(t1+d.dt,t0);
      const li=d.kind==='move' ? clamp(it.li+d.dl,0,T.lanes.length-1) : it.li, k=li-n.ly; if(k<0 || k>=g.nvis) continue;
      const x=tlX(n,g,t0), w=Math.max(2,tlX(n,g,t1)-x), y0=AX+k*rh;
      cx.fillStyle=d.dup ? 'rgba(95,211,141,.45)' : 'rgba(255,255,255,.28)'; cx.fillRect(x,y0+2,w,rh-4);
      cx.setLineDash([4,3]); cx.strokeStyle=d.dup ? '#5fd38d' : '#fff'; cx.strokeRect(x+.5,y0+2.5,w-1,rh-5); cx.setLineDash([]);
    }
    if(d.snapped!=null){ const x=Math.round(tlX(n,g,d.snapped))+.5; cx.strokeStyle='#4fd0d0'; cx.beginPath(); cx.moveTo(x,AX); cx.lineTo(x,H); cx.stroke(); }
    cx.restore();
  }
  if(n.range){                                                   // отрезок измерения
    const a=tlX(n,g,n.range.a), b=tlX(n,g,n.range.b);
    cx.fillStyle='rgba(120,160,255,.16)'; cx.fillRect(a,AX,b-a,H-AX);
    cx.strokeStyle='rgba(120,160,255,.9)'; cx.beginPath(); cx.moveTo(Math.round(a)+.5,AX); cx.lineTo(Math.round(a)+.5,H); cx.moveTo(Math.round(b)+.5,AX); cx.lineTo(Math.round(b)+.5,H); cx.stroke();
    cx.fillStyle=txt; cx.textAlign='left'; cx.fillText('Δ '+tlDur(n.range.b-n.range.a),Math.min(W-80,Math.max(LAB,a)+4),AX+fs);
  }
  // метки: флажок на линейке, тонкая линия, подпись
  cx.textAlign='left';
  for(const [list,col] of [[n.xm||[],'#7fd1ff'],[n.marks,'#ffd24a']]){
    for(const m of list){
      const x=Math.round(tlX(n,g,m.t))+.5; if(x<LAB-1 || x>W) continue;
      const sel=m===n.msel;
      cx.strokeStyle=col; cx.globalAlpha=sel ? .9 : .45; cx.beginPath(); cx.moveTo(x,AX-4); cx.lineTo(x,H); cx.stroke(); cx.globalAlpha=1;
      cx.fillStyle=col; cx.beginPath(); cx.moveTo(x-5,0); cx.lineTo(x+5,0); cx.lineTo(x,AX-5); cx.closePath(); cx.fill();
      if(sel){ cx.strokeStyle='#fff'; cx.stroke(); }
      if(m.label){ const w=cx.measureText(m.label).width+6; cx.fillStyle='rgba(0,0,0,.45)'; cx.fillRect(x+3,AX+1,w,fs+3);
        cx.fillStyle=col; cx.fillText(m.label,x+6,AX+fs/2+2); }
    }
  }
  if(n.ph!=null){
    const x=Math.round(tlX(n,g,n.ph))+.5;
    if(x>=LAB && x<=W){ cx.strokeStyle='#ff5c5c'; cx.lineWidth=1.5; cx.beginPath(); cx.moveTo(x,0); cx.lineTo(x,H); cx.stroke(); cx.lineWidth=1; }
  }
  if(g.nl>g.nvis){ cx.fillStyle=axis; cx.textAlign='right'; cx.fillText((n.ly+1)+'–'+(n.ly+g.nvis)+' / '+g.nl,W-4,AX+fs); }
  cx.textAlign='left'; cx.textBaseline='alphabetic';
}

function tlWire(n,cv){                                           // перетаскивание, выделение, колесо, клавиши
  n._cv=cv;
  if(n._wcv===cv) return; n._wcv=cv;
  cv.tabIndex=0; cv.style.outline='none';
  let drag=null;
  const pos=ev=>{ const r=cv.getBoundingClientRect(); return {x:(ev.clientX-r.left)*cv.width/r.width, y:(ev.clientY-r.top)*cv.height/r.height}; };
  const laneAt=(g,y)=>n.ly+Math.floor((y-g.AX)/g.rh);
  cv.addEventListener('pointerdown',ev=>{
    ev.stopPropagation(); cv.setPointerCapture(ev.pointerId); cv.focus({preventScroll:true});
    const g=tlGeo(n,cv), q=pos(ev); if(!n.tl || !n.tl.ok) return;
    if(n.p.follow) setMod(n,'follow',false);
    if(q.y<g.AX && q.x>=g.LAB){                                   // метка на линейке: клик — туда, перетаскивание — сдвиг
      const mk=tlMarkAt(n,g,q.x);
      if(mk){ n.msel=mk.ext ? null : mk.m; n.ph=mk.m.t; n.pprev=n.ph; drag={kind:'mark',m:mk.m,ext:mk.ext,x:q.x,moved:false}; redraw(n); return; }
    }
    if(n.p.edit && q.x>=g.LAB && q.y>=g.AX && !ev.shiftKey){      // правка: клип под курсором
      const h=tlHitRaw(n,g,q.x,q.y);
      if(h && h.e){
        const T=n.tl, rk=tlEk(T,h.e), x0=tlX(n,g,h.e.t0), x1=tlX(n,g,h.e.t1), w=x1-x0;
        const kind=w>=12 ? (q.x-x0<=5 ? 'rl' : x1-q.x<=5 ? 'rr' : 'move') : 'move';
        n.msel=null;
        if(ev.ctrlKey || ev.metaKey){ if(n.sel.has(rk)) n.sel.delete(rk); else n.sel.add(rk); n.pick={lane:T.lanes[h.li].name,rk}; redraw(n); return; }
        if(!n.sel.has(rk)){ n.sel.clear(); n.sel.add(rk); }
        n.pick={lane:T.lanes[h.li].name,rk};
        drag=n.drag={kind,edit:true,x:q.x,y:q.y,t:tlT(n,g,q.x),li0:h.li,moved:false,items:tlSelItems(n),prim:{e:h.e,rk},
          dup:ev.altKey && kind==='move',dt:0,dl:0,snapped:null,snap:null};
        cv.style.cursor=kind==='move' ? 'grabbing' : 'ew-resize'; redraw(n); return;
      }
    }
    const kind=q.x<g.LAB ? 'label' : q.y<g.AX ? 'seek' : ev.shiftKey ? 'range' : 'pan';
    drag={kind,x:q.x,y:q.y,v0:n.v0,v1:n.v1,t:tlT(n,g,q.x),moved:false};
    if(kind==='seek'){ n.ph=drag.t; n.pprev=n.ph; redraw(n); }
    if(kind==='pan') cv.style.cursor='grabbing';
  });
  cv.addEventListener('pointermove',ev=>{
    const g=tlGeo(n,cv), q=pos(ev);
    if(!drag){
      if(n.p.edit && n.tl && n.tl.ok && q.x>=g.LAB && q.y>=g.AX){                  // подсказка курсором: край — ↔, клип — рука
        const h=tlHitRaw(n,g,q.x,q.y); let c='';
        if(h && h.e){ const x0=tlX(n,g,h.e.t0), x1=tlX(n,g,h.e.t1); c=x1-x0>=12 && (q.x-x0<=5 || x1-q.x<=5) ? 'ew-resize' : 'grab'; }
        if(cv.style.cursor!==c) cv.style.cursor=c;
      }
      return;
    }
    const dx=q.x-drag.x;
    if(Math.abs(dx)+Math.abs(q.y-drag.y)>3) drag.moved=true;
    if(drag.kind==='mark'){
      if(drag.moved && !drag.ext){ drag.m.t=Math.max(0,tlT(n,g,q.x)); n.ph=drag.m.t; n.pprev=n.ph; n.marks.sort((a,b)=>a.t-b.t); }
    } else if(drag.edit){
      if(!drag.moved) return;
      const pe=drag.prim.e;
      if(drag.snap===null){                                         // список притяжения строится один раз за перетаскивание
        const skip=new Set(drag.items.map(i=>i.rk));
        drag.snap=n.p.snap ? tlSnapList(n,g,skip) : [];
      }
      let dt=tlT(n,g,q.x)-drag.t, sn=null;
      const tol=6/g.pw*(n.v1-n.v0), sl=ev.shiftKey ? [] : drag.snap;               // Shift при перетаскивании — без притяжения
      if(sl.length){
        if(drag.kind==='move'){
          const a=tlSnap(pe.t0+dt,sl,tol), b=tlSnap(pe.t1+dt,sl,tol), ca=a!==pe.t0+dt, cb=b!==pe.t1+dt;
          if(ca && (!cb || Math.abs(a-pe.t0-dt)<=Math.abs(b-pe.t1-dt))){ dt=a-pe.t0; sn=a; }
          else if(cb){ dt=b-pe.t1; sn=b; }
        } else{
          const base=drag.kind==='rl' ? pe.t0 : pe.t1, a=tlSnap(base+dt,sl,tol);
          if(a!==base+dt){ dt=a-base; sn=a; }
        }
      }
      drag.dt=dt; drag.snapped=sn;
      drag.dl=drag.kind==='move' ? clamp(laneAt(g,q.y),0,n.tl.lanes.length-1)-drag.li0 : 0;
      n.drag=drag;
    } else if(drag.kind==='pan'){ const dt=dx/g.pw*(drag.v1-drag.v0); n.v0=drag.v0-dt; n.v1=drag.v1-dt; }
    else if(drag.kind==='seek'){ n.ph=Math.max(0,tlT(n,g,q.x)); n.pprev=n.ph; }
    else if(drag.kind==='range' && drag.moved){ const t=tlT(n,g,q.x); n.range={a:Math.min(drag.t,t),b:Math.max(drag.t,t)}; }
    redraw(n);
  });
  const end=ev=>{
    if(!drag) return; const d=drag; drag=null; n.drag=null; cv.style.cursor='';
    if(d.kind==='mark'){ if(d.moved && !d.ext) tlMarkSave(n); n._mk=null; redraw(n); return; }
    if(d.edit){
      if(d.moved && (d.dt || d.dl)) tlDragCommit(n,d);
      else{ d.moved=false; if(n.sel.size>1 && !ev.ctrlKey){ n.sel.clear(); n.sel.add(d.prim.rk); } }   // клик без движения по группе — только он
      redraw(n); return;
    }
    if(d.moved) { n._ck=''; return; }
    const g=tlGeo(n,cv), q=pos(ev);
    if(d.kind==='label'){                                         // клик по имени — только эта дорожка в измерениях и выходах
      const l=n.tl.lanes[laneAt(g,q.y)];
      n.solo=l && n.solo!==l.name ? l.name : null; n._ck='';
    } else if(d.kind==='pan'){
      const h=tlHit(n,g,q.x,q.y);
      n.pick=h && h.e ? {lane:n.tl.lanes[h.li].name,rk:tlEk(n.tl,h.e)} : null;
      if(n.p.edit){ n.sel.clear(); if(n.pick) n.sel.add(n.pick.rk); }
      n.msel=null;
      if(n.range && !n.pick) n.range=null;
      n._ck='';
    }
    redraw(n);
  };
  cv.addEventListener('pointerup',end); cv.addEventListener('pointercancel',()=>{ drag=null; n.drag=null; cv.style.cursor=''; redraw(n); });
  cv.addEventListener('dblclick',ev=>{
    ev.stopPropagation(); if(!n.tl || !n.tl.ok) return;
    const g=tlGeo(n,cv), q=pos(ev);
    if(q.y<g.AX && q.x>=g.LAB){                                   // двойной клик по метке — переименовать
      const mk=tlMarkAt(n,g,q.x);
      if(mk && !mk.ext){ const s=prompt('Marker label',mk.m.label); if(s!==null){ mk.m.label=s; tlMarkSave(n); n._mk=null; redraw(n); } }
      return;
    }
    const h=tlHit(n,g,q.x,q.y);
    if(h && h.e){ n.ph=h.e.t0; n.pprev=n.ph-1e-9; n.playing=true; }   // двойной клик по событию — играть с него
    else if(n.p.edit && h && n.tl.lanes[h.li] && q.x>=g.LAB){        // по пустому месту дорожки — новый клип
      let t=Math.max(0,tlT(n,g,q.x));
      if(n.p.snap && !ev.shiftKey){ const sl=tlSnapList(n,g,new Set()); t=tlSnap(t,sl,6/g.pw*(n.v1-n.v0)); }
      tlOpAdd(n,t,h.li);
    }
    else{ n.range=null; n.pick=null; n._ck=''; tlFit(n); }
    redraw(n);
  });
  cv.addEventListener('wheel',ev=>{
    ev.preventDefault(); ev.stopPropagation();
    const now=performance.now(); if(n._wt && now-n._wt<40) return; n._wt=now;
    if(!n.tl || !n.tl.ok) return;
    const g=tlGeo(n,cv), dy=ev.deltaY||ev.deltaX; if(!dy) return;
    if(ev.shiftKey){ n.ly+=dy>0 ? 1 : -1; redraw(n); return; }
    if(n.p.follow) setMod(n,'follow',false);
    const f=dy<0 ? 1/1.25 : 1.25, q=pos(ev), tc=tlT(n,g,q.x), span=Math.min(Math.max((n.v1-n.v0)*f,1e-6),Math.max(n.tl.tmax*20,1));
    const k=(tc-n.v0)/(n.v1-n.v0); n.v0=tc-k*span; n.v1=n.v0+span; redraw(n);
  },{passive:false});
  // клавиши (холст в фокусе): Delete, Ctrl+Z / Y, Ctrl+D, Ctrl+A, стрелки, M, пробел, Esc
  cv.addEventListener('keydown',ev=>{
    const T=n.tl; if(!T || !T.ok) return;
    const k=ev.key.toLowerCase(), ctrl=ev.ctrlKey || ev.metaKey; let used=true;
    if(k==='delete' || k==='backspace'){ if(n.msel) tlMarkDel(n); else if(n.p.edit) tlOpDelete(n); else used=false; }
    else if(ctrl && k==='z'){ if(ev.shiftKey) tlUndo(n,1); else tlUndo(n,-1); }
    else if(ctrl && k==='y') tlUndo(n,1);
    else if(ctrl && k==='d' && n.p.edit) tlOpDupHere(n);
    else if(ctrl && k==='a' && n.p.edit){ n.sel=new Set(tlScope(n).flatMap(({l})=>l.ev.map(e=>tlEk(T,e)))); redraw(n); }
    else if((k==='arrowleft' || k==='arrowright') && n.p.edit && n.sel.size){
      const g=tlGeo(n,cv), dt=(k==='arrowleft' ? -1 : 1)*(ev.shiftKey ? 10 : 1)*(n.v1-n.v0)/g.pw;
      tlDragCommit(n,{kind:'move',items:tlSelItems(n),dt,dl:0,dup:false});
    }
    else if(k==='m' && !ctrl) tlMarkAdd(n,n.ph!=null ? n.ph : (n.v0+n.v1)/2);
    else if(k===' '){ n.playing=!n.playing; if(n.playing && n.ph==null) n.ph=n.range ? n.range.a : 0; if(n.playing) n.pprev=n.ph-1e-9; else tlStopAudio(n); redraw(n); }
    else if(k==='escape'){ n.sel.clear(); n.msel=null; n.pick=null; redraw(n); }
    else used=false;
    if(used){ ev.preventDefault(); ev.stopPropagation(); }
  });
}

/* ---------- узел ---------- */
def({ id:'timeline', lazy:'manual', title:'Timeline', cat:'Analysis',
  kw:'timeline intervals period duration duty cycle jitter airtime transmissions packets subscribers rssi lanes tracks clips arrange schedule replay playback files table rows repeat beacon lag delay gantt edit drag move resize mix audio iq markers annotations export png live gate effects',
  ins:[{n:'rows',t:'bands'},{n:'filter',t:'txt'},{n:'at',t:'num'},{n:'rec',t:'rec'},{n:'gate',t:'sig'},{n:'marks',t:'bands'}],
  outs:[{n:'rows',t:'bands'},{n:'stats',t:'bands'},{n:'rec',t:'rec'},{n:'file',t:'txt'},{n:'on',t:'num'},{n:'t',t:'num'},
        {n:'count',t:'num'},{n:'period',t:'num'},{n:'dur',t:'num'},{n:'duty',t:'num'},{n:'hit',t:'num'},
        {n:'edited',t:'bands'},{n:'diff',t:'bands'},{n:'marks',t:'bands'},{n:'mark',t:'rec'},{n:'audio',t:'sig'},{n:'iq',t:'iq'}],
  view:{h:240}, resize:true, readout:true, w:560,
  params:[
    {n:'by',t:'text',d:'',label:'lanes by column(s)',tip:'one lane per distinct value: freq, src, kind… several columns separated by commas make a combined lane (freq,src). Empty — the first of track / lane / freq / chan / src / kind; «none» — one lane'},
    {n:'color',t:'text',d:'',label:'colour by column',tip:'packet kind, subscriber… ; empty — by lane'},
    {n:'filter',t:'text',d:'',label:'filter',tip:'terms separated by space: kind=req,ack  src=A*  rssi>-70  freq!=433.92  name~regex  word (in any column). All terms must match. The filter input adds to it'},
    {n:'gap',t:'num',min:0,d:0,label:'merge packets closer than, ms',tip:'packets of one lane that follow with a gap up to this are merged into one transmission: the period, duration and duty are measured on transmissions'},
    {n:'link',t:'text',d:'',label:'link by column(s)',tip:'select an event: all events with the same value of this column (a subscriber, an address) are outlined on every lane'},
    {n:'ref',t:'text',d:'',label:'reference events (lag)',tip:'a filter, e.g. kind=req: for every other lane the stats get lag — the time from a reference event to the next event of the lane (a reply to a request), its spread and count'},
    {n:'lagmax',t:'num',min:0,d:1000,label:'max lag, ms',adv:true},
    {n:'tol',t:'range',min:1,max:50,step:1,d:10,label:'period tolerance, %',tip:'an interval counts as a repeat when it is a whole multiple of the period within this tolerance (stats: ok = share of such intervals, miss = skipped repeats)'},
    {n:'rssiH',t:'check',d:false,label:'bar height = rssi',tip:'a stronger packet draws a taller bar (needs an rssi / level / power column)'},
    {n:'follow',t:'check',d:false,label:'follow the end',tip:'keep the right edge of the view on the newest event (a Table collecting live packets); any drag or zoom stops it'},
    {n:'win',t:'num',min:0,d:0,label:'follow window, s (0 — keep the current zoom)',adv:true},
    {n:'lh',t:'range',min:12,max:60,step:1,d:22,label:'lane height',adv:true},
    {n:'tcol',t:'text',d:'',label:'time column (auto)',tip:'t, time, ts, timestamp, start …',adv:true},
    {n:'dcol',t:'text',d:'',label:'duration column (auto)',tip:'dur, duration, len, airtime … ; without it the end column (end / t1 / stop) is used, else the event is a point',adv:true},
    {n:'unit',t:'select',opts:['auto','s','ms','us'],d:'auto',label:'time unit of t and dur',tip:'auto: epoch milliseconds / microseconds are recognised by size, small numbers are seconds',adv:true},
    {n:'rssi',t:'text',d:'',label:'rssi column (auto)',adv:true},
    {n:'file',t:'text',d:'',label:'file column (auto)',tip:'file, fileId, clip, ref: a Files id or name to replay when the playhead reaches the event. Optional columns: off — start offset in the file, s; gain — dB; fadein / fadeout / fade — s',adv:true},
    {n:'edit',t:'check',d:false,label:'edit clips with the mouse',tip:'drag a clip — move (also to another lane), drag its edge — change the length, Alt+drag — copy, Ctrl+click — add to the selection, Delete — remove, double click on an empty spot of a lane — new clip, Ctrl+Z / Ctrl+Y — undo / redo, Ctrl+D — duplicate, arrows — nudge. The changes lie over the rows and go out of «edited» / «diff»; wire «edited» to a Table (rows in = sync, a key column id) to write them back'},
    {n:'snap',t:'check',d:true,label:'snap to the grid, other clips, markers and the playhead',tip:'Shift while dragging — without snapping',adv:true},
    {n:'newdur',t:'num',min:.001,d:1,label:'length of a new clip, s',adv:true},
    {n:'key',t:'text',d:'',label:'key column of the rows (auto: id / key / uid)',tip:'edits are matched to the rows of the Table by this column; without it by the row number. A new clip gets a unique value in it',adv:true},
    {n:'field',t:'button',label:'Set a column on the selected clips…',fn:n=>tlOpField(n),adv:true},
    {n:'addc',t:'button',label:'New clip at the playhead',fn:n=>tlOpAdd(n,n.ph!=null ? n.ph : n.v0!=null ? (n.v0+n.v1)/2 : 0,n.pick && n.tl && n.tl.ok ? Math.max(0,n.tl.lanes.findIndex(l=>l.name===n.pick.lane)) : 0),adv:true},
    {n:'undo',t:'button',label:'Undo edit (Ctrl+Z)',fn:n=>tlUndo(n,-1),adv:true},
    {n:'redo',t:'button',label:'Redo edit (Ctrl+Y)',fn:n=>tlUndo(n,1),adv:true},
    {n:'discard',t:'button',label:'Discard all edits',fn:n=>{ n.ed=tlEd0(); tlEdSave(n,true); n.sel.clear(); n.pick=null; redraw(n); },adv:true},
    {n:'addm',t:'button',label:'Add a marker at the playhead (M)',fn:n=>tlMarkAdd(n,n.ph!=null ? n.ph : n.v0!=null ? (n.v0+n.v1)/2 : 0),adv:true},
    {n:'clrm',t:'button',label:'Clear markers',fn:n=>{ n.marks=[]; n.msel=null; tlMarkSave(n); n._mk=null; redraw(n); },adv:true},
    {n:'edits',t:'text',d:'',hidden:true},
    {n:'mks',t:'text',d:'',hidden:true},
    {n:'play',t:'button',label:'Play / Pause',fn:n=>{ n.playing=!n.playing; if(n.playing && n.ph==null) n.ph=n.range ? n.range.a : 0; if(n.playing) n.pprev=n.ph-1e-9; else tlStopAudio(n); redraw(n); }},
    {n:'stop',t:'button',label:'Stop',fn:n=>{ n.playing=false; n.ph=null; tlStopAudio(n); redraw(n); }},
    {n:'speed',t:'range',min:.1,max:64,step:.1,d:1,log:true,label:'play speed'},
    {n:'loop',t:'check',d:false,label:'loop (within the selection, if there is one)'},
    {n:'audible',t:'check',d:false,label:'play audio files of events (directly, without the audio output)',tip:'at the start of an event whose file column points to an audio or video file in Files the file is played by the browser; to mix clips on lanes with effects and send them into the patch use «mix clips» instead',adv:true},
    {n:'mix',t:'check',d:false,label:'mix clips to the audio output',tip:'while the playhead moves, the audio / video files of the clips under it are mixed lane by lane (with off, gain, fadein, fadeout, fade of the row and the lane effects) into the mono «audio» output; at speed ≠ 1 the pitch follows the speed. Wire it to a Speaker, Recorder or any filter'},
    {n:'master',t:'range',min:-30,max:12,step:.5,d:0,label:'mix level, dB',adv:true},
    {n:'lanefx',t:'code',plain:true,d:'',label:'lane effects (lane: gain=-6 lp=3000 hp=200 echo=250,.4 mute solo)',tip:'one line per lane; the lane is a name with * (case is ignored), * — all lanes. gain in dB, lp / hp — low-pass / high-pass cut-off in Hz, echo=delay ms,feedback, mute, solo (the other lanes are silent)',adv:true},
    {n:'iqplay',t:'check',d:false,label:'replay IQ files of clips to the iq output',tip:'while the playhead moves, the IQ recording (cu8, cs8, cs16, cf32, SigMF, WAV IQ — from Files) of the first clip under it is sent to the «iq» output from the clip start (plus the off column, s) at the real sample rate × speed'},
    {n:'iqrate',t:'num',min:0,d:0,label:'sample rate of raw IQ files without a rate in the name, Hz',adv:true},
    {n:'trim',t:'check',d:true,label:'cut the file at the event length',adv:true},
    {n:'livemax',t:'num',min:100,d:20000,label:'live events kept (rec / gate inputs)',adv:true},
    {n:'gthr',t:'num',d:.5,label:'gate threshold',adv:true},
    {n:'glane',t:'text',d:'gate',label:'lane of gate events',adv:true},
    {n:'clrl',t:'button',label:'Clear live events',fn:n=>{ n.live=[]; n.liveRev=(n.liveRev|0)+1; n.cat=null; redraw(n); },adv:true},
    {n:'fit',t:'button',label:'Fit all',fn:n=>{ n.range=null; n.pick=null; n._ck=''; tlFit(n); }},
    {n:'clr',t:'button',label:'Clear selection',fn:n=>{ n.range=null; n.pick=null; n.solo=null; n.sel.clear(); n._ck=''; redraw(n); }},
    {n:'png',t:'button',label:'Export PNG',fn:n=>tlPng(n),adv:true},
    {n:'csv',t:'button',label:'Export rows with edits (CSV)',fn:n=>tlCsvOut(n),adv:true}],
  init:n=>{ n.tl=null; n.tk=''; n.lastRows=null; n.lastLen=-1; n.lastT=0; n.lastF=null; n.v0=null; n.v1=null; n.ly=0;
    n.range=null; n.pick=null; n.solo=null; n.ph=null; n.pprev=null; n.playing=false; n.stats=[]; n.outRows=null; n.sum=null; n._ck=''; n.cmap=null;
    n.ed=tlEdParse(n.p.edits); n._edSaved=n.p.edits||''; n.eh=[n._edSaved]; n.ei=0; n.edRev=0; n.edBuilt=-1; n.sel=new Set(); n.drag=null;
    n.marks=tlMarksParse(n.p.mks); n._mSaved=n.p.mks||''; n.msel=null; n.xm=[]; n.lastMk=null; n._mk=null;
    n.live=[]; n.liveRev=0; n.gst={}; n.lastRec=null; n.ast=new Map(); n.fxm=new Map(); n.fxs=new Map(); n._fxk=''; n.eff=null; n.keys=null; n.kc=null;
    n.lastSrc=null; n.lastSrcLen=-1; n.diff=null; n.diffRev=-1; n.mkOut=null; },
  dispose:n=>{ tlStopAudio(n); n.ast=null; },
  process(n,I){
    const p=n.p, now=performance.now(), ext=typeof I.filter==='string' ? I.filter : '';
    if((p.edits||'')!==n._edSaved){ n.ed=tlEdParse(p.edits); n._edSaved=p.edits||''; n.edRev++; }                       // undo / загрузка патча
    if((p.mks||'')!==n._mSaved){ n.marks=tlMarksParse(p.mks); n._mSaved=p.mks||''; n.msel=null; }
    tlLiveIn(n,I);
    const src=tlSrc(n,Array.isArray(I.rows) ? I.rows : null);
    const none={rows:null,stats:null,count:0,on:0,edited:null,diff:null,audio:null,iq:null};
    if(!src || !src.length){ if(n.tl){ n.tl=null; n._ck=''; n.eff=null; redraw(n); } return none; }
    // правки поверх строк: набор пересчитывается, только когда изменился источник или сами правки
    if(src!==n.lastSrc || src.length!==n.lastSrcLen || n.edBuilt!==n.edRev){
      const srcNew=src!==n.lastSrc || src.length!==n.lastSrcLen;
      n.lastSrc=src; n.lastSrcLen=src.length; n.edBuilt=n.edRev;
      n.kc=tlKeyCol(src,p.key);
      if(srcNew && tlEdSize(n.ed) && tlReconcile(src,n.ed,n.kc)){ tlEdSave(n,false); n.edBuilt=n.edRev; }   // Table приняла правки — наложение снимается
      n.eff=tlEdSize(n.ed) ? tlApply(src,n.ed,n.kc) : {rows:src,keys:null};
      n.keys=n.eff.keys; n.diff=null;
    }
    const rows=n.eff.rows, key=tlKey(n);
    if(!n.drag && (rows!==n.lastRows || rows.length!==n.lastLen || key!==n.tk || ext!==n.lastF || now-n.lastT>2000)){
      const grown=rows.length>n.lastLen;
      n.lastRows=rows; n.lastLen=rows.length; n.lastT=now; n.tk=key; n.lastF=ext;
      n.tl=tlBuild(n,rows,ext); n._ck=''; n._mk=null;
      if(n.tl.ok && grown && p.follow){ const w=+p.win>0 ? +p.win : n.v1!=null ? n.v1-n.v0 : n.tl.tmax; n.v1=n.tl.tmax+w*.02; n.v0=n.v1-w; }
      redraw(n);
    }
    const T=n.tl;
    if(!T || !T.ok) return none;
    if(I.marks!==n.lastMk || n._mk!==T.gen){ n.lastMk=I.marks; n._mk=T.gen; tlXMarks(n,Array.isArray(I.marks) ? I.marks : null); }
    tlCompute(n);
    // дорожки: эффекты (lanefx) пересчитываются при смене текста или набора дорожек
    const fk=T.gen+'|'+p.lanefx;
    if(fk!==n._fxk){ n._fxk=fk; n.fxm=tlFxLane(tlFxParse(p.lanefx),T.lanes.map(l=>l.name)); }
    if(p.mix || p.iqplay) tlWarm(n);
    // воспроизведение
    let recs=null, file=null, adv=null, mk=null;
    const at=typeof I.at==='number' && isFinite(I.at) ? I.at : null;
    if(at!==null){ n.ph=Math.max(0,at); }
    else if(n.playing){
      const dt=BLOCK/Eng.sr*(+p.speed||1), lo=n.range ? n.range.a : 0, hi=n.range ? n.range.b : T.tmax;
      let a=n.pprev==null ? (n.ph ?? 0) : n.pprev, b=(n.ph ?? 0)+dt;
      if(b>hi){ if(p.loop){ b=lo; a=lo-1e-9; } else{ b=hi; n.playing=false; } }
      n.ph=b; n.pprev=b; n._cr=[a,b]; adv=n._cr;
    }
    if(n.ph!=null){
      const cr=at!==null ? [n.pprev ?? n.ph, n.ph] : n._cr;
      if(cr && cr[1]>cr[0]){
        const hit=[]; for(const {l,tx} of tlScope({tl:T,solo:n.solo,range:null})) for(const e of tlCrossed(tx,cr[0],cr[1])) hit.push(e);
        if(hit.length){ hit.sort((x,y)=>x.t0-y.t0); recs=hit.map(e=>Object.assign({},e.row,{_t:TL_RND(e.t0),_dur:TL_RND(e.t1-e.t0)}));
          const fc=T.m.cols.file; if(fc){ for(const e of hit){ const f=e.row[fc]; if(f!=null && f!==''){ file=String(f); if(p.audible && !p.mix) tlPlayFile(n,e.row,e.t1-e.t0); } } } }
        const ms=[...n.marks,...n.xm].filter(m=>m.t>cr[0] && m.t<=cr[1]);                                   // метки, которые проехал плейхед
        if(ms.length) mk=ms.map(m=>({label:m.label,_t:TL_RND(m.t)}));
      }
      n._cr=null; n.pprev=n.ph;
      if(n.playing || at!==null) redraw(n);
    }
    let on=0;
    if(n.ph!=null) for(const l of T.lanes) on+=tlActive(l.tx,n.ph).length;
    const s=n.sum;
    if(n.diffRev!==n.edRev || !n.diff){ n.diff=tlEdSize(n.ed) ? tlDiffRows(n,src) : []; n.diffRev=n.edRev; }
    if(!n.mkOut || n.mkOutN!==n.marks.length+':'+n._mSaved){
      n.mkOutN=n.marks.length+':'+n._mSaved;
      const rel=T.m.origin;
      n.mkOut=n.marks.map(m=>({label:m.label,t:TL_RND(m.t),abs:TL_RND(rel+m.t)}));
    }
    return {rows:n.outRows, stats:n.stats, rec:recs, file, on, t:n.ph==null ? 0 : n.ph,
      count:s ? s.n : 0, period:s && s.period || 0, dur:s && s.dur || 0, duty:s && s.duty || 0, hit:recs ? 1 : 0,
      edited:n.eff.rows, diff:n.diff, marks:n.mkOut, mark:mk,
      audio:p.mix ? tlMixBlock(n,T,adv) : null, iq:p.iqplay ? tlIqBlock(n,T,adv) : null};
  },
  draw(n,cv,cx){
    tlDraw(n,cv,cx);
    const el=n.el.querySelector('.readout'); if(!el) return;
    el.style.whiteSpace='pre-wrap';
    const T=n.tl; let s;
    if(!T) s=n.live.length ? 'no events yet' : 'no rows';
    else if(!T.ok) s=T.err;
    else{
      tlCompute(n);
      const m=T.m, u=n.sum, ln=[];
      ln.push(T.ev.length+' events · '+T.lanes.length+' lanes by '+(T.by||'—')+' · '+tlDur(T.tmax)+(T.m.unit!=='s' ? ' ('+m.unit+')' : '')
        +(n.solo!=null ? ' · lane «'+n.solo+'»' : '')+(n.range ? ' · selection '+tlDur(n.range.b-n.range.a) : ''));
      const ed=tlEdSize(n.ed), extra=[];
      if(n.p.edit) extra.push('edit: '+(n.sel.size ? n.sel.size+' selected' : 'drag a clip, its edge, double click an empty spot'));
      if(ed) extra.push(ed+' edit'+(ed===1 ? '' : 's')+' pending'+(n.kc ? '' : ' (no key column: matched by row number)'));
      if(n.live.length) extra.push(n.live.length+' live');
      if(n.marks.length || n.xm.length) extra.push((n.marks.length+n.xm.length)+' markers');
      if(extra.length) ln.push(extra.join(' · '));
      if(n.p.mix || n.p.iqplay){
        const as=[...n.ast.values()], ok=as.filter(a=>a.st==='ready').length, bad=as.filter(a=>a.st==='err');
        ln.push((n.p.mix ? 'mix' : '')+(n.p.mix && n.p.iqplay ? ' + ' : '')+(n.p.iqplay ? 'IQ' : '')+': '+ok+'/'+as.length+' files ready'+(bad.length ? ' · '+bad[0].msg : ''));
      }
      const pc=v=>v==null ? '—' : Math.round(v*1000)/10+'%', one=x=>tlDur(x.period)+(x.jitter!=null ? ' ±'+pc(x.jitter) : '')+' · dur '+tlDur(x.dur)+' · duty '+pc(x.duty)
        +(x.ok!=null ? ' · ok '+pc(x.ok)+(x.miss ? ' (skipped '+x.miss+')' : '') : '')+(x.rssi!=null ? ' · '+Math.round(x.rssi)+' dBm' : '');
      if(n.sumLanes>1 && n.stats.length>1){
        for(const x of n.stats.slice(0,4)) ln.push('«'+x.lane+'» '+x.n+' tx · period '+one(x));
        if(n.stats.length>4) ln.push('… +'+(n.stats.length-4)+' lanes (stats output)');
      } else if(u && u.n)
        ln.push('tx '+u.n+(T.gap ? ' (merged ≤ '+n.p.gap+' ms)' : '')+' · period '+one(u));
      const pk=tlPick(n);
      if(pk){
        const e=pk.e, i=pk.l.tx.indexOf(e), prev=i>0 ? pk.l.tx[i-1] : null;
        ln.push('«'+pk.l.name+'» @'+tlDur(e.t0)+' · dur '+tlDur(e.t1-e.t0)+(e.n>1 ? ' · '+e.n+' packets' : '')
          +(prev ? ' · from the previous start '+tlDur(e.t0-prev.t0)+', pause '+tlDur(e.t0-prev.t1) : '')
          +'\n'+Object.entries(e.row).filter(([k,v])=>v!=='' && v!=null).slice(0,10).map(([k,v])=>k+'='+(typeof v==='object' ? JSON.stringify(v) : v)).join(' '));
      } else if(n.sum && n.stats && n.stats.length>1 && n.stats.some(x=>x.lag!=null))
        ln.push('lag from «'+n.p.ref+'»: '+n.stats.filter(x=>x.lag!=null).slice(0,4).map(x=>x.lane+' '+tlDur(x.lag)+(x.lag_std!=null ? ' ±'+tlDur(x.lag_std) : '')).join(' · '));
      if(n.p.ref && !T.refEv.length) ln.push('no reference events match «'+n.p.ref+'»');
      s=ln.join('\n');
    }
    if(el.textContent!==s) el.textContent=s;
  }});
