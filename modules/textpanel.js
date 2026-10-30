"use strict";
/* ============================ Text Panel: цветной текст по условию, форматы, полосы и графики ============================
   Универсальная «приборная панель» из нескольких строк: значения с пинов a…h (числа) и s1…s4 (текст), цвет участка или всей строки
   по условию, форматы чисел, полосы @bar и графики @graph. Рисуется на холсте узла — поэтому годится везде, где годится холст:
   в дашборде, в PiP, на живых обоях и в окне поверх других приложений (кнопка 🗔 в заголовке, приложение Android).
   Язык строк и вычисления — textpanel-kernels.js (тест: node tools/test-textpanel.mjs). */

const TP_FONT='ui-monospace,Menlo,Consolas,"DejaVu Sans Mono",monospace';
const tpFont=(px,b)=>(b ? 'bold ' : '')+px+'px '+TP_FONT;
const TP_NUM='abcdefgh'.split(''), TP_TXT=['s1','s2','s3','s4'];
const TP_SAMPLE=[
  '# Phone monitor',
  'Speed {a:0.0} km/h | red if a>100; amber if a>60; green',
  'Battery [red if b<0.2]{b:%}[/] · temp [amber if c>38]{c:0.0}[/] °C',
  '@bar b 0..1 Battery | red if b<0.2; amber if b<0.4; green',
  '@graph a,c 60 auto | cyan, amber',
  '-# {now:HH:mm:ss}'].join('\n');

