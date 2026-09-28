/* ============================ ТРЕКЕР: МОДЕЛЬ ПЕСНИ И ФОРМАТЫ ============================ */
// Общая модель для MOD / S3M / XM; чтение и запись каждого формата.
// song = {fmt:'mod'|'s3m'|'xm', title, ch, orders[], restart, speed, bpm, gvol, linear, chPan[], chVol[],
//         patterns:[{rows, d:Uint8Array(rows*ch*5)}], samples[] (mod/s3m), instruments[] (xm), rev}
// Ячейка — 5 байт: нота, инструмент, колонка громкости, эффект, параметр.
//   нота: 0 — пусто, 1..120 — нота n-1 (48 = C-4 = базовая высота семпла), 121 — key off, 122 — note cut
//   громкость: кодировка XM (0 — пусто, 0x10..0x50 — громкость 0..64, 0x60.. — команды)
//   эффект: MOD/XM — 0..35 (0..9, A..Z), S3M — 100+номер буквы (A=101…Z=126); 0/00 — пусто
// sample = {name, data:Int8Array|Int16Array, vol 0..64, pan -1|0..255, ft, rel, c2spd, ls, ll, loop 0|1|2}
//   ls/ll — в семплах; loop: 0 — нет, 1 — вперёд, 2 — туда-обратно. ft: MOD −8..7, XM −128..127
// instrument (xm) = {name, samples[], map:Uint8Array(96) — индекс в samples, venv, penv, fade, vib}
//   env = {on, sus, loop, s, ls, le, pts:[[t,v]…]}; vib = {type, sweep, depth, rate}

const TRK_CELL = 5, TRK_OFF = 121, TRK_CUT = 122;
const MOD_NOTES = 60;                     // MOD: C-0..B-4 в нотации PT (C-2 — период 428)
const MOD_PER1 = [856,808,762,720,678,640,604,570,538,508,480,453,428,404,381,360,339,320,302,285,269,254,240,226,
                  214,202,190,180,170,160,151,143,135,127,120,113];
const MOD_PER = (()=>{                    // [finetune&15][нота PT] — периоды ProTracker
  const t = new Int16Array(16*MOD_NOTES);
  for(let f=0;f<16;f++){
    const ft = f>7 ? f-16 : f;
    for(let i=0;i<MOD_NOTES;i++){
      const o = Math.floor(i/12), k = i%12;
      t[f*MOD_NOTES+i] = ft ? Math.round(856*2*Math.pow(2, -(i + ft/8)/12))
        : o===0 ? MOD_PER1[k]*2 : o===4 ? Math.round(MOD_PER1[24+k]/2) : MOD_PER1[(o-1)*12+k];
    }
  }
  return t;
})();
const MOD_NN = ['C-','C#','D-','D#','E-','F-','F#','G-','G#','A-','A#','B-'];
const TRK_EXT = {mod:'.mod', s3m:'.s3m', xm:'.xm'};
const TRK_FMT_NAME = {mod:'ProTracker MOD', s3m:'Scream Tracker 3', xm:'FastTracker 2 XM'};

function modHex(v, w){ return v.toString(16).toUpperCase().padStart(w,'0'); }
function modNoteOfPeriod(p){               // нота PT (0..59), ближайшая по логарифму периода
  if(p<=0) return -1;
  let best = 0, bd = Infinity;
  for(let i=0;i<MOD_NOTES;i++){ const d = Math.abs(Math.log(MOD_PER[i]/p)); if(d<bd){ bd=d; best=i; } }
  return best;
}
// подпись ноты; MOD показывает октавы как ProTracker (на две ниже)
function trkNoteName(song, code){
  if(!code) return '···';
  if(code===TRK_OFF) return '===';
  if(code===TRK_CUT) return '^^^';
  const n = code-1, o = Math.floor(n/12) - (song.fmt==='mod' ? 2 : 0);
  return MOD_NN[n%12] + (o<0 ? '-' : o>9 ? '+' : o);
}
function trkEffName(song, e, p){           // эффект для экрана: 'A0F' / 'G20'
  if(!e && !p) return '···';
  const letter = e>=101 ? String.fromCharCode(64+e-100) : e<10 ? String(e) : String.fromCharCode(55+e);
  return letter + modHex(p,2);
}
function trkVolName(song, v){
  if(!v) return '··';
  if(song.fmt==='s3m') return v>=0x10 && v<=0x50 ? String(v-0x10).padStart(2,'0') : '··';
  if(v>=0x10 && v<=0x50) return modHex(v-0x10,2);
  return '-+▼▲SVP◀▶M'[(v>>4)-6] + modHex(v&15,1);
}
function trkInstName(song, i){ return !i ? '··' : song.fmt==='s3m' ? String(i).padStart(2,'0') : modHex(i,2); }

