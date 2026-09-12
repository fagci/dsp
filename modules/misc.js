/* ---------- группы (вложенные подграфы) ---------- */
const PORT_TYPES=['sig','num','spec','img','txt','blk'];

def({ id:'gin', title:'Group Input', cat:'Misc',
  outs:n=>[{n:'out',t:n.p.type||'sig'}],
  params:[{n:'name',t:'text',d:'in',label:'port name'},
          {n:'type',t:'select',opts:PORT_TYPES,d:'sig'}],
  init:n=>{n.ext=null;},
  process(n){ return {out:n.ext}; }});


def({ id:'gout', title:'Group Output', cat:'Misc',
  ins:n=>[{n:'in',t:n.p.type||'sig'}],
  params:[{n:'name',t:'text',d:'out',label:'port name'},
          {n:'type',t:'select',opts:PORT_TYPES,d:'sig'}],
  init:n=>{n.val=null;},
  process(n,I){ n.val=I.in; return {}; }});


def({ id:'group', title:'Group', cat:'Misc',
  ins:n=>(n.inst? n.inst.ins.map(x=>({n:x.name,t:x.node.p.type||'sig'})) : []),
  outs:n=>(n.inst? n.inst.outs.map(x=>({n:x.name,t:x.node.p.type||'sig'})) : []),
  readout:true,
  params:[{n:'title',t:'text',d:'group',label:'name'},
          {n:'open',t:'button',label:'Open',fn:n=>enterGroup(n)}],
  init:n=>{ if(!n.sub) n.sub={nodes:[],edges:[]}; instGroup(n); },
  dispose:n=>{                                      // группа держит собственные live-инстансы (n.inst),
    n.inst?.nodes.forEach(c=>{                       // отдельные от того, что видно при входе внутрь —
      try{ MOD[c.type]?.dispose?.(c); }              // их тоже надо освободить, иначе вложенный
      catch(e){ console.error('dispose '+c.type+':',e); } }); },   // stream/cam и т.п. переживёт группу
  process(n,I){
    const g=n.inst; if(!g) return {};
    for(const x of g.ins) x.node.ext = I[x.name];    // внешние входы → внутренние источники
    for(const nd of g.order) evalNode(nd,g);
    const o={};
    for(const x of g.outs) o[x.name]=x.node.val;
    return o; },
  draw(n){ const g=n.inst;
    n.el.querySelector('.readout').textContent =
      (n.p.title||'group')+' · nodes '+(g?g.nodes.length:0); }});


function instGroup(n){                               // развернуть описание в живые экземпляры
  const sub=n.sub||{nodes:[],edges:[]};
  const map={}, nodes=[];
  for(const nd of sub.nodes){
    const inst=makeNode(nd.type,nd.p,nd.id,nd.x,nd.y);
    if(!inst) continue;
    if(nd.w){ inst.size.w=nd.w; inst.size.h=nd.h||inst.size.h; }
    if(nd.type==='group'){ inst.sub=nd.sub||{nodes:[],edges:[]}; instGroup(inst); }
    map[nd.id]=inst; nodes.push(inst); }
  const edges=(sub.edges||[]).map(e=>({from:e.from,fp:e.fp,to:e.to,tp:e.tp}));
  const ctx={nodes,edges,map};
  ctx.order=topoOrder(nodes,edges,map);
  ctx.ins=nodes.filter(x=>x.type==='gin').map(x=>({name:x.p.name,node:x}));
  ctx.outs=nodes.filter(x=>x.type==='gout').map(x=>({name:x.p.name,node:x}));
  n.inst=ctx;
}

const GStack=[];                                     // стек открытых групп
function enterGroup(n){
  GStack.push({parent:serialize(), id:n.id});
  const sub=n.sub||{nodes:[],edges:[]};
  Undo.busy=true;
  deserialize({v:1,view:{...view},nodes:sub.nodes,edges:sub.edges});
  Undo.busy=false;
  updCrumb();
}
function exitGroup(){
  if(!GStack.length) return;
  const st=GStack.pop();
  const sub=serialize();
  Undo.busy=true;
  deserialize(st.parent);
  const g=Graph.map[st.id];
  if(g){ g.sub={nodes:sub.nodes,edges:sub.edges};
    instGroup(g);
    const keep=Graph.edges.filter(e=>{                // рвём связи к исчезнувшим портам
      if(e.to===g.id) return portsOf(g,'ins').some(p=>p.n===e.tp);
      if(e.from===g.id) return portsOf(g,'outs').some(p=>p.n===e.fp);
      return true; });
    Graph.edges.filter(e=>!keep.includes(e)).forEach(delEdge);
    rebuildNode(g); }
  Undo.busy=false;
  Undo.push(); updCrumb();
}
function updCrumb(){
  const el=document.getElementById('crumb');
  if(!el) return;
  el.style.display=GStack.length?'inline-block':'none';
  el.textContent='↑ exit group ('+GStack.length+')';
}

