"use strict";
/* ============================ VDL Mode 2: D8PSK 10500 Бод, 25 кГц (136.975 МГц и др.) ============================
   Ядро IQK.vdl2Rx (грузится и страницей, и воркером острова), без DOM. Цепочка:
   IQ канала → ФНЧ 8 кГц → передискретизация на 105 кС/с (10 отсчётов на символ) → поиск преамбулы (16 символов, линейная регрессия
   фазовой ошибки — она же оценка расстройки) → разностная демодуляция D8PSK (код Грея) → скремблер (ЛРС x^15+x+1, начало 0x6959) →
   заголовок 25 бит (3 резерв, длина 17, БЧХ-проверка 5, исправление ошибки по синдрому) → данные + Рид—Соломон RS(255,249) по блокам
   с перемежением (последний блок короче: 0 / 2 / 4 / 6 проверочных байт, остальные — стирания) → HDLC (флаги 0x7E, бит-стаффинг) →
   AVLC (адреса, FCS CRC-16, кадры I / S / U) → ACARS в I-кадрах (ff ff 01 …), остальное — записью с hex.
   Алгоритмы и константы — по dumpvdl2 (Tomasz Lemiech, GPLv3) и libacars; сверка со стандартом ICAO Annex 10 vol. III, ARINC 631.
   Нужны: rsCodec (ccsds-kernels.js), iqBq (iq-kernels.js), vacParse / vacCrc / vacPar (acars-kernels.js). */
const VDL2_BAUD=10500, VDL2_SPS=10, VDL2_FS=VDL2_BAUD*VDL2_SPS, VDL2_PRE=16, VDL2_SBL=VDL2_PRE*VDL2_SPS, VDL2_SKIP=3, VDL2_THR=4, VDL2_PHMAX=1000;
const VDL2_RS_K=249, VDL2_RS_N=255, VDL2_TRLEN=17, VDL2_FECLEN=5, VDL2_HDR=3+VDL2_TRLEN+VDL2_FECLEN, VDL2_IV=0x6959, VDL2_MAXLEN=0x3FFF, VDL2_MAXLEN_C=0x1FFF;
const VDL2_GRAY=[0,1,3,2,6,7,5,4];
// фаза после каждого символа преамбулы, единицы π/4
const VDL2_PREPH=[0,3,-3,1,1,2,0,4,-3,4,-2,3,1,-2,-3,0].map(k=>k*Math.PI/4);
const VDL2_H=['0000000011111111111110000','0011111100001111111101000','1100011100110000111100100','1101101101010011001100010','0110100111100101010100001'].map(s=>parseInt(s,2));
const VDL2_SYND=['0000000000000000000000000','0000000000000000000000001','0000000000000000000000010','0100000000000000000000100','0000000000000000000000100','0100000000000000000000010','1000000000000000000000000','0100000000000000000000000',
  '0000000000000000000001000','0010000000000000000000000','0001000000000000000000000','0000100000000000000000000','0000010000000000000000000','1000100000000000000000000','0000001000000000000000000','0000000100000000000000000',
  '0000000000000000000010000','0000000010000000000000000','0100000000100000000000000','0000000001000000000000000','0100000001000000000000000','0000000000100000000000000','0000000000010000000000000','1000000010000000000000000',
  '0000000000001000000000000','0000000000000100000000000','0000000000000010000000000','0000000000000001000000000','0000000000000000100000000','0000000000000000010000000','0000000000000000001000000','0000000000000000000100000'].map(s=>parseInt(s,2));
const VDL2_SYNDW=[0,1,1,2,1,2,1,1,1,1,1,1,1,2,1,1,1,1,2,1,2,1,1,2,1,1,1,1,1,1,1,1];
const VDL2_RS=rsCodec(0x187,120,1,6);
// CRC-16/X.25 (FCS кадра AVLC): отражённый 0x1021, начало 0xFFFF, хороший остаток 0xF0B8
const VDL2_CRCT=(()=>{ const t=new Uint16Array(256); for(let i=0;i<256;i++){ let c=i; for(let k=0;k<8;k++) c=c&1 ? (c>>1)^0x8408 : c>>1; t[i]=c; } return t; })();
function vdl2Crc(b,len,crc){ crc=crc==null ? 0xFFFF : crc; for(let i=0;i<len;i++) crc=(crc>>8)^VDL2_CRCT[(crc^b[i])&0xFF]; return crc&0xFFFF; }
const vdl2Par=v=>{ v^=v>>16; v^=v>>8; v^=v>>4; v^=v>>2; v^=v>>1; return v&1; };
function vdl2Rev(v,nb){ let r=0; for(let i=0;i<nb;i++){ r=(r<<1)|(v&1); v>>>=1; } return r>>>0; }
// число проверочных байт в последнем (неполном) блоке
const vdl2FecOct=len=>len<3 ? 0 : len<31 ? 2 : len<68 ? 4 : 6;

// RS(255,249) с стираниями: cw[0..254], er — индексы стёртых; число исправленных байт (стирания в счёт) или −1
function vdl2RsFix(cw,er){
  const rs=VDL2_RS, np=rs.np, fcr=120, mul=rs.mul, div=rs.div, pw=rs.pw;
  const S=new Uint8Array(np);
  let bad=0;
  for(let j=0;j<np;j++){ const r=pw(fcr+j); let s=0; for(let i=0;i<255;i++) s=mul(s,r)^cw[i]; S[j]=s; bad|=s; }
  if(!bad) return 0;
  const ne=er.length;
  if(ne>np) return -1;
  // локатор стираний Γ(x)=∏(1+X·x), X=α^(254−i)
  let G=[1];
  for(const i of er){ const X=pw(254-i), h=new Array(G.length+1).fill(0); for(let k=0;k<G.length;k++){ h[k]^=G[k]; h[k+1]^=mul(G[k],X); } G=h; }
  // модифицированные синдромы T=S·Γ mod x^np, годятся T[ne…np−1]
  const T=new Uint8Array(np);
  for(let i=0;i<np;i++){ let v=0; for(let j=0;j<=Math.min(i,ne);j++) v^=mul(G[j],S[i-j]); T[i]=v; }
  const m=np-ne;
  let C=new Uint8Array(m+1), B=new Uint8Array(m+1), L=0, mm=1, b=1;
  C[0]=1; B[0]=1;
  for(let n=0;n<m;n++){
    let d=T[ne+n];
    for(let i=1;i<=L;i++) d^=mul(C[i],T[ne+n-i]);
    if(!d){ mm++; continue; }
    const coef=div(d,b), tmp=C.slice();
    for(let i=mm;i<=m;i++) C[i]^=mul(coef,B[i-mm]);
    if(2*L<=n){ L=n+1-L; B=tmp; b=d; mm=1; } else mm++;
  }
  if(2*L+ne>np) return -1;
  // полный локатор Ψ=Λ·Γ
  const Psi=new Uint8Array(L+ne+1);
  for(let i=0;i<=L;i++) for(let j=0;j<=ne;j++) Psi[i+j]^=mul(C[i],G[j]);
  const deg=L+ne;
  const O=new Uint8Array(np);
  for(let i=0;i<np;i++){ let v=0; for(let j=0;j<=Math.min(i,deg);j++) v^=mul(Psi[j],S[i-j]); O[i]=v; }
  const pos=[], val=[];
  for(let i=0;i<255;i++){
    const d=254-i, xi=pw(-d);
    let lv=0; for(let j=deg;j>=0;j--) lv=mul(lv,xi)^Psi[j];
    if(lv) continue;
    let ov=0; for(let j=np-1;j>=0;j--) ov=mul(ov,xi)^O[j];
    let dv=0; for(let j=1;j<=deg;j+=2) dv^=mul(Psi[j],pw(-d*(j-1)));
    if(!dv) return -1;
    pos.push(i); val.push(mul(div(ov,dv),pw(d*(1-fcr))));
  }
  if(pos.length!==deg) return -1;
  for(let k=0;k<pos.length;k++) cw[pos[k]]^=val[k];
  for(let j=0;j<np;j++){ const r=pw(fcr+j); let s=0; for(let i=0;i<255;i++) s=mul(s,r)^cw[i]; if(s) return -1; }     // проверка: после исправления синдромы нулевые
  return pos.length;
}

