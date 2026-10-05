"use strict";
/* ============================ 4FSK Digital Voice ============================
   Универсальный приёмник 4FSK-протоколов (ядро в fsk4-kernels.js, протоколы — плагины): IQ → дискриминатор → RRC → синхрослова.
   Один протокол или все сразу: канал (скорость, α) общий, протокол определяется по синхрословам. Записи — на `rec`, сырые кадры
   вокодера (AMBE / IMBE / …) — на `voice`. */

defIQ({ id:'fskRx', title:'Digital Voice Decoder', kw:'4fsk dmr p25 nxdn ysf m17 d-star dstar dpmr motorola mototrbo', cat:'Decoders', tall:true, resize:true, w:480,
  ins:[{n:'in',t:'iq'}], outs:[{n:'rec',t:'rec'},{n:'voice',t:'rec'}],
  params:[{n:'proto',t:'select',opts:['auto',...FSK4.order],d:'auto',label:'protocol (auto: every one, picked by sync words)'},
          {n:'expand',t:'button',label:'Expand into blocks',fn:n=>fskExpand(n)}]},
  n=>{ const u=n.ui; if(!u) return 'no input';
    const a=u.active && u.protos[u.active], ids=Object.keys(u.protos);
    if(a) return a.text;
    const recent=ids.flatMap(id=>u.protos[id].recent||[]).slice(-6);
    return (u.fs/1000).toFixed(1)+' kS/s · searching sync ('+ids.join(', ')+')'+(recent.length ? '\n'+recent.join('\n') : ''); });

/* ---- «Expand into blocks»: узел → цепочка блоков с теми же параметрами протокола ----
   IQ Decimator (если приёмник прореживал) → FM Discriminator → RRC. Дальше: у протоколов с описанием chain.parser (M17, DMR) —
   Symbol Slicer → Symbol Sync Search → парсер кадров; у остальных (P25, NXDN, YSF, D-STAR, dPMR) — Protocol Decoder (4FSK): код протокола
   на выходе согласованного фильтра (8 фаз такта и подгонка по синхрослову, как у монолита). Провода входа и выходов переносятся. */
function fskExpand(n){
  const pr=FSK4.protos[n.p.proto];
  if(!pr){ showToast('pick a protocol first (not auto)'); return; }
  const ch=pr.chain || {baud:pr.baud, alpha:pr.alpha, lp:pr.lp};
  const M=n.ui && n.ui.M>1 ? n.ui.M : 0;
  if(!n.ui) showToast('not run yet — add an IQ Decimator by hand if the input rate is above ~48 kS/s');
  const ins=Graph.edges.filter(e=>e.to===n.id).map(e=>({from:e.from,fp:e.fp}));
  const outs=Graph.edges.filter(e=>e.from===n.id).map(e=>({fp:e.fp,to:e.to,tp:e.tp}));
  const was=Undo.busy; Undo.busy=true;
  try{
    const x0=n.x, y0=n.y, dx=250, dy=260, made=[];
    const add=(type,col,row,p)=>{ const m=addNode(type,x0+col*dx,y0+row*dy,p); made.push(m); return m; };
    const dec=M ? add('iqDecim',0,0,{M:String(M), cut:Math.min(.45,7500/n.ui.fs)}) : null;
    const fm=add('fmDisc',M?1:0,0,{bw:ch.lp});
    const rr=add('symRrc',M?2:1,0,{baud:ch.baud, alpha:ch.alpha});
    let last;
    if(ch.parser){
      const sl=add('symSlicer',0,1,{baud:ch.baud});
      const sy=add('symSync',1,1,{word:ch.words, len:ch.len, tol:ch.tol, pre:ch.pre||0, period:ch.period||0, lockTol:ch.lockTol==null ? ch.tol : ch.lockTol});
      const ps=add(ch.parser,2,1,{});
      ps.size.w=n.size.w; ps.size.h=n.size.h; applySize(ps);
      addEdge(rr.id,'out',sl.id,'in'); addEdge(sl.id,'out',sy.id,'in'); addEdge(sy.id,'blk',ps.id,'blk');
      last=ps;
    } else {
      const pd=add('fskSym',0,1,{proto:n.p.proto, baud:ch.baud});
      pd.size.w=n.size.w; pd.size.h=n.size.h; applySize(pd);
      addEdge(rr.id,'out',pd.id,'in');
      last=pd;
    }
    const first=dec||fm;
    for(const e of ins) addEdge(e.from,e.fp,first.id,'in');
    if(dec) addEdge(dec.id,'out',fm.id,'in');
    addEdge(fm.id,'out',rr.id,'in');
    for(const e of outs) addEdge(last.id,e.fp,e.to,e.tp);
    delNode(n); Sel.delete(n.id);
    Sel.clear(); for(const m of made) Sel.add(m.id);
    syncSel();
  } finally { Undo.busy=was; }
  markWiresDirty(); Undo.push();
  showToast('expanded into blocks');
}

