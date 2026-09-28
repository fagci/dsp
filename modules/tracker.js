/* ============================ ТРЕКЕР: УЗЛЫ ============================ */
// Tracker Song — песня, секвенсор и голоса каналов (форматы — tracker-formats.js, плеер — tracker-player.js,
// редактор — tracker-editor.js). Порт song (тип trk) отдаёт {song, pl, node} другим узлам:
// Tracker Channel выводит один канал отдельно (звук, ворота, частота, нота, громкость) и по желанию
// убирает его из общего сведения; Tracker Pattern View показывает паттерн.

/* ---------- хранилище песен (IndexedDB) ---------- */
// В n.p только ключ: снимки отмены графа — JSON всего патча, песню на сотни КБ туда не кладём.
const TrackerDB = (()=>{
  let dbp = null;
  function open(){
    if(dbp) return dbp;
    dbp = new Promise((res,rej)=>{
      const rq = indexedDB.open('dsp-tracker', 1);
      rq.onupgradeneeded = e=>{ const db=e.target.result; if(!db.objectStoreNames.contains('songs')) db.createObjectStore('songs',{keyPath:'id'}); };
      rq.onsuccess = e=>res(e.target.result);
      rq.onerror = e=>rej(e.target.error);
    });
    return dbp;
  }
  const reqP = rq=>new Promise((res,rej)=>{ rq.onsuccess=()=>res(rq.result); rq.onerror=()=>rej(rq.error); });
  async function st(mode){ return (await open()).transaction('songs',mode).objectStore('songs'); }
  return {
    async get(id){ return reqP((await st('readonly')).get(id)); },
    async put(rec){ return reqP((await st('readwrite')).put(rec)); },
  };
})();

const TRK_KEYS = new Map();                  // ключ песни → узел; копия узла получает свой ключ
function trkNewKey(){ return 'trk'+Date.now().toString(36)+Math.random().toString(36).slice(2,7); }
function modAssign(dst, src){
  for(const k of ['fmt','title','ch','orders','restart','speed','bpm','gvol','linear','chPan','patterns','samples','instruments']) dst[k] = src[k];
  dst.rev = (dst.rev|0)+1;
}
function trkRecSong(rec){                     // запись базы → песня (старые записи — байты .mod)
  if(rec.song) return rec.song;
  const b = rec.bytes; return trkParse(b.buffer.slice(b.byteOffset, b.byteOffset+b.byteLength));
}
async function trkInitSong(n){
  let key = n.p.song, from = null;
  const had = !!key, owner = key && TRK_KEYS.get(key);
  if(!key || (owner && owner!==n && !owner.disposed)){ from = key; key = trkNewKey(); n.p.song = key; }
  TRK_KEYS.set(key, n);
  if(!had){ trkSync(n); return; }
  n.status = 'loading…';
  let rec = null;
  try{ rec = await TrackerDB.get(from || key); }catch(e){ console.warn('tracker db:', e); }
  if(n.disposed) return;
  n.status = '';
  if(rec && !n.touched){
    try{ modAssign(n.song, trkRecSong(rec)); }
    catch(e){ n.status = 'stored song is damaged'; }
    if(from) trkSaveSoon(n, 0);
  }
  trkSync(n);
}
function trkSaveSoon(n, ms=800){
  n.touched = true;
  clearTimeout(n.saveT);
  n.saveT = setTimeout(()=>trkSave(n), ms);
}
function trkSave(n){
  clearTimeout(n.saveT); n.saveT = 0;
  const song = trkCloneSong(n.song);
  return TrackerDB.put({id:n.p.song, name:song.title, song, t:Date.now()}).catch(e=>console.warn('tracker save:', e));
}
function trkSync(n){                          // после загрузки/смены песни
  modPlayerChannels(n.pl);
  n.pl.chn.forEach((c,k)=>{ c.pan = n.song.chPan[k]??128; });
  if(n.T) trkPanels(n.T);
  redraw(n);
  for(const e of Graph.edges) if(e.from===n.id){ const m = Graph.map[e.to]; if(m) redraw(m); }
}
async function trkLoadFile(n, file){
  try{
    const song = trkParse(await file.arrayBuffer(), file.name);
    trkStopPlay(n);
    modAssign(n.song, song);
    if(!n.song.title) n.song.title = file.name.replace(/\.[^.]+$/,'');
    n.status = '';
    if(n.T) trkReset(n.T);
    trkSaveSoon(n, 0);
    trkSync(n);
  }catch(e){ console.warn(e); alert('Could not read '+file.name+': '+e.message); }
}
let trkEngP = null;                           // запуск движка уже идёт — второй не начинаем
function trkEnsureEngine(){
  if(trkEngP) return trkEngP;
  if(Eng.running && !Eng.paused) return Promise.resolve();
  trkEngP = (Eng.running ? Eng.toggle() : Eng.start()).catch(e=>console.warn('engine:', e)).finally(()=>{ trkEngP = null; });
  return trkEngP;
}
function trkPlay(n, mode, ord, row){
  trkEnsureEngine();
  modStart(n.pl, ord, row, mode);
  n._wasPlay = true;
  if(!n.p.play) setMod(n,'play',true);
}
function trkStopPlay(n){
  modStop(n.pl); n._wasPlay = false;
  if(n.p.play) setMod(n,'play',false);
}
function trkShown(n){                         // позиция с поправкой на задержку вывода — то, что слышно сейчас
  const pl = n.pl, h = n.hist;
  if(!pl.playing || !h || !h.length) return {ord:pl.ord, row:pl.row};
  const lat = Eng.latencyMs?.(), lag = lat ? Math.round(lat.totalMs/1000*Eng.sr/BLOCK) : 0;
  const want = Eng.blocks - lag;
  for(let i=h.length-1;i>=0;i--) if(h[i][0]<=want) return {ord:h[i][1], row:h[i][2]};
  return {ord:h[0][1], row:h[0][2]};
}
function trkPanGains(pan, sep){               // pan 0..255 → [gl, gr]
  const p = clamp((pan-128)/128,-1,1)*sep;
  return [(1-p)*0.5, (1+p)*0.5];
}
function trkSource(n){                         // узел Tracker Song на входе song (и без запущенного движка)
  const e = Graph.edges.find(e=>e.to===n.id && e.tp==='song');
  const m = e && Graph.map[e.from];
  return m && m.type==='tracker' ? m : null;
}

