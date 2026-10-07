"use strict";
/* ==========================================================================================
 * JS8Call, режим Normal (15 с, 6.25 Бод, 8 тонов по 6.25 Гц): кодек и приёмник слота.
 * Порт по исходникам JS8Call (js8call/js8call, GPLv3): genjs8.f90, encode174.f90,
 * bpdecode174.f90, chkcrc12a.f90, crc12.cpp, varicode.cpp, jsc.cpp.
 * Кадр: 72 бита текста (12 символов по 6 бит) + 3 бита i3 + CRC-12 (полином 0xC06, xor 42)
 * → LDPC(174,87) → 58 символов по 3 бита (без кода Грея) между блоками Костаса 7×7.
 * Чистые функции без DOM — проверяются в tools/test-kernels.mjs.
 * ========================================================================================== */
const JS8_GEN='23bba830e23b6b6f50982e1f8e55da218c5df3309052ca7b3217cd92bd59a5ae2056f78313537d0f4382964e29c29dba9c545e267762fe6be396b5e2e819e373340c293548a138858328af4210cb6c6afcdc28bb3f7c6e863f2a86f5c5bd225c961150849dd2d63673481860f62c56cdaec6e7ae14b43feeee04ef5cfa3766ba778f45a4c525ae4bd4f627320a3974fe37802941d66dde02b99c41fd9520b2e4abeb2f989c40907b01280f03c03239467fb36c24085a34d8c1dbc440fc3e44bb7d2bb2756e44d38ab0a1d2e52a8ec3bc763d0f929ef3949bd84d473445d3814f504064f80549aef14dbf263825d0bd04b05ef08a91fb2e1f78290619a87a8dec79a51e8ac5388022ca4186dd44c3121565cf5cdb714f8f64e8ac7af1a76e8d0274de71e7c1a8055eb051f81573dd4049b082de14d037db825175d851f3af00d8f937f31822e57c5623701bf1490607c54032660ede1616d78018d0b4745ca0f2a9fa8e50bcb032c85e330483f640f1a48a8ebc0443eaeca9afa0f6b01d92305edc3776af54ccfbae916afde66abb212d9739dfc02580f205209a0abb530b9e7e34b0612f63acc025b6ab476f7c0af7723161ec223080be86a8fc906976c35669e79ce045b7ab6242b77474d9f11ab274db8abd3c6f396ea3569059dfa2bb20ef7ef73ad43d188ea477f6fa41317a4e8d9071b7e7a6a2eed6965ea377253773ea678367c3f6ecbd7c73b9cd34c3720c8ab6537f417e61d1a70853366c280d2a0523d9c4bc5946d36d662a69ae24b74dcbd8d747bfc5fd65ef70fbd9bca9fa2eefa6f8796a355772cc9da55fe046d0cb3a770cf6ad4824b87c80ebfce466cc6de59755420925f90ed2164cc861bdd803c547f2acc0fc3ec4fb7d2bb27566440dbd816fba1543f721dc72a0c0033a52ab6299802fd2bf4f56e073271f6ab4bf8057da6d13cb96a7689b279081cfc6f18c35b1e1f17114481a2a0df8a23583f82d6c1ac4672b549cd6dba79bccc87af9a5d5206abca532a897d4169cb33e7435718d90a6573f3dc8b16c9d19f7462c4142bf42b01e71076acc081c29a10d468ccdbcecb65b0f7742bca86b8012609a012dee2198eba82b19a1daf1627701a2d692fd9449e635ad3fb0faeb5f1b0c30dcb1ca4ea2e3d173bad4379c37d8e0af9258b9e8c5f9b2cd921fdf59e882683763f66114e08483043fd3f38a8a2e547dd7a05f6597aac51695e45ecd0135aca9d6e6aeb33ec97be83ce413f9acc8c8b5dffc335095dcdcaf2a3dd01a59d86310743ec75214cd0f642fc0c5fe3a65ca3a0a1dfd7eee29c2e827e08abdb889efbe39a510a1183f231f212055371cf3e2a2';
const JS8_COL='0,1,2,3,30,4,5,6,7,8,9,10,11,32,12,40,13,14,15,16,17,18,37,45,29,19,20,21,41,22,42,31,33,34,44,35,47,51,50,43,36,52,63,46,25,55,27,24,23,53,39,49,59,38,48,61,60,57,28,62,56,58,65,66,26,70,64,69,68,67,74,71,54,76,72,75,78,77,80,79,73,83,84,81,82,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,161,162,163,164,165,166,167,168,169,170,171,172,173';
const JS8_NM_RAW='1,30,60,89,118,147;2,31,61,90,119,147;3,32,62,91,120,148;4,33,63,92,121,149;2,34,64,93,122,150;5,33,65,94,123,148;6,34,66,95,124,151;7,35,67,96,120,152;8,36,68,97,125,153;9,37,69,98,126,152;10,38,70,99,127,154;11,39,71,100,126,155;12,40,61,101,128,145;10,33,60,95,128,156;13,41,72,97,126,157;13,42,73,90,129,156;14,39,74,99,130,158;15,43,75,102,131,159;16,43,71,103,118,160;17,44,76,98,130,156;18,45,60,96,132,161;19,46,73,83,133,162;12,38,77,102,134,163;19,47,78,104,135,147;1,32,77,105,136,164;20,48,73,106,123,163;21,41,79,107,137,165;22,42,66,108,138,152;18,42,80,109,139,154;23,49,81,110,135,166;16,50,82,91,129,158;3,48,63,107,124,167;6,51,67,111,134,155;24,35,77,100,122,162;20,45,76,112,140,157;21,36,64,92,130,159;8,52,83,111,118,166;21,53,84,113,138,168;25,51,79,89,122,158;22,44,75,107,133,155,172;9,54,84,90,141,169;22,54,85,110,136,161;8,37,65,102,129,170;19,39,85,114,139,150;26,55,71,93,142,167;27,56,65,96,133,160,174;28,31,86,100,117,171;28,52,70,104,132,144;24,57,68,95,137,142;7,30,72,110,143,151;4,51,76,115,127,168;16,45,87,114,125,172;15,30,86,115,123,150;23,46,64,91,144,173;23,35,75,113,145,153;14,41,87,108,117,149,170;25,40,85,94,124,159;25,58,69,116,143,174;29,43,61,116,132,162;15,58,88,112,121,164;4,59,72,114,119,163,173;27,47,86,98,134,153;5,44,78,109,141;10,46,69,103,136,165;9,50,59,93,128,164;14,57,58,109,120,166;17,55,62,116,125,154;3,54,70,101,140,170;1,36,82,108,127,174;5,53,81,105,140;29,53,67,99,142,173;18,49,74,97,115,167;2,57,63,103,138,157;26,38,79,112,135,171;11,52,66,88,119,148;20,40,68,117,141,160;11,48,81,89,146,169;29,47,80,92,146,172;6,32,87,104,145,169;27,34,74,106,131,165;12,56,84,88,139;13,56,62,111,146,171;26,37,80,105,144,151;17,31,82,113,121,161;28,49,59,94,137;7,55,83,101,131,168;24,50,78,106,143,149';