function trkEmptySample(){ return {name:'', data:new Int8Array(0), vol:64, pan:-1, ft:0, rel:0, c2spd:8363, ls:0, ll:0, loop:0}; }
function trkEmptyEnv(v){ return {on:false, sus:false, loop:false, s:0, ls:0, le:0, pts:[[0,v],[32,v]]}; }
function trkEmptyInstrument(){
  const s = trkEmptySample(); s.pan = 128;
  return {name:'', samples:[s], map:new Uint8Array(96), venv:trkEmptyEnv(64), penv:trkEmptyEnv(32), fade:0,
          vib:{type:0, sweep:0, depth:0, rate:0}};
}
function trkNewPattern(rows, ch){ return {rows, d:new Uint8Array(rows*ch*TRK_CELL)}; }
function trkNewSong(fmt='mod', ch){
  ch = ch || (fmt==='mod' ? 4 : 8);
  const s = { fmt, title:'untitled', ch, orders:[0], restart:0, speed:6, bpm:125, gvol:64, linear:fmt==='xm',
              chPan:[], patterns:[trkNewPattern(64, ch)], samples:[], instruments:null, rev:0 };
  trkDefaultPan(s);
  if(fmt==='xm') s.instruments = Array.from({length:16}, trkEmptyInstrument);
  else s.samples = Array.from({length:fmt==='mod' ? 31 : 32}, trkEmptySample);
  return s;
}
function trkDefaultPan(s){                  // MOD — Amiga L R R L, S3M — то же мягче, XM — центр
  for(let k=0;k<s.ch;k++){
    const lr = [0,1,1,0][k&3];
    s.chPan[k] = s.fmt==='mod' ? (lr ? 255 : 0) : s.fmt==='s3m' ? (lr ? 192 : 48) : 128;
  }
  s.chPan.length = s.ch;
  trkFixChVol(s);
}
function trkFixChVol(s){                    // громкость каналов 0..1 — только в нашем хранилище, форматы её не знают
  if(!s.chVol) s.chVol = [];
  while(s.chVol.length<s.ch) s.chVol.push(1);
  s.chVol.length = s.ch;
}
function trkFixLoop(s){
  const len = s.data.length;
  s.ls = Math.max(0, s.ls|0); s.ll = Math.max(0, s.ll|0);
  if(!s.loop || s.ll<2 || s.ls>=len){ s.loop = 0; s.ls = 0; s.ll = 0; return; }
  if(s.ls+s.ll>len) s.ll = len-s.ls;
  if(s.ll<2){ s.loop = 0; s.ls = 0; s.ll = 0; }
}
// все семплы песни (у XM — внутри инструментов)
function trkAllSamples(song){ return song.instruments ? song.instruments.flatMap(i=>i.samples) : song.samples; }
// копия песни; данные семплов — по ссылке (они не меняются на месте, только заменяются)
function trkCloneSong(s, cache){               // cache — сохранить float-копии семплов (снимки отмены)
  const smp = x=>{ const o = {name:x.name, data:x.data, vol:x.vol, pan:x.pan, ft:x.ft, rel:x.rel, c2spd:x.c2spd, ls:x.ls, ll:x.ll, loop:x.loop};
    if(cache && x.f){ o.f = x.f; o.fSrc = x.fSrc; } return o; };
  const env = e=>({...e, pts:e.pts.map(p=>p.slice())});
  return { fmt:s.fmt, title:s.title, ch:s.ch, orders:s.orders.slice(), restart:s.restart, speed:s.speed, bpm:s.bpm,
    gvol:s.gvol, linear:s.linear, chPan:s.chPan.slice(), chVol:(s.chVol||[]).slice(), patterns:s.patterns.map(p=>({rows:p.rows, d:p.d})),
    samples:s.samples.map(smp),
    instruments:s.instruments ? s.instruments.map(i=>({name:i.name, samples:i.samples.map(smp), map:i.map.slice(),
      venv:env(i.venv), penv:env(i.penv), fade:i.fade, vib:{...i.vib}})) : null,
    rev:s.rev|0 };
}
function trkParse(buf, name=''){
  const b = new Uint8Array(buf);
  const tag = (o,l)=>String.fromCharCode(...b.subarray(o,o+l));
  if(b.length>60 && tag(0,17)==='Extended Module: ') return xmParse(b);
  if(b.length>0x60 && tag(44,4)==='SCRM') return s3mParse(b);
  return modParse(b);
}
function trkWrite(song){ return song.fmt==='xm' ? xmWrite(song) : song.fmt==='s3m' ? s3mWrite(song) : modWrite(song); }

const trkStr = (b,o,l)=>{ let s=''; for(let i=0;i<l;i++){ const c=b[o+i]; if(!c) break; s += c>=32&&c<127 ? String.fromCharCode(c) : ' '; } return s.replace(/\s+$/,''); };
const trkU16 = (b,o)=>b[o]|(b[o+1]<<8);
const trkU32 = (b,o)=>(b[o]|(b[o+1]<<8)|(b[o+2]<<16)|(b[o+3]<<24))>>>0;
const trkI8 = v=>v>127 ? v-256 : v;

