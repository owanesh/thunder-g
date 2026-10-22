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
  const types={cmd_replySender:interfaces.nsIMsgCompType.ReplyToSender,cmd_replyall:interfaces.nsIMsgCompType.ReplyAll};
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
function installComposeDraftStatus(native,status,clock,modes=Ci.nsIMsgCompDeliverMode) {
  const compose=native.gMsgCompose;
  let closed=false,pending=false,started=0,timer=null,completion=null,state='';
  function show(next) {
    if(closed || state===next)return;
    state=next;status.dataset.state=next;
    status.textContent={saved:'✓ Saved',saving:'Saving…',dirty:'Unsaved changes',error:'Save failed',initial:'Not saved'}[next];
    status.title={saved:'Saved to Drafts',saving:'Saving to Drafts',dirty:'Changes have not been saved yet',error:'Could not save to Drafts. Use Save draft to retry.',initial:'Draft has not been saved yet'}[next];
    status.style.color=next==='saved'?'light-dark(#137333,#81c995)':next==='error'?'light-dark(#b3261e,#f2b8b5)':'light-dark(#5f6368,#bdc1c6)';
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
function createInlineCompose(win) {
  const doc=win.document;let browser=null,panel=null,originalHeader=null,originalCommand=null,ready=false,observer=null;
  let restoreChrome=null,loadingTimer=null,inlineContainer=null,scrollHost=null,presentation='inline',bar=null,title=null,floatButton=null,windowButton=null,transferBusy=false,attachmentPicker=null,draftStatus=null,floatingResize=null;
  const main=win.browsingContext.topChromeWindow;
  function stopObserver(){if(observer){Services.obs.removeObserver(observer,'chrome-document-global-created');observer=null;}}
  function dispose(){
    draftStatus?.close();draftStatus=null;floatingResize?.close();floatingResize=null;
    attachmentPicker?.close();attachmentPicker=null;
    stopObserver();if(loadingTimer!==null)win.clearTimeout(loadingTimer);loadingTimer=null;
    restoreChrome?.();restoreChrome=null;
    browser?.remove();panel?.remove();browser=panel=originalHeader=originalCommand=null;ready=false;
  }
  function requestClose(){
    if(!browser)return true;
    if(transferBusy)return false;
    const native=browser.contentWindow;
    if(!native.gMsgCompose){dispose();return true;}
    if(native.ComposeCanClose()){dispose();return true;}
    return false;
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
    sidebarResize?.disconnect();win.removeEventListener('resize',fitComposeToContent);
    main.removeEventListener('close',parentClose,true);
    if(mode?.tryCloseTab===tryCloseTab)mode.tryCloseTab=previousTryClose;
    win.removeEventListener('unload',unload);
  }
  function unload(){detach();dispose();}
  win.addEventListener('unload',unload,{once:true});
  function fitComposeToContent(){
    if(!panel)return;
    const sidebar=doc.getElementById('folderPane')?.getBoundingClientRect?.();
    const viewport=doc.documentElement.getBoundingClientRect?.();
    const rtl=doc.documentElement.dir==='rtl';
    const splitter=doc.getElementById('folderPaneSplitter')?.getBoundingClientRect?.();
    const edge=rtl?Math.min(sidebar?.left ?? 0,splitter?.left ?? sidebar?.left ?? 0):Math.max(sidebar?.right || 0,splitter?.right || 0);
    const boundary=sidebar?.width>0?Math.max(0,rtl?(viewport?.right || win.innerWidth)-edge:edge-(viewport?.left || 0)):0;
    if(presentation==='full'){
      panel.style.left=rtl?'0px':`${boundary}px`;
      panel.style.right=rtl?`${boundary}px`:'0px';
    }
    panel.style.maxWidth=`max(0px,calc(100vw - ${boundary+(presentation==='floating'?32:0)}px))`;
    floatingResize?.update(presentation==='floating',{maxWidth:(viewport?.width || win.innerWidth || 1024)-boundary-32,maxHeight:(viewport?.height || win.innerHeight || 768)-24});
  }
  const sidebarResize=win.ResizeObserver?new win.ResizeObserver(fitComposeToContent):null;
  const sidebar=doc.getElementById('folderPane');if(sidebar)sidebarResize?.observe(sidebar);
  win.addEventListener('resize',fitComposeToContent);
  function setPresentation(next){
    if(!panel)return;
    presentation=next;panel.setAttribute('data-presentation',next);
    const common='display:flex;flex-direction:column;min-height:320px;box-sizing:border-box;isolation:isolate;contain:paint;background:light-dark(#ffffff,#18181b);border:1px solid var(--layout-border-0,#dadce0);border-radius:12px;overflow:hidden;';
    panel.style.cssText=common+(next==='inline'?'position:relative;height:460px;margin:16px 0 20px 56px;box-shadow:none;':next==='full'?'position:fixed;z-index:1000;inset:0;width:auto;height:100%;min-height:0;border:0;border-radius:0;box-shadow:none;':'position:fixed;z-index:1000;inset:auto 16px 12px auto;width:min(720px,calc(100vw - 32px));height:min(620px,75vh);box-shadow:0 4px 22px #0003;');
    if(originalCommand==='cmd_newMessage') {
      labelControl(floatButton,next==='full'?'detach':'window',next==='full'?'Detach message':'Expand in this window');
      floatButton.hidden=false;
    }else{
      const label=next==='inline'?'Detach reply into a floating panel':'Return reply below the message';
      labelControl(floatButton,next==='inline'?'detach':'inline',next==='inline'?'Detach reply':'Return to conversation',label);
      floatButton.hidden=next!=='inline' && (!inlineContainer?.isConnected || scrollHost?.hidden);
    }
    windowButton.hidden=next==='inline';
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
      close:'M6 6l12 12 M18 6L6 18'
    };
    control.textContent='';
    const svg=doc.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('width','18');svg.setAttribute('height','18');svg.setAttribute('aria-hidden','true');
    const path=doc.createElementNS('http://www.w3.org/2000/svg','path');
    path.setAttribute('d',paths[kind]);path.setAttribute('fill','none');path.setAttribute('stroke','currentColor');path.setAttribute('stroke-width','1.6');path.setAttribute('stroke-linejoin','round');svg.append(path);
    const text=doc.createElement('span');text.textContent=label;control.append(svg,text);
    control.title=description;control.setAttribute('aria-label',description);
    control.style.cssText='display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--layout-border-0,#dadce0);border-radius:8px;background:transparent;color:inherit;min-height:32px;padding:4px 8px;font:inherit;font-size:12px;cursor:pointer;';
  }
  function button(label,handler){const node=doc.createElement('button');node.type='button';node.textContent=label;node.addEventListener('click',handler);return node;}
  return {
    open(header,command,placement={}){
      if(browser){
        // Never replace another unsent message when navigating or pressing Reply again.
        panel.hidden=false;browser.focus();return;
      }
      const isNew=command==='cmd_newMessage';
      const params=isNew?inlineNewMessageParams(placement.folder):inlineReplyParams(header,command);originalHeader=header;originalCommand=command;
      inlineContainer=placement.container || doc.documentElement;scrollHost=placement.scrollHost || null;
      panel=doc.createElement('section');panel.className='gm-inline-compose';panel.setAttribute('aria-label',isNew?'New message in this window':'Reply in this window');
      bar=doc.createElement('div');bar.style.cssText='display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:8px 12px;flex:none;';
      title=doc.createElement('strong');title.style.cssText='flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.9em;font-weight:500;';
      title.textContent=isNew?'New message':`${command==='cmd_replyall'?'Reply all':'Reply'} · ${header.mime2DecodedSubject || '(No subject)'}`;
      const titleGroup=doc.createElement('div');titleGroup.style.cssText='display:flex;align-items:center;gap:10px;flex:1;min-width:100px;overflow:hidden;';
      const savedStatus=doc.createElement('span');savedStatus.className='gm-compose-draft-status';savedStatus.setAttribute('role','status');savedStatus.setAttribute('aria-live','polite');savedStatus.style.cssText='flex:none;font-size:12px;white-space:nowrap;';
      titleGroup.append(title,savedStatus);
      const save=button('',()=>browser?.contentWindow.goDoCommand('cmd_saveAsDraft'));save.disabled=true;labelControl(save,'save','Save draft');
      floatButton=button('',()=>{if(presentation!=='floating')float();else returnInline();});
      windowButton=button('',separateWindow);labelControl(windowButton,'window','Separate window',isNew?'Open message in a separate window':'Open reply in a separate window');windowButton.disabled=true;
      const close=button('',requestClose);labelControl(close,'close','Close',isNew?'Close message':'Close reply');
      bar.append(titleGroup,save,floatButton,windowButton,close);panel.append(bar);floatingResize=installFloatingComposeResize(win,panel);setPresentation(placement.container?'inline':'floating');
      browser=doc.createXULElement('browser');browser.setAttribute('type','content');browser.setAttribute('maychangeremoteness','false');browser.setAttribute('disablehistory','true');browser.setAttribute('flex','1');browser.style.cssText='display:block;flex:1 1 0;min-height:0;min-width:0;width:100%;height:0;border:0;background:light-dark(#ffffff,#18181b);';
      const frame=browser;
      observer={observe(subject){
        if(subject.browsingContext!==frame.browsingContext)return;
        subject.arguments=[params];
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
          #msgIdentity{max-width:380px!important}
          #MsgHeadersToolbar{border:0!important;padding:4px 8px!important}
        `;frame.contentDocument.documentElement.append(style);
        const started=Date.now();
        const check=()=>{
          if(browser!==frame)return;
          if(native.gMsgCompose && native.GetCurrentEditor?.()) {ready=true;save.disabled=false;windowButton.disabled=false;draftStatus=installComposeDraftStatus(native,savedStatus,win);if(loadingTimer!==null)win.clearTimeout(loadingTimer);loadingTimer=null;native.SetMsgBodyFrameFocus?.();return;}
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
    float,returnInline,separateWindow,
    get presentation(){return presentation;},
    close(){
      if(!requestClose())return false;
      detach();return true;
    },
    get active(){return !!browser;},get target(){return originalHeader;},get command(){return originalCommand;}
  };
}