const JS8_ALPHA='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-+/?.';
const JS8_COSTAS=[                                  // 0 — исходные (Normal), 1 — изменённые (остальные подрежимы)
  [[4,2,5,6,1,3,0],[4,2,5,6,1,3,0],[4,2,5,6,1,3,0]],
  [[0,6,2,3,5,4,1],[1,5,0,2,3,6,4],[2,5,0,6,4,1,3]]];
const JS8_SR=6400, JS8_WIN=1024, JS8_HOP=256, JS8_FFT=2048, JS8_TS=JS8_FFT/JS8_WIN, JS8_SYMS=79;
const JS8_SYM_SEC=.16, JS8_TX_SEC=JS8_SYMS*JS8_SYM_SEC, JS8_TX_DELAY=.5;

const JS8_NM=JS8_NM_RAW.split(';').map(r=>r.split(',').map(Number));       // проверки → номера бит (с 1)
const JS8_MN=(()=>{ const m=Array.from({length:174},()=>[]);
  JS8_NM.forEach((row,i)=>row.forEach(c=>m[c-1].push(i))); return m; })();   // бит → проверки (по 3)
const JS8_EDGE=JS8_NM.map((row,m)=>row.map(c=>JS8_MN[c-1].indexOf(m)));
const JS8_COLV=JS8_COL.split(',').map(Number);
const JS8_GENR=Array.from({length:87},(_,i)=>{
  const h=JS8_GEN.substr(i*22,22), r=new Uint8Array(87);
  for(let j=0;j<87;j++) r[j]=(parseInt(h[j>>2],16)>>(3-(j&3)))&1;
  return r; });