/* ---------- MOD ---------- */
function modParse(b){
  if(b.length<600) throw new Error('not a module (too short)');
  const tag = b.length>=1084 ? String.fromCharCode(b[1080],b[1081],b[1082],b[1083]) : '';
  let ch = 0, ns = 31;
  if(['M.K.','M!K!','M&K!','FLT4','4CHN','N.T.'].includes(tag)) ch = 4;
  else if(['FLT8','8CHN','OCTA','CD81'].includes(tag)) ch = 8;
  else if(/^[1-9]CHN$/.test(tag)) ch = +tag[0];
  else if(/^[1-9]\dC[HN]$/.test(tag)) ch = +tag.slice(0,2);
  else if(/^TDZ[1-9]$/.test(tag)) ch = +tag[3];
  if(!ch){ ch = 4; ns = 15; }               // Soundtracker: 15 семплов, без метки
  const song = trkNewSong('mod', ch);
  song.title = trkStr(b,0,20);
  let off = 20;
  const lens = [];
  for(let i=0;i<ns;i++, off+=30){
    const s = song.samples[i];
    s.name = trkStr(b,off,22);
    lens.push(((b[off+22]<<8)|b[off+23])*2);
    let ft = b[off+24]&15; if(ft>7) ft -= 16;
    s.ft = ft; s.vol = Math.min(b[off+25],64);
    s.ls = ((b[off+26]<<8)|b[off+27])*2;
    s.ll = ((b[off+28]<<8)|b[off+29])*2;
  }
  const songLen = clamp(b[off],1,128);
  song.restart = b[off+1];
  const ord = Array.from(b.subarray(off+2, off+130));
  off += 130 + (ns===31 ? 4 : 0);
  const patSize = 64*ch*4;
  const smpTotal = lens.reduce((a,v)=>a+v,0);
  // PT считает паттерны по всем 128 позициям; если мусор в хвосте не влезает в файл — только по песне
  let nPat = Math.max(...ord)+1;
  if(off + nPat*patSize + smpTotal > b.length + 4096) nPat = Math.max(...ord.slice(0,songLen))+1;
  song.orders = ord.slice(0,songLen);
  song.patterns = [];
  for(let p=0;p<nPat;p++){
    const pat = trkNewPattern(64, ch), d = pat.d;
    for(let j=0;j<64*ch;j++){
      const o = off + p*patSize + j*4;
      if(o+3>=b.length) break;
      const b0=b[o], b1=b[o+1], b2=b[o+2], b3=b[o+3];
      const per = ((b0&15)<<8)|b1;
      d[j*5]   = per ? modNoteOfPeriod(per)+25 : 0;
      d[j*5+1] = (b0&0xF0)|(b2>>4);
      d[j*5+3] = b2&15;
      d[j*5+4] = b3;
    }
    song.patterns.push(pat);
  }
  off += nPat*patSize;
  for(let i=0;i<ns;i++){
    const s = song.samples[i], len = Math.max(0, Math.min(lens[i], b.length-off));
    s.data = new Int8Array(b.buffer.slice(b.byteOffset+off, b.byteOffset+off+len));
    off += lens[i];
    s.loop = s.ll>2 ? 1 : 0;
    if(s.loop && s.ls+s.ll>s.data.length && s.ls/2+s.ll<=s.data.length) s.ls = (s.ls/2)&~1;   // старые трекеры: начало петли в байтах
    trkFixLoop(s);
  }
  return song;
}
function modWrite(song){
  const ch = song.ch, patSize = 64*ch*4;
  const orders = song.orders.slice(0,128);
  let nPat = Math.max(...orders)+1;
  for(let p=song.patterns.length-1;p>=nPat;p--) if(song.patterns[p].d.some(v=>v)){ nPat = p+1; break; }
  const tag = ch===4 ? (nPat>64 ? 'M!K!' : 'M.K.') : ch<10 ? ch+'CHN' : ch+'CH';
  const smps = song.samples.slice(0,31);
  while(smps.length<31) smps.push(trkEmptySample());
  const lens = smps.map(s=>Math.min(s.data.length, 131070));
  const plen = lens.map(l=>(l+1)&~1);
  const b = new Uint8Array(1084 + nPat*patSize + plen.reduce((a,v)=>a+v,0));
  const wstr = (o,l,s)=>{ for(let i=0;i<l && i<s.length;i++){ const c=s.charCodeAt(i); b[o+i] = c<128 ? c : 63; } };
  const w16 = (o,v)=>{ b[o]=(v>>8)&255; b[o+1]=v&255; };
  wstr(0,20,song.title||'');
  let off = 20;
  smps.forEach((s,i)=>{
    wstr(off,22,s.name||'');
    w16(off+22, plen[i]>>1);
    b[off+24] = s.ft&15; b[off+25] = clamp(s.vol|0,0,64);
    if(s.loop && s.ll>2){ w16(off+26, s.ls>>1); w16(off+28, s.ll>>1); }
    else { w16(off+26, 0); w16(off+28, 1); }
    off += 30;
  });
  b[off] = orders.length; b[off+1] = song.restart&127;
  orders.forEach((v,i)=>{ b[off+2+i] = v; });
  if(nPat-1>Math.max(...orders) && orders.length<128) b[off+2+127] = nPat-1;   // PT считает паттерны по всем 128 позициям
  off += 130;
  wstr(off,4,tag); off += 4;
  for(let p=0;p<nPat;p++){
    const pat = song.patterns[p];
    for(let r=0;r<64;r++) for(let c=0;c<ch;c++){
      const o = off + (r*ch+c)*4;
      if(!pat || r>=pat.rows) continue;
      const j = (r*ch+c)*5, nt = pat.d[j], sm = pat.d[j+1];
      const pi = nt>0 && nt<=120 ? nt-25 : -1;
      const per = pi>=0 && pi<MOD_NOTES ? MOD_PER[pi] : 0;
      b[o] = (sm&0xF0)|((per>>8)&15); b[o+1] = per&255;
      b[o+2] = ((sm&15)<<4)|(pat.d[j+3]&15); b[o+3] = pat.d[j+4];
    }
    off += patSize;
  }
  smps.forEach((s,i)=>{
    const d = s.data instanceof Int8Array ? s.data : Int8Array.from(s.data, v=>v>>8);
    b.set(new Uint8Array(d.buffer, d.byteOffset, lens[i]), off); off += plen[i];
  });
  return b;
}

