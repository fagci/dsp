"use strict";
/* ============================ Table Chart ============================
   График из строк Table (вход rows, как у Graph): столбики или линии по колонкам x / y, серии по колонке by.
   Ячейка-вектор («3,5,4,…» или массив — CSI, спектр) рисуется линиями по индексу; последние N строк — наложение или
   теплокарта (водопад). Ядро (разбор строк в модель) — tblchart-kernels.js, проверка: node tools/test-tblchart.mjs */

const TC_COLORS=['#4da3ff','#ff9f4a','#5fd38d','#e46bd0','#f2d24b','#8e8cf5','#4fd0d0','#f26b6b'];

function tcHeat(t){                                 // 0..1 → тёмно-синий → голубой → жёлтый → красный
  t=Math.max(0,Math.min(1,t));
  return 'hsl('+Math.round(240-240*t)+',85%,'+Math.round(22+34*t)+'%)';
}
function tcTicks(lo,hi,n){
  const step0=(hi-lo)/n, mag=Math.pow(10,Math.floor(Math.log10(step0||1))), r=step0/mag;
  const step=(r<1.5?1:r<3?2:r<7?5:10)*mag, out=[];
  for(let v=Math.ceil(lo/step)*step; v<=hi+step*1e-6; v+=step) out.push(+v.toFixed(10));
  return out;
}
const tcFmt=v=>Math.abs(v)>=1000||Number.isInteger(v) ? String(Math.round(v*100)/100) : v.toFixed(Math.abs(v)<10?2:1);

function tcDraw(n,cv,cx){
  const W=cv.width, H=cv.height, m=n.tc;
  cx.clearRect(0,0,W,H);
  if(!m || !m.ok){ cx.fillStyle=themeColor('--axis'); cx.font='11px monospace'; cx.fillText(m ? m.err : 'wire a Table «rows» output',8,16); return; }
  const fs=Math.max(9,Math.round(H/22)), padL=44, padB=fs+6, padT=4+(m.series.length>1 && m.kind!=='heat' ? fs+4 : 0);
  const x0=padL, x1=W-6, y0=padT, y1=H-padB, pw=x1-x0, ph=y1-y0;
  if(pw<20||ph<20) return;
  cx.font=fs+'px monospace';
  let lo=n.p.auto ? m.lo : +n.p.lo, hi=n.p.auto ? m.hi : +n.p.hi;
  if(!(hi>lo)) hi=lo+1;
  if(n.p.auto){ const pad=(hi-lo)*.06; hi+=pad; if(m.kind!=='bar') lo-=pad; }
  const yOf=v=>y1-Math.max(0,Math.min(1,(v-lo)/(hi-lo)))*ph;
  cx.strokeStyle=themeColor('--grid'); cx.fillStyle=themeColor('--axis'); cx.lineWidth=1;
  if(m.kind==='heat'){
    const R=m.rows, C=m.xs.length, cw=pw/C, rh=ph/Math.max(1,R.length);
    for(let i=0;i<R.length;i++) for(let j=0;j<C;j++){
      const v=R[i][j]; if(v==null||!isFinite(v)) continue;
      cx.fillStyle=tcHeat((v-lo)/(hi-lo)); cx.fillRect(x0+j*cw,y0+i*rh,Math.ceil(cw),Math.ceil(rh)); }
    cx.fillStyle=themeColor('--axis');
    cx.fillText(tcFmt(hi),2,y0+fs); cx.fillText(tcFmt(lo),2,y1);
  } else {
    for(const v of tcTicks(lo,hi,4)){
      const y=Math.round(yOf(v))+.5;
      cx.beginPath(); cx.moveTo(x0,y); cx.lineTo(x1,y); cx.stroke();
      cx.fillText(tcFmt(v),2,Math.max(y0+fs-2,Math.min(y1,y+fs/3))); }
  }
  // подписи оси x: не чаще одной на ~48 px
  const N=m.xs.length, every=Math.max(1,Math.ceil(N/Math.max(1,pw/48)));
  const slot=pw/Math.max(1,N), xAt=i=>x0+(m.kind==='bar'||m.kind==='heat' ? (i+.5)*slot : N>1 ? i*pw/(N-1) : pw/2);
  cx.fillStyle=themeColor('--axis'); cx.textAlign='center';
  for(let i=0;i<N;i+=every) cx.fillText(m.xl[i],Math.max(x0+10,Math.min(x1-10,xAt(i))),H-3);
  cx.textAlign='left';
  if(m.kind==='bar'){
    const S=m.series.length, bw=Math.max(1,slot*.8/S);
    m.series.forEach((s,k)=>{
      cx.fillStyle=TC_COLORS[k%TC_COLORS.length];
      for(let i=0;i<N;i++){
        const v=s.v[i]; if(v==null||!isFinite(v)) continue;
        const bx=x0+i*slot+slot*.1+k*bw, y=yOf(v); cx.fillRect(bx,y,Math.max(1,bw-1),y1-y); }
      if(n.p.hold && s.pk){
        cx.strokeStyle=themeColor('--txt'); cx.beginPath();
        for(let i=0;i<N;i++){ const v=s.pk[i]; if(v==null) continue; const bx=x0+i*slot+slot*.1+k*bw, y=Math.round(yOf(v))+.5; cx.moveTo(bx,y); cx.lineTo(bx+Math.max(1,bw-1),y); }
        cx.stroke(); }
    });
  } else if(m.kind==='line'){
    m.series.forEach((s,k)=>{
      const col=TC_COLORS[(s.ci ?? k)%TC_COLORS.length], age=s.age;     // старые строки вектора бледнее
      cx.strokeStyle=col; cx.globalAlpha=age==null ? 1 : .25+.75*age; cx.lineWidth=age==1||age==null ? 1.5 : 1; cx.beginPath();
      let pen=false;
      for(let i=0;i<N;i++){
        const v=s.v[i]; if(v==null||!isFinite(v)){ pen=false; continue; }
        const x=xAt(i), y=yOf(v); pen ? cx.lineTo(x,y) : cx.moveTo(x,y); pen=true; }
      cx.stroke(); cx.globalAlpha=1;
      if(n.p.hold && s.pk){
        cx.strokeStyle=col; cx.globalAlpha=.4; cx.setLineDash([3,3]); cx.beginPath(); pen=false;
        for(let i=0;i<N;i++){ const v=s.pk[i]; if(v==null){ pen=false; continue; } const x=xAt(i), y=yOf(v); pen ? cx.lineTo(x,y) : cx.moveTo(x,y); pen=true; }
        cx.stroke(); cx.setLineDash([]); cx.globalAlpha=1; }
    });
  }
  if(m.series.length>1 && m.kind!=='heat' && !m.vector){
    let lx=x0; cx.textBaseline='top';
    m.series.forEach((s,k)=>{
      const t=String(s.name).slice(0,16), w=cx.measureText(t).width+16;
      if(lx+w>x1) return;
      cx.fillStyle=TC_COLORS[k%TC_COLORS.length]; cx.fillRect(lx,2,8,8);
      cx.fillStyle=themeColor('--txt'); cx.fillText(t,lx+11,1); lx+=w; });
    cx.textBaseline='alphabetic';
  }
}