function js8Crc12(b72,i3){                          // деление с дополнением, 88 бит: 72 + i3 + 13 нулей
  const bits=b72.slice();
  for(let k=2;k>=0;k--) bits.push((i3>>k)&1);
  while(bits.length<88) bits.push(0);
  let rem=0;
  for(const b of bits){ const hi=(rem>>11)&1; rem=((rem<<1)|b)&0xfff; if(hi) rem^=0xc06; }
  return rem^42;
}
function js8MsgBits(b72,i3){                        // 87 бит: текст, i3, CRC-12
  const b=b72.concat([(i3>>2)&1,(i3>>1)&1,i3&1]), c=js8Crc12(b72,i3);
  for(let k=11;k>=0;k--) b.push((c>>k)&1);
  return b;
}
function js8Encode(b87){                            // 87 бит → 174, порядок передачи
  const it=new Uint8Array(174);
  for(let i=0;i<87;i++){ let p=0; const g=JS8_GENR[i]; for(let j=0;j<87;j++) p^=g[j]&b87[j]; it[i]=p; }
  for(let i=0;i<87;i++) it[87+i]=b87[i];
  const cw=new Uint8Array(174);
  for(let k=0;k<174;k++) cw[JS8_COLV[k]]=it[k];
  return cw;
}
function js8Ldpc(llr,iters){                        // распространение доверия, min-sum
  const N=174, M=87, IT=iters||50;
  const tov=Array.from({length:N},()=>new Float64Array(3));
  const hard=new Uint8Array(N), tot=new Float64Array(N), nm=new Float64Array(7);
  for(let it=0;it<=IT;it++){
    for(let i=0;i<N;i++){ const t=tov[i]; tot[i]=llr[i]+t[0]+t[1]+t[2]; hard[i]=tot[i]>0?0:1; }
    let bad=0;
    for(let m=0;m<M;m++){ let p=0; for(const c of JS8_NM[m]) p^=hard[c-1]; bad+=p; }
    if(!bad) return {ok:true,bits:hard,iters:it};
    for(let m=0;m<M;m++){
      const row=JS8_NM[m], ed=JS8_EDGE[m], L=row.length;
      for(let a=0;a<L;a++){                         // сообщения от других битов проверки берутся до обновления
        let mag=1e9, sgn=1;
        for(let b=0;b<L;b++){
          if(a===b) continue;
          const i=row[b]-1, s=tot[i]-tov[i][ed[b]];
          const as=s<0?-s:s; if(as<mag) mag=as;
          if(s<0) sgn=-sgn; }
        nm[a]=.75*sgn*mag; }
      for(let a=0;a<L;a++) tov[row[a]-1][ed[a]]=nm[a]; }
  }
  return {ok:false,bits:hard,iters:IT};
}
function js8Extract(cw){                            // 174 бит кодового слова → {b72,i3} или null, если CRC не сошёлся
  const d=new Uint8Array(87);
  for(let i=0;i<87;i++) d[i]=cw[JS8_COLV[87+i]];
  const b72=Array.from(d.subarray(0,72)), i3=d[72]*4+d[73]*2+d[74];
  let crc=0; for(let k=0;k<12;k++) crc=crc*2+d[75+k];
  return js8Crc12(b72,i3)===crc ? {b72,i3} : null;
}
// 72 бита + i3 → 79 тонов: Костас, 29 + 29 информационных символов (3 бита подряд, без кода Грея)
function js8Tones(b72,i3,costas){
  const cw=js8Encode(js8MsgBits(b72,i3)), C=JS8_COSTAS[costas|0], t=new Array(JS8_SYMS);
  for(let g=0;g<3;g++) for(let k=0;k<7;k++) t[g*36+k]=C[g][k];
  for(let j=0;j<58;j++){ const s=j<29 ? 7+j : 14+j; t[s]=cw[3*j]*4+cw[3*j+1]*2+cw[3*j+2]; }
  return t;
}
function js8Chars(b72){ let s=''; for(let i=0;i<12;i++) s+=JS8_ALPHA[bitsNum(b72,i*6,6)]; return s; }
function js8FromChars(s){
  const b=[]; for(const ch of s){ const v=JS8_ALPHA.indexOf(ch); if(v<0||v>63) return null; for(let k=5;k>=0;k--) b.push((v>>k)&1); }
  return b.length===72 ? b : null;
}

/* ---------- кадры: позывные, локатор, команды ---------- */
const JS8_AN='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ /@';
const JS8_NBASECALL=37*36*10*27*27*27, JS8_NBASEGRID=180*180, JS8_NUSERGRID=JS8_NBASEGRID+10, JS8_NMAXGRID=(1<<15)-1;
const JS8_BASECALLS=['<....>','@ALLCALL','@JS8NET','@DX/NA','@DX/SA','@DX/EU','@DX/AS','@DX/AF','@DX/OC','@DX/AN',
  '@REGION/1','@REGION/2','@REGION/3','@GROUP/0','@GROUP/1','@GROUP/2','@GROUP/3','@GROUP/4','@GROUP/5','@GROUP/6',
  '@GROUP/7','@GROUP/8','@GROUP/9','@COMMAND','@CONTROL','@NET','@NTS','@RESERVE/0','@RESERVE/1','@RESERVE/2',
  '@RESERVE/3','@RESERVE/4','@APRSIS','@RAGCHEW','@JS8','@EMCOMM','@ARES','@MARS','@AMRRON','@RACES','@RAYNET',
  '@RADAR','@SKYWARN','@CQ','@HB','@QSO','@QSOPARTY','@CONTEST','@FIELDDAY','@SOTA','@IOTA','@POTA','@QRP','@QRO'];   // nbasecall+1…
// номер → команда (то, что отдаёт QMap::key, первый по алфавиту); пробел в начале — часть команды
const JS8_CMD=[' SNR?',' DIT DIT',' NACK',' HEARING?',' GRID?','>',' STATUS?',' STATUS',' HEARING',' MSG',' MSG TO:',' QUERY',
  ' QUERY MSGS',' QUERY CALL',' ACK',' GRID',' INFO?',' INFO',' FB',' HW CPY?',' SK',' RR',' QSL?',' QSL',' CMD',' SNR',
  ' NO',' YES',' 73',' HEARTBEAT SNR',' AGN?',' '];
const JS8_CMD_NUM=Object.assign({'?':0,'  ':31,' HB':-1,' CQ':-1,' HEARTBEAT':-1,' QUERY MSGS?':12},
  Object.fromEntries(JS8_CMD.map((c,i)=>[c,i])));
const JS8_CQS=['CQ CQ CQ','CQ DX','CQ QRP','CQ CONTEST','CQ FIELD','CQ FD','CQ CQ','CQ'];
const js8IsSnrCmd=c=>c===' SNR'||c===' HEARTBEAT SNR';

