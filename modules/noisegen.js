"use strict";
/* ============================ Noise Generator ============================
   Несколько шумов сразу (white / pink / brown / blue / violet) — каждый со своим уровнем, без эквалайзера: спектр задаёт сам цвет шума.
   Рядом генеративные звуки, которые не повторяются: дождь, прибой, ветер с порывами, случайные колокольчики в строе (пентатоника…),
   сердцебиение и тон разностной частоты (binaural — в разные уши, monaural — смесь в обоих, isochronic — пульсирующий тон для колонок).
   Пульсация подложки (AM, Гц) — «изохронный шум». Входы vol / carrier / beat / pulse / bpm принимают числа: Table, Breath Pacer, LFO.
   Ядро — modules/noisegen-kernels.js (tools/test-noisegen.mjs). */

const nsgOn=k=>n=>n.p[k]>0;
def({ id:'noisegen', title:'Noise Generator', cat:'Sources', w:280, readout:true,
  kw:'white pink brown red blue violet noise colour color rain sea ocean waves wind chimes bells heartbeat binaural monaural isochronic sleep relax focus masking nature ambient generative sound health',
  outs:[{n:'L',t:'sig'},{n:'R',t:'sig'},{n:'out',t:'sig'}],
  ins:[{n:'vol',t:'num'},{n:'carrier',t:'num'},{n:'beat',t:'num'},{n:'pulse',t:'num'},{n:'bpm',t:'num'}],
  params:[
    {n:'vol',t:'range',min:0,max:1,step:.01,d:.5,label:'volume'},
    {n:'width',t:'range',min:0,max:1,step:.01,d:1,label:'stereo width',tip:'0 — one noise in both ears, 1 — different noise in each ear (wide, enveloping)'},
    {n:'white',t:'range',min:0,max:1,step:.01,d:0,label:'white · flat',tip:'flat spectrum: hiss, masks speech'},
    {n:'pink',t:'range',min:0,max:1,step:.01,d:.6,label:'pink · −3 dB/oct',tip:'equal energy per octave: the sound of a waterfall, a steady fan'},
    {n:'brown',t:'range',min:0,max:1,step:.01,d:0,label:'brown · −6 dB/oct',tip:'deep rumble: distant thunder, a jet cabin'},
    {n:'blue',t:'range',min:0,max:1,step:.01,d:0,label:'blue · +3 dB/oct'},
    {n:'violet',t:'range',min:0,max:1,step:.01,d:0,label:'violet · +6 dB/oct'},
    {n:'rain',t:'range',min:0,max:1,step:.01,d:0,label:'rain'},
    {n:'density',t:'range',min:10,max:600,step:1,d:120,log:true,label:'drops/s per ear',if:nsgOn('rain')},
    {n:'waves',t:'range',min:0,max:1,step:.01,d:0,label:'waves (surf)'},
    {n:'period',t:'range',min:3,max:20,step:.1,d:9,label:'wave period, s',if:nsgOn('waves')},
    {n:'wind',t:'range',min:0,max:1,step:.01,d:0,label:'wind (gusts)'},
    {n:'chimes',t:'range',min:0,max:1,step:.01,d:0,label:'chimes (random bells)'},
    {n:'rate',t:'range',min:1,max:60,step:1,d:8,label:'chimes per minute',if:nsgOn('chimes')},
    {n:'scale',t:'select',opts:Object.keys(NSG_SCALES),d:'pentatonic',label:'scale',if:nsgOn('chimes')},
    {n:'root',t:'range',min:36,max:84,step:1,d:60,label:'root (MIDI note)',if:nsgOn('chimes')},
    {n:'heart',t:'range',min:0,max:1,step:.01,d:0,label:'heartbeat'},
    {n:'bpm',t:'range',min:30,max:140,step:1,d:60,label:'heart rate, bpm',if:nsgOn('heart')},
    {n:'tone',t:'range',min:0,max:1,step:.01,d:0,label:'tone (beat)',tip:'carrier tone with a beat: binaural — two frequencies, one per ear (headphones!); monaural — both mixed in each ear; isochronic — one tone pulsing at the beat frequency (works on speakers)'},
    {n:'mode',t:'select',opts:NSG_MODES,d:'binaural',label:'tone mode',if:nsgOn('tone')},
    {n:'carrier',t:'range',min:40,max:1000,step:1,d:200,log:true,label:'carrier, Hz',if:nsgOn('tone')},
    {n:'beat',t:'range',min:.5,max:40,step:.1,d:10,label:'beat, Hz',if:nsgOn('tone')},
    {n:'pulse',t:'range',min:0,max:40,step:.1,d:0,label:'bed pulse (AM), Hz',tip:'amplitude pulsation of the noise and nature layers (isochronic noise); 0 — off'},
    {n:'depth',t:'range',min:0,max:1,step:.01,d:.5,label:'pulse depth',if:n=>n.p.pulse>0},
    {n:'seed',t:'range',min:0,max:9999,step:1,d:0,adv:true,label:'seed (0 — random)',fn:n=>{ n.S=null; }},
  ],
  init:n=>{ n.S=null; n.info=''; },
  process(n,I){
    for(const k of ['vol','carrier','beat','pulse','bpm']) if(typeof I[k]==='number' && isFinite(I[k])) setMod(n,k,I[k]);
    if(!n.S || n.S.sr!==Eng.sr) n.S=nsgInit(Eng.sr, n.p.seed>0 ? n.p.seed : (Math.random()*4294967295)>>>0);
    const L=buf(n,'L'), R=buf(n,'R'), M=buf(n,'out');
    nsgRender(n.S,n.p,L,R,BLOCK);
    for(let i=0;i<BLOCK;i++) M[i]=(L[i]+R[i])*.5;
    return {L, R, out:M}; },
  draw(n){
    const p=n.p, on=NSG_KEYS.filter(k=>p[k]>0);
    let s=on.length ? on.map(k=>k+(p[k]<.995 ? ' '+Math.round(p[k]*100)+'%' : '')).join(' · ') : 'silent';
    if(p.tone>0) s+=` — ${p.mode} ${(+p.carrier).toFixed(0)} Hz, beat ${(+p.beat).toFixed(1)} Hz`;
    roText(n,s); }});
