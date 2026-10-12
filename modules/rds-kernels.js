"use strict";
/* ============================ RDS / RBDS ============================
   Ядро без DOM. rdsParserMake() — от дифференциально декодированных битов до группировки блоков и разбора
   групп; целиком уходит в воркер демодуляции через toString(), поэтому внутри нет ссылок наружу.
   Остальное (названия PTY, страны, позывной RBDS, подписи) — для страницы. */

function rdsParserMake(){
  const OFF=[0x0FC,0x198,0x168,0x1B4], OFFC2=0x350;           // смещения блоков A B C D и C'
  // символы 0x80…0xFF по таблице RDS (IEC 62106, приложение E); младшая половина — ASCII
  const HI='áàéèíìóòúùÑÇŞß¡Ĳâäêëîïôöûüñçşğıĳªα©‰Ğěňőπ€£$←↑→↓º¹²³±İńűµ¿÷°¼½¾§ÁÀÉÈÍÌÓÒÚÙŘČŠŽÐĿÂÄÊËÎÏÔÖÛÜřčšžđŀÃÅÆŒŷÝÕØÞŊŔĆŚŹŦðãåæœŵýõøþŋŕćśźŧ ';
  const chr=c=>c>=0x20&&c<0x7f ? String.fromCharCode(c) : c>=0x80 ? HI[c-0x80]||' ' : c===0x0d ? '\r' : ' ';
  const syn=w=>{ let r=0; for(let i=25;i>=0;i--){ r=(r<<1)|((w>>>i)&1); if(r&0x400) r^=0x5B9; } return r&0x3FF; };

  let reg, bitN, sync, lastHit, lastOff, exp, err, blk=[0,0,0,0], ok=[false,false,false,false];
  let S, dirty;
  const fresh=()=>({pi:-1, pty:0, tp:0, ta:0, ms:-1, di:[-1,-1,-1,-1],
    ps:new Array(8).fill(' '), psMask:0, rt:new Array(64).fill(' '), rtAB:-1, rtN:0, ptyn:new Array(8).fill(' '), ptynN:0,
    af:new Map(), afLf:false, ecc:0, lic:-1, pin:null, ct:null, oda:new Map(), rtpGc:-1, rtp:[], rtpRun:0,
    eon:new Map(), grp:new Array(32).fill(0), groups:0, blocks:0, bad:0});
  function reset(){
    reg=0; bitN=0; sync=false; lastHit=-1; lastOff=-1; exp=0; err=[]; ok.fill(false); S=fresh(); dirty=true;
  }
  function addAf(kHz){ if(S.af.size<40 && !S.af.has(kHz)){ S.af.set(kHz,1); dirty=true; } }
  function afCode(x){
    if(S.afLf){ S.afLf=false;
      if(x>=1&&x<=15) addAf(153+9*(x-1)); else if(x>=16&&x<=135) addAf(531+9*(x-16)); return; }
    if(x>=1&&x<=204) addAf(87500+100*x);
    else if(x===250) S.afLf=true;
  }
  function group(){
    const [a,b,c,d]=blk;
    if(ok[0] && S.pi!==a){ S.pi=a; dirty=true; }
    if(!ok[1]) return;
    const type=b>>>12, ver=(b>>>11)&1, tp=(b>>>10)&1, pty=(b>>>5)&31;
    S.groups++; S.grp[type*2+ver]++;
    if(ver && S.pi<0 && ok[2]){ S.pi=c; dirty=true; }
    if(pty!==S.pty||tp!==S.tp){ S.pty=pty; S.tp=tp; dirty=true; }
    if(type===0){
      const ta=(b>>>4)&1, ms=(b>>>3)&1, seg=b&3, di=(b>>>2)&1;
      if(ta!==S.ta||ms!==S.ms||S.di[seg]!==di){ S.ta=ta; S.ms=ms; S.di[seg]=di; dirty=true; }
      if(!ver && ok[2]){ afCode(c>>>8); afCode(c&0xff); }
      if(ok[3]){ const i=seg*2; S.ps[i]=chr(d>>>8); S.ps[i+1]=chr(d&0xff); S.psMask|=3<<i; dirty=true; }
    } else if(type===1){
      if(!ver && ok[2]){
        const v=(c>>>12)&7;
        if(v===0 && (c&0xff)){ S.ecc=c&0xff; dirty=true; }
        else if(v===3){ S.lic=c&0xfff; dirty=true; }
      }
      if(ok[3]){
        const day=d>>>11, h=(d>>>6)&31, m=d&63;
        if(day>=1 && h<24 && m<60){ S.pin={day,h,m}; dirty=true; }
      }
    } else if(type===2){
      const ab=(b>>>4)&1, addr=b&15;
      if(ab!==S.rtAB){ S.rtAB=ab; S.rt.fill(' '); S.rtN=0; }
      if(!ver && ok[2] && ok[3]){
        const t=[c>>>8,c&0xff,d>>>8,d&0xff];
        for(let k=0;k<4;k++) S.rt[addr*4+k]=chr(t[k]);
        S.rtN++;
      } else if(ver && ok[3]){
        S.rt[addr*2]=chr(d>>>8); S.rt[addr*2+1]=chr(d&0xff); S.rtN++;
      }
      dirty=true;
    } else if(type===3 && !ver){
      if(ok[2] && ok[3]){
        const gc=b&31;
        S.oda.set(d,gc); dirty=true;
        if(d===0x4BD7) S.rtpGc=gc;
      }
    } else if(type===4 && !ver){
      if(ok[2] && ok[3]){
        const mjd=((b&3)<<15)|(c>>>1), h=((c&1)<<4)|(d>>>12), mi=(d>>>6)&63, off=(d&31)*((d>>>5)&1?-30:30);
        if(mjd>40587 && h<24 && mi<60){ S.ct={ts:(mjd-40587)*86400000+h*3600000+mi*60000, off}; dirty=true; }
      }
    } else if(type===10 && !ver){
      if(ok[2] && ok[3]){
        const i=(b&1)*4;
        S.ptyn[i]=chr(c>>>8); S.ptyn[i+1]=chr(c&0xff); S.ptyn[i+2]=chr(d>>>8); S.ptyn[i+3]=chr(d&0xff); S.ptynN|=1<<(b&1); dirty=true;
      }
    } else if(type===14 && ok[3]){
      const on=d;
      let e=S.eon.get(on);
      if(!e && S.eon.size<24) S.eon.set(on, e={pi:on, ps:new Array(8).fill(' '), psN:0, pty:-1, ta:-1, af:[]});
      if(e){
        if(!ver && ok[2]){
          const vc=b&15;
          if(vc<=3){ e.ps[vc*2]=chr(c>>>8); e.ps[vc*2+1]=chr(c&0xff); e.psN|=1<<vc; }
          else if(vc===4){ const f=x=>{ if(x>=1&&x<=204 && !e.af.includes(87500+100*x) && e.af.length<12) e.af.push(87500+100*x); }; f(c>>>8); f(c&0xff); }
          else if(vc===13){ e.pty=c>>>11; e.ta=c&1; }
        } else if(ver){ e.ta=(b>>>3)&1; }
        dirty=true;
      }
    }
    // RadioText+: группа, о которой объявила ODA 4BD7
    if(S.rtpGc>=0 && S.rtpGc===(type<<1|ver) && ok[2] && ok[3]){
      S.rtpRun=(b>>>3)&1;
      const ct1=((b&7)<<3)|(c>>>13), s1=(c>>>7)&63, l1=((c>>>1)&63)+1;
      const ct2=((c&1)<<5)|(d>>>11), s2=(d>>>5)&63, l2=(d&31)+1;
      S.rtp=[[ct1,s1,l1],[ct2,s2,l2]].filter(t=>t[0]>0); dirty=true;
    }
  }
  function bit(v){
    reg=((reg<<1)|v)&0x3FFFFFF; bitN++;
    if(!sync){
      const sy=syn(reg);
      let off=OFF.indexOf(sy); if(off<0 && sy===OFFC2) off=2;
      if(off<0) return;
      // два блока подряд на правильном расстоянии и в правильном порядке — синхронизация есть
      if(lastHit>=0){
        const dist=bitN-lastHit, steps=((off-lastOff)+4)%4||4;
        if(dist===steps*26){ sync=true; exp=(off+1)%4; bitN=0; err=[]; dirty=true;
          blk[off]=(reg>>>10)&0xffff; ok.fill(false); ok[off]=true; lastHit=-1; return; }
      }
      lastHit=bitN; lastOff=off; return;
    }
    if(bitN<26) return;
    bitN=0;
    const sy=syn(reg), good=sy===OFF[exp] || (exp===2 && sy===OFFC2);
    blk[exp]=(reg>>>10)&0xffff; ok[exp]=good;
    err.push(good?0:1); if(err.length>50) err.shift();
    S.blocks++; if(!good) S.bad++;
    if(exp===3){ group(); ok.fill(false); }
    exp=(exp+1)%4;
    if(err.length>=10 && err.reduce((x,y)=>x+y,0)>err.length*0.4){ sync=false; lastHit=-1; dirty=true; }
  }
  function snap(){
    const rt=S.rt.join(''), cr=rt.indexOf('\r'), rtx=(cr>=0?rt.slice(0,cr):rt).replace(/\s+$/,'');
    const tags=S.rtp.map(([ct,s,l])=>({ct, text:rt.slice(s,s+l).trim()})).filter(t=>t.text);
    dirty=false;
    return {sync, pi:S.pi, pty:S.pty, tp:S.tp, ta:S.ta, ms:S.ms, di:S.di.slice(),
      ps:S.ps.join(''), psMask:S.psMask, rt:rtx, rtAB:S.rtAB, ptyn:S.ptynN===3?S.ptyn.join('').trim():'',
      af:[...S.af.keys()].sort((x,y)=>x-y), ecc:S.ecc, lic:S.lic, pin:S.pin, ct:S.ct,
      oda:[...S.oda].map(([aid,gc])=>({aid,gc})), rtp:tags, rtpRun:S.rtpRun,
      eon:[...S.eon.values()].map(e=>({pi:e.pi, ps:e.psN===15?e.ps.join(''):'', pty:e.pty, ta:e.ta, af:e.af})),
      grp:S.grp.slice(), groups:S.groups, blocks:S.blocks, bad:S.bad,
      bler:err.length ? err.reduce((x,y)=>x+y,0)/err.length : 1};
  }
  reset();
  return {bit, reset, snap, get dirty(){ return dirty; }, get sync(){ return sync; }};
}

