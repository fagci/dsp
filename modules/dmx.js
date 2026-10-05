"use strict";
/* ============================ DMX Out ============================
   Свет по DMX512 через Enttec DMX USB Pro (и совместимые) по WebSerial. Вселенная — 512 каналов; адаптер сам ведёт обновление линии,
   поэтому кадр уходит по изменению, но не чаще fps, и раз в секунду как обновление. Ядро — dmx-kernels.js. */

async function dxTeardown(n){
  n.ok=false;
  if(n.writer){ try{ if(n.opened && n.p.blackout) await n.writer.write(dmxEnttecFrame(new Uint8Array(DMX_CH))); }catch(e){} try{ n.writer.releaseLock(); }catch(e){} n.writer=null; }
  if(n.port){ try{ await n.port.close(); }catch(e){} n.port=null; }
  n.opened=false;
}
async function dxStop(n){ await dxTeardown(n); n.status='disconnected'; }
async function dxStart(n){
  if(n.connecting) return;
  await dxTeardown(n);
  if(!navigator.serial){ n.status='WebSerial unavailable (needs Chrome/Edge, HTTPS)'; return; }
  n.connecting=true; n.status='choose a port…';
  try{
    const port=await navigator.serial.requestPort();
    await port.open({baudRate:57600});                       // у Pro скорость порта не важна: USB внутри
    n.port=port; n.writer=port.writable.getWriter(); n.ok=true; n.opened=true; n.dirty=true; n.status='connected';
  }catch(e){ n.status=e.name==='NotFoundError' ? 'no port selected' : 'error: '+e.message; }
  n.connecting=false;
}
function dxSend(n){
  if(!n.writer) return;
  const top=Math.max(1,Math.min(DMX_CH,+n.p.channels||DMX_CH));
  const frame=dmxEnttecFrame(n.u.slice(0,top));
  n.chain=n.chain.then(()=>n.writer?.write(frame)).then(()=>{ n.frames++; },e=>{ n.status='write error: '+e.message; });
  n.dirty=false; n.lastSend=performance.now();
}
const DX_IN=['a','b','c','d','e','f','g','h'];
def({ id:'dmxOut', title:'DMX Out', cat:'Output', kw:'dmx dmx512 light lighting stage enttec usb pro fixture dimmer led par',
  ins:[...DX_IN.map(k=>({n:k,t:'num'})),{n:'text',t:'txt'}],
  outs:[{n:'ok',t:'num'}], readout:true, tall:true,
  params:[{n:'start',t:'range',min:1,max:512,step:1,d:1,label:'channel of input a (b, c… the next ones)'},
          {n:'scale',t:'select',opts:['0–255','0–1'],d:'0–255',label:'input range'},
          {n:'channels',t:'range',min:24,max:512,step:1,d:512,label:'channels in the frame (fewer — faster refresh)'},
          {n:'fps',t:'range',min:1,max:44,step:1,d:30,label:'most frames per second'},
          {n:'blackout',t:'check',d:true,label:'all to 0 on disconnect'},
          {n:'connect',t:'button',label:'Connect',fn:n=>dxStart(n)},
          {n:'disconnect',t:'button',label:'Disconnect',fn:n=>dxStop(n)},
          {n:'black',t:'button',label:'Blackout now',fn:n=>{ n.u.fill(0); n.dirty=true; }}],
  init:n=>{ n.port=n.writer=null; n.ok=false; n.opened=false; n.connecting=false; n.chain=Promise.resolve(); n.u=new Uint8Array(DMX_CH);
            n.dirty=false; n.lastSend=0; n.frames=0; n.last={}; n.lastText=undefined; n.status='not connected'; },
  dispose:n=>dxTeardown(n),
  process(n,I){
    const s0=Math.max(1,Math.min(DMX_CH,+n.p.start||1))-1;
    DX_IN.forEach((k,i)=>{
      const v=I[k]; if(typeof v!=='number' || !isFinite(v) || s0+i>=DMX_CH) return;
      const d=dmxClamp(v,n.p.scale); if(n.u[s0+i]!==d){ n.u[s0+i]=d; n.dirty=true; }
    });
    if(typeof I.text==='string' && I.text!==n.lastText){
      n.lastText=I.text;
      for(const r of dmxParse(I.text)) for(let c=r.from;c<=r.to;c++) if(n.u[c-1]!==r.v){ n.u[c-1]=r.v; n.dirty=true; }
    }
    if(n.ok){
      const now=performance.now(), gap=1000/Math.max(1,n.p.fps);
      if((n.dirty && now-n.lastSend>=gap) || now-n.lastSend>=1000) dxSend(n);
    }
    return {ok:n.ok ? 1 : 0};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const nz=[]; for(let i=0;i<DMX_CH && nz.length<8;i++) if(n.u[i]) nz.push((i+1)+'='+n.u[i]);
    const t=n.status+' · frames '+n.frames+(nz.length ? '\n'+nz.join('  ')+(nz.length===8 ? ' …' : '') : '\nall channels 0');
    if(r.textContent!==t) r.textContent=t; }
});
