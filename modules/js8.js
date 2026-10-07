"use strict";
/* JS8Call (Normal, 15 с): узлы приёма слотов и передачи. Кодек и поиск сигналов — в js8-kernels.js.
   Время и тоны те же, что у FT8 (символ 0.16 с, шаг 6.25 Гц), поэтому SNR и спектрограмма берутся от ft8Noise/ft8Snr. */

// словарь JSC для сжатого текста (data/js8-jsc.txt, ~2 МБ) — один раз, при первой необходимости
const JS8Dict={state:'idle', err:'', p:null};
function js8DictLoad(){
  if(JS8_JSC.words) return Promise.resolve();
  if(JS8Dict.p) return JS8Dict.p;
  JS8Dict.state='loading';
  return JS8Dict.p=fetch('data/js8-jsc.txt').then(r=>{ if(!r.ok) throw new Error('HTTP '+r.status); return r.text(); })
    .then(t=>{ js8JscSet(t); JS8Dict.state='ready'; })
    .catch(e=>{ JS8Dict.state='error'; JS8Dict.err=e.message; JS8Dict.p=null; });
}

function js8Text(n){
  const head=(n.warn?'⚠ '+n.warn+'\n':'')+'slots in log: '+n.log.length+
    ' · Normal mode: 12.64 s from slot start +0.5 s\n'+
    (JS8Dict.state==='loading' ? 'loading the text dictionary…\n' : JS8Dict.state==='error' ? 'text dictionary: '+JS8Dict.err+'\n' : '')+
    'sync below 17/21 usually does not decode\n';
  n.text=head+n.log.map(e=>{
    const lines=[e.stamp+'  '+(e.n?e.n+' sig.':'empty')+'  (parsed in '+e.ms+' ms)'];
    for(const c of e.list){
      const t0=0.5+c.dt;
      lines.push('   '+c.f.toFixed(1).padStart(7)+' Hz  start +'+t0.toFixed(2)+
        ' s  end +'+(t0+JS8_TX_SEC).toFixed(2)+' s  strength '+c.sc.toFixed(2)+'  sync '+c.sync+'/21');
      if(c.b72){
        const i=js8Unpack(c.b72,c.i3);                // заново: словарь мог подгрузиться уже после приёма
        lines.push('     ► '+i.text+(c.snr!=null?'   '+(c.snr>0?'+':'')+c.snr+' dB':'')+
          '   ['+i.kind+(c.i3&1?' first':'')+(c.i3&2?' last':'')+']'); }
      if(c.syms) lines.push('     tones  '+c.syms); }
    return lines.join('\n');
  }).join('\n');
}
function js8Save(n){
  const txt=n.log.map(e=>e.stamp+'\t'+e.list.map(c=>
    c.f.toFixed(1)+' Hz\tdt '+c.dt.toFixed(2)+'\tstrength '+c.sc.toFixed(2)+'\tsync '+c.sync+'/21\t'+
    (c.b72 ? js8Unpack(c.b72,c.i3).text : '')+(c.syms?'\t'+c.syms:'')).join('\n\t')).join('\n');
  dl(new Blob([txt],{type:'text/plain'}),'js8-log-'+Date.now()+'.txt');
}
// записи по расшифрованным кадрам: позывной, корреспондент, локатор (или ранее слышанный), SNR
function js8Recs(n,list,S,b0,b1,slotMs){
  const dec=list.filter(e=>e.b72);
  if(!dec.length) return;
  const noise=ft8Noise(S.mag,S.frames,S.bins,b0,b1), msgs=[];
  for(const e of dec){
    const i=js8Unpack(e.b72,e.i3);
    e.snr=ft8Snr(e,S.mag,S.frames,S.bins,noise);
    msgs.push(i.text);
    const r={t:slotMs, src:'JS8', kind:i.kind, msg:i.text, f:+e.f.toFixed(1), dt:+e.dt.toFixed(2)};
    if(e.snr!=null) r.snr=e.snr;
    if(i.from){
      if(i.grid){ n.grids.set(i.from,i.grid); if(n.grids.size>5000) n.grids.delete(n.grids.keys().next().value); }
      const grid=i.grid || n.grids.get(i.from);
      Object.assign(r,{id:i.from, call:i.from, label:i.from, from:i.from});
      if(grid){ r.grid=grid; if(typeof ft8GeoFill==='function') ft8GeoFill(r,grid); } }
    if(i.to) r.to=i.to;
    if(i.cmd) r.cmd=i.cmd.trim();
    if(i.kind==='CQ') r.cq=1;
    n.recQ.push(r);
  }
  if(n.recQ.length>2000) n.recQ.splice(0,n.recQ.length-2000);
  n.msgOut=msgs.join('\n');
}
function js8Run(n,manual,slotMs){
  const t0=performance.now(), S=js8Spec(n.buf,n.wp), hz=JS8_SR/JS8_FFT;
  const b0=Math.max(1,Math.floor(n.p.fmin/hz)), b1=Math.min(S.bins-9*JS8_TS,Math.ceil(n.p.fmax/hz));
  const list=js8Decode(S,{fmin:n.p.fmin,fmax:n.p.fmax,top:n.p.top,thr:n.p.thr,budget:n.p.budget||800,costas:0,decode:n.p.decode});
  if(!list){ n.text='not enough data'; return; }
  if(!n.p.tones) for(const e of list) delete e.syms;
  const ms=slotMs!=null ? slotMs : Date.now();
  js8Recs(n,list,S,b0,b1,ms);
  if(list.length){ n.f=list[0].f; n.sc=list[0].sc; n.dt=list[0].dt; }
  else { n.f=0; n.sc=0; }
  n.warn=Eng.turbo>1 ? 'speed ×'+Eng.turbo+' breaks slot alignment — set it back to ×1' : '';
  n.log.unshift({stamp:ft8Stamp(ms)+(manual?' (manual)':''), n:list.length, list, ms:(performance.now()-t0).toFixed(0)});
  while(n.log.length>n.p.keep) n.log.pop();
  js8Text(n);
}

