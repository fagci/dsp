"use strict";
/* ============================ Ядро управления ============================
   Виртуальный джойстик: клавиатура → оси, сглаживание, кадры для канала управления (текст / hex / RC-микросекунды).
   Мост nRF24L01+ (USB, WebSerial): строки команд и ответов. Без DOM — проверяется tools/test-control.mjs. */

// ---------- джойстик ----------
// KeyboardEvent.code → ось и знак, либо кнопка b1…b8
const JOY_KEYS={
  KeyW:['y1',1], KeyS:['y1',-1], KeyA:['x1',-1], KeyD:['x1',1],
  ArrowUp:['y2',1], ArrowDown:['y2',-1], ArrowLeft:['x2',-1], ArrowRight:['x2',1],
  Space:['b',1], Enter:['b',2], KeyZ:['b',3], KeyX:['b',4], KeyQ:['b',5], KeyE:['b',6], KeyR:['b',7], KeyF:['b',8],
};
// множество нажатых кодов → целевые оси (−1…1) и кнопки (0/1); противоположные клавиши гасят друг друга
function joyTarget(down){
  const t={x1:0,y1:0,x2:0,y2:0,b:[0,0,0,0,0,0,0,0]};
  for(const c of down){
    const k=JOY_KEYS[c]; if(!k) continue;
    if(k[0]==='b') t.b[k[1]-1]=1; else t[k[0]]+=k[1];
  }
  return t;
}
// плавное движение к цели: за rampS секунд — от 0 до 1; 0 — мгновенно
function joyStep(cur,target,dt,rampS){
  if(!(rampS>0)) return target;
  const d=dt/rampS;
  return cur<target ? Math.min(target,cur+d) : Math.max(target,cur-d);
}
// мёртвая зона и экспонента: expo 0 — линейно, 1 — кубическая (мягко у центра)
function joyShape(v,dead,expo){
  const a=Math.abs(v); if(a<=dead) return 0;
  const u=Math.min(1,(a-dead)/(1-dead)), y=(1-expo)*u+expo*u*u*u;
  return v<0 ? -y : y;
}
// инверсия вертикали: какие стики меняют знак Y (назад / на себя = вверх)
const JOY_INV=['none','right stick','left stick','both sticks'];
const joyInvY=(sel,axis)=>axis==='y2' ? sel==='right stick' || sel==='both sticks' : axis==='y1' ? sel==='left stick' || sel==='both sticks' : false;
const joyBits=b=>b.reduce((s,v,i)=>s|(v?1<<i:0),0);
const joyI8=v=>Math.round(Math.max(-1,Math.min(1,v))*127);
// кадр из 7 байт: A5, x1, y1, x2, y2 (знаковые байты), кнопки (бит i — b(i+1)), XOR всех предыдущих
function joyHexFrame(x1,y1,x2,y2,bits){
  const b=[0xA5,joyI8(x1)&255,joyI8(y1)&255,joyI8(x2)&255,joyI8(y2)&255,bits&255];
  let x=0; for(const v of b) x^=v; b.push(x);
  return b.map(v=>v.toString(16).padStart(2,'0')).join('').toUpperCase();
}
// шаблон: {x1} {y1} {x2} {y2} — −1…1; {X1} {Y1} {X2} {Y2} — −100…100; {r1}…{r4} — 1000…2000 мкс (x1, y1, x2, y2);
// {b1}…{b8}, {bits}, {hex}, {n} — счётчик кадров, {t} — время, мс. {x1:3} — знаков после запятой
function joyFormat(tpl,v,n,t){
  const ax=['x1','y1','x2','y2'];
  return String(tpl).replace(/\{([a-zA-Z]+)(\d*)(?::(\d+))?\}/g,(m,a,i,d)=>{
    const k=a+i, dec=d!=null ? +d : 2;
    if(ax.includes(k)) return v[k].toFixed(dec);
    if(/^[XY][12]$/.test(k)) return String(Math.round(v[k.toLowerCase()]*100));
    if(a==='r' && i>=1 && i<=4) return String(Math.round(1500+500*v[ax[i-1]]));
    if(a==='b' && i>=1 && i<=8) return String(v.b[i-1]);
    if(k==='bits') return String(joyBits(v.b));
    if(k==='hex') return joyHexFrame(v.x1,v.y1,v.x2,v.y2,joyBits(v.b));
    if(k==='n') return String(n);
    if(k==='t') return String(t);
    return m;
  });
}

