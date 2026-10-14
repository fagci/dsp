"use strict";
/* ============================ DVB-T / T2 / C на USB-донгле: драйверы ============================
   Astrometa DVB-T2 (15f4:0131) и подобные: RTL2832U (USB, I2C-мост, проброс TS) + тюнер R828D (Rafael) + демодулятор
   Panasonic MN88473 или MN88472 на той же I2C-шине. Порт драйверов Linux (GPL-2.0-or-later): drivers/media/tuners/r820t.c
   (Mauro Carvalho Chehab), drivers/media/dvb-frontends/mn88473.c, mn88472.c (Antti Palosaari), rtl2832.c, rtl28xxu.c.
   Без DOM и WebUSB: шина — объект bus (см. DvbBus в dvb.js), поэтому код проверяется на эмуляторе (tools/test-dvb.mjs).
     bus.w(addr8, bytes)       запись по I2C; addr8 — адрес, сдвинутый на бит (0x74 у R828D, 0x30/0x34/0x38 у банков MN88473)
     bus.r(addr8, reg, len)    регистровое чтение → Uint8Array
     bus.gate(on)              I2C-шлюз RTL2832 к тюнеру (async)
     bus.sleep(ms)
   Не перенесено: калибровка IMR тюнера (подавление зеркала, в ядре отключается параметром no_imr_cal), измерение уровня. */

const DVB_SYS={T:'DVB-T', T2:'DVB-T2', C:'DVB-C'};

/* ------------------------------- тюнер R820T / R828D ------------------------------- */
const R82_INIT=[0x83,0x32,0x75, 0xc0,0x40,0xd6,0x6c, 0xf5,0x63,0x75,0x68, 0x6c,0x83,0x80,0x00, 0x0f,0x00,0xc0,0x30, 0x48,0xcc,0x60,0x00, 0x54,0xae,0x4a,0xc0];
const R82_SHADOW=5, R82_N=27;
// таблица freq_ranges ядра: начало диапазона МГц, open_d, rf_mux_ploy, tf_c, xtal_cap20p, xtal_cap10p, xtal_cap0p
const R82_RANGES=[
  [0, 0x08, 0x02, 0xdf, 0x02, 0x01, 0x00],
  [50, 0x08, 0x02, 0xbe, 0x02, 0x01, 0x00],
  [55, 0x08, 0x02, 0x8b, 0x02, 0x01, 0x00],
  [60, 0x08, 0x02, 0x7b, 0x02, 0x01, 0x00],
  [65, 0x08, 0x02, 0x69, 0x02, 0x01, 0x00],
  [70, 0x08, 0x02, 0x58, 0x02, 0x01, 0x00],
  [75, 0x00, 0x02, 0x44, 0x02, 0x01, 0x00],
  [80, 0x00, 0x02, 0x44, 0x02, 0x01, 0x00],
  [90, 0x00, 0x02, 0x34, 0x01, 0x01, 0x00],
  [100, 0x00, 0x02, 0x34, 0x01, 0x01, 0x00],
  [110, 0x00, 0x02, 0x24, 0x01, 0x01, 0x00],
  [120, 0x00, 0x02, 0x24, 0x01, 0x01, 0x00],
  [140, 0x00, 0x02, 0x14, 0x01, 0x01, 0x00],
  [180, 0x00, 0x02, 0x13, 0x00, 0x00, 0x00],
  [220, 0x00, 0x02, 0x13, 0x00, 0x00, 0x00],
  [250, 0x00, 0x02, 0x11, 0x00, 0x00, 0x00],
  [280, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00],
  [310, 0x00, 0x41, 0x00, 0x00, 0x00, 0x00],
  [450, 0x00, 0x41, 0x00, 0x00, 0x00, 0x00],
  [588, 0x00, 0x40, 0x00, 0x00, 0x00, 0x00],
  [650, 0x00, 0x40, 0x00, 0x00, 0x00, 0x00]
];
// ёмкость кварца: порядок как в enum xtal_cap_value ядра
const XC_30P=0, XC_20P=1, XC_10P=2, XC_0P=3, XC_HI_0P=4;
const R82_XTAL_CAP=[[0x0b,XC_30P],[0x02,XC_20P],[0x01,XC_10P],[0x00,XC_0P],[0x10,XC_HI_0P]];
const r82Rev=v=>{ let r=0; for(let i=0;i<8;i++) if(v&(1<<i)) r|=0x80>>i; return r; };

