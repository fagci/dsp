"use strict";
/* ============================ IQ в файлах (Files) ============================
   Записи IQ лежат в хранилище Files (папка IQ): WAV или SigMF с метаданными — meta.iq (частота, частота дискретизации, длина,
   сегменты), meta.tags (теги), meta.note (заметка). Менеджер показывает длину, размер на диске и частоту; теги правятся в превью.
   Узлы: IQ Recorder (запись потока целиком, канала или только кусков с голосом DMR — в один файл) и IQ File Player
   (воспроизведение из Files потоком iq). USB SDR пишет сюда же (recDest) и открывает файлы из Files. Чистая логика — в iqfiles-kernels.js. */

const IQF_FOLDER='IQ';
const IQF_MIME={wav:'application/x-iq-wav', sigmf:'application/x-tar'};

// папка по пути «IQ/DMR» в корне Files; нет — создаётся
async function iqfFolder(path){
  let id=null;
  for(const nm of String(path||IQF_FOLDER).split('/').map(x=>x.trim()).filter(Boolean)){
    const have=(await FileStore.listFolders('files',id)).find(x=>x.name===nm);
    id=have ? have.id : await FileStore.addFolder('files',nm,id);
  }
  return id;
}
// запись в Files; meta — из iqfMeta
async function iqfStore(blob, name, meta, path){
  const q=await FileStore.quota();
  if(q && blob.size>q.free) throw new Error('not enough space: needs '+iqfBytes(blob.size)+', free '+iqfBytes(q.free));
  const id=await FileStore.put({space:'files', folderId:await iqfFolder(path), name, mime:IQF_MIME[meta.iq.kind]||'application/octet-stream', blob, meta});
  try{ navigator.storage?.persist?.(); }catch(e){}           // браузер не вытеснит хранилище
  return id;
}
// запись → Blob (WAV 16 бит: заголовок + данные + auxi; SigMF — tar из .sigmf-data и .sigmf-meta)
// r: {kind, rate, freq, bw, start, stop, parts, n, segs:[{start,t,label,freq}], tags, hw}
function iqfBuild(r){
  const bytes=r.n*4, data=r.parts.map(p=>new Uint8Array(p.buffer, p.byteOffset, p.byteLength));
  if(r.kind==='wav') return new Blob([iqWavHeader({rate:r.rate, bytes}), ...data, iqWavAuxi({rate:r.rate, freq:r.freq, start:r.start, stop:r.stop})], {type:IQF_MIME.wav});
  const base=r.name.replace(/\.sigmf$/,''), pad=n=>(512-n%512)%512;
  const anns=r.segs.map((s,i)=>{
    const len=(i+1<r.segs.length ? r.segs[i+1].start : r.n)-s.start, f=s.freq??r.freq;
    return {'core:sample_start':s.start, 'core:sample_count':len, 'core:label':s.label||('segment '+(i+1)),
      ...(r.bw ? {'core:freq_lower_edge':f-r.bw/2, 'core:freq_upper_edge':f+r.bw/2} : null)};
  });
  const meta=new TextEncoder().encode(iqSigmfMeta({fmt:'s16', rate:r.rate, hw:r.hw||'', tag:(r.tags||[]).join(', '),
    captures:r.segs.map(s=>({start:s.start, freq:s.freq??r.freq, datetime:new Date(s.t).toISOString()})), anns}));
  const tail=new Uint8Array(pad(bytes)+512+meta.length+pad(meta.length)+1024);
  tail.set(iqTarHeader(`${base}/${base}.sigmf-meta`, meta.length, r.stop.getTime()), pad(bytes));
  tail.set(meta, pad(bytes)+512);
  return new Blob([iqTarHeader(`${base}/${base}.sigmf-data`, bytes, r.start.getTime()), ...data, tail], {type:IQF_MIME.sigmf});
}
function iqfDownload(blob, name){
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name;
  document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href), 60000);
}

