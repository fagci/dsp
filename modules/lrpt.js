"use strict";
/* ============================ PSK / CCSDS: Meteor-M LRPT и родня ============================
   PSK Demodulator (IQ-блок, ядро в ccsds-kernels.js): канал ~137 МГц → мягкие символы QPSK/OQPSK.
   CCSDS Decoder: символы → Витерби → NRZ-M → кадры 1024 байта → дескремблер → RS → записи VCDU
   (rec: scid, vcid, cnt, rs, vcdu — 892 байта для разбора пакетов и картинки). */

def({ id:'pskDemod', title:'PSK Demodulator', cat:'IQ', kernel:true, readout:true, view:{h:150},
  ins:[{n:'in',t:'iq'}], outs:[{n:'out',t:'iq'},{n:'freq',t:'num'},{n:'lock',t:'num'}],
  params:[{n:'mode',t:'select',opts:['OQPSK','QPSK','BPSK'],d:'OQPSK',label:'modulation (Meteor M2-3/M2-4: OQPSK, M2: QPSK, Inmarsat STD-C: BPSK)'},
          {n:'rate',t:'num',d:72000,label:'symbol rate, Bd'},
          {n:'alpha',t:'range',min:.2,max:1,step:.05,d:.6,label:'RRC roll-off'},
          {n:'bw',t:'range',min:.001,max:.03,step:.001,d:.005,log:true,label:'carrier loop bandwidth, × symbol rate'},
          {n:'pull',t:'range',min:1000,max:30000,step:500,d:10000,label:'frequency search, ± Hz'}],
  init:n=>IQK.pskDemod.init(n),
  process:(n,I)=>IQK.pskDemod.process(n,I,iqCtx),
  draw(n,cv,cx){
    const u=n.ui, r=n.el.querySelector('.readout');
    if(r) r.textContent=!u ? 'no input'
      : n.p.mode+' '+(u.baud/1000)+' kBd · '+(u.sr1/1000).toFixed(1)+' kS/s'+(u.M>1 ? ' (÷'+u.M+')' : '')+
        ' · Δf '+(u.hz>=0?'+':'')+u.hz.toFixed(0)+' Hz · '+(u.lock>.15 ? 'locked' : 'searching')+
        ' · SNR '+u.snr.toFixed(1)+' dB'+(n._isl ? ' · worker' : '');
    if(!cv) return;
    const W=cv.width, H=cv.height, R=Math.min(W,H)/2*.9;
    cx.clearRect(0,0,W,H);
    cx.strokeStyle=themeColor('--grid'); cx.beginPath();
    cx.moveTo(W/2,0); cx.lineTo(W/2,H); cx.moveTo(0,H/2); cx.lineTo(W,H/2); cx.stroke();
    if(!u || !u.pts) return;
    cx.fillStyle=getComputedStyle(document.body).getPropertyValue('--t-num');
    const p=u.pts, k=R/1.8;
    for(let i=0;i<p.length;i+=2) cx.fillRect(W/2+clamp(p[i],-1.8,1.8)*k-1,H/2-clamp(p[i+1],-1.8,1.8)*k-1,2,2);
  }});

defIQ({ id:'ccsdsDecode', title:'CCSDS Decoder', cat:'Decoders',
  ins:[{n:'in',t:'iq'}], outs:[{n:'rec',t:'rec'},{n:'ber',t:'num'},{n:'lock',t:'num'}],
  params:[{n:'nrzm',t:'check',d:true,label:'NRZ-M after Viterbi (Meteor M2-3/M2-4; off for M2)'},
          {n:'rs',t:'select',opts:['RS (255,223)','RS dual basis','off'],d:'RS (255,223)',label:'Reed–Solomon ×4 (Meteor: conventional basis)'}]},
  n=>{ const u=n.ui; if(!u) return 'no input';
    const v=u.lock ? 'Viterbi locked' : 'Viterbi searching';
    const b=u.ber!=null ? ' (BER '+(100*u.ber).toFixed(1)+'%)' : '';
    const f=u.lock ? (u.fs===2 ? ' · frames synced' : u.fs===1 ? ' · ASM found' : ' · no ASM')+(u.inv ? ' (inverted)' : '') : '';
    const l=u.last ? '\nSCID '+u.last.scid+' · VC'+u.last.vcid+' #'+u.last.cnt : '';
    return v+b+f+'\n'+u.ok+' frames · '+u.fail+' RS failed · '+u.fixed+' bytes fixed · '+u.rate.toFixed(1)+'/s'+l; });

