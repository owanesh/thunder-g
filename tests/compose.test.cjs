const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const scope=vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../inline-labels/compose.js'),'utf8'),scope);
function preferences(initial={}) {
  const values=new Map(Object.entries(initial));
  const defaults={'mail.compose.autosave':true,'mail.compose.autosaveinterval':5};
  return {values,prefHasUserValue:key=>values.has(key),clearUserPref:key=>values.delete(key),
    getBoolPref:key=>values.has(key)?values.get(key):defaults[key],getIntPref:key=>values.has(key)?values.get(key):defaults[key],
    getStringPref:(key,fallback)=>values.get(key)??fallback,
    setBoolPref:(key,value)=>values.set(key,value),setIntPref:(key,value)=>values.set(key,value),setStringPref:(key,value)=>values.set(key,value)};
}
test('draft autosave uses native preferences and restores original values and user-pref presence',()=>{
  const prefs=preferences({'mail.compose.autosave':false});
  const controller=scope.createComposeAutosave(prefs);
  controller.set(true,1);assert.equal(prefs.getBoolPref('mail.compose.autosave'),true);
  assert.equal(prefs.getIntPref('mail.compose.autosaveinterval'),1);
  controller.set(true,10);controller.close();
  assert.equal(prefs.getBoolPref('mail.compose.autosave'),false);
  assert.equal(prefs.prefHasUserValue('mail.compose.autosaveinterval'),false);
  assert.equal(prefs.getIntPref('mail.compose.autosaveinterval'),5);
});
test('autosave snapshot survives an interrupted session and independent changes are preserved',()=>{
  const prefs=preferences({'mail.compose.autosave':false,'mail.compose.autosaveinterval':10});
  scope.createComposeAutosave(prefs).set(true,1);
  const restarted=scope.createComposeAutosave(prefs);restarted.set(true,2);
  prefs.setIntPref('mail.compose.autosaveinterval',8);restarted.close();
  assert.equal(prefs.getBoolPref('mail.compose.autosave'),false);
  assert.equal(prefs.getIntPref('mail.compose.autosaveinterval'),8);
  assert.equal(prefs.prefHasUserValue('extensions.thunderg.composeAutosaveSnapshot'),false);
});
test('invalid intervals cannot create zero-delay autosave loops and closed controllers do not write',()=>{
  const prefs=preferences(),controller=scope.createComposeAutosave(prefs);
  controller.set(true,0);assert.equal(prefs.getIntPref('mail.compose.autosaveinterval'),1);
  controller.close();controller.set(true,2);assert.equal(prefs.getIntPref('mail.compose.autosaveinterval'),5);
});
test('inline replies pass exact header, native reply type, identity and default account format to native composer',()=>{
 const types={ReplyToSender:1,ReplyAll:2},Ci={nsIMsgCompType:types,nsIMsgCompFormat:{Default:0}};
 const identity={key:'account-signature-and-drafts'};const fields={};
 const Cc={'@mozilla.org/messengercompose/composeparams;1':{createInstance:()=>({})},'@mozilla.org/messengercompose/composefields;1':{createInstance:()=>fields}};
 const header={folder:{getUriForMsg:value=>{assert.equal(value,header);return 'imap-message://Sent#42'}}};
 for(const [command,type] of [['cmd_replySender',1],['cmd_replyall',2]]){
  const params=scope.inlineReplyParams(header,command,{},Ci,Cc,{getIdentityForHeader(value,kind){assert.equal(value,header);assert.equal(kind,type);return [identity]}});
  assert.equal(params.type,type);assert.equal(params.identity,identity);assert.equal(params.originalMsgURI,'imap-message://Sent#42');assert.equal(params.composeFields,fields);assert.equal(params.format,0);
 }
 assert.throws(()=>scope.inlineReplyParams(header,'cmd_forwardInline',{},Ci,Cc,{}));
});
test('inline compose preserves an open reply across navigation and guards dirty window/tab closure with native draft prompts',()=>{
 let observer,frame,mayClose=false,paramsReceived;const events=new Map(),timers=new Map();
 function element(tag){return {tag,style:{},children:[],events:{},setAttribute(){},append(...values){for(const value of values){value.parentNode=this;this.children.push(value)}},moveBefore(value){if(value.parentNode)value.parentNode.children=value.parentNode.children.filter(item=>item!==value);this.append(value)},scrollIntoView(){this.revealed=true},isConnected:true,remove(){this.removed=true},focus(){this.focused=true},addEventListener(name,fn){this.events[name]=fn},removeEventListener(name){delete this.events[name]}};}
 const appChrome={XULBrowserWindow:{original:true}},oldChrome=appChrome.XULBrowserWindow;
 const mode={tryCloseTab:()=>true},tab={mode},main={document:{getElementById:()=>({tabInfo:[tab]})},docShell:{treeOwner:{QueryInterface(){return {getInterface:()=>appChrome}}}},addEventListener(name,fn){events.set(name,fn)},removeEventListener(name){events.delete(name)}};
 const native={gMsgCompose:{},GetCurrentEditor:()=>({}),ComposeCanClose:()=>mayClose,SetMsgBodyFrameFocus(){}};
 const sidebar={getBoundingClientRect:()=>({width:260,right:260,left:0})};
 const doc={getElementById:id=>id==='folderPane'?sidebar:null,documentElement:element('html'),createElement:element,createElementNS:(ns,tag)=>element(tag),createXULElement(){
  frame=element('browser');frame.browsingContext={};native.browsingContext=frame.browsingContext;
  frame.contentWindow=native;frame.contentDocument={documentURI:'chrome://messenger/content/messengercompose/messengercompose.xhtml',createElement:element,documentElement:element('html')};
  frame.loadURI=()=>{observer.observe(native);paramsReceived=native.arguments[0];frame.events.load({target:frame.contentDocument})};return frame;
 }};
 const win={document:doc,browsingContext:{topChromeWindow:main},setTimeout(fn){timers.set(1,fn);return 1},clearTimeout(id){timers.delete(id)},addEventListener(name,fn){events.set('pane-'+name,fn)},removeEventListener(name){events.delete('pane-'+name)}};tab.chromeBrowser={contentWindow:win};
 const testScope=vm.createContext({
  Ci:{nsIMsgCompType:{New:0,ReplyToSender:1,ReplyAll:2},nsIMsgCompFormat:{Default:0}},
  Cc:{'@mozilla.org/messengercompose/composeparams;1':{createInstance:()=>({})},'@mozilla.org/messengercompose/composefields;1':{createInstance:()=>({})}},
  MailServices:{},ChromeUtils:{importESModule:()=>({MailUtils:{getIdentityForHeader:()=>[{key:'chosen-account'}]}})},
  Services:{obs:{addObserver(value){observer=value},removeObserver(){}},io:{newURI:value=>value},scriptSecurityManager:{getSystemPrincipal:()=>({})}}
 });vm.runInContext(fs.readFileSync(path.join(__dirname,'../inline-labels/compose.js'),'utf8'),testScope);
 const composer=testScope.createInlineCompose(win),header={mime2DecodedSubject:'Original',folder:{getUriForMsg:()=> 'imap-message://Sent#42'}};
 const inline=element('conversation'),scrollHost={hidden:false};
 composer.open(header,'cmd_replyall',{container:inline,scrollHost});assert.equal(composer.presentation,'inline');assert.equal(composer.active,true);assert.equal(paramsReceived.type,2);assert.equal(paramsReceived.identity.key,'chosen-account');assert.equal(appChrome.XULBrowserWindow,oldChrome);
 const controls=inline.children[0].children[0].children;
 assert.equal(controls[1].children[1].textContent,'Save draft');
 assert.equal(controls[2].children[1].textContent,'Detach reply');
 assert.equal(controls[3].children[1].textContent,'Separate window');
 assert.equal(controls[3].children[0].tag,'svg','window action has a window illustration, not a send arrow');
 const originalFrame=frame;native.gMsgCompose.bodyModified=true;
 composer.float();assert.equal(composer.presentation,'floating');assert.equal(frame,originalFrame);assert.equal(native.gMsgCompose.bodyModified,true);
 assert.equal(controls[2].children.at(-1).textContent,'Return to conversation');
 composer.returnInline();assert.equal(composer.presentation,'inline');assert.equal(frame,originalFrame);
 composer.open({mime2DecodedSubject:'Another conversation'},'cmd_replySender');assert.equal(frame,originalFrame);assert.equal(composer.target,header);assert.equal(composer.command,'cmd_replyall');
 assert.equal(composer.close(),false);assert.equal(frame.removed,undefined,'cancel/save-in-progress must not destroy the editor');
 let prevented=false;events.get('close')({preventDefault(){prevented=true}});assert.equal(prevented,true);
 assert.equal(mode.tryCloseTab(tab),false,'closing a mail tab must honor native cancellation too');
 assert.equal(mode.tryCloseTab({}),true,'other tabs keep native behavior');
 // Native compose closes itself only after send/save has completed; the host then releases it.
 native.close();assert.equal(composer.active,false);assert.equal(originalFrame.removed,true);
 composer.open(null,'cmd_newMessage');assert.equal(paramsReceived.type,0);assert.equal(composer.presentation,'floating');assert.equal(composer.target,null);composer.returnInline();assert.equal(composer.presentation,'full');
 const fullPanel=doc.documentElement.children.at(-1);assert.equal(fullPanel.style.left,'260px','full composer must leave the sidebar visible');
 sidebar.getBoundingClientRect=()=>({width:340,right:340,left:0});events.get('pane-resize')();assert.equal(fullPanel.style.left,'340px','sidebar resizing moves the composer boundary');
 composer.float();assert.equal(composer.presentation,'floating');const newFrame=frame;composer.returnInline();assert.equal(composer.presentation,'full');assert.equal(frame,newFrame);
 composer.open(header,'cmd_replySender');assert.equal(composer.command,'cmd_newMessage','Reply must not replace an open new message');mayClose=true;assert.equal(composer.close(),true);assert.equal(composer.active,false);assert.equal(events.has('close'),false);
});
test('separate-window transfer waits for native draft completion and retains failures',async()=>{
 const draftScope=vm.createContext({Ci:{nsIMsgCompDeliverMode:{SaveAsDraft:4}}});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../inline-labels/compose.js'),'utf8'),draftScope);
 for(const success of [true,false]){
  let listener,unregistered=false,started=false;
  const compose={compFields:{draftId:''},RegisterStateListener(value){listener=value},UnregisterStateListener(value){assert.equal(value,listener);unregistered=true}};
  const native={gMsgCompose:compose,GenericSendMessage(mode){assert.equal(mode,4);started=true}};
  const pending=draftScope.saveInlineReplyDraft(native,{setTimeout,clearTimeout},1000);
  await Promise.resolve();assert.equal(started,true);assert.equal(unregistered,false);
  compose.compFields.draftId=success?'imap-message://Drafts#123':'';
  listener.ComposeProcessDone(success?0:1);
  if(success)assert.equal(await pending,'imap-message://Drafts#123');else await assert.rejects(pending,/Could not save/);
  assert.equal(unregistered,true);assert.equal(native.gMsgCompose,compose);
 }
 await assert.rejects(draftScope.saveInlineReplyDraft({gSaveOperationInProgress:true},{setTimeout,clearTimeout}),/Wait/);
});

