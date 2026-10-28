"use strict";
/* UPnP / DLNA: устройство вывода (MediaRenderer: AVTransport + RenderingControl + ConnectionManager) и управляющая сторона (SOAP-клиент).
   Описание устройства и служб, SOAP, события (SUBSCRIBE / NOTIFY LastChange), ответы SSDP — здесь; сокеты — netsock-kernels.js, HTTP — http-kernels.js.
   Плеер подключается снаружи (объект player), поэтому логика проверяется без браузера: tools/test-upnp.mjs (python async-upnp-client как настоящий пульт). */

const xmlEsc=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
const xmlUnesc=s=>String(s??'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');

const UPNP_NS_DEV='urn:schemas-upnp-org:device-1-0', UPNP_NS_SVC='urn:schemas-upnp-org:service-1-0';
const UPNP_RENDERER='urn:schemas-upnp-org:device:MediaRenderer:1';
const UPNP_SERVICES={
  avt:{type:'urn:schemas-upnp-org:service:AVTransport:1',id:'urn:upnp-org:serviceId:AVTransport'},
  rc:{type:'urn:schemas-upnp-org:service:RenderingControl:1',id:'urn:upnp-org:serviceId:RenderingControl'},
  cm:{type:'urn:schemas-upnp-org:service:ConnectionManager:1',id:'urn:upnp-org:serviceId:ConnectionManager'},
};
const UPNP_SINK='http-get:*:video/mp4:*,http-get:*:video/mpeg:*,http-get:*:video/webm:*,http-get:*:video/x-matroska:*,http-get:*:video/quicktime:*,http-get:*:audio/mpeg:*,http-get:*:audio/mp4:*,http-get:*:audio/aac:*,http-get:*:audio/ogg:*,http-get:*:audio/flac:*,http-get:*:audio/x-wav:*,http-get:*:audio/wav:*,http-get:*:audio/L16:*,http-get:*:image/jpeg:*,http-get:*:image/png:*';