// перемежение: байты in[0..len) идут по столбцам таблицы rows×255, ширина заполнения fillwidth, смещение столбца offset; у короткой последней строки в конце столбцов дыры.
// Возвращает {row:[], col:[]} для каждого входного байта или код ошибки
function vdl2Map(len,rows,fillwidth,offset){
  if(rows===0 || fillwidth===0) return -1;
  let lastRow=len%fillwidth; if(lastRow===0) lastRow=fillwidth;
  if(fillwidth+offset>VDL2_RS_N) return -2;
  if(len>rows*fillwidth) return -3;
  if(rows>1 && len-lastRow<(rows-1)*fillwidth) return -4;
  const R=new Uint16Array(len), C=new Uint16Array(len);
  let row=0, col=offset;
  lastRow+=offset;
  for(let i=0;i<len;i++){
    if(row===rows-1 && col>=lastRow){ row=0; col++; }
    R[i]=row; C[i]=col; row++;
    if(row===rows){ row=0; col++; }
  }
  return {R,C};
}

// ---- битовый поток ----
function vdl2Bs(len){ return {buf:new Uint8Array(len), start:0, end:0, dpos:0}; }
function vdl2BsReset(b){ b.start=b.end=b.dpos=0; }
function vdl2Descramble(b,st){
  if(b.dpos<b.start) b.dpos=b.start;
  for(let i=b.dpos;i<b.end;i++){
    const bit=((st.lfsr>>0)^(st.lfsr>>14))&1;
    st.lfsr=(st.lfsr>>1)|(bit<<14);
    b.buf[i]^=bit;
  }
  b.dpos=b.end;
}
function vdl2ReadLsb(b,out,nbytes){
  if(b.start+8*nbytes>b.end) return false;
  for(let i=0;i<nbytes;i++){ let v=0; for(let j=0;j<8;j++) v|=(b.buf[b.start++]&1)<<j; out[i]=v; }
  return true;
}
function vdl2AppendLsb(b,bytes,from,nbytes){
  if(b.end+8*nbytes>b.buf.length) return false;
  for(let i=0;i<nbytes;i++){ const t=bytes[from+i]; for(let j=0;j<8;j++) b.buf[b.end++]=(t>>j)&1; }
  return true;
}
// следующий кадр HDLC из src: снимает флаги и вставленные нули; {bits, more} или null при ошибке
function vdl2NextFrame(src){
  for(;;){
    let ones=0, j=0, restart=false;
    const dst=[];
    let i=src.start;
    for(;i<src.end;i++,src.start++){
      const bit=src.buf[i];
      if(bit===0 && ones===5){ ones=0; continue; }
      if(bit===1){ ones++; if(ones>6) return null; }
      dst[j]=bit;
      if(bit===0){
        if(ones===6){
          if(j===7){ src.start++; restart=true; break; }
          if(j<7) return null;
          dst.length=j-7; src.start++;
          return {bits:dst, more:src.start<src.end};
        }
        ones=0;
      }
      j++;
    }
    if(!restart) return {bits:dst, more:src.start<src.end, open:true};     // флага в конце нет — данные, сколько есть (как в dumpvdl2)
  }
}

// ---- AVLC / ACARS ----
const VDL2_ADDR_TYPE=['reserved','Aircraft','reserved','reserved','Ground station','Ground station','reserved','All stations'];
const VDL2_S_CMD=['Receive Ready','Receive not Ready','Reject','Selective Reject'];
const VDL2_U_CMD={0x00:'UI',0x03:'DM',0x10:'DISC',0x18:'UA',0x21:'FRMR',0x2b:'XID',0x38:'TEST'};
function vdl2Addr(b,o){
  const x=(b[o]>>1)|(b[o+1]<<6)|(b[o+2]<<13)|((b[o+3]&0xfe)<<20);
  const v=vdl2Rev(x&0xFFFFFFF,28);
  return {addr:v&0xFFFFFF, type:(v>>24)&7, status:(v>>27)&1};
}
const vdl2Hex=(b,from,to)=>{ let s=''; for(let i=from;i<to;i++) s+=(b[i]<16 ? '0' : '')+b[i].toString(16); return s; };
// кадр AVLC (с FCS) → запись или null (короткий / FCS не сошёлся)
function vdl2Avlc(b,meta,cx){
  if(b.length<11) return null;
  if(vdl2Crc(b,b.length)!==0xF0B8) return null;
  const len=b.length-2;
  const dst=vdl2Addr(b,0), src=vdl2Addr(b,4), lcf=b[8];
  const hex=a=>a.addr.toString(16).toUpperCase().padStart(6,'0');
  const r={t:Date.now(), src:'VDL2', from:hex(src), to:hex(dst), fromType:VDL2_ADDR_TYPE[src.type], toType:VDL2_ADDR_TYPE[dst.type],
    ag:dst.status ? 'On ground' : 'Airborne', cr:src.status ? 'Response' : 'Command', len};
  if(meta){ r.rssi=meta.rssi; r.df=meta.df; if(meta.fixed) r.fixed=meta.fixed; }
  const body=b.subarray(9,len);
  let kind='avlc', text='';
  if((lcf&3)===1){ r.frame='S'; r.cmd=VDL2_S_CMD[(lcf>>2)&3]; r.rseq=(lcf>>5)&7; r.pf=(lcf>>4)&1; text=r.cmd; }
  else if((lcf&3)===3){ const mf=(lcf>>2)&0x3b; r.frame='U'; r.cmd=VDL2_U_CMD[mf]||'0x'+mf.toString(16); r.pf=(lcf>>4)&1; text=r.cmd;
    if(mf===0x2b){ const xi=vdl2Xid(body,src.status,r.pf); if(xi){ kind='xid'; r.xid=xi; text=xi.name+(xi.p.dest_airport ? ' → '+xi.p.dest_airport : '')+(xi.p.nearest_airport_id ? ' '+xi.p.nearest_airport_id : '')
        +(xi.lat!=null && xi.gsif ? ' @'+vdl2LocStr({lat:xi.lat,lon:xi.lon}) : '')+(xi.p.frequency_support ? ' · '+xi.p.frequency_support : '')+(xi.p.lcr_cause ? ' · '+xi.p.lcr_cause : '')+(xi.p.autotune_frequency ? ' → '+xi.p.autotune_frequency : ''); } } }
  else { r.frame='I'; r.sseq=(lcf>>1)&7; r.rseq=(lcf>>5)&7; r.poll=(lcf>>4)&1; text='I-frame';
    if(body.length>3 && body[0]===0xff && body[1]===0xff && body[2]===0x01){
      const a=vdl2Acars(body.subarray(3));
      if(a){ kind='message'; Object.assign(r,a); text=a.reg+' '+a.label+(a.flight ? ' '+a.flight : '')+(a.txt ? ' · '+a.txt : ''); }
      else { kind='data'; r.proto='ACARS'; text='ACARS (broken)'; }
    } else {
      const x=vdl2X25(body,{asm:cx.asm, from:r.from, to:r.to, now:cx.now});
      if(x){ kind='x25'; r.x25=x; text=vdl2X25Text(x); r.proto='X.25'; }
      else { kind='data'; r.proto=body.length ? 'X.25/ATN' : ''; text='data '+body.length+' B'; }
    } }
  r.kind=kind;
  if(kind==='data' || kind==='avlc' || kind==='xid' || kind==='x25') r.hex=vdl2Hex(body,0,Math.min(body.length,96));
  r.text=r.from+'>'+r.to+' '+text;
  return r;
}

// ---- TLV и вспомогательное ----
const vdl2U16=(b,o)=>(b[o]<<8)|b[o+1], vdl2U32=(b,o)=>((b[o]*16777216)+(b[o+1]<<16)+(b[o+2]<<8)+b[o+3]);
const vdl2Ascii=b=>Array.from(b,c=>c>=32 && c<127 ? String.fromCharCode(c) : '.').join('');
const vdl2HexS=b=>vdl2Hex(b,0,b.length);
// список TLV с однобайтовой длиной; null — обрыв или нулевая длина (как в dumpvdl2)
function vdl2Tlv(b){
  const out=[]; let p=0;
  while(b.length-p>=2){
    const t=b[p], l=b[p+1]; p+=2;
    if(l>b.length-p || l===0) return null;
    out.push({t, d:b.subarray(p,p+l)}); p+=l;
  }
  return out;
}
const vdl2Hex24=a=>a.toString(16).toUpperCase().padStart(6,'0');
const vdl2AddrList=d=>{ if(d.length%4) return null; const o=[]; for(let i=0;i<d.length;i+=4) o.push(vdl2Hex24(vdl2Addr(d,i).addr)); return o; };

