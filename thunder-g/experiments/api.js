var { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
var verifyIndependentDkim = null,openIndependentDkimPopup=null;
var independentBimiEnabled=false,independentBimiListeners=new Set();
var { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { ExtensionSupport } = ChromeUtils.importESModule("resource:///modules/ExtensionSupport.sys.mjs");
var { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");

function mailPaneReady(doc) {
  const win = doc.defaultView;
  return doc.readyState === 'complete' && !!win?.threadPane &&
    ['paneLayout','threadTree','folderTree'].every(id => doc.getElementById(id));
}
function waitForMailPane(doc, onReady, onClose = () => {}) {
  const win = doc.defaultView;
  let timer = null, stopped = false, attempts = 0;
  function close() {
    if (stopped) return;
    stopped = true;
    if (timer !== null) win.clearTimeout(timer);
    win.removeEventListener('unload',close);
    onClose();
  }
  function check() {
    timer = null;
    if (stopped || win.closed) { close(); return; }
    if (mailPaneReady(doc)) { close(); onReady(); return; }
    if (++attempts < 100) timer = win.setTimeout(check,100);
    else { close(); console.warn('Thunder-G: mail pane is not ready; waiting for a later load event.'); }
  }
  win.addEventListener('unload',close,{once:true});
  timer = win.setTimeout(check,0);
  return {close};
}

// New synthetic search tabs do not reliably bubble their document load through
// the main window. Watch each chrome browser as well as native tab lifecycle.
function watchMailTabs(win,scan) {
  const tabmail=win.document.getElementById('tabmail'),browsers=new Map();
  if(!tabmail?.registerTabMonitor)return {close(){}};
  function watch(tab){
    const browser=tab?.chromeBrowser || tab?.browser;if(!browser)return;
    if(!browsers.has(browser)){
      const load=event=>{if(event.target?.nodeType===9)scan(event.target);};
      browser.addEventListener('load',load,true);browsers.set(browser,load);
    }
    try{if(browser.contentDocument)scan(browser.contentDocument);}catch(error){console.error('Thunder-G: could not inspect mail tab.',error);}
  }
  function forget(tab){const browser=tab?.chromeBrowser || tab?.browser,load=browsers.get(browser);if(load){browser.removeEventListener('load',load,true);browsers.delete(browser);}}
  const monitor={onTabOpened:watch,onTabRestored:watch,onTabSwitched:watch,onTabClosing:forget,onTabTitleChanged(){},onTabPersist(){return null}};
  tabmail.registerTabMonitor(monitor);for(const tab of tabmail.tabInfo || [])watch(tab);
  return {close(){tabmail.unregisterTabMonitor(monitor);for(const [browser,load]of browsers)browser.removeEventListener('load',load,true);browsers.clear();}};
}

var inlineLabels = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    const dkimRequests = new Map();let dkimSequence=0,dkimFire=null;
    verifyIndependentDkim = (header,details=false,popupContext=0) => new Promise((resolve,reject) => {
      const provider=ExtensionParent.GlobalManager.extensionMap.get('dkim_verifier@pl');
      if(!provider || !dkimFire){reject(new Error('DKIM Verifier integration unavailable'));return;}
      const message=typeof header==='string'?{id:0}:provider.messageManager.convert(header),request=++dkimSequence;
      const timer=setTimeout(()=>{dkimRequests.delete(request);reject(new Error('DKIM verification timed out'));},60000);
      dkimRequests.set(request,{resolve,reject,timer});
      dkimFire.async(request,message.id,typeof header==='string'?header:'',typeof header==='string'?Services.eTLD.getBaseDomainFromHost(header):'',details,popupContext).catch(()=>{clearTimeout(timer);dkimRequests.delete(request);reject(new Error('DKIM bridge unavailable'));});
    });
    const dkimPopups=new Set();
    openIndependentDkimPopup=async(header,button)=>{
      for(const close of [...dkimPopups])close();
      const result=await verifyIndependentDkim(header,true);
      const provider=ExtensionParent.GlobalManager.extensionMap.get('dkim_verifier@pl');
      if(!provider || !Number.isInteger(result.contextId) || result.contextId>=-1000)throw new Error('DKIM popup integration unavailable');
      if(!button.isConnected){await verifyIndependentDkim(header,false,result.contextId);return;}
      const {ViewPopup}=ChromeUtils.importESModule('resource:///modules/ExtensionPopups.sys.mjs');
      const url=provider.baseURI.resolve('content/displayAction.html')+'?thunderGContext='+result.contextId;
      const popup=new ViewPopup(provider,button.ownerDocument.defaultView.browsingContext.topChromeWindow,url,false,false,false);
      let disposed=false;
      const close=()=>{
        if(disposed)return;disposed=true;dkimPopups.delete(close);
        popup.viewNode.removeEventListener('popuphidden',close);
        verifyIndependentDkim?.(header,false,result.contextId).catch(()=>{});
        popup.destroy();
      };
      dkimPopups.add(close);popup.viewNode.addEventListener('popuphidden',close);
      try {await popup.browserLoaded;await popup.contentReadyAndResized.promise;if(!disposed && button.isConnected)popup.viewNode.openPopup(button,'bottomleft topleft',0,0);else close();}
      catch(error){close();throw error;}
    };
    let gmailImporter = null;
    const documents = new Map();
    const pendingDocuments = new Map();
    const windows = new Map(),tabWatchers=new Map();
    const conversationDocuments = new Map();
    const id = context.extension.id;
    const skinWindows = new Map();
    let hideTodayPane = false, showColumnHeaders = false;
    let messagesPerPage = 0, independentReader = false, threadGuides = true;
    const readers = new Map();
    const pagedDocuments = new Map(), zoomWindows = new Map();
    const fontSize = ChromeUtils.importESModule("resource:///modules/UIFontSize.sys.mjs").UIFontSize;
    const todayWindows = new Set();
    const todayURI = 'data:text/css;charset=utf-8,' + encodeURIComponent(
      '#today-pane-panel, #today-splitter, #calendar-show-todaypane-panel { display:none !important; }');
    function applyTodayPane(win) {
      if (hideTodayPane && !todayWindows.has(win)) {
        win.windowUtils.loadSheetUsingURIString(todayURI, Ci.nsIDOMWindowUtils.USER_SHEET);
        todayWindows.add(win);
      } else if (!hideTodayPane) removeTodayPaneStyle(win);
    }
    function removeTodayPaneStyle(win) {
      if (!todayWindows.delete(win)) return;
      try { win.windowUtils.removeSheetUsingURIString(todayURI, Ci.nsIDOMWindowUtils.USER_SHEET); }
      catch (_) { /* Closed windows already discarded the sheet. */ }
    }
    const skinURI = 'data:text/css;charset=utf-8,' + encodeURIComponent(GMAIL_SKIN_CSS);
    function loadSkin(win, cssURI = skinURI) {
      if (skinWindows.has(win)) return;
      win.windowUtils.loadSheetUsingURIString(cssURI, Ci.nsIDOMWindowUtils.USER_SHEET);
      skinWindows.set(win, cssURI);
    }
    function unloadSkin(win) {
      win.document?.documentElement?.removeAttribute("data-gm-hide-column-headers");
      const cssURI = skinWindows.get(win);
      if (!skinWindows.delete(win)) return;
      try { win.windowUtils.removeSheetUsingURIString(cssURI, Ci.nsIDOMWindowUtils.USER_SHEET); }
      catch (_) { /* A destroyed window already discarded its sheets. */ }
    }
    let composeAutosave = true, composeAutosaveMinutes = 1, autosaveController = null;
    let started = false;
    let closed = false;
    const attach = doc => {
      if (!closed && doc?.documentURI === 'chrome://conversations/content/experiment-api/stub.html') {
        loadSkin(doc.defaultView, 'data:text/css;charset=utf-8,' + encodeURIComponent(GMAIL_CONVERSATIONS_CSS));
        if (!conversationDocuments.has(doc)) conversationDocuments.set(doc, installConversationStyle(doc.defaultView, GMAIL_CONVERSATIONS_CSS, messageId => {
          // IDs belong to Conversations, not to this extension's message manager.
          const extension = ExtensionParent.GlobalManager.extensionMap.get("gconversation@xulforum.org");
          const header = extension?.messageManager?.get(messageId);
          if (!header) return null;
          return assignedTags(header, MailServices.tags.getAllTags()).map(tag =>
            ({key:tag.key,name:tag.tag,color:tag.color}));
        }));
        return;
      }
      if (closed || !doc || doc.documentURI !== "about:3pane" || documents.has(doc)) return;
      if (!mailPaneReady(doc)) {
        if (!pendingDocuments.has(doc)) pendingDocuments.set(doc,waitForMailPane(doc,() => {
          pendingDocuments.delete(doc);
          attach(doc);
        }, () => pendingDocuments.delete(doc)));
        return;
      }
      pendingDocuments.get(doc)?.close(); pendingDocuments.delete(doc);
      loadSkin(doc.defaultView);
      doc.documentElement.toggleAttribute("data-gm-hide-column-headers", !showColumnHeaders);
      const labels = installInlineLabels(doc.defaultView, MailServices, Services.prefs);
      const nestedLabels = installNestedLabelSidebar(doc.defaultView);
      const reader = installReadingMode(doc.defaultView);
      readers.set(doc,reader); reader.setIndependent(independentReader);
      const pages = installNativePagination(doc.defaultView,reader);
      pagedDocuments.set(doc,pages); pages.setSize(messagesPerPage);
      const zoom = installMailZoom(doc.defaultView,fontSize,action=>reader.zoom(action));
      const dates = installCompactDates(doc.defaultView);
      const inbox = installInboxControls(doc.defaultView,{threadGuides,reader});
      const conversationBrowser = watchConversationBrowser(doc.defaultView, attach);
      documents.set(doc, { setThreadGuides(enabled){inbox.setThreadGuides(enabled);}, refresh() { labels.refresh(); dates.refresh(); }, close() {
        readers.delete(doc);
        pages.close(); pagedDocuments.delete(doc); zoom.close();
        nestedLabels.close(); conversationBrowser.close(); inbox.close(); dates.close(); reader.close(); labels.close();
      }});
    };
    const scan = doc => {
      attach(doc);
      for (const browser of doc.querySelectorAll("browser")) {
        try { if (browser.contentDocument) scan(browser.contentDocument); }
        catch (error) { console.error("Inline labels document attachment:", error); }
      }
    };
    const loadWindow = win => {
      if (closed || win.closed) return;
      if (windows.has(win)) { scan(win.document); return; }
      loadSkin(win);
      if (!zoomWindows.has(win)) zoomWindows.set(win,installMailZoom(win,fontSize,action=>{
        const tabmail=win.document.getElementById('tabmail');
        if(!tabmail)return zoomNativeMessage(win,
          win.document.getElementById('messageBrowser')?.contentWindow?.getMessagePaneBrowser?.(),action);
        const pane=tabmail.currentAbout3Pane;
        return readers.get(pane?.document)?.zoom(action) || false;
      }));
      // Today Pane visibility belongs to the user. Do not persist calendar UI
      // changes when a skin attaches, restarts, or is disabled.
      const listener = event => { if (event.target?.nodeType === 9) attach(event.target); };
      win.addEventListener("load", listener, true);
      const activate = () => {
        if (closed || win.closed) return;
        scan(win.document);
        if (!tabWatchers.has(win)) tabWatchers.set(win,watchMailTabs(win,scan));
      };
      win.addEventListener("activate", activate);
      windows.set(win, {listener, activate});
      applyTodayPane(win);
      scan(win.document);
      if(!tabWatchers.has(win))tabWatchers.set(win,watchMailTabs(win,scan));
    };
    const refresh = () => {
      for (const [doc, controller] of documents) {
        if (doc.defaultView?.closed) { controller.close(); documents.delete(doc); }
        else controller.refresh();
      }
    };
    const observer = { observe: refresh };
    const tagChanges = {
      msgPropertyChanged(header, property) {
        if (closed || !["keywords", "label"].includes(property)) return;
        for (const controller of conversationDocuments.values()) controller.refresh();
      }
    };
    context.callOnClose({ close() {
      gmailImporter?.close(); gmailImporter=null;
      for(const close of [...dkimPopups])close();openIndependentDkimPopup=null;
      verifyIndependentDkim=null;
      for(const pending of dkimRequests.values()){clearTimeout(pending.timer);pending.reject(new Error('Reader closed'));}dkimRequests.clear();
      closed = true;
      try { autosaveController?.close(); } catch (_) { console.warn('Thunder-G: could not restore draft autosave settings.'); }
      if (!started) return;
      ExtensionSupport.unregisterWindowListener(id);
      Services.prefs.removeObserver("mailnews.tags.", observer);
      Services.prefs.removeObserver(HIDDEN_MESSAGE_LABELS_PREF, observer);
      MailServices.mfn.removeListener(tagChanges);
      for (const [win, handlers] of windows) {
        win.removeEventListener("load", handlers.listener, true);
        win.removeEventListener("activate", handlers.activate);
      }
      for (const controller of pendingDocuments.values()) controller.close();
      pendingDocuments.clear();
      for (const controller of documents.values()) controller.close();
      for (const controller of conversationDocuments.values()) controller.close();
      conversationDocuments.clear();
      for (const zoom of zoomWindows.values()) zoom.close(); zoomWindows.clear();
      for (const win of skinWindows.keys()) unloadSkin(win);
      for (const win of todayWindows) removeTodayPaneStyle(win);
      for(const watcher of tabWatchers.values())watcher.close();tabWatchers.clear();
      documents.clear(); windows.clear();
    }});
    return { inlineLabels: {
      async gmailLabelImport(action, data) {
        try {
          if (closed) throw new Error('Extension has closed.');
          let payload;
          try { payload=JSON.parse(data || '{}'); } catch (_) { throw new Error('Invalid importer request.'); }
          if (!payload || typeof payload!=='object' || Array.isArray(payload)) throw new Error('Invalid importer request.');
          gmailImporter ||= createNativeGmailImporter(MailServices.tags);
          return JSON.stringify({ok:true,result:await gmailImporter.run(action,payload)});
        } catch (error) {
          // Privileged exceptions otherwise become an unhelpful generic error at
          // the extension boundary. Return only the controlled user-facing text.
          return JSON.stringify({ok:false,error:error.message || 'The Gmail import operation failed.'});
        }
      },
      async setShowColumnHeaders(enabled) {
        showColumnHeaders = enabled === true;
        for (const doc of documents.keys()) doc.documentElement.toggleAttribute('data-gm-hide-column-headers', !showColumnHeaders);
      },
      async setThreadGuides(enabled){threadGuides=enabled===true;for(const controller of documents.values())controller.setThreadGuides(threadGuides);},
      async setInlineReplyEnabled(enabled){inlineReplyEnabled=enabled===true;},
      async setInlineNewMessageEnabled(enabled){inlineNewMessageEnabled=enabled===true;},
      async setBimiEnabled(enabled){independentBimiEnabled=enabled===true;for(const refresh of independentBimiListeners)refresh();},
      onDkimRequest: new ExtensionCommon.EventManager({context,name:'inlineLabels.onDkimRequest',register(fire){dkimFire=fire;return()=>{dkimFire=null;};}}).api(),
      async resolveDkim(request,payload) {
        const pending=dkimRequests.get(request);if(!pending)return;
        clearTimeout(pending.timer);dkimRequests.delete(request);
        try {const value=JSON.parse(payload);if(value.error)pending.reject(new Error(value.error));else pending.resolve(value);}catch(error){pending.reject(error);}
      },
      async setIndependentReader(enabled) {
        independentReader = enabled === true;
        for (const reader of readers.values()) reader.setIndependent(independentReader);
      },
      async setMessagesPerPage(value) {
        messagesPerPage = [25,50,100].includes(value) ? value : 0;
        for (const pages of pagedDocuments.values()) pages.setSize(messagesPerPage);
      },
      async setComposeAutosave(enabled, minutes) {
        composeAutosave = enabled === true;
        composeAutosaveMinutes = Number.isInteger(minutes) && minutes >= 1 && minutes <= 30 ? minutes : 1;
        autosaveController?.set(composeAutosave,composeAutosaveMinutes);
      },
      async setHideTodayPane(hidden) {
        if (closed) return;
        hideTodayPane = hidden;
        for (const win of windows.keys()) applyTodayPane(win);
      },
      async start() {
      if (started) return;
      try {
        autosaveController = createComposeAutosave(Services.prefs);
        autosaveController.set(composeAutosave,composeAutosaveMinutes);
      } catch (_) { console.warn('Thunder-G: could not configure draft autosave settings.'); }
      started = true;
      Services.prefs.addObserver("mailnews.tags.", observer);
      Services.prefs.addObserver(HIDDEN_MESSAGE_LABELS_PREF, observer);
      MailServices.mfn.addListener(tagChanges, Ci.nsIMsgFolderNotificationService.msgPropertyChanged);
      ExtensionSupport.registerWindowListener(id, {
        chromeURLs: ["chrome://messenger/content/messenger.xhtml"],
        onLoadWindow: loadWindow,
        onUnloadWindow(win) {
          tabWatchers.get(win)?.close();tabWatchers.delete(win);
          zoomWindows.get(win)?.close(); zoomWindows.delete(win);
          removeTodayPaneStyle(win);
          unloadSkin(win);
          const handlers = windows.get(win);
          if (handlers) {
            win.removeEventListener("load", handlers.listener, true);
            win.removeEventListener("activate", handlers.activate);
          }
          for (const [doc, pending] of pendingDocuments) {
            if (doc.defaultView?.top === win || doc.defaultView?.closed) pending.close();
          }
          windows.delete(win);
          for (const [doc, controller] of conversationDocuments) {
            if (doc.defaultView?.top === win || doc.defaultView?.closed) {
              controller.close(); unloadSkin(doc.defaultView); conversationDocuments.delete(doc);
            }
          }
          for (const [doc, controller] of documents) {
            if (doc.defaultView?.top === win || doc.defaultView?.closed) {
              controller.close(); unloadSkin(doc.defaultView); documents.delete(doc);
            }
          }
        }
      });
    }}};
  }
};
