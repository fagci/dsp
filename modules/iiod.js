"use strict";
/* ============================ iiod (libiio) поверх WebSocket ============================
   Текстовый протокол iiod (порт 30431) — для PlutoSDR, ADALM, любых плат AD936x и других IIO-устройств с буфером IQ.
   Браузер не открывает TCP: нужен мост, например `websockify 8766 192.168.2.1:30431`.
   Порядок: VERSION → TIMEOUT → PRINT (XML контекста: находим устройства и формат отсчётов) → запись атрибутов (скорость, полоса,
   частота, усиление) → OPEN → цепочка READBUF. Частота, скорость, полоса и усиление меняются на ходу: атрибуты пишутся только когда параметр изменился.
   Работает внутри узла IQ over Network (iqnet.js, протокол «iiod»); здесь — клиент протокола и разбор XML. */

const IIOD_ENC=new TextEncoder(), IIOD_DEC=new TextDecoder();
// читатель входящего потока: строки и точное число байт, ждёт данных
class IioRd{
  constructor(){ this.q=[]; this.len=0; this.wake=null; this.dead=false; }
  push(u){ if(!u.length) return; this.q.push(u); this.len+=u.length; this._go(); }
  kill(){ this.dead=true; this._go(); }
  _go(){ if(this.wake){ const w=this.wake; this.wake=null; w(); } }
  _wait(){ return new Promise(r=>{ this.wake=r; }); }
  _take(n){
    const out=new Uint8Array(n); let k=0;
    while(k<n){ const c=this.q[0], t=Math.min(c.length,n-k); out.set(c.subarray(0,t),k); k+=t; if(t===c.length) this.q.shift(); else this.q[0]=c.subarray(t); }
    this.len-=n; return out;
  }
  async line(){
    for(;;){
      let off=0;
      for(const c of this.q){ const i=c.indexOf(10); if(i>=0){ const b=this._take(off+i+1); return IIOD_DEC.decode(b.subarray(0,b.length-1)).replace(/\r$/,''); } off+=c.length; }
      if(this.dead) throw new Error('connection closed');
      await this._wait();
    }
  }
  async bytes(n){ while(this.len<n){ if(this.dead) throw new Error('connection closed'); await this._wait(); } return this._take(n); }
  async int(){                                       // пустые строки пропускаем: после блока данных iiod может ставить лишний перевод строки
    for(;;){
      const l=(await this.line()).trim(); if(l==='') continue;
      if(!/^-?\d+$/.test(l)) throw new Error('unexpected reply «'+l.slice(0,60)+'»');
      return parseInt(l,10);
    }
  }
}
const IIOD_ERR={'-1':'EPERM','-2':'ENOENT','-5':'EIO','-11':'EAGAIN','-12':'ENOMEM','-13':'EACCES','-16':'EBUSY','-19':'ENODEV','-22':'EINVAL','-110':'ETIMEDOUT'};
const iiodErr=(what,v)=>new Error(what+': error '+v+(IIOD_ERR[v] ? ' ('+IIOD_ERR[v]+')' : ''));
// разборщики ответов; каждый вызывается строго по порядку отправки команд
const iiodPInt=what=>async rd=>{ const v=await rd.int(); if(v<0) throw iiodErr(what,v); return v; };
const iiodPLine=async rd=>rd.line();
async function iiodPData(rd){                         // «<длина>\n<данные>»
  const len=await rd.int(); if(len<0) throw iiodErr('read',len);
  return len>0 ? IIOD_DEC.decode(await rd.bytes(len)) : '';
}
async function iiodPBuf(rd){                          // READBUF: «<байт>\n<маска>\n<данные>»; маска — один раз после первого числа
  let n=await rd.int(); if(n<0) throw iiodErr('READBUF',n);
  while(n===0) n=await rd.int();
  await rd.line();
  return rd.bytes(n);
}
function iioCmd(n,text,parse){
  const s=n.iio; if(!s || !n.ws || n.ws.readyState!==1) return Promise.reject(new Error('not connected'));
  n.ws.send(IIOD_ENC.encode(text));
  const p=s.tail.then(()=>parse(s.rd));
  s.tail=p.catch(()=>{});
  return p;
}
function iiodWrite(n,dev,chn,attr,value){            // chn: null — атрибут устройства, иначе [«INPUT»|«OUTPUT», id канала]
  const v=String(value);
  const head='WRITE '+dev+' '+(chn ? 'CHN '+chn[0]+' '+chn[1]+' ' : '')+attr+' '+IIOD_ENC.encode(v).length+'\r\n';
  return iioCmd(n,head+v,iiodPInt('WRITE '+attr));
}
// XML контекста → устройства (id, name, каналы со scan-element) и модель платы
function iiodParse(xml){
  const doc=new DOMParser().parseFromString(xml,'text/xml');
  if(doc.querySelector('parsererror')) throw new Error('cannot parse the iiod XML');
  const ctx={model:'',devices:[]};
  const hw=Array.from(doc.querySelectorAll('context-attribute')).find(a=>a.getAttribute('name')==='hw_model');
  ctx.model=hw ? hw.getAttribute('value') : (doc.documentElement.getAttribute('description')||'').slice(0,60);
  for(const d of doc.querySelectorAll('device')){
    ctx.devices.push({id:d.getAttribute('id'),name:d.getAttribute('name')||'',
      chans:Array.from(d.querySelectorAll('channel')).map(c=>{ const se=c.querySelector('scan-element');
        return {id:c.getAttribute('id'),out:c.getAttribute('type')==='output',idx:se ? +se.getAttribute('index') : -1,fmt:se ? se.getAttribute('format') : ''}; })});
  }
  return ctx;
}
const iiodFind=(ctx,key)=>ctx.devices.find(d=>d.id===key) || ctx.devices.find(d=>d.name===key) || null;
function iiodFormat(f){                              // «le:S12/16>>0»
  const m=/^(le|be):([SU])(\d+)\/(\d+)>>(\d+)$/.exec(f||''); return m ? {be:m[1]==='be',signed:m[2]==='S',bits:+m[3],store:+m[4],shift:+m[5]} : null;
}
const iiodSecs=ms=>new Promise(r=>setTimeout(r,ms));

