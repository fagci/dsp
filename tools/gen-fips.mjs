// modules/fips-data.js из переписных данных пакета us-atlas (npm pack us-atlas; путь к распакованному package/ — аргумент)
// node tools/gen-fips.mjs /путь/к/package
import fs from 'node:fs';
import path from 'node:path';
const dir=process.argv[2]; if(!dir){ console.error('usage: node tools/gen-fips.mjs <us-atlas/package>'); process.exit(1); }
const rd=f=>JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'));
const st={}, co={};
for(const g of rd('states-10m.json').objects.states.geometries) st[g.id]=g.properties.name;
for(const g of rd('counties-10m.json').objects.counties.geometries) co[g.id]=g.properties.name;
const sort=o=>Object.fromEntries(Object.entries(o).sort(([a],[b])=>a<b?-1:1));
const out='"use strict";\n/* Названия штатов и округов США по FIPS (SSCCC): данные переписи через npm-пакет us-atlas 3.0.1 (ISC). Сгенерировано tools/gen-fips.mjs. */\n'+
  'const FIPS_STATES='+JSON.stringify(sort(st))+';\nconst FIPS_COUNTIES='+JSON.stringify(sort(co))+';\n';
fs.writeFileSync(new URL('../modules/fips-data.js',import.meta.url),out);
console.log(Object.keys(st).length+' states, '+Object.keys(co).length+' counties, '+out.length+' bytes');
