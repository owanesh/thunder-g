const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm'), fs=require('node:fs'), path=require('node:path');

test('native keyword notifications refresh open conversations and unsubscribe on shutdown',async()=>{
  let listener, windows, cleanup, refreshed=0, disposed=0, removed;
  const mail={mfn:{addListener(value,flags){listener=value;assert.equal(flags,8)},removeListener(value){removed=value}}};
  const support={registerWindowListener(id,value){windows=value},unregisterWindowListener(){}};
  const scope=vm.createContext({ChromeUtils:{importESModule:()=>({
    ExtensionCommon:{ExtensionAPI:class{},EventManager:class{api(){return {}}}},ExtensionSupport:support,MailServices:mail,ExtensionParent:{}})},
    Services:{prefs:{addObserver(){},removeObserver(){}}},
    Ci:{nsIDOMWindowUtils:{USER_SHEET:1},nsIMsgFolderNotificationService:{msgPropertyChanged:8}},
    GMAIL_SKIN_CSS:'',GMAIL_CONVERSATIONS_CSS:'',
    createComposeAutosave:()=>({set(enabled,minutes){assert.equal(enabled,true);assert.equal(minutes,1)},close(){}}),
    installMailZoom:()=>({close(){}}),
    installConversationStyle:()=>({refresh(){refreshed++},close(){disposed++}})});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../thunder-g/label-menu.js'),'utf8'),scope);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../thunder-g/experiments/api.js'),'utf8'),scope);
  const api=new scope.inlineLabels().getAPI({extension:{id:'test'},callOnClose(value){cleanup=value}});
  await api.inlineLabels.start();
  const sheets=new Set(),events=new Map();
  const win={windowUtils:{loadSheetUsingURIString(uri){sheets.add(uri)},removeSheetUsingURIString(uri){sheets.delete(uri)}},addEventListener(name,fn){events.set(name,fn)},removeEventListener(name){events.delete(name)}};
  win.top=win;
  let todayPaneWrites=0;
  const pane={setVisible(){todayPaneWrites++}};
  win.TodayPane={updateDisplay(){todayPaneWrites++},updateSplitterState(){todayPaneWrites++}};
  win.document={documentURI:'chrome://conversations/content/experiment-api/stub.html',defaultView:win,
    getElementById:id=>id==='today-pane-panel'?pane:null,querySelectorAll:()=>[]};
  windows.onLoadWindow(win);
  assert.equal(todayPaneWrites,0,"attaching the skin preserves the native Today Pane preference");
  const originalSheets=sheets.size;
  events.get("activate")();events.get("activate")();
  assert.equal(sheets.size,originalSheets,"repeated activation does not duplicate styles");
  windows.onUnloadWindow(win);assert.equal(events.size,0);assert.equal(sheets.size,0);
  windows.onLoadWindow(win);assert.equal(sheets.size,originalSheets,"a reopened window receives the skin again");
  await api.inlineLabels.setHideTodayPane(true);
  assert.equal(sheets.size,originalSheets+1,'option adds a separate reversible stylesheet');
  await api.inlineLabels.setHideTodayPane(true);
  assert.equal(sheets.size,originalSheets+1,'reapplying does not duplicate sheets');
  await api.inlineLabels.setHideTodayPane(false);
  assert.equal(sheets.size,originalSheets,'turning off the option restores presentation');
  await api.inlineLabels.setHideTodayPane(true);
  assert.equal(todayPaneWrites,0,'setting changes never write native visibility');
  listener.msgPropertyChanged({},'keywords','ta','');assert.equal(refreshed,1);
  listener.msgPropertyChanged({},'label',1,0);assert.equal(refreshed,2);
  listener.msgPropertyChanged({},'junkscore','0','100');assert.equal(refreshed,2);
  cleanup.close();assert.equal(todayPaneWrites,0,"disabling the skin does not change calendar settings");assert.equal(removed,listener);assert.equal(disposed,2);assert.equal(sheets.size,0,"disable unloads all styles, including the Today Pane option");
  listener.msgPropertyChanged({},'keywords','ta','');assert.equal(refreshed,2);
});