class R82xxDvb{
  // cfg: {addr:0x74 (8 бит), xtal:16e6, chip:'R828D'}
  constructor(bus,cfg){
    this.bus=bus; this.addr=cfg.addr; this.xtal=cfg.xtal; this.chip=cfg.chip||'R828D';
    this.regs=new Uint8Array(R82_N); this.xtalCap=XC_HI_0P; this.initDone=false; this.hasLock=false;
    this.intFreq=0; this.filCal=0; this.type=0; this.delsys=''; this.bw=0; this.log=[];
  }
  async write(reg,vals){                                       // у платы max_i2c_msg_len = 2: по одному регистру
    for(let i=0;i<vals.length;i++){
      const r=reg+i-R82_SHADOW;
      if(r>=0 && r<R82_N) this.regs[r]=vals[i];
      await this.bus.w(this.addr,[reg+i,vals[i]]);
    }
  }
  w1(reg,v){ return this.write(reg,[v&0xff]); }
  wm(reg,v,mask){                                              // запись под маской по теневой копии
    const r=reg-R82_SHADOW; if(r<0 || r>=R82_N) throw new Error('tuner reg '+reg);
    return this.write(reg,[(this.regs[r]&~mask)|(v&mask)]);
  }
  async read(reg,len){
    const d=await this.bus.r(this.addr,reg,len), o=new Uint8Array(len);
    for(let i=0;i<len;i++) o[i]=r82Rev(d[i]);
    return o;
  }
  async id(){ return (await this.read(0,1))[0]; }               // у R820T / R828D: 0x69

  /* проверка ёмкости кварца: r820t_xtal_check */
  async xtalCheck(){
    this.regs.set(R82_INIT);
    await this.wm(0x10,0x0b,0x0b);
    await this.wm(0x1a,0x00,0x0c);
    await this.wm(0x13,0x7f,0x7f);
    await this.wm(0x13,0x00,0x40);
    let i;
    for(i=0;i<R82_XTAL_CAP.length;i++){
      await this.wm(0x10,R82_XTAL_CAP[i][0],0x1b);
      await this.bus.sleep(6);
      const d=await this.read(0,3);
      if(!(d[2]&0x40)) continue;
      const v=d[2]&0x3f;
      if(this.xtal===16000000 && (v>29 || v<23)) break;
      if(v!==0x3f) break;
    }
    if(i===R82_XTAL_CAP.length) throw new Error('tuner: crystal check failed');
    return R82_XTAL_CAP[i][1];
  }
  /* r820t_init без калибровки IMR (как no_imr_cal) */
  async init(){
    if(!this.initDone){
      await this.write(0x05,R82_INIT);
      let cap=0;
      for(let i=0;i<3;i++){ const c=await this.xtalCheck(); if(!i || c>cap) cap=c; }
      this.xtalCap=cap; this.initDone=true;
    }
    await this.write(0x05,R82_INIT);
  }
  async standby(){
    if(!this.initDone) return;
    for(const [r,v] of [[0x06,0xb1],[0x05,0x03],[0x07,0x3a],[0x08,0x40],[0x09,0xc0],[0x0a,0x36],[0x0c,0x35],[0x0f,0x68],[0x11,0x03],[0x17,0xf4],[0x19,0x0c]]) await this.w1(r,v);
    this.type=-1;
  }

  async setMux(freq){
    let mhz=Math.floor(freq/1000000), i;
    for(i=0;i<R82_RANGES.length-1;i++) if(mhz<R82_RANGES[i+1][0]) break;
    const g=R82_RANGES[i];
    await this.wm(0x17,g[1],0x08);
    await this.wm(0x1a,g[2],0xc3);
    await this.w1(0x1b,g[3]);
    let v;
    switch(this.xtalCap){
      case XC_30P: case XC_20P: v=g[4]|0x08; break;
      case XC_10P: v=g[5]|0x08; break;
      case XC_HI_0P: v=g[6]|0x00; break;
      default: v=g[6]|0x08;
    }
    await this.wm(0x10,v,0x0b);
    await this.wm(0x08,0,0x3f);                                // IMR не калибруется
    await this.wm(0x09,0,0x3f);
  }

