"use strict";
/* ============================ PSK / CCSDS: Meteor-M LRPT и родня ============================
   PSK Demodulator (IQ-блок, ядро в ccsds-kernels.js): канал ~137 МГц → мягкие символы QPSK/OQPSK.
   CCSDS Decoder: символы → Витерби → NRZ-M → кадры 1024 байта → дескремблер → RS → записи VCDU
   (rec: scid, vcid, cnt, rs, vcdu — 892 байта для разбора пакетов и картинки). */

def({ id:'pskDemod', title:'PSK Demodulator', cat:'IQ', kernel:true, readout:true, view:{h:150},
  ins:[{n:'in',t:'iq'}], outs:[{n:'out',t:'iq'},{n:'freq',t:'num'},{n:'lock',t:'num'}],
  params:[{n:'mode',t:'select',opts:['OQPSK','QPSK'],d:'OQPSK',label:'modulation (Meteor M2-3/M2-4: OQPSK, M2: QPSK)'},
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