test('startup waits for a complete mail pane and cancels retries when its window closes',()=>{
  const scope=vm.createContext({ChromeUtils:{importESModule:()=>({ExtensionCommon:{ExtensionAPI:class{}}})}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../thunder-g/label-menu.js'),'utf8'),scope);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../thunder-g/experiments/api.js'),'utf8'),scope);
  const tasks=new Map();let sequence=0,unload,attached=0;
  const win={setTimeout(fn){tasks.set(++sequence,fn);return sequence},clearTimeout(id){tasks.delete(id)},
    addEventListener(name,fn){unload=fn},removeEventListener(){}};
  const doc={defaultView:win,readyState:'loading',getElementById:()=>({})};
  const step=()=>{const [id,fn]=tasks.entries().next().value;tasks.delete(id);fn()};
  scope.waitForMailPane(doc,()=>attached++);step();assert.equal(attached,0);
  doc.readyState='complete';step();assert.equal(attached,0,'DOM alone is insufficient before threadPane exists');
  win.threadPane={};step();assert.equal(attached,1);assert.equal(tasks.size,0);
  doc.readyState='loading';scope.waitForMailPane(doc,()=>attached++);
  unload();assert.equal(tasks.size,0,'unload cancels pending startup');assert.equal(attached,1);
});

test('optional settings failures do not prevent permanent companion startup',async()=>{
  for (const fail of [false,true]) {
    const calls=[];
    const scope=vm.createContext({console:{warn(){},error(){}},browser:{
      storage:{local:{async get(){if(fail)throw Error('unavailable');return {hideTodayPane:true}}},onChanged:{addListener(){}}},
      inlineLabels:{onDkimRequest:{addListener(){}},async setIndependentReader(value){assert.equal(value,false)},async setBimiEnabled(value){assert.equal(value,false)},async setInlineReplyEnabled(value){assert.equal(value,false)},async setInlineNewMessageEnabled(value){assert.equal(value,false)},async setComposeAutosave(enabled,minutes){assert.equal(enabled,true);assert.equal(minutes,1)},async setMessagesPerPage(){},async setHideTodayPane(value){calls.push(value)},async start(){calls.push('started')}}}});
    await vm.runInContext(fs.readFileSync(path.join(__dirname,'../thunder-g/background.js'),'utf8'),scope);
    assert.deepEqual(calls,[!fail,'started']);
  }
});

test('independent reader is opt-in, restored at startup and propagated on preference changes',async()=>{
  let changed;const calls=[];
  const scope=vm.createContext({console,browser:{
    storage:{local:{async get(){return {independentReader:true,hideTodayPane:false,composeAutosave:true,composeAutosaveMinutes:1,messagesPerPage:0}}},onChanged:{addListener(fn){changed=fn}}},
    inlineLabels:{onDkimRequest:{addListener(){}},async setIndependentReader(value){calls.push(value)},async setHideTodayPane(){},async setComposeAutosave(){},async setMessagesPerPage(){},async start(){calls.push('started')}}}});
  await vm.runInContext(fs.readFileSync(path.join(__dirname,'../thunder-g/background.js'),'utf8'),scope);
  assert.deepEqual(calls,[true,'started']);
  changed({independentReader:{newValue:false}},'local');assert.deepEqual(calls,[true,'started',false]);
  changed({independentReader:{newValue:true}},'sync');assert.equal(calls.length,3);
});

test('optional compose and BIMI preferences load once and retain explicit opt-in values',async()=>{
  let reads=0;const calls=[];
  const scope=vm.createContext({console,browser:{
    storage:{local:{async get(){reads++;return {bimiEnabled:true,inlineReplyEnabled:true,inlineNewMessageEnabled:true}}},onChanged:{addListener(){}}},
    inlineLabels:{onDkimRequest:{addListener(){}},async setHideTodayPane(){},async setComposeAutosave(){},async setMessagesPerPage(){},async setIndependentReader(){},
      async setBimiEnabled(value){calls.push(['bimi',value])},async setInlineReplyEnabled(value){calls.push(['reply',value])},async setInlineNewMessageEnabled(value){calls.push(['new',value])},async start(){calls.push('started')}}}});
  await vm.runInContext(fs.readFileSync(path.join(__dirname,'../thunder-g/background.js'),'utf8'),scope);
  assert.equal(reads,1,'a later optional storage read cannot interrupt startup');
  assert.deepEqual(calls,[['bimi',true],['reply',true],['new',true],'started']);
});


