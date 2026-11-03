"use strict";
/* ============================ Echo Ranger ============================
   Расстояние до стены звуком телефона. Модуль играет чирп (выход chirp → Sound Card), слушает микрофон (вход mic ← Microphone) и по эху считает расстояния
   до отражателей: самый сильный пик корреляции — прямой звук динамик → микрофон (в нём вся задержка аудиотракта, она сокращается), следующие — стены, мебель.
   Несколько чирпов усредняются. dist + go → Measure Entry → Site Plan. Без железа: «simulate» подставляет вместо микрофона расчётную комнату.
   Ядро — echorange-kernels.js (тест tools/test-echorange.mjs). */

function erStart(n){
  n.todo=Math.max(1,Math.round(+n.p.bursts)); n.done=0; n.envs=[]; n.state='wait'; n.wait=0; n.go=0; n.msg='measuring… keep the phone still, pointed at the wall';
  redraw(n);
}
function erStop(n){ n.todo=0; n.state='idle'; n.tx=null; n.rec=null; n.msg='stopped'; redraw(n); }

// результат по накопленным огибающим
function erResult(n,cfg){
  const L=cfg.L, mean=new Float32Array(L), N=n.envs.length;
  for(const e of n.envs) for(let i=0;i<L;i++) mean[i]+=e[i]/N;
  const peaks=erPeaks(mean,{sr:cfg.sr,c:cfg.c,minDist:+n.p.minDist,thrDb:+n.p.thrDb,bw:Math.abs(+n.p.f1-+n.p.f0)});
  const pk=erPick(peaks,n.p.pick), tail=Array.from(mean.subarray(Math.round(.01*cfg.sr))).sort((a,b)=>a-b), med=tail[tail.length>>1]||1e-12;
  n.view={mean,peaks,pick:pk,rmax:+n.p.rmax,sr:cfg.sr,c:cfg.c,snr:20*Math.log10((mean[0]||1e-12)/med)};
  n.dist=pk ? pk.dist : null; n.db=pk ? pk.db : null;
  n.snr=n.view.snr;
  n.msg=n.snr<12 ? 'no clear direct sound (signal to noise '+n.snr.toFixed(0)+' dB): turn the volume up, check the speaker and the microphone (not headphones; echo cancellation / noise suppression off in Microphone)'
    : pk ? 'nearest reflector '+pk.dist.toFixed(2)+' m ('+pk.db.toFixed(0)+' dB below the direct sound), '+peaks.length+' echo'+(peaks.length===1 ? '' : 'es')+', '+N+' chirp'+(N===1 ? '' : 's') : 'no echo above the threshold: closer than '+(+n.p.minDist)+' m, further than '+(+n.p.rmax)+' m, too soft (lower «threshold» or turn the volume up)';
  n.recOut=peaks.map((p,i)=>({id:'echo:'+i,t:new Date().toISOString(),kind:'echo',label:p.dist.toFixed(2)+' m',dist_m:+p.dist.toFixed(3),level_db:+p.db.toFixed(1),n:i+1,picked:pk===p ? 1 : 0}));
  redraw(n);
}