/* ---------- S3M ---------- */
function s3mParse(b){
  const insNum = trkU16(b,34), patNum = trkU16(b,36), ordNum = trkU16(b,32);
  const ffi = trkU16(b,42), mv = b[51], dp = b[53];
  // включённые каналы подряд, как в ST3; остальные выбрасываем
  const chMap = [], pans = [];
  for(let i=0;i<32;i++){
    const v = b[64+i];
    if(v<16){ chMap[i] = pans.length; pans.push(v<8 ? 48 : 192); }
  }
  const ch = Math.max(1, pans.length);
  const song = trkNewSong('s3m', ch);
  song.title = trkStr(b,0,28);
  song.gvol = Math.min(b[48],64); song.speed = b[49]||6; song.bpm = b[50]>=32 ? b[50] : 125;
  let off = 96;
  const rawOrd = Array.from(b.subarray(off, off+ordNum)); off += ordNum;
  const insP = [], patP = [];
  for(let i=0;i<insNum;i++){ insP.push(trkU16(b,off)*16); off += 2; }
  for(let i=0;i<patNum;i++){ patP.push(trkU16(b,off)*16); off += 2; }
  if(dp===0xFC) for(let i=0;i<32;i++){ const v=b[off+i]; if(chMap[i]!=null && (v&0x20)) pans[chMap[i]] = (v&15)*16; }
  song.chPan = mv&0x80 ? pans : pans.map(()=>128);
  while(song.chPan.length<ch) song.chPan.push(128);
  trkFixChVol(song);
  // позиции: 254 — разделитель (пропускаем, переходы Bxx пересчитываем), 255 — конец
  const ordMap = [], orders = [];
  for(let i=0;i<rawOrd.length;i++){
    ordMap[i] = orders.length;
    const v = rawOrd[i];
    if(v===255) break;
    if(v===254 || v>=patNum) continue;
    orders.push(v);
  }
  song.orders = orders.length ? orders : [0];
  song.samples = [];
  for(let i=0;i<insNum;i++){
    const o = insP[i], s = trkEmptySample();
    song.samples.push(s);
    if(!o || o+80>b.length) continue;
    s.name = trkStr(b,o+48,28);
    if(b[o]!==1) continue;
    const mem = ((b[o+13]<<16)|trkU16(b,o+14))*16;
    const len = trkU32(b,o+16), flags = b[o+31];
    s.ls = trkU32(b,o+20); s.ll = trkU32(b,o+24)-s.ls; s.loop = flags&1;
    s.vol = Math.min(b[o+28],64); s.c2spd = trkU32(b,o+32)||8363;
    const bits16 = flags&4, stereo = flags&2, bps = bits16 ? 2 : 1;
    const n = Math.max(0, Math.min(len, Math.floor((b.length-mem)/bps/(stereo?2:1))));
    const d = bits16 ? new Int16Array(n) : new Int8Array(n);
    for(let k=0;k<n;k++){
      let v = bits16 ? trkU16(b,mem+k*2) : b[mem+k];
      if(stereo){ const r = bits16 ? trkU16(b,mem+(len+k)*2) : b[mem+len+k]; v = (v+r)>>1; }
      if(bits16) d[k] = ffi===2 ? v-32768 : (v<<16)>>16;
      else d[k] = ffi===2 ? v-128 : trkI8(v);
    }
    s.data = d;
    trkFixLoop(s);
  }
  song.patterns = [];
  for(let p=0;p<patNum;p++){
    const pat = trkNewPattern(64, ch), d = pat.d;
    song.patterns.push(pat);
    let o = patP[p];
    if(!o || o+2>b.length) continue;
    const end = Math.min(b.length, o+trkU16(b,o)); o += 2;
    for(let r=0;r<64 && o<end;){
      const w = b[o++];
      if(!w){ r++; continue; }
      const c = chMap[w&31], j = c!=null ? (r*ch+c)*5 : -1;
      if(w&32){
        const nt = b[o], ins = b[o+1]; o += 2;
        if(j>=0){
          d[j] = nt===255 ? 0 : nt===254 ? TRK_CUT : Math.min(119,(nt>>4)*12+(nt&15))+1;
          d[j+1] = ins;
        }
      }
      if(w&64){ const v = b[o++]; if(j>=0 && v<=64) d[j+2] = 0x10+v; }
      if(w&128){
        const e = b[o], x = b[o+1]; o += 2;
        if(j>=0 && e>=1 && e<=26){
          d[j+3] = 100+e; d[j+4] = x;
          if(e===2) d[j+4] = ordMap[x] ?? x;
        }
      }
    }
  }
  return song;
}
function s3mWrite(song){
  const ch = Math.min(32, song.ch), smps = song.samples.slice(0,99);
  const ordNum = (song.orders.length+2)&~1, insNum = smps.length, patNum = song.patterns.length;
  const out = [];                             // собираем кусками, парапойнтеры проставляем потом
  let size = 0;
  const put = u8=>{ out.push(u8); size += u8.length; };
  const align = ()=>{ const pad = (16-(size&15))&15; if(pad) put(new Uint8Array(pad)); };
  const hdr = new Uint8Array(96 + ordNum + insNum*2 + patNum*2 + 32);
  const wstr = (a,o,l,s)=>{ for(let i=0;i<l && i<s.length;i++){ const c=s.charCodeAt(i); a[o+i] = c<128 ? c : 63; } };
  const w16 = (a,o,v)=>{ a[o]=v&255; a[o+1]=(v>>8)&255; };
  const w32 = (a,o,v)=>{ w16(a,o,v&0xFFFF); w16(a,o+2,(v>>>16)&0xFFFF); };
  wstr(hdr,0,28,song.title||''); hdr[28] = 0x1A; hdr[29] = 16;
  w16(hdr,32,ordNum); w16(hdr,34,insNum); w16(hdr,36,patNum); w16(hdr,40,0x1320); w16(hdr,42,2);
  wstr(hdr,44,4,'SCRM');
  hdr[48] = song.gvol; hdr[49] = song.speed; hdr[50] = song.bpm; hdr[51] = 0x80|48; hdr[53] = 0xFC;
  for(let i=0;i<32;i++) hdr[64+i] = i<ch ? ((song.chPan[i]??128)<128 ? (i&7) : 8+(i&7)) : 255;
  for(let i=0;i<ordNum;i++) hdr[96+i] = i<song.orders.length ? song.orders[i] : 255;
  const panOff = 96+ordNum+insNum*2+patNum*2;
  for(let i=0;i<32;i++) hdr[panOff+i] = i<ch ? 0x20|((song.chPan[i]??128)>>4) : 0;
  put(hdr); align();
  const insHdr = smps.map(()=>{ const h = new Uint8Array(80); put(h); return h; });
  insHdr.forEach((h,i)=>w16(hdr, 96+ordNum+i*2, (size - (insNum-i)*80)>>4));
  align();
  song.patterns.forEach((pat,p)=>{
    align();
    w16(hdr, 96+ordNum+insNum*2+p*2, size>>4);
    const bytes = [0,0];
    for(let r=0;r<64;r++){
      for(let c=0;c<ch;c++){
        if(r>=pat.rows) break;
        const j = (r*song.ch+c)*5, d = pat.d;
        const nt = d[j], ins = d[j+1], v = d[j+2], e = d[j+3], x = d[j+4];
        const hasN = nt||ins, hasV = v>=0x10 && v<=0x50, hasE = e>100 && e<=126;
        if(!hasN && !hasV && !hasE) continue;
        bytes.push(c|(hasN?32:0)|(hasV?64:0)|(hasE?128:0));
        if(hasN) bytes.push(!nt ? 255 : nt>=TRK_OFF ? 254 : (Math.floor((nt-1)/12)<<4)|((nt-1)%12), ins);
        if(hasV) bytes.push(v-0x10);
        if(hasE) bytes.push(e-100, x);
      }
      bytes.push(0);
    }
    const u = Uint8Array.from(bytes); w16(u,0,u.length);
    put(u);
  });
  smps.forEach((s,i)=>{
    const h = insHdr[i];
    wstr(h,48,28,s.name||''); wstr(h,76,4,'SCRS');
    const len = s.data.length;
    if(!len){ h[0] = 0; return; }
    align();
    const para = size>>4;
    h[0] = 1; h[13] = (para>>16)&255; w16(h,14,para&0xFFFF);
    w32(h,16,len); w32(h,20,s.loop?s.ls:0); w32(h,24,s.loop?s.ls+s.ll:0);
    h[28] = s.vol; h[31] = (s.loop?1:0)|(s.data instanceof Int16Array?4:0); w32(h,32,s.c2spd||8363);
    if(s.data instanceof Int16Array){ const u = new Uint8Array(len*2); for(let k=0;k<len;k++) w16(u,k*2,s.data[k]+32768); put(u); }
    else put(Uint8Array.from(s.data, v=>v+128));
  });
  const res = new Uint8Array(size); let o = 0;
  for(const u of out){ res.set(u,o); o += u.length; }
  return res;
}

