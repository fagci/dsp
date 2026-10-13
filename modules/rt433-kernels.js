"use strict";
/* ============================ rtl_433 в WebAssembly: обёртка ============================
   vendor/rtl433.wasm — настоящий rtl_433 (детектор импульсов OOK/FSK, слайсеры, все декодеры устройств), собранный
   tools/rtl433/build.sh. Здесь — загрузка модуля и класс Rt433: каналы (по одному детектору на поток отсчётов),
   подача IQ и разбор выданных записей. Без DOM: работает и в воркере, и в Node (tools/test-rt433.mjs). */

class Rt433{
  // mod — WebAssembly.Module (скомпилирован из vendor/rtl433.wasm)
  constructor(mod){
    const m=Math, env={
      atan2f:(y,x)=>m.fround(m.atan2(y,x)), powf:(a,b)=>m.fround(m.pow(a,b)), log10f:x=>m.fround(m.log10(x)),
      tan:m.tan, pow:m.pow, exp:m.exp, log:m.log, log10:m.log10, sin:m.sin, cos:m.cos, atan:m.atan, atan2:m.atan2,
      asin:m.asin, acos:m.acos, rt_now_ms:()=>Date.now() };
    this.x=new WebAssembly.Instance(mod,{env}).exports;
    this.nDev=this.x.rt_init();
    this.block=this.x.rt_max_block();
    this.dec=new TextDecoder();
  }
  get mem(){ return this.x.memory.buffer; }
  devices(){
    const o=[];
    for(let i=0;i<this.nDev;i++){
      const p=this.x.rt_dev_name(i), u=new Uint8Array(this.mem,p);
      let e=0; while(u[e]) e++;
      o.push({i, name:this.dec.decode(u.subarray(0,e)), proto:this.x.rt_dev_proto(i), mod:this.x.rt_dev_mod(i),
        disabled:this.x.rt_dev_disabled(i), on:!!this.x.rt_dev_get(i)});
    }
    return o;
  }
  setDevice(i,on){ this.x.rt_dev_set(i,on?1:0); }
  unknown(on){ this.x.rt_unknown(on?1:0); }
  // mag: огибающая — модуль (cs16, вход из канализатора); без него — амплитуда, как у rtl_433 для cu8
  chan(sr,freq,mag){ return this.x.rt_chan_new(sr,freq,mag?1:0); }
  free(ch){ this.x.rt_chan_free(ch); }
  reset(ch){ this.x.rt_chan_reset(ch); }
  // min_level — нижняя граница уровня импульса, дБ от полной шкалы (по умолчанию −12 дБ); min_snr — превышение над шумом, дБ (9)
  levels(ch,minDb,snrDb){ this.x.rt_chan_levels(ch,minDb,snrDb); }
  minPulses(n){ this.x.rt_min_pulses(n); }
  setFreq(ch,f){ this.x.rt_chan_freq(ch,f); }
  // float IQ (полная шкала ±1) → cs16, пачками по block отсчётов
  feedF(ch,re,im,n,scale){
    n=n==null ? re.length : n; scale=scale||32767;
    const B=this.block; let ev=0;
    for(let o=0;o<n;o+=B){
      const k=Math.min(B,n-o), buf=new Int16Array(this.mem,this.x.rt_in16(),2*k);
      for(let i=0;i<k;i++){
        let a=re[o+i]*scale, b=im[o+i]*scale;
        buf[2*i]=a>32767 ? 32767 : a<-32768 ? -32768 : a; buf[2*i+1]=b>32767 ? 32767 : b<-32768 ? -32768 : b;
      }
      ev+=this.x.rt_feed16(ch,k);
    }
    return ev;
  }
  // готовые int16 IQ (чередование I, Q)
  feed16(ch,iq,n){
    n=n==null ? iq.length>>1 : n;
    const B=this.block; let ev=0;
    for(let o=0;o<n;o+=B){
      const k=Math.min(B,n-o);
      new Int16Array(this.mem,this.x.rt_in16(),2*k).set(iq.subarray(2*o,2*(o+k)));
      ev+=this.x.rt_feed16(ch,k);
    }
    return ev;
  }
  feed8(ch,iq,n){
    n=n==null ? iq.length>>1 : n;
    const B=this.block; let ev=0;
    for(let o=0;o<n;o+=B){
      const k=Math.min(B,n-o);
      new Uint8Array(this.mem,this.x.rt_in8(),2*k).set(iq.subarray(2*o,2*(o+k)));
      ev+=this.x.rt_feed8(ch,k);
    }
    return ev;
  }
  flush(ch){ return this.x.rt_flush(ch); }
  // записи, накопленные с прошлого вызова: [{model, id, …}] (поля как у rtl_433 -F json, плюс mod, freq, rssi, snr, noise, protocol)
  take(){
    const n=this.x.rt_out_len(); if(!n) return [];
    const s=this.dec.decode(new Uint8Array(this.mem,this.x.rt_out(),n));
    this.x.rt_out_clear();
    const o=[];
    for(const l of s.split('\n')) if(l){ try{ o.push(JSON.parse(l)); }catch(e){} }
    return o;
  }
  // неопознанные пакеты импульсов (после unknown(true)): [{mod, sr, freq, rssi, snr, noise, p:[импульс, пауза, …]}]
  takeUnknown(){
    const n=this.x.rt_unk_len(); if(!n) return [];
    const s=this.dec.decode(new Uint8Array(this.mem,this.x.rt_unk(),n));
    this.x.rt_unk_clear();
    const o=[];
    for(const l of s.split('\n')) if(l){ try{ o.push(JSON.parse(l)); }catch(e){} }
    return o;
  }
}