def({ id:'tracker', lazy:'manual', title:'Tracker Song', cat:'Music',
  outs:[{n:'L',t:'sig'},{n:'R',t:'sig'},{n:'song',t:'trk'},{n:'row',t:'num'},{n:'pos',t:'num'}],
  readout:true,
  params:[
    {n:'edit',t:'button',label:'✎ Edit',fn:n=>trkOpen(n)},
    {n:'file',t:'file',accept:'.mod,.s3m,.xm,.MOD,.S3M,.XM,.nst,.m15,.stk',fn:(n,f)=>trkLoadFile(n,f)},
    {n:'play',t:'check',d:false,label:'play',fn:n=>{ if(n.p.play) trkEnsureEngine(); }},
    {n:'loop',t:'check',d:true,label:'loop'},
    {n:'gain',t:'range',min:0,max:2,step:.01,d:.5},
    {n:'sep',t:'range',min:0,max:1,step:.01,d:.6,label:'stereo'},
    {n:'interp',t:'select',opts:['linear','none'],d:'linear',label:'interpolation',adv:true},
    {n:'song',t:'text',d:'',hidden:true}],
  init:n=>{
    n.song = trkNewSong('mod'); n.pl = modPlayer(n.song);
    n.hist = []; n._wasPlay = false; n.status = ''; n.T = null;
    n.trk = {song:n.song, pl:n.pl, node:n};
    trkInitSong(n);
  },
  dispose(n){
    n.disposed = true;
    if(n.T) trkClose(n.T, true);
    if(n.saveT) trkSave(n);
    if(TRK_KEYS.get(n.p.song)===n) TRK_KEYS.delete(n.p.song);
  },
  process(n,I,g){
    const L = buf(n,'L'), R = buf(n,'R'), pl = n.pl;
    L.fill(0); R.fill(0);
    pl.loop = !!n.p.loop;
    if(!!n.p.play!==n._wasPlay){
      n._wasPlay = !!n.p.play;
      if(n._wasPlay){ if(!pl.playing) modStart(pl, 0, 0, 'song'); }
      else modStop(pl);
    }
    modRender(pl, BLOCK, {sr:Eng.sr, interp:n.p.interp!=='none'});
    const gain = n.p.gain, sep = n.p.sep, taken = Eng.blocks-1;
    for(let k=0;k<pl.chn.length;k++){
      const c = pl.chn[k]; if(c.takenAt>=taken) continue;                   // канал забрал Tracker Channel
      const B = pl.bufs[k], [gl,gr] = trkPanGains(c.finPan, sep);
      const a = gl*gain, b = gr*gain;
      for(let i=0;i<BLOCK;i++){ const v = B[i]; L[i] += v*a; R[i] += v*b; }
    }
    if(pl.ended){ pl.ended = false; n._wasPlay = false; setMod(n,'play',false); }
    if(pl.playing){ n.hist.push([Eng.blocks, pl.ord, pl.row]); if(n.hist.length>96) n.hist.shift(); }
    else if(n.hist.length) n.hist.length = 0;
    // L/R не подключены — сразу на звуковую карту, чтобы песня была слышна без проводки
    if(n._ord!==g.order){ n._ord = g.order; n._direct = !g.edges.some(e=>e.from===n.id && (e.fp==='L'||e.fp==='R')); }
    if(n._direct && g===Graph){
      const oL = Eng.outs[0], oR = Eng.outs[1];
      for(let i=0;i<BLOCK;i++){ oL[i] = clamp(oL[i]+L[i],-1,1); oR[i] = clamp(oR[i]+R[i],-1,1); }
    }
    return {L, R, song:n.trk, row:pl.row, pos:pl.ord};
  },
  drawKey(n){ const s = trkShown(n); return n.song.rev+'|'+s.ord+'|'+s.row+'|'+n.pl.playing+'|'+n.pl.bpm+'|'+n.status; },
  draw(n){
    if(!n.ro) return;
    const song = n.song, pl = n.pl, sh = trkShown(n);
    const used = trkAllSamples(song).filter(s=>s.data.length).length;
    n.ro.textContent = (n.status ? n.status+' · ' : '') + (song.title||'untitled') + ' · ' + song.fmt.toUpperCase() + ' ' + song.ch+'ch · '+
      (pl.playing ? 'pos '+sh.ord+'/'+song.orders.length+' row '+sh.row+' · '+pl.bpm+' bpm/'+pl.speed : song.orders.length+' pos, '+used+' samples');
  }
});

