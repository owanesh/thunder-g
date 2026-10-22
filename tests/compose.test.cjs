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
 const doc={documentElement:element('html'),createElement:element,createElementNS:(ns,tag)=>element(tag),createXULElement(){
  frame=element('browser');frame.browsingContext={};native.browsingContext=frame.browsingContext;
  frame.contentWindow=native;frame.contentDocument={documentURI:'chrome://messenger/content/messengercompose/messengercompose.xhtml',createElement:element,documentElement:element('html')};
  frame.loadURI=()=>{observer.observe(native);paramsReceived=native.arguments[0];frame.events.load({target:frame.contentDocument})};return frame;
 }};
 const win={document:doc,browsingContext:{topChromeWindow:main},setTimeout(fn){timers.set(1,fn);return 1},clearTimeout(id){timers.delete(id)},addEventListener(name,fn){events.set('pane-'+name,fn)},removeEventListener(name){events.delete('pane-'+name)}};tab.chromeBrowser={contentWindow:win};
 const testScope=vm.createContext({
  Ci:{nsIMsgCompType:{ReplyToSender:1,ReplyAll:2},nsIMsgCompFormat:{Default:0}},
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
 composer.open(header,'cmd_replySender');mayClose=true;assert.equal(composer.close(),true);assert.equal(composer.active,false);assert.equal(events.has('close'),false);
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
