const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const scope=vm.createContext({});vm.runInContext(fs.readFileSync(path.join(__dirname,'../inline-labels/label-menu.js'),'utf8'),scope);
const tags=[{key:'p',tag:'Work'},{key:'c',tag:'Work/PhD'},{key:'g',tag:'Work/PhD/Project'},{key:'x',tag:'Workshops'},{key:'o',tag:'Other'}];
test('editing a label plans the entire subtree without changing native keys or unrelated prefixes',()=>{
 const plan=scope.labelRenamePlan(tags,'p','Lab');
 assert.deepEqual(Array.from(plan,p=>[p.key,p.after]),[['p','Lab'],['c','Lab/PhD'],['g','Lab/PhD/Project']]);
 assert.throws(()=>scope.labelRenamePlan(tags,'p','Work/Child'),/itself/);
 assert.throws(()=>scope.labelRenamePlan(tags,'p','Other'),/already exists/);
 assert.throws(()=>scope.labelRenamePlan([...tags,{key:'collision',tag:'Lab/PhD'}],'p','Lab'),/already exists/);
 assert.throws(()=>scope.labelRenamePlan(tags,'gone','New'),/no longer exists/);
 assert.throws(()=>scope.labelRenamePlan(tags,'p','Lab//Child'),/empty path/);
});
test('a failed subtree rename restores earlier changes',()=>{
 const names=new Map(tags.map(t=>[t.key,t.tag]));
 assert.throws(()=>scope.renameNativeLabel(tags,'p','Lab',{setTagForKey(key,value){if(key==='c' && value==='Lab/PhD')throw Error('write failed');names.set(key,value);}}),/write failed/);
 assert.deepEqual([...names],tags.map(t=>[t.key,t.tag]));
});
test('message-list visibility stores exact keys and tolerates absent/corrupt preferences',()=>{
 assert.equal(scope.hiddenMessageLabelKeys(null).size,0);
 assert.equal(scope.hiddenMessageLabelKeys({getStringPref:()=>'{bad'}).size,0);
 assert.equal(scope.hiddenMessageLabelKeys({getStringPref:()=>'{}'}).size,0);
 const hidden=scope.hiddenMessageLabelKeys({getStringPref:()=>'["p",42,"c"]'});
 assert.deepEqual([...hidden],['p','c']);assert.equal(hidden.has('g'),false);
});

test('sidebar passes the native tags service rather than its MailServices container',()=>{
 let received;const tagsService={getAllTags:()=>[]};
 const local=vm.createContext({installSidebarLabelMenu(_win,service){received=service;return {close(){}}}});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../inline-labels/nested-labels.js'),'utf8'),local);
 const prefs={addObserver(){},removeObserver(){}};
 const win={document:{getElementById:()=>({})},MutationObserver:class{observe(){} disconnect(){}},setTimeout(){return 1},clearTimeout(){}};
 const controller=local.installNestedLabelSidebar(win,{tags:tagsService},prefs);
 assert.equal(received,tagsService);controller.close();
});

test('sidebar visibility persists exact stable keys independently of message chip visibility',()=>{
 const values=new Map([['extensions.thunderg.hiddenMessageLabels','["p"]']]);
 const prefs={getStringPref:(key,fallback)=>values.get(key)??fallback,setStringPref:(key,value)=>values.set(key,value)};
 scope.setSidebarLabelMode(prefs,'p','hide');scope.setSidebarLabelMode(prefs,'c','unread');
 assert.deepEqual(Array.from(scope.sidebarLabelModes(prefs),entry=>Array.from(entry)),[['p','hide'],['c','unread']]);
 scope.setSidebarLabelMode(prefs,'p','show');assert.deepEqual(Array.from(scope.sidebarLabelModes(prefs),entry=>Array.from(entry)),[['c','unread']]);
 assert.equal(values.get('extensions.thunderg.hiddenMessageLabels'),'["p"]');
 assert.throws(()=>scope.setSidebarLabelMode(prefs,'p','invalid'),/visibility/);
 assert.equal(scope.sidebarLabelModes({getStringPref:()=>'{bad'}).size,0);
 assert.equal(scope.sidebarLabelModes({getStringPref:()=>'[]'}).size,0);
 assert.deepEqual(Array.from(scope.sidebarLabelModes({getStringPref:()=>'\u007b"a":"hide","b":"unread","c":"bad"\u007d'}),entry=>Array.from(entry)),[['a','hide'],['b','unread']]);
});

