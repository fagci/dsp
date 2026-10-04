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
   IQ Decimator (если приёмник прореживал) → FM Discriminator → RRC → Symbol Slicer → Symbol Sync Search → парсер кадров.
   Провода входа и выходов переносятся; работает для протоколов с описанием chain (пока M17). Цепочка считается так же, как монолит. */
function fskExpand(n){
  const ch=FSK4.protos[n.p.proto]?.chain;
  if(!ch){ showToast('pick a protocol with a block chain first (m17)'); return; }
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
    const sl=add('symSlicer',0,1,{baud:ch.baud});
    const sy=add('symSync',1,1,{word:ch.words, len:ch.len, tol:ch.tol});
    const ps=add(ch.parser,2,1,{});
    ps.size.w=n.size.w; ps.size.h=n.size.h; applySize(ps);
    const first=dec||fm;
    for(const e of ins) addEdge(e.from,e.fp,first.id,'in');
    if(dec) addEdge(dec.id,'out',fm.id,'in');
    addEdge(fm.id,'out',rr.id,'in'); addEdge(rr.id,'out',sl.id,'in');
    addEdge(sl.id,'out',sy.id,'in'); addEdge(sy.id,'blk',ps.id,'blk');
    for(const e of outs) addEdge(ps.id,e.fp,e.to,e.tp);
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