// кадры M17 из Symbol Sync Search (blk) → записи и сырой Codec 2; разбор тот же, что у Digital Voice Decoder с proto = m17
defIQ({ id:'m17Parse', title:'M17 Frame Parser', cat:'Decoders', kw:'m17 lsf callsign codec2 frames', tall:true, resize:true, w:480,
  ins:[{n:'blk',t:'blk'}], outs:[{n:'rec',t:'rec'},{n:'voice',t:'rec'}]},
  n=>n.ui ? n.ui.text : 'no input');

// M17 на передачу. packet: текст → кадры (преамбула, LSF, пакеты SMS, EOT), уходят по go (фронт) или кнопке Send; auto — по смене входа text.
// voice: пока PTT (вход ptt или кнопка) — преамбула, LSF и кадр потока на каждые 16 байт Codec 2 с входа voice (Vocoder Encoder); в конце — кадр с флагом конца и EOT
const M17_MODES=['packet (SMS)','voice (stream)'];
def({ id:'m17Tx', title:'M17 Frame Builder', cat:'Protocols', kw:'m17 transmit packet sms voice lsf tx encoder ptt', readout:true, tall:true,
  ins:[{n:'text',t:'txt'},{n:'go',t:'num'},{n:'voice',t:'rec'},{n:'ptt',t:'num'}], outs:[{n:'blk',t:'blk'}],
  params:[{n:'mode',t:'select',opts:M17_MODES,d:M17_MODES[0],label:'mode'},
          {n:'src',t:'text',d:'N0CALL',label:'from callsign'},
          {n:'dst',t:'text',d:'ALL',label:'to callsign'},
          {n:'can',t:'range',min:0,max:15,step:1,d:0,label:'channel access number'},
          {n:'msg',t:'text',d:'Hello from M17',label:'packet: message (if the text input is empty)'},
          {n:'auto',t:'check',d:false,label:'packet: send when the text input changes'},
          {n:'send',t:'button',label:'Send',fn:n=>{ n.send=true; }},
          {n:'pttBtn',t:'button',label:'PTT on / off',fn:n=>{ n.pttOn=!n.pttOn; }}],
  init:n=>{ n.fid=0; n.prevGo=0; n.frame=null; n.lastIn=null; n.send=false; n.text='ready'; n.tx=null; n.hold=null; n.pttOn=false; n.vf=0; },
  process(n,I){
    const frame=dib=>{ n.frame={dib:Uint8Array.from(dib), n:2*dib.length, id:++n.fid, kind:'m17-tx'}; };
    if(n.p.mode===M17_MODES[1]){
      const ptt=I.ptt>.5 || n.pttOn, dib=[];
      if(ptt && !n.tx){ n.tx=m17StreamStart(n.p.src,n.p.dst,n.p.can); n.hold=null; n.vf=0; dib.push(...n.tx.dib); }
      if(n.tx){
        const recs=Array.isArray(I.voice) ? I.voice : [];
        for(const r of recs){
          if(r.src!=='M17' || !r.codec2) continue;
          const by=Uint8Array.from(r.codec2.match(/../g)||[],h=>parseInt(h,16));
          if(by.length<16) continue;
          if(n.hold){ dib.push(...m17StreamFrame(n.tx,n.hold,false)); n.vf++; }
          n.hold=by;
        }
        if(!ptt){ dib.push(...m17StreamFrame(n.tx,n.hold||new Uint8Array(16),true), ...M17_EOT); n.vf++; n.tx=null; n.hold=null; }
      }
      if(dib.length) frame(dib);
      n.text=(n.tx ? 'TX ON' : 'idle')+' · '+n.vf+' voice frames\n'+n.p.src+' → '+n.p.dst+' · CAN '+n.p.can;
      return {blk:n.frame}; }
    const go=I.go||0, trig=go>.5 && !n.prevGo; n.prevGo=go>.5;
    const inText=typeof I.text==='string' && I.text ? I.text : null;
    let want=trig || n.send; n.send=false;
    if(inText!==null && inText!==n.lastIn){ n.lastIn=inText; if(n.p.auto) want=true; }
    if(want){
      const text=(inText!==null ? inText : n.p.msg).slice(0,700);
      frame(m17BuildPacket(n.p.src,n.p.dst,n.p.can,text));
      n.frame.text=text;
      n.text='frame #'+n.fid+' · '+n.frame.dib.length+' symbols ('+(n.frame.dib.length/4.8).toFixed(0)+' ms)\n'+n.p.src+' → '+n.p.dst+' · CAN '+n.p.can+'\n"'+text+'"';
    }
    return {blk:n.frame}; },
  draw(n){ n.el.querySelector('.readout').textContent=n.text||'…'; }});