test('thread guide preference defaults on, preserves opt-out and updates live from local storage',async()=>{
 for(const initial of [undefined,false]){
  let changed;const calls=[];
  const scope=vm.createContext({console,browser:{storage:{local:{async get(defaults){return {...defaults,...(initial===undefined?{}:{threadGuides:initial})}}},onChanged:{addListener(fn){changed=fn}}},
  inlineLabels:{onDkimRequest:{addListener(){}},async setThreadGuides(value){calls.push(value)},async setHideTodayPane(){},async setComposeAutosave(){},async setMessagesPerPage(){},async setIndependentReader(){},async start(){}}}});
  await vm.runInContext(fs.readFileSync(path.join(__dirname,'../thunder-g/background.js'),'utf8'),scope);
  assert.deepEqual(calls,[initial!==false]);
  changed({threadGuides:{newValue:false}},'local');changed({threadGuides:{newValue:true}},'local');
  assert.deepEqual(calls,[initial!==false,false,true]);
  changed({threadGuides:{newValue:false}},'sync');assert.equal(calls.length,3);
 }
});

test('column headers default hidden, restore explicit choice and respond only to local changes',async()=>{
  for (const saved of [undefined,true,false]) {
    const calls=[];let changed;
    const noop=async()=>{};
    const scope=vm.createContext({console,browser:{runtime:{},storage:{local:{get:async()=>({showColumnHeaders:saved})},onChanged:{addListener(fn){changed=fn}}},inlineLabels:{
      onDkimRequest:{addListener(){}},setShowColumnHeaders:async value=>calls.push(value),
      setHideTodayPane:noop,setComposeAutosave:noop,setMessagesPerPage:noop,setIndependentReader:noop,start:noop
    }}});
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../thunder-g/background.js'),'utf8'),scope);
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(calls,[saved===true]);
    changed({showColumnHeaders:{newValue:true}},'sync');assert.equal(calls.length,1);
    changed({showColumnHeaders:{newValue:true}},'local');
    changed({showColumnHeaders:{newValue:false}},'local');
    changed({showColumnHeaders:{}},'local');
    assert.deepEqual(calls,[saved===true,true,false,false]);
  }
});

test('mail tab watcher scans existing and newly opened search browsers and cleans listeners',()=>{
 const scope=vm.createContext({console});const source=fs.readFileSync(path.join(__dirname,'../thunder-g/experiments/api.js'),'utf8');
 vm.runInContext(source.slice(source.indexOf('function watchMailTabs'),source.indexOf('var inlineLabels = class')),scope);
 const scans=[],listeners=new Map();let monitor,removed;
 const browser={contentDocument:{name:'existing search'},addEventListener(name,fn){listeners.set(this,fn)},removeEventListener(){listeners.delete(this)}};
 const tabmail={tabInfo:[{chromeBrowser:browser}],registerTabMonitor(value){monitor=value},unregisterTabMonitor(value){removed=value}};
 const watcher=scope.watchMailTabs({document:{getElementById:()=>tabmail}},doc=>scans.push(doc));
 assert.equal(scans.length,1);
 const next={addEventListener(name,fn){listeners.set(this,fn)},removeEventListener(){listeners.delete(this)}};
 const tab={chromeBrowser:next};monitor.onTabOpened(tab);
 const doc={nodeType:9,name:'new search'};listeners.get(next)({target:doc});assert.equal(scans.at(-1),doc);
 next.contentDocument=doc;monitor.onTabSwitched(tab);assert.equal(scans.at(-1),doc);assert.equal(listeners.size,2);
 monitor.onTabClosing(tab);assert.equal(listeners.size,1);
 watcher.close();assert.equal(removed,monitor);assert.equal(listeners.size,0);
});

test('timed-out mail panes release pending state and can attach on a later activation',()=>{
 const scope=vm.createContext({console:{warn(){}},ChromeUtils:{importESModule:()=>({ExtensionCommon:{ExtensionAPI:class{}}})}});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../thunder-g/experiments/api.js'),'utf8'),scope);
 const tasks=new Map();let sequence=0,closed=0,attached=0;
 const win={setTimeout(fn){tasks.set(++sequence,fn);return sequence},clearTimeout(id){tasks.delete(id)},addEventListener(){},removeEventListener(){}};
 const doc={defaultView:win,readyState:'loading',getElementById:()=>({})};
 const step=()=>{const [id,fn]=tasks.entries().next().value;tasks.delete(id);fn()};
 scope.waitForMailPane(doc,()=>attached++,()=>closed++);
 for(let i=0;i<100;i++)step();
 assert.equal(tasks.size,0);assert.equal(closed,1);assert.equal(attached,0);
 doc.readyState='complete';win.threadPane={};
 const pending=scope.waitForMailPane(doc,()=>attached++,()=>closed++);step();
 assert.equal(attached,1);assert.equal(closed,2);pending.close();assert.equal(closed,2,'cleanup is idempotent');
});
