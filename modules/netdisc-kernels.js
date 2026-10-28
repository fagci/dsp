"use strict";
/* Обнаружение устройств в сети: SSDP / UPnP (медиа-серверы и -плееры, роутеры, принтеры, ТВ) и mDNS / DNS-SD (AirPlay, Chromecast,
   принтеры IPP, SMB, SSH…). SSDP — свой, на UDP приложения (M-SEARCH, ответы приходят одноадресно); mDNS — через nsd.* приложения
   (по одному типу за раз, как требует Android). Без DOM — tools/test-netdisc.mjs. */

const DISC_MDNS=['_ipp._tcp','_printer._tcp','_airplay._tcp','_raop._tcp','_googlecast._tcp','_spotify-connect._tcp','_sonos._tcp','_hap._tcp','_smb._tcp','_ftp._tcp','_ssh._tcp','_http._tcp','_workstation._tcp','_daap._tcp','_adb-tls-connect._tcp','_nvstream._tcp'];
const DISC_SSDP_TARGETS=['239.255.255.250:1900','255.255.255.255:1900'];

const ssdpSearch=(st='ssdp:all',mx=2)=>'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: '+mx+'\r\nST: '+st+'\r\nUSER-AGENT: DSP/1 UPnP/1.1\r\n\r\n';
function ssdpParse(text){
  const lines=String(text).split(/\r?\n/), first=lines[0]||'';
  const kind=/^HTTP\/1\.\d 200/.test(first) ? 'response' : /^NOTIFY /.test(first) ? 'notify' : /^M-SEARCH /.test(first) ? 'search' : '';
  if(!kind) return null;
  const h={}; for(const l of lines.slice(1)){ const i=l.indexOf(':'); if(i>0) h[l.slice(0,i).trim().toLowerCase()]=l.slice(i+1).trim(); }
  return {kind,st:h.st||h.nt||'',usn:h.usn||'',location:h.location||'',server:h.server||'',nts:h.nts||'',cache:h['cache-control']||'',headers:h};
}
const xmlText=(xml,tag)=>{ const m=new RegExp('<'+tag+'(?:\\s[^>]*)?>([\\s\\S]*?)</'+tag+'>','i').exec(xml); return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g,'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&').trim() : ''; };
// описание устройства UPnP (корневой XML по LOCATION): имя, изготовитель, модель, службы
function upnpParseDesc(xml){
  const dev=/<device>([\s\S]*)<\/device>/i.exec(xml); const d=dev ? dev[1] : xml;
  const head=d.replace(/<(serviceList|deviceList|iconList)>[\s\S]*?<\/\1>/gi,'');          // поля самого устройства, без вложенных
  const services=[]; for(const m of xml.matchAll(/<service>([\s\S]*?)<\/service>/gi)) services.push({type:xmlText(m[1],'serviceType'),id:xmlText(m[1],'serviceId'),control:xmlText(m[1],'controlURL'),events:xmlText(m[1],'eventSubURL'),scpd:xmlText(m[1],'SCPDURL')});
  return {name:xmlText(head,'friendlyName'),manufacturer:xmlText(head,'manufacturer'),model:xmlText(head,'modelName'),modelNumber:xmlText(head,'modelNumber'),
    description:xmlText(head,'modelDescription'),type:xmlText(head,'deviceType'),udn:xmlText(head,'UDN'),presentation:xmlText(head,'presentationURL'),serial:xmlText(head,'serialNumber'),services};
}
// что это за устройство — по типу UPnP / типу сервиса DNS-SD
function discKind(s){
  s=String(s||'').toLowerCase();
  if(/mediarenderer|raop|airplay|googlecast|spotify|sonos/.test(s)) return /raop|spotify|sonos/.test(s) ? 'speaker' : /googlecast|airplay/.test(s) ? 'cast' : 'media renderer';
  if(/mediaserver|daap/.test(s)) return 'media server';
  if(/printer|ipp|pdl-datastream|scanner/.test(s)) return /scanner/.test(s) ? 'scanner' : 'printer';
  if(/internetgateway|wanconnection|wandevice|wlanaccess/.test(s)) return 'router';
  if(/smb|nfs|afp/.test(s)) return 'file share';
  if(/_ssh|sftp|workstation/.test(s)) return 'computer';
  if(/camera|nvstream|ipcam/.test(s)) return 'camera';
  if(/hap|homekit|zigbee/.test(s)) return 'smart home';
  if(/_http|upnp|basic/.test(s)) return 'web';
  return '';
}