/* ---- список и выбор ---- */
const IQF_EXT=/\.(sigmf|cu8|cs8|ci8|cs16|ci16|cf32|cfile|fc32|cf64|iq|raw)$/i;
async function iqfList(all){
  const a=await FileStore.listAll('files');
  return a.filter(r=>r.meta?.iq || (all ? /\.(wav|bin|dat)$/i.test(r.name) : IQF_EXT.test(r.name))).sort((x,y)=>(y.modified||0)-(x.modified||0));
}
const iqfLine=r=>r.meta?.iq ? [iqfDur(r.meta.iq.seconds), iqfSub(r)].filter(Boolean).join(' · ') : iqfBytes(r.size||0);
// окно выбора записи: Promise<запись|null>
function iqfPick(title){
  return new Promise(async res=>{
    const ov=document.createElement('div'); ov.className='fm-ov';
    const box=document.createElement('div'); box.className='fm-pick'; box.style.minWidth='min(560px,92vw)';
    const h=document.createElement('b'); h.textContent=title||'IQ files'; box.append(h);
    const q=document.createElement('input'); q.type='search'; q.placeholder='search by name or tag…'; q.className='fm-q';
    const sw=document.createElement('label'); const ck=document.createElement('input'); ck.type='checkbox'; sw.append(ck,' show every WAV / bin file');
    sw.style.cssText='font-size:11px;color:var(--dim)';
    const list=document.createElement('div'); list.style.cssText='display:flex;flex-direction:column;gap:3px;overflow:auto';
    const done=v=>{ ov.remove(); res(v); };
    let all=[];
    const draw=()=>{
      const f=q.value.trim().toLowerCase();
      list.textContent='';
      const rows=all.filter(r=>!f || (r.name+' '+(r.meta?.tags||[]).join(' ')+' '+(r.meta?.note||'')).toLowerCase().includes(f));
      for(const r of rows){
        const b=document.createElement('button'), t=document.createElement('div'), s=document.createElement('div');
        t.textContent=r.name; s.textContent=iqfLine(r); s.style.cssText='font-size:10px;color:var(--dim)';
        b.append(t,s); b.onclick=()=>done(r); list.append(b);
      }
      if(!rows.length){ const e=document.createElement('div'); e.textContent=all.length ? 'nothing found' : 'no IQ recordings in Files yet'; e.style.color='var(--dim)'; list.append(e); }
    };
    const load=async()=>{ all=await iqfList(ck.checked); draw(); };
    q.oninput=draw; ck.onchange=load;
    const c=document.createElement('button'); c.textContent='Cancel'; c.onclick=()=>done(null);
    ov.onclick=e=>{ if(e.target===ov) done(null); };
    box.append(q,sw,list,c); ov.append(box); document.body.append(ov);
    await load(); q.focus();
  });
}
// запись из Files → File для iqParseFiles
const iqfAsFile=r=>new File([r.blob], r.name, {type:r.mime||''});

/* ---- менеджер файлов: превью с тегами и заметкой ---- */
function iqfPreview(rec, box){
  const q=rec.meta.iq, wrap=document.createElement('div');
  wrap.style.cssText='display:flex;flex-direction:column;gap:3px;width:100%';
  const info=document.createElement('div');
  info.textContent=['length '+iqfDur(q.seconds), 'on disk '+iqfBytes(rec.size||0), iqfFreq(q.freq)+(q.bw ? ' · bw '+iqfFreq(q.bw) : ''),
    iqfRate(q.rate)+' · '+q.dtype+' · '+String(q.kind).toUpperCase(), q.segments?.length>1 ? q.segments.length+' segments' : '', q.src].filter(Boolean).join(' · ');
  const field=(ph,val,key,conv)=>{
    const i=document.createElement('input'); i.type='text'; i.placeholder=ph; i.value=val; i.style.cssText='width:100%;box-sizing:border-box;font:inherit';
    i.onchange=async()=>{ const v=conv(i.value); rec.meta={...rec.meta,[key]:v}; i.value=Array.isArray(v) ? v.join(', ') : v;
      try{ await FileStore.update(rec.id,{meta:rec.meta}); }catch(e){ alert('Could not save: '+e.message); } };
    return i;
  };
  wrap.append(info,
    field('tags, comma separated', (rec.meta.tags||[]).join(', '), 'tags', iqfTagList),
    field('note', rec.meta.note||'', 'note', v=>v.trim().slice(0,500)));
  box.append(wrap);
}

