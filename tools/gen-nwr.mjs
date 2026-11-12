// modules/nwr-data.js из списка передатчиков NOAA Weather Radio (https://www.weather.gov/source/nwr/JS/CCL.js — округ × передатчик).
// Файл разбирается как текст (регулярками), не исполняется.   node tools/gen-nwr.mjs /путь/к/CCL.js
import fs from 'node:fs';
const src=process.argv[2]; if(!src){ console.error('usage: node tools/gen-nwr.mjs <CCL.js>'); process.exit(1); }
const text=fs.readFileSync(src,'utf8'), rec=[];
for(const m of text.matchAll(/^([A-Z]+)\[(\d+)\] = "([^"]*)";$/gm)){ (rec[+m[2]] ||= {})[m[1]]=m[3]; }
const tx={}, cty={};
for(const r of rec){
  if(!r || !/^\d{6}$/.test(r.SAME||'') || !r.CALLSIGN) continue;
  const f=+r.FREQ, la=+r.LAT, lo=+r.LON;
  if(!(f>=162 && f<=163) || !isFinite(la) || !isFinite(lo)) continue;
  tx[r.CALLSIGN] ||= [f, +la.toFixed(4), +lo.toFixed(4), +r.PWR||0, r.SITENAME||r.SITELOC||'', r.SITESTATE||r.ST||'', r.WFO||'', r.STATUS==='NORMAL' ? 0 : 1];
  (cty[r.SAME] ||= []).includes(r.CALLSIGN) || cty[r.SAME].push(r.CALLSIGN);
}
const sort=o=>Object.fromEntries(Object.entries(o).sort(([a],[b])=>a<b?-1:1));
const out='"use strict";\n/* NOAA Weather Radio: передатчики и округа (SAME) из списка NWS (weather.gov/nwr), сгенерировано tools/gen-nwr.mjs.\n'+
  '   NWR_TX[позывной]=[МГц, широта, долгота, мощность Вт, место, штат, офис «город|штат», 1 — не в норме]; NWR_CTY[PSSCCC]=[позывные]. */\n'+
  'const NWR_TX='+JSON.stringify(sort(tx))+';\nconst NWR_CTY='+JSON.stringify(sort(cty))+';\n';
fs.writeFileSync(new URL('../modules/nwr-data.js',import.meta.url),out);
console.log(Object.keys(tx).length+' transmitters, '+Object.keys(cty).length+' counties, '+out.length+' bytes');
