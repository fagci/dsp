"use strict";
/* ============================ SAME / EAS (NOAA Weather Radio, 162.4–162.55 МГц) ============================
   Specific Area Message Encoding: AFSK 520.83 Бод (бит = 1/1920 мкс), 1 — 2083.3 Гц, 0 — 1562.5 Гц, символ — 8 бит младшим
   вперёд (ASCII, старший бит 0). Передача: преамбула из 16 байт 0xAB, заголовок
   «ZCZC-ORG-EEE-PSSCCC-PSSCCC+TTTT-JJJHHMM-LLLLLLLL-» (до 31 зоны), так три раза с паузой 1 с, затем (после речи)
   «NNNN» трижды. Приём: 8 тактовых фаз, поиск «ZCZC» / «NNNN» по битам (до 2 ошибок), разбор до последнего «-» после
   «+TTTT-JJJHHMM-LLLLLLLL»; фазы голосуют за строку, три передачи — по символам. Время — по счёту отсчётов. */

const SAME_BAUD=520.8333, SAME_MARK=2083.3333, SAME_SPACE=1562.5, SAME_PH=8, SAME_MAXLEN=268;
const SAME_ORG={EAS:'EAS participant', CIV:'civil authorities', WXR:'National Weather Service', PEP:'Primary Entry Point'};
const SAME_EVENT={EAN:'Emergency Action Notification', EAT:'Emergency Action Termination', NIC:'National Information Center', NPT:'National Periodic Test',
  RMT:'Required Monthly Test', RWT:'Required Weekly Test', ADR:'Administrative Message', AVW:'Avalanche Warning', AVA:'Avalanche Watch',
  BZW:'Blizzard Warning', BLU:'Blue Alert', CAE:'Child Abduction Emergency', CDW:'Civil Danger Warning', CEM:'Civil Emergency Message',
  CFW:'Coastal Flood Warning', CFA:'Coastal Flood Watch', DSW:'Dust Storm Warning', EQW:'Earthquake Warning', EVI:'Evacuation Immediate',
  EWW:'Extreme Wind Warning', FRW:'Fire Warning', FFW:'Flash Flood Warning', FFA:'Flash Flood Watch', FFS:'Flash Flood Statement',
  FLW:'Flood Warning', FLA:'Flood Watch', FLS:'Flood Statement', FZW:'Freeze Warning', HMW:'Hazardous Materials Warning',
  HWW:'High Wind Warning', HWA:'High Wind Watch', HUW:'Hurricane Warning', HUA:'Hurricane Watch', HLS:'Hurricane Statement',
  LEW:'Law Enforcement Warning', LAE:'Local Area Emergency', NMN:'Network Message Notification', TOE:'911 Telephone Outage Emergency',
  NUW:'Nuclear Power Plant Warning', DMO:'Practice / Demo Warning', RHW:'Radiological Hazard Warning', SVR:'Severe Thunderstorm Warning',
  SVA:'Severe Thunderstorm Watch', SVS:'Severe Weather Statement', SPW:'Shelter in Place Warning', SMW:'Special Marine Warning',
  SPS:'Special Weather Statement', SSA:'Storm Surge Watch', SSW:'Storm Surge Warning', SQW:'Snow Squall Warning', TOR:'Tornado Warning',
  TOA:'Tornado Watch', TRW:'Tropical Storm Warning', TRA:'Tropical Storm Watch', TSW:'Tsunami Warning', TSA:'Tsunami Watch',
  VOW:'Volcano Warning', WSW:'Winter Storm Warning', WSA:'Winter Storm Watch'};
const SAME_LAST={W:'warning', A:'watch', E:'emergency', S:'statement', T:'test', M:'message', R:'message'};
const SAME_STATE={'01':'AL','02':'AK','04':'AZ','05':'AR','06':'CA','08':'CO','09':'CT','10':'DE','11':'DC','12':'FL','13':'GA','15':'HI','16':'ID','17':'IL','18':'IN',
  '19':'IA','20':'KS','21':'KY','22':'LA','23':'ME','24':'MD','25':'MA','26':'MI','27':'MN','28':'MS','29':'MO','30':'MT','31':'NE','32':'NV','33':'NH','34':'NJ',
  '35':'NM','36':'NY','37':'NC','38':'ND','39':'OH','40':'OK','41':'OR','42':'PA','44':'RI','45':'SC','46':'SD','47':'TN','48':'TX','49':'UT','50':'VT','51':'VA',
  '53':'WA','54':'WV','55':'WI','56':'WY','60':'AS','66':'GU','69':'MP','72':'PR','78':'VI'};