/* ---- для страницы ---- */
const RDS_PTY=['None','News','Current affairs','Information','Sport','Education','Drama','Culture','Science','Varied',
  'Pop music','Rock music','Easy listening','Light classical','Serious classical','Other music','Weather','Finance',
  'Children\'s','Social affairs','Religion','Phone-in','Travel','Leisure','Jazz music','Country music','National music',
  'Oldies music','Folk music','Documentary','Alarm test','Alarm'];
const RBDS_PTY=['None','News','Information','Sports','Talk','Rock','Classic rock','Adult hits','Soft rock','Top 40','Country',
  'Oldies','Soft','Nostalgia','Jazz','Classical','Rhythm and blues','Soft R&B','Foreign language','Religious music',
  'Religious talk','Personality','Public','College','Unassigned','Unassigned','Unassigned','Unassigned','Unassigned',
  'Weather','Emergency test','Emergency'];
// страна по ECC и первой цифре PI; только то, в чём есть уверенность — остальное страница покажет кодами
const RDS_COUNTRY={
  E0:'-,DE,DZ,AD,IL,IT,BE,RU,PS,AL,AT,HU,MT,DE,-,EG'.split(','),
  E1:'-,GR,CY,SM,CH,JO,FI,LU,BG,DK,GI,IQ,GB,LY,RO,FR'.split(','),
  E2:'-,MA,CZ,PL,VA,SK,SY,TN,-,LI,IS,MC,LT,RS,ES,NO'.split(','),
  E3:'-,ME,IE,TR,MK,-,-,-,NL,LV,LB,AZ,HR,KZ,SE,BY'.split(',')};