def({ id:'echorange', title:'Echo Ranger (chirp)', cat:'Geo', lazy:true, readout:true, view:{h:170}, w:360, resize:true,
  kw:'echo ranger chirp sonar acoustic distance wall room measure ultrasound microphone speaker phone impulse response matched filter pulse compression',
  // mic — микрофон (Microphone); trig — старт измерения по фронту; chirp — сигнал в динамик (→ Sound Card, громкость — amp);
  // dist — расстояние до выбранного отражателя, м; db — его уровень относительно прямого звука; snr — прямой звук к шуму, дБ; go — импульс «готово» (→ Measure Entry go); rec — все эхо записями
  ins:[{n:'mic',t:'sig'},{n:'trig',t:'num'}],
  outs:[{n:'chirp',t:'sig'},{n:'dist',t:'num'},{n:'db',t:'num'},{n:'snr',t:'num'},{n:'go',t:'num'},{n:'rec',t:'rec'}],
  params:[{n:'measure',t:'button',label:'▶ Measure',fn:n=>erStart(n)},
          {n:'stop',t:'button',label:'■ Stop',fn:n=>erStop(n)},
          {n:'f0',t:'range',min:200,max:22000,step:50,d:2000,label:'chirp from, Hz'},
          {n:'f1',t:'range',min:200,max:22000,step:50,d:10000,label:'chirp to, Hz (the band B gives the resolution c/2B: 8 kHz — 2 cm; 16–20 kHz is almost silent but weak on phones)'},
          {n:'dur',t:'range',min:5,max:100,step:1,d:30,label:'chirp length, ms (longer — more energy, the range does not suffer)'},
          {n:'amp',t:'range',min:.02,max:1,step:.01,d:.3,label:'chirp level (the Sound Card volume multiplies it)'},
          {n:'bursts',t:'range',min:1,max:32,step:1,d:6,label:'chirps averaged per measurement'},
          {n:'period',t:'range',min:100,max:2000,step:10,d:500,label:'pause between chirps, ms (at least the recording window)'},
          {n:'rmax',t:'range',min:1,max:30,step:.5,d:8,label:'range, m'},
          {n:'minDist',t:'range',min:.1,max:2,step:.05,d:.3,label:'nearest reflector counted, m (the chirp’s side lobes sit around the direct sound)'},
          {n:'thrDb',t:'range',min:10,max:70,step:1,d:40,label:'threshold: echoes down to … dB below the direct sound'},
          {n:'pick',t:'select',opts:['first','strongest'],d:'first',label:'dist is the nearest echo / the strongest echo'},
          {n:'temp',t:'range',min:-30,max:50,step:1,d:20,label:'air temperature, °C (the speed of sound: 0.6 m/s per °C ≈ 0.2 %)'},
          {n:'latMs',t:'range',min:50,max:800,step:10,d:250,label:'longest expected audio delay speaker → microphone, ms (phones: 50–300)'},
          {n:'cont',t:'check',d:false,label:'continuous: keep chirping, dist follows the last chirps (a sonar)'},
          {n:'sim',t:'text',d:'',label:'simulate instead of the microphone: «distance:amplitude, …», e.g. 2.5:0.4, 4.1:0.2 (empty — the real microphone)'},
          {n:'simNoise',t:'range',min:0,max:.3,step:.005,d:.02,label:'simulation noise'}],
  init:n=>{ n.state='idle'; n.todo=0; n.done=0; n.envs=[]; n.tx=null; n.txPos=0; n.rec=null; n.recPos=0; n.wait=0; n.dist=null; n.db=null; n.snr=null; n.go=0;
    n.view=null; n.recOut=null; n.msg='press «▶ Measure» (Microphone allowed, Sound Card on) — or «simulate» to try without hardware'; n.lastTrig=0; n.cfgKey=''; },
  dispose:n=>{ n.tx=null; n.rec=null; },
  process(n,I){
    const p=n.p, sr=Eng.sr, c=erSpeed(+p.temp), out=buf(n,'chirp');
    const trig=typeof I.trig==='number' && isFinite(I.trig) ? I.trig : 0;
    if(trig>0 && n.lastTrig<=0) erStart(n);
    n.lastTrig=trig;
    const dur=+p.dur/1000, key=[sr,p.f0,p.f1,p.dur,p.amp,p.rmax,p.latMs].join('|');
    if(n.cfgKey!==key){ n.cfgKey=key; n.burst=erChirp(sr,+p.f0,+p.f1,dur).map(v=>v*(+p.amp)); n.chirp0=erChirp(sr,+p.f0,+p.f1,dur);
      n.L=Math.ceil((2*(+p.rmax)/343+.012)*sr); n.win=Math.round(((+p.latMs)/1000+2*(+p.rmax)/343+dur+.03)*sr); }
    out.fill(0); let go=0;
    if(n.todo>0 || p.cont && n.state!=='idle'){
      if(n.state==='wait'){ n.wait-=BLOCK/sr*1000; if(n.wait<=0){ n.state='rec'; n.tx=n.burst; n.txPos=0; n.rec=new Float32Array(n.win); n.recPos=0; } }
      if(n.state==='rec'){
        if(n.tx){ const m=Math.min(BLOCK,n.tx.length-n.txPos); for(let i=0;i<m;i++) out[i]=n.tx[n.txPos+i]; n.txPos+=m; if(n.txPos>=n.tx.length) n.tx=null; }
        const sim=String(p.sim||'').trim()!=='', mic=I.mic;
        if(!sim){ if(mic){ const m=Math.min(BLOCK,n.win-n.recPos); n.rec.set(mic.subarray(0,m),n.recPos); n.recPos+=m; } else { n.recPos+=BLOCK; n.noMic=true; } }
        else n.recPos+=BLOCK;
        if(n.recPos>=n.win){                                                            // окно записано — разбор
          let rec=n.rec;
          if(sim) rec=erSimulate(n.chirp0.map(v=>v*(+p.amp)),sr,c,n.win,Math.round(Math.min(.12,(+p.latMs)/1000*.5)*sr),erParseSim(p.sim),+p.simNoise,n.done+1);
          else if(n.noMic){ n.msg='no microphone signal: wire Microphone (a) to «mic» and allow it'; n.noMic=false; n.state='idle'; n.todo=0; n.rec=null; redraw(n); return {chirp:out,dist:n.dist,db:n.db,snr:n.snr,go:0,rec:null}; }
          const env=erEnvelope(rec,n.chirp0), al=erAlign(env,n.L,0);
          n.envs.push(al.env); const keep=Math.max(1,Math.round(+p.bursts)); while(n.envs.length>keep) n.envs.shift();
          n.done++; n.rec=null; n.state='wait'; n.wait=Math.max(0,+p.period-n.win/sr*1000);
          erResult(n,{sr,c,L:n.L});
          if(!p.cont){ n.todo--; if(n.todo<=0){ n.state='idle'; go=1; n.go=1; if(n.recOut) n.pendingRec=n.recOut; } else n.msg='chirp '+n.done+' of '+(n.done+n.todo)+': '+(n.dist!=null ? n.dist.toFixed(2)+' m' : '—'); }
          else if(n.dist!=null) go=0;
          redraw(n);
        }
      }
    } else if(p.cont && n.state==='idle'){ /* ждём ▶ */ }
    const rec=n.pendingRec; n.pendingRec=null;
    return {chirp:out, dist:n.dist, db:n.db, snr:n.snr, go, rec:rec||null};
  },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, V=n.view, L=[], fg=themeColor('--scr-txt')||'#9fb0b6', pad=24;
    cx.fillStyle=themeColor('--screen')||'#0a0d0e'; cx.fillRect(0,0,W,H);
    cx.font='10px monospace'; cx.textBaseline='alphabetic';
    const X0=pad+8, X1=W-10, Y0=8, Y1=H-pad, rmax=+n.p.rmax, xa=d=>X0+Math.min(1,d/rmax)*(X1-X0), ya=db=>Y0+(Math.min(0,Math.max(-70,db))/-70)*(Y1-Y0);
    cx.strokeStyle='rgba(150,170,180,.25)'; cx.fillStyle=fg; cx.lineWidth=1; cx.textAlign='center';
    for(let d=0;d<=rmax+1e-9;d+=rmax>12 ? 5 : rmax>5 ? 2 : 1){ const x=xa(d); cx.beginPath(); cx.moveTo(x,Y0); cx.lineTo(x,Y1); cx.stroke(); cx.fillText(d+' m',x,H-8); }
    cx.textAlign='right'; for(let db=0;db>=-60;db-=20){ const y=ya(db); cx.beginPath(); cx.moveTo(X0,y); cx.lineTo(X1,y); cx.stroke(); cx.fillText(db+'',X0-3,y+3); }
    if(V){
      const sr=V.sr, c=V.c, m=V.mean, d0=m[0]||1e-12; cx.strokeStyle='#4fc3f7'; cx.lineWidth=1.5; cx.beginPath();
      const N=Math.min(m.length,Math.round(2*rmax/c*sr)), step=Math.max(1,Math.floor(N/Math.max(1,(X1-X0)*2)));
      for(let i=0,first=true;i<N;i+=step){ let mx=0; for(let j=i;j<Math.min(N,i+step);j++) if(m[j]>mx) mx=m[j]; const x=xa(c*i/sr/2), y=ya(20*Math.log10(Math.max(mx,1e-12)/d0)); if(first){ cx.moveTo(x,y); first=false; } else cx.lineTo(x,y); }
      cx.stroke();
      for(const pk of V.peaks){ const x=xa(pk.dist), y=ya(pk.db), picked=pk===V.pick; cx.fillStyle=picked ? '#7dff9a' : '#ffb74d'; cx.beginPath(); cx.arc(x,y,picked ? 5 : 3.5,0,7); cx.fill(); cx.fillStyle=fg; cx.textAlign='center'; cx.fillText(pk.dist.toFixed(2),x,y-8); }
    } else { cx.fillStyle=fg; cx.textAlign='center'; cx.font='11px sans-serif'; cx.fillText('no measurement yet',W/2,H/2); }
    if(n.msg) L.push(n.msg);
    if(V) L.push('echoes: '+(V.peaks.length ? V.peaks.slice(0,6).map(p=>p.dist.toFixed(2)+' m ('+p.db.toFixed(0)+' dB)').join(' · ') : '—')+' · c = '+V.c.toFixed(1)+' m/s · direct sound '+V.snr.toFixed(0)+' dB over the floor');
    n.el.querySelector('.readout').textContent=L.join('\n');
  }});