function js8PackAN50(v){                            // до 11 знаков: позывной с префиксом/суффиксом, группа @…
  let w=String(v).toUpperCase().replace(/[^A-Z0-9 /@]/g,'');
  if(w.length>3 && w[3]!=='/') w=w.slice(0,3)+' '+w.slice(3);
  if(w.length>7 && w[7]!=='/') w=w.slice(0,7)+' '+w.slice(7);
  if(w.length>11) return 0n;
  w=w.padEnd(11,' ');
  const ix=i=>BigInt(JS8_AN.indexOf(w[i]));
  let p=ix(0);
  p=p*38n+ix(1); p=p*38n+ix(2); p=p*2n+(w[3]==='/'?1n:0n);
  p=p*38n+ix(4); p=p*38n+ix(5); p=p*38n+ix(6); p=p*2n+(w[7]==='/'?1n:0n);
  p=p*38n+ix(8); p=p*38n+ix(9); p=p*38n+ix(10);
  return p;
}
function js8UnpackAN50(p){
  const w=new Array(11);
  for(const [i,m] of [[10,38n],[9,38n],[8,38n]]){ w[i]=JS8_AN[Number(p%m)]; p/=m; }
  w[7]=p%2n?'/':' '; p/=2n;
  for(const i of [6,5,4]){ w[i]=JS8_AN[Number(p%38n)]; p/=38n; }
  w[3]=p%2n?'/':' '; p/=2n;
  w[2]=JS8_AN[Number(p%38n)]; p/=38n;
  w[1]=JS8_AN[Number(p%38n)]; p/=38n;
  w[0]=JS8_AN[Number(p%39n)];
  return w.join('').replace(/ /g,'');
}
function js8PackCall(call){                         // → {v:28 бит, p:/P} или null
  let c=String(call).toUpperCase().trim(), portable=false;
  const bi=JS8_BASECALLS.indexOf(c);
  if(bi>=0) return {v:JS8_NBASECALL+bi+1, p:false};
  if(c.endsWith('/P')){ c=c.slice(0,-2); portable=true; }
  if(c.startsWith('3DA0')) c='3D0'+c.slice(4);
  if(/^3X[A-Z]/.test(c)) c='Q'+c.slice(2);
  const n=c.length;
  if(n<2||n>6) return null;
  const perm=[c];
  if(n===2) perm.push(' '+c+'   ');
  if(n===3) perm.push(' '+c+'  ',c+'   ');
  if(n===4) perm.push(' '+c+' ',c+'  ');
  if(n===5) perm.push(' '+c,c+' ');
  let m=null;
  for(const s of perm) if(/^[0-9A-Z ][0-9A-Z][0-9][A-Z ][A-Z ][A-Z ]$/.test(s)) m=s;
  if(!m) return null;
  const ix=i=>JS8_AN.indexOf(m[i]);
  let v=ix(0);
  v=36*v+ix(1); v=10*v+ix(2); v=27*v+ix(3)-10; v=27*v+ix(4)-10; v=27*v+ix(5)-10;
  return {v, p:portable};
}
function js8UnpackCall(v,portable){
  if(v>JS8_NBASECALL && v<=JS8_NBASECALL+JS8_BASECALLS.length) return JS8_BASECALLS[v-JS8_NBASECALL-1];
  const w=new Array(6);
  for(let i=5;i>=3;i--){ w[i]=JS8_AN[v%27+10]; v=Math.floor(v/27); }
  w[2]=JS8_AN[v%10]; v=Math.floor(v/10);
  w[1]=JS8_AN[v%36]; v=Math.floor(v/36);
  w[0]=JS8_AN[v];
  let c=w.join('');
  if(c.startsWith('3D0')) c='3DA0'+c.slice(3);
  if(/^Q[A-Z]/.test(c)) c='3X'+c.slice(1);
  if(portable) c=c.trim()+'/P';
  return c.trim();
}
function js8PackGrid(g){                            // 4 знака локатора → 15 бит; долгота у JS8 отсчитывается от 180 к западу
  g=String(g).trim().toUpperCase();
  if(!/^[A-R]{2}\d\d/.test(g)) return JS8_NMAXGRID;
  const lon=180-20*(g.charCodeAt(0)-65)-2*(+g[2])-62.5/60;        // середина квадрата, как «mm» в 6-значном локаторе
  const lat=-90+10*(g.charCodeAt(1)-65)+(+g[3])+31.25/60;
  return (((Math.trunc(lon)+180)/2)|0)*180+Math.trunc(lat+90);
}
function js8UnpackGrid(v){
  if(v>JS8_NBASEGRID) return '';
  let lon=Math.floor(v/180)*2-180+2; const lat=v%180-90;
  if(lon<-180) lon+=360; if(lon>180) lon-=360;
  const nl=Math.trunc(60*(180-lon)/5), n1=Math.floor(nl/240), n2=Math.floor((nl-240*n1)/24);
  const nt=Math.trunc(60*(lat+90)/2.5), m1=Math.floor(nt/240), m2=Math.floor((nt-240*m1)/24);
  return String.fromCharCode(65+n1,65+m1,48+n2,48+m2);
}
const js8Bits=(v,n)=>{ const b=[]; for(let i=n-1;i>=0;i--) b.push(Number((BigInt(v)>>BigInt(i))&1n)); return b; };
const js8Big=(b,o,n)=>{ let v=0n; for(let i=0;i<n;i++) v=v*2n+BigInt(b[o+i]); return v; };
const js8Snr=v=>(v<-60||v>60) ? '' : (v>=0?'+':'-')+String(Math.abs(v)).padStart(2,'0');