/* ---- узел IQ Recorder ---- */
function iqrVoiceLabel(r){
  return [r.from!=null ? r.from+'→'+(r.to??'?') : '', r.slot ? 'TS'+r.slot : ''].filter(Boolean).join(' ');
}
function iqrReset(n){ n.cut=iqfCutNew(); }
function iqrNew(n, s){
  const ch=n.p.band==='channel', bw=Math.max(1000, +n.p.chBw||12500);
  const r={kind:n.p.fmt==='SigMF' ? 'sigmf' : 'wav', inSr:s.sr, inFc:s.fc, start:new Date(), parts:[], n:0, segs:[], last:null,
    rate:s.sr, freq:s.fc, bw:null, ch:null, srcs:new Set(), voice:0};
  if(ch){
    const M=Math.max(1, Math.floor(s.sr/(bw*1.2)));
    r.M=M; r.rate=s.sr/M; r.bw=bw; r.chBwSet=bw;
  }
  return r;
}
// канал: сдвиг + децимация куска; для нового сегмента фильтры начинаются заново
function iqrChannel(n, r, s, p, fresh){
  if(fresh || !r.ch){
    const abs=typeof n.freqIn==='number' && isFinite(n.freqIn), off=abs ? n.freqIn-s.fc : (+n.p.chOff||0);
    const sh={p:{offset:off}}; IQK.iqShift.init(sh);
    const dc=r.M>1 ? {p:{M:String(r.M), cut:.4, tpp:'16'}} : null; if(dc) IQK.iqDecim.init(dc);
    r.ch={sh, dc, freq:s.fc+off};
  }
  const m=p.n, re=new Float32Array(m), im=new Float32Array(m);
  for(let i=0;i<m;i++){ re[i]=p.a[2*i]/32768; im[i]=p.a[2*i+1]/32768; }
  const tmp={sr:s.sr, fc:s.fc, chunks:[{re, im, t0:0, tag:null}], t:m};
  let o=IQK.iqShift.process(r.ch.sh,{in:tmp}).out;
  if(r.ch.dc) o=IQK.iqDecim.process(r.ch.dc,{in:o}).out;
  const parts=o.chunks.map(c=>iqfPack(c.re,c.im)), len=parts.reduce((a,b)=>a+b.length,0), data=new Int16Array(len);
  let k=0; for(const q of parts){ data.set(q,k); k+=q.length; }
  return data;
}
function iqrFeed(n, r, s, pieces){
  for(const p of pieces){
    const fresh=r.last==null || p.t0!==r.last;
    const data=r.M ? iqrChannel(n, r, s, p, fresh) : (p.a.byteLength===p.a.buffer.byteLength ? p.a : p.a.slice());
    if(iqfSegAdd(r, p, data)){
      const f=r.ch ? r.ch.freq : r.freq;
      r.segs[r.segs.length-1].freq=f;
      if(r.segs.length===1) r.freq=f;
    }
  }
}
async function iqrSave(n, r){
  r.stop=new Date();
  const own=iqfTagList(n.tagIn ?? n.p.tag), tags=iqfTagList([...own, ...r.autoTags]);
  r.tags=tags; r.hw='';
  const label=own[0] || (n.p.mode==='voice only' ? 'voice' : '');
  r.name=iqfFileName({kind:r.kind, label, freq:r.freq, start:r.start});
  const meta=iqfMeta({kind:r.kind, rate:r.rate, freq:r.freq, bw:r.bw, n:r.n, segs:r.segs, src:'IQ Recorder · '+n.p.mode, start:r.start, tags});
  const blob=iqfBuild(r);
  n.msg='saving '+r.name+'…';
  try{
    await iqfStore(blob, r.name, meta, n.p.folder);
    n.files=(n.files||0)+1; n.savedP=2;
    n.msg='saved '+r.name+' · '+iqfDur(meta.duration)+' · '+iqfBytes(blob.size)+' · '+iqfFreq(r.freq);
  }catch(e){
    n.msg='save failed: '+e.message+' — downloaded instead';
    iqfDownload(blob, r.name);
  }
}
// завершить запись: остаток кольца → файл; again — сразу начать следующую
async function iqrFinish(n, again){
  const r=n.rec; if(!r) return;
  const s={sr:r.inSr, fc:r.inFc};
  iqrFeed(n, r, s, iqfCutTake(n.cut, 0, true, r.inSr));
  n.rec=null; iqrReset(n);
  if(!again) n.armed=false;
  if(r.n>0) await iqrSave(n, r); else n.msg='nothing to save (no '+(n.p.mode==='voice only' ? 'voice' : 'signal')+' in the stream)';
}
def({ id:'iqRec', title:'IQ Recorder', cat:'Output', kw:'iq record save files voice dmr baseband sigmf wav channel band gate tag metadata archive',
  ins:[{n:'in',t:'iq'},{n:'voice',t:'rec'},{n:'go',t:'num'},{n:'freq',t:'num'},{n:'tag',t:'txt'}],
  outs:[{n:'sec',t:'num'},{n:'size',t:'num'},{n:'saved',t:'num'},{n:'files',t:'num'}],
  readout:true, tall:true, w:340,
  params:[
    {n:'start',t:'button',label:'● Record',fn:n=>{ n.armed=true; n.off=false; n.msg=''; }},
    {n:'stop',t:'button',label:'■ Stop and save',fn:n=>{ n.off=true; iqrFinish(n,false); }},
    {n:'mode',t:'select',opts:['everything','voice only','go input'],d:'everything',
      label:'what goes in: everything · voice only (parts of the stream marked by voice records of a decoder: DMR bursts, merged into one file) · go input above 0.5'},
    {n:'band',t:'select',opts:['whole input','channel'],d:'whole input',label:'whole input — the stream as it comes; channel — only one channel (shifted and decimated)'},
    {n:'chOff',t:'num',d:0,label:'channel: offset from the input centre, Hz (the freq input — absolute frequency — overrides it)'},
    {n:'chBw',t:'range',min:1000,max:1000000,step:500,log:true,d:25000,label:'channel: bandwidth, Hz'},
    {n:'fmt',t:'select',opts:['WAV','SigMF'],d:'WAV',label:'format (SigMF keeps voice segments as captures and annotations)'},
    {n:'tag',t:'text',d:'',label:'tags, comma separated (the first goes into the file name); the tag input overrides'},
    {n:'folder',t:'text',d:IQF_FOLDER,label:'folder in Files'},
    {n:'autostart',t:'check',d:false,label:'record as soon as the stream arrives'},
    {n:'padB',t:'range',min:0,max:1000,step:10,d:300,label:'voice: margin before, ms (the decoder needs the sync word and header before the voice to lock again when the file is played back)'},
    {n:'padA',t:'range',min:0,max:1000,step:10,d:100,label:'voice: margin after, ms'},
    {n:'split',t:'range',min:8,max:900,step:8,log:true,d:256,label:'start a new file after, MB (recordings are kept in memory until saved)'}],
  init:n=>{ n.cut=iqfCutNew(); n.rec=null; n.armed=false; n.off=false; n.msg=''; n.files=0; n.savedP=0; n.freqIn=null; n.tagIn=null; n.inSr=0; n.inFc=0; n.busy=false; },
  dispose:n=>{ if(n.rec) iqrFinish(n,false); },
  process(n,I){
    const s=iqIn(I,'in'), p=n.p;
    n.freqIn=typeof I.freq==='number' ? I.freq : null;
    n.tagIn=typeof I.tag==='string' && I.tag.trim() ? I.tag : null;
    if(s && s.sr){ n.inSr=s.sr; n.inFc=s.fc; }
    if(p.autostart && !n.off && !n.armed && s && s.sr) n.armed=true;
    let sec=0, size=0;
    if(s && s.sr && n.armed){
      if(n.rec && (n.rec.inSr!==s.sr || n.rec.inFc!==s.fc || !!n.rec.M!==(p.band==='channel') || n.rec.kind!==(p.fmt==='SigMF' ? 'sigmf' : 'wav'))){
        iqrFinish(n,true);                       // сменились частота потока, центр или режим — новый файл
      }
      if(!n.rec){ n.rec=iqrNew(n,s); n.rec.autoTags=[...(p.mode==='voice only' ? ['voice'] : []), ...(p.band==='channel' ? ['channel'] : [])]; }
      const r=n.rec, c=n.cut;
      for(const ch of s.chunks) iqfCutPush(c, ch.t0, ch.re, ch.im, Date.now());
      if(p.mode==='everything') iqfCutGate(c, true, '');
      else if(p.mode==='go input') iqfCutGate(c, typeof I.go==='number' && I.go>0.5, 'go');
      else{
        iqfCutGate(c, false);
        const tick=BLOCK/Eng.sr*1000+50;
        for(const v of recList(I.voice)){
          if(!v || typeof v!=='object') continue;
          const lab=iqrVoiceLabel(v);
          r.voice++; if(v.src) r.srcs.add(v.src);
          if(typeof v.st==='number' && v.ssr===s.sr && iqfCutHas(c, v.st, s.sr)) iqfCutMarkAt(c, v.st, s.sr, +p.padB, +p.padA, lab);
          else if(typeof v.t==='number') iqfCutMarkWall(c, v.t-(IQF_VOICE_MS+ +p.padB)-tick, v.t+ +p.padA, lab, s.sr);
        }
      }
      r.autoTags=[...new Set([...r.autoTags.filter(t=>t==='voice' || t==='channel'), ...r.srcs])];
      iqrFeed(n, r, s, iqfCutTake(c, Math.round(s.sr*1.5), false, s.sr));
      if(r.n*4>=(+p.split)*1e6) iqrFinish(n,true);
    }
    if(n.rec){ sec=n.rec.n/n.rec.rate; size=n.rec.n*4; }
    const saved=n.savedP>0 ? 1 : 0; if(n.savedP>0) n.savedP--;
    return {sec, size, saved, files:n.files};
  },
  draw(n){
    const el=n.el.querySelector('.readout'); if(!el) return;
    const r=n.rec, p=n.p;
    const head=r ? '● recording · '+p.mode+(p.band==='channel' ? ' · channel' : '') : n.armed ? '◌ armed, waiting for the stream' : '○ idle';
    const rate=r ? r.rate : n.inSr;
    const lines=[head+(rate ? ' · '+iqfRate(rate)+' @ '+iqfFreq(r ? r.freq : n.inFc) : '')];
    if(r) lines.push(iqfDur(r.n/r.rate)+' · '+iqfBytes(r.n*4)+' in memory · '+r.segs.length+' segment'+(r.segs.length===1 ? '' : 's')+(p.mode==='voice only' ? ' · '+r.voice+' voice packets' : ''));
    if(n.msg) lines.push(n.msg);
    if(!n.inSr && !r) lines.push('no input');
    el.textContent=lines.join('\n');
  }});