/* ---------- таблицы действий и переменных: из них строятся SCPD ---------- */
const UPNP_IID='A_ARG_TYPE_InstanceID';
const UPNP_AVT_ACTIONS={
  SetAVTransportURI:[['InstanceID','in',UPNP_IID],['CurrentURI','in','AVTransportURI'],['CurrentURIMetaData','in','AVTransportURIMetaData']],
  SetNextAVTransportURI:[['InstanceID','in',UPNP_IID],['NextURI','in','NextAVTransportURI'],['NextURIMetaData','in','NextAVTransportURIMetaData']],
  GetMediaInfo:[['InstanceID','in',UPNP_IID],['NrTracks','out','NumberOfTracks'],['MediaDuration','out','CurrentMediaDuration'],['CurrentURI','out','AVTransportURI'],['CurrentURIMetaData','out','AVTransportURIMetaData'],['NextURI','out','NextAVTransportURI'],['NextURIMetaData','out','NextAVTransportURIMetaData'],['PlayMedium','out','PlaybackStorageMedium'],['RecordMedium','out','RecordStorageMedium'],['WriteStatus','out','RecordMediumWriteStatus']],
  GetTransportInfo:[['InstanceID','in',UPNP_IID],['CurrentTransportState','out','TransportState'],['CurrentTransportStatus','out','TransportStatus'],['CurrentSpeed','out','TransportPlaySpeed']],
  GetPositionInfo:[['InstanceID','in',UPNP_IID],['Track','out','CurrentTrack'],['TrackDuration','out','CurrentTrackDuration'],['TrackMetaData','out','CurrentTrackMetaData'],['TrackURI','out','CurrentTrackURI'],['RelTime','out','RelativeTimePosition'],['AbsTime','out','AbsoluteTimePosition'],['RelCount','out','RelativeCounterPosition'],['AbsCount','out','AbsoluteCounterPosition']],
  GetDeviceCapabilities:[['InstanceID','in',UPNP_IID],['PlayMedia','out','PossiblePlaybackStorageMedia'],['RecMedia','out','PossibleRecordStorageMedia'],['RecQualityModes','out','PossibleRecordQualityModes']],
  GetTransportSettings:[['InstanceID','in',UPNP_IID],['PlayMode','out','CurrentPlayMode'],['RecQualityMode','out','CurrentRecordQualityMode']],
  Stop:[['InstanceID','in',UPNP_IID]],
  Play:[['InstanceID','in',UPNP_IID],['Speed','in','TransportPlaySpeed']],
  Pause:[['InstanceID','in',UPNP_IID]],
  Seek:[['InstanceID','in',UPNP_IID],['Unit','in','A_ARG_TYPE_SeekMode'],['Target','in','A_ARG_TYPE_SeekTarget']],
  Next:[['InstanceID','in',UPNP_IID]],
  Previous:[['InstanceID','in',UPNP_IID]],
  SetPlayMode:[['InstanceID','in',UPNP_IID],['NewPlayMode','in','CurrentPlayMode']],
  GetCurrentTransportActions:[['InstanceID','in',UPNP_IID],['Actions','out','CurrentTransportActions']],
};
const UPNP_AVT_VARS={
  TransportState:{t:'string',allowed:['STOPPED','PAUSED_PLAYBACK','PLAYING','TRANSITIONING','NO_MEDIA_PRESENT']},TransportStatus:{t:'string',allowed:['OK','ERROR_OCCURRED']},
  PlaybackStorageMedium:{t:'string'},RecordStorageMedium:{t:'string'},PossiblePlaybackStorageMedia:{t:'string'},PossibleRecordStorageMedia:{t:'string'},
  CurrentPlayMode:{t:'string',allowed:['NORMAL','REPEAT_ONE','REPEAT_ALL'],def:'NORMAL'},TransportPlaySpeed:{t:'string',def:'1'},RecordMediumWriteStatus:{t:'string'},
  CurrentRecordQualityMode:{t:'string'},PossibleRecordQualityModes:{t:'string'},NumberOfTracks:{t:'ui4',range:[0,4294967295,1]},CurrentTrack:{t:'ui4',range:[0,4294967295,1]},
  CurrentTrackDuration:{t:'string'},CurrentMediaDuration:{t:'string'},CurrentTrackMetaData:{t:'string'},CurrentTrackURI:{t:'string'},AVTransportURI:{t:'string'},AVTransportURIMetaData:{t:'string'},
  NextAVTransportURI:{t:'string'},NextAVTransportURIMetaData:{t:'string'},RelativeTimePosition:{t:'string'},AbsoluteTimePosition:{t:'string'},RelativeCounterPosition:{t:'i4'},AbsoluteCounterPosition:{t:'ui4'},
  CurrentTransportActions:{t:'string'},LastChange:{t:'string',events:true},A_ARG_TYPE_SeekMode:{t:'string',allowed:['TRACK_NR','REL_TIME','ABS_TIME']},A_ARG_TYPE_SeekTarget:{t:'string'},[UPNP_IID]:{t:'ui4'},
};
const UPNP_RC_ACTIONS={
  ListPresets:[['InstanceID','in',UPNP_IID],['CurrentPresetNameList','out','PresetNameList']],
  SelectPreset:[['InstanceID','in',UPNP_IID],['PresetName','in','A_ARG_TYPE_PresetName']],
  GetMute:[['InstanceID','in',UPNP_IID],['Channel','in','A_ARG_TYPE_Channel'],['CurrentMute','out','Mute']],
  SetMute:[['InstanceID','in',UPNP_IID],['Channel','in','A_ARG_TYPE_Channel'],['DesiredMute','in','Mute']],
  GetVolume:[['InstanceID','in',UPNP_IID],['Channel','in','A_ARG_TYPE_Channel'],['CurrentVolume','out','Volume']],
  SetVolume:[['InstanceID','in',UPNP_IID],['Channel','in','A_ARG_TYPE_Channel'],['DesiredVolume','in','Volume']],
};
const UPNP_RC_VARS={PresetNameList:{t:'string'},LastChange:{t:'string',events:true},Mute:{t:'boolean'},Volume:{t:'ui2',range:[0,100,1]},[UPNP_IID]:{t:'ui4'},A_ARG_TYPE_Channel:{t:'string',allowed:['Master']},A_ARG_TYPE_PresetName:{t:'string',allowed:['FactoryDefaults']}};
const UPNP_CM_ACTIONS={
  GetProtocolInfo:[['Source','out','SourceProtocolInfo'],['Sink','out','SinkProtocolInfo']],
  GetCurrentConnectionIDs:[['ConnectionIDs','out','CurrentConnectionIDs']],
  GetCurrentConnectionInfo:[['ConnectionID','in','A_ARG_TYPE_ConnectionID'],['RcsID','out','A_ARG_TYPE_RcsID'],['AVTransportID','out','A_ARG_TYPE_AVTransportID'],['ProtocolInfo','out','A_ARG_TYPE_ProtocolInfo'],['PeerConnectionManager','out','A_ARG_TYPE_ConnectionManager'],['PeerConnectionID','out','A_ARG_TYPE_ConnectionID'],['Direction','out','A_ARG_TYPE_Direction'],['Status','out','A_ARG_TYPE_ConnectionStatus']],
};
const UPNP_CM_VARS={SourceProtocolInfo:{t:'string',events:true},SinkProtocolInfo:{t:'string',events:true},CurrentConnectionIDs:{t:'string',events:true},A_ARG_TYPE_ConnectionStatus:{t:'string',allowed:['OK','ContentFormatMismatch','InsufficientBandwidth','UnreliableChannel','Unknown']},
  A_ARG_TYPE_ConnectionManager:{t:'string'},A_ARG_TYPE_Direction:{t:'string',allowed:['Input','Output']},A_ARG_TYPE_ProtocolInfo:{t:'string'},A_ARG_TYPE_ConnectionID:{t:'i4'},A_ARG_TYPE_AVTransportID:{t:'i4'},A_ARG_TYPE_RcsID:{t:'i4'}};