/* ---------- один канал ---------- */
def({ id:'trkch', lazy:'manual', title:'Tracker Channel', cat:'Music', readout:true,
  ins:[{n:'song',t:'trk'}],
  outs:[{n:'out',t:'sig'},{n:'L',t:'sig'},{n:'R',t:'sig'},{n:'gate',t:'sig'},
        {n:'freq',t:'num'},{n:'note',t:'num'},{n:'vel',t:'num'},{n:'inst',t:'num'}],
  params:[
    {n:'ch',t:'num',d:1,label:'channel'},
    {n:'take',t:'check',d:true,label:'take out of the song mix'}],
  process(n,I){
    const S = I.song, out = buf(n,'out'), L = buf(n,'L'), R = buf(n,'R'), G = buf(n,'gate');
    n.S = S;
    if(!S || !S.pl.chn.length){ out.fill(0); L.fill(0); R.fill(0); G.fill(0); return {out, L, R, gate:G, freq:0, note:0, vel:0, inst:0}; }
    const pl = S.pl, song = S.song, k = clamp((n.p.ch|0)-1, 0, pl.chn.length-1), c = pl.chn[k];
    if(n.p.take) c.takenAt = Eng.blocks;
    const B = pl.bufs[k], Gs = pl.gates[k];
    const [gl,gr] = trkPanGains(c.finPan, S.node.p.sep), gain = S.node.p.gain;
    for(let i=0;i<BLOCK;i++){ const v = B?B[i]:0; out[i] = v; L[i] = v*gl*gain; R[i] = v*gr*gain; G[i] = Gs?Gs[i]:0; }
    const on = c.active && c.baseF>0;
    const freq = on ? 261.6256*Math.pow(2,(c.note-48)/12)*trkFreq(song, c.finPer||c.per)/c.baseF : 0;
    redrawIf(n, k+'|'+c.note+'|'+c.inst+'|'+Math.round(c.fin*20)+'|'+on);
    return {out, L, R, gate:G, freq, note:on ? c.note+12 : 0, vel:c.fin, inst:c.inst};
  },
  draw(n){
    if(!n.ro) return;
    const S = n.S || trkSource(n)?.trk;
    if(!S){ n.ro.textContent = 'wire song from a Tracker Song'; return; }
    const k = clamp((n.p.ch|0)-1, 0, S.pl.chn.length-1), c = S.pl.chn[k];
    n.ro.textContent = 'ch '+(k+1)+'/'+S.song.ch+' · '+(c?.active ? trkNoteName(S.song, c.note+1)+' '+trkInstName(S.song, c.inst)+' · vol '+Math.round(c.fin*64) : 'silent');
  }
});

