/* Панель энергопрофиля: сколько ядра съедает каждый узел (process + draw), итог, график за минуту, пики и разряд батареи.
   Строка — полоса process / draw; клик — показать узел на холсте; ❄ — заморозить. Узлы на холсте подсвечены по нагрузке.
   Ядро — modules/power-kernels.js (tools/test-power.mjs). */
(()=>{
  const btn=document.getElementById('power'); if(!btn) return;
  const panel=document.createElement('div'); panel.id='powerPanel'; panel.hidden=true;
  panel.innerHTML='<div class="pp-h"><b>Power</b><label title="Do not compute nodes whose result nobody uses (no display, no wire to a used node)"><input type="checkbox" id="ppSkip"> skip unused</label></div>'+
    '<div id="ppTot"></div><canvas id="ppSpark" width="260" height="34"></canvas><div id="ppBat"></div>'+
    '<div class="pp-s"><button data-by="now" class="on">now</button><button data-by="peak">peak</button>'+
    '<label title="Outline modules on the canvas by load"><input type="checkbox" id="ppHeat" checked> heat</label></div><div id="ppList"></div>'+
    '<div class="pp-f">% of one CPU core: <i class="pp-pc"></i>processing <i class="pp-dc"></i>drawing. Click a row — show the module; ❄ — freeze / resume.</div>';
  document.body.append(panel);
  const skip=panel.querySelector('#ppSkip'); skip.checked=Prof.skip;
  skip.onchange=()=>{ Prof.skip=skip.checked; try{ localStorage.setItem('dsp-skip',Prof.skip?'1':'0'); }catch(e){} };
  const tot=panel.querySelector('#ppTot'), bat=panel.querySelector('#ppBat'), list=panel.querySelector('#ppList');
  const spark=panel.querySelector('#ppSpark'), heat=panel.querySelector('#ppHeat');
  let timer=0, b=null, b0=null, by='now', hist=[], peak={}, last=[];
  panel.querySelectorAll('.pp-s button').forEach(x=>x.onclick=()=>{
    by=x.dataset.by; panel.querySelectorAll('.pp-s button').forEach(y=>y.classList.toggle('on',y===x)); render(); });
  heat.onchange=()=>{ if(!heat.checked) for(const n of Graph.nodes) n.el&&n.el.classList.remove('pheat1','pheat2','pheat3'); };
  const key=n=>n.id;
  function reveal(n){                                 // центр холста — на узле, узел выделяется и мигает
    if(!n||!n.el) return;
    const r=cv.getBoundingClientRect(), el=n.el;
    view.x=r.width/2/view.k-(n.x+el.offsetWidth/2); view.y=r.height/2/view.k-(n.y+el.offsetHeight/2); applyView();
    el.classList.remove('pflash'); void el.offsetWidth; el.classList.add('pflash');
    setTimeout(()=>el.classList.remove('pflash'),1600);
  }
  function drawSpark(){
    const cx=spark.getContext('2d'), w=spark.width, h=spark.height, cs=getComputedStyle(panel);
    cx.clearRect(0,0,w,h); if(hist.length<2) return;
    const pts=pwrSpark(hist,w,h,25);
    cx.strokeStyle=cs.getPropertyValue('--acc')||'#4da3ff'; cx.lineWidth=1.5; cx.beginPath();
    pts.forEach(([x,y],i)=>i?cx.lineTo(x,y):cx.moveTo(x,y)); cx.stroke();
    cx.globalAlpha=.18; cx.lineTo(w-1,h-1); cx.lineTo(0,h-1); cx.fillStyle=cx.strokeStyle; cx.fill(); cx.globalAlpha=1;
  }
  function render(){
    const rk=pwrRank(last,{by,peak,top:12}), scale=Math.max(25,...rk.rows.map(r=>r.tot));
    list.replaceChildren(...rk.rows.map(r=>{
      const n=Graph.nodes.find(x=>key(x)===r.key); if(!n) return document.createElement('span');
      const el=document.createElement('div'); el.className='pp-r'+(n._frozen?' off':'');
      const bar=pwrBar(r,scale), bg=document.createElement('div'); bg.className='pp-b';
      bg.innerHTML='<i class="pp-pc" style="width:'+(bar.p*100).toFixed(1)+'%"></i><i class="pp-dc" style="width:'+(bar.d*100).toFixed(1)+'%"></i>';
      const nm=document.createElement('span'); nm.className='pp-n'; nm.textContent=nodeTitle(n); nm.title=r.p.toFixed(2)+' processing + '+r.d.toFixed(2)+' drawing · '+Math.round(r.share*100)+'% of all';
      const v=document.createElement('span'); v.className='pp-v'; v.textContent=by==='peak'?'↑'+f(r.peak):f(r.tot);
      const fz=document.createElement('button'); fz.className='pp-z'; fz.textContent='❄'; fz.title='Freeze / resume this module';
      fz.onclick=e=>{ e.stopPropagation(); n._frozen=!n._frozen; el.classList.toggle('off',n._frozen); };
      el.append(bg,nm,v,fz); el.onclick=()=>reveal(n);
      return el;
    }));
  }
  const f=v=>v>=10?v.toFixed(0):v.toFixed(1);
  function badge(n){
    if(!n._pb2){ n._pb2=document.createElement('div'); n._pb2.className='pbadge'; n.el.append(n._pb2); }
    return n._pb2;
  }
  function tick(){
    const now=performance.now(), win=now-Prof.t0; Prof.t0=now;
    if(win<=0) return;
    const rows=[]; let dead=0;
    for(const n of Graph.nodes){
      const p=(n._pAcc||0)/win*100, d=(n._dAcc||0)/win*100; n._pAcc=n._dAcc=0;
      if(n._dead && Prof.skip) dead++;
      if(n.el) badge(n).textContent=n._frozen?'frozen':(n._dead&&Prof.skip)?'skipped':(p+d>=0.05?f(p+d)+'%':'');
      rows.push({n,key:key(n),p,d});
      if(n.el){ const hc=heat.checked&&!n._frozen?pwrHeat(p+d):0;
        if(n._hc!==hc){ n._hc=hc; n.el.classList.remove('pheat1','pheat2','pheat3'); if(hc) n.el.classList.add('pheat'+hc); } }
    }
    const P=Prof.tot.p/win*100, D=Prof.tot.d/win*100; Prof.tot.p=Prof.tot.d=0;
    tot.textContent=`DSP ${f(P)}% + draw ${f(D)}% = ${f(P+D)}%`+(dead?` · skipped ${dead}`:'')+(Eng.running&&!Eng.paused?'':' · engine stopped');
    last=rows; pwrPeak(peak,rows); pwrPush(hist,P+D,60); drawSpark(); render();
    if(b){
      const lvl=b.level*100;
      if(b0===null){ b0={l:lvl,t:now}; }
      else if(lvl!==b0.l){ b0.rate=(b0.l-lvl)/((now-b0.t)/3.6e6); }
      bat.textContent=`battery ${lvl.toFixed(0)}%`+(b.charging?' · charging':(b0&&b0.rate!=null?` · ${b0.rate.toFixed(1)} %/h`:' · measuring…'));
    } else bat.textContent='';
  }
  btn.onclick=()=>{
    Prof.on=!Prof.on; btn.classList.toggle('on',Prof.on); panel.hidden=!Prof.on;
    if(Prof.on){                                     // над кнопкой, а не поверх неё (тулбар внизу на телефоне)
      const r=btn.getBoundingClientRect(), w=Math.min(290,innerWidth-16);
      panel.style.width=w+'px'; panel.style.right='auto';
      panel.style.left=Math.max(8,Math.min(r.left,innerWidth-w-8))+'px';
      if(r.top>innerHeight/2){ panel.style.top=''; panel.style.bottom=(innerHeight-r.top+4)+'px'; }
      else { panel.style.bottom='auto'; panel.style.top=(r.bottom+4)+'px'; }
    }
    clearInterval(timer);
    if(Prof.on){
      Prof.t0=performance.now(); Prof.tot.p=Prof.tot.d=0; b0=null; hist=[]; peak={}; last=[];
      for(const n of Graph.nodes) n._pAcc=n._dAcc=0;
      navigator.getBattery?.().then(x=>{ b=x; }).catch(()=>{});
      timer=setInterval(tick,1000);
    } else for(const n of Graph.nodes){ n._pb2?.remove(); n._pb2=null; n._hc=0; n.el&&n.el.classList.remove('pheat1','pheat2','pheat3','pflash'); }
  };
})();
