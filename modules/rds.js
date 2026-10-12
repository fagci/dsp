"use strict";
/* ============================ RDS DISPLAY ============================
   Показывает всё, что приёмник вытащил из RDS / RBDS: название станции, радиотекст, RT+ (исполнитель, название),
   PI с позывным и страной, тип программы, флаги (TP, TA, музыка/речь, DI), часы станции, частоты AF, приложения
   ODA, соседние сети EON, статистику групп и долю хороших блоков. Вход rec — записи выхода rds узла USB SDR
   (kind 'rds', весь разбор в поле snap). Несколько станций (сканер) — отдельными плашками внизу.
   Вёрстка подстраивается под размер плитки: ширина — @container, высота — data-h на корне. */

const RDS_MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const RDS_KEEP=12;
function rdsClock(ct, utc){
  if(!ct) return '';
  const d=new Date(ct.ts+(utc?0:ct.off*60000)), p=v=>String(v).padStart(2,'0');
  const o=Math.abs(ct.off), z=utc||!ct.off ? 'UTC' : 'UTC'+(ct.off<0?'−':'+')+Math.floor(o/60)+(o%60?':'+p(o%60):'');
  return p(d.getUTCHours())+':'+p(d.getUTCMinutes())+'  '+d.getUTCDate()+' '+RDS_MON[d.getUTCMonth()]+' '+d.getUTCFullYear()+'  '+z;
}
// ---- интерфейс ----
const RDS_HTML=`
<div class="rds-head">
  <div class="rds-ps" data-f="ps"></div>
  <div class="rds-side">
    <div class="rds-pi"><b data-f="pi"></b><span data-f="call"></span></div>
    <div class="rds-sub" data-f="sub"></div>
    <div class="rds-q" title="share of good RDS blocks"><span class="trk"><i data-f="qbar"></i></span><span data-f="qtxt"></span></div>
  </div>
</div>
<div class="rds-flags" data-f="flags"></div>
<div class="rds-body">
  <div class="rds-rt" data-f="rt"></div>
  <div class="rds-np" data-f="np"></div>
  <div class="rds-cards" data-f="cards"></div>
  <div class="rds-wide">
    <div class="rds-sec" data-s="af"><h4>Alternative frequencies</h4><div class="rds-chips" data-f="af"></div></div>
    <div class="rds-sec" data-s="oda"><h4>Applications (ODA)</h4><div class="rds-chips" data-f="oda"></div></div>
    <div class="rds-sec" data-s="eon"><h4>Other networks (EON)</h4><div class="rds-eon" data-f="eon"></div></div>
    <div class="rds-sec" data-s="grp"><h4>Groups received</h4><div class="rds-grp" data-f="grp"></div></div>
  </div>
  <div class="rds-st" data-f="st"></div>
</div>`;
function rdsUiMount(n){
  const root=document.createElement('div'); root.className='rds-ui'; root.innerHTML=RDS_HTML;
  root.addEventListener('pointerdown',e=>e.stopPropagation());
  root.addEventListener('wheel',e=>e.stopPropagation());
  const f={}; for(const e of root.querySelectorAll('[data-f]')) f[e.dataset.f]=e;
  f.st.addEventListener('click',e=>{                        // плашка станции: закрепить / вернуться к «последней»
    const k=e.target.closest('[data-k]')?.dataset.k; if(!k) return;
    n.pin=n.pin===k ? null : k; n.dirty=true; });
  n.mid.append(root);
  n.ui={root, f, ro:new ResizeObserver(()=>{ root.dataset.h=root.clientHeight<135 ? 's' : 'm'; })};
  n.ui.ro.observe(root);
  n.dirty=true; n.key='';
}
const rdsSet=(el,t)=>{ if(el.textContent!==t) el.textContent=t; };
// пересобираем список только когда он изменился
function rdsList(el, key, items, mk){
  if(el._k===key) return; el._k=key; el.textContent='';
  for(const it of items) el.append(mk(it));
}
const rdsEl=(tag,cls,text)=>{ const e=document.createElement(tag); if(cls) e.className=cls; if(text!=null) e.textContent=text; return e; };
const rdsChip=(text,cls,title)=>{ const e=rdsEl('span','rds-chip'+(cls?' '+cls:''),text); if(title) e.title=title; return e; };
function rdsCard(k,v,sub){
  const e=rdsEl('div','rds-card'); e.append(rdsEl('span','rds-k',k), rdsEl('span','rds-v',v));
  if(sub) e.append(rdsEl('span','rds-s',sub)); return e;
}
function rdsRender(n){
  const u=n.ui, f=u.f, cur=rdsCurrent(n), s=cur&&cur.snap;
  const stale=cur && n.p.hold>0 && Date.now()-cur.seen>n.p.hold*1000;
  u.root.classList.toggle('rds-stale',!!stale);
  u.root.classList.toggle('rds-none',!s);
  if(!s){
    rdsSet(f.ps,'········'); rdsSet(f.pi,'----'); rdsSet(f.call,''); rdsSet(f.sub,'no RDS yet'); rdsSet(f.qtxt,''); f.qbar.style.width='0';
    rdsList(f.flags,'',[],()=>null); rdsSet(f.rt,'Wire the “rds” output of a USB SDR (WFM) here.'); rdsSet(f.np,''); rdsList(f.cards,'',[],()=>null);
    rdsList(f.st,'',[],()=>null);
    for(const e of u.root.querySelectorAll('.rds-sec')) e.hidden=true;
    return;
  }
  const call=rdsCallsign(s.pi), cty=rdsCountry(s.pi,s.ecc);
  rdsSet(f.ps,rdsPsView(s)||'········');
  rdsSet(f.pi,rdsHex(s.pi)||'----');
  rdsSet(f.call,call ? ' '+call : '');
  rdsSet(f.sub,[cty, rdsCoverage(s.pi), cur.freq ? (cur.freq/1e6).toFixed(3)+' MHz' : ''].filter(Boolean).join(' · '));
  const ok=Math.round((1-s.bler)*100);
  f.qbar.style.width=ok+'%'; f.qbar.className=ok>=90?'g':ok>=60?'y':'r';
  rdsSet(f.qtxt,s.sync ? ok+'%' : 'lost');
  // флаги: TP / TA / музыка-речь / DI
  const di=s.di, fl=[
    ['TP',s.tp?1:0,'traffic programme'], ['TA',s.ta>0?1:s.ta<0?-1:0,'traffic announcement now'],
    [s.ms<0?'M/S':s.ms?'MUSIC':'SPEECH',s.ms<0?-1:1,'music / speech switch'],
    ['STEREO',di[3]<0?-1:di[3],'DI: stereo'], ['ART.HEAD',di[2]<0?-1:di[2],'DI: artificial head'],
    ['COMPR.',di[1]<0?-1:di[1],'DI: compressed'], ['DYN.PTY',di[0]<0?-1:di[0],'DI: dynamic PTY']];
  rdsList(f.flags, JSON.stringify(fl), fl, ([t,on,ti])=>rdsChip(t,on>0?'on':on<0?'unk':'off',ti));
  rdsSet(f.rt,s.rt||'');
  const art=s.rtp.find(t=>t.ct===4), tit=s.rtp.find(t=>t.ct===1), oth=s.rtp.filter(t=>t.ct!==4&&t.ct!==1);
  rdsSet(f.np,(art||tit) ? '♪ '+[art&&art.text, tit&&tit.text].filter(Boolean).join(' — ')+(oth.length ? '   ·   '+oth.map(t=>(RTP_TYPE[t.ct]||'type '+t.ct)+': '+t.text).join(' · ') : '') : '');
  f.np.hidden=!f.np.textContent;
  // карточки
  const cards=[], pty=rdsPtyName(s);
  cards.push(['Programme type', s.pty+' '+pty, [s.ptyn, call?'RBDS':'RDS'].filter(Boolean).join(' · ')]);
  if(s.ct) cards.push(['Station clock', rdsClock(s.ct,n.p.utc), '']);
  if(s.pin) cards.push(['Programme item', String(s.pin.h).padStart(2,'0')+':'+String(s.pin.m).padStart(2,'0'), 'day '+s.pin.day+' of the month']);
  if(s.ecc||s.lic>=0) cards.push(['Country / language', [s.ecc ? 'ECC '+rdsHex(s.ecc,2) : '', s.lic>=0 ? 'LIC '+rdsHex(s.lic,2) : ''].filter(Boolean).join(' · '), cty||'']);
  cards.push(['Reception', s.groups+' groups', s.blocks+' blocks, '+s.bad+' bad']);
  rdsList(f.cards, JSON.stringify(cards), cards, c=>rdsCard(...c));
  // AF
  const tuned=cur.freq;
  rdsList(f.af, s.af.join()+'|'+tuned, s.af, k=>rdsChip(k>=87500 ? (k/1000).toFixed(1) : k+'k', tuned&&Math.abs(k*1000-tuned)<60000?'on':'', rdsFreqText(k)));
  rdsList(f.oda, JSON.stringify(s.oda), s.oda, o=>rdsChip(RDS_ODA[o.aid]||rdsHex(o.aid), '', 'AID '+rdsHex(o.aid)+', group '+(o.gc>>1)+(o.gc&1?'B':'A')));
  rdsList(f.eon, JSON.stringify(s.eon), s.eon, e=>{
    const r=rdsEl('div','rds-eonrow');
    r.append(rdsEl('b','',e.ps||'········'), rdsEl('span','',rdsHex(e.pi)+(e.pty>=0 ? ' · '+(RDS_PTY[e.pty]||e.pty) : '')+(e.ta>0 ? ' · TA' : '')+(e.af.length ? ' · '+e.af.map(k=>(k/1000).toFixed(1)).join(' ') : '')));
    return r; });
  // группы: 16 номеров, A и B рядом
  const mx=Math.max(1,...s.grp);
  rdsList(f.grp, s.grp.join()+'|'+s.groups, Array.from({length:16},(_,i)=>i), i=>{
    const c=rdsEl('div','rds-gc'), a=s.grp[2*i], b=s.grp[2*i+1];
    const bars=rdsEl('div','rds-gb'), ba=rdsEl('i','a'), bb=rdsEl('i','b');
    ba.style.height=Math.round(a/mx*100)+'%'; bb.style.height=Math.round(b/mx*100)+'%';
    ba.title=i+'A: '+a; bb.title=i+'B: '+b; bars.append(ba,bb);
    c.append(bars, rdsEl('span','',String(i))); c.classList.toggle('z',!a&&!b); return c; });
  const has={af:s.af.length, oda:s.oda.length, eon:s.eon.length, grp:s.groups};
  for(const e of u.root.querySelectorAll('.rds-sec')) e.hidden=!has[e.dataset.s];
  // станции
  const sts=[...n.stations.values()].sort((a,b)=>b.seen-a.seen);
  rdsList(f.st, sts.map(x=>x.key+x.snap.ps+(x===cur)).join('|')+'|'+n.pin, sts.length>1 ? sts : [], x=>{
    const c=rdsChip((x.snap.ps.trim()||'····')+'  '+rdsHex(x.snap.pi), x===cur?'on':'', n.pin===x.key?'pinned — click to release':'show this station');
    c.dataset.k=x.key; return c; });
  n.dirty=false;
}
function rdsCurrent(n){
  if(n.pin && n.stations.has(n.pin)) return n.stations.get(n.pin);
  let best=null; for(const x of n.stations.values()) if(!best || x.seen>best.seen) best=x;
  return best;
}
def({ id:'rds', title:'RDS Display', cat:'Radio', kw:'rds rbds fm radio text radiotext station name ps pi pty traffic tmc rt+ now playing', resize:true, w:380,
  ins:[{n:'rec',t:'rec'}],
  outs:[{n:'ps',t:'txt'},{n:'rt',t:'txt'},{n:'artist',t:'txt'},{n:'title',t:'txt'},{n:'pty',t:'num'},{n:'sync',t:'num'}],
  params:[{n:'hold',t:'range',min:0,max:120,step:1,d:20,label:'dim when silent, s (0 = never)'},
          {n:'utc',t:'check',d:false,label:'clock in UTC'},
          {n:'clear',t:'button',label:'Clear',fn:n=>{ n.stations.clear(); n.pin=null; n.dirty=true; }}],
  init:n=>{ n.stations=new Map(); n.pin=null; n.ui=null; n.dirty=true; n.key=''; },
  process(n,I){
    for(const r of recList(I.rec)){
      if(!r || r.kind!=='rds' || !r.snap) continue;
      const key=String(r.snap.pi>=0 ? r.snap.pi : 'x');
      n.stations.set(key, {key, snap:r.snap, freq:r.freq, seen:Date.now()});
      n.dirty=true;
      if(n.stations.size>RDS_KEEP){ let old=null; for(const x of n.stations.values()) if(!old||x.seen<old.seen) old=x; n.stations.delete(old.key); }
    }
    const cur=rdsCurrent(n), s=cur&&cur.snap;
    const art=s&&s.rtp.find(t=>t.ct===4), tit=s&&s.rtp.find(t=>t.ct===1);
    return {ps:s?s.ps.trim():'', rt:s?s.rt:'', artist:art?art.text:'', title:tit?tit.text:'', pty:s?s.pty:null, sync:s&&s.sync?1:0};
  },
  draw(n){
    if(!n.ui || !n.mid.contains(n.ui.root)) rdsUiMount(n);
    const stale=n.p.hold>0 && rdsCurrent(n) && Date.now()-rdsCurrent(n).seen>n.p.hold*1000;
    if(n.dirty || stale!==n.wasStale){ n.wasStale=stale; rdsRender(n); }
  },
  dispose:n=>{ n.ui?.ro.disconnect(); }
});