test('new-message parameters preserve folder identity and native format without a reply URI',()=>{
 const custom={key:'custom-signature'},server={key:'server-signature'},Ci={nsIMsgCompType:{New:0},nsIMsgCompFormat:{Default:2}},Cc={
 '@mozilla.org/messengercompose/composeparams;1':{createInstance:()=>({})},
 '@mozilla.org/messengercompose/composefields;1':{createInstance:()=>({})}};
 const utils={getIdentityForServer(value){assert.equal(value,'server');return [server]}};
 for(const [folder,identity] of [[{customIdentity:custom,server:'server'},custom],[{server:'server'},server],[null,null]]){
  const params=scope.inlineNewMessageParams(folder,Ci,Cc,utils);
  assert.equal(params.type,0);assert.equal(params.format,2);assert.equal(params.identity,identity);
  assert.equal(params.originalMsgURI,undefined);assert.deepEqual(Object.keys(params.composeFields),[]);
 }
});
test('Write is opt-in, reuses the existing compose controller, and restores native commands',()=>{
 const native=[],opens=[],folder={server:{type:'imap'}};
 const controller={doCommand(...args){native.push(args);return 'native'}};
 const win={commandController:controller,gFolder:folder},original=controller.doCommand;
 let created=0;const composer={open(...args){opens.push(args)}};
 const hook=scope.installInlineNewMessage(win,()=>{created++;return composer});
 scope.inlineNewMessageEnabled=false;assert.equal(controller.doCommand('cmd_newMessage'),'native');
 scope.inlineNewMessageEnabled=true;controller.doCommand('cmd_newMessage');controller.doCommand('cmd_newMessage');
 assert.equal(created,1);assert.equal(opens.length,2);assert.equal(opens[0][0],null);assert.equal(opens[0][1],'cmd_newMessage');assert.equal(opens[0][2].folder,folder);
 controller.doCommand('cmd_forwardInline');controller.doCommand('cmd_newMessage',{shiftKey:true});
 folder.server.type='nntp';controller.doCommand('cmd_newMessage');assert.equal(native.length,4);
 scope.inlineNewMessageEnabled=false;controller.doCommand('cmd_newMessage');assert.equal(native.length,5);
 hook.close();assert.equal(controller.doCommand,original);
});

test('main-window Write and shortcut route to the active pane without affecting other tabs',()=>{
 const calls=[],opens=[],win={gFolder:{server:{type:'imap'}},commandController:{doCommand(){calls.push('pane-native')}}};
 const original=function(){calls.push('main-native')};
 const tabmail={currentAbout3Pane:win},main={MsgNewMessage:original,document:{getElementById:()=>tabmail}};
 win.browsingContext={topChromeWindow:main};
 const hook=scope.installInlineNewMessage(win,()=>({open(){opens.push('new')}}));
 scope.inlineNewMessageEnabled=true;main.MsgNewMessage({});assert.equal(opens.length,1);assert.equal(calls.length,0);
 tabmail.currentAbout3Pane={};main.MsgNewMessage({});assert.equal(calls.pop(),'main-native');
 tabmail.currentAbout3Pane=win;main.MsgNewMessage({shiftKey:true});assert.equal(calls.pop(),'main-native');
 scope.inlineNewMessageEnabled=false;main.MsgNewMessage({});assert.equal(calls.pop(),'main-native');
 hook.close();assert.equal(main.MsgNewMessage,original);
});
