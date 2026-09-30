// Messages и Subscribers: единый вид сообщений и абонентов поверх записей разных протоколов
export const nxdnTests = [];
export function setup(){
// генератор → приёмник → msgLog + subLog; возвращает записи выходов узлов
window.commsRun = (nodes, sec, sig) => {
  const [g, w] = [[...nodes, ['msgLog', {sig:!!sig}], ['subLog', {}]], ['0.iq>1.in', '1.rec>2.rec', '1.rec>3.rec']];
  const ns = T.build(g, w), n = Math.ceil(sec*Eng.sr/BLOCK), msgs = [], subs = [];
  for(let b=0; b<n; b++){
    for(const o of Eng.outs) o.fill(0);
    for(const nd of Graph.order) evalNode(nd);
    Eng.blocks++;
    if(ns[2].out.msgs) msgs.push(...ns[2].out.msgs);
    if(ns[3].out.stations) subs.push(...ns[3].out.stations);
  }
  const last = new Map(); for(const s of subs) last.set(s.id, s);
  return {msgs, subs:[...last.values()], ns, errors:T.errors()};
};
window.commsGen = (fsk4, proto) => [['iqGen', {sr:'256000', fc:433e6, mode:'4FSK', off:2000, lvl:-20, noise:-45, fsk4}], ['fskRx', {proto}]];

}