// ---- XID (ICAO 9776, таблица 5.12) ----
const VDL2_XID_NAMES=[['',''],['XID_CMD_LCR','Link Connection Refused'],['XID_CMD_HO','Handoff Request / Broadcast Handoff'],['GSIF','Ground Station Information Frame'],
  ['XID_CMD_LE','Link Establishment'],['',''],['XID_CMD_HO','Handoff Initiation'],['XID_CMD_LPM','Link Parameter Modification'],['',''],['',''],['',''],['',''],
  ['XID_RSP_LE','Link Establishment Response'],['XID_RSP_LCR','Link Connection Refused Response'],['XID_RSP_HO','Handoff Response'],['XID_RSP_LPM','Link Parameter Modification Response']];
const VDL2_LCR={0:'Bad local parameter',1:'Out of link layer resources',2:'Out of packet layer resources',3:'Terrestrial network not available',4:'Terrestrial network congestion',5:'Cannot support autotune',
  6:'Station cannot support initiating handoff',0x7f:'Other unspecified local reason',0x80:'Bad global parameter',0x81:'Protocol violation',0x82:'Ground system out of resources',0xff:'Other unspecified system reason'};
function vdl2Freq(d,o){            // 12 бит: (f+10000)·10 кГц, округление до 25 кГц; старшие 4 бита — поддерживаемые модуляции
  const mods=d[o]>>4; let k=((vdl2U16(d,o)&0xfff)+10000)*10;
  if(k%25) k=k+25-k%25;
  return {mhz:k/1000, mods:(mods&2 ? ['VDL-M2'] : []).concat(mods&4 ? ['VDL-M3'] : [])};
}
const vdl2S12=v=>v&0x800 ? v-0x1000 : v;
function vdl2Loc(d,o){ return {lat:vdl2S12(vdl2U16(d,o)>>4)/10, lon:vdl2S12(vdl2U16(d,o+1)&0xfff)/10}; }
const vdl2LocStr=l=>Math.abs(l.lat).toFixed(1)+(l.lat<0 ? 'S' : 'N')+' '+Math.abs(l.lon).toFixed(1)+(l.lon<0 ? 'W' : 'E');
const VDL2_XID_PUB={1:['param_set_id','Parameter set ID','a'],2:['procedure_classes','Procedure classes','x'],3:['hdlc_options','HDLC options','x'],5:['n1_downlink','N1-downlink','x'],6:['n1_uplink','N1-uplink','x'],
  7:['k_downlink','k-downlink','x'],8:['k_uplink','k-uplink','x'],9:['timer_t1_downlink','Timer T1_downlink','x'],10:['counter_n2','Counter N2','x'],11:['timer_t2','Timer T2','x']};
const VDL2_XID_VDL={0:['param_set_id','Parameter set ID','a'],2:['sqp','SQP','x'],4:['avlc_specific_options','AVLC specific options','x'],5:['expedited_sn_connection','Expedited SN connection','x'],
  0x42:['timer_t4','Timer T4','x'],0x43:['mac_persistence','MAC persistence','x'],0x44:['counter_m1','Counter M1','x'],0x45:['timer_tm2','Timer TM2','x'],0x46:['timer_tg5','Timer TG5','x'],0x47:['timer_t3min','Timer T3min','x'],
  0x49:['broadcast_connection','Broadcast connection','x'],0xC1:['airport_coverage','Airport coverage','x'],0xC3:['nearest_airport_id','Nearest airport ID','a'],0xC4:['atn_router_nets','ATN router NETs','x'],
  0xC6:['timer_tg3','Timer TG3','x'],0xC7:['timer_tg4','Timer TG4','x'],0x83:['dest_airport','Destination airport','a']};
function vdl2XidTag(t,d,o){
  const PUB=o.pub, tab=PUB ? VDL2_XID_PUB : VDL2_XID_VDL;
  if(!PUB){
    if(t===0x01 && d.length>=1){ o.cm=d[0]; o.p.conn_mgmt='h='+(d[0]&1)+' r='+((d[0]>>1)&1)+' x='+((d[0]>>2)&1)+' v='+((d[0]>>3)&1); return; }
    if(t===0x03 && d.length>=1){ o.p.xid_sequencing='seq '+(d[0]&7)+' retry '+(d[0]>>4); return; }
    if(t===0x06 && d.length>=3){ const c=d[0]; o.p.lcr_cause=c+' ('+(VDL2_LCR[c]||'unknown')+') delay '+vdl2U16(d,1)+(d.length>3 ? ' data '+vdl2HexS(d.subarray(3)) : ''); return; }
    if(t===0x81 && d.length>=1){ o.p.modulation_support=[(d[0]&2 ? 'VDL-M2' : ''),(d[0]&4 ? 'VDL-M3' : '')].filter(Boolean).join('+')||('0x'+d[0].toString(16)); return; }
    if(t===0x82 || t===0x41 || t===0x48 || t===0xC5){ const l=vdl2AddrList(d); if(l){ o.p[{0x82:'alternate_ground_stations',0x41:'replacement_ground_stations',0x48:'gs_address_filter',0xC5:'system_mask'}[t]]=l.join(' '); return; } }
    if(t===0x84 && d.length>=4){ const l=vdl2Loc(d,0); o.p.ac_location=vdl2LocStr(l)+' '+(d[3]*1000)+' ft'; o.lat=l.lat; o.lon=l.lon; return; }
    if(t===0x40 && d.length>=2){ const f=vdl2Freq(d,0); o.p.autotune_frequency=f.mhz.toFixed(3)+' MHz'+(f.mods.length ? ' ('+f.mods.join('+')+')' : ''); o.freq=f.mhz; return; }
    if(t===0xC0 && d.length%6===0){ const fl=[]; for(let i=0;i<d.length;i+=6){ const f=vdl2Freq(d,i); fl.push(f.mhz.toFixed(3)+' ('+vdl2Hex24(vdl2Addr(d,i+2).addr)+')'); }
      o.p.frequency_support=fl.join(', '); o.freqs=fl.length; return; }
    if(t===0xC8 && d.length>=3){ const l=vdl2Loc(d,0); o.p.gs_location=vdl2LocStr(l); o.lat=l.lat; o.lon=l.lon; return; }
  }
  const e=tab[t];
  if(e) o.p[e[0]]=e[2]==='a' ? vdl2Ascii(d) : vdl2HexS(d);
  else o.p['tag_'+t.toString(16)]=vdl2HexS(d);
}
// информационное поле XID → {name, descr, p, …} или null
function vdl2Xid(b,cr,pf){
  if(b.length<7 || b[0]!==0x82) return null;
  let p=1, pubSeen=false, vdlSeen=false;
  const o={p:{}, cm:0xff};
  while(b.length-p>=3){
    const gid=b[p], gl=vdl2U16(b,p+1); p+=3;
    if(gl>b.length-p) return null;
    if(gid===0x80 || gid===0xF0){
      if(gid===0x80 ? pubSeen : vdlSeen) return null;
      const tl=vdl2Tlv(b.subarray(p,p+gl));
      if(tl===null) return null;
      if(gid===0x80) pubSeen=true; else vdlSeen=true;
      o.pub=gid===0x80;
      for(const t of tl) vdl2XidTag(t.t,t.d,o);
    }
    p+=gl;
  }
  if(!vdlSeen) return null;
  const type=(cr<<3)|(pf<<2)|(((o.cm>>0)&1)<<1)|((o.cm>>1)&1), nm=VDL2_XID_NAMES[type];
  delete o.pub; delete o.cm;
  return {name:nm[0]||('XID '+type), descr:nm[1], gsif:nm[0]==='GSIF', ...o};
}

// ---- X.25 (ISO 8208, режим mod 8) / SNDCF / CLNP / COTP / ES-IS ----
const VDL2_X25_NAMES={0x0b:'Call Request',0x0f:'Call Accepted',0x13:'Clear Request',0x17:'Clear Confirm',0x00:'Data',0x01:'Receive Ready',0x09:'Receive Reject',0x1b:'Reset Request',0x1f:'Reset Confirm',0xfb:'Restart Request',0xff:'Restart Confirm',0xf1:'Diagnostics'};
const VDL2_COTP_NAMES={0xe0:'CR',0xd0:'CC',0x80:'DR',0xc0:'DC',0xf0:'DT',0x10:'ED',0x60:'AK',0x20:'EA',0x50:'RJ',0x70:'ER'};
const VDL2_CLNP_ERR={0:'Reason not specified',1:'Protocol procedure error',2:'Incorrect checksum',3:'PDU discarded due to congestion',4:'Header syntax error',5:'Segmentation needed but not permitted',6:'Incomplete PDU received',
  7:'Duplicate option',8:'Unknown PDU type',0x80:'Destination address unreachable',0x81:'Destination address unknown',0xa0:'Lifetime expired in transit',0xa1:'Lifetime expired during reassembly',0xb0:'Unsupported option'};
