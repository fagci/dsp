// Проверка разбора RDS: node tools/test-rds.mjs
// Группы кодируются в биты с настоящими контрольными словами и идут через rdsParserMake().
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({console,Math,Array,Map,String,Number,Date,Object,JSON});
vm.runInContext(fs.readFileSync(path.join(root,'modules/rds-kernels.js'),'utf8')+
  ';this.K={rdsParserMake,rdsCallsign,rdsCountry,rdsCoverage,rdsPsView,rdsFreqText,RDS_PTY,RBDS_PTY};',ctx,{filename:'rds-kernels.js'});
const K=ctx.K;
let bad=0;
const ok=(c,m)=>{ if(!c){ bad++; console.log('FAIL',m); } else console.log('ok  ',m); };

const OFF=[0x0FC,0x198,0x168,0x1B4], OFFC2=0x350;
const syn=w=>{ let r=0; for(let i=25;i>=0;i--){ r=(r<<1)|((w>>>i)&1); if(r&0x400) r^=0x5B9; } return r&0x3FF; };
const block=(data,off)=>((data<<10)|(syn(data<<10)^off))>>>0;
const bitsOf=(w,n)=>Array.from({length:n},(_,i)=>(w>>>(n-1-i))&1);
const ch=s=>[...s].map(c=>c.charCodeAt(0));
// группа → 104 бита; c2 — блок C' для версии B
function grp(pi,type,ver,tp,pty,low5,c,d,{c2=false,badBlock=-1}={}){
  const b=(type<<12)|(ver<<11)|(tp<<10)|(pty<<5)|(low5&31);
  const w=[block(pi,OFF[0]),block(b,OFF[1]),block(c,c2?OFFC2:OFF[2]),block(d,OFF[3])];
  if(badBlock>=0) w[badBlock]^=0x2000;                  // испорченный блок
  return w.flatMap(x=>bitsOf(x,26));
}
function feed(p,bits){ for(const b of bits) p.bit(b); }
const PI=0xE1C4;                                         // E — страна, 1 — международный
const w2=(a,b)=>(a<<8)|b;

// ----- синхронизация и PS/PTY/TP/TA/MS/DI/AF -----
{
  const p=K.rdsParserMake();
  let bits=[1,0,1,1,0,0,1,0,1,1,1,0,0,1];                // мусор до начала
  const ps='TEST FM ';
  for(let rep=0;rep<3;rep++) for(let s=0;s<4;s++){
    const di=[1,0,1,1][s];                               // d3 d2 d1 d0
    bits=bits.concat(grp(PI,0,0,1,10,(1<<4)|(1<<3)|(di<<2)|s, s===0?w2(225,40):s===1?w2(250,3):w2(5,6), w2(ps.charCodeAt(2*s),ps.charCodeAt(2*s+1))));
  }
  feed(p,bits);
  const s=p.snap();
  ok(s.sync,'синхронизация по блокам');
  ok(s.pi===PI,'PI');
  ok(s.ps==='TEST FM ' && K.rdsPsView(s)==='TEST FM ','PS собран из 4 сегментов');
  ok(s.pty===10 && s.tp===1 && s.ta===1 && s.ms===1,'PTY / TP / TA / M-S');
  ok(JSON.stringify(s.di)==='[1,0,1,1]','DI (динамический PTY, голова, стерео)');
  ok(s.af.includes(87500+100*40) && s.af.includes(153+9*2) && s.af.includes(87500+100*5) && s.af.includes(87500+100*6),'список AF: FM и LF');
  ok(s.groups===12 && s.grp[0]===12,'счётчики групп');
  ok(s.bler===0,'блоки без ошибок');
  ok(K.rdsPsView(K.rdsParserMake().snap())==='','пустой PS до приёма');
}

// ----- RadioText 2A, A/B, окончание по CR -----
{
  const p=K.rdsParserMake(); let bits=[];
  const rt='Hello RDS\r'.padEnd(12,' ');
  for(let rep=0;rep<2;rep++) for(let s=0;s<3;s++){
    const t=ch(rt.slice(4*s,4*s+4));
    bits=bits.concat(grp(PI,2,0,0,0,s,w2(t[0],t[1]),w2(t[2],t[3])));
  }
  feed(p,bits);
  ok(p.snap().rt==='Hello RDS','RadioText до CR');
  const rt2='New text!';
  bits=[]; for(let s=0;s<3;s++){ const t=ch(rt2.padEnd(12,' ').slice(4*s,4*s+4)); bits=bits.concat(grp(PI,2,0,0,0,16|s,w2(t[0],t[1]),w2(t[2],t[3]))); }
  feed(p,bits);
  ok(p.snap().rt==='New text!','переключение A/B очищает текст');
}

