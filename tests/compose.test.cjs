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
test('inline compose preserves an open reply across navigation and guards dirty window/tab closure with native draft prompts',async()=>{
 let observer,frame,mayClose=false,paramsReceived;const events=new Map(),timers=new Map();
 function element(tag){return {tag,style:{},dataset:{},children:[],events:{},getBoundingClientRect:()=>({width:0,height:0}),setAttribute(){},append(...values){for(const value of values){value.parentNode=this;this.children.push(value)}},replaceChildren(...values){this.children=[];this.append(...values)},moveBefore(value){if(value.parentNode)value.parentNode.children=value.parentNode.children.filter(item=>item!==value);this.append(value)},scrollIntoView(){this.revealed=true},isConnected:true,remove(){this.removed=true},focus(){this.focused=true},addEventListener(name,fn){this.events[name]=fn},removeEventListener(name){delete this.events[name]}};}
 const appChrome={XULBrowserWindow:{original:true}},oldChrome=appChrome.XULBrowserWindow;
 const mode={tryCloseTab:()=>true},tab={mode},main={document:{getElementById:()=>({tabInfo:[tab]})},docShell:{treeOwner:{QueryInterface(){return {getInterface:()=>appChrome}}}},addEventListener(name,fn){events.set(name,fn)},removeEventListener(name){events.delete(name)}};
 const native={addEventListener(){},removeEventListener(){},document:{addEventListener(){},removeEventListener(){}},gMsgCompose:{compFields:{draftId:''},RegisterStateListener(){},UnregisterStateListener(){}},GetCurrentEditor:()=>({}),ComposeCanClose:()=>mayClose,SetMsgBodyFrameFocus(){}};
 const sidebar={getBoundingClientRect:()=>({width:260,right:260,left:0})};
 const doc={getElementById:id=>id==='folderPane'?sidebar:null,documentElement:element('html'),createElement:element,createElementNS:(ns,tag)=>element(tag),createXULElement(){
  frame=element('browser');frame.browsingContext={};native.browsingContext=frame.browsingContext;
  frame.contentWindow=native;frame.contentDocument={getElementById:()=>null,documentURI:'chrome://messenger/content/messengercompose/messengercompose.xhtml',createElement:element,documentElement:element('html')};
  frame.loadURI=()=>{observer.observe(native);paramsReceived=native.arguments[0];frame.events.load({target:frame.contentDocument})};return frame;
 }};
 const win={document:doc,browsingContext:{topChromeWindow:main},setTimeout(fn){timers.set(1,fn);return 1},clearTimeout(id){timers.delete(id)},addEventListener(name,fn){events.set('pane-'+name,fn)},removeEventListener(name){events.delete('pane-'+name)}};tab.chromeBrowser={contentWindow:win};
 const testScope=vm.createContext({
  Ci:{nsIMsgCompType:{New:0,ReplyToSender:1,ReplyAll:2},nsIMsgCompFormat:{Default:0}},
  Cc:{'@mozilla.org/messengercompose/composeparams;1':{createInstance:()=>({})},'@mozilla.org/messengercompose/composefields;1':{createInstance:()=>({})}},
  MailServices:{},ChromeUtils:{importESModule:()=>({MailUtils:{getIdentityForHeader:()=>[{key:'chosen-account'}]}})},
  Services:{obs:{addObserver(value){observer=value},removeObserver(){}},io:{newURI:value=>value},scriptSecurityManager:{getSystemPrincipal:()=>({})}}
 });vm.runInContext(fs.readFileSync(path.join(__dirname,'../inline-labels/compose.js'),'utf8'),testScope);
 let feedback;testScope.installInlineSendStatus=(native,clock,onState)=>{feedback=onState;return {close(){}}};
 const composer=testScope.createInlineCompose(win),header={mime2DecodedSubject:'Original',folder:{getUriForMsg:()=> 'imap-message://Sent#42'}};
 const inline=element('conversation'),scrollHost={hidden:false};
 composer.open(header,'cmd_replyall',{container:inline,scrollHost});assert.equal(composer.presentation,'inline');assert.equal(composer.active,true);assert.equal(paramsReceived.type,2);assert.equal(paramsReceived.identity.key,'chosen-account');assert.equal(appChrome.XULBrowserWindow,oldChrome);
 const controls=inline.children[0].children[0].children;
 assert.equal(controls[1].children[1].textContent,'Save draft');
 assert.equal(controls[2].children[1].textContent,'Detach reply');
 assert.equal(controls[3].children[1].textContent,'Separate window');
 assert.equal(controls[3].children[0].tag,'svg','window action has a window illustration, not a send arrow');
 const originalFrame=frame;
 feedback({state:'sending'});assert.equal(inline.children[0].hidden,false,'sending must never hide/destroy the embedded editor');assert.equal(frame.removed,undefined);
 feedback({state:'draft-error',error:'Connection failed',draftError:'Disk full'});assert.equal(inline.children[0].hidden,false);
 native.gMsgCompose.bodyModified=true;
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
 composer.open(header,'cmd_replySender');assert.equal(composer.command,'cmd_newMessage','Reply must not replace an open new message');let closeSaves=0;testScope.saveInlineReplyDraft=async()=>{closeSaves++;throw new Error('Draft folder unavailable')};
 const closeControl=doc.documentElement.children.at(-1).children[0].children[4];
 await closeControl.events.click();assert.equal(composer.active,true,'failed close-save preserves reply');
 testScope.saveInlineReplyDraft=async()=>{closeSaves++;return 'draft://confirmed'};
 await closeControl.events.click();assert.equal(closeSaves,2);assert.equal(composer.active,false,'Close waits for saved draft');
 mayClose=true;assert.equal(composer.close(),true);assert.equal(composer.active,false);assert.equal(events.has('close'),false);
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

test('embedded attachment picker anchors to the mail window and preserves native file handling',async()=>{
 let resultCallback,initArgs,restored=0,added,files=[{name:'qa.txt'},{name:'qa2.txt'}],last;
 const original=()=>{},native={AttachFile:original,gMsgCompose:{},gAttachmentBucket:{itemCount:1},
  document:{l10n:{async formatValue(){return 'Attach files'}}},toggleAttachmentPane(mode){assert.equal(mode,'show');restored++},
  GetLastAttachDirectory:()=> 'previous-directory',FileToAttachment:file=>({name:file.name}),
  AddAttachments(items){added=items},SetLastAttachDirectory(file){last=file}};
 const picker={files,init(...args){initArgs=args},appendFilters(value){assert.equal(value,7)},open(callback){resultCallback=callback}};
 const classes={'@mozilla.org/filepicker;1':{createInstance:()=>picker}},interfaces={nsIFilePicker:{modeOpenMultiple:2,filterAll:7,returnOK:0}};
 const host={browsingContext:{host:true}},hook=scope.installEmbeddedAttachmentPicker(native,host,classes,interfaces);
 await native.AttachFile();assert.equal(initArgs[0],host.browsingContext);assert.equal(initArgs[1],'Attach files');assert.equal(initArgs[2],2);
 assert.equal(picker.displayDirectory,'previous-directory');assert.equal(restored,1);
 resultCallback(0);assert.equal(added.length,2);assert.equal(added[1].name,'qa2.txt');assert.equal(last,files[1]);
 added=null;await native.AttachFile();resultCallback(1);assert.equal(added,null,'Cancel leaves attachments unchanged');
 await native.AttachFile();hook.close();resultCallback(0);assert.equal(added,null,'late picker results cannot affect a closed compose window');assert.equal(native.AttachFile,original);
});

function composeEventTarget(){
 const listeners=new Map();return {listeners,addEventListener(name,fn){listeners.set(name,fn)},removeEventListener(name){listeners.delete(name)},emit(name,event={}){listeners.get(name)?.({type:name,...event})}};
}
test('draft status waits for native success, clears on edits, handles failure and edits during autosave, and cleans up',()=>{
 const document=composeEventTarget(),body=composeEventTarget(),native=Object.assign(composeEventTarget(),{document,GetCurrentEditor:()=>({document:body})});
 let listener;native.gMsgCompose={compFields:{draftId:'old-draft'},bodyModified:false,RegisterStateListener(value){listener=value},UnregisterStateListener(value){assert.equal(value,listener);listener=null}};
 const timers=new Map();let sequence=0;
 const clock={setTimeout(fn,delay){timers.set(++sequence,{fn,delay});return sequence},clearTimeout(id){timers.delete(id)}};
 const complete=()=>{for(const [id,task] of [...timers])if(task.delay===0){timers.delete(id);task.fn()}};
 const status={dataset:{},style:{}},modes={SaveAsDraft:4,AutoSaveAsDraft:7};
 const hook=scope.installComposeDraftStatus(native,status,clock,modes);
 assert.equal(status.textContent,'Not saved','an old draft URI is not evidence of a new save');
 native.emit('compose-send-message',{detail:{msgType:7}});assert.equal(status.textContent,'Saving…');
 listener.ComposeProcessDone(0);assert.equal(status.textContent,'Saving…','native flags must settle before showing success');complete();
 assert.equal(status.textContent,'✓ Saved');assert.match(status.style.color,/#137333/);
 body.emit('input');assert.equal(status.textContent,'Unsaved changes','body edits clear success immediately');
 native.emit('compose-send-message',{detail:{msgType:4}});listener.ComposeProcessDone(1);complete();assert.equal(status.textContent,'Save failed','a previous draft cannot hide a failure');
 native.emit('compose-send-message',{detail:{msgType:7}});body.emit('input');native.gMsgCompose.bodyModified=true;listener.ComposeProcessDone(0);complete();
 assert.equal(status.textContent,'Unsaved changes','typing during autosave is not reported as saved');
 native.gMsgCompose.bodyModified=false;native.emit('compose-send-message',{detail:{msgType:4}});listener.ComposeProcessDone(0);complete();assert.equal(status.textContent,'✓ Saved');
 document.emit('input',{isTrusted:false});document.emit('change',{isTrusted:true});assert.equal(status.textContent,'✓ Saved','native serialization and clean blur events do not clear success');
 native.gContentChanged=true;document.emit('attachments-added');assert.equal(status.textContent,'Unsaved changes');
 native.emit('compose-send-message',{detail:{msgType:0}});assert.equal(status.textContent,'Unsaved changes','sending is not draft saving');
 hook.close();assert.equal(timers.size,0);assert.equal(listener,null);assert.equal(body.listeners.size,0);assert.equal(document.listeners.size,0);assert.equal(native.listeners.size,0);
});

function floatingFixture(prefs,dir='ltr',testScope=scope) {
 function element(){return Object.assign(composeEventTarget(),{style:{},children:[],setAttribute(){},append(item){this.children.push(item)},remove(){this.removed=true},setPointerCapture(id){this.captured=id},hasPointerCapture(id){return this.captured===id},releasePointerCapture(){this.captured=null}})}
 const panel=element();panel.getBoundingClientRect=()=>({width:parseFloat(panel.style.width)||720,height:parseFloat(panel.style.height)||600});
 const win={document:{documentElement:{dir},createElement:element,createElementNS:element}};
 const hook=testScope.installFloatingComposeResize(win,panel,prefs),[corner,top,side]=panel.children;
 return {panel,hook,corner,top,side};
}
test('floating resize uses pointer capture, clamps to the message area, preserves dimensions and supports keyboard resizing',()=>{
 const {panel,hook,corner,top,side}=floatingFixture();
 const limits={maxWidth:900,maxHeight:700};hook.update(true,limits);assert.equal(panel.style.width,'720px');
 const event=(values={})=>({button:0,pointerId:1,clientX:200,clientY:200,preventDefault(){},stopPropagation(){},...values});
 corner.emit('pointerdown',event());assert.equal(corner.captured,1);
 corner.emit('pointermove',event({clientX:100,clientY:150}));assert.equal(panel.style.width,'820px');assert.equal(panel.style.height,'650px');
 corner.emit('pointermove',event({clientX:-200,clientY:-200}));assert.equal(panel.style.width,'900px');assert.equal(panel.style.height,'700px');
 corner.emit('pointerup');assert.equal(corner.captured,null);
 hook.update(false,limits);assert.equal(corner.hidden,true);
 panel.style.width='1200px';hook.update(true,limits);assert.equal(panel.style.width,'900px','detach/return retains the user choice');
 hook.update(true,{maxWidth:300,maxHeight:250});assert.equal(panel.style.width,'300px');assert.equal(panel.style.height,'250px','small viewports override minimum sizes');
 hook.update(true,limits);assert.equal(panel.style.width,'900px');
 corner.emit('keydown',event({key:'ArrowRight'}));assert.equal(panel.style.width,'884px');
 top.emit('pointerdown',event());top.emit('pointermove',event({clientX:100,clientY:250}));top.emit('pointercancel');assert.equal(panel.style.width,'884px');assert.equal(panel.style.height,'650px','top edge changes height only');
 side.emit('pointerdown',event());side.emit('pointermove',event({clientX:1000,clientY:1000}));side.emit('pointerup');assert.equal(panel.style.width,'420px');assert.equal(panel.style.height,'650px','side edge changes width only');
 hook.close();assert.ok(panel.children.every(handle=>handle.removed));
});

test('floating size survives new composers and restart without saving each drag frame or viewport adjustment',()=>{
 const key='extensions.thunderg.floatingComposeSize',prefs=preferences(),writes=[];
 const set=prefs.setStringPref;prefs.setStringPref=(name,value)=>{writes.push([name,value]);set(name,value)};
 const limits={maxWidth:900,maxHeight:700};
 const event=(values={})=>({button:0,pointerId:1,clientX:200,clientY:200,preventDefault(){},stopPropagation(){},...values});
 let f=floatingFixture(prefs);f.hook.update(true,limits);
 f.corner.emit('pointerdown',event());
 for(let step=1;step<=50;step++)f.corner.emit('pointermove',event({clientX:200-step*2,clientY:200-step}));
 assert.equal(writes.length,0,'pointer movement only changes the panel');
 f.corner.emit('pointerup',event());
 assert.equal(writes.length,1);assert.deepEqual(JSON.parse(prefs.getStringPref(key)),{width:820,height:650});
 f.hook.close();assert.equal(writes.length,1,'closing an unchanged panel does not write again');

 f=floatingFixture(prefs);f.hook.update(true,limits);
 assert.equal(f.panel.style.width,'820px');assert.equal(f.panel.style.height,'650px','a new composer reuses the chosen size');
 f.hook.update(true,{maxWidth:500,maxHeight:350});
 assert.equal(f.panel.style.width,'500px');assert.equal(f.panel.style.height,'350px');
 assert.equal(writes.length,1,'a smaller message area does not replace the preferred size');
 f.hook.update(true,limits);assert.equal(f.panel.style.width,'820px');assert.equal(f.panel.style.height,'650px');
 for(let count=0;count<3;count++)f.corner.emit('keydown',event({key:'ArrowRight'}));
 assert.equal(writes.length,1,'holding a resize key does not repeatedly persist');
 f.corner.emit('keyup',event({key:'ArrowRight'}));assert.equal(writes.length,2);
 assert.deepEqual(JSON.parse(prefs.getStringPref(key)),{width:772,height:650});
 f.corner.emit('keydown',event({key:'ArrowUp'}));f.corner.emit('blur');assert.equal(writes.length,3,'leaving the grip completes a keyboard gesture');
 f.corner.emit('keydown',event({key:'ArrowRight'}));f.hook.close();assert.equal(writes.length,4,'closing before keyup retains the latest choice');

 const restarted=vm.createContext({});vm.runInContext(fs.readFileSync(path.join(__dirname,'../inline-labels/compose.js'),'utf8'),restarted);
 f=floatingFixture(prefs,'rtl',restarted);f.hook.update(true,limits);
 assert.equal(f.panel.style.width,'756px');assert.equal(f.panel.style.height,'666px','a fresh extension context restores the stored preference');
 f.corner.emit('keydown',event({key:'ArrowLeft'}));f.corner.emit('keyup',event({key:'ArrowLeft'}));
 assert.equal(f.panel.style.width,'740px','RTL keyboard resizing remains mirrored');
 f.side.emit('pointerdown',event());f.side.emit('pointermove',event({clientX:230}));f.side.emit('pointerup',event());
 assert.deepEqual(JSON.parse(prefs.getStringPref(key)),{width:770,height:666},'RTL side grip follows its visual direction');
 f.hook.close();
});

test('invalid floating size preferences fall back safely and oversized drags save the visible result',()=>{
 const key='extensions.thunderg.floatingComposeSize',limits={maxWidth:900,maxHeight:700};
 for(const saved of ['broken JSON','null','{}','[]','{"width":"800","height":600}','{"width":0,"height":600}','{"width":800,"height":-1}','{"width":1e999,"height":600}']) {
  const prefs=preferences({[key]:saved}),f=floatingFixture(prefs);f.hook.update(true,limits);
  assert.equal(f.panel.style.width,'720px');assert.equal(f.panel.style.height,'600px');
  f.hook.close();assert.equal(prefs.getStringPref(key),saved,'opening a panel does not write over preferences');
 }
 const unavailable=floatingFixture({getStringPref(){throw new Error('unavailable')},setStringPref(){throw new Error('unavailable')}});
 unavailable.hook.update(true,limits);unavailable.corner.emit('keydown',{key:'ArrowRight',preventDefault(){},stopPropagation(){}});unavailable.hook.close();
 const prefs=preferences(),f=floatingFixture(prefs);f.hook.update(true,limits);
 const event=values=>({button:0,pointerId:1,clientX:200,clientY:200,preventDefault(){},stopPropagation(){},...values});
 f.corner.emit('pointerdown',event());f.corner.emit('pointermove',event({clientX:-10000,clientY:-10000}));f.corner.emit('pointerup',event());
 assert.deepEqual(JSON.parse(prefs.getStringPref(key)),{width:900,height:700},'remember the visible size, not how far the pointer overshot');
 f.hook.update(true,{maxWidth:1600,maxHeight:1000});assert.equal(f.panel.style.width,'900px');assert.equal(f.panel.style.height,'700px');f.hook.close();
});

function sendFixture({result='success',draftFails=false,busy=false}={}) {
 const events=new Map(),states=[],timers=new Map();let sendListener,saved=0,timerId=0;
 const modes={Now:0,Later:1,SaveAsDraft:4,Background:8};
 const compose={compFields:{from:'Me <me@example.org>',to:'You <you@example.org>',subject:'Re: Thread',messageId:''},
  addMsgSendListener(listener){sendListener=listener},removeMsgSendListener(listener){assert.equal(listener,sendListener);sendListener=null}};
 const native={gSendOperationInProgress:busy,gMsgCompose:compose,gAttachmentBucket:{itemChildren:[{attachment:{name:'notes.pdf'}}]},
  GetCurrentEditor:()=>({outputToString:()=>'<literal text> reply'}),
  addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:name=>events.delete(name),
  async GenericSendMessage(mode){
   if(result==='preflight-cancel')return;
   events.get('compose-send-message')?.({detail:{msgType:mode}});
   if(busy)sendListener.onStartSending();
   if(mode!==modes.Now && mode!==modes.Background)return;
   if(result==='success'){
    sendListener.onStopSending('<outgoing-id>',0);compose.compFields.messageId='<outgoing-id>';
    events.get('aftersend')?.();
   }
   if(result==='server-error')sendListener.onStopSending('<failed>',0x80004005,'SMTP server refused the connection');
   if(result==='throw')throw new Error('network failed');
  }};
 const original=native.GenericSendMessage;
 const clock={setTimeout(fn){timers.set(++timerId,fn);return timerId},clearTimeout(id){timers.delete(id)}};
 const status=scope.installInlineSendStatus(native,clock,state=>states.push(state),async()=>{saved++;if(draftFails)throw new Error('disk full');return 'draft://42'},modes);
 return {native,states,status,original,modes,timers,fail(){sendListener.onStopSending('',1,'Send failed')},tick(){const pending=[...timers.values()];timers.clear();for(const fn of pending)fn()},get saved(){return saved}};
}
test('inline send shows an immediate snapshot and reports Sent only after native aftersend',async()=>{
 const f=sendFixture();await f.native.GenericSendMessage(f.modes.Now);
 assert.deepEqual(f.states.map(s=>s.state),['sending','sent']);
 assert.equal(f.states[0].body,'<literal text> reply');assert.equal(f.states[0].attachments[0],'notes.pdf');
 assert.equal(f.states[1].messageId,'<outgoing-id>');assert.equal(f.states[0].id,f.states[1].id);
 assert.equal(f.saved,0);f.status.close();assert.equal(f.native.GenericSendMessage,f.original);
});
test('native failure saves the real composer as a draft and exposes draft-save failure honestly',async()=>{
 for(const draftFails of [false,true]){
  const f=sendFixture({result:'failure',draftFails});await f.native.GenericSendMessage(f.modes.Now);
  assert.deepEqual(f.states.map(s=>s.state),['sending','saving-draft',draftFails?'draft-error':'draft-saved']);
  assert.equal(f.saved,1);if(!draftFails)assert.equal(f.states.at(-1).draftURI,'draft://42');f.status.close();
 }
 const f=sendFixture({result:'throw'});await assert.rejects(()=>f.native.GenericSendMessage(f.modes.Now));
 assert.equal(f.states.at(-1).state,'draft-saved');f.status.close();
});
test('preflight cancellation, draft autosave and queued mail do not pretend to send',async()=>{
 const cancelled=sendFixture({result:'preflight-cancel'});await cancelled.native.GenericSendMessage(cancelled.modes.Now);
 assert.equal(cancelled.states.length,0);assert.equal(cancelled.saved,0);cancelled.status.close();
 const f=sendFixture();await f.native.GenericSendMessage(f.modes.SaveAsDraft);await f.native.GenericSendMessage(f.modes.Later);
 assert.equal(f.states.length,0);assert.equal(f.saved,0);f.status.close();
});
test('native progress preference is restored after concurrent embedded sends without overwriting user changes',()=>{
 const prefs=preferences({'mailnews.show_send_progress':true});
 const a=scope.suppressInlineSendProgress(prefs),b=scope.suppressInlineSendProgress(prefs);
 assert.equal(prefs.getBoolPref('mailnews.show_send_progress'),false);a();a();
 assert.equal(prefs.getBoolPref('mailnews.show_send_progress'),false);b();
 assert.equal(prefs.getBoolPref('mailnews.show_send_progress'),true);
 const c=scope.suppressInlineSendProgress(prefs);prefs.setBoolPref('mailnews.show_send_progress',true);c();
 assert.equal(prefs.getBoolPref('mailnews.show_send_progress'),true);
});

test('failed-send recovery waits for native send and save operations to finish',async()=>{
 const f=sendFixture({result:'failure',busy:true});const sending=f.native.GenericSendMessage(f.modes.Now);
 await new Promise(setImmediate);f.native.gSaveOperationInProgress=true;f.fail();f.tick();await new Promise(setImmediate);assert.equal(f.saved,0);assert.equal(f.states.at(-1).state,'saving-draft');
 f.native.gSendOperationInProgress=false;f.native.gSaveOperationInProgress=true;f.tick();await new Promise(setImmediate);assert.equal(f.saved,0);
 f.native.gSaveOperationInProgress=false;f.tick();await sending;await new Promise(setImmediate);
 assert.equal(f.saved,1);assert.equal(f.states.at(-1).state,'draft-saved');f.status.close();
});
test('a later successful manual draft save clears a stale recovery failure notice',async()=>{
 const f=sendFixture({result:'failure',draftFails:true});await f.native.GenericSendMessage(f.modes.Now);
 assert.equal(f.states.at(-1).state,'draft-error');
 f.native.gMsgCompose.compFields.draftId='draft://manual';f.status.draftSaved();
 assert.equal(f.states.at(-1).state,'draft-saved');assert.equal(f.states.at(-1).draftURI,'draft://manual');f.status.close();
});
test('manual save during recovery avoids a duplicate save; closing cancels idle waiting',async()=>{
 const f=sendFixture({result:'failure',busy:true});const sending=f.native.GenericSendMessage(f.modes.Now);await new Promise(setImmediate);f.native.gSaveOperationInProgress=true;f.fail();f.tick();await new Promise(setImmediate);
 f.native.gMsgCompose.compFields.draftId='draft://manual';f.status.draftSaved();f.native.gSendOperationInProgress=false;f.native.gSaveOperationInProgress=false;f.tick();await sending;await new Promise(setImmediate);
 assert.equal(f.saved,0);assert.equal(f.states.at(-1).state,'draft-saved');f.status.close();
 const g=sendFixture({result:'failure',busy:true});const pending=g.native.GenericSendMessage(g.modes.Now);await new Promise(setImmediate);g.native.gSaveOperationInProgress=true;g.fail();g.tick();await new Promise(setImmediate);g.status.close();await pending;
 assert.equal(g.timers.size,0);assert.equal(g.saved,0);
});

test('failed send exposes native server details separately from draft recovery errors',async()=>{
 const f=sendFixture({result:'server-error',draftFails:true});await f.native.GenericSendMessage(f.modes.Now);
 assert.equal(f.states.at(-1).error,'SMTP server refused the connection');
 assert.equal(f.states.at(-1).draftError,'disk full');f.status.close();
 assert.equal(scope.inlineSendFailure(0x80004005),'Thunderbird error 0x80004005');
 assert.equal(scope.inlineSendFailure(undefined),'Thunderbird did not provide a failure reason.');
 assert.equal(scope.inlineSendFailure(1,'server\nrefused'),'server refused');
});

test('an active native transport is not treated as failed when GenericSendMessage returns',async()=>{
 const f=sendFixture({result:'failure',busy:true});await f.native.GenericSendMessage(f.modes.Now);
 assert.deepEqual(f.states.map(s=>s.state),['sending']);assert.equal(f.saved,0);
 assert.equal(f.native.gSendOperationInProgress,true);f.status.close();
});