/* ---------- XM ---------- */
function xmEnv(b, o, n, sus, ls, le, type){
  const pts = [];
  for(let i=0;i<Math.min(n,12);i++) pts.push([trkU16(b,o+i*4), trkU16(b,o+i*4+2)]);
  if(!pts.length) pts.push([0,0]);
  return {on:!!(type&1), sus:!!(type&2), loop:!!(type&4), s:Math.min(sus,pts.length-1), ls:Math.min(ls,pts.length-1), le:Math.min(le,pts.length-1), pts};
}
function xmParse(b){
  const ver = trkU16(b,58);
  if(ver<0x0104) throw new Error('XM version '+modHex(ver,4)+' is not supported (need 0104)');
  const hsize = trkU32(b,60);
  const songLen = trkU16(b,64), ch = trkU16(b,68), nPat = trkU16(b,70), nIns = trkU16(b,72), flags = trkU16(b,74);
  const song = trkNewSong('xm', clamp(ch,1,64));
  song.title = trkStr(b,17,20);
  song.restart = trkU16(b,66); song.linear = !!(flags&1);
  song.speed = trkU16(b,76)||6; song.bpm = trkU16(b,78)||125;
  song.orders = Array.from(b.subarray(80, 80+Math.min(songLen,256)));
  if(!song.orders.length) song.orders = [0];
  let off = 60+hsize;
  song.patterns = [];
  for(let p=0;p<nPat;p++){
    const hl = trkU32(b,off), rows = trkU16(b,off+5)||64, psz = trkU16(b,off+7);
    const pat = trkNewPattern(Math.min(rows,256), song.ch), d = pat.d;
    let o = off+hl; const end = Math.min(b.length, o+psz);
    for(let j=0; j<pat.rows*song.ch && o<end; j++){
      let f = b[o], nt=0, ins=0, v=0, e=0, x=0;
      if(f&0x80){ o++; if(f&1) nt=b[o++]; if(f&2) ins=b[o++]; if(f&4) v=b[o++]; if(f&8) e=b[o++]; if(f&16) x=b[o++]; }
      else { nt=b[o]; ins=b[o+1]; v=b[o+2]; e=b[o+3]; x=b[o+4]; o += 5; }
      d[j*5] = nt===97 ? TRK_OFF : nt>0 && nt<97 ? nt : 0;
      d[j*5+1] = ins; d[j*5+2] = v; d[j*5+3] = e<36 ? e : 0; d[j*5+4] = x;
    }
    song.patterns.push(pat);
    off += hl+psz;
  }
  if(!song.patterns.length) song.patterns.push(trkNewPattern(64, song.ch));
  song.instruments = [];
  for(let i=0;i<nIns && off<b.length;i++){
    const isz = trkU32(b,off), ins = trkEmptyInstrument();
    ins.name = trkStr(b,off+4,22); ins.samples = [];
    song.instruments.push(ins);
    const ns = trkU16(b,off+27);
    if(!ns){ const e = trkEmptySample(); e.pan = 128; ins.samples.push(e); off += isz||29; continue; }
    const shs = trkU32(b,off+29) || 40;
    ins.map = Uint8Array.from(b.subarray(off+33, off+129));
    ins.venv = xmEnv(b, off+129, b[off+225], b[off+227], b[off+228], b[off+229], b[off+233]);
    ins.penv = xmEnv(b, off+177, b[off+226], b[off+230], b[off+231], b[off+232], b[off+234]);
    ins.vib = {type:b[off+235], sweep:b[off+236], depth:b[off+237], rate:b[off+238]};
    ins.fade = trkU16(b,off+239);
    off += isz;
    const hdrs = [];
    for(let k=0;k<ns;k++, off+=shs){
      const s = trkEmptySample();
      const type = b[off+14], bits16 = type&16;
      s.name = trkStr(b,off+18,22); s.vol = Math.min(b[off+12],64); s.ft = trkI8(b[off+13]);
      s.pan = b[off+15]; s.rel = trkI8(b[off+16]); s.loop = type&3; if(s.loop===3) s.loop = 1;
      const div = bits16 ? 2 : 1;
      s.ls = Math.floor(trkU32(b,off+4)/div); s.ll = Math.floor(trkU32(b,off+8)/div);
      hdrs.push({s, bytes:trkU32(b,off), bits16});
      ins.samples.push(s);
    }
    for(const h of hdrs){
      const n = Math.max(0, Math.min(h.bytes, b.length-off));
      if(h.bits16){
        const d = new Int16Array(n>>1); let acc = 0;
        for(let k=0;k<d.length;k++){ acc = (acc + trkU16(b,off+k*2))&0xFFFF; d[k] = (acc<<16)>>16; }
        h.s.data = d;
      } else {
        const d = new Int8Array(n); let acc = 0;
        for(let k=0;k<n;k++){ acc = (acc + b[off+k])&255; d[k] = trkI8(acc); }
        h.s.data = d;
      }
      off += h.bytes;
      trkFixLoop(h.s);
    }
    for(let k=0;k<96;k++) if(ins.map[k]>=ins.samples.length) ins.map[k] = 0;
    if(!ins.samples.length){ const s = trkEmptySample(); s.pan = 128; ins.samples.push(s); }
  }
  while(song.instruments.length<1) song.instruments.push(trkEmptyInstrument());
  return song;
}
function xmWrite(song){
  const out = []; let size = 0;
  const put = u8=>{ out.push(u8); size += u8.length; };
  const wstr = (a,o,l,s)=>{ for(let i=0;i<l && i<s.length;i++){ const c=s.charCodeAt(i); a[o+i] = c<128 ? c : 63; } };
  const w16 = (a,o,v)=>{ a[o]=v&255; a[o+1]=(v>>8)&255; };
  const w32 = (a,o,v)=>{ w16(a,o,v&0xFFFF); w16(a,o+2,(v>>>16)&0xFFFF); };
  const h = new Uint8Array(336);
  wstr(h,0,17,'Extended Module: '); wstr(h,17,20,song.title||''); h[37] = 0x1A;
  wstr(h,38,20,'DSP workbench'); w16(h,58,0x0104); w32(h,60,276);
  const ord = song.orders.slice(0,256);
  w16(h,64,ord.length); w16(h,66,song.restart); w16(h,68,song.ch); w16(h,70,song.patterns.length);
  w16(h,72,song.instruments.length); w16(h,74,song.linear?1:0); w16(h,76,song.speed); w16(h,78,song.bpm);
  ord.forEach((v,i)=>{ h[80+i] = v; });
  put(h);
  for(const pat of song.patterns){
    const bytes = [];
    for(let j=0;j<pat.rows*song.ch;j++){
      const d = pat.d;
      const nt = d[j*5]===TRK_OFF || d[j*5]===TRK_CUT ? 97 : d[j*5]>96 ? 0 : d[j*5];
      const f = [nt, d[j*5+1], d[j*5+2], d[j*5+3], d[j*5+4]];
      const mask = f.reduce((m,v,k)=>v ? m|(1<<k) : m, 0);
      if(mask===31) bytes.push(...f);
      else { bytes.push(0x80|mask); f.forEach(v=>{ if(v) bytes.push(v); }); }
    }
    const ph = new Uint8Array(9); w32(ph,0,9); w16(ph,5,pat.rows); w16(ph,7,bytes.length);
    put(ph); put(Uint8Array.from(bytes));
  }
  for(const ins of song.instruments){
    const one = ins.samples[0];
    const ns = ins.samples.length===1 && !one.data.length && !one.name ? 0 : ins.samples.length;
    const ih = new Uint8Array(ns ? 263 : 29);
    w32(ih,0,ih.length); wstr(ih,4,22,ins.name||''); w16(ih,27,ns);
    if(ns){
      w32(ih,29,40); ih.set(ins.map.subarray(0,96),33);
      const env = (o, e)=>e.pts.slice(0,12).forEach((p,k)=>{ w16(ih,o+k*4,p[0]); w16(ih,o+k*4+2,p[1]); });
      env(129, ins.venv); env(177, ins.penv);
      ih[225] = Math.min(12,ins.venv.pts.length); ih[226] = Math.min(12,ins.penv.pts.length);
      ih[227] = ins.venv.s; ih[228] = ins.venv.ls; ih[229] = ins.venv.le;
      ih[230] = ins.penv.s; ih[231] = ins.penv.ls; ih[232] = ins.penv.le;
      const et = e=>(e.on?1:0)|(e.sus?2:0)|(e.loop?4:0);
      ih[233] = et(ins.venv); ih[234] = et(ins.penv);
      ih[235] = ins.vib.type; ih[236] = ins.vib.sweep; ih[237] = ins.vib.depth; ih[238] = ins.vib.rate;
      w16(ih,239,ins.fade);
    }
    put(ih);
    if(!ns) continue;
    for(const s of ins.samples){
      const sh = new Uint8Array(40), m = s.data instanceof Int16Array ? 2 : 1;
      w32(sh,0,s.data.length*m); w32(sh,4,s.loop?s.ls*m:0); w32(sh,8,s.loop?s.ll*m:0);
      sh[12] = s.vol; sh[13] = s.ft&255; sh[14] = (s.loop&3)|(m===2?16:0); sh[15] = s.pan<0 ? 128 : s.pan;
      sh[16] = s.rel&255; wstr(sh,18,22,s.name||'');
      put(sh);
    }
    for(const s of ins.samples){
      const d = s.data;
      if(d instanceof Int16Array){
        const u = new Uint8Array(d.length*2); let prev = 0;
        for(let k=0;k<d.length;k++){ w16(u,k*2,(d[k]-prev)&0xFFFF); prev = d[k]; }
        put(u);
      } else {
        const u = new Uint8Array(d.length); let prev = 0;
        for(let k=0;k<d.length;k++){ u[k] = (d[k]-prev)&255; prev = d[k]; }
        put(u);
      }
    }
  }
  const res = new Uint8Array(size); let o = 0;
  for(const u of out){ res.set(u,o); o += u.length; }
  return res;
}