/* ---- картинка MSU-MR ---- */
// Записи CCSDS Decoder (VCDU) → VCID 5 → пакеты → сегменты JPEG → строки каналов 1…6 (APID 64…69).
// Картинка копится в холсте во всю высоту (строки рисуются по мере прихода), в узле — последняя часть.
const LRPT_COMP={'RGB 221':[1,1,0], 'RGB 123':[0,1,2], 'RGB 321':[2,1,0], 'RGB 125':[0,1,4]};
def({ id:'lrptImage', title:'LRPT Image (MSU-MR)', cat:'Decoders', readout:true, view:{h:220}, resize:true,
  ins:[{n:'rec',t:'rec'}], outs:[{n:'img',t:'img'},{n:'lines',t:'num'}],
  params:[{n:'comp',t:'select',opts:[...Object.keys(LRPT_COMP),'channel'],d:'RGB 221',label:'composite (R G B channels) or one channel',
           fn:n=>lrptRepaint(n)},
          {n:'ch',t:'select',opts:['1','2','3','4','5','6'],d:'1',label:'channel (for «channel»)',fn:n=>lrptRepaint(n)},
          {n:'png',t:'button',label:'Save PNG',fn:n=>{ n.im.rows && lrptCrop(n).toBlob(b=>dl(b,'meteor-lrpt-'+Date.now()+'.png'),'image/png'); }},
          {n:'clr',t:'button',label:'Clear image',fn:n=>{ n.im=msuNew(); n.st={}; n.cv2=null; }}],
  init:n=>{ n.im=msuNew(); n.st={}; n.cv2=null; n.outT=0; n.frames=0; },
  process(n,I){
    const recs=I.rec;
    if(Array.isArray(recs)) for(const r of recs){
      if(!r || !r.vcdu || r.vcid!==5) continue;
      n.frames++;
      for(const p of msuDemux(n.st,r.vcdu)) msuAdd(n.im,p);
    }
    const now=performance.now();
    let img=null;
    if(n.im.rows && now-n.outT>2000 && Graph.edges.some(e=>e.from===n.id && e.fp==='img')){
      lrptPaint(n); n.outT=now;
      const c=lrptCrop(n); img={w:c.width, h:c.height, data:c.getContext('2d').getImageData(0,0,c.width,c.height)};
    }
    return {img, lines:n.im.rows*8};
  },
  draw(n,cv,cx){
    const im=n.im, r=n.el.querySelector('.readout');
    if(r){ const chs=[...im.ch.keys()].sort().map(c=>c+1).join(' ');
      r.textContent=!im.good ? (n.frames ? n.frames+' frames (VC5), no image packets yet' : 'no frames')
        : 'channels '+chs+' · '+im.rows*8+' lines · '+im.good+' segments'+(im.bad ? ', '+im.bad+' bad' : '')+
          ' · QF '+im.qf+(n.st.lost ? ' · '+n.st.lost+' gaps' : ''); }
    lrptPaint(n);
    cx.clearRect(0,0,cv.width,cv.height);
    if(!n.cv2 || !im.rows) return;
    // последняя часть по ширине узла
    const H=im.rows*8, k=cv.width/MSU_W, vis=Math.min(H,Math.ceil(cv.height/k));
    cx.imageSmoothingEnabled=true;
    cx.drawImage(n.cv2,0,H-vis,MSU_W,vis,0,0,cv.width,vis*k);
  }});
// новые строки → холст (растёт по высоте удвоением)
function lrptPaint(n){
  const im=n.im;
  if(!im.dirty.size) return;
  const H=im.rows*8;
  if(!n.cv2 || n.cv2.height<H){
    const c=document.createElement('canvas'); c.width=MSU_W; c.height=Math.max(256,2**Math.ceil(Math.log2(H)));
    if(n.cv2) c.getContext('2d').drawImage(n.cv2,0,0);
    n.cv2=c; n.cx2=c.getContext('2d'); n.row=n.cx2.createImageData(MSU_W,8);
  }
  const m=n.p.comp==='channel' ? [+n.p.ch-1,+n.p.ch-1,+n.p.ch-1] : LRPT_COMP[n.p.comp]||LRPT_COMP['RGB 221'];
  const d=n.row.data;
  for(const r of im.dirty){
    const rows=m.map(c=>im.ch.get(c)?.rows.get(r));
    for(let i=0;i<MSU_W*8;i++){
      d[4*i]=rows[0] ? rows[0][i] : 0; d[4*i+1]=rows[1] ? rows[1][i] : 0; d[4*i+2]=rows[2] ? rows[2][i] : 0; d[4*i+3]=255;
    }
    n.cx2.putImageData(n.row,0,r*8);
  }
  im.dirty.clear();
}
function lrptRepaint(n){ const im=n.im; for(let r=0;r<im.rows;r++) im.dirty.add(r); }
// холст ровно по высоте картинки
function lrptCrop(n){
  lrptPaint(n);
  const c=document.createElement('canvas'); c.width=MSU_W; c.height=n.im.rows*8;
  c.getContext('2d').drawImage(n.cv2,0,0);
  return c;
}