  async setPll(freqHz){
    let freq=Math.floor(freqHz/1000), pllRef=Math.floor(this.xtal/1000), sleep=10;
    const vcoMin=1770000, vcoMax=vcoMin*2;
    let nSdm=2, sdm=0, mixDiv=2, divBuf=0, divNum=0;
    await this.wm(0x10,0,0x10);
    await this.wm(0x1a,0x00,0x0c);
    await this.wm(0x12,0x80,0xe0);
    while(mixDiv<=64){
      if(freq*mixDiv>=vcoMin && freq*mixDiv<vcoMax){
        divBuf=mixDiv;
        while(divBuf>2){ divBuf>>=1; divNum++; }
        break;
      }
      mixDiv<<=1;
    }
    let data=await this.read(0,5);
    const fine=(data[4]&0x30)>>4;
    if(this.chip!=='R828D'){
      if(fine>2) divNum--; else if(fine<2) divNum++;
    }
    await this.wm(0x10,(divNum<<5)&0xe0,0xe0);
    const vco=freq*mixDiv;
    let nint=Math.floor(vco/(2*pllRef)), fra=vco-2*pllRef*nint;
    if(fra<Math.floor(pllRef/64)) fra=0;
    else if(fra>Math.floor(pllRef*127/64)){ fra=0; nint++; }
    else if(fra>Math.floor(pllRef*127/128) && fra<pllRef) fra=Math.floor(pllRef*127/128);
    else if(fra>pllRef && fra<Math.floor(pllRef*129/128)) fra=Math.floor(pllRef*129/128);
    const ni=Math.floor((nint-13)/4), si=nint-4*ni-13;
    await this.w1(0x14,ni+(si<<6));
    await this.wm(0x12,fra ? 0x00 : 0x08,0x08);
    while(fra>1){
      if(fra>Math.floor(2*pllRef/nSdm)){
        sdm+=Math.floor(32768/(nSdm/2));
        fra-=Math.floor(2*pllRef/nSdm);
        if(nSdm>=0x8000) break;
      }
      nSdm=(nSdm<<1)&0xffff;
    }
    await this.w1(0x16,sdm>>8);
    await this.w1(0x15,sdm&0xff);
    let d;
    for(let i=0;i<2;i++){
      await this.bus.sleep(sleep+1);
      d=await this.read(0,3);
      if(d[2]&0x40) break;
      if(!i) await this.wm(0x12,0x60,0xe0);
    }
    if(!(d[2]&0x40)){ this.hasLock=false; return; }
    this.hasLock=true;
    await this.wm(0x1a,0x08,0x08);
  }

  async sysFreqSel(freq,delsys){
    let mixerTop,lnaTop,cp,divBufCur,lnaVth,mixVth,air1,cable2,lnaDis,filterCur;
    lnaTop=0xe5; lnaVth=0x53; mixVth=0x75; air1=0x00; cable2=0x00; lnaDis=14; filterCur=0x40;
    mixerTop=0x24; cp=0x38; divBufCur=0x30;
    if(delsys===DVB_SYS.T && (freq===506000000 || freq===666000000 || freq===818000000)){ mixerTop=0x14; cp=0x28; divBufCur=0x20; }
    if(delsys===DVB_SYS.C){ lnaVth=0x62; air1=0x60; }
    await this.wm(0x1d,lnaTop,0xc7);
    await this.wm(0x1c,mixerTop,0xf8);
    await this.w1(0x0d,lnaVth);
    await this.w1(0x0e,mixVth);
    await this.wm(0x05,air1,0x60);                             // вход «воздух» (Astrometa)
    await this.wm(0x06,cable2,0x08);
    await this.wm(0x11,cp,0x38);
    await this.wm(0x17,divBufCur,0x30);
    await this.wm(0x0a,filterCur,0x60);
    // LNA
    await this.wm(0x1d,0,0x38);
    await this.wm(0x1c,0,0x04);
    await this.wm(0x06,0,0x40);
    await this.wm(0x1a,0x30,0x30);
    await this.bus.sleep(250);
    await this.wm(0x1d,0x18,0x38);
    await this.wm(0x1c,mixerTop,0x04);
    await this.wm(0x1e,lnaDis,0x1f);
    await this.wm(0x1a,0x20,0x30);
  }