// сборка фрагментов по смещению: возвращает целый буфер или null (пока не хватает)
function vdl2Frag(map,key,off,data,total,now){
  let e=map.get(key);
  if(!e || now-e.t>10000){ e={t:now, parts:new Map(), total}; map.set(key,e); }
  e.t=now; e.parts.set(off,data);
  if(total>0) e.total=total;
  if(e.total){
    let n=0; const buf=new Uint8Array(e.total);
    for(const [o,d] of e.parts){ if(o+d.length<=e.total){ buf.set(d,o); n+=d.length; } }
    if(n>=e.total){ map.delete(key); return buf; }
  }
  if(map.size>64) for(const [k,v] of map) if(now-v.t>10000) map.delete(k);
  return null;
}
function vdl2Nsap(d){ return vdl2HexS(d); }
// ES-IS: заголовок 9 байт, NET, параметры
function vdl2Esis(b,x){
  if(b.length<10 || b[2]!==1) return false;
  const type=b[4]&0x1f, hold=vdl2U16(b,5);
  if(type!==2 && type!==4) return false;
  const nl=b[9]; if(b.length<10+nl) return false;
  x.esis={type:type===2 ? 'ES Hello' : 'IS Hello', hold, net:vdl2Nsap(b.subarray(10,10+nl))};
  return true;
}
// COTP: цепочка TPDU подряд; возвращает массив TPDU и «хвост» пользовательских данных
function vdl2Cotp(b,x){
  const list=[]; let p=0, ud=null;
  while(b.length-p>=4){
    const li=b[p]; if(li===0 || li===255 || b.length-p-1<li) break;
    const code=b[p+1], hi=code&0xf0, c=hi===0xe0||hi===0xd0||hi===0x60||hi===0x50 ? hi : hi===0xf0 ? (code&0xfe) : code;
    const t={type:VDL2_COTP_NAMES[c&0xf0]||('0x'+c.toString(16)), dst:vdl2U16(b,p+2)};
    let final=false;
    if(c===0xe0||c===0xd0||c===0x80){ if(li<6) break; t.src=vdl2U16(b,p+4); if(c===0x80) t.reason=b[p+6]; else t.cls=b[p+6]>>4; final=true; }
    else if(c===0xf0||c===0x10){ if(li&1){ if(li<7) break; t.eot=b[p+4]>>7; t.seq=vdl2U32(b,p+4)&0x7fffffff; } else { if(li<4) break; t.eot=b[p+4]>>7; t.seq=b[p+4]&0x7f; } final=true; }
    else if(c===0x60||c===0x20){ if(li&1){ if(li<7) break; t.seq=vdl2U32(b,p+4)&0x7fffffff; } else { if(li<4) break; t.seq=b[p+4]&0x7f; } }
    list.push(t);
    p+=li+1;
    if(final){ if(p<b.length) ud=b.subarray(p); else if(t.type==='DT') ud=new Uint8Array(0); p=b.length; break; }
  }
  if(!list.length) return false;
  x.cotp=list; if(ud && ud.length) x.data=vdl2Hex(ud,0,Math.min(ud.length,96)); x.dataLen=ud ? ud.length : 0;
  return true;
}
function vdl2Transport(b,x){          // после заголовка CLNP
  if(!b.length) return;
  if(b[0]===0x82){ if(vdl2Esis(b,x)) return; }
  else if(b[0]===0x85){ x.idrp=true; x.data=vdl2Hex(b,0,Math.min(b.length,96)); x.dataLen=b.length; return; }
  else if(vdl2Cotp(b,x)) return;
  x.data=vdl2Hex(b,0,Math.min(b.length,96)); x.dataLen=b.length;
}
function vdl2Clnp(b,x,ctx){
  if(b.length<9 || b[1]===255 || b[1]>b.length || b[2]!==1) return false;
  const hl=b[1], type=b[4]&0x1f, sp=b[4]>>7, ms=(b[4]>>6)&1;
  let p=9;
  const rd=()=>{ if(p>=hl) return null; const l=b[p]; if(p+1+l>hl) return null; const d=b.subarray(p+1,p+1+l); p+=1+l; return d; };
  const dst=rd(), src=dst&&rd();
  if(!dst || !src) return false;
  const c={compressed:false, lifetime:b[3]/2, dst:vdl2Nsap(dst), src:vdl2Nsap(src), type:type===0x1c ? 'DT' : type===0x1d ? 'MD' : type===1 ? 'ER' : 'type 0x'+type.toString(16)};
  let id=0, off=0, total=0;
  if(sp){ if(hl-p<6) return false; id=vdl2U16(b,p); off=vdl2U16(b,p+2); total=vdl2U16(b,p+4); p+=6; c.pduId=id; c.offset=off; c.total=total; }
  const opt=vdl2Tlv(b.subarray(p,hl));
  if(opt) for(const t of opt){ if(t.t===5) c.lref=vdl2HexS(t.d); else if(t.t===0xcd) c.priority=t.d[0]; else if(t.t===0xc1 && t.d.length===2) c.discard=(VDL2_CLNP_ERR[t.d[0]]||t.d[0]); }
  x.clnp=c;
  let pay=b.subarray(hl);
  if(type===1){ const y={}; vdl2Clnp(pay,y,ctx); if(y.clnp) x.errPdu=y.clnp; return true; }
  if(!pay.length) return true;
  if(sp){ pay=vdl2Frag(ctx.asm.clnp,ctx.from+'>'+ctx.to+'#'+id,off,pay,total,ctx.now); if(!pay){ c.reasm='in progress'; return true; } c.reasm='complete'; }
  vdl2Transport(pay,x);
  return true;
}
function vdl2ClnpC(b,x,ctx){
  if(b.length<4) return false;
  const type=b[0]>>4, exp=b[3]>>7, derived=type===6||type===7||type===9||type===10, segp=type===1||type===3||derived;
  let hl=4+(exp ? 1 : 0)+(segp ? 2 : 0)+(derived ? 4 : 0);
  if(b.length<hl) return false;
  let p=4;
  const c={compressed:true, prio:b[0]&0xf, lifetime:b[1]/2, flags:b[2], lref:exp ? ((b[3]&0x7f)<<8)|b[p++] : b[3]&0x7f};
  let id=0, off=0, total=0;
  if(segp){ id=vdl2U16(b,p); p+=2; c.pduId=id; }
  if(derived){ off=vdl2U16(b,p); total=vdl2U16(b,p+2); p+=4; c.offset=off; c.total=total; }
  x.clnp=c;
  let pay=b.subarray(p);
  if(derived){
    if(off+pay.length>total || !pay.length) return false;
    const whole=vdl2Frag(ctx.asm.clnp,ctx.from+'>'+ctx.to+'#c'+id,off,pay,total,ctx.now);
    if(!whole){ c.reasm='in progress'; return true; }
    c.reasm='complete'; pay=whole;
  }
  vdl2Transport(pay,x);
  return true;
}
function vdl2UserData(b,x,ctx){
  if(!b.length) return;
  const proto=b[0], t=proto>>4;
  if(proto===0x81){ if(vdl2Clnp(b,x,ctx)) return; }
  else if(proto===0x82){ if(vdl2Esis(b,x)) return; }
  else if(t<4 || t===6 || t===7 || t===9 || t===10){ if(vdl2ClnpC(b,x,ctx)) return; }
  else if(proto===0xe0 && b.length>=3){ x.sndcfErr={code:b[1], lref:b[2]}; if(b.length>3){ const y={}; vdl2UserData(b.subarray(3),y,ctx); x.errPdu=y.clnp||y; } return; }
  x.data=vdl2Hex(b,0,Math.min(b.length,96)); x.dataLen=b.length;
}
function vdl2X25(b,ctx){
  if(b.length<3 || (b[0]>>4)!==1) return null;
  const tv=b[2], x={ch:((b[0]&15)<<8)|b[1]};
  let type, p=3;
  if((tv&1)===0){ type=0; x.sseq=(tv>>1)&7; x.more=(tv>>4)&1; x.rseq=(tv>>5)&7; }
  else { const t=tv&0x1f; type=(t===1||t===9) ? t : tv; if(t===1||t===9) x.rseq=tv>>5; }
  const nm=VDL2_X25_NAMES[type];
  if(nm===undefined) return null;
  x.type=nm;
  if(type===0x0b || type===0x0f){
    if(b.length<=p) return null;
    const cl=b[p]>>4, cd=b[p]&15, nn=cl+cd, nb=(nn+1)>>1;
    if(b.length<p+1+nb) return null;
    let digs=''; for(let i=0;i<nn;i++){ const by=b[p+1+(i>>1)]; digs+=((i&1) ? by&15 : by>>4).toString(16); }
    x.called=digs.slice(0,cd); x.calling=digs.slice(cd);
    p+=1+nb;
    if(b.length<=p) return null;
    const fl=b[p]; if(b.length<p+1+fl) return null;
    if(fl) x.facilities=vdl2Hex(b,p+1,p+1+fl);
    p+=1+fl;
    if(type===0x0b){
      if(b.length<p+2 || b[p]!==0xc1) return null;
      const sl=b[p+1]; if(sl<4 || b.length<p+2+sl || b[p+2]!==1) return null;
      x.compression=b[p+5]; p+=2+sl;
    } else { if(b.length<=p) return null; x.compression=b[p++]; }
    vdl2UserData(b.subarray(p),x,ctx);
  } else if(type===0x00){
    const pay=b.subarray(p), key=ctx.from+'>'+ctx.to+'#x';
    const q=ctx.asm.x25, pend=q.get(key);
    let whole=null;
    if(x.more){
      if(pend && ctx.now-pend.t<3000 && pend.next===x.sseq){ pend.parts.push(pay); pend.next=(x.sseq+1)&7; pend.t=ctx.now; }
      else q.set(key,{parts:[pay], next:(x.sseq+1)&7, t:ctx.now});
      x.reasm='in progress';
    } else if(pend && ctx.now-pend.t<3000 && pend.next===x.sseq){
      pend.parts.push(pay); q.delete(key);
      let n=0; for(const a of pend.parts) n+=a.length;
      whole=new Uint8Array(n); n=0; for(const a of pend.parts){ whole.set(a,n); n+=a.length; }
      x.reasm='complete';
    } else { q.delete(key); whole=pay; }
    if(whole) vdl2UserData(whole,x,ctx);
  } else if(type===0x13 || type===0x1b || type===0xfb){
    if(b.length<=p) return null;
    x.cause=(b[p]&0x80) ? 0 : b[p]; p++;
    if(b.length>p) x.diag=b[p];
  } else if(type===0xf1){
    if(b.length<=p) return null;
    x.diag=b[p++]; if(b.length>p) x.diagData=vdl2Hex(b,p,Math.min(b.length,p+32));
  }
  return x;
}
// текст слоёв X.25 → строка для журнала
function vdl2X25Text(x){
  const a=['X.25 '+x.type+(x.sseq!=null ? ' S'+x.sseq+(x.more ? '+' : '')+' R'+x.rseq : x.rseq!=null ? ' R'+x.rseq : '')+' ch'+x.ch];
  if(x.called!=null) a.push('called '+x.called+' calling '+x.calling);
  if(x.cause!=null) a.push('cause 0x'+x.cause.toString(16)+(x.diag!=null ? '/0x'+x.diag.toString(16) : ''));
  if(x.clnp){ const c=x.clnp; a.push('CLNP'+(c.compressed ? 'c lref '+c.lref : ' '+c.type+' '+c.src+'→'+c.dst)+(c.reasm ? ' ('+c.reasm+')' : '')); }
  if(x.esis) a.push('ES-IS '+x.esis.type+' NET '+x.esis.net);
  if(x.cotp) a.push('COTP '+x.cotp.map(t=>t.type+(t.seq!=null ? ' #'+t.seq+(t.eot ? '/EOT' : '') : '')).join('+'));
  if(x.sndcfErr) a.push('SNDCF error '+x.sndcfErr.code);
  if(x.idrp) a.push('IDRP');
  if(x.dataLen) a.push(x.dataLen+' B');
  return a.join(' › ');
}
// блок ACARS внутри AVLC: …, ETX/ETB, BCS (2 байта), DEL
function vdl2Acars(b){
  const n=b.length;
  if(n<16 || b[n-1]!==0x7f) return null;
  const crcOk=crc16r(b,0,n-1,0x8408,0,0)===0;
  const by=Array.from(b.subarray(0,n-3),v=>v&0x7f);
  if(by[by.length-1]!==3 && by[by.length-1]!==0x17) return null;
  const m=vacParse(by);
  if(!m) return null;
  const o={id:m.reg, reg:m.reg, mode:m.mode, ack:m.ack, label:m.label, blk:m.blk, dir:m.dir, txt:m.txt};
  if(m.no) o.no=m.no;
  if(m.flight) o.flight=m.flight;
  if(m.etb) o.etb=true;
  if(!crcOk) o.crcBad=true;
  return o;
}

