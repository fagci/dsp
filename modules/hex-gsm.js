"use strict";
/* ============================ HEX Structure: GSM (TS 44.018, 04.12, 03.41, GSMTAP) ============================
   Форматы значений (gsm-freqs, gsm-si13, gsm-si2q, gsm-si3rest, gsm-mi, gsm7) и схемы: L2-сообщения BCCH / CCCH (gsm-l2),
   блок и страница CBCH (gsm-cbch-block, gsm-cbs), контейнер GSMTAP из gr-gsm (gsmtap), заголовки pcap (sll, null).
   Списки частот и CSN.1 Rest Octets разбирает декодер (gsm.js: gsmDecodeFreqList, gsmDecodeSi13, gsmDecodeSi2quater) —
   формат вызывает его, если он загружен, иначе показывает байты. */

const HEX_GSM7='@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const HEX_GSM7X={0x0a:'\f',0x14:'^',0x28:'{',0x29:'}',0x2f:'\\',0x3c:'[',0x3d:'~',0x3e:']',0x40:'|',0x65:'€'};
function hexGsm7Unpack(b,n){                                       // упакованные септеты, младшие биты первыми
  const o=[]; let buf=0, bits=0, i=0;
  while(o.length<n && i<b.length){ buf|=b[i++]<<bits; bits+=8; while(bits>=7 && o.length<n){ o.push(buf&127); buf>>=7; bits-=7; } }
  return o;
}
HEX_FMT_EXT.gsm7=b=>{
  let s='', esc=false;
  for(const c of hexGsm7Unpack(b,Math.floor(b.length*8/7))){ if(esc){ s+=HEX_GSM7X[c]||'?'; esc=false; } else if(c===27) esc=true; else s+=HEX_GSM7[c]||'?'; }
  return s.replace(/\r+$/,'');
};
HEX_UNFMT_EXT.gsm7=(v,len)=>{
  const sept=[];
  for(const ch of String(v)){ const k=HEX_GSM7.indexOf(ch); if(k>=0 && k!==27) sept.push(k); else { const e=Object.keys(HEX_GSM7X).find(x=>HEX_GSM7X[x]===ch); if(e){ sept.push(27,+e); } else sept.push(0x3f); } }
  while(len && sept.length*7<len*8-6) sept.push(13);               // заливка CR, как у сети
  const o=new Uint8Array(len || Math.ceil(sept.length*7/8));
  let buf=0, bits=0, k=0;
  for(const c of sept){ buf|=c<<bits; bits+=7; while(bits>=8 && k<o.length){ o[k++]=buf&255; buf>>=8; bits-=8; } }
  if(bits>0 && k<o.length) o[k]=buf&255;
  return o;
};
const hexGsmRanges=a=>{ const o=[]; for(let i=0;i<a.length;){ let j=i; while(j+1<a.length && a[j+1]===a[j]+1) j++; o.push(j>i ? a[i]+'–'+a[j] : String(a[i])); i=j+1; } return o.join(', '); };
HEX_FMT_EXT['gsm-freqs']=b=>{                                      // список частот (TS 44.018 10.5.2.13): формат и ARFCN
  if(typeof gsmDecodeFreqList!=='function') return hexToHex(b);
  const r=gsmDecodeFreqList(Array.from(b),0,b.length);
  return r.format+': '+(r.arfcns.length ? hexGsmRanges(r.arfcns)+' ('+r.arfcns.length+')' : 'none');
};
HEX_FMT_EXT['gsm-si13']=b=>{
  if(typeof gsmDecodeSi13!=='function') return hexToHex(b);
  const r=gsmDecodeSi13([0,0,0,...b]);
  if(!r.present) return 'no SI13 contents';
  const L=['BCCH change mark '+r.bcchChangeMark,'SI change field '+r.siChangeField];
  if(r.pbcch) L.push('PBCCH TN'+r.pbcch.tn+' TSC'+r.pbcch.tsc+(r.pbcch.arfcn!=null ? ' ARFCN '+r.pbcch.arfcn : r.pbcch.maio!=null ? ' MAIO '+r.pbcch.maio : ''));
  else if(r.rac!=null) L.push('GPRS on BCCH/CCCH, RAC '+r.rac,'priority access thr '+r.priorityAccessThr,'network control order '+r.networkControlOrder);
  return L.join(' · ');
};
HEX_FMT_EXT['gsm-si2q']=b=>{
  if(typeof gsmDecodeSi2quater!=='function') return hexToHex(b);
  const r=gsmDecodeSi2quater([0,0,0,...b]);
  const L=['BA_IND '+r.baInd,'3G_BA_IND '+r.ba3gInd,'MP change mark '+r.mpChangeMark,'index '+r.index+'/'+r.count];
  if(r.networkControlOrder!=null) L.push('NC order '+r.networkControlOrder);
  const g=r.neighbors3g;
  if(g){
    for(const [k,name] of [['utranFdd','UTRAN FDD'],['utranTdd','UTRAN TDD']]) if(g[k]) for(const c of g[k].cells) L.push(name+' UARFCN '+c.uarfcn+' ('+c.codes.length+' cells)');
  }
  if(r.note) L.push('… '+r.note);
  return L.join(' · ');
};
HEX_FMT_EXT['gsm-si3rest']=b=>{                                    // SI3 Rest Octets (TS 44.018 10.5.2.34): необязательные блоки с флагом
  const r={p:0,bit(){ const v=this.p<b.length*8 ? (b[this.p>>3]>>(7-(this.p&7)))&1 : 0; this.p++; return v; },bits(n){ let v=0; for(let i=0;i<n;i++) v=v*2+this.bit(); return v; }};
  const L=[];
  if(r.bit()){ const cbq=r.bit(), off=r.bits(6), tmp=r.bits(3), pen=r.bits(5); L.push('selection params: CBQ '+cbq+', reselect offset '+off*2+' dB, temporary offset '+tmp*10+' dB, penalty time '+(pen*20+20)+' s'); }
  if(r.bit()) L.push('power offset '+r.bits(2));
  if(r.bit()) L.push('SI2ter present');
  if(r.bit()) L.push('early classmark sending allowed');
  if(r.bit()) L.push('scheduling where '+r.bits(3));
  if(r.bit()){ const ra=r.bits(3), pos=r.bit(); L.push('GPRS: RA colour '+ra+', SI13 on '+(pos ? 'BCCH Ext' : 'BCCH Norm')); }
  return L.length ? L.join(' · ') : 'nothing optional present';
};
HEX_FMT_EXT['gsm-mi']=b=>{                                         // Mobile Identity (TS 24.008 10.5.1.4): IMSI / IMEI / TMSI
  if(!b.length) return '';
  const t=b[0]&7, odd=(b[0]>>3)&1;
  if(t===4) return 'TMSI '+hexToHex(b.subarray(1));
  if(t===0) return 'no identity';
  let d=String(b[0]>>4);
  for(let i=1;i<b.length;i++){ d+=(b[i]&15).toString(16); if(i<b.length-1 || odd) d+=(b[i]>>4).toString(16); }
  return ({1:'IMSI',2:'IMEI',3:'IMEISV'}[t]||'type '+t)+' '+d.replace(/f/g,'');
};