  /* r820t_set_tv_standard для цифрового ТВ; bwMHz — полоса канала, целые МГц */
  async setStandard(bwMHz,delsys){
    let ifk,cal,hp,ext,flt;                                     // if, filt_cal_lo, hp_cor, ext_enable, flt_ext_widest
    if(delsys===DVB_SYS.C){ ifk=5070; cal=73500; hp=0x0b; ext=0x40; flt=0x00; }
    else if(bwMHz<=6){ ifk=3570; cal=56000; hp=0x6b; ext=0x60; flt=0x00; }
    else if(bwMHz===7){ ifk=4570; cal=63000; hp=0x2a; ext=0x60; flt=0x00; }
    else{ ifk=4570; cal=68500; hp=0x0b; ext=0x60; flt=0x00; }
    const filtGain=0x10, imgR=0x00, filtQ=0x10, loopThrough=0x00, ltAtt=0x00, poly=0x60;
    this.regs.set(R82_INIT);
    await this.wm(0x0c,0,0x0f);                                  // imr_done = 0
    await this.wm(0x13,49,0x3f);                                  // VER_NUM
    await this.wm(0x1d,0x00,0x38);
    await this.bus.sleep(2);
    this.intFreq=ifk*1000;
    const need = this.type!==3 || delsys!==this.delsys || bwMHz!==this.bw;
    if(need){
      for(let i=0;i<2;i++){
        await this.wm(0x0b,hp,0x60);
        await this.wm(0x0f,0x04,0x04);
        await this.wm(0x10,0x00,0x03);
        await this.setPll(cal*1000);
        if(!this.hasLock) return;                                // как в ядре: молча, настройка идёт дальше
        await this.wm(0x0b,0x10,0x10);
        await this.bus.sleep(2);
        await this.wm(0x0b,0x00,0x10);
        await this.wm(0x0f,0x00,0x04);
        const d=await this.read(0,5);
        this.filCal=d[4]&0x0f;
        if(this.filCal && this.filCal!==0x0f) break;
      }
      if(this.filCal===0x0f) this.filCal=0;
    }
    await this.wm(0x0a,filtQ|this.filCal,0x1f);
    await this.wm(0x0b,hp,0xef);
    await this.wm(0x07,imgR,0x80);
    await this.wm(0x06,filtGain,0x30);
    await this.wm(0x1e,ext,0x60);
    await this.wm(0x05,loopThrough,0x80);
    await this.wm(0x1f,ltAtt,0x80);
    await this.wm(0x0f,flt,0x80);
    await this.wm(0x19,poly,0x60);
    this.delsys=delsys; this.type=3; this.bw=bwMHz;
  }
  /* generic_set_freq: freq — частота канала, Гц. Возвращает {lock, ifHz} */
  async tune(delsys,freq,bwHz){
    let bw=Math.floor((bwHz+500000)/1000000); if(!bw) bw=8;
    await this.bus.gate(true);
    try{
      await this.setStandard(bw,delsys);
      const lo=freq+this.intFreq;
      await this.setMux(lo);
      await this.setPll(lo);
      if(!this.hasLock) return {lock:false, ifHz:this.intFreq};
      await this.sysFreqSel(freq,delsys);
      return {lock:true, ifHz:this.intFreq};
    }finally{ await this.bus.gate(false); }
  }
}

/* ------------------------------- демодуляторы MN88473 / MN88472 ------------------------------- */
// банки регистров на I2C-адресах 0x18, 0x1a, 0x1c (8 бит: 0x30, 0x34, 0x38). Банк 2 — только по одному регистру
const MN_BANK=[0x30,0x34,0x38];

class Mn8847x{
  // kind: 473 | 472. xtal: 25 МГц у MN88473 (по умолчанию в драйвере), 20.5 МГц у MN88472 на этой плате
  constructor(bus,kind){
    this.bus=bus; this.kind=kind; this.clk= kind===473 ? 25000000 : 20500000; this.active=false; this.log=[];
  }
  w(b,reg,v){ return this.bus.w(MN_BANK[b],[reg,v&0xff]); }
  async wBulk(b,reg,bytes){ await this.bus.w(MN_BANK[b],[reg,...bytes]); }
  async r(b,reg){ return (await this.bus.r(MN_BANK[b],reg,1))[0]; }
  async rBulk(b,reg,len){ return await this.bus.r(MN_BANK[b],reg,len); }
  async chipId(){ return await this.r(2,0xff); }                // 0x03 — MN88473, 0x02 — MN88472
  async probeSleep(){ await this.w(2,0x05,0x3e); }

