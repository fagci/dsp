"use strict";
/* ============================ Скины Table (без DOM) ============================
   Скин — набор CSS-переменных --tk-*, которыми рисуются карточки, строки со значками и сетка (styles.css: .tbl-card, .tbl-irow, .tc-body…).
   Выбранный скин и свои переменные лежат в схеме списка (card.skin, card.skinCss) и ездят вместе с ней. Свои переменные пишутся строкой
   «--tk-r:14px;--tk-av:48px»: допускаются только --tk-* и безопасные значения (числа с единицами, цвета, color-mix/var/rgba, тень, список слов) —
   url(), выражения и скобки вне белого списка отбрасываются. Проверяется tools/test-tblskin.mjs. */

const TBL_SKIN_VARS={               // что можно настраивать (подсказка в панели)
  '--tk-r':'corner radius of a card','--tk-pad':'padding inside a card','--tk-gap':'gap between cards','--tk-min':'minimal card width',
  '--tk-bg':'card background','--tk-bd':'card border colour','--tk-sh':'card shadow','--tk-rowpad':'padding of a row with an avatar',
  '--tk-av':'avatar size','--tk-tfs':'title font size','--tk-sfs':'second line font size','--tk-sep':'colour of the line between rows'};
const TBL_SKINS=[
  {id:'',title:'default',vars:{}},
  {id:'soft',title:'soft (rounded, shadow)',vars:{'--tk-r':'12px','--tk-pad':'8px 10px 10px','--tk-gap':'10px','--tk-bd':'transparent','--tk-bg':'color-mix(in srgb,var(--panel) 90%,#fff)','--tk-sh':'0 2px 8px rgba(0,0,0,.28)','--tk-rowpad':'8px 10px','--tk-av':'42px'}},
  {id:'flat',title:'flat (no borders)',vars:{'--tk-r':'4px','--tk-gap':'4px','--tk-bd':'transparent','--tk-bg':'var(--panel2)','--tk-sh':'none','--tk-sep':'transparent'}},
  {id:'outline',title:'outline',vars:{'--tk-r':'6px','--tk-bd':'var(--acc2)','--tk-bg':'transparent','--tk-gap':'8px'}},
  {id:'dense',title:'dense (small)',vars:{'--tk-r':'3px','--tk-pad':'2px 4px 3px','--tk-gap':'3px','--tk-min':'120px','--tk-rowpad':'2px 6px','--tk-av':'24px','--tk-tfs':'11px','--tk-sfs':'9px'}},
  {id:'big',title:'big cards',vars:{'--tk-r':'8px','--tk-pad':'8px 10px 10px','--tk-gap':'12px','--tk-min':'220px','--tk-rowpad':'10px 12px','--tk-av':'52px','--tk-tfs':'14px','--tk-sfs':'12px'}},
  {id:'messenger',title:'messenger (contact list)',vars:{'--tk-r':'0','--tk-rowpad':'8px 14px','--tk-av':'46px','--tk-tfs':'14px','--tk-sfs':'11px','--tk-sep':'color-mix(in srgb,var(--line) 40%,transparent)','--tk-bd':'transparent','--tk-gap':'0'}},
];
const tblSkin=id=>TBL_SKINS.find(s=>s.id===String(id||''))||TBL_SKINS[0];

// значение переменной: числа с единицами, цвета, var()/color-mix()/rgba()/hsl()/calc() без url и выражений, слова (transparent, none)
function tblSkinValue(v){
  v=String(v==null?'':v).trim();
  if(!v || v.length>120 || /url\s*\(|expression|javascript|[{}<>\;@]|\/\*|!/i.test(v)) return '';
  let depth=0; for(const ch of v){ if(ch==='(') depth++; else if(ch===')') depth--; if(depth<0) return ''; } if(depth) return '';
  const fns=(v.match(/[a-z-]+(?=\()/gi)||[]).map(f=>f.toLowerCase());
  if(fns.some(f=>!['var','color-mix','rgb','rgba','hsl','hsla','calc','min','max','clamp'].includes(f))) return '';
  if(!/^[#a-z0-9\s.,%()+*\/_-]+$/i.test(v)) return '';
  return v;
}
// «--tk-r:14px;--tk-av:48px» → {переменная: значение}, только известные --tk-*
function tblSkinParse(css){
  const out={};
  for(const part of String(css||'').split(';')){
    const i=part.indexOf(':'); if(i<1) continue;
    const k=part.slice(0,i).trim().toLowerCase(), v=tblSkinValue(part.slice(i+1));
    if(k in TBL_SKIN_VARS && v) out[k]=v;
  }
  return out;
}
// итоговые переменные списка: скин, поверх — свои
const tblSkinVars=(id,css)=>({...tblSkin(id).vars,...tblSkinParse(css)});