// ---- приёмник ----
function vdl2Reset(v){            // новый поиск преамбулы
  v.ds=0; v.dec=0; v.reqBits=VDL2_HDR; v.fixes=0; vdl2BsReset(v.bs);
  v.sclk=0; v.pherr=[VDL2_PHMAX,VDL2_PHMAX,VDL2_PHMAX]; v.pwr=0; v.pwrN=0;
}
const VDL2_LRX=(()=>{ let m=0; for(let i=0;i<VDL2_PRE;i++) m+=i; m/=VDL2_PRE; const X=[]; let den=0; for(let i=0;i<VDL2_PRE;i++){ X.push(i-m); den+=(i-m)*(i-m); } return {X,den}; })();
function vdl2ParaVertex(x,d,y1,y2,y3){
  const den=d*2*d*(-d);
  const A=(x*(y2-y1)+(x-d)*(y1-y3)+(x-2*d)*(y3-y2))/den;
  const B=(x*x*(y1-y2)+(x-d)*(x-d)*(y3-y1)+(x-2*d)*(x-2*d)*(y2-y3))/den;
  return -B/(2*A);
}
function vdl2GotSync(v){
  const err=new Float64Array(VDL2_PRE), sb=v.sb, L=VDL2_SBL;
  let prev=sb[(v.sbi+VDL2_SPS)%L]-VDL2_PREPH[0], mean=prev, unwrap=0;
  err[0]=prev;
  for(let i=1;i<VDL2_PRE;i++){
    const cur=sb[(v.sbi+(i+1)*VDL2_SPS)%L]-VDL2_PREPH[i], dd=cur-prev;
    prev=cur;
    if(dd>Math.PI) unwrap-=2*Math.PI; else if(dd<-Math.PI) unwrap+=2*Math.PI;
    err[i]=cur+unwrap; mean+=err[i];
  }
  mean/=VDL2_PRE;
  for(let i=0;i<VDL2_PRE;i++) err[i]-=mean;
  let fe=0;
  for(let i=0;i<VDL2_PRE;i++) fe+=VDL2_LRX.X[i]*err[i];
  fe/=VDL2_LRX.den;
  v.pherr[0]=0;
  for(let i=0;i<VDL2_PRE;i++){ const e=err[i]-fe*VDL2_LRX.X[i]; v.pherr[0]+=e*e; }
  if(v.pherr[1]<VDL2_THR && v.pherr[0]>v.pherr[1]){
    let vx=vdl2ParaVertex(v.sclk,VDL2_SKIP,v.pherr[2],v.pherr[1],v.pherr[0]);
    if(!isFinite(vx)) vx=0;
    v.sclk=-Math.round(vx);
    let sp=(v.sbi-v.sclk)%L; if(sp<0) sp+=L;
    v.prevPhi=sb[sp];
    v.dphi=v.prevDphi;
    v.pherr[1]=v.pherr[2]=VDL2_PHMAX;
    return true;
  }
  v.pherr[2]=v.pherr[1];
  v.pherr[1]=v.pherr[0];
  v.prevDphi=fe;
  return false;
}
// разбор принятого пакета: заголовок, данные, FEC → кадры (Uint8Array[]) или null
function vdl2Burst(v){
  const bs=v.bs;
  if(v.dec===0){                                                  // заголовок
    v.st.lfsr=VDL2_IV; vdl2Descramble(bs,v.st);
    let h=0;
    for(let i=0;i<VDL2_HDR;i++) h=(h<<1)|bs.buf[bs.start+i];
    bs.start+=VDL2_HDR;
    const mask=(1<<(VDL2_TRLEN+VDL2_FECLEN))-1;
    h&=mask;                                                      // резервный символ — нули
    let syn=0;
    for(let i=0;i<VDL2_FECLEN;i++) syn|=vdl2Par(h&VDL2_H[i])<<(VDL2_FECLEN-1-i);
    h=(h^VDL2_SYND[syn])>>>0;
    v.syn=syn;
    if((h&mask)!==h){ v.cnt.badHdr++; v.dec=2; return null; }
    h>>>=VDL2_FECLEN;
    v.datalen=vdl2Rev(h&((1<<VDL2_TRLEN)-1),VDL2_TRLEN);
    if((syn!==0 && v.datalen>VDL2_MAXLEN_C) || v.datalen>VDL2_MAXLEN){ v.cnt.badHdr++; v.dec=2; return null; }
    v.dOct=Math.ceil(v.datalen/8);
    v.nBlk=Math.floor(v.dOct/VDL2_RS_K);
    v.fecOct=v.nBlk*(VDL2_RS_N-VDL2_RS_K);
    v.lastLen=v.dOct%VDL2_RS_K;
    if(v.lastLen!==0) v.nBlk++;
    v.fecOct+=vdl2FecOct(v.lastLen);
    if(v.lastLen===0) v.lastLen=VDL2_RS_K;
    if(v.fecOct===0){ v.cnt.badHdr++; v.dec=2; return null; }
    v.reqBits=8*(v.dOct+v.fecOct);
    v.dec=1;
    return null;
  }
  // данные
  vdl2Descramble(bs,v.st);
  const data=new Uint8Array(v.dOct), fec=new Uint8Array(v.fecOct);
  v.dec=2;
  if(!vdl2ReadLsb(bs,data,v.dOct) || !vdl2ReadLsb(bs,fec,v.fecOct)) return null;
  const tab=new Uint8Array(v.nBlk*VDL2_RS_N);
  const m1=vdl2Map(v.dOct,v.nBlk,VDL2_RS_K,0);
  if(typeof m1==='number'){ v.cnt.badFec++; return null; }
  for(let i=0;i<v.dOct;i++) tab[m1.R[i]*VDL2_RS_N+m1.C[i]]=data[i];
  let fecRows=v.nBlk;
  if(vdl2FecOct(v.lastLen)===0) fecRows--;
  if(fecRows>0){
    const m2=vdl2Map(v.fecOct,fecRows,VDL2_RS_N-VDL2_RS_K,VDL2_RS_K);
    if(typeof m2==='number'){ v.cnt.badFec++; return null; }
    for(let i=0;i<v.fecOct;i++) tab[m2.R[i]*VDL2_RS_N+m2.C[i]]=fec[i];
  }
  vdl2BsReset(bs);
  for(let r=0;r<v.nBlk;r++){
    const nf=r===v.nBlk-1 ? vdl2FecOct(v.lastLen) : VDL2_RS_N-VDL2_RS_K;
    const cw=tab.subarray(r*VDL2_RS_N,(r+1)*VDL2_RS_N);
    if(nf>0){
      const er=[]; for(let i=VDL2_RS_K+nf;i<VDL2_RS_N;i++) er.push(i);
      const ret=vdl2RsFix(cw,er);
      if(ret<0){ v.cnt.badFec++; return null; }
      if(ret>0) v.fixes+=Math.max(0,ret-er.length);
    }
    if(!vdl2AppendLsb(bs,cw,0,r!==v.nBlk-1 ? VDL2_RS_K : v.lastLen)){ v.cnt.badFec++; return null; }
  }
  if(v.datalen<bs.end-bs.start) bs.end=bs.start+v.datalen;
  const frames=[];
  for(;;){
    const f=vdl2NextFrame(bs);
    if(!f){ v.cnt.badStuff++; return frames.length ? frames : null; }
    if(f.bits.length%8!==0){ v.cnt.badStuff++; return frames.length ? frames : null; }
    const by=new Uint8Array(f.bits.length/8);
    for(let i=0;i<by.length;i++){ let x=0; for(let j=0;j<8;j++) x|=f.bits[8*i+j]<<j; by[i]=x; }
    frames.push(by);
    if(!f.more) break;
  }
  return frames;
}
function vdl2Sample(n,v,re,im,recs,now){
  if(v.dec===2) vdl2Reset(v);
  if(v.ds===0){                                                    // поиск преамбулы
    v.sbi=(v.sbi+1)%VDL2_SBL; v.sb[v.sbi]=Math.atan2(im,re);
    if(++v.sclk<VDL2_SKIP) return;
    v.sclk=0;
    v.mag=v.mag*.9+Math.hypot(re,im)*.1;
    if(vdl2GotSync(v)) v.ds=1;
    return;
  }
  if(++v.sclk<VDL2_SPS) return;
  v.sclk=0;
  const phi=Math.atan2(im,re);
  let d=phi-v.prevPhi-v.dphi;
  if(d<0) d+=2*Math.PI; else if(d>2*Math.PI) d-=2*Math.PI;
  d/=Math.PI/4;
  const idx=Math.round(d)%8;
  v.pwr=(v.pwr*v.pwrN+re*re+im*im)/(v.pwrN+1); v.pwrN++;
  v.prevPhi=phi;
  const bs=v.bs, g=VDL2_GRAY[idx<0 ? idx+8 : idx];
  if(bs.end+3>bs.buf.length){ v.dec=2; return; }
  bs.buf[bs.end++]=(g>>2)&1; bs.buf[bs.end++]=(g>>1)&1; bs.buf[bs.end++]=g&1;
  if(bs.end-bs.start>=v.reqBits){
    v.cnt.bursts++;
    const frames=vdl2Burst(v);
    if(v.dec===1) return;                                          // заголовок принят, ждём данные
    v.dec=2;
    if(frames){
      const meta={rssi:+(10*Math.log10(Math.max(v.pwr,1e-9))).toFixed(1), df:Math.round(v.dphi*VDL2_BAUD/(2*Math.PI)), fixed:v.fixes};
      for(const f of frames){
        const r=vdl2Avlc(f,meta,{asm:v.asm, now});
        if(r){ n.frames++; v.cnt.good++; if(v.fixes) n.fixed++; if(r.kind==='message') n.acars++; recs.push(r); n.last=now;
          n.recent.push(new Date(now).toTimeString().slice(0,8)+' '+r.text.slice(0,100)); if(n.recent.length>20) n.recent.shift(); }
        else v.cnt.badFcs++;
      }
    }
  }
}

