const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const scope=vm.createContext({console});vm.runInContext(fs.readFileSync(path.join(__dirname,'../thunder-g/label-navigation.js'),'utf8'),scope);
test('chip navigation resolves exact native keys, reveals tag mode and clears reader/filter state',()=>{
 const tags=[{key:'exact',tag:'confs/mw26'},{key:'different',tag:'confs-mw26'}],calls=[];
 const values={sticky:true,text:{text:'unrelated'},unread:true};
 const pane={folderPane:{activeModes:['all']},CustomEvent:class{constructor(type){this.type=type}},dispatchEvent:e=>calls.push(e.type),displayFolder:uri=>calls.push(uri),
 quickFilterBar:{filterer:{filterValues:values,clear(){calls.push('clear-native-filters');for(const key of Object.keys(values))delete values[key]},setFilterValue(key,value){calls.push([key,value]);values[key]=value}},updateSearch(){},reflectFiltererState(){}}};
 const win={document:{getElementById:()=>({currentAbout3Pane:pane})}};
 const service={tags:{getAllTags:()=>tags}},smart={getSmartMailbox:()=>({getTagFolder(tag){assert.equal(tag,tags[0]);return {URI:'native://exact-tag'}}})};
 assert.equal(scope.openNativeLabelView(win,'exact',service,smart),'native://exact-tag');
 assert.deepEqual([...pane.folderPane.activeModes],['all','tags']);assert.equal(calls[0],'gm-open-label-view');assert.equal(calls.at(-1),'native://exact-tag');
 assert.deepEqual(values,{sticky:true});assert.throws(()=>scope.openNativeLabelView(win,'deleted',service,smart),/no longer exists/);
});
test('text click/Enter navigate, remove buttons do not, cleanup restores native attributes',()=>{
 const attrs=new Map([['title','original']]),events={},calls=[];
 const node={style:{cursor:'default'},getAttribute:key=>attrs.get(key)??null,setAttribute:(k,v)=>attrs.set(k,v),removeAttribute:k=>attrs.delete(k),addEventListener:(k,f)=>events[k]=f,removeEventListener:k=>delete events[k]};
 const cleanup=scope.bindLabelNavigation(node,{key:'key with/slash',tag:'Nested/Label'}, {},(_win,key)=>calls.push(key));
 assert.equal(node.title,'Show all messages with label Nested/Label');assert.equal(attrs.get('role'),'link');
 const event={target:{closest:()=>null},preventDefault(){},stopImmediatePropagation(){},stopPropagation(){}};
 events.click(event);events.keydown({...event,target:node,key:'Enter'});assert.deepEqual(calls,['key with/slash','key with/slash']);
 events.click({...event,target:{closest:()=>({})}});events.keydown({...event,target:node,key:'Escape'});assert.equal(calls.length,2);
 cleanup();assert.equal(attrs.get('title'),'original');assert.equal(attrs.has('role'),false);assert.equal(node.style.cursor,'default');assert.deepEqual(events,{});
});