// сложенные кадры: heartbeat / compound — [3 тип][50 позывной][11 + 5 допполе][3 бита]
function js8CompoundFrame(call,type,num,bits3){
  const c=js8PackAN50(call); if(!c) return null;
  return js8Bits(type,3).concat(js8Bits(c,50),js8Bits((num&0xffe0)>>5,11),js8Bits(num&31,5),js8Bits(bits3,3));
}
function js8PackHeartbeat(call,kind,grid){          // kind — 'HB', 'CQ', 'CQ DX' … ; grid — 4 знака или ''
  const alt=kind.startsWith('CQ');
  let num=/^[A-R]{2}\d\d$/.test(grid||'') ? js8PackGrid(grid) : JS8_NMAXGRID;
  if(alt) num|=1<<15;
  return js8CompoundFrame(call,0,num,alt ? Math.max(0,JS8_CQS.indexOf(kind)) : 0);
}
function js8PackDirected(from,to,cmd,num){          // cmd — со своим пробелом: ' SNR?', ' 73'; num — число или null
  const f=js8PackCall(from), t=js8PackCall(to), c=JS8_CMD_NUM[cmd];
  if(!f||!t||c==null||c<0) return null;
  const n=num==null||num==='' ? 0 : Math.max(-30,Math.min(31,+num|0))+31;
  return js8Bits(3,3).concat(js8Bits(f.v,28),js8Bits(t.v,28),js8Bits(c%32,5),
    js8Bits((f.p?128:0)+(t.p?64:0)+n,8));
}

/* ---------- данные: Хаффман и словарь JSC ---------- */
const JS8_HUFF={' ':'01','E':'100','T':'1101','A':'0011','O':'11111','I':'11100','N':'10111','S':'10100','H':'00011','R':'00000',
  'D':'111011','L':'110011','C':'110001','U':'101101','M':'101011','W':'001011','F':'001001','G':'000101','Y':'000011',
  'P':'1111011','B':'1111001','.':'1110100','V':'1100101','K':'1100100','-':'1100001','+':'1100000','?':'1011001',
  '!':'1011000','"':'1010101','X':'1010100','0':'0010101','J':'0010100','1':'0010001','Q':'0010000','2':'0001001',
  'Z':'0001000','3':'0000101','5':'0000100','4':'11110101','9':'11110100','8':'11110001','6':'11110000','7':'11101011','/':'11101010'};
const JS8_HUFF_REV=new Map(Object.entries(JS8_HUFF).map(([c,b])=>[b,c]));
function js8HuffDecode(bits){
  let s='', cur='';
  for(const b of bits){ cur+=b; const c=JS8_HUFF_REV.get(cur); if(c!==undefined){ s+=c; cur=''; } else if(cur.length>8) break; }
  return s;
}
// словарь JSC (data/js8-jsc.txt, 262144 слов в порядке индексов) подгружает узел; без него сжатый текст не разобрать
const JS8_JSC={words:null,map:null};
const JS8_JSC_N=262144, JS8_JSC_S=7, JS8_JSC_C=9;
function js8JscSet(text){
  const w=text.split('\n');
  if(w.length!==JS8_JSC_N) throw new Error('JSC: '+w.length+' words');
  w[69]='\n';                                       // единственное слово с переводом строки
  JS8_JSC.words=w; JS8_JSC.map=null;
}
function js8JscIndex(w){                            // самый длинный префикс слова w, имеющийся в словаре
  if(!JS8_JSC.map){ JS8_JSC.map=new Map(); const ws=JS8_JSC.words; for(let i=0;i<ws.length;i++) JS8_JSC.map.set(ws[i],i); }
  for(let n=Math.min(w.length,26);n>0;n--){ const i=JS8_JSC.map.get(w.slice(0,n)); if(i!==undefined) return i; }
  return -1;
}
function js8JscCode(index,sep){                     // (s,c)-плотный код: [старшие по 4 бита][последний 4 бита + признак пробела]
  const s=JS8_JSC_S, c=JS8_JSC_C, out=[];
  out.unshift(js8Bits(((index%s)<<1)+(sep?1:0),5));
  let x=Math.floor(index/s);
  while(x>0){ x--; out.unshift(js8Bits((x%c)+s,4)); x=Math.floor(x/c); }
  return [].concat(...out);
}
function js8JscCompress(text){                      // → [{bits, n}]: n — сколько знаков текста закрыто кодом
  const out=[], words=text.split(' ');
  for(let i=0;i<words.length;i++){
    let w=words[i]; const last=i===words.length-1; let sp=false;
    if(w===''&&!last){ w=' '; sp=true; }
    while(w){
      const ix=js8JscIndex(w); if(ix<0) break;
      const t=JS8_JSC.words[ix]; w=w.slice(t.length);
      const addSp=w===''&&!sp&&!last;
      out.push({bits:js8JscCode(ix,addSp), n:t.length+(addSp?1:0)}); }
  }
  return out;
}
function js8JscDecompress(bits){
  const s=JS8_JSC_S, c=JS8_JSC_C, W=JS8_JSC.words;
  if(!W) return null;
  const base=[0]; for(let k=1,p=s;k<8;k++,p*=c){ base.push(base[k-1]+p); }   // base[k] = s·(1 + c + … + c^(k-1))
  const bytes=[], seps=[];
  let i=0;
  while(i<bits.length){
    if(i+4>bits.length) break;
    const v=bitsNum(bits,i,4); bytes.push(v); i+=4;
    if(v<s){ if(bits.length-i>0 && bits[i]) seps.push(bytes.length-1); i++; } }
  let start=0, out='';
  while(start<bytes.length){
    let k=0, j=0;
    while(start+k<bytes.length && bytes[start+k]>=s){ j=j*c+(bytes[start+k]-s); k++; }
    if(k>7 || j>=JS8_JSC_N || start+k>=bytes.length) break;
    j=j*s+bytes[start+k]+base[k];
    if(j>=JS8_JSC_N) break;
    out+=W[j];
    if(seps.length && seps[0]===start+k){ out+=' '; seps.shift(); }
    start+=k+1; }
  return out;
}
function js8PadFrame(bits){                         // после данных 0, дальше единицы — по ним находят конец
  const b=bits.slice();
  for(let i=0;b.length<72;i++) b.push(i===0?0:1);
  return b;
}
function js8PackHuff(text){                         // → {bits, n}; n=0 — в тексте есть знак вне таблицы
  const b=[1,0]; let n=0;
  for(const ch of text) if(!(ch in JS8_HUFF)) return {bits:null,n:0};
  for(const ch of text){ const code=JS8_HUFF[ch]; if(b.length+code.length>=72) break; for(const x of code) b.push(+x); n++; }
  return {bits:js8PadFrame(b), n};
}
function js8PackJsc(text){
  const b=[1,1]; let n=0;
  if(!JS8_JSC.words) return {bits:null,n:0};
  for(const p of js8JscCompress(text)){ if(b.length+p.bits.length>=72) break; b.push(...p.bits); n+=p.n; }
  return {bits:js8PadFrame(b), n};
}
function js8DataFrames(text){                       // текст → кадры данных (по одному на слот); null — не упаковалось
  let rest=text.toUpperCase().replace(/\s+$/,''), out=[];
  while(rest){
    const h=js8PackHuff(rest), j=js8PackJsc(rest);
    const p=h.n>j.n ? h : j;
    if(!p.n) return null;
    out.push(p.bits); rest=rest.slice(p.n); }
  return out;
}