// ----- ECC / LIC / PIN, CT -----
{
  const p=K.rdsParserMake(); let bits=[];
  const pin=(5<<11)|(7<<6)|30;
  bits=bits.concat(grp(PI,1,0,0,0,0,0x00E1,pin), grp(PI,1,0,0,0,0,(3<<12)|0x08,pin));
  const mjd=60431, h=12, mi=34, off=4;                   // 2024-05-01 12:34 UTC, +2:00
  const c=((mjd&0x7fff)<<1)|(h>>4), d=((h&15)<<12)|(mi<<6)|off;
  bits=bits.concat(grp(PI,4,0,0,0,mjd>>15,c,d), grp(PI,0,0,0,0,0,0,0), grp(PI,0,0,0,0,0,0,0));
  feed(p,bits);
  const s=p.snap();
  ok(s.ecc===0xE1 && K.rdsCountry(s.pi,s.ecc)==='RO' && K.rdsCountry(0xC201,0xE1)==='GB' && K.rdsCountry(0xC201,0)==='','ECC + первая цифра PI → страна');
  ok(s.lic===8,'LIC');
  ok(s.pin && s.pin.day===5 && s.pin.h===7 && s.pin.m===30,'PIN');
  ok(s.ct && new Date(s.ct.ts).toISOString()==='2024-05-01T12:34:00.000Z' && s.ct.off===120,'CT: дата, время UTC и смещение');
}

// ----- ODA, RadioText+, PTYN, EON -----
{
  const p=K.rdsParserMake(); let bits=[];
  const rt='Artist - Song title    ';
  const t=ch(rt);
  for(let s=0;s<6;s++) bits=bits.concat(grp(PI,2,0,0,0,s,w2(t[4*s],t[4*s+1]),w2(t[4*s+2],t[4*s+3])));
  bits=bits.concat(grp(PI,3,0,0,0,11<<1,0x0000,0x4BD7));                    // RT+ в группе 11A
  // тег 1: тип 4 (artist), с 0, длина 6; тег 2: тип 1 (title), с 9, длина 10
  const ct1=4,s1=0,l1=6-1, ct2=1,s2=9,l2=10-1;
  const b=(1<<3)|(ct1>>3), c=((ct1&7)<<13)|(s1<<7)|(l1<<1)|(ct2>>5), d=((ct2&31)<<11)|(s2<<5)|l2;
  bits=bits.concat(grp(PI,11,0,0,0,b,c,d));
  for(let s=0;s<2;s++){ const q=ch('JAZZ    '.slice(4*s,4*s+4)); bits=bits.concat(grp(PI,10,0,0,0,s,w2(q[0],q[1]),w2(q[2],q[3]))); }
  const ON=0x2204, onps='NEWS FM ';
  for(let v=0;v<4;v++) bits=bits.concat(grp(PI,14,0,0,0,v,w2(onps.charCodeAt(2*v),onps.charCodeAt(2*v+1)),ON));
  bits=bits.concat(grp(PI,14,0,0,0,4,w2(30,31),ON), grp(PI,14,0,0,0,13,(7<<11)|1,ON));
  feed(p,bits);
  const s=p.snap();
  ok(s.oda.some(o=>o.aid===0x4BD7 && o.gc===22),'ODA: приложение RT+');
  ok(JSON.stringify(s.rtp.map(x=>[x.ct,x.text]))==='[[4,"Artist"],[1,"Song title"]]','RT+: исполнитель и название');
  ok(s.rtpRun===1,'RT+: «идёт сейчас»');
  ok(s.ptyn==='JAZZ','PTYN');
  const e=s.eon.find(x=>x.pi===ON);
  ok(e && e.ps==='NEWS FM ' && e.pty===7 && e.ta===1 && e.af.length===2,'EON: PS, PTY, TA, AF чужой сети');
}

// ----- ошибки блоков: группа с битым блоком D не портит PS, счётчик ошибок растёт -----
{
  const p=K.rdsParserMake(); let bits=[];
  for(let rep=0;rep<3;rep++) for(let s=0;s<4;s++) bits=bits.concat(grp(PI,0,0,0,0,s,0,w2(65+2*s,66+2*s)));
  bits=bits.concat(grp(PI,0,0,0,0,0,0,w2(0x58,0x58),{badBlock:3}));
  feed(p,bits);
  const s=p.snap();
  ok(s.ps==='ABCDEFGH','битый блок D не принят');
  ok(s.bler>0 && s.bad===1,'ошибки блоков посчитаны');
}

// ----- версия B: PI берётся из блока C' -----
{
  const p=K.rdsParserMake(); let bits=[];
  for(let i=0;i<4;i++) bits=bits.concat(grp(PI,0,1,0,3,i&3,PI,w2(48+i,48+i),{c2:true}));
  feed(p,bits);
  ok(p.snap().pi===PI && p.snap().sync,'версия B: синхронизация по C\' и PI');
}

// ----- справочное -----
ok(K.rdsCallsign(0x1000)==='KAAA' && K.rdsCallsign(21672)==='WAAA' && K.rdsCallsign(21671)==='KZZZ' && K.rdsCallsign(0xE1C4)==='','позывной RBDS по PI');
ok(K.rdsCoverage(0xE1C4)==='international' && K.rdsCoverage(0xE2C4)==='national' && K.rdsCoverage(0xE7C4)==='regional R4','зона охвата');
ok(K.RDS_PTY.length===32 && K.RBDS_PTY.length===32,'таблицы PTY');
ok(K.rdsFreqText(87600)==='87.6 MHz' && K.rdsFreqText(531)==='531 kHz','подпись частоты');

console.log(bad ? bad+' FAIL' : 'all ok');
process.exit(bad?1:0);