def({ id:'js8Rx', title:'JS8Call: Receive Slots', cat:'Decoders',
  ins:[{n:'in',t:'sig'},{n:'fmin',t:'num'},{n:'fmax',t:'num'},{n:'top',t:'num'},{n:'thr',t:'num'},
       {n:'keep',t:'num'},{n:'tones',t:'num'},{n:'decode',t:'num'},{n:'budget',t:'num'}],
  outs:[{n:'f',t:'num'},{n:'score',t:'num'},{n:'dt',t:'num'},{n:'busy',t:'num'},
        {n:'msg',t:'txt'},{n:'rec',t:'rec'}],        // rec — по записи на кадр: позывной, корреспондент, локатор, SNR
  readout:true, tall:true,
  params:[{n:'fmin',t:'range',min:100,max:3000,step:6.25,d:200},
          {n:'fmax',t:'range',min:200,max:3200,step:6.25,d:2800},
          {n:'top',t:'range',min:1,max:30,step:1,d:8},
          {n:'thr',t:'range',min:1,max:8,step:.1,d:1.6},
          {n:'keep',t:'range',min:1,max:60,step:1,d:12},
          {n:'tones',t:'check',d:false,label:'show tones'},
          {n:'decode',t:'check',d:true,label:'decode (LDPC)'},
          {n:'dict',t:'check',d:true,label:'text dictionary (JSC, ~1 MB download)'},
          {n:'now',t:'button',label:'Parse now',fn:n=>js8Run(n,true)},
          {n:'wav',t:'button',label:'Save slot to WAV',fn:n=>{
            const L=n.buf.length, o=new Float32Array(L);
            for(let i=0;i<L;i++) o[i]=n.buf[(n.wp+i)%L];
            wavDownload([o],JS8_SR,'js8-'+recStamp()+'.wav'); }},
          {n:'budget',t:'range',min:100,max:3000,step:50,d:800,label:'parse budget, ms'},
          {n:'save',t:'button',label:'Save log',fn:n=>js8Save(n)},
          {n:'clr',t:'button',label:'Clear log',fn:n=>{n.log=[];js8Text(n);}}],
  init:n=>{ n.buf=new Float32Array(JS8_SR*15); n.wp=0;
            n.slot=-1; n.log=[]; n.text='waiting for slot boundary…'; n.f=0; n.sc=0; n.dt=0; n.busy=0;
            n.recQ=[]; n.msgOut=''; n.grids=new Map(); n.dictAsked=false; n.rs=null; n.rsSr=0; n.o1=new Float32Array(8); },
  process(n,I){
    for(const k of ['fmin','fmax','top','thr','keep','budget']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    for(const k of ['tones','decode']) if(typeof I[k]==='number') setMod(n,k,I[k]>=0.5);
    if(!n.dictAsked && n.p.dict){ n.dictAsked=true; js8DictLoad().then(()=>{ if(n.log.length) js8Text(n); }); }
    if(!n.rs || n.rsSr!==Eng.sr){ n.rs=js8Resampler(Eng.sr,JS8_SR); n.rsSr=Eng.sr; }
    let got=0;
    for(let i=0;i<BLOCK;i++){                       // sinc-передискретизация в 6400 Гц (усреднение давало призраки ±700 Гц)
      const k=n.rs.push(I.in?I.in[i]:0,n.o1);
      for(let q=0;q<k;q++){ n.buf[n.wp]=n.o1[q]; n.wp=(n.wp+1)%n.buf.length; }
      got+=k; }
    const now=Date.now(), slot=Math.floor(now/15000);   // границы слотов кратны 15 с UTC
    if(n.slot<0){ n.slot=slot; n.filled=0; }
    else if(slot!==n.slot){ n.slot=slot;
      if(n.filled>=JS8_SR*14) js8Run(n,false,(slot-1)*15000);
      n.filled=0; }
    n.filled=(n.filled||0)+got;
    n.busy=clamp(n.filled/(JS8_SR*15),0,1);
    const rec=n.recQ.length ? n.recQ.splice(0) : null;
    return {f:n.f, score:n.sc, dt:n.dt, busy:n.busy, msg:n.msgOut, rec}; },
  draw(n){ const r=n.el.querySelector('.readout');
    if(r.textContent!==n.text){ const atTop=r.scrollTop<8;
      r.textContent=n.text; if(atTop) r.scrollTop=0; } }});

def({ id:'js8Tx', title:'JS8Call: Transmit', cat:'Protocols',
  ins:[{n:'text',t:'txt'},{n:'freq',t:'num'}], outs:[{n:'out',t:'sig'}], readout:true,
  params:[{n:'text',t:'text',d:'HB'},
          {n:'mycall',t:'text',d:'K1ABC',label:'my callsign'},
          {n:'mygrid',t:'text',d:'FN42',label:'my locator (for HB / CQ)'},
          {n:'freq',t:'range',min:200,max:3000,step:1,d:1500,label:'tone 0 frequency, Hz'},
          {n:'slots',t:'select',opts:['every','even','odd'],d:'every',label:'15 s slots (UTC) to transmit in'},
          {n:'loop',t:'check',d:true,label:'repeat the message'},
          {n:'send',t:'button',label:'Send again',fn:n=>{ n.fi=0; n.pend=true; }},
          {n:'lvl',t:'range',min:.05,max:1,step:.05,d:.5,label:'level'}],
  init:n=>{ n.slot=-1; n.t=-99; n.ph=0; n.key=null; n.plan=null; n.fi=0; n.pend=true; n.cur=null; n.text=''; },
  process(n,I){
    if(typeof I.freq==='number') setMod(n,'freq',I.freq);
    const o=buf(n,'out'), sr=Eng.sr, txt=(typeof I.text==='string'&&I.text) ? I.text : n.p.text;
    const key=txt+'|'+n.p.mycall+'|'+n.p.mygrid+'|'+(JS8_JSC.words?1:0);
    if(n.key!==key){
      n.key=key; n.fi=0; n.pend=true; n.cur=null;
      n.plan=js8Plan(txt,n.p.mycall,n.p.mygrid);
      if(!JS8_JSC.words && (n.plan.err || n.plan.frames.some(f=>f[0]===1))) js8DictLoad(); }
    const now=Date.now(), slot=Math.floor(now/15000);
    if(slot!==n.slot){
      n.slot=slot; n.t=(now-slot*15000)/1000-JS8_TX_DELAY; n.cur=null;
      const on=n.plan && n.plan.frames && (n.p.slots==='every' || (slot%2===0)===(n.p.slots==='even'));
      if(on && n.pend){
        const F=n.plan.frames, last=F.length-1, i3=(n.fi===0?1:0)|(n.fi===last?2:0);
        n.cur={tones:js8Tones(F[n.fi],i3,0), idx:n.fi+1, total:F.length, text:js8Unpack(F[n.fi],i3).text};
        n.fi++;
        if(n.fi>last){ n.fi=0; if(!n.p.loop) n.pend=false; } } }
    const cur=n.cur, f0=n.p.freq, a=n.p.lvl;
    for(let i=0;i<BLOCK;i++,n.t+=1/sr){
      if(!cur || n.t<0 || n.t>=JS8_TX_SEC){ o[i]=0; continue; }
      n.ph+=2*Math.PI*(f0+6.25*js8Freq(cur.tones,n.t/JS8_SYM_SEC))/sr;
      o[i]=a*Math.sin(n.ph); }
    n.ph%=2*Math.PI;
    return {out:o}; },
  draw(n){ const r=n.el.querySelector('.readout'), c=n.cur;
    const t=!n.plan ? '' : n.plan.err ? 'cannot pack: '+n.plan.err
      : (n.plan.frames.length+' frame'+(n.plan.frames.length>1?'s':'')+' · ')+
        (c ? c.text+' · frame '+c.idx+'/'+c.total+(n.t>=0&&n.t<JS8_TX_SEC ? ' · sending '+n.t.toFixed(1)+' s' : ' · waiting for the slot')
             : n.pend ? 'waiting for the slot' : 'sent');
    if(r && r.textContent!==t) r.textContent=t; }});
