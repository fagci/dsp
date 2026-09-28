/* ============================ MOD-ТРЕКЕР ============================ */
// ProTracker-модули (.mod): чтение/запись, плеер с эффектами PT, узел графа и полноэкранный редактор.
// Песня: {title, ch, orders[], restart, patterns[Uint8Array(64*ch*4)], samples[31]}.
// Ячейка паттерна — 4 байта: нота (0 — пусто, иначе индекс+1; 12 = C-1 = период 856), семпл, эффект, параметр.
// Семпл: {name, data:Int8Array, vol 0..64, ft -8..7, ls, ll} — ls/ll в байтах, ll=0 — без петли.

const MOD_CLOCK = 3546894.6;              // PAL: частота = MOD_CLOCK/период
const MOD_ROWS = 64;
const MOD_NOTES = 60;                     // C-0..B-4
// периоды PT для finetune 0, октавы 1..3; октавы 0 и 4 — удвоение/половина (расширенные трекеры)
const MOD_PER1 = [856,808,762,720,678,640,604,570,538,508,480,453,428,404,381,360,339,320,302,285,269,254,240,226,
                  214,202,190,180,170,160,151,143,135,127,120,113];
const MOD_PER = (()=>{
  const t = new Int16Array(16*MOD_NOTES);
  for(let f=0;f<16;f++){
    const ft = f>7 ? f-16 : f;
    for(let i=0;i<MOD_NOTES;i++){
      const o = Math.floor(i/12), k = i%12;
      let p;
      if(ft===0) p = o===0 ? MOD_PER1[k]*2 : o===4 ? Math.round(MOD_PER1[24+k]/2) : MOD_PER1[(o-1)*12+k];
      else p = Math.round(856*2*Math.pow(2, -(i + ft/8)/12));
      t[f*MOD_NOTES+i] = p;
    }
  }
  return t;
})();
const MOD_SINE = [0,24,49,74,97,120,141,161,180,197,212,224,235,244,250,253,255,253,250,244,235,224,212,197,180,161,141,120,97,74,49,24];
const MOD_NN = ['C-','C#','D-','D#','E-','F-','F#','G-','G#','A-','A#','B-'];
const MOD_C3_RATE = MOD_CLOCK/214;        // частота воспроизведения на C-3 — для импорта/редактора семплов

function modPeriod(note, ft){ return MOD_PER[((ft|0)&15)*MOD_NOTES + clamp(note|0,0,MOD_NOTES-1)]; }
function modNoteOfPeriod(p){               // ближайшая нота по логарифму периода
  if(p<=0) return -1;
  let best = 0, bd = Infinity;
  for(let i=0;i<MOD_NOTES;i++){ const d = Math.abs(Math.log(MOD_PER[i]/p)); if(d<bd){ bd=d; best=i; } }
  return best;
}
function modNoteName(i){ return i<0 ? '---' : MOD_NN[i%12]+Math.floor(i/12); }
function modHex(v, w){ return v.toString(16).toUpperCase().padStart(w,'0'); }

function modEmptySample(){ return {name:'', data:new Int8Array(0), vol:64, ft:0, ls:0, ll:0}; }
function modNewSong(ch=4){
  return { title:'untitled', ch, orders:[0], restart:0, patterns:[new Uint8Array(MOD_ROWS*ch*4)],
           samples:Array.from({length:31}, modEmptySample), rev:0 };
}

/* ---------- чтение ---------- */
function modParse(buf){
  const b = new Uint8Array(buf);
  if(b.length<600) throw new Error('file is too short for a MOD');
  const str = (o,l)=>{ let s=''; for(let i=0;i<l;i++){ const c=b[o+i]; if(!c) break; s += c>=32&&c<127 ? String.fromCharCode(c) : ' '; } return s.replace(/\s+$/,''); };
  const tag = b.length>=1084 ? String.fromCharCode(b[1080],b[1081],b[1082],b[1083]) : '';
  let ch = 0, ns = 31;
  if(['M.K.','M!K!','M&K!','FLT4','4CHN','N.T.'].includes(tag)) ch = 4;
  else if(['FLT8','8CHN','OCTA','CD81'].includes(tag)) ch = 8;
  else if(/^[1-9]CHN$/.test(tag)) ch = +tag[0];
  else if(/^[1-9]\dC[HN]$/.test(tag)) ch = +tag.slice(0,2);
  else if(/^TDZ[1-9]$/.test(tag)) ch = +tag[3];
  if(!ch){ ch = 4; ns = 15; }               // Soundtracker: 15 семплов, без метки
  const song = modNewSong(ch);
  song.title = str(0,20);
  let off = 20;
  const lens = [];
  for(let i=0;i<ns;i++, off+=30){
    const s = song.samples[i];
    s.name = str(off,22);
    const len = ((b[off+22]<<8)|b[off+23])*2;
    let ft = b[off+24]&15; if(ft>7) ft -= 16;
    s.ft = ft; s.vol = Math.min(b[off+25],64);
    s.ls = ((b[off+26]<<8)|b[off+27])*2;
    s.ll = ((b[off+28]<<8)|b[off+29])*2;
    lens.push(len);
  }
  const songLen = clamp(b[off],1,128);
  song.restart = b[off+1];
  const ord = Array.from(b.subarray(off+2, off+130));
  off += 130 + (ns===31 ? 4 : 0);
  const patSize = MOD_ROWS*ch*4;
  const smpTotal = lens.reduce((a,v)=>a+v,0);
  // PT считает паттерны по всем 128 позициям; если мусор в хвосте не влезает в файл — только по песне
  let nPat = Math.max(...ord)+1;
  const nUsed = Math.max(...ord.slice(0,songLen))+1;
  if(off + nPat*patSize + smpTotal > b.length + 4096) nPat = nUsed;
  song.orders = ord.slice(0,songLen);
  song.patterns = [];
  for(let p=0;p<nPat;p++){
    const pat = new Uint8Array(patSize);
    for(let j=0;j<MOD_ROWS*ch;j++){
      const o = off + p*patSize + j*4;
      if(o+3>=b.length) break;
      const b0=b[o], b1=b[o+1], b2=b[o+2], b3=b[o+3];
      const per = ((b0&15)<<8)|b1;
      pat[j*4]   = per ? modNoteOfPeriod(per)+1 : 0;
      pat[j*4+1] = (b0&0xF0)|(b2>>4);
      pat[j*4+2] = b2&15;
      pat[j*4+3] = b3;
    }
    song.patterns.push(pat);
  }
  off += nPat*patSize;
  for(let i=0;i<ns;i++){
    const s = song.samples[i], len = Math.max(0, Math.min(lens[i], b.length-off));
    s.data = new Int8Array(b.buffer.slice(b.byteOffset+off, b.byteOffset+off+len));
    off += lens[i];
    modFixLoop(s);
  }
  return song;
}
function modFixLoop(s){
  const len = s.data.length;
  s.ls &= ~1; s.ll &= ~1;
  if(s.ll<=2 || s.ls>=len){ s.ls = 0; s.ll = 0; return; }
  if(s.ls+s.ll>len){
    if(s.ls/2+s.ll<=len) s.ls = (s.ls/2)&~1;   // старые трекеры писали начало петли в байтах
    else s.ll = (len-s.ls)&~1;
  }
  if(s.ll<=2){ s.ls = 0; s.ll = 0; }
}

/* ---------- запись ---------- */
function modWrite(song){
  const ch = song.ch, patSize = MOD_ROWS*ch*4;
  const orders = song.orders.slice(0,128);
  let nPat = Math.max(...orders)+1;
  for(let p=song.patterns.length-1;p>=nPat;p--) if(song.patterns[p].some(v=>v)){ nPat = p+1; break; }
  const tag = ch===4 ? (nPat>64 ? 'M!K!' : 'M.K.') : ch<10 ? ch+'CHN' : ch+'CH';
  const lens = song.samples.map(s=>Math.min(s.data.length, 131070));
  const plen = lens.map(l=>(l+1)&~1);
  const total = 1084 + nPat*patSize + plen.reduce((a,v)=>a+v,0);
  const b = new Uint8Array(total);
  const wstr = (o,l,s)=>{ for(let i=0;i<l && i<s.length;i++){ const c=s.charCodeAt(i); b[o+i] = c<128 ? c : 63; } };
  const w16 = (o,v)=>{ b[o]=(v>>8)&255; b[o+1]=v&255; };
  wstr(0,20,song.title||'');
  let off = 20;
  song.samples.forEach((s,i)=>{
    wstr(off,22,s.name||'');
    w16(off+22, plen[i]>>1);
    b[off+24] = s.ft&15; b[off+25] = clamp(s.vol|0,0,64);
    if(s.ll>2){ w16(off+26, s.ls>>1); w16(off+28, s.ll>>1); }
    else { w16(off+26, 0); w16(off+28, 1); }
    off += 30;
  });
  b[off] = orders.length; b[off+1] = song.restart&127;
  orders.forEach((v,i)=>{ b[off+2+i] = v; });
  if(nPat-1>Math.max(...orders) && orders.length<128) b[off+2+127] = nPat-1;   // PT считает паттерны по всем 128 позициям
  off += 130;
  wstr(off,4,tag); off += 4;
  for(let p=0;p<nPat;p++){
    const pat = song.patterns[p] || new Uint8Array(patSize);
    for(let j=0;j<MOD_ROWS*ch;j++){
      const o = off + j*4, nt = pat[j*4], sm = pat[j*4+1];
      const per = nt ? MOD_PER[nt-1] : 0;
      b[o] = (sm&0xF0)|((per>>8)&15); b[o+1] = per&255;
      b[o+2] = ((sm&15)<<4)|(pat[j*4+2]&15); b[o+3] = pat[j*4+3];
    }
    off += patSize;
  }
  song.samples.forEach((s,i)=>{ b.set(new Uint8Array(s.data.buffer, s.data.byteOffset, lens[i]), off); off += plen[i]; });
  return b;
}