/* ---- универсальный канал данных поверх 4FSK-символов (не по спецификации любого протокола) ----
   Любые байты (файл, текст, кадр камеры/видео в JPEG, биты с blk) → кадры фиксированной длины → дибиты → Symbol Player → RRC Pulse Shaper → FM Modulator.
   Кадр: [преамбула][синхрослово][seq u16][total u16][len u8][данные до pay байт, добитые нулями][crc16], после синхрослова всё отбелено PN9. */
/* dl:begin */
const DL_HDR=5;
function dlHex(s){ const h=(s||'').replace(/[^0-9a-f]/gi,''), b=[]; for(let i=0;i+1<h.length;i+=2) b.push(parseInt(h.substr(i,2),16)); return Uint8Array.from(b); }
function dlPn9(len){                                // x^9 + x^5 + 1, начальное состояние 0x1FF
  let r=0x1FF; const o=new Uint8Array(len);
  for(let i=0;i<len;i++){ let v=0; for(let k=0;k<8;k++){ v=(v<<1)|((r>>8)&1); r=((r<<1)|(((r>>8)^(r>>4))&1))&0x1FF; } o[i]=v; }
  return o;
}
function dlToDib(b){ const d=new Uint8Array(b.length*4); for(let i=0;i<b.length;i++) for(let k=0;k<4;k++) d[4*i+k]=(b[i]>>(6-2*k))&3; return d; }
function dlFromDib(d,nb){ const b=new Uint8Array(nb); for(let i=0;i<nb;i++) b[i]=(d[4*i]<<6)|(d[4*i+1]<<4)|(d[4*i+2]<<2)|d[4*i+3]; return b; }
// данные → тела кадров (байты после синхрослова)
function dlFrames(data,pay,whiten){
  const total=Math.max(1,Math.ceil(data.length/pay)), fr=[], pn=whiten ? dlPn9(DL_HDR+pay+2) : null;
  for(let i=0;i<total;i++){
    const ch=data.subarray(i*pay,(i+1)*pay), b=new Uint8Array(DL_HDR+pay+2);
    b[0]=i>>8; b[1]=i&255; b[2]=total>>8; b[3]=total&255; b[4]=ch.length; b.set(ch,DL_HDR);
    const c=crc16(b,0,DL_HDR+pay,0x1021,0xFFFF,0); b[DL_HDR+pay]=c>>8; b[DL_HDR+pay+1]=c&255;
    if(pn) for(let k=0;k<b.length;k++) b[k]^=pn[k];
    fr.push(b); }
  return fr;
}
const DL_LEAD=256, DL_TAIL=12;                                    // хвост после тела: фильтры тракта держат последние символы
function dlSymbols(body,pre,word){                  // преамбула чередованием +3/−3, затем слово, тело и хвост
  const p=new Uint8Array(pre), t=new Uint8Array(DL_TAIL);
  for(let i=0;i<pre;i++) p[i]=i&1 ? 3 : 1;
  for(let i=0;i<DL_TAIL;i++) t[i]=i&1 ? 3 : 1;
  return u8cat(p,dlToDib(word),dlToDib(body),t);
}
// дибиты тела → {seq,total,len,data} или null, если CRC не сошёлся
function dlParse(dib,pay,whiten){
  const nb=DL_HDR+pay+2; if(!dib || dib.length<nb*4) return null;
  const b=dlFromDib(dib,nb); if(whiten){ const pn=dlPn9(nb); for(let k=0;k<nb;k++) b[k]^=pn[k]; }
  if(crc16(b,0,DL_HDR+pay,0x1021,0xFFFF,0)!==(b[DL_HDR+pay]<<8|b[DL_HDR+pay+1])) return null;
  const len=b[4]; if(len>pay) return null;
  return {seq:b[0]<<8|b[1], total:b[2]<<8|b[3], len, data:b.subarray(DL_HDR,DL_HDR+len)};
}
/* dl:end */

