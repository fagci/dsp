/* ============================ ТРЕКЕР: ПЛЕЕР ============================ */
// Один плеер на три формата. Высота — «период» в единицах, общих для эффектов:
//   MOD — период PT×4, S3M — период ST3, XM — линейный (7680 − нота·64) или амига-период FT2.
// Во всех трёх портаменто xx сдвигает период на xx·4, вибрато — на (волна·глубина)>>5.
// Каналы рендерятся каждый в свой буфер (pl.bufs), сведение и панорама — у узлов (tracker.js).

const TRK_CLK = {mod:14187578.4, s3m:14317056, xm:8363*1712};
const TRK_SINE = [0,24,49,74,97,120,141,161,180,197,212,224,235,244,250,253,255,253,250,244,235,224,212,197,180,161,141,120,97,74,49,24];
const TRK_RETRIG = [v=>v, v=>v-1, v=>v-2, v=>v-4, v=>v-8, v=>v-16, v=>v*2/3, v=>v/2,
                    v=>v, v=>v+1, v=>v+2, v=>v+4, v=>v+8, v=>v+16, v=>v*3/2, v=>v*2];

function trkPer(song, note, s, ft){            // период ноты (0..119) для семпла
  if(song.fmt==='mod'){
    const i = note-24;
    if(i>=0 && i<MOD_NOTES) return MOD_PER[(ft&15)*MOD_NOTES+i]*4;
    return 1712*4*Math.pow(2, -(i-24+ft/8)/12);
  }
  if(song.fmt==='s3m') return TRK_CLK.s3m/((s.c2spd||8363)*Math.pow(2,(note-48)/12));
  if(song.linear) return 7680 - (note+s.rel)*64 - ft/2;
  return 1712*Math.pow(2, -(note+s.rel-48+ft/128)/12);
}
function trkFreq(song, per){
  if(song.fmt==='xm' && song.linear) return 8363*Math.pow(2,(4608-per)/768);
  return per>0 ? TRK_CLK[song.fmt]/per : 0;
}
function trkSmpOf(song, c, inst, n){           // семпл для ноты n инструмента inst
  if(song.instruments){ const ins = song.instruments[inst-1]; return ins ? ins.samples[ins.map[n]] || null : null; }
  return song.samples[inst-1] || null;
}
function modChan(k, pan){
  return { inst:0, smp:null, ins:null, pos:0, dir:1, active:false, note:48, per:0, outPer:0, baseF:0, ft:0,
    target:0, pspd:0, vol:0, outVol:0, pan:pan??128, outPan:128,
    vspd:0, vdep:0, vpos:0, vwav:0, vfine:false, tspd:0, tdep:0, tpos:0, twav:0,
    mOff:0, mPU:0, mPD:0, mFU:0, mFD:0, mXU:0, mXD:0, mVS:0, mFVU:0, mFVD:0, mGS:0, mPS:0, mRx:0, mRy:0, mTr:0, mJ:0,
    mD:0, mE:0, mT:0, trPos:0, trOn:true, rtCnt:0,
    keyOff:false, fade:32768, envVT:0, envPT:0, envV:64, envP:32, avPos:0, avT:0,
    loopRow:0, loopCnt:0, eff:0, prm:0, vcmd:0, delay:null, mute:false, vu:0, fin:0, finPan:128,
    trig:0, takenAt:-9, k };
}
function modPlayer(song){
  const pl = { song, playing:false, mode:'song', ord:0, row:0, tick:0, speed:6, bpm:125, gvol:64, left:0,
               jump:-1, brk:-1, loopJump:-1, delay:0, inDelay:false, chn:[], ended:false, solo:-1, loop:true,
               bufs:[], gates:[], clk:null, ext:{}, now:0 };
  modPlayerChannels(pl);
  return pl;
}
function modPlayerChannels(pl){
  const s = pl.song, n = s.ch;
  while(pl.chn.length<n) pl.chn.push(modChan(pl.chn.length, s.chPan[pl.chn.length]));
  pl.chn.length = n;
}
function modPat(pl){ const s=pl.song; return s.patterns[s.orders[pl.ord]] || null; }
function modRows(pl){ return modPat(pl)?.rows || 64; }
function modStart(pl, ord, row, mode){
  const s = pl.song;
  pl.ord = clamp(ord|0, 0, s.orders.length-1); pl.row = clamp(row|0, 0, modRows(pl)-1);
  pl.mode = mode||'song'; pl.tick = 0; pl.left = 0; pl.speed = s.speed||6; pl.bpm = s.bpm||125; pl.gvol = s.gvol??64;
  pl.jump = pl.brk = pl.loopJump = -1; pl.delay = 0; pl.inDelay = false; pl.ended = false;
  modPlayerChannels(pl);
  pl.chn.forEach((c,k)=>{ const m = c.mute; Object.assign(c, modChan(k, s.chPan[k])); c.mute = m; });
  pl.playing = true;
}
function modStop(pl){ pl.playing = false; for(const c of pl.chn) c.active = false; }
function modSmpF(s){                          // float-копия данных семпла, пересчёт при замене data
  if(s.fSrc!==s.data){
    const d = s.data, k = d instanceof Int16Array ? 1/32768 : 1/128, f = new Float32Array(d.length);
    for(let i=0;i<d.length;i++) f[i] = d[i]*k;
    s.f = f; s.fSrc = d;
  }
  return s.f;
}
function trkTrigger(pl, c){
  const s = c.smp;
  c.ext = trkIsExt(pl, c.inst);
  c.pos = 0; c.dir = 1; c.active = !!(s && s.data.length) || c.ext; c.trig++;
  if(!(c.vwav&4)) c.vpos = 0;
  if(!(c.twav&4)) c.tpos = 0;
  // XM: огибающие, затухание и key off сбрасывает номер инструмента, не нота
  if(pl.song.fmt!=='xm'){ c.keyOff = false; c.fade = 32768; c.envVT = 0; c.envPT = 0; }
  c.avPos = 0; c.avT = 0; c.rtCnt = 0;
  c.baseF = trkFreq(pl.song, c.per);
}
// инструмент играет узел Tracker Instrument (генератор в графе) — метка обновляется каждый блок
function trkIsExt(pl, inst){ return (pl.ext[inst]??-9) >= pl.now-2; }
function trkKeyOff(c){
  c.keyOff = true;
  if(!c.ins || !c.ins.venv.on){ c.vol = 0; c.outVol = 0; }
}
// нота в канале вне секвенсора — прослушивание при вводе
function modPreview(pl, ch, note, inst){
  const c = pl.chn[ch]; if(!c) return;
  const song = pl.song, s = trkSmpOf(song, c, inst, note); if(!s) return;
  c.inst = inst; c.ins = song.instruments ? song.instruments[inst-1] : null; c.smp = s;
  c.vol = c.outVol = s.vol; c.ft = s.ft; c.note = note; if(s.pan>=0) c.pan = s.pan;
  c.per = c.outPer = trkPer(song, note, s, c.ft); c.eff = 0; c.prm = 0; c.vcmd = 0; c.delay = null;
  trkTrigger(pl, c);
}
function trkIsPorta(song, c){
  if(song.fmt==='s3m') return c.eff===107 || c.eff===112;
  return c.eff===3 || c.eff===5 || (c.vcmd>>4)===0xF;
}
function modRowNote(pl, c, note, inst){       // нота/инструмент из ячейки (тик 0 или задержка)
  const song = pl.song, xm = song.fmt==='xm';
  const porta = trkIsPorta(song, c);
  const n = note>0 && note<=120 ? note-1 : -1;
  if(inst){
    c.inst = inst;
    if(xm) c.ins = song.instruments[inst-1] || null;
    const s = n>=0 ? trkSmpOf(song, c, inst, n) : xm ? c.smp : song.samples[inst-1];
    if(s){
      c.vol = s.vol;
      if(xm && s.pan>=0) c.pan = s.pan;
      if(song.fmt==='mod') c.ft = s.ft;
    }
    if(xm){ c.keyOff = false; c.fade = 32768; c.envVT = 0; c.envPT = 0; c.trZero = false;
      if(!c.ins){ c.vol = 0; c.active = false; } }                    // нет такого инструмента — нота глохнет
  }
  if(note===TRK_OFF){ trkKeyOff(c); }
  else if(note===TRK_CUT){ c.vol = 0; c.active = false; }
  else if(n>=0){
    const s = trkSmpOf(song, c, c.inst, n);
    if(s){
      let ft = song.fmt==='mod' ? c.ft : s.ft;
      if(c.eff===14 && (c.prm>>4)===5){ const f = c.prm&15; ft = song.fmt==='mod' ? (f>7?f-16:f) : (f-8)*16; if(song.fmt==='mod') c.ft = ft; }
      const per = trkPer(song, n, s, ft);
      if(porta && c.smp){ c.target = per; if(xm) c.ft = ft; }
      else {
        c.smp = s; c.note = n; c.per = per; c.target = 0; c.ft = ft;
        trkTrigger(pl, c);
        const off = song.fmt==='s3m' ? (c.eff===115) : (c.eff===9);
        if(off){
          if(c.prm) c.mOff = c.prm;
          c.pos = c.mOff*256;
          if(c.pos>=s.data.length){ if(s.loop && song.fmt!=='xm') c.pos = s.ls; else c.active = false; }
        }
      }
    }
  }
  const v = c.vcmd, lo = v&15;                  // колонка громкости, тик 0
  if(v>=0x10 && v<=0x50) c.vol = v-0x10;
  else switch(v>>4){
    case 0x8: c.vol = Math.max(0, c.vol-lo); break;
    case 0x9: c.vol = Math.min(64, c.vol+lo); break;
    case 0xA: if(lo) c.vspd = lo; break;
    case 0xB: if(lo) c.vdep = lo; break;
    case 0xC: c.pan = lo*16; break;
    case 0xF: if(lo) c.pspd = lo*64; break;
  }
}
function trkBreak(pl, row){ pl.brk = row; if(pl.jump<0) pl.jump = -2; }
function modRow(pl){
  const pat = modPat(pl), song = pl.song, ch = song.ch, xm = song.fmt==='xm', s3m = song.fmt==='s3m';
  for(let k=0;k<ch;k++){
    const c = pl.chn[k], o = (pl.row*ch+k)*5, d = pat?.d;
    const note = d ? d[o] : 0, inst = d ? d[o+1] : 0;
    c.vcmd = d ? d[o+2] : 0; c.eff = d ? d[o+3] : 0; c.prm = d ? d[o+4] : 0;
    const e = c.eff, p = c.prm, x = p>>4, y = p&15;
    c.delay = null;
    c.vfine = false;
    if(((!s3m && e===14) || (s3m && e===119)) && x===0xD && y) c.delay = {note, inst, t:y};
    else modRowNote(pl, c, note, inst);
    if(s3m) trkRowS3M(pl, c, e, p, x, y);
    else switch(e){
      case 1: if(xm && p) c.mPU = p; break;
      case 2: if(xm && p) c.mPD = p; break;
      case 3: if(p) c.pspd = p*4; break;
      case 4: if(x) c.vspd = x; if(y) c.vdep = y; break;
      case 5: case 6: case 10: if(xm && p) c.mVS = p; break;
      case 7: if(x) c.tspd = x; if(y) c.tdep = y; break;
      case 8: c.pan = p; break;
      case 11: pl.jump = p; if(pl.brk<0) pl.brk = 0; break;
      case 12: c.vol = Math.min(p,64); break;
      case 13: trkBreak(pl, x*10+y); break;
      case 14:
        switch(x){
          case 1: if(xm && y) c.mFU = y; c.per -= (xm ? c.mFU : y)*4; break;
          case 2: if(xm && y) c.mFD = y; c.per += (xm ? c.mFD : y)*4; break;
          case 3: c.gliss = y; break;
          case 4: c.vwav = y; break;
          case 6: trkLoop(pl, c, y); break;
          case 7: c.twav = y; break;
          case 8: c.pan = y*16; break;
          case 0xA: if(xm && y) c.mFVU = y; c.vol = Math.min(64, c.vol+(xm ? c.mFVU : y)); break;
          case 0xB: if(xm && y) c.mFVD = y; c.vol = Math.max(0, c.vol-(xm ? c.mFVD : y)); break;
          case 0xC: if(!y) c.vol = 0; break;
          case 0xE: if(!pl.inDelay && !pl.delay) pl.delay = y; break;
        }
        break;
      case 15: if(p){ if(p<32) pl.speed = p; else pl.bpm = p; } break;
      case 16: pl.gvol = Math.min(p,64); break;
      case 17: if(p) c.mGS = p; break;
      case 20: if(!p) trkKeyOff(c); break;
      case 21: c.envVT = p; c.envPT = p; break;
      case 25: if(p) c.mPS = p; break;
      case 27: if(x) c.mRx = x; if(y) c.mRy = y; break;
      case 29: if(p) c.mTr = p; break;
      case 33:
        if(x===1){ if(y) c.mXU = y; c.per -= c.mXU; }
        else if(x===2){ if(y) c.mXD = y; c.per += c.mXD; }
        break;
    }
    trkClampPer(song, c);
    c.outPer = c.per; c.outVol = c.vol; c.outPan = c.pan;
  }
}
function trkLoop(pl, c, y){
  if(!y) c.loopRow = pl.row;
  else if(!c.loopCnt){ c.loopCnt = y; pl.loopJump = c.loopRow; }
  else if(--c.loopCnt) pl.loopJump = c.loopRow;
}
function trkRowS3M(pl, c, e, p, x, y){
  switch(e-100){
    case 1: if(p) pl.speed = p; break;                                   // A
    case 2: pl.jump = p; if(pl.brk<0) pl.brk = 0; break;                  // B
    case 3: trkBreak(pl, x*10+y); break;                                  // C
    case 4: case 11: case 12:                                             // D K L — общая память
      if(p) c.mD = p;
      { const q = c.mD, qx = q>>4, qy = q&15;
        if(qy===15 && qx) c.vol = Math.min(64, c.vol+qx);
        else if(qx===15 && qy) c.vol = Math.max(0, c.vol-qy); }
      break;
    case 5: case 6: {                                                     // E F — общая память
      if(p) c.mE = p;
      const q = c.mE, sgn = e===105 ? 1 : -1;
      if((q>>4)===15) c.per += sgn*(q&15)*4;
      else if((q>>4)===14) c.per += sgn*(q&15);
      break;
    }
    case 7: if(p) c.pspd = p*4; break;                                   // G
    case 8: case 21: if(x) c.vspd = x; if(y) c.vdep = y; c.vfine = e===121; break;   // H U
    case 9: if(p) c.mTr = p; break;                                      // I
    case 10: if(p) c.mJ = p; break;                                      // J
    case 17: if(x) c.mRx = x; if(y) c.mRy = y; break;                    // Q
    case 18: if(x) c.tspd = x; if(y) c.tdep = y; break;                  // R
    case 19:                                                             // S
      switch(x){
        case 1: c.gliss = y; break;
        case 3: c.vwav = y; break;
        case 4: c.twav = y; break;
        case 8: c.pan = y*16; break;
        case 0xB: trkLoop(pl, c, y); break;
        case 0xC: if(!y) c.vol = 0; break;
        case 0xE: if(!pl.inDelay && !pl.delay) pl.delay = y; break;
      }
      break;
    case 20: if(p>=0x20) pl.bpm = p; else if(p) c.mT = p; break;        // T: 0x — медленнее, 1x — быстрее
    case 22: pl.gvol = Math.min(p,64); break;                            // V
    case 24: if(p<=0x80) c.pan = Math.min(255, p*2); break;              // X
  }
}
function trkClampPer(song, c){
  if(song.fmt==='mod') c.per = clamp(c.per, 113*4, 856*4);
  else c.per = clamp(c.per, 1, 65535);
}
function modVolSlide(c, p){ const x=p>>4, y=p&15; c.vol = clamp(x ? c.vol+x : c.vol-y, 0, 64); }
function modTonePorta(song, c){
  if(c.target){
    if(c.per<c.target) c.per = Math.min(c.per+c.pspd, c.target);
    else if(c.per>c.target) c.per = Math.max(c.per-c.pspd, c.target);
    if(c.per===c.target) c.target = 0;
  }
  c.outPer = c.per;
  if(c.gliss && song.fmt==='mod') c.outPer = trkPer(song, modNoteOfPeriod(c.per/4)+24, c.smp||{}, c.ft);
}
function modWave(w, pos){                     // pos 0..63, результат −255..255
  const i = pos&31, neg = pos&32;
  const v = (w&3)===0 ? TRK_SINE[i] : (w&3)===1 ? (neg ? 255-i*8 : i*8) : 255;
  return neg ? -v : v;
}
function modVibrato(c){
  c.outPer = c.per + ((modWave(c.vwav, c.vpos)*c.vdep) >> (c.vfine ? 7 : 5));
  c.vpos = (c.vpos + c.vspd)&63;
}
function modTremolo(c){
  c.outVol = clamp(c.vol + ((modWave(c.twav, c.tpos)*c.tdep)>>6), 0, 64);
  c.tpos = (c.tpos + c.tspd)&63;
}
function trkTremor(c, xm){
  const on = (c.mTr>>4)+1, off = (c.mTr&15)+1, up = c.trPos < on;
  c.outVol = up ? c.vol : 0;
  c.trPos = (c.trPos+1) % (on+off);
  if(xm){ c.trZero = !up; c.trVolAt = c.vol; }     // FT2: тишина держится до следующей смены громкости
}
function trkArp(song, c, p, t){
  const k = t%3; if(!k) return;
  const add = k===1 ? p>>4 : p&15;
  if(song.fmt==='mod'){ c.outPer = trkPer(song, modNoteOfPeriod(c.per/4)+24+add, c.smp||{}, c.ft); return; }
  if(song.fmt==='xm' && song.linear){ c.outPer = c.per - add*64; return; }
  c.outPer = c.per*Math.pow(2, -add/12);
}
function trkRetrig(pl, c){
  const y = c.mRy; if(!y) return;
  if(++c.rtCnt>=y){ c.rtCnt = 0; c.vol = clamp(Math.round(TRK_RETRIG[c.mRx](c.vol)),0,64); c.outVol = c.vol; trkTrigger(pl, c); }
}
function modTickFx(pl){
  const t = pl.tick, song = pl.song, xm = song.fmt==='xm', s3m = song.fmt==='s3m';
  for(const c of pl.chn){
    c.outPer = c.per; c.outVol = c.vol; c.outPan = c.pan;
    const e = c.eff, p = c.prm, x = p>>4, y = p&15;
    const v = c.vcmd, vlo = v&15;              // колонка громкости XM, тики 1+
    switch(v>>4){
      case 6: c.vol = Math.max(0, c.vol-vlo); c.outVol = c.vol; break;
      case 7: c.vol = Math.min(64, c.vol+vlo); c.outVol = c.vol; break;
      case 0xB: modVibrato(c); break;
      case 0xD: c.pan = Math.max(0, c.pan-vlo); c.outPan = c.pan; break;
      case 0xE: c.pan = Math.min(255, c.pan+vlo); c.outPan = c.pan; break;
      case 0xF: modTonePorta(song, c); break;
    }
    if(s3m){ trkTickS3M(pl, c, e, p, x, y, t); trkClampPer(song, c); continue; }
    switch(e){
      case 0: if(p) trkArp(song, c, p, t); break;
      case 1: c.per -= (xm ? c.mPU : p)*4; trkClampPer(song, c); c.outPer = c.per; break;
      case 2: c.per += (xm ? c.mPD : p)*4; trkClampPer(song, c); c.outPer = c.per; break;
      case 3: modTonePorta(song, c); break;
      case 4: modVibrato(c); break;
      case 5: modTonePorta(song, c); modVolSlide(c, xm ? c.mVS : p); c.outVol = c.vol; break;
      case 6: modVolSlide(c, xm ? c.mVS : p); c.outVol = c.vol; modVibrato(c); break;
      case 7: modTremolo(c); break;
      case 10: modVolSlide(c, xm ? c.mVS : p); c.outVol = c.vol; break;
      case 14:
        if(x===9 && y && t%y===0) trkTrigger(pl, c);
        else if(x===0xC && t===y){ c.vol = 0; c.outVol = 0; }
        else if(x===0xD && c.delay && t===c.delay.t) trkDelayed(pl, c);
        break;
      case 17: { const q = c.mGS; pl.gvol = clamp((q>>4) ? pl.gvol+(q>>4) : pl.gvol-(q&15), 0, 64); break; }
      case 20: if(t===p) trkKeyOff(c); break;
      case 25: { const q = c.mPS; c.pan = clamp((q>>4) ? c.pan+(q>>4) : c.pan-(q&15), 0, 255); c.outPan = c.pan; break; }
      case 27: trkRetrig(pl, c); break;
      case 29: trkTremor(c, xm); break;
    }
  }
}
function trkDelayed(pl, c){
  const d = c.delay; c.delay = null;
  modRowNote(pl, c, d.note, d.inst);
  c.outPer = c.per; c.outVol = c.vol; c.outPan = c.pan;
}
function trkTickS3M(pl, c, e, p, x, y, t){
  switch(e-100){
    case 4: case 11: case 12: {                                          // D K L
      const q = c.mD, qx = q>>4, qy = q&15;
      if(e===111) modVibrato(c);
      if(e===112) modTonePorta(pl.song, c);
      if(qx===15 && qy || qy===15 && qx) break;                          // тонкие — только на тике 0
      if(!qy) c.vol = Math.min(64, c.vol+qx); else if(!qx) c.vol = Math.max(0, c.vol-qy);
      c.outVol = c.vol;
      break;
    }
    case 5: case 6: { const q = c.mE; if((q>>4)<14){ c.per += (e===105 ? 1 : -1)*q*4; c.outPer = c.per; } break; }
    case 7: modTonePorta(pl.song, c); break;
    case 8: case 21: modVibrato(c); break;
    case 9: trkTremor(c); break;
    case 10: if(c.mJ) trkArp(pl.song, c, c.mJ, t); break;
    case 17: trkRetrig(pl, c); break;
    case 18: modTremolo(c); break;
    case 19:
      if(x===0xC && t===y){ c.vol = 0; c.outVol = 0; }
      else if(x===0xD && c.delay && t===c.delay.t) trkDelayed(pl, c);
      break;
    case 20: if(p<0x20 && c.mT){ const q = c.mT; pl.bpm = clamp(q<16 ? pl.bpm-q : pl.bpm+(q&15), 32, 255); } break;
  }
}
function trkEnvVal(e, t){
  const P = e.pts;
  if(t<=P[0][0]) return P[0][1];
  for(let i=0;i<P.length-1;i++){
    const a = P[i], b = P[i+1];
    if(t<b[0]) return b[0]>a[0] ? a[1] + (b[1]-a[1])*(t-a[0])/(b[0]-a[0]) : b[1];
  }
  return P[P.length-1][1];
}
function trkEnvStep(e, t, keyOff){
  if(e.sus && !keyOff && t===e.pts[e.s][0]) return t;
  t++;
  if(e.loop && t===e.pts[e.le][0] && !(e.sus && !keyOff && e.s===e.le)) t = e.pts[e.ls][0];   // FT2: только точное попадание
  return t;
}
// итог тика: огибающие, затухание, автовибрато XM, общая громкость
function trkPost(pl){
  const song = pl.song;
  for(const c of pl.chn){
    if(c.trZero && c.vol!==c.trVolAt) c.trZero = false;
    let vol = c.trZero ? 0 : clamp(c.outVol,0,64), pan = clamp(c.outPan,0,255), per = c.outPer;
    const ins = c.ins;
    if(ins){
      if(ins.venv.on){ c.envV = trkEnvVal(ins.venv, c.envVT); c.envVT = trkEnvStep(ins.venv, c.envVT, c.keyOff); vol *= c.envV/64; }
      if(ins.penv.on){ c.envP = trkEnvVal(ins.penv, c.envPT); c.envPT = trkEnvStep(ins.penv, c.envPT, c.keyOff);
        pan += (c.envP-32)*(128-Math.abs(pan-128))/32; }
      if(c.keyOff){ c.fade = Math.max(0, c.fade-ins.fade); vol *= c.fade/32768; }   // FT2: и без огибающей
      const av = ins.vib;
      if(av.depth && av.rate){
        c.avT++;
        const dep = av.sweep ? av.depth*Math.min(1, c.avT/av.sweep) : av.depth;
        const ph = c.avPos&255;
        const w = av.type===1 ? (ph<128 ? 64 : -64) : av.type===2 ? 64-(ph>>1) : av.type===3 ? (ph>>1)-64 : Math.sin(ph/128*Math.PI)*64;
        per += w*dep/16;
        c.avPos = (c.avPos + av.rate)&255;
      }
    }
    c.fin = vol*pl.gvol/64/64*(song.chVol?.[c.k] ?? 1);
    c.finPan = clamp(pan,0,255);
    c.finPer = per;
  }
}
function modAdvance(pl){
  const song = pl.song, len = song.orders.length;
  if(pl.loopJump>=0){ pl.row = pl.loopJump; }
  else if(pl.jump!==-1 || pl.brk>=0){
    if(pl.mode==='song'){
      const next = pl.jump>=0 ? pl.jump : pl.ord+1;
      // Bxx назад — песня зациклена сама; без loop на этом и заканчиваем
      if(pl.jump>=0 && next<=pl.ord && !pl.loop){ pl.jump = pl.brk = pl.loopJump = -1; modEnd(pl); return; }
      pl.ord = next;
    }
    pl.row = Math.max(0, pl.brk);
    if(pl.ord<len && pl.row>=modRows(pl)) pl.row = 0;
  } else if(++pl.row>=modRows(pl)){ pl.row = 0; if(pl.mode==='song') pl.ord++; }
  pl.jump = -1; pl.brk = -1; pl.loopJump = -1;
  if(pl.ord>=len){
    pl.ord = song.restart<len ? song.restart : 0;
    if(!pl.loop) modEnd(pl);
  }
}
function modEnd(pl){ pl.playing = false; pl.ended = true; pl.ord = 0; pl.row = 0; }
function modDoTick(pl){
  const row = pl.tick===0 && !pl.inDelay;
  if(row) modRow(pl);
  else modTickFx(pl);
  trkPost(pl);
  if(++pl.tick>=pl.speed){
    pl.tick = 0;
    if(pl.delay>0){ pl.delay--; pl.inDelay = true; }
    else { pl.inDelay = false; pl.delay = 0; modAdvance(pl); }
  }
  return row;
}
// Рендер len семплов: каждый канал — в pl.bufs[k] (моно, с громкостью), ворота нот — в pl.gates[k].
function modRender(pl, len, o){
  const song = pl.song, sr = o.sr;
  modPlayerChannels(pl);
  const N = pl.chn.length;
  for(let k=0;k<N;k++){
    if(!pl.bufs[k] || pl.bufs[k].length!==len){ pl.bufs[k] = new Float32Array(len); pl.gates[k] = new Float32Array(len); }
    pl.bufs[k].fill(0);
  }
  pl.bufs.length = N; pl.gates.length = N;
  if(!pl.clk || pl.clk.length!==len) pl.clk = new Float32Array(len);
  pl.clk.fill(0);
  let i = 0;
  while(i<len){
    if(pl.left<=0){
      if(pl.playing && modDoTick(pl)) pl.clk[i] = 1;        // импульс на каждую строку — такт для других секвенсоров
      else trkPost(pl);
      pl.left += sr*2.5/pl.bpm;
    }
    const n = Math.min(len-i, Math.ceil(pl.left));
    for(let k=0;k<N;k++){
      const c = pl.chn[k], B = pl.bufs[k], G = pl.gates[k];
      const on = c.active && !c.keyOff && c.fin>0 ? 1 : 0;
      G.fill(on, i, i+n);
      if(c.trig!==c.trigSeen){ c.trigSeen = c.trig; G[i] = 0; }          // новая нота — провал ворот на семпл
      if(!c.active || !(c.finPer>0)){ c.vu *= 0.9; continue; }
      const s = c.smp;
      if(c.ext){ c.vu = Math.max(c.fin, c.vu*0.9); continue; }         // звук делает узел-генератор
      if(!s || !s.data.length){ c.active = false; continue; }
      const f = modSmpF(s), L = f.length, loop = s.loop && s.ll>=2 ? s.loop : 0;
      const ls = s.ls, end = loop ? Math.min(ls+s.ll, L) : L, span = end-ls;
      const step = trkFreq(song, c.finPer)/sr;
      const g = c.mute || (pl.solo>=0 && pl.solo!==k) ? 0 : c.fin;
      let pos = c.pos, dir = c.dir, pk = 0;
      for(let j=0;j<n;j++){
        if(dir>0 && pos>=end){
          if(!loop){ c.active = false; break; }
          if(loop===1) pos = ls + (pos-end)%span;
          else { pos = end - (pos-end)%span - 1e-6; dir = -1; }
        } else if(dir<0 && pos<ls){ pos = ls + (ls-pos)%span; dir = 1; }
        const i0 = pos|0;
        let vv;
        if(o.interp){ const nx = i0+1<end ? f[i0+1] : loop===1 ? f[ls] : f[i0]; vv = f[i0] + (nx-f[i0])*(pos-i0); }
        else vv = f[i0];
        B[i+j] = vv*g;
        const a = vv<0 ? -vv : vv; if(a>pk) pk = a;
        pos += step*dir;
      }
      c.pos = pos; c.dir = dir;
      c.vu = Math.max(pk*c.fin, c.vu*0.9);
    }
    pl.left -= n; i += n;
  }
}