// «ZCZC-ORG-EEE-PSSCCC…+TTTT-JJJHHMM-LLLLLLLL-» → поля; null — не заголовок
function sameParse(s){
  const m=/^ZCZC-([A-Z]{3})-([A-Z0-9]{3})-((?:\d{6}-){0,30}\d{6})\+(\d{4})-(\d{3})(\d{2})(\d{2})-(.{8})-$/.exec(s);
  if(!m) return null;
  const loc=m[3].split('-'), ev=m[2];
  const r={kind:'header', org:m[1], orgName:SAME_ORG[m[1]]||'', event:ev, eventName:SAME_EVENT[ev] || (SAME_LAST[ev[2]] ? ev+' '+SAME_LAST[ev[2]] : ev),
    locations:loc, purge:+m[4].slice(0,2)*60+ +m[4].slice(2), jday:+m[5], hour:+m[6], min:+m[7], callsign:m[8].replace(/\//g,'-').trim()};
  r.states=[...new Set(loc.map(l=>SAME_STATE[l.slice(1,3)]).filter(Boolean))];
  r.ok=r.hour<24 && r.min<60 && r.jday>=1 && r.jday<=366 && +m[4].slice(2)<60;
  return r;
}
const sameBytes=s=>{ const b=[]; for(const ch of s){ const c=ch.charCodeAt(0)&0x7F; for(let k=0;k<8;k++) b.push((c>>k)&1); } return b; };
const samePat=bits=>{ let v=0; for(let i=0;i<32;i++) v=((v<<1)|bits[i])>>>0; return v; };     // первый бит — старший
const SAME_VZ=samePat(sameBytes('ZCZC')), SAME_VN=samePat(sameBytes('NNNN'));
// строка → биты в эфире: преамбула 16×0xAB и сообщение
function sameBurstBits(str){
  const b=[]; for(let i=0;i<16;i++) for(let k=0;k<8;k++) b.push((0xAB>>k)&1);
  return b.concat(sameBytes(str));
}
// «ZCZC-…-» из полей (для генератора)
function sameBuild(org,ev,locs,purgeHHMM,jday,hh,mm,call){
  return 'ZCZC-'+org+'-'+ev+'-'+locs.join('-')+'+'+purgeHHMM+'-'+String(jday).padStart(3,'0')+String(hh).padStart(2,'0')+String(mm).padStart(2,'0')+'-'+
    String(call).replace(/-/g,'/').padEnd(8).slice(0,8)+'-';
}

def({ id:'sameRx', title:'SAME / EAS Decoder', cat:'Decoders', readout:true, tall:true, resize:true, w:460,
  kw:'same eas noaa weather radio alert tornado warning nwr',
  ins:[{n:'in',t:'sig'}], outs:[{n:'rec',t:'rec'},{n:'text',t:'txt'},{n:'new',t:'num'}],
  params:[{n:'wait',t:'range',min:2,max:10,step:.5,d:4,label:'close a message after this silence, s (the 3 repeats are voted)'}],
  init:n=>{ n.key=''; n.msgs=0; n.recent=[]; n.last=''; n.samp=0; n.x=new Float32Array(0); n.xb=0; n.tNext=0; n.jj=0; n.ph=[]; n.cand=[]; n.group=null; n.bursts=0; n.lvl=0; },
  process(n,I){
    const sr=Eng.sr, sps=sr/SAME_BAUD;
    if(n.key!==String(sr)){
      n.key=String(sr); n.x=new Float32Array(0); n.xb=n.samp; n.tNext=n.samp; n.jj=0;
      n.ph=[]; for(let i=0;i<SAME_PH;i++) n.ph.push({reg:0, mode:0, str:'', cnt:0, cur:0});
    }
    const x=I.in, recs=[], texts=[];
    if(x){ let e=0; for(let i=0;i<BLOCK;i++) e+=x[i]*x[i]; n.lvl=n.lvl*.9+Math.sqrt(e/BLOCK)*.1; }
    const nx=new Float32Array(n.x.length+BLOCK); nx.set(n.x); if(x) nx.set(x.subarray(0,BLOCK),n.x.length); n.x=nx;
    n.samp+=BLOCK;
    const xs=n.x, N=xs.length, step=sps/SAME_PH;
    // суммы произведений с квадратурами обоих тонов (фаза — по абсолютному номеру отсчёта)
    const P=[new Float64Array(N+1),new Float64Array(N+1),new Float64Array(N+1),new Float64Array(N+1)], fr=[SAME_MARK/sr,SAME_SPACE/sr];
    for(let i=0;i<N;i++){
      const ab=n.xb+i, v=xs[i];
      for(let t=0;t<2;t++){
        const ph=2*Math.PI*((ab*fr[t])%1);
        P[2*t][i+1]=P[2*t][i]+v*Math.cos(ph); P[2*t+1][i+1]=P[2*t+1][i]+v*Math.sin(ph);
      }
    }
    let tj=n.tNext-n.xb; if(tj<0) tj=0;
    while(tj+sps<N-1){
      const a0=Math.floor(tj), a1=Math.floor(tj+sps), g=[];
      for(let q=0;q<4;q++){
        const p=P[q], va=p[a0]+(tj-a0)*(p[a0+1]-p[a0]), vb=p[a1]+(tj+sps-a1)*(p[a1+1]-p[a1]);
        g.push(vb-va);
      }
      const bit=(g[0]*g[0]+g[1]*g[1])>(g[2]*g[2]+g[3]*g[3]) ? 1 : 0;
      sameFeed(n,n.ph[n.jj%SAME_PH],bit,(n.xb+tj+sps)/sr);
      n.jj++; tj+=step;
    }
    n.tNext=n.xb+tj;
    const keep=Math.max(0,Math.floor(tj)-2);
    if(keep>0){ n.x=xs.slice(keep); n.xb+=keep; }
    sameFlush(n,n.samp/sr,recs,texts);
    return {rec:recs.length ? recs : null, text:texts.length ? texts.join('\n') : null, new:recs.length ? 1 : 0};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const t=n.msgs+' messages · '+n.bursts+' bursts · input '+(n.lvl>1e-4 ? (20*Math.log10(n.lvl)).toFixed(0)+' dBFS' : '—')+(n.last ? '\n'+n.last : '')+(n.recent.length ? '\n'+n.recent.slice(-8).join('\n') : '\nwaiting for ZCZC');
    if(r.textContent!==t) r.textContent=t; }
});

// один бит одной фазы: поиск «ZCZC» / «NNNN» (до 2 ошибок), затем символы до конца заголовка
function sameFeed(n,d,bit,te){
  d.reg=((d.reg<<1)|bit)>>>0;
  if(d.mode===0){
    if(popcnt32((d.reg^SAME_VZ)>>>0)<=2){ d.mode=1; d.str='ZCZC'; d.cnt=0; d.cur=0; }
    else if(popcnt32((d.reg^SAME_VN)>>>0)<=2){ sameCand(n,te,'NNNN'); }
    return;
  }
  d.cur|=bit<<d.cnt;
  if(++d.cnt<8) return;
  const c=d.cur; d.cnt=0; d.cur=0;
  if(c<0x20 || c>0x7E){ d.mode=0; return; }
  d.str+=String.fromCharCode(c);
  if(d.str.length>SAME_MAXLEN){ d.mode=0; return; }
  if(/\+\d{4}-\d{7}-[\s\S]{8}-$/.test(d.str)){ sameCand(n,te,d.str); d.mode=0; }
}
// кандидаты одной передачи от разных фаз (во времени ближе 0.5 с) голосуют за строку
function sameCand(n,te,str){
  let c=n.cand.find(c=>Math.abs(c.t-te)<0.5);
  if(!c){ c={t:te, last:te, m:new Map()}; n.cand.push(c); }
  c.m.set(str,(c.m.get(str)||0)+1); c.last=Math.max(c.last,te);
}
// по символам среди строк модальной длины
function sameVote(list){
  const len=new Map(); for(const s of list) len.set(s.length,(len.get(s.length)||0)+1);
  let L=0, best=0; for(const [k,v] of len) if(v>best || (v===best && k>L)){ best=v; L=k; }
  const same=list.filter(s=>s.length===L);
  let out='';
  for(let i=0;i<L;i++){
    const m=new Map(); for(const s of same) m.set(s[i],(m.get(s[i])||0)+1);
    let ch='', cb=0; for(const [k,v] of m) if(v>cb){ cb=v; ch=k; }
    out+=ch;
  }
  return {s:out, agree:same.filter(s=>s===out).length};
}
function sameFlush(n,now,recs,texts){
  for(let i=n.cand.length-1;i>=0;i--){
    const c=n.cand[i];
    if(now-c.last<0.6) continue;
    n.cand.splice(i,1);
    let s='', cb=0; for(const [k,v] of c.m) if(v>cb){ cb=v; s=k; }
    n.bursts++;
    if(n.group && c.t-n.group.last>+n.p.wait) sameClose(n,recs,texts);
    if(!n.group) n.group={last:c.t, list:[]};
    n.group.list.push(s); n.group.last=c.t;
  }
  if(n.group && (n.group.list.length>=3 || now-n.group.last>+n.p.wait)) sameClose(n,recs,texts);
}
function sameClose(n,recs,texts){
  const g=n.group; n.group=null;
  if(!g || !g.list.length) return;
  const v=sameVote(g.list), s=v.s;
  const rec={t:Date.now(), src:'SAME', id:'SAME', raw:s, repeats:g.list.length, agree:v.agree};
  let line;
  if(s==='NNNN'){ rec.kind='eom'; rec.text='end of message'; line='NNNN end of message'; }
  else {
    const f=sameParse(s);
    if(f && f.ok){
      Object.assign(rec,{kind:'header', org:f.org, orgName:f.orgName, event:f.event, eventName:f.eventName, locations:f.locations.join(' '), states:f.states.join(' '),
        areas:f.locations.length, purge:f.purge, jday:f.jday, hour:f.hour, min:f.min, callsign:f.callsign, id:f.callsign||f.org});
      line=f.eventName+' ('+f.event+') · '+f.orgName+' · '+f.locations.length+' area'+(f.locations.length>1 ? 's' : '')+(f.states.length ? ' '+f.states.join(' ') : '')+
        ' · valid '+f.purge+' min · day '+f.jday+' '+String(f.hour).padStart(2,'0')+':'+String(f.min).padStart(2,'0')+' UTC · '+f.callsign;
      rec.text=line;
    } else { rec.kind='raw'; rec.text=s; line='unparsed: '+s; }
  }
  n.msgs++; n.last=line; n.recent.push(line+'  ['+v.agree+'/'+g.list.length+']'); if(n.recent.length>20) n.recent.shift();
  recs.push(rec); texts.push(line);
}

/* ---- Тестовый сигнал: заголовок и «NNNN» тремя повторами, AFSK ---- */
// Только для проверки декодера по кабелю / на звуковой карте: не излучать в эфир и не подавать на системы оповещения.
function sameTxQueue(n){
  const loc=String(n.p.loc).split(/[\s,;-]+/).filter(x=>/^\d{6}$/.test(x)).slice(0,31);
  if(!loc.length){ n.status='locations: six-digit PSSCCC codes, e.g. 048453'; return; }
  const d=new Date(), jday=Math.floor((Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate())-Date.UTC(d.getUTCFullYear(),0,1))/86400000)+1;
  const hdr=sameBuild(n.p.org,String(n.p.event).toUpperCase().slice(0,3).padEnd(3,'X'),loc,String(n.p.purge).replace(/\D/g,'').padStart(4,'0').slice(-4),jday,d.getUTCHours(),d.getUTCMinutes(),n.p.call);
  const bits=[];
  const burst=str=>{ bits.push(...sameBurstBits(str)); };
  for(let i=0;i<3;i++){ burst(hdr); bits.push('gap'); }
  if(n.p.eom){ bits.push('gap'); for(let i=0;i<3;i++){ burst('NNNN'); bits.push('gap'); } }
  n.tq={bits, i:0, pos:0};
  n.status='sending '+hdr.slice(0,50);
}
def({ id:'sameTx', title:'SAME: Test Signal', cat:'Protocols', readout:true,
  ins:[{n:'go',t:'num'}], outs:[{n:'out',t:'sig'},{n:'busy',t:'num'}],
  params:[{n:'org',t:'select',opts:['WXR','EAS','CIV','PEP'],d:'WXR',label:'originator'},
          {n:'event',t:'text',d:'RWT',label:'event code (RWT = Required Weekly Test)'},
          {n:'loc',t:'text',d:'048453',label:'locations PSSCCC (state FIPS 48 = TX, county 453), up to 31 separated by space'},
          {n:'purge',t:'text',d:'0030',label:'valid for, hhmm'},
          {n:'call',t:'text',d:'KTEST/NW',label:'station (8 characters, / instead of -)'},
          {n:'eom',t:'check',d:true,label:'end of message (NNNN ×3) after the header'},
          {n:'amp',t:'range',min:0,max:1,step:.01,d:.4},
          {n:'send',t:'button',label:'Send (decoder test only)',fn:n=>sameTxQueue(n)}],
  init:n=>{ n.tq=null; n.prevGo=0; n.ph=0; n.status='waiting'; },
  process(n,I){
    const sr=Eng.sr, o=buf(n,'out'), go=I.go||0;
    if(go>.5 && n.prevGo<=.5) sameTxQueue(n);
    n.prevGo=go;
    let q=n.tq, busy=0;
    for(let i=0;i<BLOCK;i++){
      let v=0;
      if(q){
        busy=1;
        const it=q.bits[q.i];
        if(it==='gap'){ if(++q.pos>=sr){ q.i++; q.pos=0; } }
        else {
          const bit=it;
          n.ph+=2*Math.PI*(bit ? SAME_MARK : SAME_SPACE)/sr; v=Math.sin(n.ph)*n.p.amp;
          q.pos+=SAME_BAUD/sr; if(q.pos>=1){ q.pos-=1; q.i++; }
        }
        if(q.i>=q.bits.length){ n.tq=q=null; n.status='sent'; }
      }
      o[i]=v;
    }
    n.ph%=2*Math.PI;
    return {out:o, busy};
  },
  draw(n){ n.el.querySelector('.readout').textContent=n.status; }});
