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
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../inline-labels/label-menu.js'),'utf8'),scope);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../inline-labels/experiments/api.js'),'utf8'),scope);
  const api=new scope.inlineLabels().getAPI({extension:{id:'test'},callOnClose(value){cleanup=value}});
  await api.inlineLabels.start();
  const sheets=new Set();
  const win={windowUtils:{loadSheetUsingURIString(uri){sheets.add(uri)},removeSheetUsingURIString(uri){sheets.delete(uri)}},addEventListener(){},removeEventListener(){}};
  let todayPaneWrites=0;
  const pane={setVisible(){todayPaneWrites++}};
  win.TodayPane={updateDisplay(){todayPaneWrites++},updateSplitterState(){todayPaneWrites++}};
  win.document={documentURI:'chrome://conversations/content/experiment-api/stub.html',defaultView:win,
    getElementById:id=>id==='today-pane-panel'?pane:null,querySelectorAll:()=>[]};
  windows.onLoadWindow(win);
  assert.equal(todayPaneWrites,0,"attaching the skin preserves the native Today Pane preference");
  const originalSheets=sheets.size;
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
  cleanup.close();assert.equal(todayPaneWrites,0,"disabling the skin does not change calendar settings");assert.equal(removed,listener);assert.equal(disposed,1);assert.equal(sheets.size,0,"disable unloads all styles, including the Today Pane option");
  listener.msgPropertyChanged({},'keywords','ta','');assert.equal(refreshed,2);
});

test('startup waits for a complete mail pane and cancels retries when its window closes',()=>{
  const scope=vm.createContext({ChromeUtils:{importESModule:()=>({ExtensionCommon:{ExtensionAPI:class{}}})}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../inline-labels/label-menu.js'),'utf8'),scope);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../inline-labels/experiments/api.js'),'utf8'),scope);
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
    await vm.runInContext(fs.readFileSync(path.join(__dirname,'../inline-labels/background.js'),'utf8'),scope);
    assert.deepEqual(calls,[!fail,'started']);
  }
});

test('independent reader is opt-in, restored at startup and propagated on preference changes',async()=>{
  let changed;const calls=[];
  const scope=vm.createContext({console,browser:{
    storage:{local:{async get(){return {independentReader:true,hideTodayPane:false,composeAutosave:true,composeAutosaveMinutes:1,messagesPerPage:0}}},onChanged:{addListener(fn){changed=fn}}},
    inlineLabels:{onDkimRequest:{addListener(){}},async setIndependentReader(value){calls.push(value)},async setHideTodayPane(){},async setComposeAutosave(){},async setMessagesPerPage(){},async start(){calls.push('started')}}}});
  await vm.runInContext(fs.readFileSync(path.join(__dirname,'../inline-labels/background.js'),'utf8'),scope);
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
  await vm.runInContext(fs.readFileSync(path.join(__dirname,'../inline-labels/background.js'),'utf8'),scope);
  assert.equal(reads,1,'a later optional storage read cannot interrupt startup');
  assert.deepEqual(calls,[['bimi',true],['reply',true],['new',true],'started']);
});


test('thread guide preference defaults on, preserves opt-out and updates live from local storage',async()=>{
 for(const initial of [undefined,false]){
  let changed;const calls=[];
  const scope=vm.createContext({console,browser:{storage:{local:{async get(defaults){return {...defaults,...(initial===undefined?{}:{threadGuides:initial})}}},onChanged:{addListener(fn){changed=fn}}},
  inlineLabels:{onDkimRequest:{addListener(){}},async setThreadGuides(value){calls.push(value)},async setHideTodayPane(){},async setComposeAutosave(){},async setMessagesPerPage(){},async setIndependentReader(){},async start(){}}}});
  await vm.runInContext(fs.readFileSync(path.join(__dirname,'../inline-labels/background.js'),'utf8'),scope);
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
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../inline-labels/background.js'),'utf8'),scope);
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(calls,[saved===true]);
    changed({showColumnHeaders:{newValue:true}},'sync');assert.equal(calls.length,1);
    changed({showColumnHeaders:{newValue:true}},'local');
    changed({showColumnHeaders:{newValue:false}},'local');
    changed({showColumnHeaders:{}},'local');
    assert.deepEqual(calls,[saved===true,true,false,false]);
  }
});
