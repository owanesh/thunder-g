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
function createInlineCompose(win) {
  const doc=win.document;let browser=null,panel=null,originalHeader=null,originalCommand=null,ready=false,observer=null;
  let restoreChrome=null,loadingTimer=null,inlineContainer=null,scrollHost=null,presentation='inline',bar=null,title=null,floatButton=null,windowButton=null,transferBusy=false;
  const main=win.browsingContext.topChromeWindow;
  function stopObserver(){if(observer){Services.obs.removeObserver(observer,'chrome-document-global-created');observer=null;}}
  function dispose(){
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
    main.removeEventListener('close',parentClose,true);
    if(mode?.tryCloseTab===tryCloseTab)mode.tryCloseTab=previousTryClose;
    win.removeEventListener('unload',unload);
  }
  function unload(){detach();dispose();}
  win.addEventListener('unload',unload,{once:true});
  function setPresentation(next){
    if(!panel)return;
    presentation=next;panel.setAttribute('data-presentation',next);
    const common='display:flex;flex-direction:column;min-height:320px;background:var(--layout-background-0,white);border:1px solid var(--layout-border-0,#dadce0);border-radius:12px;overflow:hidden;';
    panel.style.cssText=common+(next==='inline'?'position:relative;height:460px;margin:16px 0 20px 56px;box-shadow:none;':'position:fixed;z-index:1000;inset:auto 16px 12px auto;width:min(720px,calc(100vw - 32px));height:min(620px,75vh);box-shadow:0 4px 22px #0003;');
    const label=next==='inline'?'Detach reply into a floating panel':'Return reply below the message';
    labelControl(floatButton,next==='inline'?'detach':'inline',next==='inline'?'Detach reply':'Return to conversation',label);
    windowButton.hidden=next==='inline';
    floatButton.hidden=next!=='inline' && (!inlineContainer?.isConnected || scrollHost?.hidden);
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
      const params=inlineReplyParams(header,command);originalHeader=header;originalCommand=command;
      inlineContainer=placement.container || doc.documentElement;scrollHost=placement.scrollHost || null;
      panel=doc.createElement('section');panel.className='gm-inline-compose';panel.setAttribute('aria-label','Reply in this window');
      bar=doc.createElement('div');bar.style.cssText='display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:8px 12px;flex:none;';
      title=doc.createElement('strong');title.style.cssText='flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.9em;font-weight:500;';
      title.textContent=`${command==='cmd_replyall'?'Reply all':'Reply'} · ${header.mime2DecodedSubject || '(No subject)'}`;
      const save=button('',()=>browser?.contentWindow.goDoCommand('cmd_saveAsDraft'));save.disabled=true;labelControl(save,'save','Save draft');
      floatButton=button('',()=>{if(presentation==='inline')float();else returnInline();});
      windowButton=button('',separateWindow);labelControl(windowButton,'window','Separate window','Open reply in a separate window');windowButton.disabled=true;
      const close=button('',requestClose);labelControl(close,'close','Close','Close reply');
      bar.append(title,save,floatButton,windowButton,close);panel.append(bar);setPresentation(placement.container?'inline':'floating');
      browser=doc.createXULElement('browser');browser.setAttribute('type','content');browser.setAttribute('maychangeremoteness','false');browser.setAttribute('disablehistory','true');browser.setAttribute('flex','1');browser.style.cssText='flex:1;min-height:0;width:100%;';
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
        // Restore the application's browser chrome after compose's native startup hook.
        restoreChrome?.();restoreChrome=null;
        const style=frame.contentDocument.createElement('style');style.textContent=`
          #compose-toolbar-menubar2,#titlebar,#status-bar{display:none!important}
          html,body{min-width:0!important;min-height:0!important}
          body{display:flex!important;flex-direction:column!important}
          #compose-toolbox{order:3!important;flex:none!important;border-top:1px solid var(--layout-border-0,#dadce0)}
          #composeContentBox{order:1!important;flex:1!important;min-height:0!important}
          #composeToolbar2{padding:6px!important}
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
          if(native.gMsgCompose && native.GetCurrentEditor?.()) {ready=true;save.disabled=false;windowButton.disabled=false;if(loadingTimer!==null)win.clearTimeout(loadingTimer);loadingTimer=null;native.SetMsgBodyFrameFocus?.();return;}
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