/* ---------- вид паттерна ---------- */
def({ id:'trkview', lazy:'manual', title:'Tracker Pattern View', cat:'Music', readout:true,
  ins:[{n:'song',t:'trk'}],
  view:{h:200}, w:420, resize:true,
  process(n,I){ n.S = I.song; return {}; },
  drawKey(n){
    const src = n.S?.node || trkSource(n);
    if(!src) return 'none';
    const s = trkShown(src), pl = src.pl;
    let vu = ''; for(const c of pl.chn) vu += (c.vu*8)|0;
    return src.id+'|'+src.song.rev+'|'+s.ord+'|'+s.row+'|'+pl.playing+'|'+vu+'|'+(src.T?src.T.ord+':'+src.T.row:'');
  },
  draw(n,cv,cx){
    const src = n.S?.node || trkSource(n);
    if(cv && !n._cvWired){
      n._cvWired = true;
      cv.addEventListener('dblclick', ev=>{ ev.stopPropagation(); const s = n.S?.node || trkSource(n); if(s) trkOpen(s); });
    }
    if(n.ro) n.ro.textContent = src ? (src.song.title||'untitled')+' · double click to edit' : 'wire song from a Tracker Song';
    if(!cv) return;
    const W = cv.width, H = cv.height;
    cx.fillStyle = themeColor('--screen'); cx.fillRect(0,0,W,H);
    if(!src) return;
    trkDrawMini(src, cx, W, H);
  }
});
function trkDrawMini(src, cx, W, H){
  const song = src.song, pl = src.pl, sh = trkShown(src);
  const ord = pl.playing ? sh.ord : (src.T ? src.T.ord : 0), row = pl.playing ? sh.row : (src.T ? src.T.row : 0);
  const pat = song.patterns[song.orders[ord]], ch = song.ch, vcol = song.fmt!=='mod';
  const fs = 10, rh = 12, cw = fs*0.6;
  cx.font = fs+'px '+themeColor('--mono');
  const wide = (vcol ? 14 : 11)*cw, full = 20 + ch*wide <= W, colW = full ? wide : 4*cw;
  const nch = Math.min(ch, Math.floor((W-20)/colW));
  const top = 12, cy = top + Math.floor((H-top)/2/rh)*rh;
  cx.fillStyle = 'rgba(224,178,60,.18)'; cx.fillRect(0, cy-rh+3, W, rh);
  for(let k=0;k<nch;k++){                        // индикаторы уровня каналов
    const x = 20+k*colW, v = clamp(pl.chn[k]?.vu||0,0,1), c = pl.chn[k];
    cx.fillStyle = c?.mute ? themeColor('--err') : c && c.takenAt>=Eng.blocks-2 ? themeColor('--t-trk') : themeColor('--acc2');
    cx.fillRect(x, 2, (colW-cw)*v, 5);
    cx.fillStyle = themeColor('--grid'); cx.fillRect(x+(colW-cw)*v, 2, (colW-cw)*(1-v), 5);
  }
  if(!pat) return;
  for(let r=row-Math.ceil((cy-top)/rh); r<=row+Math.ceil((H-cy)/rh); r++){
    if(r<0 || r>=pat.rows) continue;
    const y = cy + (r-row)*rh;
    cx.fillStyle = r%4 ? themeColor('--axis') : themeColor('--acc');
    cx.fillText(modHex(r,2), 2, y);
    for(let k=0;k<nch;k++){
      const o = (r*ch+k)*5, x = 20+k*colW, d = pat.d;
      const nt = d[o], sm = d[o+1], vv = d[o+2], ef = d[o+3], pr = d[o+4];
      cx.fillStyle = nt ? themeColor('--screen-fg') : themeColor('--grid');
      cx.fillText(trkNoteName(song, nt), x, y);
      if(!full) continue;
      cx.fillStyle = sm ? themeColor('--acc') : themeColor('--grid');
      cx.fillText(trkInstName(song, sm), x+4*cw, y);
      let ex = 7;
      if(vcol){ cx.fillStyle = vv ? themeColor('--t-num') : themeColor('--grid'); cx.fillText(trkVolName(song, vv), x+7*cw, y); ex = 10; }
      cx.fillStyle = ef||pr ? themeColor('--t-spec') : themeColor('--grid');
      cx.fillText(trkEffName(song, ef, pr), x+ex*cw, y);
    }
  }
}