/* ---------- разбор кадра ---------- */
// → {kind, text, from, to, grid, cmd, num}; kind: HB / CQ / COMPOUND / DIRECTED / DATA / FAST
function js8Unpack(b72,i3){
  const flag=bitsNum(b72,0,3);
  if(i3&4){                                         // быстрые режимы: все 72 бита — данные
    const n=b72.lastIndexOf(0), t=js8JscDecompress(b72.slice(0,n));
    return {kind:'FAST', text:t==null ? '[JSC '+js8Chars(b72)+']' : t}; }
  if(b72[0]){                                       // [1][сжатие][70 бит данных]
    const rest=b72.slice(1), n=rest.lastIndexOf(0), d=rest.slice(1,n);
    if(rest[0]){ const t=js8JscDecompress(d); return {kind:'DATA', text:t==null ? '[JSC '+js8Chars(b72)+']' : t, jsc:t==null}; }
    return {kind:'DATA', text:js8HuffDecode(d)}; }
  if(flag===3){
    const f=js8UnpackCall(bitsNum(b72,3,28),!!b72[64]);
    const t=js8UnpackCall(bitsNum(b72,31,28),!!b72[65]);
    const cmd=JS8_CMD[bitsNum(b72,59,5)], ex=bitsNum(b72,66,6);
    const o={kind:'DIRECTED', from:f, to:t, cmd};
    let num='';
    if(ex){ num=js8IsSnrCmd(cmd) ? js8Snr(ex-31) : String(ex-31); o.num=num; }
    o.text=f+': '+t+cmd+(num?' '+num:'');
    return o; }
  const call=js8UnpackAN50(js8Big(b72,3,50)), n11=bitsNum(b72,53,11), n5=bitsNum(b72,64,5), b3=bitsNum(b72,69,3);
  const num=n11*32+n5;
  if(flag===0){
    const grid=js8UnpackGrid(num&0x7fff), alt=!!(num&0x8000);
    return {kind:alt?'CQ':'HB', from:call, grid,
      text:call+': '+(alt ? '@ALLCALL '+JS8_CQS[b3] : '@HB HEARTBEAT')+(grid?' '+grid:'')}; }
  const o={kind:'COMPOUND', from:call, cmd:''};      // 1 — сложный позывной, 2 — сложный позывной с командой
  let extra='';
  if(num<=JS8_NBASEGRID){ o.grid=js8UnpackGrid(num); extra=' '+o.grid; }
  else if(num>=JS8_NUSERGRID && num<JS8_NMAXGRID){
    const v=num-JS8_NUSERGRID;
    let c, nn=0;
    if(v&128){ nn=v&63; c=(v&64)?JS8_CMD[29]:JS8_CMD[25]; } else c=JS8_CMD[v&127];
    o.cmd=c||''; extra=(c||'')+(js8IsSnrCmd(c)?' '+js8Snr(nn-31):''); }
  o.text=call+(flag===2?'> ':': ')+extra.trim();
  return o;
}