/* ---------- конвертация (MOD → S3M/XM, S3M → XM) ---------- */
// MOD-эффект → S3M-буква (код 100+n) и параметр; C уходит в колонку громкости
function trkModToS3M(e, p){
  const x = p>>4, y = p&15, L = c=>100+c.charCodeAt(0)-64;
  switch(e){
    case 0: return p ? [L('J'),p] : [0,0];
    case 1: return [L('F'),p]; case 2: return [L('E'),p]; case 3: return [L('G'),p]; case 4: return [L('H'),p];
    case 5: return [L('L'),p]; case 6: return [L('K'),p]; case 7: return [L('R'),p];
    case 8: return [L('X'),p>>1]; case 9: return [L('O'),p];
    case 10: return [L('D'), x ? x<<4 : y]; case 11: return [L('B'),p]; case 13: return [L('C'),p];
    case 14: switch(x){
      case 1: return [L('F'),0xF0|y]; case 2: return [L('E'),0xF0|y]; case 3: return [L('S'),0x10|y];
      case 4: return [L('S'),0x30|y]; case 5: return [L('S'),0x20|y]; case 6: return [L('S'),0xB0|y];
      case 7: return [L('S'),0x40|y]; case 8: return [L('S'),0x80|y]; case 9: return [L('Q'),y];
      case 10: return [L('D'),(y<<4)|15]; case 11: return [L('D'),0xF0|y]; case 12: return [L('S'),0xC0|y];
      case 13: return [L('S'),0xD0|y]; case 14: return [L('S'),0xE0|y];
    } return [0,0];
    case 15: return p<32 ? [L('A'),p] : [L('T'),p];
  }
  return [0,0];
}
// S3M-буква → XM-эффект
function trkS3MToXM(e, p){
  const x = p>>4, y = p&15;
  switch(String.fromCharCode(64+e-100)){
    case 'A': return [15, Math.min(p,31)]; case 'T': return p>=32 ? [15,p] : [0,0];
    case 'B': return [11,p]; case 'C': return [13,p];
    case 'D': return y===15 && x ? [14,0xA0|x] : x===15 && y ? [14,0xB0|y] : [10, y ? y : x<<4];
    case 'E': return x===15 ? [14,0x20|y] : x===14 ? [33,0x20|y] : [2,p];
    case 'F': return x===15 ? [14,0x10|y] : x===14 ? [33,0x10|y] : [1,p];
    case 'G': return [3,p]; case 'H': case 'U': return [4,p]; case 'I': return [29,p]; case 'J': return [0,p];
    case 'K': return [6,p]; case 'L': return [5,p]; case 'O': return [9,p]; case 'Q': return [27,p]; case 'R': return [7,p];
    case 'S': { const m = {1:3,2:5,3:4,4:7,8:8,11:6,12:12,13:13,14:14}[x]; return m!=null ? [14,(m<<4)|y] : [0,0]; }
    case 'V': return [16,p]; case 'X': return [8,Math.min(255,p*2)];
  }
  return [0,0];
}
function trkConvert(src, fmt){
  const s = trkCloneSong(src);
  if(s.fmt===fmt) return s;
  const to = trkNewSong(fmt, s.ch);
  Object.assign(to, {title:s.title, orders:s.orders, restart:s.restart, speed:s.speed, bpm:s.bpm, gvol:s.gvol, chPan:s.chPan, chVol:s.chVol});
  to.linear = false;                                    // амига-периоды — как в исходном формате
  to.patterns = s.patterns.map(p=>{
    const q = trkNewPattern(p.rows, s.ch), d = p.d, o = q.d;
    for(let j=0;j<d.length;j+=5){
      let nt = d[j], ins = d[j+1], v = d[j+2], e = d[j+3], x = d[j+4];
      if(s.fmt==='mod' && fmt==='s3m'){ if(e===12){ v = 0x10+Math.min(x,64); e = 0; x = 0; } else [e,x] = trkModToS3M(e,x); }
      else if(s.fmt==='s3m' && fmt==='xm'){ [e,x] = e>100 ? trkS3MToXM(e,x) : [0,0]; if(nt===TRK_CUT){ nt = 0; v = 0x10; } }
      o[j]=nt; o[j+1]=ins; o[j+2]=v; o[j+3]=e; o[j+4]=x;
    }
    return q;
  });
  const smps = s.samples;
  if(fmt==='s3m'){
    to.samples = smps.map(x=>({...x, c2spd:Math.round(8363*Math.pow(2, x.ft/96)), ft:0}));
    while(to.samples.length<32) to.samples.push(trkEmptySample());
  } else {
    to.instruments = smps.map(x=>{
      const ins = trkEmptyInstrument();
      let semis = s.fmt==='mod' ? x.ft/8 : 12*Math.log2((x.c2spd||8363)/8363);
      const rel = Math.round(semis);
      ins.name = x.name;
      ins.samples = [{...x, pan:128, rel, ft:clamp(Math.round((semis-rel)*128),-128,127)}];
      return ins;
    });
    while(to.instruments.length<16) to.instruments.push(trkEmptyInstrument());
  }
  return to;
}
