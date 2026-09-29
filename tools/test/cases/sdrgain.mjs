// USB SDR, R820T/R828D (в т.ч. RTL-SDR Blog V4): ручное усиление как в librtlsdr, ползунок снимает auto
export default [
  {name:'rtl gain: every librtlsdr step maps to itself, in-between rounds up', fn(){
    // r82xx_gains[] из librtlsdr.c (rtl-sdr-blog), десятые дБ
    const G = [0, 9, 14, 27, 37, 77, 87, 125, 144, 157, 166, 197, 207, 229, 254, 280, 297, 328, 338, 364, 372, 386, 402, 421, 434, 439, 445, 480, 496];
    for(const g of G){ const r = r82xxGainSteps(g/10); if(Math.round(r.db*10) !== g) return g+' → '+JSON.stringify(r); }
    const a = r82xxGainSteps(20), b = r82xxGainSteps(49.6), c = r82xxGainSteps(0);
    if(a.db !== 20.7 || b.lna !== 15 || b.mix !== 14 || c.lna || c.mix) return JSON.stringify([a, b, c]);
    // монотонно: больше дБ — не меньше ступеней
    let prev = -1; for(let g=0; g<=49.6; g+=.1){ const d = r82xxGainSteps(g).db; if(d < prev) return 'not monotonic at '+g; prev = d; }
    return true;
  }},
  {name:'rtl gain: USB worker source has the gain tables and compiles', fn(){
    if(!/R82XX_LNA_STEPS=\[/.test(RTL_USB_WORKER_SRC) || !/function r82xxGainSteps/.test(RTL_USB_WORKER_SRC)) return 'tables missing';
    try{ new Function(RTL_USB_WORKER_SRC); }catch(e){ return 'syntax: '+e.message; }
    return true;
  }},
  {name:'rtl gain: moving the gain slider or wiring gain turns auto off', fn(){
    const n = T.build([['rtlsdr', {sr:'1024000', auto:true}]], [])[0];
    const s = MOD.rtlsdr.params.find(p => p.n === 'gainDb');
    n.p.gainDb = 35; s.fn(n);
    if(n.p.auto !== false || sdrGainKey(n) !== 'g35') return 'slider: auto '+n.p.auto+' key '+sdrGainKey(n);
    const m = T.build([['const', {}], ['rtlsdr', {sr:'1024000', auto:true}]], ['0.out>1.gainDb'])[1];
    T.run(.1);
    return m.p.auto === false || 'wired: auto '+m.p.auto;
  }},
];