  /* firmware — Uint8Array (dvb-demod-mn88473-01.fw / dvb-demod-mn88472-02.fw из linux-firmware) или null, если уже загружена */
  async init(fw,onProgress){
    if(this.kind===472){ await this.w(2,0x05,0x00); await this.w(2,0x0b,0x00); await this.w(2,0x0c,0x00); }
    const st=await this.r(0,0xf5);
    if(st&0x01){
      if(!fw) throw new Error('firmware needed: '+(this.kind===473 ? 'dvb-demod-mn88473-01.fw' : 'dvb-demod-mn88472-02.fw'));
      await this.w(0,0xf5,0x03);
      const max=21;                                              // i2c_wr_max = 22 вместе с адресом регистра
      for(let p=0;p<fw.length;p+=max){
        await this.wBulk(0,0xf6,fw.subarray(p,Math.min(fw.length,p+max)));
        if(onProgress && (p/max)%100===0) onProgress(p/fw.length);
      }
      const par=await this.r(0,0xf8);
      if(par&0x10) throw new Error('firmware parity check failed');
      await this.w(0,0xf5,0x00);
    }
    if(this.kind===473){ await this.w(2,0x09,0x08); await this.w(2,0x08,0x1d); }
    else{ await this.w(2,0x08,0x1d); await this.w(0,0xd9,0xe3); }  // последовательный TS, переменная частота
    this.active=true;
  }
  async sleep(){
    this.active=false;
    if(this.kind===472){ await this.w(2,0x0c,0x30); await this.w(2,0x0b,0x30); }
    await this.w(2,0x05,0x3e);
  }

  /* set_frontend после настройки тюнера; ifHz — промежуточная частота тюнера */
  async tune(delsys,bwHz,ifHz,plp){
    if(!this.active) throw new Error('demodulator is not initialised');
    const T=delsys===DVB_SYS.T, T2=delsys===DVB_SYS.T2, C=delsys===DVB_SYS.C;
    const ifv=Math.round(ifHz*0x1000000/this.clk), ifb=[(ifv>>16)&255,(ifv>>8)&255,ifv&255];
    if(this.kind===473){
      const dsv= T ? 0x02 : T2 ? 0x03 : 0x04, b2_2d= T ? 0x23 : 0x3b, b0_d2= T ? 0x2a : 0x29;
      let conf;
      if(!C){
        conf= bwHz===6000000 ? [0xe9,0x55,0x55,0x1c,0x29,0x1c,0x29] : bwHz===7000000 ? [0xc8,0x00,0x00,0x17,0x0a,0x17,0x0a]
            : bwHz===8000000 ? [0xaf,0x00,0x00,0x11,0xec,0x11,0xec] : null;
        if(!conf) throw new Error('bandwidth '+bwHz+' is not supported');
      }else conf=[0x10,0xab,0x0d,0xae,0x1d,0x9d];
      for(const [r,v] of [[0x05,0x00],[0xfb,0x13],[0xef,0x13],[0xf9,0x13],[0x00,0x18],[0x01,0x01],[0x02,0x21],[0x03,dsv],[0x0b,0x00]]) await this.w(2,r,v);
      for(let i=0;i<3;i++) await this.w(2,0x10+i,ifb[i]);
      if(!C) for(let i=0;i<7;i++) await this.w(2,0x13+i,conf[i]);
      else await this.wBulk(1,0x10,conf);
      await this.w(2,0x2d,b2_2d); await this.w(2,0x2e,0x00); await this.w(2,0x56,0x0d);
      await this.wBulk(0,0x01,[0xba,0x13,0x80,0xba,0x91,0xdd,0xe7,0x28]);
      for(const [r,v] of [[0x0a,0x1a],[0x13,0x1f],[0x19,0x03],[0x1d,0xb0],[0x2a,0x72],[0x2d,0x00],[0x3c,0x00],[0x3f,0xf8]]) await this.w(0,r,v);
      await this.wBulk(0,0x40,[0xf4,0x08]);
      await this.w(0,0xd2,b0_d2); await this.w(0,0xd4,0x55); await this.w(1,0xbe,0x08); await this.w(0,0xb2,0x37); await this.w(0,0xd7,0x04);
      if(T2) await this.w(2,0x36,plp==null || plp<0 ? 0 : plp);
      await this.w(2,0xf8,0x9f);                                 // сброс автомата
    }else{
      const dsv= T ? 0x02 : T2 ? 0x03 : 0x04;
      const b0={b4:T?0x00:T2?0xf6:0x00, cd:T?0x1f:T2?0x01:0x17, d4:T?0x0a:0x09, d6:T?0x48:T2?0x46:0x48};
      let bwv=0, conf=null;
      if(!C){
        const tab={5000000:[0x03,[0xe5,0x99,0x9a,0x1b,0xa9,0x1b,0xa9]],6000000:[0x02,[0xbf,0x55,0x55,0x15,0x6b,0x15,0x6b]],
                   7000000:[0x01,[0xa4,0x00,0x00,0x0f,0x2c,0x0f,0x2c]],8000000:[0x00,[0x8f,0x80,0x00,0x08,0xee,0x08,0xee]]}[bwHz];
        if(!tab) throw new Error('bandwidth '+bwHz+' is not supported');
        bwv=tab[0]; conf=tab[1];
      }
      for(const [r,v] of [[0x00,0x66],[0x01,0x00],[0x02,0x01],[0x03,dsv],[0x04,bwv]]) await this.w(2,r,v);
      for(let i=0;i<3;i++) await this.w(2,0x10+i,ifb[i]);
      if(conf) for(let i=0;i<7;i++) await this.w(2,0x13+i,conf[i]);
      await this.w(0,0xb4,b0.b4); await this.w(0,0xcd,b0.cd); await this.w(0,0xd4,b0.d4); await this.w(0,0xd6,b0.d6);
      if(T){ await this.w(0,0x07,0x26); await this.w(0,0x00,0xba); await this.w(0,0x01,0x13); }
      else if(T2){ await this.w(2,0x2b,0x13); await this.w(2,0x4f,0x05); await this.w(1,0xf6,0x05); await this.w(2,0x32,plp==null || plp<0 ? 0 : plp); }
      await this.w(2,0xf8,0x9f);
    }
  }

