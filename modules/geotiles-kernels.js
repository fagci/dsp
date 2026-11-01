"use strict";
/* Здоровье источников растровых тайлов карты и запасные источники — без DOM, проверяется в tools/test-geotiles.mjs.
   Публичные серверы тайлов то и дело отвечают 403 / 429 (политика OSM, лимиты, блокировки по Referer): тогда основа молча пустеет.
   Мы считаем подряд неудавшиеся загрузки по сети и, когда источник «лёг», временно берём запасной того же склада. */

const GEO_TILE_DOWN_RUN=4, GEO_TILE_DOWN_MS=300000;     // 4 неудачи подряд → источник считается лёгшим на 5 минут, потом пробуем снова
// запасные основы по порядку (названия из GEO_TILES); спутник и рельеф не подменяем улицами — это другая карта
const GEO_TILE_FB={
  'OSM':['OSM Humanitarian','CARTO Light','OpenTopoMap'],
  'OpenTopoMap':['Esri Topo','OSM Humanitarian','CARTO Light'],
  'OSM Humanitarian':['CARTO Light','OSM'],
  'CyclOSM':['OSM Humanitarian','CARTO Light'],
  'CARTO Light':['OSM Humanitarian','OSM'],
  'CARTO Dark':['CARTO Light','OSM Humanitarian'],
  'OpenFreeMap (vector)':['CARTO Light','OSM Humanitarian'],
  'OpenFreeMap Dark (vector)':['CARTO Dark','CARTO Light'],
  'Esri Topo':['OpenTopoMap','OSM Humanitarian'],
  'Esri Streets':['CARTO Light','OSM Humanitarian'],
};

// итог сетевой загрузки тайла: ok — получен; code — HTTP-статус или 0 (сеть / CORS)
function geoTileMark(stat,id,ok,code,now){
  const s=stat[id]||(stat[id]={run:0,ok:0,bad:0,code:0,t:0});
  if(ok){ s.ok++; s.run=0; s.code=0; }
  else { s.bad++; s.run++; s.code=code|0; s.t=now; }
}
function geoTileDown(stat,id,now){ const s=stat[id]; return !!s && s.run>=GEO_TILE_DOWN_RUN && now-s.t<GEO_TILE_DOWN_MS; }

// какую основу рисовать: name, если жива; иначе первая живая из запасных, существующих в have (набор имён). from — что подменили, code — последний статус
function geoTileChoose(name,have,stat,now){
  if(!geoTileDown(stat,name,now)) return {name,from:null,code:0};
  for(const f of GEO_TILE_FB[name]||[]) if(have.includes(f) && !geoTileDown(stat,f,now)) return {name:f,from:name,code:stat[name].code};
  return {name,from:null,code:0};                         // запасных нет / все лежат — оставляем выбранный, пусть пробует
}
function geoTileNote(from,to,code){ return 'tiles: '+from+(code ? ' HTTP '+code : ' unreachable')+' → '+to; }
