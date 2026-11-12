"use strict";
/* ======================= SUNRISE ALARM — ядро =======================
   Будильник-рассвет без DOM (node tools/test-sunrise.mjs): по времени побудки и длине рассвета считает фазу
   (wait → ramp → hold → done), долю рассвета, свет, цвет и громкость. Свет растёт сразу, звук входит позже (soundAt),
   цвет идёт по небу: тёмно-красный → оранжевый → янтарь → тёплый белый. Время — местное. */

const SUN_DAYS=['every day','weekdays','weekends'];
const SUN_STOPS=[[0,[0,0,0]],[.12,[56,10,6]],[.35,[190,60,20]],[.6,[255,140,50]],[.82,[255,196,120]],[1,[255,240,216]]];   // доля рассвета → цвет
const SUN_CURVES=['gamma','linear','cosine'];

function sunParseTime(s){                                           // «7:00» → минуты от полуночи; мусор → 7:00
  const m=/^\s*(\d{1,2})[:.h]?(\d{2})?\s*$/.exec(String(s||'')); if(!m) return 420;
  return Math.min(23,+m[1])*60+Math.min(59,+(m[2]||0));
}
function sunDayOk(days,wd){ return days==='weekdays' ? wd>=1 && wd<=5 : days==='weekends' ? wd===0 || wd===6 : true; }
function sunFmtTime(min){ const p=v=>String(v).padStart(2,'0'); return Math.floor(min/60)+':'+p(min%60); }

// все побудки в окне [-1 … +2] суток от now, мс (местное время)
function sunWakes(now, hhmm, days){
  const m=sunParseTime(hhmm), d=new Date(now), out=[];
  for(let k=-1;k<=7;k++){
    const t=new Date(d.getFullYear(), d.getMonth(), d.getDate()+k, Math.floor(m/60), m%60, 0, 0);
    if(sunDayOk(days,t.getDay())) out.push(t.getTime());
  }
  return out;
}

// cfg: {time, days, lead (мин рассвета), hold (мин удержания после побудки), dismissed (мс побудки, от которой отказались), over:{W,lead}}
// → {phase, left (с до побудки; после — 0), frac (0…1 по рассвету), wake (мс), leadMs}
function sunState(now, cfg){
  const leadMs=Math.max(1,+cfg.lead||30)*60000, holdMs=Math.max(0,+cfg.hold||0)*60000;
  const list=cfg.over ? [cfg.over.W] : sunWakes(now,cfg.time,cfg.days);
  const lead=cfg.over ? cfg.over.lead : leadMs;
  for(const W of list){
    if(cfg.dismissed===W) continue;
    if(now>=W-lead && now<W) return {phase:'ramp', left:(W-now)/1000, frac:(now-(W-lead))/lead, wake:W, leadMs:lead};
    if(now>=W && now<W+holdMs) return {phase:'hold', left:0, frac:1, wake:W, leadMs:lead};
  }
  for(const W of list) if(W-lead>now && cfg.dismissed!==W) return {phase:'wait', left:(W-now)/1000, frac:0, wake:W, leadMs:lead};
  return {phase:'done', left:Infinity, frac:0, wake:null, leadMs:lead};
}

const sunClamp=x=>x<0 ? 0 : x>1 ? 1 : x;
// доля рассвета → яркость: gamma (почти не видно сначала, потом быстрее — как настоящий рассвет), linear, cosine
function sunLight(frac,curve,gamma){
  const f=sunClamp(frac);
  return curve==='linear' ? f : curve==='cosine' ? .5-.5*Math.cos(Math.PI*f) : Math.pow(f, Math.max(.5,+gamma||2));
}
// звук входит с доли soundAt и растёт квадратично (ухо слышит громкость логарифмически)
function sunGain(frac,soundAt){
  const a=sunClamp(soundAt), f=sunClamp(frac);
  if(f<=a) return 0; const u=a>=1 ? 1 : (f-a)/(1-a);
  return u*u;
}
// цвет неба: по опорным точкам, линейно в RGB; hex при полной яркости
function sunColor(frac){
  const f=sunClamp(frac);
  for(let i=1;i<SUN_STOPS.length;i++){
    const [f1,c1]=SUN_STOPS[i], [f0,c0]=SUN_STOPS[i-1];
    if(f<=f1){ const u=(f-f0)/(f1-f0||1); return c0.map((v,k)=>Math.round(v+(c1[k]-v)*u)); }
  }
  return SUN_STOPS[SUN_STOPS.length-1][1].slice();
}
const sunHex=rgb=>'#'+rgb.map(v=>Math.max(0,Math.min(255,Math.round(v))).toString(16).padStart(2,'0')).join('');
// цветовая температура, К: 1500 (свеча) → 5500 (утренний свет)
const sunKelvin=frac=>Math.round(1500+4000*sunClamp(frac));
// всё вместе для одного момента: свет/цвет/звук/подпись
function sunMix(st, cfg){
  const frac=st.phase==='ramp' || st.phase==='hold' ? st.frac : 0;
  const light=sunLight(frac,cfg.curve,cfg.gamma)*(st.phase==='done'||st.phase==='wait' ? 0 : 1)*sunClamp(cfg.maxLight==null ? 1 : cfg.maxLight);
  const gain=sunGain(frac,cfg.soundAt)*sunClamp(cfg.vol==null ? 1 : cfg.vol)*(st.phase==='ramp'||st.phase==='hold' ? 1 : 0);
  const rgb=sunColor(frac);
  return {light, gain, rgb, hex:sunHex(rgb), kelvin:sunKelvin(frac)};
}
// «через 7:32:10» / «до побудки 12 мин»
function sunLeftTxt(s){
  if(!isFinite(s)) return '—'; s=Math.max(0,Math.ceil(s-1e-9));
  const h=Math.floor(s/3600), m=Math.floor(s%3600/60), x=s%60, p=v=>String(v).padStart(2,'0');
  return h ? h+':'+p(m)+':'+p(x) : m+':'+p(x);
}

if(typeof module!=='undefined') module.exports={SUN_DAYS,SUN_STOPS,SUN_CURVES,sunParseTime,sunDayOk,sunFmtTime,sunWakes,sunState,sunLight,sunGain,sunColor,sunHex,sunKelvin,sunMix,sunLeftTxt};