export default [
  {name:'comms: D-STAR text and GPS become messages (text / location), the caller shows up as a subscriber with the repeater', async fn(){
    let r = commsRun(commsGen('D-STAR voice', 'dstar'), 5);
    if(r.errors.length) return r.errors.join('; ');
    if(!r.msgs.some(m => m.src === 'D-STAR' && m.type === 'text' && m.text === 'Hello D-STAR world!!')) return 'no text: '+JSON.stringify(r.msgs.slice(0, 2));
    const s = r.subs.find(x => x.id === 'D-STAR:N0CALL');
    if(!s || s.calls < 1 || s.seconds <= 0 || s.via !== 'DB0XX  B') return 'subscriber '+JSON.stringify(r.subs);
    r = commsRun(commsGen('D-STAR GPS', 'dstar'), 5);
    const g = r.msgs.find(m => m.type === 'location');
    if(!g || Math.abs(g.lat-48.1173) > 1e-3 || Math.abs(g.lon-11.5167) > 1e-3) return 'no location: '+JSON.stringify(r.msgs.slice(0, 2));
    const st = r.subs.find(x => x.lat != null);
    if(!st || Math.abs(st.lat-48.1173) > 1e-3) return 'no position on the subscriber: '+JSON.stringify(r.subs);
    return true;
  }},
  {name:'comms: P25 data PDUs (NMEA position, IP / UDP) and M17 SMS packets are messages; trunking is signalling only when asked', async fn(){
    let r = commsRun(commsGen('P25 data (PDU)', 'p25'), 6);
    if(r.errors.length) return r.errors.join('; ');
    const loc = r.msgs.find(m => m.src === 'P25' && m.type === 'location');
    if(!loc || Math.abs(loc.lat-48.1173) > 1e-3 || loc.from !== '1234567') return 'P25 location: '+JSON.stringify(loc);
    const udp = r.msgs.find(m => m.src === 'P25' && m.service === 'UDP 5000');
    if(!udp || udp.ip !== '10.1.2.3 → 10.4.5.6' || udp.to !== '1193046') return 'P25 UDP: '+JSON.stringify(udp);
    if(r.msgs.some(m => m.type === 'signalling')) return 'signalling without the check';
    r = commsRun(commsGen('P25 data (PDU)', 'p25'), 6, true);
    if(!r.msgs.some(m => m.type === 'signalling' && m.service === 'NET_STS_BCST')) return 'no MBT with the check: '+JSON.stringify(r.msgs.map(m => m.type+':'+m.service));
    r = commsRun(commsGen('M17 packet (SMS)', 'm17'), 5);
    const sms = r.msgs.find(m => m.src === 'M17' && m.type === 'text');
    if(!sms || sms.text !== 'Hello from M17' || sms.from !== 'N0CALL' || sms.to !== 'ECHO') return 'M17 SMS: '+JSON.stringify(r.msgs.slice(0, 2));
    return true;
  }},
  {name:'comms: subscribers and groups from calls of P25, NXDN, dPMR, YSF, M17 (talker, destination, seconds, group)', async fn(){
    for(const [g, proto, id, dest, grp] of [['P25 voice', 'p25', 'P25:1234567', 'P25:4321', true], ['NXDN 9600 voice', 'nxdn', 'NXDN:1234', 'NXDN:4321', true], ['dPMR voice', 'dpmr', 'dPMR:7654321', 'dPMR:1234567', false],
                                             ['YSF V/D mode 2', 'ysf', 'YSF:N0CALL', 'YSF:CQCQCQ', true], ['M17 voice stream', 'm17', 'M17:SP5WWP', 'M17:W2FBI', false]]){
      const r = commsRun(commsGen(g, proto), 5);
      if(r.errors.length) return r.errors.join('; ');
      const s = r.subs.find(x => x.id === id);
      if(!s || s.calls < 1) return g+': talker '+id+' '+JSON.stringify(r.subs.map(x => x.id));
      const d = r.subs.find(x => x.id === dest);
      if(grp ? d : !d) return g+': destination '+dest+' '+(grp ? 'must be a group, not a subscriber' : 'missing');
      const sub = r.ns[3];
      if(grp && ![...sub.gr.values()].some(x => x.calls >= 1 && x.stations.has(id.split(':')[1]))) return g+': no group '+dest;
    }
    return true;
  }},
  {name:'comms: DMR SMS / LRRP messages and talker alias (dmrRx → Messages, Subscribers)', async fn(){
    const [g, w] = [[['iqGen', {sr:'256000', fc:438e6, mode:'DMR', off:2000, lvl:-20, noise:-45}], ['dmrRx', {}], ['msgLog', {}], ['subLog', {}]], ['0.iq>1.in', '1.rec>2.rec', '1.rec>3.rec']];
    const ns = T.build(g, w), n = Math.ceil(9*Eng.sr/BLOCK); let msgs = [];
    for(let b=0; b<n; b++){
      for(const o of Eng.outs) o.fill(0);
      for(const nd of Graph.order) evalNode(nd);
      Eng.blocks++;
      if(ns[2].out.msgs) msgs.push(...ns[2].out.msgs);
    }
    const e = T.errors(); if(e.length) return e.join('; ');
    if(!msgs.some(m => m.src === 'DMR' && m.type === 'text' && m.text)) return 'no DMR text: '+JSON.stringify(msgs.slice(0, 3));
    const s = [...ns[3].st.values()];
    if(!s.some(x => x.proto === 'DMR' && x.id === '2600123' && x.calls >= 1)) return 'DMR talker: '+JSON.stringify(s.map(x => x.id));
    if(![...ns[3].gr.values()].some(g => g.proto === 'DMR' && g.calls >= 1)) return 'no DMR group';
    return true;
  }},
  {name:'comms: protocol filter — Messages / Subscribers with protocol = P25 ignore D-STAR records', async fn(){
    const [g, w] = [[...commsGen('D-STAR voice', 'dstar'), ['msgLog', {proto:'P25'}], ['subLog', {proto:'P25'}]], ['0.iq>1.in', '1.rec>2.rec', '1.rec>3.rec']];
    const ns = T.build(g, w), n = Math.ceil(4*Eng.sr/BLOCK);
    for(let b=0; b<n; b++){ for(const o of Eng.outs) o.fill(0); for(const nd of Graph.order) evalNode(nd); Eng.blocks++; }
    return ns[2].rows.length === 0 && ns[3].st.size === 0 ? true : 'filter leaked: '+ns[2].rows.length+' messages, '+ns[3].st.size+' subscribers';
  }},
];
