// Ядро питомца: node tools/test-pet.mjs
// Опыт и сложность, инвентарь устройств, задания, горизонты, достижения, сохранение.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Date,Object,Array,Set,Map,JSON,Number,String,isFinite});
vm.runInContext(fs.readFileSync(path.join(root,'modules/pet-kernels.js'),'utf8')+
  ';this.K={PET_TYPES,PET_QUESTS,petBand,petXp,petSnrBonus,petLevel,petNeed,petStage,petDevices,petRanges,petHorizons,petLocked,petCanDo,petQuestMatch,petPick,petNew,petSave,petLoad,petFrame,petNag,petSay,petNewGear};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,x)=>{ if(!c){ bad++; console.log('FAIL',n,x===undefined ? '' : x); } else console.log('ok  ',n); };
const M=1e6;

// опыт: сложнее и слабее — больше
ok('xp grows with difficulty',K.petXp('OFDM',15,false,false)>K.petXp('FSK',15,false,false) && K.petXp('FSK',15,false,false)>K.petXp('AM',15,false,false));
ok('xp grows as SNR falls',K.petXp('FSK',5,false,false)>K.petXp('FSK',15,false,false) && K.petXp('FSK',15,false,false)>K.petXp('FSK',30,false,false));
ok('strong signal has no weak bonus',K.petSnrBonus(30)===0 && K.petSnrBonus(24)===0);
ok('weak bonus is capped',K.petSnrBonus(-50)===1.5);
ok('first of a class and first in a band add xp',K.petXp('PSK',12,true,true)===K.petXp('PSK',12,false,false)+6*5+20);
ok('unknown costs more than a plain carrier',K.petXp('UNK',12,false,false)>K.petXp('CAR',12,false,false)*5);

// уровни
ok('level 1 at 0 xp',K.petLevel(0).lv===1);
ok('levels rise monotonically',[0,250,700,1300,2000,5000].every((x,i,a)=>i===0 || K.petLevel(x).lv>=K.petLevel(a[i-1]).lv));
const lvEv=need=>{ const s=K.petNew(); s.xp=K.petNeed(need)-1; let tt=0, e=[]; for(let i=0;i<3;i++) e.push(...K.petFrame(s,[{f:99.5*M,type:'WFM',conf:.9,snr:20}],tt+=2000,K.petDevices([{vendorId:0x0bda,productId:0x2838}],[],{}),{})); return e.find(x=>x.kind==='level'); };
ok('level event flags a stage change only when the stage changes',lvEv(3)?.grew===true && lvEv(2)?.grew===false);
ok('level boundary',K.petLevel(K.petNeed(4)).lv===4 && K.petLevel(K.petNeed(4)-1).lv===3);
ok('stages',K.petStage(1)==='noise' && K.petStage(3)==='tone' && K.petStage(6)==='chord' && K.petStage(12)==='spectrum');

// полосы
ok('bands',K.petBand(100*M,true)[0]==='FM broadcast' && K.petBand(14e6,true)[0]==='HF' && K.petBand(433.9*M,true)[0]==='70 cm / ISM 433' && K.petBand(2440*M,true)[0]==='2.4 GHz');
ok('audio is its own band',K.petBand(1000,false)[0]==='audio');

// инвентарь
const rtl=[{vendorId:0x0bda,productId:0x2838}], hrf=[{vendorId:0x1d50,productId:0x6089}], hf=[{vendorId:0x03eb,productId:0x800c}];
let inv=K.petDevices(rtl,[],{audio:true});
ok('inventory: RTL-SDR and microphone',inv.length===2 && inv[0].name==='RTL-SDR' && inv[1].kind==='audio');
ok('inventory: unknown USB devices are skipped',K.petDevices([{vendorId:1,productId:2}],[],{}).length===0);
ok('inventory: two identical dongles are both listed',K.petDevices([...rtl,...rtl],[],{}).length===2);
ok('inventory: vendor wildcard (SDRplay)',K.petDevices([{vendorId:0x1df7,productId:0x3010}],[],{})[0].name==='SDRplay');
ok('inventory: serial tinySA is an analyzer',K.petDevices([],[{vendorId:0x0483,productId:0x5740}],{})[0].kind==='sdr');
ok('inventory: flags',K.petDevices([],[],{camera:true,ble:true,nfc:true,motion:true,gamepad:true,hid:true}).map(d=>d.kind).join()==='camera,ble,nfc,hid,gamepad,motion');

// задания по инвентарю
const q=id=>K.PET_QUESTS.find(x=>x.id===id);
ok('RTL-SDR can do FM, ADS-B, not HF or 2.4 GHz',K.petCanDo(q('fm'),inv) && K.petCanDo(q('adsb'),inv) && !K.petCanDo(q('hfssb'),inv) && !K.petCanDo(q('wifi'),inv));
ok('microphone quests need audio',K.petCanDo(q('tone'),inv) && !K.petCanDo(q('tone'),K.petDevices(rtl,[],{})));
const invH=K.petDevices(hrf,[],{});
ok('HackRF opens HF and 2.4 GHz',K.petCanDo(q('hfssb'),invH) && K.petCanDo(q('wifi'),invH));
ok('HF+ opens HF but not 1090',K.petCanDo(q('hfssb'),K.petDevices(hf,[],{})) && !K.petCanDo(q('adsb'),K.petDevices(hf,[],{})));
ok('without any gear: no quest',K.petPick(K.petNew(),[])===null);
ok('every quest has a hint and a title',K.PET_QUESTS.every(x=>x.hint && x.title && x.xp>0));
ok('quest ids are unique',new Set(K.PET_QUESTS.map(x=>x.id)).size===K.PET_QUESTS.length);

// горизонты
let st=K.petNew();
const hz=K.petHorizons(st,K.petDevices(rtl,[],{}));
ok('RTL-SDR horizons: from VHF low to L-band, no HF',hz.some(h=>h.name==='FM broadcast') && hz.some(h=>h.name==='GSM / L-band') && !hz.some(h=>h.name==='HF') && hz.every(h=>!h.open));
ok('locked horizons for RTL-SDR include HF and 2.4 GHz',K.petLocked(K.petDevices(rtl,[],{})).includes('HF') && K.petLocked(K.petDevices(rtl,[],{})).includes('2.4 GHz'));
ok('HackRF locks nothing audible-band',K.petLocked(invH).length===0 || !K.petLocked(invH).includes('FM broadcast'));

// кадр: подтверждение, порог уверенности, SNR
const fm={f:99.5*M,type:'WFM',conf:.9,snr:20};
let t=0, ev=[];
const step=l=>{ t+=2000; return K.petFrame(st,l,t,inv,{}); };
ev=step([fm]); ev=step([fm]);
ok('not caught before the confirmation count',ev.length===0 && st.xp===0);
ev=step([fm]);
const d=ev.find(e=>e.kind==='discovery');
ok('caught on the third sighting',d && d.type==='WFM' && d.band==='FM broadcast' && d.xp>0 && st.xp>=d.xp);
ok('the quest completes with the catch',ev.some(e=>e.kind==='quest' && e.id==='fm') && st.quests.fm);
ok('first catch gives the first achievement',ev.some(e=>e.kind==='achievement' && e.id==='first'));
const xp1=st.xp; ev=step([fm]); ev=step([fm]);
ok('the same signal pays once',ev.length===0 && st.xp===xp1);
// слабый повторный улов того же класса — отдельная награда
for(let i=0;i<6;i++) step([]);                    // кандидат остывает
const faint={...fm,snr:8};
step([faint]); step([faint]); ev=step([faint]);
ok('a much weaker repeat pays a weak bonus',ev.some(e=>e.kind==='weak' && e.xp>0) && st.found['WFM@FM broadcast'].low<=8,JSON.stringify(ev));
// уверенность и SNR отсекают мусор
const st2=K.petNew(); let t2=0; const step2=l=>K.petFrame(st2,l,t2+=2000,inv,{});
for(let i=0;i<5;i++) step2([{f:200*M,type:'FSK',conf:.2,snr:20}]);
ok('low confidence is not caught',st2.xp===0);
for(let i=0;i<5;i++) step2([{f:210*M,type:'FSK',conf:.9,snr:1}]);
ok('SNR below the floor is not caught',st2.xp===0);
for(let i=0;i<5;i++) step2([{f:220*M,type:'FSK',conf:.9,snr:20}, {f:0,type:'FSK'}, null]);
ok('garbage labels are ignored, a real one is caught',st2.caught===1);
// мерцающий сигнал (не подряд) уходит по таймауту и не накапливается вечно
const st3=K.petNew(); let t3=0;
K.petFrame(st3,[fm],t3+=2000,inv,{}); K.petFrame(st3,[fm],t3+=2000,inv,{});
for(let i=0;i<8;i++) K.petFrame(st3,[],t3+=2000,inv,{});
ok('a candidate is dropped after the hold time',Object.keys(st3.cand).length===0);

// звук: аудиозадания не засчитываются от радио и наоборот
const st4=K.petNew(); let t4=0, ev4=[];
for(let i=0;i<4;i++) ev4.push(...K.petFrame(st4,[{f:1000,type:'TONE',conf:.9,snr:25,rf:false}],t4+=2000,inv,{}));
ok('audio tone completes the microphone quest only',ev4.some(e=>e.kind==='quest' && e.id==='tone') && !st4.quests.fm);
ok('audio finds live in the audio horizon',Object.keys(st4.found)[0]==='TONE@audio');
const st5=K.petNew(); let t5=0, ev5=[];
for(let i=0;i<4;i++) ev5.push(...K.petFrame(st5,[{f:1000e3,type:'TONE',conf:.9,snr:25}],t5+=2000,inv,{}));
ok('an RF tone does not complete the audio quest',!ev5.some(e=>e.id==='tone'));
ok('a quest without the gear is not completed',(()=>{ const s=K.petNew(); let tt=0; const e=[]; for(let i=0;i<4;i++) e.push(...K.petFrame(s,[{f:14.074*M,type:'DIG',conf:.9,snr:15}],tt+=2000,K.petDevices(rtl,[],{}),{})); return !e.some(x=>x.id==='hfdig'); })());
ok('weak quest needs a low SNR',(()=>{ const s=K.petNew(); let tt=0; const e=[]; for(let i=0;i<4;i++) e.push(...K.petFrame(s,[{f:300*M,type:'NFM',conf:.9,snr:7}],tt+=2000,inv,{})); return e.some(x=>x.id==='weak'); })());

// выбор задания: сначала неоткрытые горизонты
const st6=K.petNew();
const first=K.petPick(st6,inv);
ok('a quest is offered',first && K.petCanDo(first,inv));
st6.quests[first.id]={}; st6.found['WFM@FM broadcast']={low:10,best:10,n:1,f:1};
const second=K.petPick(st6,inv);
ok('done quests are not offered again',second && second.id!==first.id);
st6.skip[second.id]=1;
ok('skipped quests are not offered',K.petPick(st6,inv).id!==second.id);

// достижения и уровни
const st7=K.petNew(); let t7=0; const evs=[];
const kinds=['OFDM','PSK','MFSK','FSK','OOK','NFM'];
for(let k=0;k<kinds.length;k++) for(let i=0;i<3;i++) evs.push(...K.petFrame(st7,[{f:(150+k*40)*M,type:kinds[k],conf:.9,snr:12}],t7+=2000,inv,{}));
ok('several classes: taxonomist and hard-one achievements',st7.ach.types5 && st7.ach.hard);
ok('xp accumulates into levels',K.petLevel(st7.xp).lv>1 && evs.some(e=>e.kind==='level'));
ok('faint heart for SNR 10 dB or below',st.ach.faint);

// совет по артефакту
const st8=K.petNew();
ok('nag names an unknown digital signal and the next tool',/433\.920 MHz.*OOK.*ISM Scanner/.test(K.petNag(st8,[{f:433.92*M,type:'OOK',snr:15}])));
ok('nag picks the strongest',/868\.000/.test(K.petNag(st8,[{f:433.92*M,type:'OOK',snr:10},{f:868*M,type:'FSK',snr:25}])));
ok('nag ignores plain classes and known ones',K.petNag(st8,[{f:99*M,type:'WFM',snr:30}])==='' && K.petNag(st,[{f:99*M,type:'FSK',snr:30}])!=='');
st8.found['OOK@70 cm / ISM 433']={low:10,best:10,n:1,f:1};
ok('nag is silent once the class is known in that band',K.petNag(st8,[{f:433.92*M,type:'OOK',snr:15}])==='');

// голос
const sayInv=K.petDevices(rtl,[],{});
ok('without gear it asks for a sense',/no senses/.test(K.petSay(K.petNew(),[],[],'',0,0)));
ok('an event outranks everything else',/Level|Quest done|New/.test(K.petSay(K.petNew(),sayInv,[{kind:'discovery',type:'WFM',f:99.5*M,band:'FM broadcast',snr:20,xp:50}],'nag',0,0)));
ok('a nag outranks the quest',K.petSay(K.petNew(),sayInv,[],'nag text',0,0)==='nag text');
ok('the quest is read out',/^Quest:/.test(K.petSay(K.petNew(),sayInv,[],'',0,0)));
ok('long idle makes it hungry',/^I am hungry/.test(K.petSay(K.petNew(),sayInv,[],'',20*60000,0)));
const done=K.petNew(); for(const x of K.PET_QUESTS) done.quests[x.id]={};
ok('all quests done: names what is out of reach',/Beyond reach.*HF/.test(K.petSay(done,sayInv,[],'',0,0)));

// новое железо
const st9=K.petNew();
const g1=K.petNewGear(st9,K.petDevices(rtl,[],{audio:true}));
ok('new gear is announced once, with its horizon count',g1.length===2 && g1[0].name==='RTL-SDR' && g1[0].horizons>=8 && K.petNewGear(st9,K.petDevices(rtl,[],{audio:true})).length===0);
ok('a second device is announced later',K.petNewGear(st9,K.petDevices([...rtl,...hrf],[],{audio:true})).map(e=>e.name).join()==='HackRF One');

// сохранение
const saved=JSON.stringify(K.petSave(st7)), st10=K.petNew();
ok('save → load restores xp, finds, quests, achievements',K.petLoad(st10,JSON.parse(saved)) && st10.xp===st7.xp && Object.keys(st10.found).length===Object.keys(st7.found).length && JSON.stringify(st10.ach)===JSON.stringify(st7.ach));
ok('save leaves out candidates',!('cand' in JSON.parse(saved)));
ok('load: garbage is refused',!K.petLoad(K.petNew(),null) && !K.petLoad(K.petNew(),{v:2}) && !K.petLoad(K.petNew(),{v:1,xp:'x',found:{}}) && !K.petLoad(K.petNew(),{v:1,xp:1}));
ok('save is small',saved.length<4000,saved.length);

console.log(bad ? bad+' failed' : 'all ok');
process.exit(bad ? 1 : 0);