IQK.vdl2Rx={
  init(n){
    n.key=''; n.frames=0; n.fixed=0; n.acars=0; n.last=0; n.recent=[]; n.rt=0; n.ui=null;
    n.vd={bs:vdl2Bs(32768), sb:new Float64Array(VDL2_SBL), sbi:0, st:{lfsr:0}, prevPhi:0, dphi:0, prevDphi:0, mag:0,
      cnt:{bursts:0, good:0, badHdr:0, badFec:0, badStuff:0, badFcs:0}, asm:{x25:new Map(), clnp:new Map()}};
    vdl2Reset(n.vd);
  },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s || !s.sr){ n.ui=null; return {rec:null, text:null, locked:0}; }
    const sr=s.sr, v=n.vd, recs=[], now=Date.now();
    if(sr<24e3){ n.ui={err:'sample rate '+(sr/1000).toFixed(1)+' kS/s is too low: VDL2 needs ≥ 48 kS/s', fs:sr, frames:n.frames, recent:n.recent}; return {rec:null, text:null, locked:0}; }
    if(n.key!==String(sr)){                                        // ФНЧ 8 кГц и шаг передискретизации
      n.key=String(sr); n.q=biquadCoef('lp',Math.min(8000,.45*sr),.7071,sr);
      n.zr=new Float64Array(4); n.zi=new Float64Array(4); n.step=sr/VDL2_FS; n.rt=0;
      n.hr=new Float64Array(4); n.hi=new Float64Array(4);          // последние 4 отфильтрованных отсчёта (кубическая интерполяция)
    }
    const q=n.q, zr=n.zr, zi=n.zi, hr=n.hr, hi=n.hi, step=n.step;
    for(const c of s.chunks){
      const xr=c.re, xi=iqChunkIm(c), K=xr.length;
      for(let i=0;i<K;i++){
        const yr=iqBq(zr,0,q,xr[i]), yi=iqBq(zi,0,q,xi[i]);
        hr[0]=hr[1]; hr[1]=hr[2]; hr[2]=hr[3]; hr[3]=yr;
        hi[0]=hi[1]; hi[1]=hi[2]; hi[2]=hi[3]; hi[3]=yi;
        // выходной отсчёт лежит между hr[1] и hr[2] при n.rt∈[0,1); n.rt — позиция относительно hr[1]
        while(n.rt<1){
          const t=n.rt;
          const cr=.5*(hr[2]-hr[0]), c2r=hr[0]-2.5*hr[1]+2*hr[2]-.5*hr[3], c3r=.5*(hr[3]-hr[0])+1.5*(hr[1]-hr[2]);
          const ci=.5*(hi[2]-hi[0]), c2i=hi[0]-2.5*hi[1]+2*hi[2]-.5*hi[3], c3i=.5*(hi[3]-hi[0])+1.5*(hi[1]-hi[2]);
          vdl2Sample(n,v,((c3r*t+c2r)*t+cr)*t+hr[1],((c3i*t+c2i)*t+ci)*t+hi[1],recs,now);
          n.rt+=step;
        }
        n.rt-=1;
      }
    }
    const nz=Math.max(v.mag,1e-9);
    n.ui={fs:sr, frames:n.frames, fixed:n.fixed, acars:n.acars, bursts:v.cnt.bursts, bad:v.cnt.badHdr+v.cnt.badFec+v.cnt.badStuff+v.cnt.badFcs, cnt:{...v.cnt},
      lvl:20*Math.log10(nz), recent:n.recent, age:n.last ? now-n.last : null, state:v.ds===0 ? 'search' : v.dec===0 ? 'header' : 'data'};
    const text=recs.map(r=>r.text);
    return {rec:recs.length ? recs : null, text:text.length ? text.join('\n') : null, locked:n.last && now-n.last<5000 ? 1 : 0};
  }};