const RDS_ODA={0x4BD7:'RadioText+', 0xCD46:'TMC', 0xCD47:'TMC', 0x0093:'DAB cross-reference'};
const RTP_TYPE=['', 'title','album','track no.','artist','composition','movement','conductor','composer','band','comment',
  'genre','news','local news','stock market','sport','lottery','horoscope','daily diversion','health','event','scene',
  'cinema','TV','date/time','weather','traffic','alarm','advertisement','URL','other'];
const rdsHex=(v,n)=>v==null||v<0 ? '' : v.toString(16).toUpperCase().padStart(n||4,'0');
// позывной США по PI (RBDS): K***/W***
function rdsCallsign(pi){
  const L=n=>String.fromCharCode(65+Math.floor(n/676))+String.fromCharCode(65+Math.floor(n%676/26))+String.fromCharCode(65+n%26);
  if(pi>=4096 && pi<21672) return 'K'+L(pi-4096);
  if(pi>=21672 && pi<39248) return 'W'+L(pi-21672);
  return '';
}
function rdsCountry(pi, ecc){
  if(pi<0 || !ecc) return '';
  const t=RDS_COUNTRY[ecc.toString(16).toUpperCase()];
  const c=t&&t[pi>>>12];
  return c&&c!=='-' ? c : '';
}
// зона охвата — вторая цифра PI
function rdsCoverage(pi){
  if(pi<0) return '';
  const a=(pi>>>8)&15;
  return a===0 ? 'local' : a===1 ? 'international' : a===2 ? 'national' : a===3 ? 'supra-regional' : 'regional R'+(a-3);
}
function rdsFreqText(kHz){ return kHz>=87500 ? (kHz/1000).toFixed(1)+' MHz' : kHz+' kHz'; }
function rdsPtyName(s){ return (rdsCallsign(s.pi) ? RBDS_PTY : RDS_PTY)[s.pty]||''; }
// ps с неполученными символами как «·»; пока ни одного — пусто
function rdsPsView(s){
  let o=''; for(let i=0;i<8;i++) o+=(s.psMask>>>i)&1 ? s.ps[i] : '·';
  return s.psMask ? o : '';
}