// ---------- мост nRF24L01+ ----------
const NRF_RATES=['250K','1M','2M'];
// hex из «DE AD be-ef», «0xDE,0xAD» — чистая строка заглавных, чётной длины; иначе null
function nrfHex(s){
  const h=String(s).replace(/0x/gi,'').replace(/[\s,;:\-]/g,'');
  return h.length>0 && h.length%2===0 && /^[0-9a-fA-F]+$/.test(h) ? h.toUpperCase() : null;
}
function nrfTextToHex(text){
  const b=new TextEncoder().encode(String(text));
  return Array.from(b,v=>v.toString(16).padStart(2,'0')).join('').toUpperCase();
}
function nrfHexToText(hex){
  const b=new Uint8Array(hex.length>>1);
  for(let i=0;i<b.length;i++) b[i]=parseInt(hex.substr(i*2,2),16);
  return new TextDecoder().decode(b).replace(/[\x00-\x08\x0b-\x1f\x7f]/g,'·');
}
// строка настройки: канал 0…125 (2400 + ch МГц), скорость, адрес 3…5 байт, размер пакета (0 — динамический), мощность 0…3, CRC 0 / 1 / 2 байта
function nrfCfgLine(p){
  const ch=Math.max(0,Math.min(125,Math.round(+p.ch)||0)), rate=NRF_RATES.includes(p.rate) ? p.rate : '1M';
  const addr=nrfHex(p.addr), ab=addr && addr.length>=6 && addr.length<=10 ? addr : 'E7E7E7E7E7';
  const pay=Math.max(0,Math.min(32,Math.round(+p.pay)||0)), pwr=Math.max(0,Math.min(3,Math.round(+p.pwr)||0)), crc=[0,1,2].includes(+p.crc) ? +p.crc : 2;
  return `CFG ch=${ch} rate=${rate} addr=${ab} pay=${pay} pwr=${pwr} crc=${crc} ack=${p.ack?1:0} retry=${Math.max(0,Math.min(15,Math.round(+p.retry)||0))}`;
}
// ответ моста → объект; null — не наша строка
function nrfParseLine(line){
  const s=String(line).trim(); if(!s) return null;
  const sp=s.indexOf(' '), k=(sp<0 ? s : s.slice(0,sp)).toUpperCase(), rest=sp<0 ? '' : s.slice(sp+1).trim();
  if(k==='RX'){ const m=rest.match(/^(\d+)\s+([0-9a-fA-F]+)$/); return m && m[2].length%2===0 ? {k:'rx',ch:+m[1],hex:m[2].toUpperCase()} : null; }
  if(k==='TXOK') return {k:'txok'};
  if(k==='TXFAIL') return {k:'txfail'};
  if(k==='OK') return {k:'ok'};
  if(k==='ERR') return {k:'err',msg:rest};
  if(k==='PONG') return {k:'pong',info:rest};
  if(k==='SCAN'){ const a=rest.split(',').map(x=>parseInt(x,10)); return a.length===126 && a.every(x=>x>=0) ? {k:'scan',counts:a} : null; }
  return null;
}
// сканирование: счётчик захвата несущей на канал (0…passes) → спектр: уровень −100…−40 дБ по доле проходов
function nrfScanSpec(counts,passes,rev){
  const N=counts.length, mag=new Float32Array(N), freqs=new Float64Array(N), mx=Math.max(1,passes);
  for(let i=0;i<N;i++){ mag[i]=Math.pow(10,(-100+60*Math.min(1,counts[i]/mx))/20); freqs[i]=(2400+i)*1e6; }
  return {mag,freqs,sr:N*1e6,size:N,rev:rev|0};
}