test('bulk move retains selected subtrees once, preserving keys and unrelated labels',()=>{
 const plan=scope.bulkLabelMovePlan(tags,['p','c','x'],'o');
 assert.deepEqual(Array.from(plan,item=>[item.key,item.after]),[['p','Other/Work'],['c','Other/Work/PhD'],['g','Other/Work/PhD/Project'],['x','Other/Workshops']]);
 assert.deepEqual(Array.from(scope.bulkLabelMovePlan(tags,['c'],null),item=>item.after),['PhD','PhD/Project']);
 assert.equal(scope.bulkLabelMovePlan(tags,['p'],undefined).length,0);
 assert.throws(()=>scope.bulkLabelMovePlan(tags,['p'],'g'),/itself/);
 assert.throws(()=>scope.bulkLabelMovePlan(tags,['p','missing'],null),/no longer exists/);
 assert.throws(()=>scope.bulkLabelMovePlan(tags,['p'],'missing'),/no longer exists/);
 assert.throws(()=>scope.bulkLabelMovePlan([...tags,{key:'z',tag:'Other/work'}],['p'],'o'),/already exists/);
 assert.throws(()=>scope.bulkLabelMovePlan([{key:'a',tag:'A/X'},{key:'b',tag:'B/X'}],['a','b'],null),/already exists/);
});
function bulkFixture(fail=()=>false){
 const values=new Map([['extensions.thunderg.hiddenMessageLabels','["o"]']]);
 const names=new Map(tags.map(tag=>[tag.key,tag.tag])),colors=new Map(tags.map(tag=>[tag.key,'#123456']));
 const prefs={getStringPref:(key,fallback)=>values.get(key)??fallback,setStringPref(key,value){if(fail('pref',key,value))throw Error('write failed');values.set(key,value)}};
 const service={getAllTags:()=>tags.map(tag=>({...tag,tag:names.get(tag.key),color:colors.get(tag.key)})),setTagForKey(key,value){if(fail('name',key,value))throw Error('write failed');names.set(key,value)},setColorForKey(key,value){if(fail('color',key,value))throw Error('write failed');colors.set(key,value)}};
 return {values,names,colors,prefs,service};
}
test('bulk changes only selected colors/visibility and keep message keys while moving descendants',()=>{
 const f=bulkFixture();scope.applyBulkLabelChanges(f.service,f.prefs,['p','x'],{parentKey:'o',color:'#aabbcc',sidebar:'unread',messageHidden:true});
 assert.equal(f.names.get('g'),'Other/Work/PhD/Project');
 assert.equal(f.colors.get('p'),'#aabbcc');assert.equal(f.colors.get('x'),'#aabbcc');assert.equal(f.colors.get('g'),'#123456');
 assert.deepEqual(JSON.parse(f.values.get('extensions.thunderg.hiddenMessageLabels')),['o','p','x']);
 assert.deepEqual(JSON.parse(f.values.get('extensions.thunderg.sidebarLabelVisibility')),{p:'unread',x:'unread'});
 scope.applyBulkLabelChanges(f.service,f.prefs,['p','x'],{sidebar:'show',messageHidden:false});
 assert.equal(f.values.get('extensions.thunderg.sidebarLabelVisibility'),'{}');
 assert.deepEqual(JSON.parse(f.values.get('extensions.thunderg.hiddenMessageLabels')),['o']);
});
test('bulk validates every path before writing and rolls back names, colors and preferences on failure',()=>{
 for(const failure of ['name','color','pref']){
  let failed=false;
  const f=bulkFixture((kind,key,value)=>{if(!failed && kind===failure && (failure==='pref'?key==='extensions.thunderg.hiddenMessageLabels':key==='x')){failed=true;return true}return false});
  assert.throws(()=>scope.applyBulkLabelChanges(f.service,f.prefs,['p','x'],{parentKey:'o',color:'#abcdef',sidebar:'hide',messageHidden:true}),/write failed/);
  assert.deepEqual([...f.names],tags.map(tag=>[tag.key,tag.tag]));
  assert.ok([...f.colors.values()].every(value=>value==='#123456'));
  assert.deepEqual(JSON.parse(f.prefs.getStringPref('extensions.thunderg.sidebarLabelVisibility','{}')),{});
  assert.equal(f.values.get('extensions.thunderg.hiddenMessageLabels'),'["o"]');
 }
 const f=bulkFixture();assert.throws(()=>scope.applyBulkLabelChanges(f.service,f.prefs,['p'],{parentKey:'g',color:'#abcdef'}),/itself/);
 assert.deepEqual([...f.names],tags.map(tag=>[tag.key,tag.tag]));
});
test('bulk selection uses native selected label rows only, and unselected menus remain single-label',()=>{
 const a={dataset:{tagKey:'p'}},b={dataset:{tagKey:'x'}},folder={dataset:{}};
 const tree={selection:new Set([a,b,folder])};
 assert.deepEqual(Array.from(scope.selectedSidebarLabelKeys(tree,a)),['p','x']);
 assert.deepEqual(Array.from(scope.selectedSidebarLabelKeys(tree,{dataset:{tagKey:'o'}})),['o']);
});
