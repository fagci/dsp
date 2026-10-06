"use strict";
/* ============================ WASM SIMD: ядра ============================
   ЭТОТ ФАЙЛ СОБИРАЕТСЯ tools/simd/build.sh из tools/simd/*.c — не править руками.
   Модуль (808 байт) вшит в base64: воркеру острова нужна синхронная инициализация. Нет WebAssembly SIMD — iqSimd() даёт null,
   и ядра остаются на JS. Память — одна на контекст; временные массивы ядер раскладываются по ней на время одного вызова (simdAlloc),
   рост памяти пересоздаёт окна — после simdAlloc берите simdF32() заново. */
const SIMD_WASM_B64='AGFzbQEAAAABCwFgB39/f39/f38AAg8BA2VudgZtZW1vcnkCAAIDAgEABggBfwFBgIgECwcIAQRwb2x5AAAK5wUB5AUECX8BewF/A3sCQCAFQQFIDQACQCAGQQFIDQAgBCAFQQJ0IgdqQXBqIQggAyAHakFwaiEJIAVBA3QhBCAGQf7///8HcSEDIAZBAXEhCiAAIAdqIQsgASAHaiEMIAIgB2ohDUEAIQ5BACEPA0D9DAAAAAAAAAAAAAAAAAAAAAAhEEEAIRECQAJAIAZBAUcNACAQIRIMAQsgDiEHIBAhEgNAIBAgACAHav0AAAAiEyACIAdq/QAAAP3mAf3kASALIAdq/QAAACIUIA0gB2r9AAAA/eYB/eQBIRAgEiATIAEgB2r9AAAA/eYB/eQBIBQgDCAHav0AAAD95gH95AEhEiAHIARqIQcgAyARQQJqIhFHDQALCyAPQQJ0IQcCQCAKRQ0AIBAgACAHaiARIAVsQQJ0IhFq/QAAACITIAIgB2ogEWr9AAAA/eYB/eQBIRAgEiATIAEgB2ogEWr9AAAA/eYB/eQBIRILIAkgB2sgEiAS/Q0MDQ4PCAkKCwQFBgcAAQID/QsAACAIIAdrIBAgEP0NDA0ODwgJCgsEBQYHAAECA/0LAAAgDkEQaiEOIA9BBGoiDyAFSA0ADAILCyAFQX9qQQJ2QQFqIgdBA3EhAv0MAAAAAAAAAAAAAAAAAAAAACIQIBD9DQwNDg8ICQoLBAUGBwABAgMhEEEAIQACQCAFQQ1JDQAgB0H8////B3EiAUECdCEAIAMgBUECdEFAaiIRaiEHIAQgEWohEQNAIAdBMGogEP0LAAAgEUEwaiAQ/QsAACAHQSBqIBD9CwAAIBFBIGogEP0LAAAgB0EQaiAQ/QsAACARQRBqIBD9CwAAIAcgEP0LAAAgESAQ/QsAACAHQUBqIQcgEUFAaiERIAFBfGoiAQ0ACwsgAkUNACADIAVBAnQgAEECdGtBcGoiEWohByAEIBFqIREDQCAHIBD9CwAAIBEgEP0LAAAgB0FwaiEHIBFBcGohESACQX9qIgINAAsLCw==';
let SIMD=undefined, SIMD_OFF=false;                    // SIMD_OFF — принудительно JS (сверка в тестах)
function iqSimd(){
  if(SIMD_OFF) return null;
  if(SIMD!==undefined) return SIMD;
  SIMD=null;
  try{
    if(typeof WebAssembly!=='object' || typeof atob!=='function') return null;
    const s=atob(SIMD_WASM_B64), b=new Uint8Array(s.length);
    for(let i=0;i<s.length;i++) b[i]=s.charCodeAt(i);
    if(!WebAssembly.validate(b)) return null;
    const mem=new WebAssembly.Memory({initial:64});    // 4 МБ, растёт по требованию
    const inst=new WebAssembly.Instance(new WebAssembly.Module(b),{env:{memory:mem}});
    SIMD={mem, poly:inst.exports.poly, f32:new Float32Array(mem.buffer)};
  }catch(e){ SIMD=null; }
  return SIMD;
}
// гарантирует floats четырёхбайтовых слов в памяти; возвращает окно Float32Array (после роста — новое)
function simdAlloc(sm,floats){
  const need=floats*4;
  if(need>sm.mem.buffer.byteLength){ sm.mem.grow(Math.ceil((need-sm.mem.buffer.byteLength)/65536)); sm.f32=new Float32Array(sm.mem.buffer); }
  return sm.f32;
}
