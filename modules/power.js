/* Панель энергопрофиля: сколько ядра съедает каждый узел (process + draw), итог и разряд батареи */
(()=>{
  const btn=document.getElementById('power'); if(!btn) return;
  const panel=document.createElement('div'); panel.id='powerPanel'; panel.hidden=true;
  panel.innerHTML='<div class="pp-h"><b>Power</b><label title="Do not compute nodes whose result nobody uses (no display, no wire to a used node)"><input type="checkbox" id="ppSkip"> skip unused</label></div>'+
    '<div id="ppTot"></div><div id="ppBat"></div><div id="ppList"></div>'+
    '<div class="pp-f">% of one CPU core. Click a row to freeze / resume a node.</div>';
  document.body.append(panel);
  const skip=panel.querySelector('#ppSkip'); skip.checked=Prof.skip;
  skip.onchange=()=>{ Prof.skip=skip.checked; try{ localStorage.setItem('dsp-skip',Prof.skip?'1':'0'); }catch(e){} };
  const tot=panel.querySelector('#ppTot'), bat=panel.querySelector('#ppBat'), list=panel.querySelector('#ppList');
  let timer=0, b=null, b0=null;
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
      rows.push({n,p,d});
    }
    const P=Prof.tot.p/win*100, D=Prof.tot.d/win*100; Prof.tot.p=Prof.tot.d=0;
    tot.textContent=`DSP ${f(P)}% + draw ${f(D)}% = ${f(P+D)}%`+(dead?` · skipped ${dead}`:'')+(Eng.running&&!Eng.paused?'':' · engine stopped');
    rows.sort((a,c)=>(c.p+c.d)-(a.p+a.d));
    list.replaceChildren(...rows.slice(0,10).map(r=>{
      const el=document.createElement('div'); el.className='pp-r'+(r.n._frozen?' off':'');
      const nm=document.createElement('span'); nm.textContent=MOD[r.n.type]?.title||r.n.type;
      const v=document.createElement('span'); v.textContent=`${f(r.p)} + ${f(r.d)}`;
      el.append(nm,v); el.onclick=()=>{ r.n._frozen=!r.n._frozen; };
      return el;
    }));
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
      const r=btn.getBoundingClientRect(), w=Math.min(230,innerWidth-16);
      panel.style.width=w+'px'; panel.style.right='auto';
      panel.style.left=Math.max(8,Math.min(r.left,innerWidth-w-8))+'px';
      if(r.top>innerHeight/2){ panel.style.top=''; panel.style.bottom=(innerHeight-r.top+4)+'px'; }
      else { panel.style.bottom=''; panel.style.top=(r.bottom+4)+'px'; }
    }
    clearInterval(timer);
    if(Prof.on){
      Prof.t0=performance.now(); Prof.tot.p=Prof.tot.d=0; b0=null;
      for(const n of Graph.nodes) n._pAcc=n._dAcc=0;
      navigator.getBattery?.().then(x=>{ b=x; }).catch(()=>{});
      timer=setInterval(tick,1000);
    } else for(const n of Graph.nodes) n._pb2?.remove(), n._pb2=null;
  };
})();