const UPNP_TABLES={avt:[UPNP_AVT_ACTIONS,UPNP_AVT_VARS],rc:[UPNP_RC_ACTIONS,UPNP_RC_VARS],cm:[UPNP_CM_ACTIONS,UPNP_CM_VARS]};

function upnpScpd(actions,vars){
  let x='<?xml version="1.0"?>\n<scpd xmlns="'+UPNP_NS_SVC+'"><specVersion><major>1</major><minor>0</minor></specVersion><actionList>';
  for(const a in actions){
    x+='<action><name>'+a+'</name>'+(actions[a].length ? '<argumentList>' : '');
    for(const [n,d,v] of actions[a]) x+='<argument><name>'+n+'</name><direction>'+d+'</direction><relatedStateVariable>'+v+'</relatedStateVariable></argument>';
    x+=(actions[a].length ? '</argumentList>' : '')+'</action>';
  }
  x+='</actionList><serviceStateTable>';
  for(const v in vars){
    const d=vars[v];
    x+='<stateVariable sendEvents="'+(d.events ? 'yes' : 'no')+'"><name>'+v+'</name><dataType>'+d.t+'</dataType>'+(d.def!=null ? '<defaultValue>'+d.def+'</defaultValue>' : '');
    if(d.allowed) x+='<allowedValueList>'+d.allowed.map(a=>'<allowedValue>'+a+'</allowedValue>').join('')+'</allowedValueList>';
    if(d.range) x+='<allowedValueRange><minimum>'+d.range[0]+'</minimum><maximum>'+d.range[1]+'</maximum><step>'+d.range[2]+'</step></allowedValueRange>';
    x+='</stateVariable>';
  }
  return x+'</serviceStateTable></scpd>';
}
function upnpDeviceDesc(o){
  const svc=Object.keys(UPNP_SERVICES).map(k=>'<service><serviceType>'+UPNP_SERVICES[k].type+'</serviceType><serviceId>'+UPNP_SERVICES[k].id+'</serviceId><SCPDURL>/'+k+'.xml</SCPDURL><controlURL>/ctl/'+k+'</controlURL><eventSubURL>/evt/'+k+'</eventSubURL></service>').join('');
  return '<?xml version="1.0"?>\n<root xmlns="'+UPNP_NS_DEV+'" xmlns:dlna="urn:schemas-dlna-org:device-1-0"><specVersion><major>1</major><minor>0</minor></specVersion><device>'
    +'<deviceType>'+UPNP_RENDERER+'</deviceType><friendlyName>'+xmlEsc(o.name)+'</friendlyName><manufacturer>'+xmlEsc(o.manufacturer||'DSP workbench')+'</manufacturer>'
    +'<modelName>'+xmlEsc(o.model||'DSP Cast Receiver')+'</modelName><modelDescription>'+xmlEsc(o.description||'Screen and sound of the DSP workbench')+'</modelDescription><modelNumber>1</modelNumber>'
    +'<serialNumber>'+xmlEsc(o.uuid.slice(-12))+'</serialNumber><UDN>uuid:'+o.uuid+'</UDN><dlna:X_DLNADOC>DMR-1.50</dlna:X_DLNADOC>'
    +'<serviceList>'+svc+'</serviceList></device></root>';
}

