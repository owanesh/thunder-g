/* Use Thunderbird's draft machinery, including account folders and attachments. */
function createComposeAutosave(prefs) {
  const names = ['mail.compose.autosave','mail.compose.autosaveinterval'];
  const snapshotKey = 'extensions.thunderg.composeAutosaveSnapshot';
  const originals = new Map(), applied = new Map();
  const saved = prefs.getStringPref(snapshotKey,'');
  if (saved) {
    const values = JSON.parse(saved);
    if (!Array.isArray(values) || values.length !== 2 || values.some((item,index) =>
      item[0] !== names[index] || typeof item[1]?.user !== 'boolean' ||
      typeof item[1]?.value !== (index === 0 ? 'boolean' : 'number'))) throw new Error('Invalid autosave snapshot');
    for (const [name,value] of values) originals.set(name,value);
  }
  let closed = false;
  function read(name) {
    return name === names[0] ? prefs.getBoolPref(name) : prefs.getIntPref(name);
  }
  return {
    set(enabled, minutes) {
      if (closed) return;
      minutes = Number.isInteger(minutes) && minutes >= 1 && minutes <= 30 ? minutes : 1;
      for (const name of names) {
        if (!originals.has(name)) originals.set(name,{user:prefs.prefHasUserValue(name),value:read(name)});
      }
      // Save originals before touching native preferences, also across restarts.
      prefs.setStringPref(snapshotKey,JSON.stringify([...originals]));
      prefs.setBoolPref(names[0],enabled === true);
      prefs.setIntPref(names[1],minutes);
      applied.set(names[0],enabled === true); applied.set(names[1],minutes);
    },
    close() {
      if (closed) return; closed = true;
      for (const [name,previous] of originals) {
        // Preserve preferences changed independently while the extension ran.
        if (read(name) !== applied.get(name)) continue;
        if (!previous.user) prefs.clearUserPref(name);
        else if (name === names[0]) prefs.setBoolPref(name,previous.value);
        else prefs.setIntPref(name,previous.value);
      }
      prefs.clearUserPref(snapshotKey);
    }
  };
}

// Keep the full native compose document alive independently of conversation navigation.
var inlineReplyEnabled=false;
var inlineNewMessageEnabled=false;
var inlineComposeControllers=new WeakMap();
function inlineReplyParams(header,command,services=MailServices,interfaces=Ci,classes=Cc,utils=null) {
  const types={cmd_replySender:interfaces.nsIMsgCompType.ReplyToSender,cmd_replyall:interfaces.nsIMsgCompType.ReplyAll,cmd_forwardInline:interfaces.nsIMsgCompType.ForwardInline};
  if(!(command in types))throw new Error('Unsupported inline compose action');
  utils ||= ChromeUtils.importESModule('resource:///modules/MailUtils.sys.mjs').MailUtils;
  const params=classes['@mozilla.org/messengercompose/composeparams;1'].createInstance(interfaces.nsIMsgComposeParams);
  params.type=types[command];params.format=interfaces.nsIMsgCompFormat.Default;
  params.originalMsgURI=header.folder.getUriForMsg(header);
  [params.identity]=utils.getIdentityForHeader(header,params.type);
  params.composeFields=classes['@mozilla.org/messengercompose/composefields;1'].createInstance(interfaces.nsIMsgCompFields);
  return params;
}
function inlineNewMessageParams(folder,interfaces=Ci,classes=Cc,utils=null) {
  utils ||= ChromeUtils.importESModule('resource:///modules/MailUtils.sys.mjs').MailUtils;
  const params=classes['@mozilla.org/messengercompose/composeparams;1'].createInstance(interfaces.nsIMsgComposeParams);
  params.type=interfaces.nsIMsgCompType.New;params.format=interfaces.nsIMsgCompFormat.Default;
  params.identity=folder?.customIdentity || (folder?.server?utils.getIdentityForServer(folder.server)[0]:null);
  params.composeFields=classes['@mozilla.org/messengercompose/composefields;1'].createInstance(interfaces.nsIMsgCompFields);
  return params;
}
function installInlineNewMessage(win,create=createInlineCompose) {
  const controller=win.commandController,original=controller?.doCommand;
  if(typeof original!=='function')return {close(){}};
  function doCommand(command,...args){
    if(command!=='cmd_newMessage' || !inlineNewMessageEnabled || args[0]?.shiftKey || win.gFolder?.server?.type==='nntp')return original.call(this,command,...args);
    let composer=inlineComposeControllers.get(win);
    if(!composer){composer=create(win);inlineComposeControllers.set(win,composer);}
    composer.open(null,command,{folder:win.gFolder});
  }
  controller.doCommand=doCommand;
  // Thunderbird's Write button and main-window shortcut bypass the pane controller.
  const main=win.browsingContext?.topChromeWindow,previousNew=main?.MsgNewMessage;
  let closed=false;
  function newMessage(event){
    const pane=main.document.getElementById('tabmail')?.currentAbout3Pane;
    if(!closed && pane===win && inlineNewMessageEnabled && !event?.shiftKey && win.gFolder?.server?.type!=='nntp')return doCommand('cmd_newMessage',event);
    return previousNew.apply(this,arguments);
  }
  if(typeof previousNew==='function')main.MsgNewMessage=newMessage;
  return {close(){closed=true;if(controller.doCommand===doCommand)controller.doCommand=original;if(main?.MsgNewMessage===newMessage)main.MsgNewMessage=previousNew;}};
}
function saveInlineReplyDraft(native,clock,timeoutMs=60000) {
  return new Promise((resolve,reject)=>{
    if(native.gSaveOperationInProgress || native.gSendOperationInProgress){reject(new Error('Wait for the current save or send to finish.'));return;}
    const compose=native.gMsgCompose;let finished=false;
    const finish=(error)=>{
      if(finished)return;finished=true;clock.clearTimeout(timer);compose.UnregisterStateListener(listener);
      const uri=compose.compFields.draftId;
      if(error || !uri)reject(error || new Error('Draft was not saved.'));else resolve(uri);
    };
    const listener={NotifyComposeFieldsReady(){},NotifyComposeBodyReady(){},SaveInFolderDone(){},
      ComposeProcessDone(result){clock.setTimeout(()=>finish(result===0?null:new Error('Could not save the draft.')),0);}};
    const timer=clock.setTimeout(()=>finish(new Error('Draft saving timed out; your reply remains open.')),timeoutMs);
    compose.RegisterStateListener(listener);
    Promise.resolve().then(()=>native.GenericSendMessage(Ci.nsIMsgCompDeliverMode.SaveAsDraft)).catch(error=>finish(error));
  });
}