/* ---------- схемы ---------- */
{
  const b=(n,w,when,o)=>Object.assign({n,t:'bits',w,when},o||{}), pad=(w,when)=>({t:'pad',w,when});
  const RACH='mt==25 || mt==26 || mt==2 || mt==27 || mt==28', CCD='tag==100';
  const txi={}; [3,4,5,6,7,8,9,10,11,12,14,16,20,25,32,50].forEach((v,i)=>{ txi[i]=String(v); });
  const rlt={}; for(let i=0;i<16;i++) rlt[i]=(i+1)*4+' SACCH blocks';
  const rxl={}; for(let i=0;i<64;i++) rxl[i]=(i-110)+' dBm';
  const chan={1:'TCH/F + ACCHs',2:'TCH/H + ACCH (sub 0)',3:'TCH/H + ACCH (sub 1)'};
  for(let i=0;i<4;i++) chan[4+i]='SDCCH/4 + CBCH (sub '+i+')';
  for(let i=0;i<8;i++) chan[8+i]='SDCCH/8 + CBCH (sub '+i+')';
  const PG='mt==33 || mt==34 || mt==36', IA='mt==63';
  Object.assign(HEX_LIB,{
    'gsm-l2':{ title:'GSM L2 message: BCCH / CCCH (System Information, paging, immediate assignment)', group:'GSM', fields:[
      b('li',6), b('m',1), b('el',1), b('skip',4), b('pd',4,undefined,{enum:{6:'RR'}}),
      {n:'mt',t:'u8',fmt:'hex',enum:{0:'SI13',2:'SI2bis',3:'SI2ter',7:'SI2quater',25:'SI1',26:'SI2',27:'SI3',28:'SI4',33:'Paging Request 1',34:'Paging Request 2',36:'Paging Request 3',
        57:'Immediate Assignment Extended',58:'Immediate Assignment Reject',63:'Immediate Assignment'}},
      // SI3: Cell Identity, LAI
      {n:'ci',t:'u16',when:'mt==27'},
      {n:'plmn',t:'bytes',fmt:'plmn',when:'mt==27 || mt==28'}, {n:'lac',t:'u16',when:'mt==27 || mt==28'},
      // SI3: Control Channel Description, Cell Options BCCH
      b('mscr',1,'mt==27'), b('att',1,'mt==27'), b('bs_ag_blks_res',3,'mt==27'),
      b('ccch_conf',3,'mt==27',{enum:{0:'1 CCCH, not combined',1:'1 CCCH, combined with SDCCH',2:'2 CCCH',4:'3 CCCH',6:'4 CCCH'}}),
      pad(1,'mt==27'), b('cbq3',2,'mt==27'), pad(2,'mt==27'), b('bs_pa_mfrms',3,'mt==27',{enum:{0:'2',1:'3',2:'4',3:'5',4:'6',5:'7',6:'8',7:'9'}}),
      {n:'t3212',t:'u8',when:'mt==27',scale:6,unit:'min',prec:0},
      pad(1,'mt==27'), b('pwrc',1,'mt==27'), b('dtx',2,'mt==27',{enum:{0:'MS may use DTX',1:'MS shall use DTX',2:'MS shall not use DTX'}}), b('radio_link_timeout',4,'mt==27',{enum:rlt}),
      // SI3, SI4: Cell Selection Parameters
      b('cell_reselect_hyst',3,'mt==27 || mt==28',{scale:2,unit:'dB',prec:0}), b('ms_txpwr_max_cch',5,'mt==27 || mt==28'),
      b('acs',1,'mt==27 || mt==28'), b('neci',1,'mt==27 || mt==28'), b('rxlev_access_min',6,'mt==27 || mt==28',{enum:rxl}),
      // SI1, SI2, SI2bis, SI2ter: списки частот
      {n:'freqs',t:'bytes',len:16,fmt:'gsm-freqs',when:'mt==25 || mt==26 || mt==2 || mt==3'},
      {n:'ncc_permitted',t:'u8',fmt:'bin',when:'mt==26'},
      // RACH Control Parameters (SI1, SI2, SI2bis, SI3, SI4)
      b('max_retrans',2,RACH,{enum:{0:'1',1:'2',2:'4',3:'7'}}), b('tx_integer',4,RACH,{enum:txi}), b('cell_barred',1,RACH), b('re_allowed',1,RACH,{enum:{0:'re-establishment allowed',1:'not allowed'}}),
      b('access_classes',16,RACH,{fmt:'bin',flags:{15:'C15',14:'C14',13:'C13',12:'C12',11:'C11',10:'C10',9:'C9',8:'C8',7:'C7',6:'C6',5:'C5',4:'C4',3:'C3',2:'C2',1:'C1',0:'C0'}}),
      // SI4: необязательное описание CBCH
      {n:'tag',t:'u8',fmt:'hex',when:'mt==28 && _left>0'},
      b('cbch_chan',5,CCD,{enum:chan}), b('cbch_tn',3,CCD), b('cbch_tsc',3,CCD), b('cbch_hop',1,CCD),
      pad(2,CCD+' && cbch_hop==0'), b('cbch_arfcn',10,CCD+' && cbch_hop==0'),
      b('cbch_maio',6,CCD+' && cbch_hop==1'), b('cbch_hsn',6,CCD+' && cbch_hop==1'),
      // Paging Request 1 / 2 / 3
      b('cneed2',2,PG), b('cneed1',2,PG), b('page_mode',4,PG,{enum:{0:'normal paging',1:'extended paging',2:'paging reorganization',3:'same as before'}}),
      {n:'mi1len',t:'u8',when:'mt==33'}, {n:'mi1',t:'bytes',len:'mi1len',fmt:'gsm-mi',when:'mt==33'},
      {n:'tmsi1',t:'bytes',len:4,fmt:'hex',when:'mt==34 || mt==36'}, {n:'tmsi2',t:'bytes',len:4,fmt:'hex',when:'mt==34 || mt==36'},
      {n:'tmsi3',t:'bytes',len:4,fmt:'hex',when:'mt==36'}, {n:'tmsi4',t:'bytes',len:4,fmt:'hex',when:'mt==36'},
      // Immediate Assignment
      b('dedicated_mode',4,IA), b('ia_page_mode',4,IA,{enum:{0:'normal paging',1:'extended paging',2:'paging reorganization',3:'same as before'}}),
      b('ia_chan',5,IA), b('ia_tn',3,IA), b('ia_tsc',3,IA), b('ia_hop',1,IA),
      pad(2,IA+' && ia_hop==0'), b('ia_arfcn',10,IA+' && ia_hop==0'), b('ia_maio',6,IA+' && ia_hop==1'), b('ia_hsn',6,IA+' && ia_hop==1'),
      {n:'ra',t:'u8',fmt:'hex',when:IA}, b('t1',5,IA), b('t3',6,IA), b('t2',5,IA), {n:'timing_advance',t:'u8',when:IA},
      {n:'malen',t:'u8',when:IA}, {n:'mobile_allocation',t:'bytes',len:'malen',when:IA},
      // Rest Octets и остальное
      {n:'rest3',t:'bytes',len:'_left',fmt:'gsm-si3rest',when:'mt==27'},
      {n:'si13',t:'bytes',len:'_left',fmt:'gsm-si13',when:'mt==0'},
      {n:'si2q',t:'bytes',len:'_left',fmt:'gsm-si2q',when:'mt==7'},
      {n:'rest',t:'bytes',len:'_left',when:'mt!=27 && mt!=0 && mt!=7'}]},

    /* CBCH: блок L2 (23 байта, TS 04.12) и собранная страница CBS (88 байт, TS 03.41) */
    'gsm-cbch-block':{ title:'GSM CBCH block (23 B)', group:'GSM', fields:[
      b('spare',1), b('lpd',2), b('lb',1), b('seq',4,undefined,{enum:{0:'block 1',1:'block 2',2:'block 3',3:'block 4',15:'null'}}), {n:'data',t:'bytes',len:'_left'}]},
    'gsm-cbs':{ title:'GSM cell broadcast page (88 B)', group:'GSM', fields:[
      b('gs',2,undefined,{enum:{0:'immediate, cell',1:'normal, PLMN',2:'normal, location area',3:'normal, cell'}}), b('msg_code',10), b('update',4),
      {n:'msg_id',t:'u16',fmt:'hex'}, {n:'dcs',t:'u8',fmt:'hex'},
      b('page',4), b('pages',4),
      {n:'text',t:'bytes',len:82,fmt:'gsm7',when:'((dcs&192)==64 ? ((dcs>>2)&3) : 0)==0'},
      {n:'text',t:'str',len:82,enc:'ucs2',when:'((dcs&192)==64 ? ((dcs>>2)&3) : 0)==2'},
      {n:'data8',t:'bytes',len:82,when:'((dcs&192)==64 ? ((dcs>>2)&3) : 0)==1 || ((dcs&192)==64 && ((dcs>>2)&3)==3)'}]},

    /* GSMTAP (gr-gsm, Wireshark): UDP порт 4729, 16-байтный заголовок, затем кадр канала */
    gsmtap:{ title:'GSMTAP', group:'GSM', fields:[
      {n:'version',t:'u8'}, {n:'hdr_len',t:'u8'},
      {n:'type',t:'u8',enum:{1:'GSM Um',2:'GSM Abis',3:'GSM Um burst',4:'SIM',5:'TETRA I1',6:'TETRA I1 burst',7:'WiMAX burst',8:'GB LLC',9:'GB SNDCP',10:'GMR-1 L2',11:'UMTS RLC/MAC',12:'UMTS RRC',13:'LTE RRC',14:'LTE MAC',15:'LTE MAC framed',16:'OsmoCore log',17:'QC DIAG',18:'LTE NAS'}},
      {n:'timeslot',t:'u8'}, {n:'arfcn',t:'u16'}, {n:'signal_dbm',t:'i8',fmt:'dbm'}, {n:'snr_db',t:'i8'}, {n:'frame_number',t:'u32'},
      {n:'sub_type',t:'u8',enum:{0:'unknown',1:'BCCH',2:'CCCH',3:'RACH',4:'AGCH',5:'PCH',6:'SDCCH',7:'SDCCH/4',8:'SDCCH/8',9:'TCH/F',10:'TCH/H',11:'PACCH',12:'CBCH52',13:'PDCH',14:'PTCCH',15:'CBCH51',128:'ACCH'}},
      {n:'antenna',t:'u8'}, {n:'sub_slot',t:'u8'}, {n:'rsv',t:'u8'},
      {n:'payload',t:'rest',sub:{by:'sub_type',map:{1:'gsm-l2',2:'gsm-l2',4:'gsm-l2',5:'gsm-l2',12:'gsm-cbch-block',15:'gsm-cbch-block'}}}]},

    /* заголовки pcap: Linux cooked (113) и loopback (0 / 108) перед IP */
    sll:{ title:'Linux cooked capture (SLL)', group:'Network', fields:[
      {n:'pkt_type',t:'u16',enum:{0:'to us',1:'broadcast',2:'multicast',3:'other host',4:'from us'}}, {n:'hatype',t:'u16'}, {n:'halen',t:'u16'}, {n:'addr',t:'bytes',len:8,fmt:'hex'},
      {n:'proto',t:'u16',fmt:'hex',enum:{2048:'IPv4',34525:'IPv6'}}, {n:'payload',t:'rest',sub:{by:'proto',map:{2048:'ipv4',34525:'ipv6'}}}]},
    null:{ title:'BSD loopback', group:'Network', endian:'le', fields:[
      {n:'family',t:'u32',enum:{2:'IPv4',10:'IPv6',24:'IPv6',30:'IPv6'}}, {n:'payload',t:'rest',sub:{by:'family',map:{2:'ipv4',10:'ipv6',24:'ipv6',30:'ipv6'}}}]}
  });
}