function dlImgToJpeg(img,w,q){                      // кадр img → JPEG (уменьшенный до ширины w)
  return new Promise(res=>{
    const sc=document.createElement('canvas'); sc.width=img.w; sc.height=img.h;
    let id=img.data;
    if(!id){ id=new ImageData(img.w,img.h); for(let i=0;i<img.w*img.h;i++){ const v=Math.max(0,Math.min(255,img.buf[i]*255))|0; id.data.set([v,v,v,255],4*i); } }
    sc.getContext('2d').putImageData(id,0,0);
    const k=Math.min(1,w/img.w), c=document.createElement('canvas');
    c.width=Math.max(1,Math.round(img.w*k)); c.height=Math.max(1,Math.round(img.h*k));
    c.getContext('2d').drawImage(sc,0,0,c.width,c.height);
    c.toBlob(b=>b ? b.arrayBuffer().then(a=>res(new Uint8Array(a)),()=>res(null)) : res(null),'image/jpeg',q);
  });
}

const DL_SRC=['auto','image','text','bits','file'];
def({ id:'dataTx', title:'Data → Symbols (universal)', cat:'Protocols', kw:'transmit file image video frame text bytes 4fsk dmr tx modem packetizer', readout:true, tall:true,
  ins:[{n:'img',t:'img'},{n:'text',t:'txt'},{n:'blk',t:'blk'},{n:'go',t:'num'}], outs:[{n:'blk',t:'blk'},{n:'busy',t:'num'}],
  params:[{n:'src',t:'select',opts:DL_SRC,d:'auto',label:'source (auto: image, bits, text, then the message below)'},
          {n:'msg',t:'text',d:'Hello',label:'message (if nothing else is wired)'},
          {n:'file',t:'file',accept:'*/*',fn:(n,f)=>{ f.arrayBuffer().then(a=>{ n.fileBytes=new Uint8Array(a); n.text='file: '+f.name+' · '+f.size+' bytes'; }); }},
          {n:'pay',t:'range',min:8,max:255,step:1,d:32,label:'payload per frame, bytes'},
          {n:'word',t:'text',d:'755FD7DF75F7',label:'sync word (hex)'},
          {n:'pre',t:'range',min:0,max:256,step:2,d:16,label:'preamble, symbols'},
          {n:'baud',t:'num',d:4800,label:'symbol rate, Bd (paces the frames)'},
          {n:'whiten',t:'check',d:true,label:'whiten the body (PN9)'},
          {n:'w',t:'select',opts:['64','96','128','160','240','320','480'],d:'160',label:'image: width, px'},
          {n:'q',t:'range',min:.1,max:.95,step:.05,d:.5,label:'image: JPEG quality'},
          {n:'loop',t:'check',d:false,label:'repeat (a stream of frames, a beacon)'},
          {n:'send',t:'button',label:'Send',fn:n=>{ n.trig=true; }}],
  init:n=>{ n.q=[]; n.qi=0; n.nextAt=0; n.fid=0; n.frame=null; n.prevGo=0; n.trig=false; n.fileBytes=null; n.lastImg=null; n.busy=false; n.what=''; n.text='ready'; },
  process(n,I){
    const P=n.p, now=performance.now();
    if(I.img) n.lastImg=I.img;
    const go=I.go||0, rise=go>.5 && n.prevGo<=.5; n.prevGo=go;
    const idle=n.qi>=n.q.length && !n.busy;
    if((rise||n.trig||(P.loop && idle && n.what)) && idle){
      const send=(data,what)=>{ n.q=dlFrames(data,P.pay|0,P.whiten); n.qi=0; n.nextAt=0; n.what=what; n.text=what+' · '+data.length+' bytes · '+n.q.length+' frames'; };
      const bitsOf=b=>{ const d=b.d, a=new Uint8Array(Math.ceil(d.length/8)); for(let i=0;i<d.length;i++) if(d[i]>0) a[i>>3]|=0x80>>(i&7); return a; };
      let src=P.src; const textIn=typeof I.text==='string' && I.text ? I.text : '';
      if(src==='auto') src=n.lastImg ? 'image' : I.blk ? 'bits' : textIn ? 'text' : n.fileBytes ? 'file' : 'text';
      if(src==='image'){
        if(!n.lastImg) n.text='no image on the input';
        else{ n.busy=true; n.text='encoding the image…'; dlImgToJpeg(n.lastImg,+P.w,P.q).then(b=>{ n.busy=false; if(b) send(b,'image'); else n.text='could not encode the image'; }); }
      }else if(src==='bits'){ if(I.blk && I.blk.d) send(bitsOf(I.blk),'bits'); else n.text='no bit block on the input'; }
      else if(src==='file'){ if(n.fileBytes) send(n.fileBytes,'file'); else n.text='choose a file'; }
      else send(new TextEncoder().encode((textIn||P.msg).slice(0,60000)),'text');
    }
    n.trig=false;
    if(n.qi<n.q.length && now>=n.nextAt){
      const body=n.q[n.qi++], dib=dlSymbols(body,(P.pre|0)+(n.qi===1 ? DL_LEAD : 0),dlHex(P.word));   // перед первым кадром — длинная преамбула: уровни слайсера успевают подстроиться
      n.frame={dib, n:2*dib.length, id:++n.fid, kind:'data-tx'};
      n.nextAt=now+dib.length/Math.max(1,P.baud)*800;
      n.text=n.what+' · frame '+n.qi+'/'+n.q.length+' · '+dib.length+' symbols ('+(dib.length/P.baud*1000).toFixed(0)+' ms)\nafter the word: '+(body.length*4)+' symbols (set the same in Sync Search)';
    }
    return {blk:n.frame, busy:n.qi<n.q.length||n.busy?1:0}; },
  draw(n){ n.el.querySelector('.readout').textContent=n.text||'…'; }});

