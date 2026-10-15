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
    const mod=await WebAssembly.compile(bytes);
    for(const im of WebAssembly.Module.imports(mod)) if(im.module==='wasi_snapshot_preview1' && !wasi[im.name]) wasi[im.name]=()=>0;
    const r=await WebAssembly.instantiate(mod,{wasi_snapshot_preview1:wasi});
    d.x=r.exports; d.mem=d.x.memory; if(d.x._initialize) d.x._initialize();
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

/* ============================ DVB-T2 из IQ: vendor/dvbofdm.wasm (tools/dvbofdm) ============================
   IQ с любой частотой дискретизации не ниже полосы канала → ресемплер, P1, L1, оценка канала, LDPC / BCH → транспортный поток одного PLP.
     const d = await DvbOfdm.create(wasmBytes);  d.init({bw:8, plp:-1, fs:10e6});  d.feed(Float32Array I,Q,I,Q…);  d.take();  d.st  */
const T2_FFT_NAMES={1024:'1K',2048:'2K',4096:'4K',8192:'8K',16384:'16K',32768:'32K'};
const T2_GI_NAMES=['1/32','1/16','1/8','1/4','1/128','19/128','19/256'];
const T2_MOD_NAMES=['QPSK','16QAM','64QAM','256QAM'];
const T2_COD_NAMES=['1/2','3/5','2/3','3/4','4/5','5/6'];
class DvbOfdm{
  static async create(bytes){
    const d=new DvbOfdm();
    const wasi={
      fd_write:(fd,iov,n,nw)=>{ const dv=new DataView(d.mem.buffer); let t=0; for(let i=0;i<n;i++) t+=dv.getUint32(iov+i*8+4,true); dv.setUint32(nw,t,true); return 0; },
      fd_close:()=>0, fd_fdstat_get:()=>8, fd_fdstat_set_flags:()=>0, fd_read:()=>8, fd_seek:()=>8, poll_oneoff:()=>0,
      proc_exit:c=>{ throw new Error('dvbofdm: exit '+c); }
    };
    const mod=await WebAssembly.compile(bytes);
    for(const im of WebAssembly.Module.imports(mod)) if(im.module==='wasi_snapshot_preview1' && !wasi[im.name]) wasi[im.name]=()=>0;
    wasi.environ_sizes_get=(a,b)=>{ const dv=new DataView(d.mem.buffer); dv.setUint32(a,0,true); dv.setUint32(b,0,true); return 0; };
    const r=await WebAssembly.instantiate(mod,{wasi_snapshot_preview1:wasi});
    d.x=r.exports; d.mem=d.x.memory; if(d.x._initialize) d.x._initialize();
    return d;
  }
  constructor(){ this.st={lock:0, mer:null, ss:null, cnr:null, vber:null, freq:null, ts:0, info:''}; this.ready=false; this.out=[]; this.outLen=0; this.lostIn=0; this.drop=0; this.js=null; }
  init(o){
    const rc=this.x.t2_init(Math.round((o.bw||8)*1000), o.plp==null?-1:o.plp, o.fs||0, o.merge===false?0:1);
    if(rc) throw new Error('input sample rate '+(o.fs/1e6).toFixed(2)+' MS/s is below the channel rate');
    this.ready=true; this.out=[]; this.outLen=0;
  }
  feed(f32){
    if(!this.ready) return;
    const cap=this.x.t2_in_cap();
    for(let i=0;i<f32.length;i+=cap*2){
      const k=Math.min(cap*2,f32.length-i)&~1, p=this.x.t2_in();
      new Float32Array(this.mem.buffer,p,k).set(f32.subarray(i,i+k));
      this.x.t2_feed(k>>1);
      this.drain();
    }
    this.status();
  }
  drain(){
    const n=this.x.t2_ts_len();
    if(n){ this.out.push(new Uint8Array(this.mem.buffer,this.x.t2_ts(),n).slice()); this.outLen+=n; this.st.ts+=n; this.x.t2_ts_clear(); }
  }
  status(){
    const p=this.x.t2_status(); const u=new Uint8Array(this.mem.buffer,p,4096); let e=0; while(e<4096 && u[e]) e++;
    if(!e) return;
    let j; try{ j=JSON.parse(new TextDecoder().decode(u.subarray(0,e))); }catch(x){ return; }
    this.js=j;
    const s=this.st;
    s.lock=j.lock && j.fecOk ? 1 : 0; s.mer=j.lock ? j.snr : null; s.freq=j.cfo; s.cnr=j.snr;
    s.vber=j.blocks ? 1-j.blocksOk/j.blocks : null;
    s.info=j.lock ? 'DVB-T2 '+(T2_FFT_NAMES[j.fft]||j.fft)+' GI '+(T2_GI_NAMES[j.gi]||j.gi)+(j.plp>=0 ? ' · PLP '+j.plp+'/'+j.numPlp+' '+(T2_MOD_NAMES[j.mod]||'?')+' '+(T2_COD_NAMES[j.cod]||'?')+(j.rot?' rot':'')+(j.long?' 64K':' 16K') : '')+' · FEC blocks '+j.blocksOk+'/'+j.blocks : 'searching for a T2 preamble… (P1 found '+j.p1ok+', rejected '+j.p1bad+(j.p1ok ? ', L1 not decoded '+j.preBad+(j.preBad ? ' — best try: BPSK SNR '+j.preSnr.toFixed(1)+' dB (GI '+(T2_GI_NAMES[j.preGi]||'?')+(j.preExt?', ext':'')+(j.prePapr?', TR':'')+(j.preSnr<6 ? '; low: wrong frequency / bandwidth, or too weak)' : '; fine: the layout or modulation is not known to the decoder)') : '') : ' — no preamble: check frequency, bandwidth and gain')+', best match '+j.met.toFixed(2)+')';
  }
  take(){
    if(!this.outLen) return null;
    const o=new Uint8Array(this.outLen); let k=0; for(const c of this.out){ o.set(c,k); k+=c.length; }
    this.out=[]; this.outLen=0; return o;
  }
}