// приведение атрибутов к параметрам узла: пишем только изменившееся
function iiodSync(n){
  const s=n.iio; if(!s || !s.ready) return Promise.resolve();
  const p=n.p, phy=s.phy.id, sr=Math.max(1,Math.round(+p.sr)), g=+p.gain||0;
  const bw=+p.bw>0 ? Math.round(+p.bw) : Math.max(2e5,Math.min(56e6,Math.round(sr*.8)));
  const want=[['sr',['INPUT','voltage0'],'sampling_frequency',sr],['bw',['INPUT','voltage0'],'rf_bandwidth',bw],
              ['freq',['OUTPUT','altvoltage0'],'frequency',Math.round(+p.freq)],
              ['gm',['INPUT','voltage0'],'gain_control_mode',g>0 ? 'manual' : 'slow_attack'],
              ['gain',['INPUT','voltage0'],'hardwaregain',g>0 ? g.toFixed(2) : null]];
  const jobs=[];
  for(const [k,chn,attr,v] of want){
    if(v===null || n.ap[k]===v) continue;
    n.ap[k]=v;
    jobs.push(iiodWrite(n,phy,chn,attr,v).then(()=>{ if(k==='freq' || k==='sr') n.retune=true; },
      e=>{ n.ap[k]=undefined; n.warnMsg=attr+': '+e.message+(k==='sr' && /EINVAL/.test(e.message) ? ' — AD9361 needs ≥ 2.084 MS/s unless a FIR filter is loaded' : ''); }));
  }
  return Promise.all(jobs);
}
function iiodStop(n){ const s=n.iio; n.iio=null; if(s){ s.run=false; s.rd.kill(); } }
async function iiodRun(n){
  const s=n.iio={rd:new IioRd(),tail:Promise.resolve(),ready:false,run:true,phy:null,rx:null};
  const alive=()=>n.iio===s && s.run;
  try{
    n.status='iiod: handshake…';
    n.iioVer=await iioCmd(n,'VERSION\r\n',iiodPLine);
    try{ await iioCmd(n,'TIMEOUT 10000\r\n',iiodPInt('TIMEOUT')); }catch(e){}
    const ctx=iiodParse(await iioCmd(n,'PRINT\r\n',iiodPData));
    s.phy=iiodFind(ctx,String(n.p.phy||'ad9361-phy').trim()); s.rx=iiodFind(ctx,String(n.p.rxdev||'cf-ad9361-lpc').trim());
    const names=ctx.devices.map(d=>d.id+(d.name ? ' ('+d.name+')' : '')).join(', ');
    if(!s.phy) throw new Error('control device «'+n.p.phy+'» not found; the context has: '+names);
    if(!s.rx) throw new Error('RX buffer device «'+n.p.rxdev+'» not found; the context has: '+names);
    const ch=s.rx.chans.filter(c=>!c.out && c.idx>=0).sort((a,b)=>a.idx-b.idx);
    if(ch.length<2) throw new Error('the RX device has no I/Q scan channels');
    const f=iiodFormat(ch[0].fmt);
    if(!f || f.be || !f.signed || f.store!==16) throw new Error('unsupported sample format «'+ch[0].fmt+'» (need little-endian signed 16-bit storage)');
    const shift=16-f.bits;                             // 12 бит в 16: сдвигаем к полной шкале int16, как у остальных источников
    const mask=(1<<ch[0].idx)|(1<<ch[1].idx), maskHex=(mask>>>0).toString(16).padStart(8,'0');
    const samples=+n.p.buf||16384, bytes=samples*4;
    n.hw=ctx.model; n.warnMsg=''; s.ready=true; n.ap={};
    n.status='iiod: '+(ctx.model||'device')+' — configuring…';
    await iiodSync(n);
    if(n.warnMsg){ throw new Error(n.warnMsg); }
    await iioCmd(n,'OPEN '+s.rx.id+' '+samples+' '+maskHex+'\r\n',iiodPInt('OPEN'));
    n.status='connected, '+(ctx.model||'iiod')+' · streaming';
    // три READBUF в полёте: пока читаем один, устройство уже заполняет следующий — буфер ядра не переполняется
    const chain=async()=>{
      while(alive()){
        const raw=await iioCmd(n,'READBUF '+s.rx.id+' '+bytes+'\r\n',iiodPBuf);
        if(!alive()) return;
        n.bytes+=raw.length;
        const k=raw.length>>2, v=new Int16Array(raw.buffer,0,k*2);
        if(shift) for(let i=0;i<v.length;i++) v[i]<<=shift;
        n.q.push({raw:v,fmt:'s16',n:k}); n.qN+=k;
        const lim=Math.max(1,(+n.p.sr||1e6))*IQN_QMAX_S;
        if(n.qN>lim){ while(n.qN>lim/2 && n.q.length>1) n.qN-=n.q.shift().n; n.gap=true; n.dropped++; }
        if(n.retune){ n.retune=false; n.tagNext='retune'; }
      }
    };
    await Promise.all([chain(),chain(),chain()]);
  }catch(e){
    if(alive()){ n.status='iiod: '+e.message; n.bad=true; n.want=false; try{ n.ws && n.ws.close(); }catch(x){} }
  }
}