/* ---------- плеер ---------- */
function modChan(i){
  const lr = [-1,1,1,-1][i&3];                                   // Amiga: L R R L
  return { smp:0, pos:0, active:false, per:0, outPer:0, vol:0, outVol:0, ft:0, note:-1,
           target:0, pspd:0, vspd:0, vdep:0, vpos:0, vwav:0, tspd:0, tdep:0, tpos:0, twav:0,
           off:0, loopRow:0, loopCnt:0, pan:lr, eff:0, prm:0, gliss:0, delay:null, mute:false, vu:0 };
}
function modPlayer(song){
  const pl = { song, playing:false, mode:'song', ord:0, row:0, tick:0, speed:6, bpm:125, left:0,
               jump:-1, brk:-1, loopJump:-1, delay:0, inDelay:false, chn:[], ended:false, solo:-1 };
  modPlayerChannels(pl);
  return pl;
}
function modPlayerChannels(pl){
  const n = pl.song.ch;
  while(pl.chn.length<n) pl.chn.push(modChan(pl.chn.length));
  pl.chn.length = n;
}
function modPat(pl){ const s=pl.song; return s.patterns[s.orders[pl.ord]] || null; }
function modStart(pl, ord, row, mode){
  const s = pl.song;
  pl.ord = clamp(ord|0, 0, s.orders.length-1); pl.row = clamp(row|0, 0, MOD_ROWS-1);
  pl.mode = mode||'song'; pl.tick = 0; pl.left = 0; pl.speed = 6; pl.bpm = 125;
  pl.jump = pl.brk = pl.loopJump = -1; pl.delay = 0; pl.inDelay = false; pl.ended = false;
  modPlayerChannels(pl);
  for(const c of pl.chn){ const m=c.mute, p=c.pan; Object.assign(c, modChan(0)); c.mute=m; c.pan=p; }
  pl.playing = true;
}
function modStop(pl){ pl.playing = false; for(const c of pl.chn) c.active = false; }
function modSmpF(s){                         // float-копия данных семпла, пересчёт при замене data
  if(s.fSrc!==s.data){ const d=s.data, f=new Float32Array(d.length); for(let i=0;i<d.length;i++) f[i]=d[i]/128; s.f=f; s.fSrc=d; }
  return s.f;
}
function modTrigger(c, s){
  c.pos = 0; c.active = !!(s && s.data.length);
  if(!(c.vwav&4)) c.vpos = 0;
  if(!(c.twav&4)) c.tpos = 0;
}
// нота в канале вне секвенсора — прослушивание при вводе
function modPreview(pl, ch, note, inst){
  const c = pl.chn[ch]; if(!c) return;
  const s = pl.song.samples[inst-1]; if(!s) return;
  c.smp = inst; c.vol = c.outVol = s.vol; c.ft = s.ft; c.note = note;
  c.per = c.outPer = modPeriod(note, c.ft); c.eff = 0; c.prm = 0; c.delay = null;
  modTrigger(c, s);
}
function modVolSlide(c){ const x=c.prm>>4, y=c.prm&15; c.vol = clamp(x ? c.vol+x : c.vol-y, 0, 64); }
function modTonePorta(c){
  if(!c.target) return;
  if(c.per<c.target){ c.per = Math.min(c.per+c.pspd, c.target); }
  else if(c.per>c.target){ c.per = Math.max(c.per-c.pspd, c.target); }
  if(c.per===c.target) c.target = 0;
  c.outPer = c.gliss ? modPeriod(modNoteOfPeriod(c.per), c.ft) : c.per;
}
function modWave(w, pos){                    // pos 0..63, результат −255..255
  const i = pos&31, neg = pos&32;
  const v = (w&3)===0 ? MOD_SINE[i] : (w&3)===1 ? (neg ? 255-i*8 : i*8) : 255;
  return neg ? -v : v;
}
function modVibrato(c){
  c.outPer = c.per + ((modWave(c.vwav, c.vpos)*c.vdep)>>7);
  c.vpos = (c.vpos + c.vspd)&63;
}
function modTremolo(c){
  c.outVol = clamp(c.vol + ((modWave(c.twav, c.tpos)*c.tdep)>>6), 0, 64);
  c.tpos = (c.tpos + c.tspd)&63;
}
function modRowNote(pl, c, note, inst){      // запуск ноты/семпла из ячейки (тик 0 или задержка EDx)
  const song = pl.song;
  if(inst>0 && inst<=31){ const s=song.samples[inst-1]; c.smp = inst; c.vol = s.vol; c.ft = s.ft; }
  if(note<0) return;
  if(c.eff===0xE && (c.prm>>4)===5){ let f=c.prm&15; c.ft = f>7 ? f-16 : f; }
  const per = modPeriod(note, c.ft);
  if(c.eff===3 || c.eff===5){ c.target = per; if(c.target===c.per) c.target = 0; return; }
  c.per = per; c.note = note; c.target = 0;
  modTrigger(c, song.samples[c.smp-1]);
  if(c.eff===9){
    if(c.prm) c.off = c.prm;
    const s = song.samples[c.smp-1];
    c.pos = c.off*256;
    if(s && c.pos>=s.data.length){ if(s.ll>2) c.pos = s.ls; else c.active = false; }
  }
}
function modRow(pl){
  const pat = modPat(pl), song = pl.song, ch = song.ch;
  for(let k=0;k<ch;k++){
    const c = pl.chn[k], o = (pl.row*ch+k)*4;
    const note = pat ? pat[o]-1 : -1, inst = pat ? pat[o+1] : 0;
    c.eff = pat ? pat[o+2] : 0; c.prm = pat ? pat[o+3] : 0;
    const x = c.prm>>4, y = c.prm&15;
    c.delay = null;
    if(c.eff===0xE && x===0xD && y) c.delay = {note, inst, t:y};
    else modRowNote(pl, c, note, inst);
    switch(c.eff){
      case 3: if(c.prm) c.pspd = c.prm; break;
      case 4: if(x) c.vspd = x; if(y) c.vdep = y; break;
      case 7: if(x) c.tspd = x; if(y) c.tdep = y; break;
      case 8: c.pan = c.prm/255*2-1; break;
      case 0xB: pl.jump = c.prm; if(pl.brk<0) pl.brk = 0; break;
      case 0xC: c.vol = Math.min(c.prm,64); break;
      case 0xD: pl.brk = x*10+y; if(pl.brk>63) pl.brk = 0; if(pl.jump<0) pl.jump = -2; break;
      case 0xE:
        switch(x){
          case 1: c.per = Math.max(113, c.per-y); break;
          case 2: c.per = Math.min(856, c.per+y); break;
          case 3: c.gliss = y; break;
          case 4: c.vwav = y; break;
          case 6:
            if(!y) c.loopRow = pl.row;
            else if(!c.loopCnt){ c.loopCnt = y; pl.loopJump = c.loopRow; }
            else if(--c.loopCnt) pl.loopJump = c.loopRow;
            break;
          case 7: c.twav = y; break;
          case 8: c.pan = y/15*2-1; break;
          case 0xA: c.vol = Math.min(64, c.vol+y); break;
          case 0xB: c.vol = Math.max(0, c.vol-y); break;
          case 0xC: if(!y) c.vol = 0; break;
          case 0xE: if(!pl.inDelay && !pl.delay) pl.delay = y; break;
        }
        break;
      case 0xF: if(c.prm){ if(c.prm<32) pl.speed = c.prm; else pl.bpm = c.prm; } break;
    }
    c.outPer = c.per; c.outVol = c.vol;
  }
}
function modTickFx(pl){
  const t = pl.tick, song = pl.song;
  for(const c of pl.chn){
    c.outPer = c.per; c.outVol = c.vol;
    const x = c.prm>>4, y = c.prm&15;
    switch(c.eff){
      case 0: if(c.prm){
        const k = t%3; if(k){ const nb = modNoteOfPeriod(c.per); c.outPer = modPeriod(nb+(k===1?x:y), c.ft); } }
        break;
      case 1: c.per = Math.max(113, c.per-c.prm); c.outPer = c.per; break;
      case 2: c.per = Math.min(856, c.per+c.prm); c.outPer = c.per; break;
      case 3: modTonePorta(c); break;
      case 4: modVibrato(c); break;
      case 5: modTonePorta(c); modVolSlide(c); c.outVol = c.vol; break;
      case 6: modVolSlide(c); c.outVol = c.vol; modVibrato(c); break;
      case 7: modTremolo(c); break;
      case 0xA: modVolSlide(c); c.outVol = c.vol; break;
      case 0xE:
        if(x===9 && y && t%y===0) modTrigger(c, song.samples[c.smp-1]);
        else if(x===0xC && t===y){ c.vol = 0; c.outVol = 0; }
        else if(x===0xD && c.delay && t===c.delay.t){ const d=c.delay; c.delay=null; modRowNote(pl, c, d.note, d.inst); c.outPer=c.per; c.outVol=c.vol; }
        break;
    }
  }
}
function modAdvance(pl){
  const song = pl.song, len = song.orders.length;
  if(pl.loopJump>=0){ pl.row = pl.loopJump; }
  else if(pl.jump!==-1 || pl.brk>=0){
    if(pl.mode==='song'){
      const nextOrd = pl.jump>=0 ? pl.jump : pl.ord+1;
      // Bxx назад — песня зациклена сама; без loop на этом и заканчиваем
      if(pl.jump>=0 && nextOrd<=pl.ord && !pl.loop){ pl.playing = false; pl.ended = true; pl.ord = 0; pl.row = 0; pl.jump = pl.brk = pl.loopJump = -1; return; }
      pl.ord = nextOrd;
    }
    pl.row = Math.max(0, pl.brk);
  } else if(++pl.row>=MOD_ROWS){ pl.row = 0; if(pl.mode==='song') pl.ord++; }
  pl.jump = -1; pl.brk = -1; pl.loopJump = -1;
  if(pl.ord>=len){
    pl.ord = song.restart<len ? song.restart : 0;
    if(!pl.loop){ pl.playing = false; pl.ended = true; pl.ord = 0; pl.row = 0; }
  }
}
function modDoTick(pl){
  if(pl.tick===0 && !pl.inDelay) modRow(pl);
  else modTickFx(pl);
  if(++pl.tick>=pl.speed){
    pl.tick = 0;
    if(pl.delay>0){ pl.delay--; pl.inDelay = true; }
    else { pl.inDelay = false; pl.delay = 0; modAdvance(pl); }
  }
}
// Микширование len семплов в L/R (прибавляет). o — {sr, gain, sep, interp}
function modRender(pl, L, R, len, o){
  const song = pl.song, sr = o.sr;
  modPlayerChannels(pl);
  let i = 0;
  while(i<len){
    if(pl.left<=0){
      if(pl.playing) modDoTick(pl);
      pl.left += sr*2.5/pl.bpm;
    }
    const n = Math.min(len-i, Math.ceil(pl.left));
    for(let k=0;k<pl.chn.length;k++){
      const c = pl.chn[k];
      if(!c.active || c.outPer<=0){ c.vu *= 0.9; continue; }
      const s = song.samples[c.smp-1];
      if(!s || !s.data.length){ c.active = false; continue; }
      const f = modSmpF(s), loop = s.ll>2, end = loop ? Math.min(s.ls+s.ll, s.data.length) : s.data.length;
      const step = MOD_CLOCK/c.outPer/sr;
      const silent = c.mute || (pl.solo>=0 && pl.solo!==k);
      const g = silent ? 0 : clamp(c.outVol,0,64)/64*o.gain;
      const p = clamp(c.pan,-1,1)*o.sep, gl = g*(1-p)*0.5, gr = g*(1+p)*0.5;
      let pos = c.pos, pk = 0;
      for(let j=0;j<n;j++){
        if(pos>=end){
          if(loop){ pos = s.ls + (pos-end)%s.ll; }
          else { c.active = false; break; }
        }
        const i0 = pos|0;
        let v;
        if(o.interp){
          const nx = i0+1<end ? f[i0+1] : loop ? f[s.ls] : 0;
          v = f[i0] + (nx-f[i0])*(pos-i0);
        } else v = f[i0];
        L[i+j] += v*gl; R[i+j] += v*gr;
        const a = v<0?-v:v; if(a>pk) pk = a;
        pos += step;
      }
      c.pos = pos;
      c.vu = Math.max(pk*clamp(c.outVol,0,64)/64, c.vu*0.9);
    }
    pl.left -= n; i += n;
  }
}

