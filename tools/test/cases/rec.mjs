// Rec: Unique by Key — дедупликация записей по ключу с подсчётом и временем first/last.

export default [
  {name:'rec: recUniq dedups by key, counts and merges', fn(){
    const n={p:{key:'id', mode:'merge (last wins)', max:1000}};
    MOD.recUniq.init(n);
    let o=MOD.recUniq.process(n,{rec:[{id:'A',v:1,t:1000},{id:'B',v:2,t:1000}]});
    if(o.count!==2) return 'after first batch count='+o.count;
    if(!o.new || o.new.length!==2) return 'new should be 2, got '+(o.new&&o.new.length);
    o=MOD.recUniq.process(n,{rec:{id:'A',v:9,t:2000}});
    if(o.count!==2) return 'repeat should not add a key, count='+o.count;
    if(o.new) return 'repeat should not be new';
    const a=n.map.get('A');
    if(a.count!==2) return 'A count='+a.count;
    if(a.v!==9) return 'merge (last wins) should update v, got '+a.v;
    if(a.first!==1000 || a.last!==2000) return 'first/last='+a.first+'/'+a.last;
    return true;
  }},

  {name:'rec: recUniq first-only keeps original fields', fn(){
    const n={p:{key:'id', mode:'first only', max:1000}};
    MOD.recUniq.init(n);
    MOD.recUniq.process(n,{rec:{id:'X',v:1,t:1}});
    MOD.recUniq.process(n,{rec:{id:'X',v:5,t:2}});
    const x=n.map.get('X');
    return (x.v===1 && x.count===2 && x.last===2) || 'x='+JSON.stringify(x);
  }},

  {name:'rec: recUniq skips records without the key', fn(){
    const n={p:{key:'id', mode:'merge (last wins)', max:1000}};
    MOD.recUniq.init(n);
    const o=MOD.recUniq.process(n,{rec:[{foo:1},{id:'',v:1},{id:'Z',v:2}]});
    return (o.count===1 && n.map.has('Z')) || 'count='+o.count;
  }},
];
