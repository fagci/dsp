"use strict";
/* ============================ Ядро фото ============================
   Идентификаторы фото в ячейке таблицы, размер после сжатия, разбор EXIF (GPS, время) из JPEG.
   Без DOM — проверяется tools/test-photo.mjs. */

const PH_MAX=1600;
const phNewId=()=>'ph-'+Date.now().toString(36)+Math.random().toString(36).slice(2,7);
// ячейка «ph-a ph-b» (пробелы, запятые, ;) → ['ph-a','ph-b']; всё, что не похоже на id, отбрасывается
const phIds=cell=>String(cell??'').split(/[\s,;]+/).filter(s=>/^ph-[a-z0-9]+$/i.test(s));
const phJoin=ids=>ids.join(' ');
function phFit(w,h,max=PH_MAX){ const k=Math.min(1,max/Math.max(w,h)); return [Math.max(1,Math.round(w*k)),Math.max(1,Math.round(h*k))]; }

// EXIF из JPEG (ArrayBuffer): {lat,lon,alt,t (мс, местное время снимка),orient,make,model} или null
function phExif(buf){
  const v=new DataView(buf);
  if(v.byteLength<12 || v.getUint16(0)!==0xFFD8) return null;
  let o=2;
  while(o+4<v.byteLength){
    const mk=v.getUint16(o); if(mk===0xFFDA || (mk&0xFF00)!==0xFF00) break;
    const len=v.getUint16(o+2);
    if(mk===0xFFE1 && o+10<v.byteLength && v.getUint32(o+4)===0x45786966 && v.getUint16(o+8)===0) return phTiff(v,o+10);
    o+=2+len;
  }
  return null;
}
function phTiff(v,t){
  const le=v.getUint16(t)===0x4949, u16=p=>v.getUint16(p,le), u32=p=>v.getUint32(p,le), N=v.byteLength;
  if(u16(t+2)!==42) return null;
  const tags=off=>{                                              // IFD → Map тег → {type,cnt,vo}
    const m=new Map(); let p=t+off; if(p+2>N) return m;
    const n=u16(p); p+=2;
    for(let i=0;i<n && p+12<=N;i++,p+=12) m.set(u16(p),{type:u16(p+2),cnt:u32(p+4),vo:p+8});
    return m;
  };
  const dat=e=>{ const sz={1:1,2:1,3:2,4:4,5:8,7:1}[e.type]||1; return e.cnt*sz<=4 ? e.vo : t+u32(e.vo); };
  const rat=(e,i)=>{ const p=dat(e)+8*i; if(p+8>N) return NaN; const d=u32(p+4); return d ? u32(p)/d : NaN; };
  const str=e=>{ let s='', p=dat(e); for(let i=0;i<e.cnt-1 && p+i<N;i++) s+=String.fromCharCode(v.getUint8(p+i)); return s; };
  const out={}, i0=tags(u32(t+4));
  const mk=i0.get(0x010F), md=i0.get(0x0110), or=i0.get(0x0112);
  if(mk) out.make=str(mk); if(md) out.model=str(md); if(or) out.orient=u16(or.vo);
  const ex=i0.get(0x8769);
  if(ex){ const dt=tags(u32(ex.vo)).get(0x9003); if(dt){ const m=/(\d+):(\d+):(\d+) (\d+):(\d+):(\d+)/.exec(str(dt)); if(m) out.t=new Date(+m[1],m[2]-1,+m[3],+m[4],+m[5],+m[6]).getTime(); } }
  const gp=i0.get(0x8825);
  if(gp){
    const g=tags(u32(gp.vo)), dms=e=>e ? rat(e,0)+rat(e,1)/60+rat(e,2)/3600 : NaN;
    const la=dms(g.get(2)), lo=dms(g.get(4));
    if(isFinite(la) && isFinite(lo)){
      out.lat=g.get(1) && str(g.get(1))==='S' ? -la : la; out.lon=g.get(3) && str(g.get(3))==='W' ? -lo : lo;
      const al=g.get(6); if(al){ const a=rat(al,0); if(isFinite(a)) out.alt=(g.get(5) && v.getUint8(g.get(5).vo)===1 ? -a : a); }
    }
  }
  return Object.keys(out).length ? out : null;
}