/* ---------- хранилище песен (IndexedDB) ---------- */
// В n.p только ключ: снимки отмены графа — JSON всего патча, модуль на сотни КБ туда не кладём.
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

/* ---------- узел ---------- */
const TRK_KEYS = new Map();                  // ключ песни → узел; копия узла получает свой ключ
function trkNewKey(){ return 'trk'+Date.now().toString(36)+Math.random().toString(36).slice(2,7); }
function modAssign(dst, src){
  for(const k of ['title','ch','orders','restart','patterns','samples']) dst[k] = src[k];
  dst.rev = (dst.rev|0)+1;
}
async function trkInitSong(n){
  let key = n.p.song, from = null;
  const had = !!key;
  const owner = key && TRK_KEYS.get(key);
  if(!key || (owner && owner!==n && !owner.disposed)){ from = key; key = trkNewKey(); n.p.song = key; }
  TRK_KEYS.set(key, n);
  const src = from || key;
  if(!had){ trkSync(n); return; }
  n.status = 'loading…';
  let rec = null;
  try{ rec = await TrackerDB.get(src); }catch(e){ console.warn('tracker db:', e); }
  if(n.disposed) return;
  if(rec && !n.touched){
    try{ modAssign(n.song, modParse(rec.bytes.buffer.slice(rec.bytes.byteOffset, rec.bytes.byteOffset+rec.bytes.byteLength))); n.status = ''; }
    catch(e){ n.status = 'stored song is damaged'; }
    if(from) trkSaveSoon(n, 0);
  } else if(!rec) n.status = '';
  trkSync(n);
}
function trkSaveSoon(n, ms=800){
  n.touched = true;
  clearTimeout(n.saveT);
  n.saveT = setTimeout(()=>trkSave(n), ms);
}
function trkSave(n){
  clearTimeout(n.saveT); n.saveT = 0;
  const bytes = modWrite(n.song);
  return TrackerDB.put({id:n.p.song, name:n.song.title, bytes, t:Date.now()}).catch(e=>console.warn('tracker save:', e));
}
function trkSync(n){                          // после загрузки/смены песни
  modPlayerChannels(n.pl);
  if(n.T) trkPanels(n.T);
  redraw(n);
}
async function trkLoadFile(n, file){
  try{
    const song = modParse(await file.arrayBuffer());
    modStop(n.pl); setMod(n,'play',false); n._wasPlay = false;
    modAssign(n.song, song);
    if(!n.song.title) n.song.title = file.name.replace(/\.[^.]+$/,'');
    n.status = '';
    if(n.T){ n.T.undo = []; n.T.redo = []; n.T.ord = 0; n.T.row = 0; n.T.ch = 0; n.T.sel = null; }
    trkSaveSoon(n, 0);
    trkSync(n);
  }catch(e){ console.warn(e); alert('Could not read '+file.name+': '+e.message); }
}
async function trkEnsureEngine(){
  if(!Eng.running) await Eng.start();
  else if(Eng.paused) await Eng.toggle();
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

def({ id:'tracker', lazy:'manual', title:'MOD Tracker', cat:'Music',
  outs:[{n:'L',t:'sig'},{n:'R',t:'sig'},{n:'row',t:'num'},{n:'pos',t:'num'}],
  view:{h:190}, w:380, resize:true, readout:true,
  params:[
    {n:'edit',t:'button',label:'✎ Edit',fn:n=>trkOpen(n)},
    {n:'file',t:'file',accept:'.mod,.MOD,.nst,.m15,.stk',fn:(n,f)=>trkLoadFile(n,f)},
    {n:'play',t:'check',d:false,label:'play',fn:n=>{ if(n.p.play) trkEnsureEngine(); }},
    {n:'loop',t:'check',d:true,label:'loop'},
    {n:'gain',t:'range',min:0,max:2,step:.01,d:.5},
    {n:'sep',t:'range',min:0,max:1,step:.01,d:.6,label:'stereo'},
    {n:'interp',t:'select',opts:['linear','none'],d:'linear',label:'interpolation',adv:true},
    {n:'song',t:'text',d:'',hidden:true}],
  init:n=>{
    n.song = modNewSong(4); n.pl = modPlayer(n.song);
    n.hist = []; n._wasPlay = false; n.status = ''; n.T = null;
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
    modRender(pl, L, R, BLOCK, {sr:Eng.sr, gain:n.p.gain, sep:n.p.sep, interp:n.p.interp!=='none'});
    if(pl.ended){ pl.ended = false; n._wasPlay = false; setMod(n,'play',false); }
    if(pl.playing){ n.hist.push([Eng.blocks, pl.ord, pl.row]); if(n.hist.length>96) n.hist.shift(); }
    else if(n.hist.length) n.hist.length = 0;
    // выходы не подключены — сразу на звуковую карту, чтобы модуль был слышен без проводки
    if(n._ord!==g.order){ n._ord = g.order; n._direct = !g.edges.some(e=>e.from===n.id && (e.fp==='L'||e.fp==='R')); }
    if(n._direct && g===Graph){
      const oL = Eng.outs[0], oR = Eng.outs[1];
      for(let i=0;i<BLOCK;i++){ oL[i] = clamp(oL[i]+L[i],-1,1); oR[i] = clamp(oR[i]+R[i],-1,1); }
    }
    return {L, R, row:pl.row, pos:pl.ord};
  },
  drawKey(n){
    const s = trkShown(n), pl = n.pl;
    let vu = ''; for(const c of pl.chn) vu += (c.vu*8)|0;
    return n.song.rev+'|'+s.ord+'|'+s.row+'|'+pl.playing+'|'+vu+'|'+n.status+'|'+(n.T?n.T.ord+':'+n.T.row:'');
  },
  draw(n,cv,cx){
    if(!n._cvWired && cv){
      n._cvWired = true;
      cv.addEventListener('dblclick', ev=>{ ev.stopPropagation(); trkOpen(n); });
    }
    const song = n.song, pl = n.pl, sh = trkShown(n);
    const ord = pl.playing ? sh.ord : (n.T ? n.T.ord : 0), row = pl.playing ? sh.row : (n.T ? n.T.row : 0);
    if(n.ro){
      const used = song.samples.filter(s=>s.data.length).length;
      n.ro.textContent = (n.status ? n.status+' · ' : '') + (song.title||'untitled') + ' · ' + song.ch+'ch · '+
        (pl.playing ? 'pos '+ord+'/'+song.orders.length+' row '+row+' · '+pl.bpm+' bpm/'+pl.speed : song.orders.length+' pos, '+used+' samples');
    }
    if(!cv) return;
    const W = cv.width, H = cv.height;
    cx.fillStyle = themeColor('--screen'); cx.fillRect(0,0,W,H);
    const pat = song.patterns[song.orders[ord]], ch = song.ch;
    const fs = 10, rh = 12, cw = fs*0.6;
    cx.font = fs+'px '+themeColor('--mono');
    const full = 20 + ch*11*cw <= W, colW = full ? 11*cw : 4*cw;
    const nch = Math.min(ch, Math.floor((W-20)/colW));
    const top = 12, cy = top + Math.floor((H-top)/2/rh)*rh;
    cx.fillStyle = 'rgba(224,178,60,.18)'; cx.fillRect(0, cy-rh+3, W, rh);
    for(let k=0;k<nch;k++){                      // индикаторы уровня каналов
      const x = 20+k*colW, v = clamp(pl.chn[k]?.vu||0,0,1);
      cx.fillStyle = pl.chn[k]?.mute ? themeColor('--err') : themeColor('--acc2');
      cx.fillRect(x, 2, (colW-cw)*v, 5);
      cx.fillStyle = themeColor('--grid'); cx.fillRect(x+(colW-cw)*v, 2, (colW-cw)*(1-v), 5);
    }
    if(!pat) return;
    for(let r=row-Math.ceil((cy-top)/rh); r<=row+Math.ceil((H-cy)/rh); r++){
      if(r<0 || r>=MOD_ROWS) continue;
      const y = cy + (r-row)*rh;
      cx.fillStyle = r%4 ? themeColor('--axis') : themeColor('--acc');
      cx.fillText(modHex(r,2), 2, y);
      for(let k=0;k<nch;k++){
        const o = (r*ch+k)*4, x = 20+k*colW;
        const nt = pat[o], sm = pat[o+1], ef = pat[o+2], pr = pat[o+3];
        cx.fillStyle = nt ? themeColor('--screen-fg') : themeColor('--grid');
        cx.fillText(nt ? modNoteName(nt-1) : '···', x, y);
        if(!full) continue;
        cx.fillStyle = sm ? themeColor('--acc') : themeColor('--grid');
        cx.fillText(sm ? modHex(sm,2) : '··', x+4*cw, y);
        cx.fillStyle = ef||pr ? themeColor('--t-spec') : themeColor('--grid');
        cx.fillText(ef||pr ? modHex(ef,1)+modHex(pr,2) : '···', x+7*cw, y);
      }
    }
  }
});

/* ============================ РЕДАКТОР ============================ */
// Полноэкранный, как редактор семплов. Правит n.song на месте — плеер узла слышит правки сразу.
// Отмена — снимки песни; паттерны копируются при первой записи после снимка (copy-on-write),
// данные семплов никогда не меняются на месте, только заменяются новым массивом.
const TRK_PIANO = {                          // ev.code → полутон от базовой октавы (раскладка FT2)
  KeyZ:0,KeyS:1,KeyX:2,KeyD:3,KeyC:4,KeyV:5,KeyG:6,KeyB:7,KeyH:8,KeyN:9,KeyJ:10,KeyM:11,
  Comma:12,KeyL:13,Period:14,Semicolon:15,Slash:16,
  KeyQ:12,Digit2:13,KeyW:14,Digit3:15,KeyE:16,KeyR:17,Digit5:18,KeyT:19,Digit6:20,KeyY:21,Digit7:22,KeyU:23,
  KeyI:24,Digit9:25,KeyO:26,Digit0:27,KeyP:28,BracketLeft:29,Equal:30,BracketRight:31 };
const TRK_COLX = [0,4,5,7,8,9];              // позиция подколонки в символах: нота, семпл×2, эффект, параметр×2
let TrkClip = null;                          // буфер обмена блоков {w,h,cells}
const TRK_FX = {0:'arpeggio',1:'porta up',2:'porta down',3:'tone porta',4:'vibrato',5:'tone porta + vol slide',
  6:'vibrato + vol slide',7:'tremolo',8:'panning',9:'sample offset',10:'volume slide',11:'position jump',
  12:'set volume',13:'pattern break',15:'speed / tempo'};
const TRK_EFX = {0:'filter',1:'fine porta up',2:'fine porta down',3:'glissando',4:'vibrato waveform',5:'set finetune',
  6:'pattern loop',7:'tremolo waveform',8:'panning',9:'retrigger',10:'fine vol up',11:'fine vol down',12:'note cut',
  13:'note delay',14:'pattern delay',15:'invert loop'};

function trkOpen(n){
  if(n.T){ n.T.ui.root.focus?.(); return n.T; }
  const T = { n, song:n.song, pl:n.pl, ord:0, row:0, ch:0, col:0, hs:0, oct:2, step:1, edit:false, follow:true,
              inst:1, sel:null, anchor:null, undo:[], redo:[], fresh:new Set(), raf:0, tab:'song',
              msg:'', msgT:0, g:null, sub:null, wheel:0 };
  n.T = T;
  trkBuildUI(T);
  trkDraw(T, true);
  return T;
}
function trkClose(T, force){
  if(T.sub && !force) return;
  if(T.sub){ try{ aedClose(T.sub); }catch(e){} T.sub = null; }
  window.removeEventListener('keydown', T.onKey, true);
  T.ro.disconnect();
  cancelAnimationFrame(T.raf); T.raf = 0;
  T.ui.root.remove();
  if(T.n.saveT) trkSave(T.n);
  T.n.T = null;
  redraw(T.n);
}

/* ---------- UI ---------- */
function trkBuildUI(T){
  const root = document.createElement('div');
  root.className = 'trk';
  const btn = (a,t,title,cls='')=>`<button class="aed-b ${cls}" data-a="${a}" title="${title}">${t}</button>`;
  const keys = [];
  for(let o=0;o<2;o++) for(let k=0;k<12;k++){
    const blk = [1,3,6,8,10].includes(k);
    const nm = MOD_NN[k].replace('-','');
    keys.push(`<button class="trk-pk${blk?' blk':''}" data-a="note" data-v="${o*12+k}">${o ? nm.toLowerCase() : nm}</button>`);
  }
  root.innerHTML = `
    <div class="aed-head">
      ${btn('close','✕','Close (Esc)')}
      <input class="aed-name trk-title" type="text" spellcheck="false" maxlength="20" title="Song title">
      <span class="aed-info trk-info"></span>
      ${btn('open','⭱ .mod','Open a .mod file')}
      ${btn('savemod','⭳ .mod','Download as .mod','aed-pri')}
      ${btn('new','new','New empty song')}
      <input class="trk-file" type="file" accept=".mod,.MOD,.nst,.m15,.stk" hidden>
      <input class="trk-sfile" type="file" accept="audio/*,.wav,.mp3,.ogg,.flac,.aif,.aiff,.raw,.8svx,.iff" hidden>
    </div>
    <div class="aed-row trk-tr">
      ${btn('playsong','▶ song','Play song from this position (Space)','aed-play')}
      ${btn('playpat','▶ pat','Loop this pattern from the cursor row (Shift+Space)')}
      ${btn('stop','■','Stop')}
      ${btn('edit','● edit','Edit mode: keys write notes (Enter)')}
      ${btn('follow','⇣ follow','Cursor follows playback')}
      <span class="trk-lab">oct</span>${btn('octdn','−','Octave down (F1…F4 set it)')}<b class="trk-oct"></b>${btn('octup','+','Octave up')}
      <span class="trk-lab">step</span>${btn('stepdn','−','Rows to advance after a note')}<b class="trk-step"></b>${btn('stepup','+','Edit step up')}
      ${btn('undo','↶','Undo (Ctrl+Z)')}${btn('redo','↷','Redo (Ctrl+Shift+Z)')}
      <span class="trk-pos"></span>
    </div>
    <div class="trk-body">
      <div class="trk-main"><canvas class="trk-cv"></canvas></div>
      <div class="trk-side">
        <div class="trk-tabs">
          <button class="trk-tab" data-tab="song">Song</button>
          <button class="trk-tab" data-tab="smp">Samples</button>
          <button class="trk-tab" data-tab="keys">Keys</button>
        </div>
        <div class="trk-pane" data-p="song">
          <div class="aed-row">
            ${btn('posins','+ pos','Insert a position after this one')}${btn('posdel','− pos','Delete this position')}
            ${btn('patdn','pat −','Previous pattern number at this position')}${btn('patup','pat +','Next pattern number (a new empty one after the last)')}
          </div>
          <div class="aed-row">
            ${btn('patnew','new pat','Put a new empty pattern at this position')}${btn('patclone','clone','Copy of this pattern as a new one, put here')}
            ${btn('patclear','clear','Clear this pattern')}
          </div>
          <div class="trk-grid">
            <label>restart<input type="number" class="trk-restart" min="0" max="127"></label>
            <label>channels<select class="trk-chn">${[2,4,6,8,10,12,16,24,32].map(v=>`<option>${v}</option>`).join('')}</select></label>
          </div>
          <div class="trk-ords"></div>
        </div>
        <div class="trk-pane" data-p="smp">
          <div class="trk-slist"></div>
          <div class="trk-sed">
            <input class="aed-name trk-sname" type="text" spellcheck="false" maxlength="22" placeholder="sample name">
            <canvas class="trk-wave"></canvas>
            <div class="trk-grid">
              <label>volume<input type="number" class="trk-svol" min="0" max="64"></label>
              <label>finetune<input type="number" class="trk-sft" min="-8" max="7"></label>
              <label>loop start<input type="number" class="trk-sls" min="0" step="2"></label>
              <label>loop length<input type="number" class="trk-sll" min="0" step="2"></label>
            </div>
            <div class="aed-row trk-wrap">
              ${btn('splay','▶','Play the sample on the cursor channel')}
              ${btn('sload','load','Load an audio file into this slot (resampled for C-3)')}
              ${btn('sedit','✎ edit','Open in the sample editor')}
              ${btn('sloop','loop','Loop on/off')}
              ${btn('swav','⭳ wav','Download as WAV')}
              ${btn('sclear','clear','Empty this slot')}
              <span class="trk-sinfo"></span>
            </div>
          </div>
        </div>
        <div class="trk-pane" data-p="keys">
          <div class="trk-piano">${keys.join('')}</div>
          <div class="trk-hex">${[...'0123456789ABCDEF'].map((h,i)=>`<button class="trk-k" data-a="hex" data-v="${i}">${h}</button>`).join('')}</div>
          <div class="trk-kb">
            <button class="trk-k" data-a="up">↑</button><button class="trk-k" data-a="down">↓</button>
            <button class="trk-k" data-a="left">←</button><button class="trk-k" data-a="right">→</button>
            <button class="trk-k" data-a="tab">ch ⇥</button><button class="trk-k" data-a="del">del</button>
            <button class="trk-k" data-a="ins">ins row</button><button class="trk-k" data-a="bksp">del row</button>
            <button class="trk-k" data-a="mark">mark</button><button class="trk-k" data-a="copy">copy</button>
            <button class="trk-k" data-a="cut">cut</button><button class="trk-k" data-a="paste">paste</button>
            <button class="trk-k" data-a="tdn">−1</button><button class="trk-k" data-a="tup">+1</button>
            <button class="trk-k" data-a="tdn12">−12</button><button class="trk-k" data-a="tup12">+12</button>
          </div>
        </div>
      </div>
    </div>
    <div class="aed-stat"><span class="trk-msg"></span><span class="trk-hint"></span></div>`;
  document.body.append(root);
  const q = s=>root.querySelector(s);
  T.ui = { root, cv:q('.trk-cv'), main:q('.trk-main'), title:q('.trk-title'), info:q('.trk-info'), pos:q('.trk-pos'),
    oct:q('.trk-oct'), step:q('.trk-step'), msg:q('.trk-msg'), hint:q('.trk-hint'), ords:q('.trk-ords'),
    restart:q('.trk-restart'), chn:q('.trk-chn'), slist:q('.trk-slist'), sname:q('.trk-sname'), wave:q('.trk-wave'),
    svol:q('.trk-svol'), sft:q('.trk-sft'), sls:q('.trk-sls'), sll:q('.trk-sll'), sinfo:q('.trk-sinfo'),
    file:q('.trk-file'), sfile:q('.trk-sfile') };
  const U = T.ui;
  // кнопки не забирают фокус — иначе пробел/стрелки уходят в кнопку, а не в редактор
  root.addEventListener('pointerdown', ev=>{ if(ev.target.closest('button')) ev.preventDefault(); });
  root.addEventListener('click', ev=>{
    const tb = ev.target.closest('.trk-tab');
    if(tb){ T.tab = tb.dataset.tab; trkPanels(T); return; }
    const b = ev.target.closest('[data-a]');
    if(b) trkAction(T, b.dataset.a, b.dataset.v!=null ? +b.dataset.v : undefined);
  });
  U.title.addEventListener('input', ()=>trkChange(T, 'title', ()=>{ T.song.title = U.title.value; }, 'title'));
  U.restart.addEventListener('change', ()=>trkChange(T, 'restart', ()=>{ T.song.restart = clamp(+U.restart.value|0,0,127); }));
  U.chn.addEventListener('change', ()=>trkSetChannels(T, +U.chn.value));
  U.file.addEventListener('change', ()=>{ const f=U.file.files[0]; U.file.value=''; if(f) trkLoadFile(T.n, f); });
  U.sfile.addEventListener('change', ()=>{ const f=U.sfile.files[0]; U.sfile.value=''; if(f) trkImportSample(T, f); });
  const smpField = (el, fn)=>el.addEventListener('change', ()=>{ const s=trkSmp(T); trkChange(T, 'sample', ()=>{ fn(s, el); modFixLoop(s); }); trkPanels(T); });
  U.sname.addEventListener('input', ()=>{ const s=trkSmp(T); trkChange(T, 'sample name', ()=>{ s.name = U.sname.value; }, 'sname'+T.inst); trkSampleList(T); });
  smpField(U.svol, (s,el)=>{ s.vol = clamp(+el.value|0,0,64); });
  smpField(U.sft, (s,el)=>{ s.ft = clamp(+el.value|0,-8,7); });
  smpField(U.sls, (s,el)=>{ const ll = s.ll; s.ls = clamp(+el.value|0,0,s.data.length-2)&~1; s.ll = Math.min(ll, s.data.length-s.ls)&~1; });
  smpField(U.sll, (s,el)=>{ s.ll = clamp(+el.value|0,0,s.data.length-s.ls)&~1; });
  root.addEventListener('dragover', ev=>ev.preventDefault());
  root.addEventListener('drop', ev=>{
    ev.preventDefault();
    const f = ev.dataTransfer.files?.[0]; if(!f) return;
    if(/\.(mod|nst|m15|stk)$/i.test(f.name)) trkLoadFile(T.n, f);
    else trkImportSample(T, f);
  });
  T.onKey = ev=>trkKey(T, ev);
  window.addEventListener('keydown', T.onKey, true);
  T.ro = new ResizeObserver(()=>{ trkDraw(T); trkWave(T); });
  T.ro.observe(U.main); T.ro.observe(U.wave);
  trkBindPattern(T);
  trkBindWave(T);
  trkPanels(T);
}
function trkSmp(T){ return T.song.samples[T.inst-1]; }
function trkMsg(T, m){ T.msg = m; T.msgT = performance.now(); trkDraw(T); setTimeout(()=>trkDraw(T), 3100); }

// Панели справа: заполнить из песни
function trkPanels(T){
  const U = T.ui, s = T.song;
  U.root.querySelectorAll('.trk-tab').forEach(b=>b.classList.toggle('on', b.dataset.tab===T.tab));
  U.root.querySelectorAll('.trk-pane').forEach(p=>p.classList.toggle('on', p.dataset.p===T.tab));
  if(document.activeElement!==U.title) U.title.value = s.title;
  U.restart.value = s.restart; U.chn.value = s.ch;
  if(![...U.chn.options].some(o=>+o.value===s.ch)) U.chn.insertAdjacentHTML('beforeend', `<option>${s.ch}</option>`), U.chn.value = s.ch;
  trkOrders(T);
  trkSampleList(T);
  trkSampleEd(T);
  trkDraw(T, true);
}
function trkOrders(T){
  const s = T.song, box = T.ui.ords, playing = T.pl.playing ? trkShown(T.n).ord : -1;
  let h = '';
  s.orders.forEach((p,i)=>{
    h += `<div class="trk-ord${i===T.ord?' on':''}${i===playing?' pl':''}" data-o="${i}"><span>${modHex(i,2)}</span><b>${modHex(p,2)}</b></div>`;
  });
  box.innerHTML = h;
  if(!box._wired){
    box._wired = true;
    box.addEventListener('click', ev=>{
      const e = ev.target.closest('[data-o]'); if(!e) return;
      T.ord = +e.dataset.o; T.follow = T.follow && !T.pl.playing; trkOrders(T); trkDraw(T, true);
    });
  }
  box.querySelector('.on')?.scrollIntoView({block:'nearest'});
}
function trkSampleList(T){
  const box = T.ui.slist;
  let h = '';
  T.song.samples.forEach((s,i)=>{
    h += `<div class="trk-si${i+1===T.inst?' on':''}${s.data.length?'':' empty'}" data-i="${i+1}"><span>${modHex(i+1,2)}</span>`+
         `<span class="trk-sn">${escapeHtml(s.name||'')}</span><span>${s.data.length||''}</span></div>`;
  });
  box.innerHTML = h;
  if(!box._wired){
    box._wired = true;
    box.addEventListener('click', ev=>{
      const e = ev.target.closest('[data-i]'); if(!e) return;
      T.inst = +e.dataset.i; trkSampleList(T); trkSampleEd(T); trkDraw(T);
    });
  }
  box.querySelector('.on')?.scrollIntoView({block:'nearest'});
}
function trkSampleEd(T){
  const U = T.ui, s = trkSmp(T);
  if(document.activeElement!==U.sname) U.sname.value = s.name;
  U.svol.value = s.vol; U.sft.value = s.ft; U.sls.value = s.ls; U.sll.value = s.ll;
  U.sls.max = Math.max(0, s.data.length-2); U.sll.max = s.data.length;
  U.root.querySelector('[data-a=sloop]').classList.toggle('on', s.ll>2);
  U.sinfo.textContent = 'sample '+modHex(T.inst,2)+' · '+s.data.length+' bytes' + (s.data.length ? ' · '+(s.data.length/MOD_C3_RATE).toFixed(2)+' s at C-3' : '');
  trkWave(T);
}

/* ---------- правки ---------- */
function trkSnap(s){
  return { title:s.title, ch:s.ch, orders:s.orders.slice(), restart:s.restart, patterns:s.patterns.slice(),
           samples:s.samples.map(x=>({name:x.name, data:x.data, vol:x.vol, ft:x.ft, ls:x.ls, ll:x.ll})),
           cur:null };
}
function trkRestore(T, sn){
  const s = T.song;
  s.title = sn.title; s.ch = sn.ch; s.orders = sn.orders.slice(); s.restart = sn.restart; s.patterns = sn.patterns.slice();
  sn.samples.forEach((x,i)=>Object.assign(s.samples[i], x));
  s.rev++;
  T.fresh.clear();
  T.ord = clamp(T.ord, 0, s.orders.length-1); T.ch = clamp(T.ch, 0, s.ch-1);
}
// Правка: снимок до неё (merge — ключ для слияния подряд идущих правок одного поля, напр. набор имени)
function trkChange(T, label, fn, merge){
  const now = performance.now();
  if(!(merge && T.lastMerge===merge && now-T.lastMergeT<1500)){
    T.undo.push(trkSnap(T.song)); if(T.undo.length>300) T.undo.shift();
    T.fresh.clear();
  }
  T.lastMerge = merge; T.lastMergeT = now;
  T.redo.length = 0;
  fn();
  T.song.rev++;
  modPlayerChannels(T.pl);
  trkSaveSoon(T.n);
  trkDraw(T);
  redraw(T.n);
}
function trkUndo(T, redo){
  const from = redo ? T.redo : T.undo, to = redo ? T.undo : T.redo;
  if(!from.length) return;
  to.push(trkSnap(T.song));
  trkRestore(T, from.pop());
  T.lastMerge = null;
  modPlayerChannels(T.pl);
  trkSaveSoon(T.n);
  trkPanels(T);
}
function trkPatIdx(T){ return T.song.orders[T.ord]; }
function trkPatW(T, idx=trkPatIdx(T)){         // паттерн для записи: копия при первой записи после снимка
  const s = T.song;
  while(s.patterns.length<=idx) s.patterns.push(new Uint8Array(MOD_ROWS*s.ch*4));
  if(!T.fresh.has(idx)){ s.patterns[idx] = s.patterns[idx].slice(); T.fresh.add(idx); }
  return s.patterns[idx];
}
function trkCell(T, r=T.row, c=T.ch){ return (r*T.song.ch+c)*4; }
function trkSelRect(T){
  if(!T.sel) return {c0:T.ch, c1:T.ch, r0:T.row, r1:T.row};
  const a = T.sel;
  return {c0:Math.min(a.c0,a.c1), c1:Math.max(a.c0,a.c1), r0:Math.min(a.r0,a.r1), r1:Math.max(a.r0,a.r1)};
}
function trkMove(T, dr, dc, extend){
  const s = T.song;
  if(extend){ if(!T.sel) T.sel = {c0:T.ch, r0:T.row, c1:T.ch, r1:T.row}; }
  else if(!T.anchor) T.sel = null;
  if(dr) T.row = ((T.row+dr)%MOD_ROWS+MOD_ROWS)%MOD_ROWS;
  if(dc){
    let k = T.ch*6+T.col+dc, tot = s.ch*6;
    k = ((k%tot)+tot)%tot; T.ch = Math.floor(k/6); T.col = k%6;
  }
  if(T.sel && (extend || T.anchor)){ T.sel.c1 = T.ch; T.sel.r1 = T.row; }
  trkDraw(T);
}
function trkNote(T, semi){
  const note = clamp(T.oct*12+semi, 0, MOD_NOTES-1);
  modPreview(T.pl, T.ch, note, T.inst);
  trkEnsureEngine();
  if(!T.edit){ trkDraw(T); return; }
  trkChange(T, 'note', ()=>{
    const p = trkPatW(T), o = trkCell(T);
    p[o] = note+1; p[o+1] = T.inst;
  });
  trkMove(T, T.step, 0);
}
function trkHex(T, v){
  if(!T.edit || T.col===0) return;
  trkChange(T, 'hex', ()=>{
    const p = trkPatW(T), o = trkCell(T);
    if(T.col===1) p[o+1] = Math.min(31, (Math.min(v,1)<<4)|(p[o+1]&15));
    else if(T.col===2) p[o+1] = Math.min(31, (p[o+1]&0xF0)|v);
    else if(T.col===3) p[o+2] = v;
    else if(T.col===4) p[o+3] = (v<<4)|(p[o+3]&15);
    else p[o+3] = (p[o+3]&0xF0)|v;
  });
  // внутри поля — вправо, после последней цифры поля — вниз на шаг и к началу поля
  if(T.col===1 || T.col===3 || T.col===4) T.col++;
  else { T.col = T.col===2 ? 1 : 3; trkMove(T, T.step, 0); }
  trkDraw(T);
}
function trkClearSel(T){
  const r = trkSelRect(T), whole = !!T.sel;
  trkChange(T, 'clear', ()=>{
    const p = trkPatW(T);
    for(let row=r.r0;row<=r.r1;row++) for(let c=r.c0;c<=r.c1;c++){
      const o = trkCell(T,row,c);
      if(whole) p.fill(0,o,o+4);
      else if(T.col<=2){ p[o] = 0; p[o+1] = 0; }
      else { p[o+2] = 0; p[o+3] = 0; }
    }
  });
  if(!whole) trkMove(T, T.step, 0);
}
function trkShiftRows(T, ins){                // вставка/удаление строки в канале (или в выделенных каналах)
  const r = trkSelRect(T);
  trkChange(T, ins?'insert row':'delete row', ()=>{
    const p = trkPatW(T);
    for(let c=r.c0;c<=r.c1;c++){
      if(ins) for(let row=MOD_ROWS-1;row>T.row;row--) p.copyWithin(trkCell(T,row,c), trkCell(T,row-1,c), trkCell(T,row-1,c)+4);
      else for(let row=T.row;row<MOD_ROWS-1;row++) p.copyWithin(trkCell(T,row,c), trkCell(T,row+1,c), trkCell(T,row+1,c)+4);
      p.fill(0, trkCell(T, ins?T.row:MOD_ROWS-1, c), trkCell(T, ins?T.row:MOD_ROWS-1, c)+4);
    }
  });
}
function trkCopy(T, cut){
  const r = trkSelRect(T), w = r.c1-r.c0+1, h = r.r1-r.r0+1, p = T.song.patterns[trkPatIdx(T)];
  const cells = new Uint8Array(w*h*4);
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){ const o=trkCell(T,r.r0+y,r.c0+x); cells.set(p.subarray(o,o+4),(y*w+x)*4); }
  TrkClip = {w, h, cells};
  if(cut){ const had = T.sel; T.sel = {c0:r.c0,c1:r.c1,r0:r.r0,r1:r.r1}; trkClearSel(T); T.sel = had; }
  trkMsg(T, (cut?'cut ':'copied ')+w+'×'+h);
}
function trkPaste(T){
  if(!TrkClip) return;
  const {w,h,cells} = TrkClip;
  trkChange(T, 'paste', ()=>{
    const p = trkPatW(T);
    for(let y=0;y<h && T.row+y<MOD_ROWS;y++) for(let x=0;x<w && T.ch+x<T.song.ch;x++)
      p.set(cells.subarray((y*w+x)*4,(y*w+x)*4+4), trkCell(T,T.row+y,T.ch+x));
  });
}
function trkTranspose(T, d){
  const r = trkSelRect(T);
  trkChange(T, 'transpose', ()=>{
    const p = trkPatW(T);
    for(let row=r.r0;row<=r.r1;row++) for(let c=r.c0;c<=r.c1;c++){
      const o = trkCell(T,row,c); if(p[o]) p[o] = clamp(p[o]+d, 1, MOD_NOTES);
    }
  });
}
function trkSetChannels(T, nc){
  const s = T.song; if(nc===s.ch) return;
  trkChange(T, 'channels', ()=>{
    const oc = s.ch;
    s.patterns = s.patterns.map(p=>{
      const q = new Uint8Array(MOD_ROWS*nc*4);
      for(let r=0;r<MOD_ROWS;r++) for(let c=0;c<Math.min(oc,nc);c++) q.set(p.subarray((r*oc+c)*4,(r*oc+c)*4+4),(r*nc+c)*4);
      return q;
    });
    s.ch = nc;
    T.fresh = new Set(s.patterns.map((_,i)=>i));
  });
  T.ch = Math.min(T.ch, nc-1); T.sel = null;
  trkPanels(T);
}
function trkSelectAll(T){
  const s = T.sel;
  if(s && s.c0===T.ch && s.c1===T.ch && Math.min(s.r0,s.r1)===0 && Math.max(s.r0,s.r1)===63) T.sel = {c0:0,c1:T.song.ch-1,r0:0,r1:63};
  else T.sel = {c0:T.ch,c1:T.ch,r0:0,r1:63};
  trkDraw(T);
}

