// Несколько разных пресетов: без железа, с проверяемым результатом.
// fn выполняется в странице; true — успех, иначе строка с причиной.
export default [
  {name:'preset: Demo: Sweep and Waterfall', fn(){
    T.preset('Demo: Sweep and Waterfall'); const pk = T.run(1);
    const e = T.errors(); if(e.length) return e.join('; ');
    return pk > 0.01 || 'dac: silence';
  }},
  {name:'preset: RTTY: Transmit and Receive', fn(){
    T.preset('RTTY: Transmit and Receive'); T.run(6);
    const e = T.errors(); if(e.length) return e.join('; ');
    const txt = T.byType('serialRx')[0].text;
    return txt.includes('RYRY DE TEST') || 'decoded: '+JSON.stringify(txt);
  }},
  {name:'preset: APRS: Transmit and Receive (Loop)', fn(){
    T.preset('APRS: Transmit and Receive (Loop)'); T.run(3);
    const e = T.errors(); if(e.length) return e.join('; ');
    const rx = T.byType('ax25Rx')[0];
    return rx.out.crcOk > 0 || 'frames '+rx.out.frames+', crcOk '+rx.out.crcOk;
  }},
  {name:'preset: IQ: Receiver from Blocks (Generator)', fn(){
    T.preset('IQ: Receiver from Blocks (Generator)');
    const au = T.byType('iqAudio')[0], a = T.capture(au, 'out', 1, 0.5);
    const e = T.errors(); if(e.length) return e.join('; ');
    const f = T.toneHz(a, Eng.sr), pk = T.peak(a);
    return Math.abs(f-1000) < 2 && pk > 0.9 || `f=${f.toFixed(2)} peak=${pk.toFixed(3)}`;
  }},
  {name:'preset: USB SDR: FM Receiver from Blocks (not connected)', fn(){
    T.preset('USB SDR: FM Receiver from Blocks'); T.run(0.5);
    const e = T.errors(); return e.length ? e.join('; ') : true;
  }},
  {name:'preset: Techno: Drum Machine', fn(){
    T.preset('Techno: Drum Machine'); const pk = T.run(2);
    const e = T.errors(); if(e.length) return e.join('; ');
    return pk > 0.001 || 'dac: silence';
  }},
];