def({ id:'tblchart', title:'Table Chart', cat:'Output', kw:'chart plot graph bar line heatmap waterfall table rows csi channel occupancy rssi level series',
  ins:[{n:'rows',t:'bands'}],
  outs:[{n:'max',t:'num'},{n:'count',t:'num'}],
  view:{h:200}, resize:true, readout:true, w:420,
  params:[{n:'kind',t:'select',opts:['auto','bar','line','heat'],d:'auto',label:'chart',tip:'auto: a vector cell («3,5,4…», CSI) → lines by index, a number column with a text / channel x → bars, a time or numeric x with many rows → lines; heat: last N rows of a vector column as a waterfall'},
          {n:'x',t:'text',d:'',label:'x column (auto)',tip:'chan, t, name … ; empty — the first of chan / t / time / x / id / name'},
          {n:'y',t:'text',d:'',label:'y column(s), comma (auto)',tip:'a number column or a vector column (csi); several → one series each. Empty — rssi_max, busy, csi, rssi, value, y, the first number column'},
          {n:'by',t:'text',d:'',label:'series by column',tip:'one series per distinct value of this column (src, bssid, ssid…); empty — one series per y column'},
          {n:'last',t:'num',min:1,max:500,step:1,d:1,label:'vector rows (overlay / heat)',tip:'for a vector column: how many of the last rows to draw (line: overlaid, older fainter; heat: waterfall)'},
          {n:'hold',t:'check',d:false,label:'peak hold',tip:'keep the highest value seen at every x (bars: a tick, lines: dashed)'},
          {n:'auto',t:'check',d:true,label:'auto range'},
          {n:'lo',t:'num',d:-100,label:'range: min'},
          {n:'hi',t:'num',d:-20,label:'range: max'},
          {n:'clr',t:'button',label:'Reset peaks',fn:n=>{ n.peak=new Map(); }}],
  init:n=>{ n.tc=null; n.peak=new Map(); n.lastRows=null; n.lastLen=-1; n.lastT=0; n.dkey=0; },
  process(n,I){
    const rows=Array.isArray(I.rows) ? I.rows : null, now=performance.now();
    if(!rows){ n.tc=null; n.lastRows=null; return {max:0,count:0}; }
    if(rows!==n.lastRows || rows.length!==n.lastLen || now-n.lastT>250){
      n.lastRows=rows; n.lastLen=rows.length; n.lastT=now;
      const p=n.p;
      n.tc=tcModel(rows,{kind:p.kind,x:p.x,y:p.y,by:p.by,last:p.last,hold:p.hold,peak:n.peak});
    }
    const m=n.tc;
    return {max:m && m.ok ? m.max : 0, count:rows.length};
  },
  draw(n,cv,cx){
    tcDraw(n,cv,cx);
    const el=n.el.querySelector('.readout'); if(!el) return;
    const m=n.tc, s=m ? (m.ok ? m.kind+' · x '+m.xName+' · y '+m.yNames.join(', ')+' · '+m.xs.length+' x · '+m.series.length+' series' : m.err) : 'no rows';
    if(el.textContent!==s) el.textContent=s;
  }});