// Observe native saves; never report success merely because a timer fired or
// an older draft URI exists. Thunderbird keeps ownership of autosave and MIME.
function installComposeDraftStatus(native,status,clock,modes=Ci.nsIMsgCompDeliverMode,onState=()=>{}) {
  const compose=native.gMsgCompose;
  let closed=false,pending=false,started=0,timer=null,completion=null,state='';
  function show(next) {
    if(closed || state===next)return;
    state=next;status.dataset.state=next;
    status.textContent={saved:'✓ Saved',saving:'Saving…',dirty:'Unsaved changes',error:'Save failed',initial:'Not saved'}[next];
    status.title={saved:'Saved to Drafts',saving:'Saving to Drafts',dirty:'Changes have not been saved yet',error:'Could not save to Drafts. Use Save draft to retry.',initial:'Draft has not been saved yet'}[next];
    status.style.color=next==='saved'?'light-dark(#137333,#81c995)':next==='error'?'light-dark(#b3261e,#f2b8b5)':'light-dark(#5f6368,#bdc1c6)';
    onState(next);
  }
  const dirty=()=>!!(native.gContentChanged || compose.bodyModified);
  function edited(event) {
    // Native draft serialization also dispatches field updates. Only genuine
    // typing should clear confirmation before Thunderbird updates dirty flags.
    if((event?.type==='input' || event?.type==='change') && event.isTrusted===false)return;
    if(!pending && (event?.type==='input' || dirty()))show('dirty');
  }
  function saving(event) {
    if(event.detail?.msgType!==modes.SaveAsDraft && event.detail?.msgType!==modes.AutoSaveAsDraft)return;
    pending=true;started=Date.now();show('saving');
  }
  const listener={NotifyComposeFieldsReady(){},NotifyComposeBodyReady(){},SaveInFolderDone(){},ComposeProcessDone(result){
    if(!pending || closed)return;
    if(completion!==null)clock.clearTimeout(completion);
    // Native listeners may clear modified flags and set draftId in this turn.
    completion=clock.setTimeout(()=>{
      completion=null;if(closed)return;pending=false;
      if(result!==0 || !compose.compFields.draftId)show('error');
      // Native autosave clears flags at its start and preserves subsequent
      // edits; manual save locks the editor until completion.
      else show(dirty()?'dirty':'saved');
    },0);
  }};
  const editorDocument=native.GetCurrentEditor?.()?.document;
  const documents=[...new Set([native.document,editorDocument].filter(Boolean))];
  const changes=['input','change','attachments-added','attachments-removed','attachment-renamed','compose-from-changed'];
  for(const doc of documents)for(const name of changes)doc.addEventListener(name,edited,true);
  native.addEventListener('compose-send-message',saving);
  compose.RegisterStateListener(listener);
  function check() {
    if(closed)return;
    if(pending && completion===null && !native.gSaveOperationInProgress && Date.now()-started>2000) {
      pending=false;show('error');
    }else if(!pending && dirty() && state!=='error')show('dirty');
    timer=clock.setTimeout(check,500);
  }
  show('initial');check();
  return {close(){
    if(closed)return;closed=true;clock.clearTimeout(timer);if(completion!==null)clock.clearTimeout(completion);
    for(const doc of documents)for(const name of changes)doc.removeEventListener(name,edited,true);
    native.removeEventListener('compose-send-message',saving);compose.UnregisterStateListener(listener);
  }};
}

// The native progress dialog is controlled by a shared preference. Lease it
// only during embedded sends and restore it after the last concurrent send.
var inlineSendProgressLease=null;
function suppressInlineSendProgress(prefs=typeof Services==='undefined'?null:Services.prefs) {
  if(!prefs)return ()=>{};
  const key='mailnews.show_send_progress';
  if(!inlineSendProgressLease) {
    inlineSendProgressLease={users:0,user:prefs.prefHasUserValue(key),value:prefs.getBoolPref(key,true)};
    prefs.setBoolPref(key,false);
  }
  const lease=inlineSendProgressLease;lease.users++;let released=false;
  return ()=>{
    if(released)return;released=true;
    if(--lease.users)return;
    inlineSendProgressLease=null;
    if(prefs.getBoolPref(key,true)!==false)return;
    if(lease.user)prefs.setBoolPref(key,lease.value);else prefs.clearUserPref(key);
  };
}

// Observe the native async operation, not a button click or a guessed timeout.
// GenericSendMessage catches native failures itself, so a completed call without
// aftersend is a failure/cancellation only if compose-send-message actually ran.
function inlineSendFailure(status,message) {
  const detail=typeof message==='string'?message.replace(/[\x00-\x1f\x7f]/g,' ').trim().slice(0,240):'';
  if(detail)return detail;
  if(typeof status==='number' && status!==0) {
    const name=typeof Components==='undefined'?null:Object.keys(Components.results).find(key=>Components.results[key]===status);
    return name || `Thunderbird error 0x${(status>>>0).toString(16).padStart(8,'0')}`;
  }
  return 'Thunderbird did not provide a failure reason.';
}
function installInlineSendStatus(native,clock,onState,saveDraft=()=>saveInlineReplyDraft(native,clock),modes=Ci.nsIMsgCompDeliverMode) {
  const original=native.GenericSendMessage,compose=native.gMsgCompose;
  if(typeof original!=='function')return {close(){}};
  let closed=false,job=null,sequence=0,idleTimer=null,idleCancel=null;
  function waitForIdle() {
    return new Promise((resolve,reject)=>{
      let checks=0;
      const finish=error=>{if(idleTimer!==null)clock.clearTimeout(idleTimer);idleTimer=null;idleCancel=null;error?reject(error):resolve()};
      idleCancel=()=>finish(new Error('Composer closed.'));
      const check=()=>{
        if(closed)return finish(new Error('Composer closed.'));
        if(!native.gSendOperationInProgress && !native.gSaveOperationInProgress)return finish();
        if(++checks>=300)return finish(new Error('Composer is still busy; reply remains open.'));
        idleTimer=clock.setTimeout(check,100);
      };check();
    });
  }
  function draftSaved() {
    if(closed || !job || !job.done || job.delivered)return;
    job.recovered=true;job.draftURI=compose.compFields.draftId;emit('draft-saved');
  }
  function snapshot() {
    const fields=compose.compFields;
    let body='';try{body=native.GetCurrentEditor().outputToString('text/plain',0)}catch(_){}
    ++sequence;return {id:{},from:fields.from || native.gCurrentIdentity?.email || '',to:fields.to || '',
      subject:fields.subject || '',date:Date.now(),cc:fields.cc || '',body,messageId:fields.messageId || '',attachments:Array.from(native.gAttachmentBucket?.itemChildren || [],item=>item.attachment?.name || '').filter(Boolean)};
  }
  function emit(state){if(!closed && job)onState({...job,state})}
  function starting(event) {
    if(event.defaultPrevented || ![modes.Now,modes.Background].includes(event.detail?.msgType))return;
    job=snapshot();emit('sending');
  }
  function sent(){if(!job || job.done)return;job.messageId=compose.compFields.messageId || job.messageId;job.done=true;job.delivered=true;emit('sent')}
  function recoverLater(){clock.setTimeout(()=>{if(!closed && job?.error && !job.done)recover();},0)}
  async function recover(){
    if(closed || !job || job.done)return;
    job.done=true;job.error ||= inlineSendFailure();emit('saving-draft');
    if((!job.transportStarted || job.transportStopped) && native.gSendOperationInProgress){native.gSendOperationInProgress=false;native.ToggleWindowLock?.(false);}
    const failedJob=job;
    try{
      await waitForIdle();
      if(closed || job!==failedJob || job.delivered || job.recovered)return;
      job.draftURI=await saveDraft();job.recovered=true;emit('draft-saved');
    }catch(error){if(!closed && job===failedJob && !job.recovered){job.draftError=inlineSendFailure(error?.result,error?.message);emit('draft-error')}}
  }
  const stateListener={NotifyComposeFieldsReady(){},NotifyComposeBodyReady(){},SaveInFolderDone(){},ComposeProcessDone(result){if(result!==0 && job && !job.done){job.transportStopped=true;job.error=inlineSendFailure(result);recoverLater()}}};
  const listener={onStartSending(){if(job)job.transportStarted=true},onSendProgress(){},onStatus(){},onGetDraftFolderURI(){},
    onSendNotPerformed(id,status){if(job){job.transportStopped=true;job.error=inlineSendFailure(status);recoverLater()}},
    onStopSending(id,status,message){if(job)job.transportStopped=true;if(job && id)job.messageId=id;if(status===0)sent();else if(job){job.error=inlineSendFailure(status,message);recoverLater()}},
    onTransportSecurityError(id,status){if(job)job.error=inlineSendFailure(status,'Connection security error. Check Thunderbird’s security prompt.')}};
  async function send(mode,...args) {
    const sending=[modes.Now,modes.Background].includes(mode),before=sequence;
    const restoreProgress=sending?suppressInlineSendProgress():()=>{};
    try{return await original.call(this,mode,...args)}
    catch(error){if(job)job.error=inlineSendFailure(error?.result,error?.message);throw error}
    finally {
      restoreProgress();
      // The native call may resolve while transport is still active. That is
      // not a failure: wait for a native terminal callback instead.
      if(sending && !closed && sequence!==before && job && !job.done &&
        (job.error || !native.gSendOperationInProgress))await recover();
    }
  }
  native.GenericSendMessage=send;
  native.addEventListener('compose-send-message',starting);
  native.addEventListener('aftersend',sent);
  compose.addMsgSendListener?.(listener);compose.RegisterStateListener?.(stateListener);
  return {draftSaved,close(){
    if(closed)return;closed=true;idleCancel?.();
    if(native.GenericSendMessage===send)native.GenericSendMessage=original;
    native.removeEventListener('compose-send-message',starting);native.removeEventListener('aftersend',sent);
    compose.removeMsgSendListener?.(listener);compose.UnregisterStateListener?.(stateListener);
  }};
}