  /* read_status: {lock, carrier, signal, strength (0…1023), cnr (дБ) | null} */
  async status(delsys){
    let u, st={signal:false, carrier:false, viterbi:false, lock:false, strength:null, cnr:null};
    if(delsys===DVB_SYS.T){
      u=await this.r(0,0x62);
      if(!(u&0xa0)){
        if((u&0x0f)>=0x09) Object.assign(st,{signal:true,carrier:true,viterbi:true,lock:true});
        else if((u&0x0f)>=0x03) Object.assign(st,{signal:true,carrier:true});
      }
    }else if(delsys===DVB_SYS.T2){
      u=await this.r(2,0x8b);
      if(!(u&0x40)){
        if((u&0x0f)>=0x0d) Object.assign(st,{signal:true,carrier:true,viterbi:true,lock:true});
        else if((u&0x0f)>=0x0a) Object.assign(st,{signal:true,carrier:true,viterbi:true});
        else if((u&0x0f)>=0x07) Object.assign(st,{signal:true,carrier:true});
      }
    }else{
      u=await this.r(1,0x85);
      if(!(u&0x40) && ((await this.r(1,0x89))&1)) Object.assign(st,{signal:true,carrier:true,viterbi:true,lock:true});
    }
    if(st.signal){
      const a=await this.r(2,0x86);
      st.strength=(a<<8)|(await this.r(2,0x87))|(a>>2);
    }
    if(st.viterbi){
      if(delsys===DVB_SYS.T){
        const b=await this.rBulk(0,0x8f,2), v=(b[0]<<8)|b[1];
        st.cnr= v ? 10*(Math.log10(65536/v)+0.2) : 0;
      }else if(delsys===DVB_SYS.T2){
        const b0=await this.r(2,0xb7), v=((await this.r(2,0xb8))<<8)|(await this.r(2,0xb9)), miso=(b0>>2)&1;
        st.cnr= v ? (miso ? 10*(Math.log10(16384/v)-0.6) : 10*(Math.log10(65536/v)+0.2)) : 0;
      }
    }
    return st;
  }
}