/* ---- передатчик (тест и генератор): кадры AVLC → пакет D8PSK ---- */
const VDL2_SIM=[
  {from:0x4840D6, to:0x1B4002, text:{mode:'2', reg:'.PH-BXA', ack:0x15, label:'H1', blk:'3', flight:'KL1234', body:'#M1BPOS N52123E004456,FL360,ETA1432'}},
  {from:0x1B4002, to:0x4840D6, text:{mode:'2', reg:'.PH-BXA', ack:'3', label:'5Z', blk:'B', body:'GATE B23 LAND 1432Z'}},
  {from:0x3C4DD2, to:0x1B4002, text:{mode:'2', reg:'.D-AIZF', ack:0x15, label:'QA', blk:'1', flight:'LH0401', body:'OUT0745 OFF0802'}}];
function vdl2AddrBytes(a,last){        // type, status, addr → 4 октета (LSB — признак продолжения)
  const val=(a.addr&0xFFFFFF)|((a.type&7)<<24)|((a.status&1)<<27), x=vdl2Rev(val,28);
  return [((x&0x7f)<<1), (((x>>7)&0x7f)<<1), (((x>>14)&0x7f)<<1), ((((x>>21)&0x7f)<<1)|1)];
}
function vdl2AcarsBytes(m,k){
  const code=s=>typeof s==='number' ? s : s.charCodeAt(0), c=[code(m.mode)];
  for(const ch of m.reg) c.push(ch.charCodeAt(0));
  c.push(code(m.ack), m.label.charCodeAt(0), m.label.charCodeAt(1), code(m.blk));
  let txt=m.body;
  if(m.blk<='9') txt='M'+String(k%100).padStart(2,'0')+'A'+(m.flight||'').padEnd(6,' ')+txt;
  if(txt){ c.push(2); for(const ch of txt) c.push(ch.charCodeAt(0)); }
  c.push(3);
  const by=c.map(vacPar), crc=vacCrc(by,by.length);
  by.push(crc&0xFF,crc>>8,0x7f);
  return by;
}
// кадр AVLC (адреса — {addr,type,status}, lcf — управляющий байт) → байты с FCS
function vdl2BuildFrame(dst,src,sseq,rseq,payload,lcf){
  const b=[...vdl2AddrBytes(dst),...vdl2AddrBytes(src),lcf!=null ? lcf : ((rseq&7)<<5)|((sseq&7)<<1),...payload];
  const fcs=vdl2Crc(b,b.length)^0xFFFF;
  b.push(fcs&0xFF,fcs>>8);
  return Uint8Array.from(b);
}
const vdl2Tl=(t,d)=>[t,d.length,...d];
const vdl2Asc=s=>Array.from(s,c=>c.charCodeAt(0));
const vdl2LocB=(lat,lon)=>{ const a=Math.round(lat*10)&0xfff, o=Math.round(lon*10)&0xfff; return [a>>4,((a&15)<<4)|(o>>8),o&255]; };
const vdl2FreqB=(mhz,mods)=>{ const f=(Math.floor(mhz*100)-10000)&0xfff; return [(mods<<4)|(f>>8),f&255]; };
function vdl2XidBytes(pub,vdl){ const g=(id,t)=>t.length ? [id,t.length>>8,t.length&255,...t] : []; return [0x82,...g(0x80,pub),...g(0xF0,vdl)]; }
// X.25: заголовок (канал 1), данные / Call Request
const vdl2X25Hdr=(type)=>[0x10,0x01,type];
const vdl2X25Data=(sseq,rseq,more,pay)=>[...vdl2X25Hdr(((rseq&7)<<5)|((more ? 1 : 0)<<4)|((sseq&7)<<1)),...pay];
const vdl2Clnp0=(src,dst,id,off,total,data)=>{          // полный CLNP DT с сегментацией
  const hl=9+1+dst.length+1+src.length+6;
  return [0x81,hl,1,0x3c,0x9c,(hl+data.length)>>8,(hl+data.length)&255,0,0,dst.length,...dst,src.length,...src,id>>8,id&255,off>>8,off&255,total>>8,total&255,...data];
};
const VDL2_GS=0x1B4002, VDL2_AC=0x4840D6;
const VDL2_NSAP_GS=[0x47,0x00,0x27,0x01,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0xfe];
const VDL2_NSAP_AC=[0x47,0x00,0x27,0x02,0x00,0x00,0x00,0x00,0x48,0x40,0xd6,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x01];
// сценарии тестового эфира: ACARS (3 сообщения), маяк GSIF, XID Link Establishment, X.25 Call Request + ES-IS, данные X.25 → CLNP (сжатый) → COTP, фрагментированный полный CLNP
function vdl2SimFrames(k){
  const ac={addr:VDL2_AC,type:1,status:0}, all={addr:0xFFFFFF,type:7,status:0}, G={addr:VDL2_GS,type:4,status:0};
  const sc=k%9;
  if(sc<3){ const m=VDL2_SIM[sc], pay=[0xff,0xff,0x01,...vdl2AcarsBytes(m.text,k)];
    return [vdl2BuildFrame({addr:m.to,type:m.to===VDL2_GS ? 4 : 1,status:0},{addr:m.from,type:m.from===VDL2_GS ? 4 : 1,status:0},k&7,(k+1)&7,pay)]; }
  if(sc===3){            // GSIF
    const vdl=[...vdl2Tl(0,vdl2Asc('V')),...vdl2Tl(0xC8,vdl2LocB(52.3,4.8)),...vdl2Tl(0xC3,vdl2Asc('EHAM')),
      ...vdl2Tl(0xC0,[...vdl2FreqB(136.975,2),...vdl2AddrBytes({addr:VDL2_GS,type:4,status:0}),...vdl2FreqB(136.725,2),...vdl2AddrBytes({addr:VDL2_GS,type:4,status:0})]),
      ...vdl2Tl(0x81,[2])];
    return [vdl2BuildFrame(all,G,0,0,vdl2XidBytes(vdl2Tl(1,vdl2Asc('A')),vdl),0xAF)]; }
  if(sc===4){            // XID_CMD_LE от борта: P=1, h=0 r=0
    const vdl=[...vdl2Tl(0,vdl2Asc('V')),...vdl2Tl(1,[0x00]),...vdl2Tl(3,[0x01]),...vdl2Tl(0x81,[2]),...vdl2Tl(0x83,vdl2Asc('EDDF')),...vdl2Tl(0x84,[...vdl2LocB(50.1,8.6),12])];
    return [vdl2BuildFrame({addr:VDL2_GS,type:4,status:0},ac,0,0,vdl2XidBytes(vdl2Tl(1,vdl2Asc('A')),vdl),0xBF)]; }
  if(sc===5){            // X.25 Call Request с SNDCF и ES-IS Hello в данных
    const net=VDL2_NSAP_AC, esis=[0x82,9+1+net.length,1,0,4,0x03,0x84,0,0,net.length,...net];
    const pay=[...vdl2X25Hdr(0x0b),0x44,0x12,0x34,0x56,0x78,0x00,0xc1,0x04,0x01,0x00,0x00,0x01,...esis];
    return [vdl2BuildFrame({addr:VDL2_GS,type:4,status:0},ac,k&7,(k+1)&7,pay)]; }
  if(sc===6){            // данные: X.25 → сжатый CLNP (тип 1: сегментация разрешена, lref 5) → COTP DT
    const pay=[...vdl2X25Data(0,1,false,[0x10,0x3c,0x00,0x05,0x00,0x07,0x04,0xf0,0x00,0x01,0x80,0xde,0xad,0xbe,0xef])];
    return [vdl2BuildFrame({addr:VDL2_GS,type:4,status:0},ac,k&7,(k+1)&7,pay)]; }
  if(sc===7){            // полный CLNP, два сегмента в двух пакетах X.25 (more-бит)
    const data=[0x04,0xf0,0x00,0x01,0x80,0x01,0x02,0x03,0x04,0x05], total=data.length;
    const f1=vdl2Clnp0(VDL2_NSAP_AC,VDL2_NSAP_GS,0x1234,0,total,data.slice(0,5)), f2=vdl2Clnp0(VDL2_NSAP_AC,VDL2_NSAP_GS,0x1234,5,total,data.slice(5));
    return [vdl2BuildFrame({addr:VDL2_GS,type:4,status:0},ac,0,0,vdl2X25Data(0,0,false,f1)), vdl2BuildFrame({addr:VDL2_GS,type:4,status:0},ac,1,0,vdl2X25Data(1,0,false,f2))]; }
  // X.25 Clear Request: причина 0, диагностика 0x91
  return [vdl2BuildFrame(ac,{addr:VDL2_GS,type:4,status:0},k&7,(k+1)&7,[...vdl2X25Hdr(0x13),0x00,0x91])];
}
// кадры (байты) → индексы разностной фазы (0…7) пакета, включая преамбулу: [символы фазы]
function vdl2BuildBurst(frames){
  const bits=[];
  const flag=[0,1,1,1,1,1,1,0];
  for(const b of flag) bits.push(b);
  for(const f of frames){
    let ones=0;
    for(const by of f) for(let j=0;j<8;j++){ const bit=(by>>j)&1; bits.push(bit); if(bit){ if(++ones===5){ bits.push(0); ones=0; } } else ones=0; }
    for(const b of flag) bits.push(b);
  }
  const datalen=bits.length, dOct=Math.ceil(datalen/8);
  const data=new Uint8Array(dOct);
  for(let i=0;i<datalen;i++) data[i>>3]|=bits[i]<<(i&7);
  const nBlk=Math.ceil(dOct/VDL2_RS_K), lastLen=dOct%VDL2_RS_K || VDL2_RS_K;
  const tab=new Uint8Array(nBlk*VDL2_RS_N);
  for(let r=0;r<nBlk;r++){
    const len=r===nBlk-1 ? lastLen : VDL2_RS_K, cw=tab.subarray(r*VDL2_RS_N,(r+1)*VDL2_RS_N);
    cw.set(data.subarray(r*VDL2_RS_K,r*VDL2_RS_K+len));
    VDL2_RS.encode(cw);
  }
  const nfLast=vdl2FecOct(lastLen);
  const fecTotal=(nBlk-1)*(VDL2_RS_N-VDL2_RS_K)+nfLast;
  const m1=vdl2Map(dOct,nBlk,VDL2_RS_K,0);
  const outData=new Uint8Array(dOct);
  for(let i=0;i<dOct;i++) outData[i]=tab[m1.R[i]*VDL2_RS_N+m1.C[i]];
  let fecRows=nBlk; if(nfLast===0) fecRows--;
  const outFec=new Uint8Array(fecTotal);
  if(fecRows>0 && fecTotal>0){
    const m2=vdl2Map(fecTotal,fecRows,VDL2_RS_N-VDL2_RS_K,VDL2_RS_K);
    for(let i=0;i<fecTotal;i++) outFec[i]=tab[m2.R[i]*VDL2_RS_N+m2.C[i]];
  }
  // заголовок: резерв 000, длина (биты в обратном порядке), проверка
  let h=(vdl2Rev(datalen,VDL2_TRLEN)<<VDL2_FECLEN)>>>0;
  for(let i=0;i<VDL2_FECLEN;i++) if(vdl2Par(h&VDL2_H[i])) h|=1<<(VDL2_FECLEN-1-i);
  const all=[];
  for(let i=VDL2_HDR-1;i>=0;i--) all.push((h>>i)&1);
  for(const by of outData) for(let j=0;j<8;j++) all.push((by>>j)&1);
  for(const by of outFec) for(let j=0;j<8;j++) all.push((by>>j)&1);
  let lf=VDL2_IV;
  for(let i=0;i<all.length;i++){ const bit=((lf>>0)^(lf>>14))&1; lf=(lf>>1)|(bit<<14); all[i]^=bit; }
  while(all.length%3) all.push(0);
  const inv=[]; VDL2_GRAY.forEach((g,i)=>{ inv[g]=i; });
  const sym=[];
  for(let i=0;i<all.length;i+=3) sym.push(inv[(all[i]<<2)|(all[i+1]<<1)|all[i+2]]);
  return sym;
}
// RRC α=0.6 в таблице (шаг 1/64 символа, ±6 символов)
const VDL2_RRC=(()=>{
  const a=.6, R=64, H=6, t=new Float32Array(2*H*R+1);
  for(let i=0;i<t.length;i++){
    const x=(i-H*R)/R;
    let v;
    if(Math.abs(x)<1e-9) v=1-a+4*a/Math.PI;
    else if(Math.abs(Math.abs(x)-1/(4*a))<1e-6) v=a/Math.SQRT2*((1+2/Math.PI)*Math.sin(Math.PI/(4*a))+(1-2/Math.PI)*Math.cos(Math.PI/(4*a)));
    else v=(Math.sin(Math.PI*x*(1-a))+4*a*x*Math.cos(Math.PI*x*(1+a)))/(Math.PI*x*(1-(4*a*x)*(4*a*x)));
    t[i]=v;
  }
  let e=0; for(const v of t) e+=v*v; const k=1/Math.sqrt(e/R);
  for(let i=0;i<t.length;i++) t[i]*=k;
  return t;
})();
// символы разностной фазы → комплексный сигнал на частоте sr (преамбула добавляется здесь); [re,im]
function vdl2Modulate(sym,sr,lead,tail){
  const ph=[...VDL2_PREPH];
  let p=0;
  for(const d of sym){ p+=d*Math.PI/4; ph.push(p); }
  const spsr=sr/VDL2_BAUD, nl=Math.round(lead*spsr), nt=Math.round(tail*spsr), N=Math.round((ph.length+12)*spsr)+nl+nt;
  const re=new Float32Array(N), im=new Float32Array(N), R=64, H=6;
  const cs=ph.map(Math.cos), sn=ph.map(Math.sin);
  for(let i=0;i<N-nt;i++){
    const tau=(i-nl)/spsr-6;
    const k0=Math.ceil(tau-H), k1=Math.floor(tau+H);
    let ar=0, ai=0;
    for(let k=Math.max(0,k0);k<=Math.min(ph.length-1,k1);k++){
      const w=VDL2_RRC[Math.round((tau-k+H)*R)]; if(w===undefined) continue;
      ar+=w*cs[k]; ai+=w*sn[k];
    }
    re[i]=ar; im[i]=ai;
  }
  return [re,im];
}
// генератор IQ для IQ Generator: пакеты с ACARS через паузу, амплитуда 1
function vdl2Generate(n,sr,N){
  let g=n.vdl2G;
  if(!g || g.sr!==sr) g=n.vdl2G={sr, k:0, buf:null, pos:0};
  const re=new Float32Array(N), im=new Float32Array(N);
  for(let i=0;i<N;i++){
    if(!g.buf || g.pos>=g.buf[0].length){
      g.buf=vdl2Modulate(vdl2BuildBurst(vdl2SimFrames(g.k)),sr,Math.round(.05*VDL2_BAUD),Math.round(.4*VDL2_BAUD)); g.pos=0; g.k++;
    }
    re[i]=g.buf[0][g.pos]; im[i]=g.buf[1][g.pos]; g.pos++;
  }
  return [re,im];
}