function tpLayout(cx,items,size){
  const rows=[]; let w=0, h=0;
  for(const it of items){
    let rh, rw=0;
    if(it.k==='text'){ const px=size*it.scale; rh=px*1.32; for(const sp of it.spans){ cx.font=tpFont(px,sp.bold); rw+=cx.measureText(sp.s).width; } }
    else if(it.k==='bar'){ rh=size*1.5; rw=size*16; }
    else if(it.k==='graph'){ rh=size*4.2; rw=size*18; }
    else if(it.k==='sep'){ rh=size*.5; } else rh=size*.7;
    rows.push({it,rh,rw}); w=Math.max(w,rw); h+=rh;
  }
  return {rows,w,h};
}
function tpDrawGraph(cx,it,x,y,w,h,k,fg){
  cx.strokeStyle='rgba(255,255,255,.18)'; cx.lineWidth=1; cx.strokeRect(x+.5,y+.5,w-1,h-1);
  cx.beginPath(); cx.moveTo(x,y+h/2); cx.lineTo(x+w,y+h/2); cx.setLineDash([3,4]); cx.stroke(); cx.setLineDash([]);
  const t1=performance.now()/1000, t0=t1-it.sec, Y=v=>y+h-(v-it.lo)/(it.hi-it.lo)*h;
  cx.save(); cx.beginPath(); cx.rect(x,y,w,h); cx.clip(); cx.lineJoin='round'; cx.lineWidth=Math.max(1.2,k*.12);
  for(const s of it.series){
    if(s.pts.length<2) continue;
    cx.strokeStyle=s.color; cx.beginPath();
    s.pts.forEach((q,i)=>{ const px=x+(q[0]-t0)/it.sec*w, py=Y(q[1]); i ? cx.lineTo(px,py) : cx.moveTo(px,py); });
    cx.stroke();
  }
  cx.restore();
  const fs=Math.max(7,k*.8); cx.font=tpFont(fs); cx.textBaseline='top'; cx.textAlign='right'; cx.fillStyle='rgba(255,255,255,.55)';
  cx.fillText(indFmt(it.hi),x+w-2,y+1); cx.textBaseline='bottom'; cx.fillText(indFmt(it.lo),x+w-2,y+h-1);
  cx.textAlign='left'; cx.textBaseline='top'; let lx=x+3;                       // подписи рядов: имя и последнее значение цветом ряда
  for(const s of it.series){ const t=s.name+' '+(typeof s.last==='number' ? indFmt(s.last) : '—'); cx.fillStyle=s.color; cx.fillText(t,lx,y+1); lx+=cx.measureText(t).width+fs; }
}
def({ id:'textpanel', lazy:'proc', title:'Text Panel', cat:'Indicators', kw:'text hud overlay monitor coloured colored lines graph chart bar condition format template status dashboard float widget',
  ins:[...TP_NUM.map(k=>({n:k,t:'num'})),...TP_TXT.map(k=>({n:k,t:'txt'}))],
  view:{h:170}, w:320, resize:true,
  params:[{n:'lines',t:'code',plain:true,d:TP_SAMPLE,label:'lines: {a:0.0} values, [red if a>5]text[/] colour by condition, # headings, @bar / @graph, | red if a>5; green — whole line (help: F1)'},
          {n:'size',t:'range',min:8,max:40,step:1,d:14,label:'text size'},
          {n:'fit',t:'check',d:true,label:'shrink the text to fit the tile (never above the size)'},
          {n:'bg',t:'text',d:'rgba(8,10,12,.74)',label:'background — any CSS colour, alpha allowed (empty — transparent)'},
          {n:'fg',t:'text',d:'#f2f2f2',label:'default text colour'},
          {n:'align',t:'select',opts:['left','center','right'],d:'left'}],
  init:n=>{ n.src=null; n.ast=[]; n.items=[]; n.hist={}; n.ht=0; n.keep=60; },
  process(n,I){
    const p=n.p;
    if(n.src!==p.lines){ n.src=p.lines; n.ast=tpParse(p.lines); n.keep=Math.max(10,...n.ast.filter(l=>l.k==='graph').map(l=>l.sec),10); n.gp=tpGraphPins(n.ast); }
    const get=k=>{ const v=I[k]; return typeof v==='number' && isFinite(v) ? v : typeof v==='string' ? v : undefined; };
    const t=performance.now()/1000;
    if((n.ht-=indDt())<=0){ n.ht=.2; for(const k of n.gp) tpPush(n.hist,k,t,get(k),n.keep+5); }
    n.items=tpEval(n.ast,get,new Date(),(k,sec)=>(n.hist[k]||[]).filter(q=>q[0]>=t-sec));
    return {}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, p=n.p, pad=Math.max(5,Math.min(W,H)*.04), fg=p.fg||'#f2f2f2';
    cx.clearRect(0,0,W,H);
    if(p.bg){ cx.fillStyle=p.bg; pnRoundTp(cx,0,0,W,H,Math.min(10,H*.08)); cx.fill(); }
    const size=+p.size||14, nat=tpLayout(cx,n.items,size);
    const k=p.fit ? Math.min(1,(W-2*pad)/Math.max(1,nat.w),(H-2*pad)/Math.max(1,nat.h)) : 1;
    const lay=k===1 ? nat : tpLayout(cx,n.items,size*k), S=size*k, iw=W-2*pad;
    let y=pad; cx.textBaseline='middle';
    for(const r of lay.rows){
      const it=r.it;
      if(it.k==='text'){
        const px=S*it.scale; let x= p.align==='center' ? (W-r.rw)/2 : p.align==='right' ? W-pad-r.rw : pad;
        cx.textAlign='left';
        for(const sp of it.spans){ cx.font=tpFont(px,sp.bold); cx.fillStyle=sp.color || (it.dim ? '#8c949c' : fg); cx.fillText(sp.s,x,y+r.rh/2); x+=cx.measureText(sp.s).width; }
      } else if(it.k==='bar'){
        const bh=Math.max(4,S*.62), by=y+(r.rh-bh)/2, f=it.v===null ? 0 : clamp((it.v-it.lo)/(it.hi-it.lo||1),0,1), col=it.color || '#4fd8e8';
        cx.font=tpFont(S*.8); cx.fillStyle='#8c949c'; cx.textAlign='left'; let lx=pad;
        if(it.label){ cx.fillText(it.label,pad,y+r.rh/2); lx+=cx.measureText(it.label).width+S*.5; }
        const tw=cx.measureText(it.text).width+S*.5, bw=Math.max(10,iw-(lx-pad)-tw);
        cx.fillStyle='rgba(255,255,255,.14)'; pnRoundTp(cx,lx,by,bw,bh,bh/2); cx.fill();
        if(f>0){ cx.fillStyle=col; pnRoundTp(cx,lx,by,Math.max(bh,bw*f),bh,bh/2); cx.fill(); }
        cx.fillStyle=it.color || fg; cx.textAlign='right'; cx.fillText(it.text,W-pad,y+r.rh/2);
      } else if(it.k==='graph') tpDrawGraph(cx,it,pad,y+2,iw,r.rh-4,S,fg);
      else if(it.k==='sep'){ cx.fillStyle='rgba(255,255,255,.2)'; cx.fillRect(pad,y+r.rh/2,iw,1); }
      y+=r.rh;
    }
    cx.textAlign='start'; cx.textBaseline='alphabetic'; }
});
function pnRoundTp(cx,x,y,w,h,r){ cx.beginPath(); cx.roundRect(x,y,w,h,r); }
