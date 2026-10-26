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