function groupSel(){                                 // свернуть выделенное в группу
  const sel=Graph.nodes.filter(n=>Sel.has(n.id));
  if(sel.length<1){ stat.textContent='select nodes first'; return; }
  const ids=new Set(sel.map(n=>n.id));
  const inner=Graph.edges.filter(e=>ids.has(e.from)&&ids.has(e.to));
  const inc=Graph.edges.filter(e=>!ids.has(e.from)&&ids.has(e.to));
  const out=Graph.edges.filter(e=>ids.has(e.from)&&!ids.has(e.to));
  const x0=Math.min(...sel.map(n=>n.x)), y0=Math.min(...sel.map(n=>n.y));
  const nodes=sel.map(n=>({id:n.id,type:n.type,x:n.x-x0,y:n.y-y0,
                           w:n.size.w,h:n.size.h,p:{...n.p},sub:n.sub}));
  const edges=inner.map(e=>({from:e.from,fp:e.fp,to:e.to,tp:e.tp}));
  let seq=1;
  const extIn=[], extOut=[];
  for(const e of inc){                               // каждый входящий провод даёт порт-вход
    const t=portsOf(Graph.map[e.from],'outs').find(p=>p.n===e.fp)?.t||'sig';
    const gid='gi'+(seq++), name='in'+extIn.length;
    nodes.push({id:gid,type:'gin',x:-160,y:extIn.length*90,p:{name,type:t}});
    edges.push({from:gid,fp:'out',to:e.to,tp:e.tp});
    extIn.push({name,src:e.from,sp:e.fp}); }
  for(const e of out){
    const t=portsOf(Graph.map[e.from],'outs').find(p=>p.n===e.fp)?.t||'sig';
    const gid='go'+(seq++), name='out'+extOut.length;
    nodes.push({id:gid,type:'gout',x:900,y:extOut.length*90,p:{name,type:t}});
    edges.push({from:e.from,fp:e.fp,to:gid,tp:'in'});
    extOut.push({name,dst:e.to,dp:e.tp}); }
  const g=addNode('group',x0,y0,{title:'group'});
  g.sub={nodes,edges}; instGroup(g); rebuildNode(g);
  sel.forEach(delNode);
  for(const x of extIn) addEdge(x.src,x.sp,g.id,x.name);
  for(const x of extOut) addEdge(g.id,x.name,x.dst,x.dp);
  Sel.clear(); Sel.add(g.id); syncSel();
  drawWires(); Undo.push();
  stat.textContent='grouped nodes: '+sel.length;
}
function ungroupSel(){                               // развернуть обратно
  const g=Graph.nodes.find(n=>n.type==='group'&&Sel.has(n.id));
  if(!g) return;
  const sub=g.sub||{nodes:[],edges:[]};
  const outer=Graph.edges.filter(e=>e.from===g.id||e.to===g.id)
    .map(e=>({from:e.from,fp:e.fp,to:e.to,tp:e.tp}));
  const map={};
  Sel.clear();
  for(const nd of sub.nodes){
    if(nd.type==='gin'||nd.type==='gout'){ map[nd.id]=null; continue; }
    const nn=addNode(nd.type,g.x+nd.x,g.y+nd.y,nd.p);
    if(nd.sub){ nn.sub=nd.sub; instGroup(nn); rebuildNode(nn); }
    if(nd.w){ nn.size.w=nd.w; nn.size.h=nd.h||nn.size.h; applySize(nn); }
    map[nd.id]=nn.id; Sel.add(nn.id); }
  const gins={}, gouts={};
  for(const nd of sub.nodes){
    if(nd.type==='gin') gins[nd.p.name]=nd.id;
    if(nd.type==='gout') gouts[nd.p.name]=nd.id; }
  for(const e of sub.edges){
    if(map[e.from]&&map[e.to]) addEdge(map[e.from],e.fp,map[e.to],e.tp); }
  for(const oe of outer){                            // внешние провода на внутренние узлы
    if(oe.to===g.id){
      const gid=gins[oe.tp];
      for(const e of sub.edges) if(e.from===gid&&map[e.to])
        addEdge(oe.from,oe.fp,map[e.to],e.tp);
    } else {
      const gid=gouts[oe.fp];
      for(const e of sub.edges) if(e.to===gid&&map[e.from])
        addEdge(map[e.from],e.fp,oe.to,oe.tp); } }
  delNode(g); syncSel(); drawWires(); Undo.push();
}

def({ id:'note', title:'Note', cat:'Misc', resize:true,
  params:[{n:'text',t:'code',d:'Note: what this part of the patch does'}],
  process(){ return {}; }});