// Floating panels are anchored beside the sidebar. Resize from their top/left
// edges so the grip can move naturally without pushing the footer off screen.
function installFloatingComposeResize(win,panel,prefs=typeof Services==='undefined'?null:Services.prefs) {
  const doc=win.document,handles=[];
  const preference='extensions.thunderg.floatingComposeSize';
  let floating=false,bounds={maxWidth:720,maxHeight:620},preferred=null,drag=null,pendingSave=false,savedSize='';
  try {
    const value=JSON.parse(prefs?.getStringPref(preference,'') || 'null');
    if(value && [value.width,value.height].every(size=>Number.isFinite(size) && size>0)) {
      preferred={width:value.width,height:value.height};savedSize=JSON.stringify(preferred);
    }
  }catch(_){} // An absent or invalid layout preference must never block composition.
  function clamp(width,height) {
    return {width:Math.max(Math.min(420,bounds.maxWidth),Math.min(width,bounds.maxWidth)),
      height:Math.max(Math.min(320,bounds.maxHeight),Math.min(height,bounds.maxHeight))};
  }
  function current() {const rect=panel.getBoundingClientRect();return {width:rect.width || 720,height:rect.height || Math.min(620,(win.innerHeight || 768)*.75)};}
  function apply(size,remember=false) {
    const fit=clamp(size.width,size.height);
    if(remember){preferred=fit;pendingSave=true;}
    panel.style.width=`${fit.width}px`;panel.style.height=`${fit.height}px`;
    panel.style.minWidth=`${Math.min(420,bounds.maxWidth)}px`;panel.style.minHeight=`${Math.min(320,bounds.maxHeight)}px`;
    panel.style.maxHeight=`${bounds.maxHeight}px`;
  }
  function saveSize() {
    if(!pendingSave)return;
    pendingSave=false;
    const value=JSON.stringify(preferred);
    if(value===savedSize)return;
    // Persist one completed gesture, never individual pointer moves or automatic
    // viewport/sidebar adjustments. Keep the in-memory choice if storage fails.
    try {prefs?.setStringPref(preference,value);savedSize=value;}catch(_){}
  }
  function stop(event) {
    if(event?.pointerId!=null && drag && event.pointerId!==drag.pointerId)return;
    const previous=drag;drag=null;
    if(previous?.handle.hasPointerCapture?.(previous.pointerId))previous.handle.releasePointerCapture(previous.pointerId);
    saveSize();
  }
  function move(event) {
    if(!drag || event.pointerId!==drag.pointerId)return;
    const dx=(event.clientX-drag.x)*(drag.rtl?-1:1),dy=event.clientY-drag.y;
    apply({width:drag.width-(drag.kind==='top'?0:dx),height:drag.height-(drag.kind==='side'?0:dy)},true);
    event.preventDefault();
  }
  for(const kind of ['corner','top','side']) {
    const handle=doc.createElement('button');handle.type='button';handle.className=`gm-compose-resize gm-compose-resize-${kind}`;
    handle.setAttribute('aria-label','Resize compose panel');handle.title='Drag to resize; arrow keys resize, Shift makes larger steps';
    const rtl=doc.documentElement.dir==='rtl',side=rtl?'right':'left';
    handle.style.cssText=`position:absolute;z-index:2;padding:0;margin:0;border:0;background:transparent;color:light-dark(#80868b,#9aa0a6);touch-action:none;${kind==='top'?'top:0;left:18px;right:0;height:6px;cursor:ns-resize;':kind==='side'?`${side}:0;top:18px;bottom:0;width:6px;cursor:ew-resize;`:`top:0;${side}:0;width:18px;height:18px;cursor:${rtl?'nesw':'nwse'}-resize;font-size:16px;line-height:18px;`}`;
    handle.tabIndex=kind==='corner'?0:-1;
    if(kind==='corner') {
      const icon=doc.createElementNS('http://www.w3.org/2000/svg','svg');icon.setAttribute('viewBox','0 0 18 18');icon.setAttribute('width','18');icon.setAttribute('height','18');icon.setAttribute('aria-hidden','true');
      if(rtl)icon.style.transform='scaleX(-1)';
      const lines=doc.createElementNS('http://www.w3.org/2000/svg','path');lines.setAttribute('d','M3 12 12 3 M3 8 8 3 M3 4 4 3');lines.setAttribute('stroke','currentColor');lines.setAttribute('fill','none');icon.append(lines);handle.append(icon);
    }
    handle.addEventListener('pointerdown',event=>{
      if(!floating || event.button!==0)return;
      event.preventDefault();event.stopPropagation();const size=current();
      drag={...size,x:event.clientX,y:event.clientY,kind,handle,pointerId:event.pointerId,rtl};handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener('keydown',event=>{
      if(!floating || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;
      event.preventDefault();event.stopPropagation();const size=current(),step=event.shiftKey?40:16;
      apply({width:size.width+(['ArrowLeft','ArrowRight'].includes(event.key)?((event.key==='ArrowLeft')!==rtl?step:-step):0),
        height:size.height+(event.key==='ArrowUp'?step:event.key==='ArrowDown'?-step:0)},true);
    });
    handle.addEventListener('keyup',event=>{
      if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))saveSize();
    });
    handle.addEventListener('blur',saveSize);
    handle.addEventListener('pointermove',move);
    handle.addEventListener('pointerup',stop);handle.addEventListener('pointercancel',stop);handle.addEventListener('lostpointercapture',stop);
    panel.append(handle);handles.push(handle);
  }
  return {update(enabled,limits){
    floating=enabled;bounds={maxWidth:Math.max(0,limits.maxWidth),maxHeight:Math.max(0,limits.maxHeight)};
    for(const handle of handles)handle.hidden=!enabled;
    if(!enabled){stop();return;}
    apply(preferred || current());
  },close(){stop();for(const handle of handles)handle.remove();}};
}
// macOS cannot show a file picker anchored to an embedded compose browsing
// context. Keep native attachment conversion/handling, but anchor to its host.
function installEmbeddedAttachmentPicker(native,main,classes=Cc,interfaces=Ci) {
  const original=native.AttachFile;
  if(typeof original!=='function')return {close(){}};
  let closed=false,busy=false;
  async function attach(){
    if(closed || busy)return;
    busy=true;
    try {
      const title=await native.document.l10n.formatValue('compose-attach-file-picker-title');
      if(closed)return;
      if(native.gAttachmentBucket.itemCount)native.toggleAttachmentPane('show');
      const picker=classes['@mozilla.org/filepicker;1'].createInstance(interfaces.nsIFilePicker);
      picker.init(main.browsingContext,title,interfaces.nsIFilePicker.modeOpenMultiple);
      const directory=native.GetLastAttachDirectory();if(directory)picker.displayDirectory=directory;
      picker.appendFilters(interfaces.nsIFilePicker.filterAll);
      picker.open(result=>{
        busy=false;
        if(closed || result!==interfaces.nsIFilePicker.returnOK || !picker.files || !native.gMsgCompose)return;
        const files=[...picker.files];
        native.AddAttachments(files.map(file=>native.FileToAttachment(file)));
        if(files.length)native.SetLastAttachDirectory(files.at(-1));
      });
    }catch(error){busy=false;console.error('Thunder-G: could not open the attachment picker.',error);}
  }
  native.AttachFile=attach;
  return {close(){closed=true;if(native.AttachFile===attach)native.AttachFile=original;}};
}
// A saved draft is discarded through Thunderbird's recoverable Trash path.
// Never use RemoveDraft(), which can permanently delete/expunge the copy.
function trashInlineDraft(native,services=MailServices,msgWindow=null) {
  if(native.gSendOperationInProgress || native.gSaveOperationInProgress)return Promise.reject(new Error('Wait for the current send or save to finish.'));
  const uri=native.gMsgCompose?.compFields.draftId;
  if(!uri)return Promise.resolve();
  return new Promise((resolve,reject)=>{
    try {
      const header=services.messageServiceFromURI(uri).messageURIToMsgHdr(uri);
      if(!header?.folder)throw new Error('The saved draft could not be found.');
      header.folder.deleteMessages([header],msgWindow,false,false,{
        onStartCopy(){},onProgress(){},setMessageKey(){},getMessageId(){return null;},
        onStopCopy(status){if(status===0)resolve();else reject(new Error('Could not move the draft to Trash.'));}
      },true);
    }catch(error){reject(error)}
  });
}
// Native compose assumes window.content resolves its primary editor. In an
// embedded chrome window that legacy lookup can be null during startup.
function installEmbeddedComposeContent(native) {
  const previous=Object.getOwnPropertyDescriptor(native,'content');
  const get=()=>native.document.getElementById('messageEditor')?.contentWindow || null;
  Object.defineProperty(native,'content',{configurable:true,enumerable:previous?.enumerable ?? true,get});
  return {close(){
    try{
      if(Object.getOwnPropertyDescriptor(native,'content')?.get!==get)return;
      if(previous)Object.defineProperty(native,'content',previous);else delete native.content;
    }catch(_){/* The disposable compose window may already have been destroyed. */}
  }};
}
// An editor object can exist before native body/signature initialization ends.
// Observe the native completion event before exposing an editable composer.
function watchInlineComposeBodyReady(native) {
  let ready=false,compose=null,closed=false;
  const listener={NotifyComposeFieldsReady(){},ComposeProcessDone(){},SaveInFolderDone(){},NotifyComposeBodyReady(){if(!closed)ready=true}};
  function init(){
    if(closed || compose)return;
    compose=native.gMsgCompose;compose?.RegisterStateListener(listener);
  }
  native.addEventListener('compose-window-init',init,true);
  return {get ready(){return ready},close(){if(closed)return;closed=true;native.removeEventListener('compose-window-init',init,true);compose?.UnregisterStateListener(listener);}};
}
function styleInlineComposeBody(native) {
  const utils=native.document.getElementById?.('messageEditor')?.contentWindow?.windowUtils;
  if(!utils)return {close(){}};
  const css='body{margin:12px 20px;line-height:1.5;}'+(!native.gMsgCompose.composeHTML?'body,body>pre,pre.moz-signature{font-family:Arial,sans-serif!important;font-size:14px!important;line-height:1.5!important;}':'');
  const uri='data:text/css;charset=utf-8,'+encodeURIComponent(css);
  // Sheet loading is presentation-only. Inserting <style> into an editable
  // document marks it modified and can interfere with native startup/autosave.
  utils.loadSheetUsingURIString(uri,utils.USER_SHEET);
  return {close(){try{utils.removeSheetUsingURIString(uri,utils.USER_SHEET)}catch(_){}}};
}
function createInlineCompose(win) {
  const doc=win.document;let browser=null,panel=null,originalHeader=null,originalCommand=null,ready=false,observer=null;
  let restoreChrome=null,loadingTimer=null,inlineContainer=null,scrollHost=null,presentation='inline',bar=null,title=null,floatButton=null,windowButton=null,transferBusy=false,attachmentPicker=null,draftStatus=null,floatingResize=null,sendStatus=null;
  let sendNotice=null,noticeTimer=null,scrim=null,minimized=false,minimizeButton=null,bodyReadyWatcher=null,bodySheet=null,composeContentBridge=null;
  const main=win.browsingContext.topChromeWindow;
  function stopObserver(){if(observer){Services.obs.removeObserver(observer,'chrome-document-global-created');observer=null;}}
  function dispose(){
    bodyReadyWatcher?.close();bodyReadyWatcher=null;bodySheet?.close();bodySheet=null;
    sendStatus?.close();sendStatus=null;
    draftStatus?.close();draftStatus=null;floatingResize?.close();floatingResize=null;
    attachmentPicker?.close();attachmentPicker=null;
    stopObserver();if(loadingTimer!==null)win.clearTimeout(loadingTimer);loadingTimer=null;
    restoreChrome?.();restoreChrome=null;
    browser?.remove();composeContentBridge?.close();composeContentBridge=null;panel?.remove();scrim?.remove();scrim=null;minimized=false;browser=panel=originalHeader=originalCommand=null;ready=false;
  }
  function requestClose(){
    if(!browser)return true;
    if(transferBusy)return false;
    const native=browser.contentWindow;
    if(!native.gMsgCompose){dispose();return true;}
    if(native.ComposeCanClose()){dispose();return true;}
    return false;
  }
  async function saveAndClose(){
    if(!browser || transferBusy)return;
    const native=browser.contentWindow;
    if(!native.gMsgCompose){dispose();return;}
    if(native.gSendOperationInProgress || native.gSaveOperationInProgress){title.textContent='Wait for the current send or save to finish.';return;}
    transferBusy=true;
    try{
      if(native.gContentChanged || native.gMsgCompose.bodyModified || !native.gMsgCompose.compFields.draftId)await saveInlineReplyDraft(native,win);
      dispose();
    }catch(error){title.textContent=error.message || 'Could not save the draft. Your reply remains open.';}
    finally{transferBusy=false;}
  }
  async function discard(){
    if(!ready || transferBusy || !browser)return;
    const native=browser.contentWindow;
    if(native.gSendOperationInProgress || native.gSaveOperationInProgress){title.textContent='Wait for the current send or save to finish.';return;}
    transferBusy=true;
    // Pause autosave while the saved copy is moved; restore it if Trash fails.
    if(native.gAutoSaveTimeout)native.clearTimeout(native.gAutoSaveTimeout);
    try{await trashInlineDraft(native,MailServices,main.msgWindow);hideSendNotice();dispose();}
    catch(error){title.textContent=error.message || 'Could not discard. Your message remains open.';
      if(native.gAutoSaveInterval)native.gAutoSaveTimeout=native.setTimeout(native.AutoSave,native.gAutoSaveInterval);
    }finally{transferBusy=false;}
  }
  function minimize(){
    if(!panel)return;
    if(minimized){minimized=false;panel.style.transform='';labelControl(minimizeButton,'minimize','Minimize');browser?.focus();return;}
    float();minimized=true;
    // Translate the intact panel below the viewport, retaining editor layout,
    // signature, undo history and attachment state. Never display:none it.
    panel.style.transform='translateY(calc(100% - 40px))';
    labelControl(minimizeButton,'maximize','Restore composer');
  }
  function parentClose(event){if(browser && !requestClose())event.preventDefault();}
  main.addEventListener('close',parentClose,true);
  const tabmail=main.document.getElementById('tabmail');
  const tab=tabmail?.tabInfo.find(item=>item.chromeBrowser?.contentWindow===win);
  const mode=tab?.mode,previousTryClose=mode?.tryCloseTab;
  function tryCloseTab(candidate){
    if(candidate===tab && browser && !requestClose())return false;
    return previousTryClose?previousTryClose.apply(this,arguments):true;
  }
  if(mode)mode.tryCloseTab=tryCloseTab;
  function detach(){
    sidebarResize?.disconnect();win.removeEventListener('resize',fitComposeToContent);win.removeEventListener('scroll',positionSendNotice,true);
    main.removeEventListener('close',parentClose,true);
    if(mode?.tryCloseTab===tryCloseTab)mode.tryCloseTab=previousTryClose;
    win.removeEventListener('unload',unload);
  }
  function unload(){detach();dispose();sendNotice?.remove();if(noticeTimer!==null)win.clearTimeout(noticeTimer);}
  win.addEventListener('unload',unload,{once:true});
  function hideSendNotice(){if(sendNotice){sendNotice.hidden=true;sendNotice.style.display='none';}}
  function positionSendNotice(){
    if(!sendNotice)return;
    const footer=browser?.contentDocument?.getElementById('compose-toolbox');
    const frameTop=browser?.getBoundingClientRect?.().top;
    const footerTop=footer?.getBoundingClientRect?.().top;
    const bottom=panel && !panel.hidden && Number.isFinite(frameTop) && Number.isFinite(footerTop)?Math.max(88,win.innerHeight-frameTop-footerTop+8):24;
    sendNotice.style.bottom=`${bottom}px`;
  }
  function fitComposeToContent(){
    positionSendNotice();
    if(!panel)return;
    const sidebar=doc.getElementById('folderPane')?.getBoundingClientRect?.();
    const viewport=doc.documentElement.getBoundingClientRect?.();
    const rtl=doc.documentElement.dir==='rtl';
    const splitter=doc.getElementById('folderPaneSplitter')?.getBoundingClientRect?.();
    const edge=rtl?Math.min(sidebar?.left ?? 0,splitter?.left ?? sidebar?.left ?? 0):Math.max(sidebar?.right || 0,splitter?.right || 0);
    const boundary=sidebar?.width>0?Math.max(0,rtl?(viewport?.right || win.innerWidth)-edge:edge-(viewport?.left || 0)):0;
    if(presentation==='full'){
      panel.style.left='12px';panel.style.right='12px';
    }
    panel.style.maxWidth=`max(0px,calc(100vw - ${presentation==='full'?24:boundary+(presentation==='floating'?32:0)}px))`;
    floatingResize?.update(presentation==='floating',{maxWidth:(viewport?.width || win.innerWidth || 1024)-boundary-32,maxHeight:(viewport?.height || win.innerHeight || 768)-24});
  }
  const sidebarResize=win.ResizeObserver?new win.ResizeObserver(fitComposeToContent):null;
  const sidebar=doc.getElementById('folderPane');if(sidebar)sidebarResize?.observe(sidebar);
  win.addEventListener('resize',fitComposeToContent);win.addEventListener('scroll',positionSendNotice,true);
  function setPresentation(next){
    if(!panel)return;
    presentation=next;minimized=false;panel.setAttribute('data-presentation',next);if(scrim)scrim.hidden=next!=='full';
    const common='display:flex;flex-direction:column;min-height:320px;box-sizing:border-box;isolation:isolate;contain:paint;background:light-dark(#ffffff,#18181b);border:1px solid var(--layout-border-0,#dadce0);border-radius:12px;overflow:hidden;';
    panel.style.cssText=common+(next==='inline'?'position:relative;height:460px;margin:16px 0 20px 56px;box-shadow:none;':next==='full'?'position:fixed;z-index:1000;inset:12px;width:auto;height:calc(100% - 24px);min-height:0;border:0;border-radius:12px;box-shadow:0 8px 32px #0004;':'position:fixed;z-index:1000;inset:auto 16px 12px auto;width:min(600px,calc(100vw - 32px));height:min(640px,80vh);box-shadow:0 4px 22px #0003;');
    if(originalCommand==='cmd_newMessage') {
      labelControl(floatButton,next==='full'?'detach':'window',next==='full'?'Detach message':'Expand in this window');
      floatButton.hidden=false;
    }else{
      const label=next==='inline'?'Detach reply into a floating panel':'Return reply below the message';
      labelControl(floatButton,next==='inline'?'detach':'inline',next==='inline'?'Detach reply':'Return to conversation',label);
      floatButton.hidden=next!=='inline' && (!inlineContainer?.isConnected || scrollHost?.hidden);
    }
    windowButton.hidden=next==='inline' || originalCommand==='cmd_newMessage';
    windowButton.style.display=windowButton.hidden?'none':'inline-flex';
    floatButton.style.display=floatButton.hidden?'none':'inline-flex';
    if(minimizeButton){labelControl(minimizeButton,'minimize','Minimize');minimizeButton.style.order='-1';}
    fitComposeToContent();
  }
  function float(){
    if(!panel)return;
    // An atomic move keeps the browser/editor and its undo/attachments alive.
    if(panel.parentNode!==doc.documentElement){
      if(typeof doc.documentElement.moveBefore!=='function')throw new Error('State-preserving panel moves are unavailable.');
      doc.documentElement.moveBefore(panel,null);
    }
    setPresentation('floating');
  }
  function returnInline(){
    if(originalCommand==='cmd_newMessage'){setPresentation('full');return;}
    if(!inlineContainer?.isConnected || scrollHost?.hidden)return;
    inlineContainer.moveBefore(panel,null);setPresentation('inline');panel.scrollIntoView({block:'nearest',behavior:'instant'});
  }
  async function separateWindow(){
    if(!ready || transferBusy)return;
    transferBusy=true;windowButton.disabled=true;floatButton.disabled=true;
    const native=browser.contentWindow;
    try {
      title.textContent='Saving draft before opening a separate window…';
      const subject=native.document.getElementById('msgSubject').value;
      const uri=await saveInlineReplyDraft(native,win);
      // Drafts must go through the compose service so their MIME body and attachments
      // are loaded; opening messengercompose.xhtml with empty fields loses that step.
      const newWindow=await new Promise((resolve,reject)=>{
        let timer;
        const opened={observe(subject,topic){if(topic!=='domwindowopened')return;
          Services.ww.unregisterNotification(opened);win.clearTimeout(timer);resolve(subject);}};
        Services.ww.registerNotification(opened);
        timer=win.setTimeout(()=>{Services.ww.unregisterNotification(opened);reject(new Error('Could not open a separate window; the draft remains here.'));},15000);
        try {
          const draftHeader=MailServices.messageServiceFromURI(uri).messageURIToMsgHdr(uri);
          MailServices.compose.OpenComposeWindow(null,draftHeader,uri,Ci.nsIMsgCompType.Draft,
            Ci.nsIMsgCompFormat.Default,native.gCurrentIdentity,null,main.msgWindow);
        }catch(error){Services.ww.unregisterNotification(opened);win.clearTimeout(timer);reject(error);}
      });
      await new Promise((resolve,reject)=>{
        let listener=null,compose=null;
        const cleanup=()=>{win.clearTimeout(timer);newWindow.removeEventListener('compose-window-init',init,true);if(listener)compose.UnregisterStateListener(listener);};
        const timer=win.setTimeout(()=>{cleanup();reject(new Error('The new window did not finish loading; the saved reply remains here.'));},30000);
        function init(){
          compose=newWindow.gMsgCompose;
          listener={NotifyComposeFieldsReady(){},ComposeProcessDone(){},SaveInFolderDone(){},NotifyComposeBodyReady(){
            newWindow.gMsgCompose.compFields.subject=subject;
            newWindow.document.getElementById('msgSubject').value=subject;
            newWindow.SetComposeWindowTitle();cleanup();resolve();}};
          compose.RegisterStateListener(listener);
        }
        newWindow.addEventListener('compose-window-init',init,true);
      });
      // Release the old editor only after the native draft has loaded in its successor.
      dispose();newWindow.focus();
    }catch(error){title.textContent=error.message || 'Could not detach; your reply remains open.';}
    finally{transferBusy=false;if(windowButton)windowButton.disabled=!ready;if(floatButton)floatButton.disabled=false;}
  }
  function labelControl(control,kind,label,description=label){
    const paths={
      detach:'M3 5h18v14H3z M3 9h18 M13 12h6v5h-6z',
      inline:'M3 5h18v14H3z M3 9h18 M6 12h6 M6 15h10',
      window:'M8 3h13v13 M3 8h13v13H3z',
      save:'M4 3h14l3 3v15H3V3z M7 3v6h10V3 M7 21v-8h10v8',
      close:'M6 6l12 12 M18 6L6 18',minimize:'M5 17h14',maximize:'M5 9V5h4 M15 5h4v4 M19 15v4h-4 M9 19H5v-4'
    };
    control.textContent='';
    const svg=doc.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('width','18');svg.setAttribute('height','18');svg.setAttribute('aria-hidden','true');
    const path=doc.createElementNS('http://www.w3.org/2000/svg','path');
    path.setAttribute('d',paths[kind]);path.setAttribute('fill','none');path.setAttribute('stroke','currentColor');path.setAttribute('stroke-width','1.6');path.setAttribute('stroke-linejoin','round');svg.append(path);
    const text=doc.createElement('span');text.textContent=label;control.append(svg,text);
    control.title=description;control.setAttribute('aria-label',description);
    text.style.display='none';
    control.style.cssText='display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;border:0;border-radius:4px;background:transparent;color:inherit;padding:5px;cursor:pointer;';
  }
  function button(label,handler){const node=doc.createElement('button');node.type='button';node.textContent=label;node.addEventListener('click',handler);return node;}
  return {
    open(header,command,placement={}){
      if(browser){
        // Never replace another unsent message when navigating or pressing Reply again.
        panel.hidden=false;browser.focus();return;
      }
      const onSendState=state=>{
        if(!sendNotice){
          sendNotice=doc.createElement('div');sendNotice.className='gm-send-notice';sendNotice.setAttribute('role','status');sendNotice.setAttribute('aria-live','polite');
          sendNotice.style.cssText='position:fixed;z-index:10000;bottom:24px;left:24px;max-width:min(440px,calc(100vw - 48px));box-sizing:border-box;padding:8px 10px;border-radius:4px;background:#202124;color:#fff;font:12px/1.35 sans-serif;display:flex;align-items:flex-start;gap:12px;box-shadow:0 4px 16px #0004;';
          doc.documentElement.append(sendNotice);
        }
        if(noticeTimer!==null)win.clearTimeout(noticeTimer);noticeTimer=null;sendNotice.hidden=false;sendNotice.style.display='flex';
        const labels={sending:'Sending…',sent:'Sent', 'saving-draft':'Sending failed. Saving draft…','draft-saved':'Not sent. Saved to Drafts.','draft-error':'Not sent. Draft could not be saved. Your reply is still open.'};
        const message=doc.createElement('span');message.textContent=labels[state.state];
        if(state.error && !['sending','sent'].includes(state.state))message.textContent+=` ${state.error}`;
        if(state.state==='draft-error' && state.draftError)message.textContent+=` Draft: ${state.draftError}`;
        const dismiss=button('×',hideSendNotice);dismiss.setAttribute('aria-label','Dismiss notification');dismiss.title='Dismiss';
        dismiss.style.cssText='flex:none;border:0;padding:0 2px;background:transparent;color:#fff;font:18px/1 sans-serif;cursor:pointer;';
        sendNotice.replaceChildren(message,dismiss);
        // display:none destroys the embedded editor. Thunderbird serializes
        // that editor AFTER compose-send-message, so keep its layout alive.
        if(panel){panel.hidden=false;panel.style.opacity=state.state==='sending'?'.65':'';}
        try{placement.onSendState?.(state)}catch(error){console.error('Thunder-G: could not update send feedback.',error)}
        positionSendNotice();
        if(['sent','draft-saved','draft-error'].includes(state.state))noticeTimer=win.setTimeout(()=>{noticeTimer=null;hideSendNotice();},state.state==='sent'?6000:12000);
      };
      const isNew=command==='cmd_newMessage';
      const params=isNew?inlineNewMessageParams(placement.folder):inlineReplyParams(header,command);originalHeader=header;originalCommand=command;
      inlineContainer=placement.container || doc.documentElement;scrollHost=placement.scrollHost || null;
      scrim=doc.createElement('div');scrim.className='gm-compose-scrim';scrim.hidden=true;scrim.style.cssText='position:fixed;inset:0;background:#0005;z-index:999;';doc.documentElement.append(scrim);
      panel=doc.createElement('section');panel.className='gm-inline-compose';panel.setAttribute('aria-label',isNew?'New message in this window':'Reply in this window');
      bar=doc.createElement('div');bar.style.cssText='display:flex;align-items:center;gap:2px;padding:6px 12px;min-height:40px;box-sizing:border-box;flex:none;background:light-dark(#f2f6fc,#292a2d);color:light-dark(#16345c,#e8eaed);';
      title=doc.createElement('strong');title.style.cssText='flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.9em;font-weight:500;';
      title.textContent=isNew?'New Message':`${command==='cmd_forwardInline'?'Forward':command==='cmd_replyall'?'Reply all':'Reply'} · ${header.mime2DecodedSubject || '(No subject)'}`;
      const titleGroup=doc.createElement('div');titleGroup.style.cssText='display:flex;align-items:center;gap:10px;flex:1;min-width:100px;overflow:hidden;';
      const savedStatus=doc.createElement('span');savedStatus.className='gm-compose-draft-status';savedStatus.setAttribute('role','status');savedStatus.setAttribute('aria-live','polite');savedStatus.style.cssText='flex:none;font-size:12px;white-space:nowrap;';
      titleGroup.append(title,savedStatus);
      const save=button('',()=>browser?.contentWindow.goDoCommand('cmd_saveAsDraft'));save.disabled=true;labelControl(save,'save','Save draft');
      floatButton=button('',()=>{if(presentation!=='floating')float();else returnInline();});
      windowButton=button('',separateWindow);labelControl(windowButton,'window','Separate window',isNew?'Open message in a separate window':'Open reply in a separate window');windowButton.disabled=true;
      const close=button('',saveAndClose);labelControl(close,'close','Close',isNew?'Close message':'Close reply');
      minimizeButton=button('',minimize);labelControl(minimizeButton,'minimize','Minimize');
      bar.append(titleGroup,save,floatButton,windowButton,close,minimizeButton);
      minimizeButton.style.order='-1';titleGroup.style.order='-2';close.style.order='2';panel.append(bar);floatingResize=installFloatingComposeResize(win,panel);setPresentation(placement.container?'inline':'floating');
      browser=doc.createXULElement('browser');browser.setAttribute('type','content');browser.setAttribute('maychangeremoteness','false');browser.setAttribute('disablehistory','true');browser.setAttribute('flex','1');browser.style.cssText='display:block;flex:1 1 0;min-height:0;min-width:0;width:100%;height:0;border:0;background:light-dark(#ffffff,#18181b);';
      const frame=browser;
      observer={observe(subject){
        if(subject.browsingContext!==frame.browsingContext)return;
        subject.arguments=[params];
        composeContentBridge?.close();composeContentBridge=installEmbeddedComposeContent(subject);
        bodyReadyWatcher?.close();bodyReadyWatcher=watchInlineComposeBodyReady(subject);
        subject.close=()=>{if(browser===frame)dispose();};
      }};
      Services.obs.addObserver(observer,'chrome-document-global-created');
      frame.addEventListener('load',event=>{
        if(browser!==frame || event.target!==frame.contentDocument || !frame.contentDocument.documentURI.includes('messengercompose.xhtml'))return;
        const native=frame.contentWindow;stopObserver();
        attachmentPicker=installEmbeddedAttachmentPicker(native,main);
        // Restore the application's browser chrome after compose's native startup hook.
        restoreChrome?.();restoreChrome=null;
        const style=frame.contentDocument.createElement('style');style.textContent=`
          #compose-toolbar-menubar2,#titlebar,#status-bar{display:none!important}
          html,body{box-sizing:border-box!important;min-width:0!important;min-height:0!important;width:100%!important;height:100%!important;margin:0!important;overflow:hidden!important;background:light-dark(#ffffff,#18181b)!important}
          body{display:flex!important;flex-direction:column!important}
          #compose-toolbox{order:3!important;flex:none!important;border-top:1px solid var(--layout-border-0,#dadce0)}
          #composeContentBox{order:1!important;flex:1 1 0!important;min-height:0!important;overflow:hidden!important}
          #appcontent,#messageArea,#content-frame{min-height:0!important}
          #compose-toolbox,#composeToolbar2{background:light-dark(#ffffff,#18181b)!important;background-image:none!important;opacity:1!important;backdrop-filter:none!important}
          /* macOS native titlebar overlap must not follow the toolbar into the footer. */
          #composeToolbar2{margin:0!important;padding:6px!important;overflow:visible!important}
          #compose-toolbox::before,#compose-toolbox::after{display:none!important}
          #button-attach .toolbarbutton-icon{rotate:90deg!important}
          #composeToolbar2 .toolbarbutton-text{display:none!important}
          #button-send .toolbarbutton-text{display:initial!important}
          #button-send{border-radius:20px!important;background:#0b57d0!important;color:white!important;padding:6px 18px!important}
          #composeContentBox{box-shadow:none!important;grid-template-areas:"contacts contacts-splitter headers" "contacts contacts-splitter headers-splitter" "contacts contacts-splitter message" "contacts contacts-splitter attachment-splitter" "contacts contacts-splitter attachment-area" "contacts contacts-splitter format-toolbar"!important;grid-template-rows:min-content min-content minmax(0,1fr) min-content min-content min-content!important}
          #headersSplitter{visibility:hidden!important;height:0!important}
          #MsgHeadersToolbar{background:light-dark(#fff,#18181b)!important;padding:4px 16px!important}
          #top-gradient-box,.address-row,#subject-box{min-height:34px!important;align-items:center!important}
          .aw-firstColBox{width:0!important;min-width:0!important}
          #identityLabel-box,.address-label-container{width:36px!important;min-width:36px!important;max-width:36px!important;margin:0!important;padding:0!important;justify-content:flex-start!important}
          #MsgHeadersToolbar .input-container{border:0!important;outline:0!important;box-shadow:none!important}
          #MsgHeadersToolbar .address-input{border:0!important;outline:0!important;box-shadow:none!important}
          #recipientsContainer .address-row:focus-within{border-bottom-color:#1a73e8!important}
          #identityLabel,.address-label-container label{margin:0!important;font-size:13px!important}
          #msgIdentity{max-width:calc(100% - 60px)!important;flex:1!important;background:transparent!important;border:0!important;box-shadow:none!important}
          .address-container,#msgSubjectContainer{background:transparent!important;border:0!important;border-radius:0!important;box-shadow:none!important}
          #recipientsContainer .address-row,#subject-box{border-bottom:1px solid light-dark(#e8eaed,#3c4043)!important}
          #subjectLabel-box{display:none!important}
          #msgSubject{padding:8px 0!important;border:0!important;background:transparent!important;box-shadow:none!important;font-size:14px!important}
          #FormatToolbox{background:transparent!important;border:0!important;padding:4px 16px!important}
          #FormatToolbar{background:light-dark(#f2f6fc,#303134)!important;border:0!important;border-radius:20px!important;padding:4px 8px!important;margin:0!important;min-height:32px!important}
          #composeToolbar2{display:flex!important;align-items:center!important;gap:2px!important;padding:8px 16px!important;min-height:48px!important}
          #composeToolbar2 > *{flex:0 0 auto!important}
          #composeToolbar2 > :is(spacer,toolbarspring){flex:1 1 auto!important;order:90!important}
          #composeToolbar2 > :is(toolbarseparator,#button-save,#button-contacts,#button-address){display:none!important}
          #button-send{order:0!important;min-height:36px!important;padding:6px 16px!important;margin-inline-end:8px!important}
          #button-attach{order:1!important}
          #composeToolbar2 > :not(#button-send):not(#button-attach){order:2}
          #composeToolbar2 > #gm-discard-draft{order:99!important;margin-inline-start:auto!important;display:inline-flex!important;align-items:center;justify-content:center;width:30px;height:30px;border:0;border-radius:4px;background:transparent;color:light-dark(#5f6368,#bdc1c6);cursor:pointer}
          #addressRowReply[data-gm-redundant]{display:none!important}
          #extraAddressRowsArea{flex:0 0 auto!important;margin-inline-start:auto!important}
          #gm-discard-draft:hover{background:light-dark(#e8eaed,#3c4043)!important}
          #MsgHeadersToolbar{border:0!important;padding:4px 8px!important}
        `;frame.contentDocument.documentElement.append(style);
        const subjectInput=frame.contentDocument.getElementById('msgSubject');if(subjectInput)subjectInput.placeholder='Subject';
        const extra=frame.contentDocument.getElementById('extraAddressRowsArea'),toRow=frame.contentDocument.getElementById('addressRowTo');
        if(extra && toRow)toRow.append(extra);
        const footer=frame.contentDocument.getElementById('composeToolbar2');
        if(footer){
          const trash=frame.contentDocument.createElement('button');trash.id='gm-discard-draft';trash.type='button';trash.title='Discard draft';trash.setAttribute('aria-label','Discard draft');
          const icon=frame.contentDocument.createElementNS('http://www.w3.org/2000/svg','svg');icon.setAttribute('viewBox','0 0 24 24');icon.setAttribute('width','18');icon.setAttribute('height','18');icon.setAttribute('aria-hidden','true');
          const path=frame.contentDocument.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d','M4 7h16 M9 7V4h6v3 M6 7l1 14h10l1-14 M10 10v8 M14 10v8');path.setAttribute('fill','none');path.setAttribute('stroke','currentColor');path.setAttribute('stroke-width','1.6');icon.append(path);trash.append(icon);trash.addEventListener('click',discard);footer.append(trash);
        }
        const started=Date.now();
        const check=()=>{
          if(browser!==frame)return;
          if(bodyReadyWatcher?.ready && native.gMsgCompose && native.GetCurrentEditor?.()) {
            bodyReadyWatcher.close();bodyReadyWatcher=null;
            bodySheet=styleInlineComposeBody(native);
            const replyTo=native.gMsgCompose.compFields.replyTo || '',identity=native.gCurrentIdentity?.email;
            const replyRow=frame.contentDocument.getElementById('addressRowReply');
            if(replyRow && identity){
              try{const addresses=MailServices.headerParser.parseDecodedHeader(replyTo);replyRow.toggleAttribute('data-gm-redundant',addresses.length>0 && addresses.every(item=>item.email?.toLowerCase()===identity.toLowerCase()));}catch(_){}
            }
            ready=true;save.disabled=false;windowButton.disabled=false;draftStatus=installComposeDraftStatus(native,savedStatus,win,Ci.nsIMsgCompDeliverMode,state=>{if(state==='saved')sendStatus?.draftSaved()});sendStatus=installInlineSendStatus(native,win,onSendState);if(loadingTimer!==null)win.clearTimeout(loadingTimer);loadingTimer=null;native.SetMsgBodyFrameFocus?.();return;}
          if(Date.now()-started>20000){
            title.textContent='Editor could not finish starting. Close and use a classic reply.';restoreChrome?.();restoreChrome=null;return;
          }
          loadingTimer=win.setTimeout(check,100);
        };check();
      },true);
      const chrome=main.docShell.treeOwner.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIAppWindow);
      const previous=chrome.XULBrowserWindow;restoreChrome=()=>{chrome.XULBrowserWindow=previous;};
      panel.append(frame);inlineContainer.append(panel);
      if(placement.container)panel.scrollIntoView?.({block:'nearest',behavior:'instant'});
      frame.loadURI(Services.io.newURI('chrome://messenger/content/messengercompose/messengercompose.xhtml'),{triggeringPrincipal:Services.scriptSecurityManager.getSystemPrincipal()});
    },
    float,returnInline,separateWindow,minimize,discard,
    get presentation(){return presentation;},
    close(){
      if(!requestClose())return false;
      detach();return true;
    },
    get active(){return !!browser;},get target(){return originalHeader;},get command(){return originalCommand;}
  };
}
