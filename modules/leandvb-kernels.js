"use strict";
/* ============================ DVB-S / DVB-S2 из IQ: обёртка над vendor/leandvb.wasm ============================
   LeanSDR leandvb (GPL-3.0-or-later, tools/leandvb): IQ → синхронизация, демодуляция, Витерби / LDPC, RS / BCH → транспортный поток.
   Без DOM и воркера: грузится и страницей, и воркером. Минимальный WASI — только то, что просит libc (вывод в stderr, выход).
     const d = await LeanDvb.create(wasmBytes);
     d.init({std:'DVB-S', cstln:'QPSK', cr:'1/2', sr:1e6, fs:2e6});
     d.feed(Float32Array)   // чередующиеся I, Q
     d.take()               // Uint8Array — новые байты TS (накопленные с прошлого вызова)
     d.st                   // {lock, mer, ss, cnr, vber, freq, ts}                                                                    */

const LDVB_INFO={LOCK:'lock', MER:'mer', SS:'ss', CNR:'cnr', VBER:'vber', FREQ:'freq'};
class LeanDvb{
  static async create(bytes){
    const d=new LeanDvb();
    const wasi={
      fd_write:(fd,iov,n,nw)=>{ const dv=new DataView(d.mem.buffer); let t=0;
        for(let i=0;i<n;i++){ const p=dv.getUint32(iov+i*8,true), l=dv.getUint32(iov+i*8+4,true); t+=l;
          if(fd===2 && d.log.length<4000) d.log+=new TextDecoder().decode(new Uint8Array(d.mem.buffer,p,l)); }
        dv.setUint32(nw,t,true); return 0; },
      fd_close:()=>0, fd_fdstat_get:()=>8, fd_fdstat_set_flags:()=>0, fd_read:()=>8, fd_seek:()=>8, poll_oneoff:()=>0,
      proc_exit:c=>{ throw new Error('leandvb: exit '+c+(d.log ? ' — '+d.log.trim().split('\n').slice(-2).join(' ') : '')); }
    };
    const r=await WebAssembly.instantiate(bytes,{wasi_snapshot_preview1:wasi});
    d.x=r.instance.exports; d.mem=d.x.memory; if(d.x._initialize) d.x._initialize();
    return d;
  }
  constructor(){ this.log=''; this.st={lock:0, mer:null, ss:null, cnr:null, vber:null, freq:null, ts:0}; this.ready=false; this.txt=''; this.lostIn=0; this.drop=0; }
  // o: std 'DVB-S' | 'DVB-S2'; cstln, cr — как в leandvb; sr — символьная скорость, Гц; fs — частота дискретизации входа, Гц
  init(o){
    const a=['--f32','-f',String(o.fs),'--sr',String(o.sr),'--standard',o.std||'DVB-S','--const',o.cstln||'QPSK','--cr',o.cr||'1/2',
      '--fd-info','3','--roll-off',String(o.rolloff||0.35),'--float-scale',String(o.scale||14.14)];
    if(o.derot) a.push('--derotate',String(o.derot));
    if(o.fast!==false) a.push('--fastlock'); if(o.cnr) a.push('--cnr'); if(o.viterbi) a.push('--viterbi');
    const s=a.join(' '), enc=new TextEncoder().encode(s+'\0');
    const p=this.x.lds_in(); if(enc.length>this.x.lds_in_cap()) throw new Error('args too long');
    new Uint8Array(this.mem.buffer,p,enc.length).set(enc);
    const rc=this.x.lds_init(p);
    if(rc) throw new Error('leandvb: init '+rc);
    this.ready=true; this.out=[]; this.outLen=0; this.txt='';
  }
  feed(f32){
    if(!this.ready) return;
    const cap=this.x.lds_in_cap()>>2&~1;                     // отсчётов float, чётное число (пара I/Q)
    for(let i=0;i<f32.length;i+=cap){
      const k=Math.min(cap,f32.length-i), p=this.x.lds_in();
      new Float32Array(this.mem.buffer,p,k).set(f32.subarray(i,i+k));
      this.lostIn+=this.x.lds_feed(k*4);
      this.drain();
    }
  }
  drain(){
    const n=this.x.lds_out_len();
    if(n){ this.out.push(new Uint8Array(this.mem.buffer,this.x.lds_out(),n).slice()); this.outLen+=n; this.x.lds_out_clear(); this.st.ts+=n; }
    this.drop=this.x.lds_out_drop();
    const m=this.x.lds_info_len();
    if(m){ this.txt+=new TextDecoder().decode(new Uint8Array(this.mem.buffer,this.x.lds_info(),m)); this.x.lds_info_clear();
      let e; while((e=this.txt.indexOf('\n'))>=0){ const l=this.txt.slice(0,e).split(' '); this.txt=this.txt.slice(e+1);
        const k=LDVB_INFO[l[0]]; if(k) this.st[k]=+l[1]; } }
  }
  take(){
    if(!this.outLen) return null;
    const o=new Uint8Array(this.outLen); let k=0; for(const c of this.out){ o.set(c,k); k+=c.length; }
    this.out=[]; this.outLen=0; return o;
  }
}