/* o: ssdp (bool), st, mx, mdns (список типов или []), mdnsWait (мс на тип), wait (мс на SSDP), desc (скачать описание), targets, onRec, stop() */
async function discRun(ns,o={}){
  const emit=o.onRec||(()=>{}), stop=o.stop||(()=>false), found=new Map(), t0=Date.now();
  let n=0;
  if(o.ssdp!==false){
    const u=await ns.udpOpen(0,true);
    try{
      const targets=o.targets||DISC_SSDP_TARGETS, wait=o.wait||3000;
      const send=async()=>{ for(const t of targets){ const [h,p]=t.split(':'); try{ await u.send(h,+p,ssdpSearch(o.st||'ssdp:all',Math.max(1,Math.round(wait/1500))),{broadcast:true}); }catch(e){} } };
      await send();
      let again=false; const end=Date.now()+wait;
      while(Date.now()<end && !stop()){
        if(!again && Date.now()>end-wait*0.6){ again=true; await send(); }           // второй запрос: UDP теряется
        let d; try{ d=await u.recv(Math.max(50,Math.min(500,end-Date.now()))); }catch(e){ continue; }
        if(!d) break;
        const p=ssdpParse(nsDec(d.bytes)); if(!p || p.kind==='search') continue;
        const ip=d.peer.replace(/:\d+$/,''), key=ip+'|'+(p.usn||p.location||p.st);
        if(found.has(key)) continue;
        const r={src:'disc',via:'ssdp',ip,st:p.st,usn:p.usn,location:p.location,server:p.server,kind:discKind(p.st+' '+p.usn),t:Date.now()};
        found.set(key,r); n++; emit(r);
      }
    } finally { await u.close(); }
    // описания: по одному на LOCATION
    if(o.desc!==false && !stop()){
      const locs=new Map(); for(const r of found.values()) if(r.location && !locs.has(r.location)) locs.set(r.location,r);
      const names=new Map();
      await scanPool([...locs.keys()],4,async loc=>{
        try{
          const rs=await httpFetch(ns,loc,{timeout:4000,connectTimeout:2000,maxBody:1<<20});
          if(rs.status!==200) return;
          const d=upnpParseDesc(rs.text()); names.set(loc,d);
          emit({src:'disc',via:'upnp',ip:locs.get(loc).ip,location:loc,name:d.name,manufacturer:d.manufacturer,model:d.model,modelNumber:d.modelNumber,type:d.type,udn:d.udn,presentation:d.presentation,
            services:d.services.map(s=>s.type.replace(/^urn:[^:]+:service:/,'').replace(/:\d+$/,'')).join(' '),kind:discKind(d.type+' '+d.services.map(s=>s.type).join(' ')),t:Date.now()});
        }catch(e){}
      },stop);
    }
  }
  const types=o.mdns||[];
  if(types.length){
    const seen=new Set();
    const hook=r=>{
      if(r.ev!=='nsd' || (r.kind!=='resolved' && r.kind!=='found')) return;
      const key=(r.type||'')+'|'+(r.name||'')+'|'+r.kind; if(seen.has(key)) return; seen.add(key);
      n++; emit({src:'disc',via:'mdns',state:r.kind,name:r.name,type:r.type,ip:r.host||'',port:r.port||0,txt:r.txt||{},kind:discKind(r.type),t:Date.now()});
    };
    ns.hooks.add(hook);
    try{
      for(const t of types){
        if(stop()) break;
        try{ await ns.call('nsd.discover',{type:t,resolve:o.resolve!==false,timeout:(o.mdnsWait||2500)+500}); }catch(e){ continue; }
        const end=Date.now()+(o.mdnsWait||2500); while(Date.now()<end && !stop()) await new Promise(r=>setTimeout(r,100));
        try{ await ns.call('nsd.stop'); }catch(e){}
      }
    } finally { ns.hooks.delete(hook); try{ await ns.call('nsd.stop'); }catch(e){} }
  }
  return {found:n,ms:Date.now()-t0};
}