/* ---------- время, метаданные, события ---------- */
const upnpTime=s=>{ if(!(s>=0) || !isFinite(s)) return 'NOT_IMPLEMENTED'; s=Math.floor(s); return Math.floor(s/3600)+':'+String(Math.floor(s/60)%60).padStart(2,'0')+':'+String(s%60).padStart(2,'0'); };
const upnpParseTime=t=>{ const m=/^(\d+):(\d{1,2}):(\d{1,2})(?:\.\d+)?$/.exec(String(t||'').trim()); return m ? (+m[1])*3600+(+m[2])*60+(+m[3]) : null; };
// DIDL-Lite: название, класс, исполнитель, обложка, mime по protocolInfo
function upnpDidl(xml){
  const t=String(xml||''), g=tag=>{ const m=new RegExp('<'+tag+'(?:\\s[^>]*)?>([\\s\\S]*?)</'+tag+'>','i').exec(t); return m ? xmlUnesc(m[1].replace(/<!\[CDATA\[|\]\]>/g,'')).trim() : ''; };
  const res=/<res\b([^>]*)>([\s\S]*?)<\/res>/i.exec(t), pi=res ? /protocolInfo="([^"]*)"/.exec(res[1]) : null;
  return {title:g('dc:title'),creator:g('dc:creator')||g('upnp:artist'),cls:g('upnp:class'),album:g('upnp:album'),art:g('upnp:albumArtURI'),mime:pi ? (pi[1].split(':')[2]||'') : '',uri:res ? xmlUnesc(res[2].trim()) : ''};
}
function upnpDidlItem(o){
  return '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="0" parentID="-1" restricted="1"><dc:title>'+xmlEsc(o.title||'DSP')+'</dc:title><upnp:class>'+(o.cls||'object.item.videoItem')+'</upnp:class><res protocolInfo="http-get:*:'+(o.mime||'video/mp4')+':*">'+xmlEsc(o.uri)+'</res></item></DIDL-Lite>';
}
function upnpLastChange(kind,vars){                           // vars: {Имя: значение или {val, channel}}
  const ns=kind==='avt' ? 'urn:schemas-upnp-org:metadata-1-0/AVT/' : 'urn:schemas-upnp-org:metadata-1-0/RCS/';
  let x='<Event xmlns="'+ns+'"><InstanceID val="0">';
  for(const k in vars){ const v=vars[k]; x+='<'+k+(v && typeof v==='object' && v.channel ? ' channel="'+v.channel+'"' : '')+' val="'+xmlEsc(v && typeof v==='object' ? v.val : v)+'"/>'; }
  return x+'</InstanceID></Event>';
}
const upnpPropertySet=(vars)=>'<?xml version="1.0"?>\n<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0">'+Object.keys(vars).map(k=>'<e:property><'+k+'>'+xmlEsc(vars[k])+'</'+k+'></e:property>').join('')+'</e:propertyset>';