function trkAction(T, a, v){
  const s = T.song, pl = T.pl, n = T.n;
  switch(a){
    case 'close': return trkClose(T);
    case 'open': T.ui.file.click(); return;
    case 'savemod': {
      trkSave(n);
      dl(new Blob([modWrite(s)],{type:'audio/x-mod'}), (s.title||'untitled').replace(/[\\/:*?"<>|]/g,'_').trim()+'.mod');
      return;
    }
    case 'new':
      if(!confirm('Start a new empty song? (Undo brings the old one back)')) return;
      trkStopPlay(n);
      trkChange(T, 'new song', ()=>{ const e = modNewSong(s.ch); modAssign(s, e); });
      T.ord = 0; T.row = 0; T.sel = null; T.fresh.clear(); trkPanels(T); return;
    case 'playsong': if(pl.playing) trkStopPlay(n); else trkPlay(n, 'song', T.ord, 0); T.follow = true; break;
    case 'playpat': trkPlay(n, 'pattern', T.ord, T.row); T.follow = true; break;
    case 'stop': trkStopPlay(n); break;
    case 'edit': T.edit = !T.edit; break;
    case 'follow': T.follow = !T.follow; break;
    case 'octdn': T.oct = Math.max(0, T.oct-1); break;
    case 'octup': T.oct = Math.min(3, T.oct+1); break;
    case 'stepdn': T.step = Math.max(0, T.step-1); break;
    case 'stepup': T.step = Math.min(16, T.step+1); break;
    case 'undo': return trkUndo(T, false);
    case 'redo': return trkUndo(T, true);
    case 'posins': trkChange(T, 'insert position', ()=>{ if(s.orders.length<128) s.orders.splice(T.ord+1, 0, s.orders[T.ord]); }); T.ord = Math.min(T.ord+1, s.orders.length-1); trkOrders(T); break;
    case 'posdel': if(s.orders.length>1){ trkChange(T, 'delete position', ()=>{ s.orders.splice(T.ord,1); }); T.ord = Math.min(T.ord, s.orders.length-1); trkOrders(T); } break;
    case 'patdn': trkChange(T, 'pattern', ()=>{ s.orders[T.ord] = Math.max(0, s.orders[T.ord]-1); }); trkOrders(T); break;
    case 'patup': trkChange(T, 'pattern', ()=>{ const p = Math.min(99, s.orders[T.ord]+1); trkPatW(T, p); s.orders[T.ord] = p; }); trkOrders(T); break;
    case 'patnew': trkChange(T, 'new pattern', ()=>{ const i = s.patterns.length; if(i>99) return; trkPatW(T, i); s.orders[T.ord] = i; }); trkOrders(T); break;
    case 'patclone': trkChange(T, 'clone pattern', ()=>{ const i = s.patterns.length; if(i>99) return; s.patterns.push(s.patterns[trkPatIdx(T)].slice()); T.fresh.add(i); s.orders[T.ord] = i; }); trkOrders(T); break;
    case 'patclear': trkChange(T, 'clear pattern', ()=>{ trkPatW(T).fill(0); }); break;
    case 'note': trkNote(T, v); return;
    case 'hex': trkHex(T, v); return;
    case 'up': trkMove(T, -1, 0); return;
    case 'down': trkMove(T, 1, 0); return;
    case 'left': trkMove(T, 0, -1); return;
    case 'right': trkMove(T, 0, 1); return;
    case 'tab': T.ch = (T.ch+1)%s.ch; T.col = 0; break;
    case 'del': trkClearSel(T); return;
    case 'ins': trkShiftRows(T, true); return;
    case 'bksp': trkShiftRows(T, false); return;
    case 'mark':
      if(T.anchor){ T.anchor = null; }
      else { T.anchor = true; T.sel = {c0:T.ch, r0:T.row, c1:T.ch, r1:T.row}; }
      break;
    case 'copy': trkCopy(T, false); T.anchor = null; return;
    case 'cut': trkCopy(T, true); T.anchor = null; T.sel = null; return;
    case 'paste': trkPaste(T); return;
    case 'tup': trkTranspose(T, 1); return;
    case 'tdn': trkTranspose(T, -1); return;
    case 'tup12': trkTranspose(T, 12); return;
    case 'tdn12': trkTranspose(T, -12); return;
    case 'splay': { const sm = trkSmp(T); if(!sm.data.length) return; trkEnsureEngine(); modPreview(pl, T.ch, T.oct*12+12, T.inst); return; }
    case 'sload': T.ui.sfile.click(); return;
    case 'sedit': trkEditSample(T); return;
    case 'sloop': {
      const sm = trkSmp(T); if(!sm.data.length) return;
      trkChange(T, 'loop', ()=>{ if(sm.ll>2){ sm.ll = 0; sm.ls = 0; } else { sm.ls = 0; sm.ll = sm.data.length&~1; } });
      trkSampleEd(T); return;
    }
    case 'swav': {
      const sm = trkSmp(T); if(!sm.data.length) return;
      dl(aedWavBlob(Float32Array.from(sm.data, x=>x/128), Math.round(MOD_C3_RATE)), (sm.name||'sample'+T.inst).replace(/[\\/:*?"<>|]/g,'_').trim()+'.wav');
      return;
    }
    case 'sclear': {
      const sm = trkSmp(T); if(!sm.data.length && !sm.name) return;
      trkChange(T, 'clear sample', ()=>{ Object.assign(sm, modEmptySample()); });
      trkSampleList(T); trkSampleEd(T); return;
    }
  }
  trkDraw(T);
}

/* ---------- семплы ---------- */
function trkQuantize(f){
  const len = Math.min(f.length, 131070), d = new Int8Array(len + (len&1));
  for(let i=0;i<len;i++) d[i] = clamp(Math.round(f[i]*127), -128, 127);
  return d;
}
async function trkImportSample(T, file){
  try{
    trkMsg(T, 'decoding '+file.name+'…');
    const {samples, sr} = await decodeAudioFile(file);
    const rs = aedResample(samples, sr, MOD_C3_RATE);
    let pk = 0; for(let i=0;i<rs.length;i++){ const a=Math.abs(rs[i]); if(a>pk) pk=a; }
    if(pk>1) for(let i=0;i<rs.length;i++) rs[i] /= pk;
    const sm = trkSmp(T);
    trkChange(T, 'load sample', ()=>{
      sm.data = trkQuantize(rs); sm.name = file.name.replace(/\.[^.]+$/,'').slice(0,22);
      sm.vol = 64; sm.ft = 0; sm.ls = 0; sm.ll = 0;
    });
    trkMsg(T, rs.length>131070 ? 'sample cut to 131070 bytes (MOD limit)' : 'loaded '+sm.name);
    trkSampleList(T); trkSampleEd(T);
  }catch(e){ console.warn(e); trkMsg(T, 'could not decode '+file.name); }
}
function trkEditSample(T){
  const sm = trkSmp(T), inst = T.inst;
  const clip = { id:null, folderId:null, name:sm.name||('sample '+modHex(inst,2)), sr:Math.round(MOD_C3_RATE),
                 samples:Float32Array.from(sm.data, x=>x/128) };
  T.sub = aedOpen(clip, {
    save:E=>{
      const s = T.song.samples[inst-1];
      trkChange(T, 'edit sample', ()=>{
        s.data = trkQuantize(E.s); s.name = (E.name||'').slice(0,22);
        modFixLoop(s);
      });
    },
    onClose:()=>{ T.sub = null; trkPanels(T); },
  });
}
function trkWave(T){
  const cv = T.ui.wave; if(!cv || !cv.clientWidth) return;
  const dpr = window.devicePixelRatio||1, W = cv.clientWidth, H = cv.clientHeight;
  if(cv.width!==Math.round(W*dpr) || cv.height!==Math.round(H*dpr)){ cv.width = Math.round(W*dpr); cv.height = Math.round(H*dpr); }
  const g = cv.getContext('2d'); g.setTransform(dpr,0,0,dpr,0,0);
  g.fillStyle = themeColor('--screen'); g.fillRect(0,0,W,H);
  const s = trkSmp(T), d = s.data, len = d.length;
  g.fillStyle = themeColor('--grid'); g.fillRect(0, H/2, W, 1);
  if(!len){ g.fillStyle = themeColor('--axis'); g.font = '11px '+themeColor('--mono'); g.fillText('empty — load or drop an audio file', 8, H/2-6); return; }
  if(s.ll>2){
    const x0 = s.ls/len*W, x1 = (s.ls+s.ll)/len*W;
    g.fillStyle = 'rgba(224,178,60,.16)'; g.fillRect(x0, 0, x1-x0, H);
    g.fillStyle = themeColor('--acc');
    for(const x of [x0,x1]){ g.fillRect(x-1, 0, 2, H); g.beginPath(); g.moveTo(x-7,H); g.lineTo(x+7,H); g.lineTo(x,H-11); g.fill(); }
  }
  g.strokeStyle = themeColor('--acc2'); g.beginPath();
  for(let x=0;x<W;x++){
    const i0 = Math.floor(x/W*len), i1 = Math.max(i0+1, Math.floor((x+1)/W*len));
    let lo = 127, hi = -128;
    for(let i=i0;i<i1 && i<len;i++){ const v=d[i]; if(v<lo) lo=v; if(v>hi) hi=v; }
    g.moveTo(x+.5, H/2 - hi/128*H/2*0.95); g.lineTo(x+.5, H/2 - lo/128*H/2*0.95 + 1);
  }
  g.stroke();
  // позиция воспроизведения в каналах с этим семплом
  g.fillStyle = themeColor('--hi');
  for(const c of T.pl.chn) if(c.active && c.smp===T.inst) g.fillRect(c.pos/len*W, 0, 1, H);
}
function trkBindWave(T){                       // перетаскивание краёв петли
  const cv = T.ui.wave;
  let drag = null;
  const at = ev=>{ const r = cv.getBoundingClientRect(), s = trkSmp(T); return clamp((ev.clientX-r.left)/r.width,0,1)*s.data.length; };
  cv.addEventListener('pointerdown', ev=>{
    const s = trkSmp(T); if(!s.data.length) return;
    const p = at(ev), tol = s.data.length/cv.clientWidth*14;
    let edge = null;
    if(s.ll>2){ if(Math.abs(p-s.ls)<tol) edge = 'a'; else if(Math.abs(p-(s.ls+s.ll))<tol) edge = 'b'; }
    if(!edge){ edge = 'b'; if(s.ll<=2){ edge = 'new'; } }
    drag = {edge, p0:p, first:true};
    cv.setPointerCapture(ev.pointerId);
  });
  cv.addEventListener('pointermove', ev=>{
    if(!drag) return;
    const s = trkSmp(T), p = Math.round(at(ev))&~1, len = s.data.length&~1;
    if(drag.first){ T.undo.push(trkSnap(T.song)); T.redo.length = 0; T.fresh.clear(); drag.first = false; }
    if(drag.edge==='new'){ const a = Math.min(drag.p0&~1, p), b = Math.max(drag.p0&~1, p); s.ls = a; s.ll = b-a; }
    else if(drag.edge==='a'){ const end = s.ls+s.ll; s.ls = clamp(p, 0, end-4); s.ll = end-s.ls; }
    else { s.ll = clamp(p, s.ls+4, len) - s.ls; }
    T.song.rev++; trkSaveSoon(T.n); trkSampleEd(T);
  });
  const end = ()=>{ if(drag){ const s = trkSmp(T); if(s.ll<=2){ s.ll = 0; s.ls = 0; } drag = null; trkSampleEd(T); } };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
}

/* ---------- клавиатура ---------- */
function trkKey(T, ev){
  if(T.sub || !T.ui) return;                 // поверх открыт редактор семпла — клавиши его
  const t = ev.target;
  const typing = t && (t.tagName==='INPUT' && t.type!=='checkbox' && t.type!=='file' || t.tagName==='TEXTAREA' || t.tagName==='SELECT');
  ev.stopPropagation();
  if(typing){ if(ev.key==='Escape' || ev.key==='Enter') t.blur(); return; }
  const code = ev.code, mod = ev.ctrlKey||ev.metaKey;
  const done = ()=>{ ev.preventDefault(); };
  if(mod){
    const m = {KeyZ:ev.shiftKey?'redo':'undo', KeyY:'redo', KeyC:'copy', KeyX:'cut', KeyV:'paste'}[code];
    if(m){ done(); trkAction(T, m); return; }
    if(code==='KeyA'){ done(); trkSelectAll(T); return; }
    if(code==='KeyS'){ done(); trkSave(T.n); trkMsg(T, 'saved in this browser'); return; }
    if(code==='ArrowUp' || code==='ArrowDown'){ done(); trkTranspose(T, (code==='ArrowUp'?1:-1)*(ev.shiftKey?12:1)); return; }
    return;
  }
  if(ev.altKey) return;
  if(/^F[1-4]$/.test(ev.key)){ done(); T.oct = +ev.key[1]-1; trkDraw(T); return; }
  switch(code){
    case 'Escape': done(); if(T.sel || T.anchor){ T.sel = null; T.anchor = null; trkDraw(T); } else trkClose(T); return;
    case 'Space': done(); if(ev.repeat) return; trkAction(T, ev.shiftKey ? 'playpat' : (T.pl.playing ? 'stop' : 'playsong')); return;
    case 'Enter': case 'NumpadEnter': done(); trkAction(T, 'edit'); return;
    case 'ArrowUp': done(); trkMove(T, -1, 0, ev.shiftKey); return;
    case 'ArrowDown': done(); trkMove(T, 1, 0, ev.shiftKey); return;
    case 'ArrowLeft': done(); trkMove(T, 0, ev.shiftKey?-6:-1, false); return;
    case 'ArrowRight': done(); trkMove(T, 0, ev.shiftKey?6:1, false); return;
    case 'PageUp': done(); trkMove(T, Math.max(0,T.row-16)-T.row, 0, ev.shiftKey); return;
    case 'PageDown': done(); trkMove(T, Math.min(63,T.row+16)-T.row, 0, ev.shiftKey); return;
    case 'Home': done(); trkMove(T, -T.row, 0, ev.shiftKey); return;
    case 'End': done(); trkMove(T, 63-T.row, 0, ev.shiftKey); return;
    case 'Tab': done(); T.ch = (T.ch+(ev.shiftKey?T.song.ch-1:1))%T.song.ch; T.col = 0; if(!T.anchor) T.sel = null; trkDraw(T); return;
    case 'Delete': done(); trkClearSel(T); return;
    case 'Insert': done(); trkShiftRows(T, true); return;
    case 'Backspace': done(); trkShiftRows(T, false); return;
  }
  if(T.col===0){
    const semi = TRK_PIANO[code];
    if(semi!=null){ done(); if(!ev.repeat) trkNote(T, semi); return; }
  } else {
    let v = -1;
    if(/^(Digit|Numpad)[0-9]$/.test(code)) v = +code.slice(-1);
    else if(/^Key[A-F]$/.test(code)) v = code.charCodeAt(3)-55;
    if(v>=0){ done(); trkHex(T, v); return; }
  }
  if(code==='NumpadAdd'){ done(); T.oct = Math.min(3,T.oct+1); trkDraw(T); }
  else if(code==='NumpadSubtract'){ done(); T.oct = Math.max(0,T.oct-1); trkDraw(T); }
}

/* ---------- паттерн: геометрия и отрисовка ---------- */
function trkMetrics(T){
  const U = T.ui, W = U.main.clientWidth, H = U.main.clientHeight;
  const fs = TOUCH ? 14 : 13, rh = fs+(TOUCH?8:5), cw = Math.round(fs*0.6*10)/10;
  const HH = 24, numW = 3*cw+6, chW = 10*cw+14;
  const vis = Math.max(1, Math.floor((W-numW)/chW));
  if(T.ch<T.hs) T.hs = T.ch;
  if(T.ch>=T.hs+vis) T.hs = T.ch-vis+1;
  T.hs = clamp(T.hs, 0, Math.max(0, T.song.ch-vis));
  const cy = HH + Math.floor((H-HH)/2/rh)*rh;       // верх строки курсора
  return {W, H, fs, rh, cw, HH, numW, chW, vis, cy};
}
function trkHit(T, x, y){
  const M = trkMetrics(T);
  const k = Math.floor((x-M.numW)/M.chW);
  const ch = clamp(T.hs+k, 0, T.song.ch-1);
  const cx = (x-M.numW-k*M.chW)/M.cw;
  let col = 0;
  if(cx>=3.5) col = cx<5 ? 1 : cx<6.5 ? 2 : cx<8 ? 3 : cx<9 ? 4 : 5;
  const row = T.row + Math.floor((y-M.cy)/M.rh);
  return {ch, col, row, head:y<M.HH, M};
}
function trkDraw(T, now){
  if(!T.ui) return;
  if(now){ cancelAnimationFrame(T.raf); T.raf = 0; trkRender(T); return; }
  if(T.raf) return;
  T.raf = requestAnimationFrame(()=>{ T.raf = 0; trkRender(T); if(T.pl.playing || T.pl.chn.some(c=>c.active)) trkDraw(T); });
}
function trkRender(T){
  const U = T.ui, s = T.song, pl = T.pl;
  if(pl.playing && T.follow){
    const sh = trkShown(T.n);
    if(sh.ord!==T.ord){ T.ord = sh.ord; trkOrders(T); }
    T.row = sh.row;
  }
  T.ord = clamp(T.ord, 0, s.orders.length-1);
  const cv = U.cv, dpr = window.devicePixelRatio||1, M = trkMetrics(T), {W,H,rh,cw,HH,numW,chW,cy} = M;
  if(!W || !H) return;
  if(cv.width!==Math.round(W*dpr) || cv.height!==Math.round(H*dpr)){ cv.width = Math.round(W*dpr); cv.height = Math.round(H*dpr); }
  const g = cv.getContext('2d'); g.setTransform(dpr,0,0,dpr,0,0);
  const C = { bg:themeColor('--panel'), bg2:themeColor('--bg'), line:themeColor('--line'), txt:themeColor('--txt'), dim:themeColor('--dim'),
              acc:themeColor('--acc'), acc2:themeColor('--acc2'), fx:themeColor('--t-spec'), err:themeColor('--err'), note:themeColor('--t-img') };
  g.fillStyle = C.bg2; g.fillRect(0,0,W,H);
  const pat = s.patterns[trkPatIdx(T)] || new Uint8Array(MOD_ROWS*s.ch*4);
  const nch = Math.min(M.vis, s.ch-T.hs);
  g.font = M.fs+'px '+themeColor('--mono'); g.textBaseline = 'middle';
  const r0 = T.row - Math.ceil((cy-HH)/rh), r1 = T.row + Math.ceil((H-cy)/rh);
  const sel = T.sel ? trkSelRect(T) : null;
  const sh = pl.playing ? trkShown(T.n) : null;
  for(let r=Math.max(0,r0); r<=Math.min(63,r1); r++){
    const y = cy + (r-T.row)*rh;
    if(r%16===0){ g.fillStyle = 'rgba(127,127,127,.16)'; g.fillRect(0,y,W,rh); }
    else if(r%4===0){ g.fillStyle = 'rgba(127,127,127,.08)'; g.fillRect(0,y,W,rh); }
    if(sh && sh.ord===T.ord && sh.row===r && !(T.follow)){ g.fillStyle = 'rgba(78,201,176,.22)'; g.fillRect(0,y,W,rh); }
    g.fillStyle = r%4 ? C.dim : C.acc;
    g.fillText(modHex(r,2), 4, y+rh/2);
    for(let k=0;k<nch;k++){
      const c = T.hs+k, x = numW+k*chW, o = (r*s.ch+c)*4;
      const nt = pat[o], sm = pat[o+1], ef = pat[o+2], pr = pat[o+3];
      const mute = pl.chn[c]?.mute;
      g.globalAlpha = mute ? .45 : 1;
      g.fillStyle = nt ? C.txt : C.line; g.fillText(nt ? modNoteName(nt-1) : '···', x, y+rh/2);
      g.fillStyle = sm ? C.acc2 : C.line; g.fillText(sm ? modHex(sm,2) : '··', x+4*cw, y+rh/2);
      g.fillStyle = ef||pr ? C.fx : C.line; g.fillText(ef||pr ? modHex(ef,1)+modHex(pr,2) : '···', x+7*cw, y+rh/2);
      g.globalAlpha = 1;
    }
  }
  // выделение
  if(sel){
    const k0 = Math.max(sel.c0, T.hs)-T.hs, k1 = Math.min(sel.c1, T.hs+nch-1)-T.hs;
    if(k1>=k0){
      const y0 = cy+(sel.r0-T.row)*rh, y1 = cy+(sel.r1+1-T.row)*rh;
      g.fillStyle = 'rgba(86,156,214,.25)'; g.fillRect(numW+k0*chW-4, y0, (k1-k0+1)*chW, y1-y0);
    }
  }
  // строка курсора и курсор
  g.fillStyle = T.edit ? 'rgba(224,92,92,.20)' : 'rgba(224,178,60,.16)'; g.fillRect(0, cy, W, rh);
  if(T.ch>=T.hs && T.ch<T.hs+nch){
    const x = numW+(T.ch-T.hs)*chW+TRK_COLX[T.col]*cw, w = (T.col===0?3:1)*cw;
    g.strokeStyle = T.edit ? C.err : C.acc; g.lineWidth = 1.5; g.strokeRect(x-1.5, cy+.5, w+3, rh-1);
  }
  // разделители каналов и шапка
  g.fillStyle = C.line;
  for(let k=0;k<=nch;k++) g.fillRect(numW+k*chW-7, HH, 1, H-HH);
  g.fillStyle = C.bg; g.fillRect(0,0,W,HH);
  g.fillStyle = C.line; g.fillRect(0,HH-1,W,1);
  g.textBaseline = 'middle';
  for(let k=0;k<nch;k++){
    const c = T.hs+k, x = numW+k*chW-4, ch = pl.chn[c], w = chW-10;
    const solo = pl.solo===c, mute = ch?.mute;
    g.fillStyle = C.bg2; g.fillRect(x, 4, w, HH-8);
    g.fillStyle = mute ? C.err : solo ? C.acc : C.acc2;
    g.globalAlpha = .55; g.fillRect(x, 4, w*clamp(ch?.vu||0,0,1), HH-8); g.globalAlpha = 1;
    g.fillStyle = mute ? C.err : C.txt;
    g.fillText((solo?'S ':mute?'M ':'')+'ch '+(c+1), x+4, HH/2);
  }
  g.fillStyle = C.dim; g.fillText(T.hs>0?'◂':'', 2, HH/2);
  if(T.hs+nch<s.ch){ g.fillStyle = C.dim; g.fillText('▸', W-10, HH/2); }
  trkStatus(T);
}
function trkStatus(T){
  const U = T.ui, s = T.song, pl = T.pl, sh = trkShown(T.n);
  U.oct.textContent = T.oct; U.step.textContent = T.step;
  U.pos.textContent = pl.playing ? `pos ${modHex(sh.ord,2)}/${modHex(s.orders.length,2)} · row ${modHex(sh.row,2)} · ${pl.bpm} bpm · spd ${pl.speed}`
                                 : `pos ${modHex(T.ord,2)} · pat ${modHex(trkPatIdx(T),2)} · row ${modHex(T.row,2)}`;
  const nPat = new Set(s.orders).size, used = s.samples.filter(x=>x.data.length).length;
  U.info.textContent = `${s.ch} ch · ${s.orders.length} pos · ${nPat} pat · ${used} smp`;
  const bset = (a,on)=>U.root.querySelector(`[data-a=${a}]`)?.classList.toggle('on',!!on);
  bset('edit', T.edit); bset('follow', T.follow); bset('playsong', pl.playing && pl.mode==='song'); bset('playpat', pl.playing && pl.mode==='pattern');
  bset('mark', T.anchor);
  U.root.querySelector('[data-a=undo]').disabled = !T.undo.length;
  U.root.querySelector('[data-a=redo]').disabled = !T.redo.length;
  const p = s.patterns[trkPatIdx(T)], o = trkCell(T);
  let hint = 'inst '+modHex(T.inst,2)+' '+(s.samples[T.inst-1].name||'');
  if(p && (p[o+2]||p[o+3])){
    const e = p[o+2], v = p[o+3];
    hint = modHex(e,1)+modHex(v,2)+': '+(e===14 ? 'E'+modHex(v>>4,1)+'x '+TRK_EFX[v>>4] : e===0 ? 'arpeggio' : TRK_FX[e]||'');
  }
  U.hint.textContent = hint;
  U.msg.textContent = performance.now()-T.msgT<3000 ? T.msg : (T.edit ? 'EDIT — keys write notes' : 'Enter: edit mode · Space: play');
  if(T.tab==='song' && pl.playing) trkOrdersLive(T);
  if(T.tab==='smp' && pl.playing) trkWave(T);
}
function trkOrdersLive(T){                      // подсветка играющей позиции без перестройки списка
  const pos = trkShown(T.n).ord;
  if(T._plOrd===pos) return; T._plOrd = pos;
  T.ui.ords.querySelectorAll('.trk-ord').forEach(e=>e.classList.toggle('pl', +e.dataset.o===pos));
}
function trkBindPattern(T){
  const cv = T.ui.cv;
  cv.addEventListener('pointerdown', ev=>{
    const r = cv.getBoundingClientRect(), x = ev.clientX-r.left, y = ev.clientY-r.top;
    const h = trkHit(T, x, y);
    cv.setPointerCapture(ev.pointerId);
    if(h.head){
      const now = performance.now(), last = T.lastHead;
      T.lastHead = {c:h.ch, t:now};
      const ch = T.pl.chn[h.ch]; if(!ch) return;
      if(last && last.c===h.ch && now-last.t<350){          // двойной — соло вместо приглушения
        ch.mute = false; T.pl.solo = T.pl.solo===h.ch ? -1 : h.ch; T.lastHead = null; }
      else ch.mute = !ch.mute;
      trkDraw(T); return;
    }
    T.g = {x, y, row:T.row, hs:T.hs, h, moved:false, touch:ev.pointerType!=='mouse'};
    if(!T.g.touch && h.row>=0 && h.row<64){
      T.ch = h.ch; T.col = h.col; T.row = h.row;
      if(ev.shiftKey){ if(!T.sel) T.sel = {c0:T.ch, r0:T.row, c1:T.ch, r1:T.row}; }
      else if(!T.anchor) T.sel = null;
      T.follow = T.follow && !T.pl.playing;
    }
    trkDraw(T);
  });
  cv.addEventListener('pointermove', ev=>{
    const G = T.g; if(!G) return;
    const r = cv.getBoundingClientRect(), x = ev.clientX-r.left, y = ev.clientY-r.top;
    if(!G.moved && Math.hypot(x-G.x, y-G.y)<6) return;
    G.moved = true;
    if(G.touch){                              // палец: прокрутка строк и каналов
      T.follow = false;
      T.row = clamp(G.row - Math.round((y-G.y)/G.h.M.rh), 0, 63);
      T.hs = clamp(G.hs - Math.round((x-G.x)/G.h.M.chW), 0, Math.max(0, T.song.ch-G.h.M.vis));
      if(T.ch<T.hs) T.ch = T.hs; else if(T.ch>=T.hs+G.h.M.vis) T.ch = T.hs+G.h.M.vis-1;
    } else {                                  // мышь: выделение блока
      const h = trkHit(T, x, y);
      if(!T.sel) T.sel = {c0:G.h.ch, r0:G.h.row, c1:h.ch, r1:h.row};
      T.sel.c1 = h.ch; T.sel.r1 = clamp(h.row,0,63);
      if(y<G.h.M.HH+8) T.row = Math.max(0, T.row-1);          // у краёв — прокрутка
      else if(y>G.h.M.H-8) T.row = Math.min(63, T.row+1);
    }
    trkDraw(T);
  });
  const up = ev=>{
    const G = T.g; T.g = null; if(!G) return;
    if(G.touch && !G.moved){
      const r = cv.getBoundingClientRect(), h = trkHit(T, ev.clientX-r.left, ev.clientY-r.top);
      if(h.row>=0 && h.row<64){ T.ch = h.ch; T.col = h.col; T.row = h.row; T.follow = T.follow && !T.pl.playing;
        if(T.anchor && T.sel){ T.sel.c1 = T.ch; T.sel.r1 = T.row; } }
    }
    trkDraw(T);
  };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  cv.addEventListener('wheel', ev=>{
    ev.preventDefault();
    if(ev.shiftKey || Math.abs(ev.deltaX)>Math.abs(ev.deltaY)){ T.ch = clamp(T.ch+Math.sign(ev.deltaX||ev.deltaY), 0, T.song.ch-1); trkDraw(T); return; }
    T.wheel += ev.deltaMode ? ev.deltaY*16 : ev.deltaY;
    const st = Math.trunc(T.wheel/40); if(!st) return;
    T.wheel -= st*40; T.follow = T.follow && !T.pl.playing;
    T.row = clamp(T.row+st, 0, 63); trkDraw(T);
  }, {passive:false});
}