def({ id:'dataRx', title:'Symbols → Data (universal)', cat:'Decoders', kw:'receive file image video frame text bytes 4fsk dmr rx modem depacketizer', readout:true, tall:true, view:{h:100},
  ins:[{n:'blk',t:'blk'}], outs:[{n:'text',t:'txt'},{n:'img',t:'img'},{n:'rec',t:'rec'},{n:'progress',t:'num'},{n:'ok',t:'num'}],
  params:[{n:'pay',t:'range',min:8,max:255,step:1,d:32,label:'payload per frame, bytes (as in the transmitter)'},
          {n:'whiten',t:'check',d:true,label:'body is whitened (PN9)'},
          {n:'timeout',t:'range',min:1,max:120,step:1,d:15,label:'drop an unfinished transfer after, s'},
          {n:'save',t:'button',label:'Save last data',fn:n=>{
            if(!n.last) return; const a=document.createElement('a');
            a.href=URL.createObjectURL(new Blob([n.last])); a.download='data.bin'; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),5000); }}],
  init:n=>{ n.lastId=0; n.parts=new Map(); n.total=0; n.at=0; n.good=0; n.bad=0; n.done=0; n.pulse=0; n.out=null; n.msgText=''; n.rec=null;
    n.img=null; n.capCv=document.createElement('canvas'); n.last=null; n.text='waiting for frames'; },
  process(n,I){
    const f=I.blk, P=n.p, now=performance.now();
    n.pulse=0; n.rec=null;
    if(n.parts.size && now-n.at>P.timeout*1000){ n.parts.clear(); n.total=0; }
    const fl=f && f.id!==n.lastId ? (f.all || [f]) : [];       // Symbol Sync Search кладёт в all все кадры тика
    if(f) n.lastId=f.id;
    for(const fr of fl){
      const r=fr.dib ? dlParse(fr.dib,P.pay|0,P.whiten) : null;
      if(!r || !r.total || r.seq>=r.total) n.bad++;
      else{
        n.good++; n.at=now;
        if(r.total!==n.total){ n.parts.clear(); n.total=r.total; }
        n.parts.set(r.seq,Uint8Array.from(r.data));
        if(n.parts.size===n.total){
          const all=u8cat(...Array.from({length:n.total},(_,i)=>n.parts.get(i)));
          n.parts.clear(); n.total=0; n.done++; n.pulse=1; n.last=all;
          const jpeg=all[0]===0xFF && all[1]===0xD8, png=all[0]===0x89 && all[1]===0x50;
          let text=null; if(!jpeg && !png){ try{ text=new TextDecoder('utf-8',{fatal:true}).decode(all); }catch(e){} }
          if(text!==null) n.msgText=text;
          n.rec={t:Date.now(), src:'data', kind:jpeg||png ? 'image' : text!==null ? 'text' : 'file', bytes:all.length, text:text!==null ? text : undefined};
          if(jpeg||png) createImageBitmap(new Blob([all])).then(bm=>{
            n.capCv.width=bm.width; n.capCv.height=bm.height;
            const cx=n.capCv.getContext('2d',{willReadFrequently:true}); cx.drawImage(bm,0,0);
            n.img={data:cx.getImageData(0,0,bm.width,bm.height),w:bm.width,h:bm.height,gray:false,rev:(n.img?.rev|0)+1};
          }).catch(()=>{ n.rec.kind='file'; });
        }
      }
    }
    n.text=n.good+' frames ok · '+n.bad+' bad · '+n.done+' transfers'+(n.total ? '\nreceiving '+n.parts.size+'/'+n.total : '')+(n.msgText ? '\n'+n.msgText.slice(0,300) : '');
    return {text:n.msgText, img:n.img, rec:n.rec, progress:n.total ? n.parts.size/n.total : 0, ok:n.pulse}; },
  drawKey:n=>n.text+'|'+n.img?.rev,
  draw(n,cv,cx){ const r=n.el.querySelector('.readout'); if(r) r.textContent=n.text; if(n.img) cx.drawImage(n.capCv,0,0,cv.width,cv.height); }});