/* ---------- текст → кадры для передачи ---------- */
// «HB [GRID]», «CQ [DX|QRP|…] [GRID]» → кадр heartbeat; «TO КОМАНДА [число]» → адресный кадр;
// «TO: текст» → адресный кадр + данные; иначе только данные. Кадры идут по одному на слот.
function js8Plan(text,mycall,mygrid){
  const t=String(text||'').toUpperCase().trim().replace(/\s+/g,' ');
  if(!t) return {err:'empty'};
  const from=String(mycall||'').toUpperCase().trim(), need=()=>js8PackCall(from) ? null : 'set a valid callsign (my call)';
  let m=/^(?:@(?:ALLCALL|HB) )?(CQ CQ CQ|CQ DX|CQ QRP|CQ CONTEST|CQ FIELD|CQ FD|CQ CQ|CQ|HB|HEARTBEAT)(?: ([A-R]{2}\d\d))?$/.exec(t);
  if(m){
    const e=need(); if(e) return {err:e};
    const g=m[2]||(/^[A-R]{2}\d\d/i.test(mygrid||'') ? mygrid.slice(0,4).toUpperCase() : '');
    const b=js8PackHeartbeat(from,m[1],g);
    return b ? {frames:[b]} : {err:'callsign does not fit'}; }
  m=/^([@A-Z0-9/]+?)(:)? (.+)$/.exec(t) || /^([@A-Z0-9/]+)()()$/.exec(t);
  if(m && js8PackCall(m[1])){
    const to=m[1], rest=m[3]||'';
    if(!m[2]){
      const cs=Object.keys(JS8_CMD_NUM).filter(c=>JS8_CMD_NUM[c]>=0&&c!==' '&&c!=='  ').sort((a,b)=>b.length-a.length);
      for(const c of cs){
        const tr=c.trim(), mm=new RegExp('^'+tr.replace(/[?+.]/g,'\\$&')+'(?: ([+-]?\\d{1,2}))?$').exec(rest);
        if(mm && (mm[1]==null || js8IsSnrCmd(c))){
          const e=need(); if(e) return {err:e};
          const b=js8PackDirected(from,to,c,mm[1]);
          if(b) return {frames:[b]}; } } }
    else if(rest){
      const e=need(); if(e) return {err:e};
      const d=js8DataFrames(rest), b=js8PackDirected(from,to,' ',null);
      if(d && b) return {frames:[b,...d]}; } }
  const d=js8DataFrames(t);
  return d ? {frames:d} : {err:'cannot pack'+(JS8_JSC.words?'':' (dictionary not loaded yet)')};
}

/* ---------- сигнал: передатчик ---------- */
// гауссов частотный импульс GFSK, BT=2: вклад символа в мгновенную частоту (в долях шага тонов)
const JS8_GP=(()=>{ const N=96, c=Math.PI*2*Math.sqrt(2/Math.LN2), t=new Float32Array(N+1);
  const erf=x=>{ const u=1/(1+.3275911*Math.abs(x)), y=1-u*(.254829592+u*(-.284496736+u*(1.421413741+u*(-1.453152027+u*1.061405429))))*Math.exp(-x*x); return x>=0?y:-y; };
  for(let i=0;i<=N;i++){ const x=(i/N)*3-1.5; t[i]=.5*(erf(c*(x+.5))-erf(c*(x-.5))); }
  return t; })();
function js8Freq(tones,u){                          // мгновенная частота в шагах тонов, u — время в символах
  const k=Math.floor(u); let f=0;
  for(let j=k-1;j<=k+1;j++){
    const tj=tones[j<0?0:j>78?78:j], x=(u-j-.5+1.5)/3*96;
    if(x>=0 && x<96){ const xi=x|0, fr=x-xi; f+=tj*(JS8_GP[xi]+(JS8_GP[xi+1]-JS8_GP[xi])*fr); } }
  return f;
}
function js8Wave(tones,f0,sr,amp){                  // готовая посылка 12.64 с (для проверок и записи)
  const L=Math.round(JS8_TX_SEC*sr), o=new Float32Array(L); let ph=0;
  for(let i=0;i<L;i++){ ph+=2*Math.PI*(f0+6.25*js8Freq(tones,i/sr/JS8_SYM_SEC))/sr; o[i]=(amp||1)*Math.sin(ph); }
  return o;
}

