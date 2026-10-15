"use strict";
/* ============================ DVB-приёмник из IQ с выбором стандарта: один узел ============================
   iq (любой SDR) → vendor/leandvb.wasm в воркере (dvbsoft-worker.js, LeanSDR leandvb) → транспортный поток → тот же разбор, что у «TS → Video»
   (видео, звук, телетекст, таблицы служб). Стандарт выбирается параметром std; движок на стандарт — в воркере (сейчас leandvb: DVB-S, DVB-S2). Выходы: vid, L, R, bin (TS), lock (синхронизация несущей и FEC), level, mer, ber, freq + выходы tsvid. */

(function(){
const TSV=MOD.tsvid, SEQ={n:0};
const std={'DVB-S':['QPSK'], 'DVB-S2':['QPSK','8PSK','16APSK','32APSK'], 'DVB-T2':[]};
const T2_FS={'1.7':131e6/71,'5':40e6/7,'6':48e6/7,'7':8e6,'8':64e6/7,'10':80e6/7};      // channel sample rate by bandwidth, MHz
const dbfs=ss=>20*Math.log10(Math.max(ss,1e-9)/(14.14*4.414));      // SS растёт с амплитудой входа; 4.414·scale — полная шкала при float-scale 14.14

function dsStop(n){ if(n.dw){ n.dw.terminate(); n.dw=null; } n.dwReady=false; n.dwKey=''; n.dwIn=0; n.dsTs=[]; }
function dsStart(n,cfg,key){
  n.dsStarts=(n.dsStarts||0)+1;
  dsStop(n); n.dsFeedAt=performance.now(); n.dwKey=key; n.dsErr='';
  try{
    const w=new Worker('dvbsoft-worker.js'+(document.currentScript?.src||'').replace(/^[^?]*/,''));
    n.dw=w;
    w.onmessage=e=>{
      const m=e.data;
      if(m.type==='ts') n.dsTs.push(m.d);
      else if(m.type==='st'){ n.dwIn=Math.max(0,n.dwIn-m.ack); if(m.st){ n.ds=m.st; n.dsDrop=m.drop; n.dsLost=m.lost; n.dsAt=performance.now(); n.dsInfo=m.info||''; n.dsJs=m.js||null; n.dsMsgs=(n.dsMsgs||0)+1; } }
      else if(m.type==='ready') n.dwReady=true;
      else if(m.type==='err'){ n.dsErr=m.msg; n.dwReady=false; }
    };
    w.onerror=e=>{ n.dsErr=e.message||'worker failed'; n.dwReady=false; };
    w.postMessage({type:'init', cfg});
  }catch(x){ n.dsErr=x.message; }
}

def({ ...TSV, id:'dvbsoft', title:'DVB Receiver (IQ)', cat:'Decoders',
  kw:'dvb dvb-s dvb-s2 dvb-t dvb-t2 standard satellite tv qo-100 datv iq sdr receiver demodulator video audio transport stream leandvb software',
  ins:[{n:'in',t:'iq'},{n:'prog',t:'val'},{n:'page',t:'num'}],
  outs:[...TSV.outs.filter(o=>o.n==='vid'||o.n==='L'||o.n==='R'), {n:'bin',t:'bin'}, {n:'lock',t:'num'}, {n:'level',t:'num'}, {n:'mer',t:'num'}, {n:'ber',t:'num'}, {n:'freq',t:'num'},
    {n:'vlock',t:'num'}, ...TSV.outs.filter(o=>!['vid','L','R','lock'].includes(o.n))],
  params:[{n:'std',t:'select',opts:Object.keys(std),d:'DVB-S',label:'standard'},
          {n:'cstln',t:'select',opts:['QPSK','8PSK','16APSK','32APSK'],d:'QPSK',label:'constellation (DVB-S: QPSK only)'},
          {n:'cr',t:'select',opts:['1/2','2/3','3/4','5/6','7/8','1/4','1/3','2/5','3/5','4/5','8/9','9/10'],d:'1/2',label:'code rate (DVB-S: 1/2…7/8)'},
          {n:'sr',t:'num',d:1000,label:'symbol rate, kBd (the input needs ≥ 2 samples per symbol)'},
          {n:'rolloff',t:'range',min:.2,max:.4,step:.05,d:.35,label:'RRC roll-off'},
          {n:'offset',t:'num',d:0,label:'signal offset from the input centre, Hz (frequency search covers ± about a quarter of the symbol rate)'},
          {n:'viterbi',t:'check',d:false,label:'DVB-S: force Viterbi decoding (weak signals)'},
          {n:'bw',t:'select',opts:['8','7','6','5','10','1.7'],d:'8',label:'DVB-T2: channel bandwidth, MHz (the input sample rate must be at least 8 MHz × 8/7 = 9.14 MS/s for 8 MHz)'},
          {n:'plp',t:'num',d:-1,label:'DVB-T2: PLP id (-1 — the first data PLP)'},
          ...TSV.params.filter(p=>p.n!=='file'&&p.n!=='loop')],
  init(n){ TSV.init(n); n.dw=null; n.dwReady=false; n.dwKey=''; n.dwIn=0; n.dsTs=[]; n.ds=null; n.dsErr=''; n.dsSent=0; n.dsDrop=0; n.dsLost=0; n.dsSkip=0; n.dsHold=false; },
  dispose:n=>{ dsStop(n); TSV.dispose?.(n); },
  process(n,I){
    const s=iqIn(I,'in'), p=n.p;
    let rx='no input';
    const t2=p.std==='DVB-T2';
    if(s && s.sr){
      const sr=Math.round(+p.sr*1000), need=t2 ? T2_FS[p.bw]||T2_FS['8'] : 2*sr;
      if(s.sr<need*0.999) rx=t2 ? 'DVB-T2 '+p.bw+' MHz needs an input of at least '+(need/1e6).toFixed(2)+' MS/s (the input is '+(s.sr/1e6).toFixed(2)+' MS/s)' : 'needs ≥ 2 samples per symbol (input '+s.sr+' S/s, symbol rate '+sr+' Bd)';
      else{
        const cfg=t2 ? {std:'DVB-T2', bw:+p.bw, plp:Math.round(+p.plp), fs:s.sr} : {std:p.std, cstln:p.std==='DVB-S' ? 'QPSK' : p.cstln, cr:p.cr, sr, fs:s.sr, rolloff:+p.rolloff, derot:+p.offset||0, viterbi:!!p.viterbi};
        const key=JSON.stringify(cfg);
        if(key!==n.dwKey) dsStart(n,cfg,key);
        rx=n.dsErr||'';
        if(n.dwReady) for(const c of s.chunks){
          if(t2){                                                                  // T2: воркер не успевает — выбрасываем подряд, пока он не разгребёт очередь,
            if(n.dwIn>=600) n.dsHold=true; else if(n.dwIn<=40) n.dsHold=false;       // иначе рвутся все кадры, а так хоть часть кадров приходит целиком
            if(n.dsHold){ n.dsSkip++; continue; }
          }else if(n.dwIn>=48){ n.dsSkip++; continue; }                            // воркер не успевает: порция выбрасывается
          const re=c.re, im=iqChunkIm(c), K=re.length, f=new Float32Array(2*K);
          let pw=0;
          for(let i=0;i<K;i++){ const a=re[i], b=im[i]; f[2*i]=a; f[2*i+1]=b; if((i&15)===0) pw+=a*a+b*b; }
          if(K) n.dsPwr=(n.dsPwr||0)*0.9+0.1*pw/Math.ceil(K/16);
          n.dwIn++; n.dsFeedAt=performance.now(); n.dw.postMessage({type:'iq', f},[f.buffer]);
        }
      }
    }else if(n.dw && performance.now()-(n.dsFeedAt||0)>3000) dsStop(n);       // input gone for a while: release the worker
    let bin=null;
    if(n.dsTs.length){
      let len=0; for(const c of n.dsTs) len+=c.length;
      const d=new Uint8Array(len); let o=0; for(const c of n.dsTs){ d.set(c,o); o+=c.length; }
      n.dsTs=[]; bin={d, name:'', mime:'video/mp2t', id:++SEQ.n};
    }
    n.dsRx=rx;
    const r=TSV.process(n,{bin, prog:I.prog, page:I.page}), st=n.ds, fresh=st && performance.now()-n.dsAt<1500;
    return {...r, bin, lock:fresh && st.lock ? 1 : 0, vlock:r.lock, level:t2 ? (n.dsPwr>0 ? Math.min(1,Math.max(0,(10*Math.log10(n.dsPwr)+60)/60)) : 0) : st&&fresh&&st.ss!=null ? Math.min(1,Math.max(0,(dbfs(st.ss)+60)/60)) : 0,
      mer:st&&st.mer!=null ? st.mer : 0, ber:st&&st.vber!=null ? st.vber : 0, freq:st&&st.freq!=null ? st.freq : 0};
  },
  draw(n,cv,cx){
    TSV.draw(n,cv,cx);
    const r=n.el.querySelector('.readout');
    if(r){
      const st=n.ds, fresh=st && performance.now()-n.dsAt<1500;
      if(!n.dsRx && n.p.std==='DVB-T2' && st && n.dwReady){
        const t=(fresh && st.lock ? 'LOCK' : 'no lock')+' · '+(n.dsInfo||'')+(st.mer!=null ? ' · SNR '+st.mer.toFixed(1)+' dB' : '')+(st.freq!=null ? ' · Δf '+st.freq.toFixed(0)+' Hz' : '')+' · TS '+(st.ts/1e6).toFixed(2)+' MB'+(n.dsSkip ? ' · skipped '+n.dsSkip+' blocks (CPU)' : '');
        if(!r.textContent.startsWith(t)) r.textContent=t+'\n'+r.textContent;
        return;
      }
      let t=n.dsRx || (!n.dw ? '' : !n.dwReady ? 'loading the demodulator…' : !st ? 'waiting for samples…' :
        (fresh && st.lock ? 'LOCK' : 'no lock')+(st.mer!=null ? ' · MER '+st.mer.toFixed(1)+' dB' : '')+(st.ss!=null ? ' · level '+dbfs(st.ss).toFixed(0)+' dBFS' : '')+
        (st.vber!=null ? ' · BER '+st.vber.toExponential(1) : '')+(st.freq!=null ? ' · Δf '+(st.freq/1000).toFixed(1)+' kHz' : '')+' · TS '+(st.ts/1e6).toFixed(2)+' MB'+
        (n.dsSkip ? ' · skipped '+n.dsSkip+' blocks (CPU)' : '')+(n.dsDrop ? ' · output lost' : ''));
      if(t && !r.textContent.startsWith(t)) r.textContent=t+'\n'+r.textContent;
    }
  }
});
})();