/* ---------- SOAP ---------- */
function upnpSoapParse(body,header){
  const text=nsDec(body), act=/^"?([^#"]+)#([^"]+)"?$/.exec(header||'');
  const m=/<(?:\w+:)?Body[^>]*>\s*<(?:(\w+):)?(\w+)\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?\2>\s*<\/(?:\w+:)?Body>/i.exec(text);
  if(!m) throw Object.assign(new Error('bad SOAP body'),{upnp:401});
  const args={}; for(const a of m[4].matchAll(/<(\w+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>|<(\w+)\s*\/>/g)) args[a[1]||a[3]]=a[1] ? xmlUnesc(a[2].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1')) : '';
  return {service:act ? act[1] : '',action:act ? act[2] : m[2],args};
}
function upnpSoapResponse(service,action,out){
  return '<?xml version="1.0"?>\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:'+action+'Response xmlns:u="'+service+'">'
    +Object.keys(out||{}).map(k=>'<'+k+'>'+xmlEsc(out[k])+'</'+k+'>').join('')+'</u:'+action+'Response></s:Body></s:Envelope>';
}
const UPNP_ERR={401:'Invalid Action',402:'Invalid Args',501:'Action Failed',701:'Transition not available',702:'No contents',703:'Read error',704:'Format not supported for playback',714:'Illegal MIME-type',716:'Resource not found',718:'Invalid InstanceID',720:'Cannot process the request'};
function upnpSoapFault(code,text){
  return '<?xml version="1.0"?>\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>'
    +code+'</errorCode><errorDescription>'+xmlEsc(text||UPNP_ERR[code]||'Error')+'</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>';
}

/* ---------- SSDP: сообщения устройства ---------- */
const SSDP_ADDR='239.255.255.250', SSDP_PORT=1900;
function ssdpTargets(uuid){                                   // [NT, USN]
  const u='uuid:'+uuid, o=[[ 'upnp:rootdevice',u+'::upnp:rootdevice' ],[u,u],[UPNP_RENDERER,u+'::'+UPNP_RENDERER]];
  for(const k in UPNP_SERVICES) o.push([UPNP_SERVICES[k].type,u+'::'+UPNP_SERVICES[k].type]);
  return o;
}
const SSDP_SERVER='Android/1.0 UPnP/1.0 DSP/1';
const ssdpNotify=(nt,usn,loc,sub)=>'NOTIFY * HTTP/1.1\r\nHOST: '+SSDP_ADDR+':'+SSDP_PORT+'\r\n'+(sub==='byebye' ? '' : 'CACHE-CONTROL: max-age=1800\r\nLOCATION: '+loc+'\r\n')+'NT: '+nt+'\r\nNTS: ssdp:'+sub+'\r\n'+(sub==='byebye' ? '' : 'SERVER: '+SSDP_SERVER+'\r\n')+'USN: '+usn+'\r\n\r\n';
const ssdpAnswer=(st,usn,loc)=>'HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nDATE: '+new Date().toUTCString()+'\r\nEXT:\r\nLOCATION: '+loc+'\r\nSERVER: '+SSDP_SERVER+'\r\nST: '+st+'\r\nUSN: '+usn+'\r\n\r\n';
// что ответить на M-SEARCH с таким ST
const ssdpMatch=(st,uuid)=>{ const all=ssdpTargets(uuid); return st==='ssdp:all' ? all : all.filter(t=>t[0]===st); };

/* ---------- устройство вывода ---------- */
/* player: {load(uri,meta), play(), pause(), stop(), seek(sec), info() → {pos,dur,state,error}, setVolume(0..100), setMute(bool)} — всё синхронное и без исключений наружу.
   opt: name, uuid, host (IP телефона в адресах), port, onState(ev) */
class UpnpRenderer{
  constructor(ns,player,opt){
    this.ns=ns; this.player=player; this.opt=opt; this.http=null; this.udp=null; this.subs=new Map(); this.on=false; this.timers=[];
    this.st={uri:'',meta:'',next:'',nextMeta:'',state:'NO_MEDIA_PRESENT',status:'OK',volume:+opt.volume>=0 ? +opt.volume : 100,mute:false,mode:'NORMAL'};
    this.stats={actions:0,searches:0,subs:0};
  }
  get loc(){ return 'http://'+this.opt.host+':'+this.opt.port+'/desc.xml'; }
  async start(){
    this.http=new HttpServer(this.ns,req=>this._http(req),{idle:60000});
    this.opt.port=await this.http.start(this.opt.port||0,true);
    this.on=true;
    try{ this.udp=await this.ns.udpOpen(SSDP_PORT,false,SSDP_ADDR); this._ssdpLoop(); this.ssdp='listening on 1900'; }
    catch(e){ this.udp=null; this.ssdp='M-SEARCH is not heard ('+e.message+') — only announcements'; }
    await this._announce('alive');
    this.timers.push(setInterval(()=>{ if(this.on) this._announce('alive'); },this.opt.every||600000));
    return this.opt.port;
  }
  async stop(){
    if(!this.on) return; this.on=false;
    for(const t of this.timers) clearInterval(t); this.timers=[];
    try{ await this._announce('byebye'); }catch(e){}
    if(this.udp) await this.udp.close().catch(()=>{}); this.udp=null;
    await this.http?.stop(); this.http=null;
  }
  async _announce(sub){
    const s=this.udp ? this.udp : null;
    for(const [nt,usn] of ssdpTargets(this.opt.uuid)){
      const msg=ssdpNotify(nt,usn,this.loc,sub);
      for(let k=0;k<(sub==='alive' ? 2 : 1);k++) await this.ns.udpSend(SSDP_ADDR,SSDP_PORT,msg,s ? {conn:s.id} : {broadcast:true}).catch(()=>{});
    }
  }
  async _ssdpLoop(){
    const u=this.udp;
    while(this.on && u.open){
      let d; try{ d=await u.recv(0); }catch(e){ break; } if(!d) break;
      const t=nsDec(d.bytes); if(!/^M-SEARCH /i.test(t)) continue;
      const h={}; for(const l of t.split(/\r?\n/).slice(1)){ const i=l.indexOf(':'); if(i>0) h[l.slice(0,i).trim().toLowerCase()]=l.slice(i+1).trim(); }
      if(!/ssdp:discover/.test(h.man||'')) continue;
      const hits=ssdpMatch(h.st||'',this.opt.uuid); if(!hits.length) continue;
      this.stats.searches++;
      const mx=Math.max(0,Math.min(5,+h.mx||1)), [ip,port]=[d.peer.replace(/:\d+$/,''),+d.peer.replace(/.*:/,'')];
      setTimeout(async()=>{ if(!this.on) return; for(const [nt,usn] of hits) await u.send(ip,port,ssdpAnswer(h.st==='ssdp:all' ? nt : h.st,usn,this.loc)).catch(()=>{}); },Math.random()*mx*600);
    }
  }
  /* --- HTTP: описание, службы, управление, подписки --- */
  async _http(req){
    const p=req.path;
    if(p==='/desc.xml') return {body:nsEnc(upnpDeviceDesc({name:this.opt.name,uuid:this.opt.uuid,model:this.opt.model})),headers:{'content-type':'text/xml; charset="utf-8"'}};
    let m=/^\/(avt|rc|cm)\.xml$/.exec(p); if(m) return {body:nsEnc(upnpScpd(...UPNP_TABLES[m[1]])),headers:{'content-type':'text/xml; charset="utf-8"'}};
    if((m=/^\/ctl\/(avt|rc|cm)$/.exec(p))) return this._soap(m[1],req);
    if((m=/^\/evt\/(avt|rc|cm)$/.exec(p))) return this._event(m[1],req);
    return {status:404,text:'not found'};
  }
  async _soap(k,req){
    if(req.method!=='POST') return {status:405,text:'POST only'};
    let call;
    try{ call=upnpSoapParse(req.body,req.headers.soapaction); }
    catch(e){ return {status:500,body:nsEnc(upnpSoapFault(401)),headers:{'content-type':'text/xml; charset="utf-8"'}}; }
    const svc=UPNP_SERVICES[k], acts=UPNP_TABLES[k][0];
    this.stats.actions++;
    try{
      if(call.service && call.service!==svc.type) throw Object.assign(new Error('wrong service'),{upnp:401});
      if(!acts[call.action]) throw Object.assign(new Error('unknown action'),{upnp:401});
      for(const [n,d] of acts[call.action]) if(d==='in' && !(n in call.args)) throw Object.assign(new Error('missing '+n),{upnp:402});
      if('InstanceID' in call.args && String(call.args.InstanceID)!=='0') throw Object.assign(new Error('only InstanceID 0'),{upnp:718});
      const out=await this['_'+k](call.action,call.args)||{};
      return {body:nsEnc(upnpSoapResponse(svc.type,call.action,out)),headers:{'content-type':'text/xml; charset="utf-8"',ext:''}};
    }catch(e){ const code=e.upnp||501; return {status:500,body:nsEnc(upnpSoapFault(code,e.upnp ? undefined : String(e.message||e))),headers:{'content-type':'text/xml; charset="utf-8"'}}; }
  }
  _live(){ const i=this.player.info(); if(this.st.state==='PLAYING' || this.st.state==='TRANSITIONING'){ if(i.error){ this.st.state='STOPPED'; this.st.status='ERROR_OCCURRED'; } else if(i.ended){ this.st.state='STOPPED'; } else if(i.paused===true && this.st.state==='PLAYING' && !i.seeking){ /* пауза извне */ } } return i; }
  async _avt(a,g){
    const st=this.st, pl=this.player;
    switch(a){
      case 'SetAVTransportURI': {
        if(!/^https?:\/\//i.test(g.CurrentURI||'') && g.CurrentURI) throw Object.assign(new Error('only http(s) URIs'),{upnp:714});
        st.uri=g.CurrentURI||''; st.meta=g.CurrentURIMetaData||''; st.status='OK';
        if(!st.uri){ pl.stop(); st.state='NO_MEDIA_PRESENT'; } else { pl.load(st.uri,upnpDidl(st.meta)); st.state=this.opt.autoplay ? 'PLAYING' : 'STOPPED'; if(this.opt.autoplay) pl.play(); }
        this._changed({TransportState:st.state,AVTransportURI:st.uri,AVTransportURIMetaData:st.meta,CurrentTrackURI:st.uri,CurrentTrackMetaData:st.meta,NumberOfTracks:st.uri ? 1 : 0,CurrentTrack:st.uri ? 1 : 0});
        return {};
      }
      case 'SetNextAVTransportURI': st.next=g.NextURI||''; st.nextMeta=g.NextURIMetaData||''; return {};
      case 'Play': if(!st.uri) throw Object.assign(new Error('nothing to play'),{upnp:701}); pl.play(); st.state='PLAYING'; this._changed({TransportState:st.state}); return {};
      case 'Pause': if(st.state!=='PLAYING') throw Object.assign(new Error('not playing'),{upnp:701}); pl.pause(); st.state='PAUSED_PLAYBACK'; this._changed({TransportState:st.state}); return {};
      case 'Stop': if(st.uri){ pl.stop(); st.state='STOPPED'; } this._changed({TransportState:st.state}); return {};
      case 'Seek': {
        if(!st.uri) throw Object.assign(new Error('nothing loaded'),{upnp:701});
        const t=upnpParseTime(g.Target); if(g.Unit==='TRACK_NR'){ return {}; }
        if(t==null || (g.Unit!=='REL_TIME' && g.Unit!=='ABS_TIME')) throw Object.assign(new Error('bad seek target'),{upnp:711});
        pl.seek(t); return {};
      }
      case 'Next': case 'Previous': throw Object.assign(new Error('single item'),{upnp:701});
      case 'SetPlayMode': st.mode=g.NewPlayMode||'NORMAL'; return {};
      case 'GetMediaInfo': { const i=this._live(); return {NrTracks:st.uri ? 1 : 0,MediaDuration:upnpTime(i.dur),CurrentURI:st.uri,CurrentURIMetaData:st.meta,NextURI:st.next,NextURIMetaData:st.nextMeta,PlayMedium:'NETWORK',RecordMedium:'NOT_IMPLEMENTED',WriteStatus:'NOT_IMPLEMENTED'}; }
      case 'GetTransportInfo': this._live(); return {CurrentTransportState:st.state,CurrentTransportStatus:st.status,CurrentSpeed:'1'};
      case 'GetPositionInfo': { const i=this._live(); return {Track:st.uri ? 1 : 0,TrackDuration:upnpTime(i.dur),TrackMetaData:st.meta,TrackURI:st.uri,RelTime:upnpTime(i.pos),AbsTime:upnpTime(i.pos),RelCount:2147483647,AbsCount:2147483647}; }
      case 'GetDeviceCapabilities': return {PlayMedia:'NETWORK,NONE',RecMedia:'NOT_IMPLEMENTED',RecQualityModes:'NOT_IMPLEMENTED'};
      case 'GetTransportSettings': return {PlayMode:st.mode,RecQualityMode:'NOT_IMPLEMENTED'};
      case 'GetCurrentTransportActions': return {Actions:st.state==='PLAYING' ? 'Pause,Stop,Seek' : st.state==='PAUSED_PLAYBACK' ? 'Play,Stop,Seek' : st.uri ? 'Play,Stop,Seek' : ''};
    }
    throw Object.assign(new Error('unknown action'),{upnp:401});
  }
  async _rc(a,g){
    const st=this.st, pl=this.player;
    switch(a){
      case 'ListPresets': return {CurrentPresetNameList:'FactoryDefaults'};
      case 'SelectPreset': return {};
      case 'GetMute': return {CurrentMute:st.mute ? 1 : 0};
      case 'GetVolume': return {CurrentVolume:st.volume};
      case 'SetMute': st.mute=/^(1|true)$/i.test(String(g.DesiredMute)); pl.setMute(st.mute); this._changed({Mute:{val:st.mute ? 1 : 0,channel:'Master'}},'rc'); return {};
      case 'SetVolume': { const v=Math.round(+g.DesiredVolume); if(!(v>=0 && v<=100)) throw Object.assign(new Error('0…100'),{upnp:402}); st.volume=v; pl.setVolume(v); this._changed({Volume:{val:v,channel:'Master'}},'rc'); return {}; }
    }
    throw Object.assign(new Error('unknown action'),{upnp:401});
  }
  async _cm(a,g){
    if(a==='GetProtocolInfo') return {Source:'',Sink:UPNP_SINK};
    if(a==='GetCurrentConnectionIDs') return {ConnectionIDs:'0'};
    if(a==='GetCurrentConnectionInfo'){ if(String(g.ConnectionID)!=='0') throw Object.assign(new Error('no such connection'),{upnp:706}); return {RcsID:0,AVTransportID:0,ProtocolInfo:'',PeerConnectionManager:'',PeerConnectionID:-1,Direction:'Input',Status:'OK'}; }
    throw Object.assign(new Error('unknown action'),{upnp:401});
  }
  /* --- события --- */
  async _event(k,req){
    const hdr=req.headers;
    if(req.method==='UNSUBSCRIBE'){ this.subs.delete(hdr.sid); return {status:200}; }
    if(req.method!=='SUBSCRIBE') return {status:405,text:'SUBSCRIBE / UNSUBSCRIBE'};
    const timeout=/Second-(\d+)/i.exec(hdr.timeout||'')?.[1]||'1800';
    if(hdr.sid){                                               // продление
      const s=this.subs.get(hdr.sid); if(!s) return {status:412,text:'unknown SID'};
      s.until=Date.now()+timeout*1000; return {status:200,headers:{sid:hdr.sid,timeout:'Second-'+timeout,'content-length':'0'}};
    }
    const urls=[...(hdr.callback||'').matchAll(/<([^>]+)>/g)].map(m=>m[1]).filter(u=>/^http:\/\//i.test(u));
    if(!urls.length || !/upnp:event/i.test(hdr.nt||'')) return {status:412,text:'bad CALLBACK / NT'};
    const sid='uuid:'+upnpUuid(), sub={k,urls,seq:0,until:Date.now()+timeout*1000};
    this.subs.set(sid,sub); this.stats.subs++;
    setTimeout(()=>this._send(sid,sub,this._full(k)),80);      // первое событие — после ответа на SUBSCRIBE
    return {status:200,headers:{sid,timeout:'Second-'+timeout}};
  }
  _full(k){
    const st=this.st, i=this.player.info();
    if(k==='avt') return {LastChange:upnpLastChange('avt',{TransportState:st.state,TransportStatus:st.status,CurrentPlayMode:st.mode,TransportPlaySpeed:'1',NumberOfTracks:st.uri ? 1 : 0,CurrentTrack:st.uri ? 1 : 0,CurrentTrackDuration:upnpTime(i.dur),CurrentMediaDuration:upnpTime(i.dur),CurrentTrackURI:st.uri,AVTransportURI:st.uri,AVTransportURIMetaData:st.meta,CurrentTrackMetaData:st.meta,CurrentTransportActions:'Play,Pause,Stop,Seek'})};
    if(k==='rc') return {LastChange:upnpLastChange('rc',{Volume:{val:st.volume,channel:'Master'},Mute:{val:st.mute ? 1 : 0,channel:'Master'}})};
    return {SourceProtocolInfo:'',SinkProtocolInfo:UPNP_SINK,CurrentConnectionIDs:'0'};
  }
  async _send(sid,sub,vars){
    const body=nsEnc(upnpPropertySet(vars));
    for(const u of sub.urls){
      try{ await httpFetch(this.ns,u,{method:'NOTIFY',body,headers:{'Content-Type':'text/xml; charset="utf-8"',NT:'upnp:event',NTS:'upnp:propchange',SID:sid,SEQ:String(sub.seq)},timeout:4000,connectTimeout:2000,redirects:0}); sub.seq++; return; }catch(e){}
    }
  }
  // изменение состояния → всем подписанным на службу
  _changed(vars,k='avt'){
    this.opt.onState?.({k,vars});
    const now=Date.now();
    for(const [sid,sub] of this.subs){
      if(sub.until<now){ this.subs.delete(sid); continue; }
      if(sub.k===k) this._send(sid,sub,{LastChange:upnpLastChange(k,vars)});
    }
  }
  // плеер сообщает о своём изменении (конец файла, ошибка, пауза с экрана…)
  playerEvent(kind){
    const st=this.st;
    if(kind==='ended' && st.state!=='STOPPED'){ st.state='STOPPED'; this._changed({TransportState:'STOPPED'}); }
    else if(kind==='error'){ st.state='STOPPED'; st.status='ERROR_OCCURRED'; this._changed({TransportState:'STOPPED',TransportStatus:'ERROR_OCCURRED'}); }
    else if(kind==='playing' && st.state!=='PLAYING' && st.uri){ st.state='PLAYING'; this._changed({TransportState:'PLAYING'}); }
    else if(kind==='paused' && st.state==='PLAYING'){ st.state='PAUSED_PLAYBACK'; this._changed({TransportState:'PAUSED_PLAYBACK'}); }
  }
}
const upnpUuid=()=>{ const h=n=>Array.from({length:n},()=>Math.floor(Math.random()*16).toString(16)).join(''); return h(8)+'-'+h(4)+'-4'+h(3)+'-'+'89ab'[Math.floor(Math.random()*4)]+h(3)+'-'+h(12); };

/* ---------- управляющая сторона (пульт): послать адрес на найденный плеер ---------- */
// «urn:…:AVTransport:1» → его controlURL из описания устройства
function upnpFindService(descXml,locationUrl,part){
  for(const m of String(descXml).matchAll(/<service>([\s\S]*?)<\/service>/gi)){
    const g=t=>{ const r=new RegExp('<'+t+'>([\\s\\S]*?)</'+t+'>','i').exec(m[1]); return r ? xmlUnesc(r[1]).trim() : ''; };
    if(g('serviceType').includes(part)){
      const abs=u=>{ try{ return new URL(u,locationUrl).toString(); }catch(e){ return u; } };
      return {type:g('serviceType'),control:abs(g('controlURL')),events:abs(g('eventSubURL')),scpd:abs(g('SCPDURL'))};
    }
  }
  return null;
}
async function upnpCall(ns,svc,action,args={},o={}){
  const body='<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:'+action+' xmlns:u="'+svc.type+'">'
    +Object.keys(args).map(k=>'<'+k+'>'+xmlEsc(args[k])+'</'+k+'>').join('')+'</u:'+action+'></s:Body></s:Envelope>';
  const r=await httpFetch(ns,svc.control,{method:'POST',body,headers:{'Content-Type':'text/xml; charset="utf-8"',SOAPACTION:'"'+svc.type+'#'+action+'"'},timeout:o.timeout||8000,redirects:0});
  const txt=r.text();
  if(r.status!==200){ const c=/<errorCode>(\d+)<\/errorCode>/.exec(txt), d=/<errorDescription>([\s\S]*?)<\/errorDescription>/.exec(txt); throw Object.assign(new Error(action+': '+(c ? c[1]+' ' : r.status+' ')+(d ? xmlUnesc(d[1]) : r.statusText)),{upnp:c ? +c[1] : 0}); }
  const out={}; const resp=new RegExp('<(?:\\w+:)?'+action+'Response[^>]*>([\\s\\S]*?)</(?:\\w+:)?'+action+'Response>').exec(txt);
  if(resp) for(const a of resp[1].matchAll(/<(\w+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>|<(\w+)\s*\/>/g)) out[a[1]||a[3]]=a[1] ? xmlUnesc(a[2]) : '';
  return out;
}