/* ---- узел IQ File Player ---- */
const IQP_BPS={cu8:2, ci8:2, ci16_le:4, cf32_le:8, cf64_le:16};
// сырые отсчёты → float32 (re, im)
function iqpDecode(buf, dtype){
  const view=dtype==='cu8' ? new Uint8Array(buf) : dtype==='ci8' ? new Int8Array(buf) : dtype==='ci16_le' ? new Int16Array(buf) : dtype==='cf32_le' ? new Float32Array(buf) : new Float64Array(buf);
  const m=view.length>>1, re=new Float32Array(m), im=new Float32Array(m);
  const k=dtype==='cu8' ? 1/127.5 : dtype==='ci8' ? 1/128 : dtype==='ci16_le' ? 1/32768 : 1, o=dtype==='cu8' ? 127.5 : 0;
  for(let i=0;i<m;i++){ re[i]=(view[2*i]-o)*k; im[i]=(view[2*i+1]-o)*k; }
  return [re, im];
}
async function iqpLoad(n, id){
  n.loadedId=id; n.src=null; n.cur=n.ahead=null; n.pos=0; n.msg='';
  try{
    const rec=await FileStore.get(id);
    if(!rec){ n.msg='file not found in Files'; return; }
    const src=await iqParseFiles([iqfAsFile(rec)], 'auto');
    if(!(src.rate>0)) throw new Error('the file has no sample rate');
    n.src=src; n.bps=IQP_BPS[src.dtype]; n.total=Math.floor(src.size/n.bps);
    n.caps=src.captures.map(c=>({start:c.start, freq:c.freq})).sort((a,b)=>a.start-b.start);
    n.rec=rec; n.name=rec.name; n.pos=0; n.acc=0; n.p.seek=n.appliedSeek=0;
    n.blk=Math.max(1<<14, Math.min(Math.round(src.rate/2), Math.floor((8<<20)/n.bps)));
    n.msg='';
  }catch(e){ n.msg='cannot open: '+e.message; n.src=null; }
}
// блок отсчётов [a, a+blk) читается упреждающе
function iqpBlock(n, a){
  const b=Math.min(n.total, a+n.blk), o={a, v:null};
  n.src.blob.slice(n.src.off+a*n.bps, n.src.off+b*n.bps).arrayBuffer()
    .then(buf=>{ const [re,im]=iqpDecode(buf, n.src.dtype); o.v={a, b, re, im}; }).catch(e=>{ n.msg='read error: '+e.message; });
  return o;
}
function iqpFreqAt(n, pos){
  let f=null; for(const c of n.caps){ if(c.start<=pos) f=c.freq; else break; }
  return f ?? n.caps[0]?.freq ?? 0;
}
def({ id:'iqPlay', title:'IQ File Player', cat:'Sources', kw:'iq play file files recording sigmf wav replay saved baseband stream source',
  ins:[{n:'pause',t:'num'}],
  outs:[{n:'iq',t:'iq'},{n:'fc',t:'num'},{n:'pos',t:'num'},{n:'sec',t:'num'},{n:'end',t:'num'}],
  readout:true, w:320,
  params:[
    {n:'pick',t:'button',label:'Choose from Files…',fn:async n=>{ const r=await iqfPick('Play IQ from Files'); if(r){ n.p.fileId=r.id; await iqpLoad(n, r.id); } }},
    {n:'fileId',t:'num',d:0,hidden:true},
    {n:'loop',t:'check',d:true,label:'loop'},
    {n:'paused',t:'check',d:false,label:'pause (the pause input pauses too)'},
    {n:'speed',t:'range',min:.25,max:16,step:.25,d:1,label:'speed (1 = real time; the decoder keeps up only at the rate it can process)'},
    {n:'seek',t:'range',min:0,max:100,step:.1,d:0,label:'position, %'}],
  init:n=>{ n.src=null; n.loadedId=0; n.loading=false; n.pos=0; n.acc=0; n.cur=null; n.ahead=null; n.msg=''; n.name=''; n.appliedSeek=0; n.endP=0; },
  process(n,I){
    const id=+n.p.fileId||0;
    if(id && id!==n.loadedId && !n.loading){ n.loading=true; iqpLoad(n,id).finally(()=>{ n.loading=false; }); }
    const src=n.src;
    if(!src) return {iq:null, fc:null, pos:0, sec:0, end:0};
    const sr=src.rate, s=iqStream(n,'iq',sr,iqpFreqAt(n,n.pos));
    if(n.p.seek!==n.appliedSeek){ n.appliedSeek=n.p.seek; n.pos=Math.max(0, Math.min(n.total-1, Math.floor(n.p.seek/100*n.total))); n.acc=0; n.cur=null; n.ahead=null; }
    const paused=n.p.paused || (typeof I.pause==='number' && I.pause>0.5);
    let want=paused ? 0 : (n.acc+=sr*(+n.p.speed||1)*BLOCK/Eng.sr, Math.floor(n.acc));
    n.acc-=want;
    let ended=0;
    while(want>0){
      if(!(n.cur && n.pos>=n.cur.a && n.pos<n.cur.b)){
        if(!n.ahead || n.ahead.a!==n.pos) n.ahead=iqpBlock(n, n.pos);
        if(!n.ahead.v){ n.acc=Math.min(n.acc+want, sr/2); break; }        // блок ещё читается — отсчёты не теряем
        n.cur=n.ahead.v;
        n.ahead=iqpBlock(n, n.cur.b>=n.total ? 0 : n.cur.b);
      }
      const take=Math.min(want, n.cur.b-n.pos), o=n.pos-n.cur.a;
      iqPush(s, n.cur.re.slice(o,o+take), n.cur.im.slice(o,o+take));
      n.pos+=take; want-=take;
      if(n.pos>=n.total){
        if(n.p.loop){ n.pos=0; ended=1; } else{ n.pos=n.total-1; n.acc=0; n.endP=2; ended=1; break; }
      }
    }
    if(ended) n.endP=2;
    const end=n.endP>0 ? 1 : 0; if(n.endP>0) n.endP--;
    s.fc=iqpFreqAt(n,n.pos);
    return {iq:s, fc:s.fc, pos:n.pos/n.total, sec:n.pos/sr, end};
  },
  draw(n){
    const el=n.el.querySelector('.readout'); if(!el) return;
    if(!n.src){ el.textContent=n.msg || 'choose a recording from Files'; return; }
    const q=n.rec?.meta?.iq;
    n.p.seek=n.appliedSeek=n.pos/n.total*100;
    el.textContent=n.name+'\n'+iqfRate(n.src.rate)+' @ '+iqfFreq(iqpFreqAt(n,n.pos))+(q?.bw ? ' · bw '+iqfFreq(q.bw) : '')+
      '\n'+iqfDur(n.pos/n.src.rate)+' / '+iqfDur(n.total/n.src.rate)+' · '+iqfBytes(n.rec?.size||n.src.size)+
      ((n.rec?.meta?.tags||[]).length ? '\n'+n.rec.meta.tags.map(t=>'#'+t).join(' ') : '')+(n.p.paused ? '\n❚❚ paused' : '');
  }});