/* ------------------------------- RTL2832U: питание, проброс TS ------------------------------- */
// адреса блоков и регистров как в rtl28xxu.h
const DVB_REG={SYS_DEMOD_CTL:0x3000, GPIO_OUT_VAL:0x3001, GPIO_OUT_EN:0x3003, GPIO_DIR:0x3004, DEMOD_CTL1:0x300b,
               USB_SYSCTL_0:0x2000, EPA_CTL:0x2148, EPA_MAXPKT:0x2158, EPA_FIFO_CFG:0x2160};

/* io: {sys(reg) → Promise<byte>, sysW(reg,val,mask?), usbW(reg,bytes), demodR(page,addr), demodW(page,addr,val,len), i2cW, i2cR, sleep, clearHalt} */
const DvbRtl={
  // rtl28xxu_init: конечная точка потока
  async initEp(io){
    const v=await io.rd(DVB_REG.USB_SYSCTL_0);
    await io.wr(DVB_REG.USB_SYSCTL_0,v|0x09);
    await io.wrBytes(DVB_REG.EPA_MAXPKT,[0x00,0x02,0x00,0x00]);
    await io.wrBytes(DVB_REG.EPA_FIFO_CFG,[0x14,0x00,0x00,0x00]);
  },
  // начало rtl2832u_read_config: GPIO, затем шлюз I2C открыт
  async gpioProbe(io){
    await io.wrMask(DVB_REG.GPIO_DIR,0x00,0x40);
    await io.wrMask(DVB_REG.GPIO_OUT_EN,0x48,0x48);
  },
  // питание GPIO0 подчинённого демодулятора, как при пробе: сброс и подача
  async slavePower(io){
    await io.wrMask(DVB_REG.GPIO_OUT_VAL,0x00,0x01);
    await io.wrMask(DVB_REG.GPIO_OUT_EN,0x00,0x01);
    await io.sleep(50);
    await io.wrMask(DVB_REG.GPIO_OUT_VAL,0x01,0x01);
    await io.wrMask(DVB_REG.GPIO_DIR,0x00,0x01);
    await io.wrMask(DVB_REG.GPIO_OUT_EN,0x01,0x01);
    await io.sleep(20);
  },
  // rtl2832u_power_ctrl
  async power(io,on){
    if(on){
      await io.wrMask(DVB_REG.GPIO_OUT_VAL,0x08,0x18);
      await io.wrMask(DVB_REG.DEMOD_CTL1,0x00,0x10);
      await io.wrMask(DVB_REG.SYS_DEMOD_CTL,0x80,0x80);
      await io.wrMask(DVB_REG.SYS_DEMOD_CTL,0x20,0x20);
      await io.wrBytes(DVB_REG.EPA_CTL,[0x00,0x00]);
      await io.clearHalt();
    }else{
      await io.wrMask(DVB_REG.GPIO_OUT_VAL,0x10,0x10);
      await io.wrMask(DVB_REG.SYS_DEMOD_CTL,0x00,0x80);
      await io.wrBytes(DVB_REG.EPA_CTL,[0x10,0x02]);
    }
  },
  // rtl2832_slave_ts_ctrl: TS подчинённого демодулятора идёт через RTL2832 на USB
  async slaveTs(io,on){
    const mask=async(page,addr,v,m)=>{ const o=await io.demodR(page,addr); await io.demodW(page,addr,(o&~m)|(v&m),1); };
    if(on){
      await mask(1,0x01,0x00,0x04);                              // SOFT_RST = 0
      await io.demodW(1,0x0c,0x5fff,2);
      await mask(0,0x21,0x08,0x08);                              // PIP_ON = 1
      await io.demodW(0,0xbc,0x18,1);
      await io.demodW(1,0x92,0x7ff7ff,3);
    }else{
      await io.demodW(1,0x92,0x000fff,3);
      await io.demodW(0,0xbc,0x08,1);
      await mask(0,0x21,0x00,0x08);
      await io.demodW(1,0x0c,0x0000,2);
      await mask(1,0x01,0x04,0x04);
    }
  }
};

/* Диапазоны каналов: центральная частота и полоса, Гц */
function dvbChannel(n){
  n=n|0;
  if(n>=21 && n<=69) return {f:(474+8*(n-21))*1e6, bw:8e6};                 // UHF
  if(n>=5 && n<=12) return {f:(177.5+7*(n-5))*1e6, bw:7e6};                  // VHF III: 5 — 177.5 МГц … 12 — 226.5 МГц
  return null;
}