/* ---------- сигнал: спектрограмма слота и поиск ---------- */
// buf — кольцо из 15 с при 6400 Гц, wp — позиция самого старого отсчёта; окно 1024 (= символ), шаг 256, сетка 3.125 Гц
function js8Spec(buf,wp){
  const L=buf.length, frames=Math.floor((L-JS8_WIN)/JS8_HOP)+1, bins=JS8_FFT/2;
  const win=window_('hann',JS8_WIN), re=new Float32Array(JS8_FFT), im=new Float32Array(JS8_FFT);
  const mag=new Float32Array(frames*bins);
  for(let f=0;f<frames;f++){
    const off=(wp+f*JS8_HOP)%L;
    re.fill(0); im.fill(0);
    for(let k=0;k<JS8_WIN;k++) re[k]=buf[(off+k)%L]*win[k];
    fft(re,im);
    for(let b=0;b<bins;b++) mag[f*bins+b]=Math.hypot(re[b],im[b]);
  }
  return {mag,frames,bins};
}
const js8Now=()=>typeof performance!=='undefined' ? performance.now() : Date.now();
// мягкие метрики слота (3 бита на тон — напрямую, без кода Грея); null — окно выходит за спектрограмму
function js8Llr(S,b,t){
  const {mag,frames,bins}=S, TS=JS8_TS;
  if(b<1||b+7*TS>=bins||t<0||t+4*JS8_SYMS>=frames) return null;
  const llr=new Float64Array(174), lg=new Float64Array(8);
  let bi=0;
  for(let s=0;s<JS8_SYMS;s++){
    if(s<7||(s>=36&&s<43)||s>=72) continue;
    const fr=(t+4*s)*bins; let mean=0;
    for(let q=0;q<8;q++){ lg[q]=Math.log(mag[fr+b+q*TS]+1e-12); mean+=lg[q]; }
    mean/=8;
    for(let k=2;k>=0;k--){
      let m0=-1e9, m1=-1e9;
      for(let q=0;q<8;q++){ const lv=lg[q]-mean; if((q>>k)&1){ if(lv>m1) m1=lv; } else if(lv>m0) m0=lv; }
      llr[bi++]=(m0-m1)*2.5; } }
  return llr;
}
// P: fmin, fmax, top, thr, budget (мс), costas — 0 исходные / 1 изменённые / 2 оба (по умолчанию 0), decode
// → [{f, dt, sc, sync, set, b72?, i3?, info?, msg?}] по убыванию силы
function js8Decode(S,P){
  const {mag,frames,bins}=S, TS=JS8_TS, hz=JS8_SR/JS8_FFT, t0=js8Now();
  const b0=Math.max(1,Math.floor(P.fmin/hz)), b1=Math.min(bins-9*TS,Math.ceil(P.fmax/hz));
  const maxOff=frames-4*JS8_SYMS-1;
  if(maxOff<1) return null;
  const sets=P.costas===2 ? [0,1] : [P.costas|0];
  const cand=[];
  for(let b=b0;b<=b1;b++) for(let t=0;t<=maxOff;t++){
    let best=0, bs=0;
    for(const set of sets){
      let sc=0;
      for(let g=0;g<3;g++) for(let k=0;k<7;k++){
        const fr=(t+4*(g*36+k))*bins; let sum=0;
        for(let q=0;q<8;q++) sum+=mag[fr+b+q*TS];
        sc+=mag[fr+b+JS8_COSTAS[set][g][k]*TS]/(sum/8+1e-12); }
      if(sc>best){ best=sc; bs=set; } }
    cand.push([best/21,b,t,bs]);
  }
  cand.sort((a,c)=>c[0]-a[0]);
  const picked=[];
  for(const c of cand){
    if(c[0]<P.thr) break;
    if(picked.some(p=>Math.abs(p[1]-c[1])<4*TS&&Math.abs(p[2]-c[2])<6)) continue;
    picked.push(c);
    if(picked.length>=P.top) break;
  }
  const budget=P.budget||800;
  return picked.map(([sc,b,t,set])=>{
    const e={f:b*hz, dt:t*JS8_HOP/JS8_SR-JS8_TX_DELAY, sc, set};
    const syms=[];
    for(let s=0;s<JS8_SYMS;s++){
      const fr=(t+4*s)*bins; let best=0, bv=-1;
      for(let q=0;q<8;q++){ const v=mag[fr+b+q*TS]; if(v>bv){ bv=v; best=q; } }
      syms.push(best); }
    let sync=0;
    for(let g=0;g<3;g++) for(let k=0;k<7;k++) if(syms[g*36+k]===JS8_COSTAS[set][g][k]) sync++;
    e.sync=sync; e.syms=syms.join('');
    if(P.decode!==false){
      for(const dt2 of [0,1,-1,2,-2]){                // мелкая подстройка по времени и частоте
        let done=false;
        if(js8Now()-t0>budget) break;
        for(const db2 of [0,1,-1]){
          const llr=js8Llr(S,b+db2,t+dt2); if(!llr) continue;
          const dec=js8Ldpc(llr,50); if(!dec.ok) continue;
          const x=js8Extract(dec.bits); if(!x) continue;
          e.b72=x.b72; e.i3=x.i3; e.frame=js8Chars(x.b72);
          e.info=js8Unpack(x.b72,x.i3); e.msg=e.info.text;
          e.f=(b+db2)*hz; e.dt=(t+dt2)*JS8_HOP/JS8_SR-JS8_TX_DELAY;
          done=true; break; }
        if(done) break; } }
    return e; });
}

/* ---------- передискретизация в 6400 Гц ---------- */
// Усреднение по окну в дробное число отсчётов даёт амплитудную модуляцию с частотой srOut·(1 − frac) и боковые «призраки»
// сильного сигнала (при 44100 → 6400 — ±700 Гц, около −9 дБ), поэтому — окно Блэкмана × sinc с таблицей ядра.
function js8Resampler(srIn,srOut){
  const ratio=srIn/srOut, fc=.45*Math.min(srOut,srIn)/srIn, half=Math.ceil(4/(2*fc)), OS=64, T=new Float32Array(half*OS+2);
  for(let k=0;k<T.length;k++){
    const d=k/OS, x=2*Math.PI*fc*d, w=d>=half ? 0 : .42+.5*Math.cos(Math.PI*d/half)+.08*Math.cos(2*Math.PI*d/half);
    T[k]=2*fc*(x<1e-9 ? 1 : Math.sin(x)/x)*w; }
  const R=1<<Math.ceil(Math.log2(2*half+8)), M=R-1, hist=new Float32Array(R);
  let ni=0, tn=half;                                // ni — принято отсчётов, tn — момент следующего выходного отсчёта (в входных)
  return {
    push(x,out){                                     // → сколько выходных отсчётов дописано в out (обычно 0 или 1)
      hist[ni&M]=x; ni++; let c=0;
      while(tn+half<ni){
        const i0=Math.ceil(tn-half), i1=Math.floor(tn+half); let y=0;
        for(let i=i0;i<=i1;i++){
          const d=Math.abs(i-tn)*OS, k=d|0, f=d-k;
          y+=hist[i&M]*(T[k]+(T[k+1]-T[k])*f); }
        out[c++]=y; tn+=ratio; }
      return c; } };
}
