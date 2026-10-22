/* Independent conversation chrome; MIME, remote-content policy and attachments
 * remain in Thunderbird's about:message, never in privileged innerHTML. */
function independentMessageKey(message) {
  return JSON.stringify([message.folder?.URI,message.messageKey]);
}
function independentMessages(messages, anchor) {
  const physical=new Map();
  for(const message of [anchor,...messages]) {
    if(message?.folder?.URI && message.messageKey !== undefined) physical.set(independentMessageKey(message),message);
  }
  const logical=new Map();
  // Keep the selected physical copy if a message is also in Sent/All Mail.
  for(const message of [anchor,...physical.values()]) {
    const key=message.messageId || independentMessageKey(message);
    if(!logical.has(key)) logical.set(key,message);
  }
  return [...logical.values()].sort((a,b)=>(a.dateInSeconds || 0)-(b.dateInSeconds || 0));
}
function independentFolderThread(header) {
  const messages=[];
  try {
    const thread=header.folder.msgDatabase.getThreadContainingMsgHdr(header);
    for(let i=0;i<thread.numChildren;i++) messages.push(thread.getChildHdrAt(i));
  } catch (_) { /* An unindexed/deleted folder still allows the selected message. */ }
  return independentMessages(messages,header);
}
function independentReferenceIds(header) {
  const normalize=value=>String(value || '').trim().replace(/^<|>$/g,'');
  const ids=new Set();
  if(header.messageId)ids.add(normalize(header.messageId));
  for(let i=0;i<(header.numReferences || 0);i++) {
    const id=normalize(header.getStringReference(i));if(id)ids.add(id);
  }
  return [...ids];
}
function independentSentFolders() {
  try {
    const configured=new Set(Array.from(MailServices.accounts.allIdentities,identity=>identity.fccFolder));
    return Array.from(MailServices.accounts.allFolders).filter(folder=>!folder.isServer &&
      (folder.isSpecialFolder(Ci.nsMsgFolderFlags.SentMail,false) || configured.has(folder.URI)));
  }catch(_){return []}
}
async function independentSentCandidates(win,folders,cancelled) {
  const candidates=[];let visited=0;
  for(const folder of folders) {
    if(cancelled())break;
    try {
      // Local summary headers only: no message-body or server searches.
      for(const header of folder.messages) {
        if(cancelled())return candidates;
        candidates.push({header,ids:independentReferenceIds(header)});
        if(++visited%200===0)await new Promise(resolve=>win.setTimeout(resolve,0));
      }
    }catch(_){/* An unavailable summary must not prevent reading the conversation. */}
  }
  return candidates;
}
function independentRelatedSent(messages,candidates) {
  const byId=new Map(),seen=new Set(),result=[...messages];
  for(const candidate of candidates)for(const id of candidate.ids) {
    if(!byId.has(id))byId.set(id,[]);byId.get(id).push(candidate);
  }
  const pending=messages.flatMap(independentReferenceIds),visited=new Set();
  for(let i=0;i<pending.length;i++) {
    const id=pending[i];if(visited.has(id))continue;visited.add(id);
    for(const candidate of byId.get(id) || []) {
      if(seen.has(candidate))continue;seen.add(candidate);
      result.push(candidate.header);pending.push(...candidate.ids);
    }
  }
  return result;
}
function independentConversation(win, header, gloda, sentFolders=[]) {
  const fallback=independentFolderThread(header);
  let finish,timer,settled=false,localDone=sentFolders.length===0,indexDone=!gloda,indexed=false;
  let sent=[],indexedMessages=[];
  const collections=[];
  const promise=new Promise(resolve=>{
    finish=()=>{
      if(settled)return;
      settled=true;if(timer!==undefined)win.clearTimeout(timer);
      collections.length=0;
      const messages=independentRelatedSent([...fallback,...indexedMessages],sent);
      resolve({messages:independentMessages(messages,header),indexed});
    };
    const complete=()=>{if(localDone && indexDone)finish()};
    if(sentFolders.length)independentSentCandidates(win,sentFolders,()=>settled).then(result=>{
      sent=result;localDone=true;complete();
    },()=>{localDone=true;complete()});
    if(!gloda){complete();return}
    const finishIndex=(messages=[],available=false)=>{
      if(settled || indexDone)return;
      if(timer!==undefined)win.clearTimeout(timer);
      indexedMessages=messages;indexed=available;indexDone=true;complete();
    };
    timer=win.setTimeout(()=>finishIndex(),2500);
    const listener=completeQuery=>({onItemsAdded(){},onItemsModified(){},onItemsRemoved(){},
      onQueryCompleted(collection){if(!settled && !indexDone) {try{completeQuery(collection)}catch(_){finishIndex()}}}});
    try {
      collections.push(gloda.getMessageCollectionForHeader(header,listener(collection=>{
        const conversation=collection.items[0]?.conversation;
        if(!conversation) {finishIndex();return}
        collections.push(conversation.getMessagesCollection(listener(result=>{
          finishIndex(result.items.map(item=>item.folderMessage).filter(Boolean),true);
        })));
      })));
    }catch(_){finishIndex()}
  });
  return {promise,cancel(){finish()}};
}
// Measure the contents, not body.scrollHeight: the latter includes the current
// viewport and leaves an artificial blank area when a short message is loaded.
function independentContentHeight(content) {
  if(!content?.body)return null;
  const range=content.createRange();
  range.selectNodeContents(content.body);
  const bounds=range.getBoundingClientRect(),body=content.body.getBoundingClientRect();
  const css=content.defaultView.getComputedStyle(content.body);
  return Math.max(48,Math.ceil(bounds.bottom-body.top+
    (parseFloat(css.marginTop)||0)+(parseFloat(css.marginBottom)||0)+(parseFloat(css.paddingBottom)||0)));
}
function independentAvatar(address) {
  try { return MailServices.ab.cardForEmailAddress(address)?.photoURL || null; }
  catch (_) { return null; }
}
function independentTagKey(event) {
  const target=event.composedPath?.()[0] || event.target;
  if(event.defaultPrevented || event.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey ||
    target?.isContentEditable || target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]'))return null;
  return /^[0-9]$/.test(event.key || '')?Number(event.key):null;
}
function independentDkimStatus(header, live) {
  let data=live;
  if(!data)try {data=JSON.parse(header.getStringProperty('dkim_verifier@pl-result') || 'null')}catch(_){}
  const version=String(data?.version || '').split('.')[0];
  const result=version==='1'?data:['2','3'].includes(version)?data?.dkim?.[0]:null;
  const domain=result?.sdid || result?.SDID || '';
  if(result?.result==='SUCCESS') {
    const warning=Array.isArray(result.warnings) && result.warnings.length>0;
    return {tone:warning?'warning':'success',label:warning?'DKIM verified · warning':'DKIM verified',detail:domain};
  }
  if(result?.result==='PERMFAIL')return {tone:'failure',label:'DKIM failed',detail:result.errorType || ''};
  if(result?.result==='TEMPFAIL')return {tone:'warning',label:'DKIM temporary error',detail:result.errorType || ''};
  if(result?.result==='none' || result?.result==='NOSIG')return {tone:'warning',label:'DKIM unsigned',detail:''};
  return {tone:'warning',label:'DKIM not checked',detail:'No saved DKIM Verifier result is available for this message'};
}
function independentBimiDomain(address,result,baseDomain) {
  const from=address.split('@').at(-1)?.toLowerCase();
  if(!from || !result?.dkim?.some(signature=>signature.result==='SUCCESS' && signature.sdid && baseDomain(signature.sdid.toLowerCase())===baseDomain(from)))return null;
  return from;
}
function installIndependentReader(win) {
  const doc=win.document,layout=doc.getElementById('paneLayout');
  let closed=false,ticket=0,query=null,revealFrame=null;
  const host=doc.createElement('section');host.className='gm-independent-reader';host.hidden=true;
  host.setAttribute('aria-label','Thunder-G conversation');layout.append(host);
  const root=host.attachShadow({mode:'open'});
  const previews=createPreviewQueue(win);
  const style=doc.createElement('style');style.textContent=`
    :host { grid-area:message; display:block; min-width:0; min-height:0; overflow:auto;
      color:var(--layout-color-0,#202124); background:var(--layout-background-0,white);
      font:inherit; border-radius:0 0 1em 1em; }
    :host([hidden]) { display:none !important; }
    .conversation { --message-inset:56px; padding:14px 16px 20px; color-scheme:light dark; }
    h1 { margin:0 0 16px var(--message-inset); font-size:1.6em; line-height:1.4; font-weight:400; overflow-wrap:anywhere; }
    .scope,.status { font-size:.85em; opacity:.75; margin:0 0 8px var(--message-inset); }
    .title-tags { display:inline-flex; flex-wrap:wrap; gap:4px; margin-inline-start:10px; vertical-align:middle; font-size:.6em; font-weight:400; }
    .cards { display:flex; flex-direction:column; }
    article { border-block-end:1px solid var(--layout-border-0,#eceff1); padding:10px 0; }
    article[data-expanded] { padding:10px 0 0; }
    article:last-child { border-block-end:0; }
    .card-header { display:flex; align-items:flex-start; gap:16px; min-block-size:40px; }
    article:not([data-expanded]) .address { display:none; }
    .toggle { display:flex; align-items:center; gap:16px; flex:1; min-width:0;
      text-align:start; font:inherit; color:inherit; background:transparent; border:0; cursor:pointer; padding:0; line-height:1.4; }
    .toggle:not([aria-disabled="true"]):hover { background:var(--treeitem-background-hover,#e9eef6); border-radius:.5em; }
    button:focus-visible { outline:2px solid var(--focus-outline-color,#1a73e8); outline-offset:2px; }
    .avatar { display:flex; align-items:center; justify-content:center; flex:0 0 40px;
      inline-size:40px; block-size:40px; border-radius:50%; background:#d3e3fd; color:#174ea6; font-weight:600; }
    .sender { display:grid; grid-template-columns:minmax(0,auto) minmax(0,1fr); flex:1; min-width:0; overflow:hidden; padding-block-start:1px; }
    .sender > .name { grid-column:1; grid-row:1; }
    .sender > :is(.address,.preview) { grid-column:1 / -1; grid-row:2; }
    .sender > .tags { grid-column:2; grid-row:1; align-self:center; margin:0 0 0 8px; }
    .message-meta { display:flex; flex-wrap:wrap; justify-content:flex-end; align-items:center; gap:6px 10px; max-inline-size:45%; }
    .dkim-status { display:inline-flex; align-items:center; font-size:.8em; line-height:1.5; padding:1px 7px; border-radius:4px; white-space:nowrap; }
    .dkim-status[data-tone="success"] { background:light-dark(#ceead6,#183e29); color:light-dark(#137333,#a8dab5); }
    .dkim-status[data-tone="warning"] { background:light-dark(#feefc3,#493617); color:light-dark(#8a4b00,#fdd663); }
    .dkim-status[data-tone="failure"] { background:light-dark(#fce8e6,#4c2524); color:light-dark(#b3261e,#f6aea9); }
    .avatar img { inline-size:100%; block-size:100%; border-radius:inherit; object-fit:cover; }
    .name { display:block; font-weight:600; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
    .address { display:block; font-size:.85em; opacity:.75; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
    time { font-size:.85em; white-space:nowrap; opacity:.8; padding-block-start:2px; }
    .tags { display:flex; flex-wrap:wrap; gap:.35em; margin:4px 0 4px var(--message-inset); }
    .tags:empty { display:none; }
    .tag { display:inline-flex; align-items:center; gap:.3em; max-inline-size:100%;
      font-size:.85em; line-height:1.4; border-radius:.35em; padding:.1em .3em .1em .5em; }
    .tag-label { overflow-wrap:anywhere; }
    .tag-remove { display:inline-flex; align-items:center; justify-content:center; flex:none;
      inline-size:1.5em; block-size:1.5em; padding:0; border:0; border-radius:50%;
      font:inherit; font-size:1.1em; line-height:1; background:transparent; color:inherit; cursor:pointer; }
    .tag-remove:hover { background:light-dark(#0002,#fff2); }
    .preview { display:block; margin:2px 0 0; font-size:.9em; font-weight:400; opacity:.75; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
    .actions { display:flex; flex-wrap:wrap; gap:.5em; margin:16px 0 4px var(--message-inset); }
    .actions button,.fallback { display:inline-flex; align-items:center; justify-content:center; gap:9px; min-block-size:36px; min-inline-size:104px; font:inherit;color:inherit; background:transparent; border:1px solid var(--layout-border-0,#dadce0); border-radius:1.5em; padding:6px 18px; cursor:pointer; }
    .body { display:flex; min-height:0; flex-direction:column; margin-inline-start:var(--message-inset); }
    .quote-toggle { align-self:flex-start; min-inline-size:22px; block-size:16px;
      padding:0 5px; margin:4px 0 8px; border:0; border-radius:3px;
      background:var(--treeitem-background-hover,#e8eaed); color:inherit; font:bold 14px/12px sans-serif; cursor:pointer; }
    .action-icon { font-size:18px; line-height:1; }
    browser { display:block; flex:none; inline-size:100%; block-size:24em; min-block-size:0; border:0; }
    [hidden] { display:none !important; }
    @media(max-width:650px) { .conversation { --message-inset:48px; padding:12px; } .toggle {gap:8px;} time {font-size:.75em;} h1 {font-size:1.4em;} .card-header {gap:8px;} }
  `;
  const layoutStyle=doc.createElement('style');layoutStyle.textContent=`
    #paneLayout.gm-independent-open > #messagePane { display:none !important; }
    #paneLayout > .gm-independent-reader { grid-area:message; min-width:0; min-height:0; }
    #paneLayout > .gm-independent-reader[hidden] { display:none !important; }
  `;doc.head.append(layoutStyle);
  const conversation=doc.createElement('div');conversation.className='conversation';
  const title=doc.createElement('h1'),scope=doc.createElement('p'),status=doc.createElement('p'),cards=doc.createElement('div');
  scope.className='scope';scope.hidden=true;
  status.className='status';status.setAttribute('role','status');cards.className='cards';
  conversation.append(title,scope,status,cards);root.append(style,conversation);
  const titleTags=doc.createElement('span');titleTags.className='title-tags';titleTags.setAttribute('aria-label','Labels in this conversation');
  const cleanups=new Set(),tagRenderers=new Set(),securityRenderers=new Set(),frames=new Map(),messageDocs=new Map();let currentHeaders=[],actionHeader=null,activeHeader=null;
  const actions=doc.createElement('div');actions.className='actions';actions.setAttribute('role','group');actions.setAttribute('aria-label','Reply to conversation');
  const buttons=[];
  function runCommand(command) {
    if(typeof inlineReplyEnabled!=='undefined' && inlineReplyEnabled && ['cmd_replySender','cmd_replyall'].includes(command)) {
      let composer=inlineComposeControllers.get(win);
      if(!composer){composer=createInlineCompose(win);inlineComposeControllers.set(win,composer);}
      composer.open(actionHeader,command,{container:conversation,scrollHost:host});return;
    }
    const frame=frames.get(independentMessageKey(actionHeader || {}));
    const controller=frame?.contentWindow?.commandController;
    if(controller?.isCommandEnabled(command))controller.doCommand(command);
  }
  for(const [label,command,glyph] of [['Reply','cmd_replySender','↩'],['Reply all','cmd_replyall','⇇'],['Forward','cmd_forwardInline','↪']]) {
    const button=text('button','',label);
    const icon=text('span','action-icon',glyph);icon.setAttribute('aria-hidden','true');
    button.replaceChildren(icon,text('span','',label));button.type='button';button.disabled=true;buttons.push(button);
    button.addEventListener('click',()=>runCommand(command));actions.append(button);
  }
  conversation.append(actions);
  function updateActions(){for(const button of buttons)button.disabled=!frames.has(independentMessageKey(actionHeader || {}))}
  function refreshTags(){
    for(const render of securityRenderers)render();
    for(const render of tagRenderers)render();
    titleTags.replaceChildren();
    if(typeof assignedTags!=='function')return;
    const tags=new Map(),definitions=MailServices.tags.getAllTags();
    for(const header of currentHeaders)for(const tag of assignedTags(header,definitions))tags.set(tag.key,tag);
    for(const tag of tags.values()) {
      const chip=text('span','tag',tag.tag),colors=chipColors(tag.color);
      chip.style.backgroundColor=colors.background;chip.style.color=colors.foreground;
      chip.title=`${tag.tag} — present in this conversation`;titleTags.append(chip);
    }
  }
  const tagListener={msgPropertyChanged(header,property){if(['keywords','label'].includes(property))refreshTags();if(property==='dkim_verifier@pl-result')for(const render of securityRenderers)render()}};
  if(MailServices.mfn)MailServices.mfn.addListener(tagListener,Ci.nsIMsgFolderNotificationService.msgPropertyChanged);
  win.addEventListener?.('focus',refreshTags);
  function clearCards(){if(revealFrame!==null)win.cancelAnimationFrame(revealFrame);revealFrame=null;for(const cleanup of cleanups)cleanup();cleanups.clear();cards.replaceChildren();tagRenderers.clear();securityRenderers.clear();messageDocs.clear();titleTags.replaceChildren();frames.clear();currentHeaders=[];actionHeader=null;activeHeader=null;updateActions()}
  function text(tag,className,value){const node=doc.createElement(tag);node.className=className;node.textContent=value;return node}
  function buildCard(header,expand,token) {
    const article=doc.createElement('article');
    const cardHeader=doc.createElement('div');cardHeader.className='card-header';
    const latest=header===actionHeader;
    const toggle=doc.createElement('button');toggle.type='button';toggle.className='toggle';toggle.setAttribute('aria-expanded','false');
    if(latest) {article.setAttribute('data-latest','');toggle.setAttribute('aria-disabled','true');toggle.title='Most recent message'}
    let name=header.mime2DecodedAuthor || header.author || 'Unknown sender',address='';
    try {const from=MailServices.headerParser.parseDecodedHeader(name)[0];name=from?.name || from?.email || name;address=from?.email || ''}catch(_){}
    const initials=name.trim().split(/\s+/).slice(0,2).map(part=>part[0]).join('').toLocaleUpperCase();
    const preview=text('span','preview','');
    const isCurrent=()=>!closed && token===ticket;
    const updatePreview=()=>{preview.textContent=previews.get(header,isCurrent,()=>{})};
    preview.textContent=previews.get(header,isCurrent,updatePreview);
    const sender=text('span','sender','');sender.append(text('span','name',name),text('span','address',address),preview);
    const avatar=text('span','avatar',initials),photo=independentAvatar(address);
    if(photo) {
      const image=doc.createElement('img');image.alt='';image.setAttribute('src',photo);
      image.addEventListener('error',()=>avatar.replaceChildren(doc.createTextNode(initials)),{once:true});
      avatar.replaceChildren(image);
    }
    toggle.append(avatar,sender);
    const date=new Date((header.dateInSeconds || 0)*1000);
    const time=text('time','',date.toLocaleString(undefined,{weekday:'short',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}));time.dateTime=date.toISOString();time.title=date.toLocaleString();
    const meta=doc.createElement('div');meta.className='message-meta';
    const dkim=text('span','dkim-status','');dkim.setAttribute('role','status');
    let bimiTicket=0;
    async function refreshBimi(){
      const attempt=++bimiTicket;
      if(!photo)avatar.replaceChildren(doc.createTextNode(initials));
      if(photo || typeof independentBimiEnabled==='undefined' || !independentBimiEnabled || !liveDkim)return;
      let domain;try{domain=independentBimiDomain(address,liveDkim,host=>Services.eTLD.getBaseDomainFromHost(host));}catch(_){return;}
      if(!domain)return;
      try {const result=await verifyIndependentDkim(domain);
        if(!isCurrent() || attempt!==bimiTicket || !independentBimiEnabled || !result?.logo?.startsWith('data:image/svg+xml;base64,'))return;
        const image=doc.createElement('img');image.alt='';image.title='DNS-published BIMI logo';image.setAttribute('src',result.logo);
        image.addEventListener('error',()=>{if(attempt===bimiTicket)avatar.replaceChildren(doc.createTextNode(initials));},{once:true});avatar.replaceChildren(image);
      }catch(_){}
    }
    if(typeof independentBimiListeners!=='undefined'){independentBimiListeners.add(refreshBimi);cleanups.add(()=>{bimiTicket++;independentBimiListeners.delete(refreshBimi);});}
    let liveDkim=null,dkimPending=typeof verifyIndependentDkim==='function',dkimUnavailable=false;
    function renderDkim(){const value=dkimPending?{label:'DKIM checking…',tone:'warning'}:dkimUnavailable?{label:'DKIM unavailable',tone:'warning',detail:'DKIM Verifier integration unavailable'}:independentDkimStatus(header,liveDkim);dkim.textContent=value.label;dkim.setAttribute('data-tone',value.tone);dkim.title=[value.label,value.detail].filter(Boolean).join(' — ')}
    securityRenderers.add(renderDkim);renderDkim();meta.append(time,dkim);
    if(typeof verifyIndependentDkim==='function') {
      dkim.textContent='DKIM checking…';
      Promise.resolve().then(()=>verifyIndependentDkim(header)).then(result=>{
        if(!isCurrent())return;dkimPending=false;liveDkim={...result,version:'2.1'};renderDkim();refreshBimi();
      },()=>{if(isCurrent()){dkimPending=false;dkimUnavailable=true;renderDkim();}});
    }
    cardHeader.append(toggle,meta);article.append(cardHeader);
    const tags=doc.createElement('div');tags.className='tags';tags.setAttribute('aria-label','Labels on this message');sender.append(tags);
    function renderTags() {
      tags.replaceChildren();
      if(typeof assignedTags!=='function')return;
      for(const tag of assignedTags(header,MailServices.tags.getAllTags())) {
        const chip=text('span','tag',''),colors=chipColors(tag.color);
        chip.style.backgroundColor=colors.background;chip.style.color=colors.foreground;
        const label=text('span','tag-label',tag.tag),remove=text('button','tag-remove','×');remove.type='button';
        remove.setAttribute('aria-label',`Remove ${tag.tag} from this message`);remove.title=`Remove ${tag.tag}`;
        remove.addEventListener('click',event=>{
          event.preventDefault();event.stopPropagation();
          if(closed || token!==ticket)return;
          try {
            applyConversationLabel([header],tag.key,false);
            if(header.label && tag.key===`$label${header.label}`)header.label=0;
            refreshTags();
          }
          catch (_) {remove.title='Could not remove label. Try again.'}
        });
        chip.append(label,remove);tags.append(chip);
      }
    }
    tagRenderers.add(renderTags);renderTags();
    const body=doc.createElement('div');body.className='body';body.hidden=true;article.append(body);
    let browser=null,timeout=null,zoom=null,bodyResize=null,contentChanges=null,contentLoad=null,resizeFrame=null,ready=false,toggleQuotes=null,restoreCommands=null,focusCleanup=null;
    const quoteButton=text('button','quote-toggle','…');quoteButton.type='button';quoteButton.hidden=true;
    quoteButton.setAttribute('aria-label','Show quoted text');quoteButton.setAttribute('aria-expanded','false');
    quoteButton.addEventListener('click',()=>toggleQuotes?.());
    const error=text('div','status','Unable to display this message. Close and reopen it to retry. ');error.hidden=true;
    const fallback=text('button','fallback','Open in Thunderbird window');fallback.type='button';
    fallback.addEventListener('click',()=>{
      ChromeUtils.importESModule('resource:///modules/MailUtils.sys.mjs').MailUtils.openMessageInNewWindow(header);
    });error.append(fallback);
    function release(){
      if(timeout!==null)win.clearTimeout(timeout);timeout=null;
      bodyResize?.disconnect();bodyResize=null;
      contentChanges?.disconnect();contentChanges=null;
      contentLoad?.();contentLoad=null;toggleQuotes=null;
      if(resizeFrame!==null)win.cancelAnimationFrame(resizeFrame);resizeFrame=null;
      restoreCommands?.();restoreCommands=null;focusCleanup?.();focusCleanup=null;
      for(const [document,message] of messageDocs)if(message===header)messageDocs.delete(document);
      frames.delete(independentMessageKey(header));updateActions();
      zoom?.close();zoom=null;
      browser?.remove();browser=null;ready=false;

    }
    function expandCard(){
      activeHeader=header;body.hidden=false;preview.hidden=true;article.setAttribute('data-expanded','');toggle.setAttribute('aria-expanded','true');error.hidden=true;
      browser=doc.createXULElement('browser');
      const frame=browser;
      browser.addEventListener('load',event=>{
        if(closed || token!==ticket || browser!==frame || event.target!==browser.contentDocument || browser.contentDocument.documentURI!=='about:message')return;
        try {
          messageDocs.set(browser.contentDocument,header);
          const controller=browser.contentWindow.commandController;
          if(controller) {
            const originals=new Map();
            for(const [name,replacement] of [
              ['_toggleMessageTagKey',number=>toggleTagNumber(header,number)],
              ['_toggleMessageTag',(key,add)=>setMessageTag(header,key,add)],
              ['_removeAllMessageTags',()=>toggleTagNumber(header,0)]]) {
              originals.set(name,controller[name]);controller[name]=replacement;
            }
            restoreCommands=()=>{for(const [name,value] of originals)controller[name]=value};
          }
          browser.docShell.allowDNSPrefetch=false;
          zoom=installMailZoom(browser.contentWindow,ChromeUtils.importESModule('resource:///modules/UIFontSize.sys.mjs').UIFontSize);
          browser.contentWindow.displayMessage(header.folder.getUriForMsg(header));
        }catch(_){release();error.hidden=false}
      },true);
      browser.addEventListener('MsgLoaded',()=>{
        if(closed || token!==ticket || browser!==frame)return;
        if(timeout!==null)win.clearTimeout(timeout);timeout=null;ready=true;error.hidden=true;
        frames.set(independentMessageKey(header),frame);updateActions();
        // Style only the native envelope chrome. Remote-content and encryption
        // notifications and attachments remain present and functional.
        const frameStyle=browser.contentDocument.createElement('style');
        frameStyle.textContent=`
          #messageHeader { display:flex !important; flex-wrap:wrap; align-items:center;
            border:0; background:transparent; padding:0; gap:0 8px; }
          #headerSenderToolbarContainer { order:2; flex:0 0 auto; margin-inline-start:auto; }
          #expandedtoRow { order:1; flex:1 1 auto; }
          #headerSubjectSecurityContainer { order:3; }
          #messageHeader > .message-header-row { min-block-size:0; margin-block:0; padding-block:0; }
          #header-view-toolbox, #header-view-toolbar { min-block-size:24px; padding:0; margin:0; }
          #expandedBoxSpacer { display:none !important; }
          #dkim_verifier_pl-messageDisplayAction-toolbarbutton { display:none !important; }
          /* The conversation already supplies sender, date, subject and actions.
             Keep recipients, security indicators, extension controls and notices. */
          #expandedfromRow, #expandedsubjectRow, #expandedtagsRow, #dateLabel, #dateLabelSubject,
          #hdrReplyToSenderButton, #hdrSmartReplyButton, #hdrReplyButton,
          #hdrReplyAllButton, #hdrReplyListButton, #hdrFollowupButton,
          #hdrForwardButton, #hdrArchiveButton, #hdrJunkButton, #hdrTrashButton {
            display:none !important;
          }
          #messagepaneboxwrapper, #messagepanebox { min-block-size:0; }
          #messagepane { min-block-size:0; flex:1; }
          .message-header-view-button { border-radius:16px !important; }
          #header-view-toolbar { column-gap:6px; align-items:center; }
#otherActionsButton {
  min-inline-size:36px !important; max-inline-size:36px !important;
  min-block-size:36px !important; padding:8px !important;
  margin-inline:4px !important; border:0 !important;
  border-radius:50% !important; background:transparent !important;
  justify-content:center !important;
}
#otherActionsButton > .toolbarbutton-text,
#otherActionsButton > .toolbarbutton-menu-dropmarker { display:none !important; }
#otherActionsButton > .toolbarbutton-icon {
  margin:0 !important; width:16px !important; height:16px !important;
}
#otherActionsButton:hover { background:light-dark(#20212414,#ffffff20) !important; }
#otherActionsButton:focus-visible { outline:2px solid Highlight !important; outline-offset:2px; }

        `;
        browser.contentDocument.documentElement.append(frameStyle);
        // Size the envelope to the rendered message; the conversation owns the
        // scrollbar. Read layout only: MIME content and its security stay native.
        const pane=browser.contentDocument.getElementById('messagepane');
        const content=pane?.contentDocument;
        if(content) {
          messageDocs.set(content,header);
          const activate=()=>{activeHeader=header};
          content.addEventListener('pointerdown',activate,true);content.addEventListener('focusin',activate,true);
          focusCleanup=()=>{content.removeEventListener('pointerdown',activate,true);content.removeEventListener('focusin',activate,true)};
        }
        if(content?.body && win.ResizeObserver) {
          const resizeBody=()=>{
            resizeFrame=null;
            if(browser!==frame || closed || token!==ticket || body.hidden)return;
            const chrome=Math.max(0,frame.clientHeight-pane.clientHeight);
            const contentHeight=independentContentHeight(content);
            const height=Math.ceil(contentHeight+chrome);
            if(Math.abs(frame.clientHeight-height)>1)frame.style.blockSize=height+'px';
          };
          const scheduleResize=()=>{if(resizeFrame===null)resizeFrame=win.requestAnimationFrame(resizeBody)};
          // Presentation only, in the disposable native viewer. Stored MIME and
          // message text are untouched, and the user can reveal every quote.
          const quotes=content.querySelectorAll('blockquote[type="cite"], .gmail_quote');
          if(currentHeaders.length>1 && quotes.length) {
            const quoteStyle=content.createElement('style');
            quoteStyle.textContent='@media screen { :root[data-gm-fold-quotes] :is(blockquote[type="cite"], .gmail_quote, .moz-cite-prefix) { display:none !important; } }';
            content.documentElement.append(quoteStyle);
            content.documentElement.setAttribute('data-gm-fold-quotes','');
            quoteButton.hidden=false;
            toggleQuotes=()=>{
              const folded=quoteButton.getAttribute('aria-expanded')!=='true';
              if(folded)content.documentElement.removeAttribute('data-gm-fold-quotes');
              else content.documentElement.setAttribute('data-gm-fold-quotes','');
              quoteButton.setAttribute('aria-expanded',String(folded));
              quoteButton.setAttribute('aria-label',folded?'Hide quoted text':'Show quoted text');
              quoteButton.title=folded?'Hide quoted text':'Show quoted text';scheduleResize();
            };
          }
          bodyResize?.disconnect();
          bodyResize=new win.ResizeObserver(scheduleResize);
          bodyResize.observe(content.body);bodyResize.observe(pane);
          contentChanges=new win.MutationObserver(scheduleResize);
          contentChanges.observe(content.body,{childList:true,subtree:true,characterData:true,attributes:true});
          content.addEventListener('load',scheduleResize,true);
          contentLoad=()=>content.removeEventListener('load',scheduleResize,true);
          scheduleResize();
        }
      },true);
      browser.setAttribute('src','about:message');
      body.replaceChildren(error,browser,quoteButton);
      timeout=win.setTimeout(()=>{if(!ready){release();error.hidden=false}},15000);
    }
    article.addEventListener('pointerdown',()=>{activeHeader=header});
    article.addEventListener('focusin',()=>{activeHeader=header});
    toggle.addEventListener('click',()=>{
      activeHeader=header;
      if(latest)return;
      if(body.hidden) {
        if(browser) {body.hidden=false;preview.hidden=true;article.setAttribute('data-expanded','');toggle.setAttribute('aria-expanded','true')}
        else expandCard();
      } else {
        // Retain a loaded frame while folded so footer Reply/Print still target
        // the latest message. All frames are released when leaving the reader.
        body.hidden=true;preview.hidden=false;article.removeAttribute('data-expanded');toggle.setAttribute('aria-expanded','false');
      }
    });
    cleanups.add(release);cards.append(article);if(expand)expandCard();
    return article;
  }
  function render(headers,anchor,token){
    clearCards();currentHeaders=headers;
    actionHeader=headers.at(-1) || anchor;activeHeader=actionHeader;
    let latestCard;
    for(const header of headers) {
      const card=buildCard(header,header===actionHeader,token);
      if(header===actionHeader)latestCard=card;
    }
    updateActions();refreshTags();
    revealFrame=win.requestAnimationFrame(()=>{
      revealFrame=null;
      if(!closed && token===ticket)latestCard?.scrollIntoView({block:'nearest',inline:'nearest'});
    });
  }
  function setMessageTag(header,key,add) {
    if(closed || !currentHeaders.includes(header))return;
    applyConversationLabel([header],key,add);
    if(!add && header.label && key===`$label${header.label}`)header.label=0;
    refreshTags();
  }
  function toggleTagNumber(header,number) {
    if(!header || !currentHeaders.includes(header))return;
    const tags=MailServices.tags.getAllTags();
    if(number===0) {
      const keys=new Set((header.getStringProperty('keywords') || '').split(/\s+/));
      for(const tag of tags)if(keys.has(tag.key) || tag.key===`$label${header.label}`)setMessageTag(header,tag.key,false);
      return;
    }
    const tag=tags[number-1];if(!tag)return;
    const keys=(header.getStringProperty('keywords') || '').split(/\s+/);
    setMessageTag(header,tag.key,!(keys.includes(tag.key) || tag.key===`$label${header.label}`));
  }
  return {
    handleTagKey(event) {
      const number=independentTagKey(event);
      if(number===null || host.hidden || closed)return false;
      const header=messageDocs.get(event.currentTarget) || messageDocs.get(event.target?.ownerDocument) || activeHeader;
      event.preventDefault();event.stopImmediatePropagation();
      try {toggleTagNumber(header,number)}catch(_){status.hidden=false;status.textContent='Could not update the label on this message. Try again.'}
      return true;
    },
    async open(header){
      if(closed)return;if(typeof inlineComposeControllers!=='undefined')inlineComposeControllers.get(win)?.float();const token=++ticket;query?.cancel();
      host.hidden=false;layout.classList.add('gm-independent-open');host.scrollTop=0;
      title.textContent=header.mime2DecodedSubject || '(No subject)';title.append(titleTags);status.hidden=false;status.textContent='Loading conversation…';
      clearCards();
      let gloda=null;
      try {if(Services.prefs.getBoolPref('mailnews.database.global.indexer.enabled',true))gloda=ChromeUtils.importESModule('resource:///modules/gloda/GlodaPublic.sys.mjs').Gloda}catch(_){}
      query=independentConversation(win,header,gloda,independentSentFolders());
      const result=await query.promise;
      if(closed || token!==ticket)return;
      render(result.messages,header,token);
      status.textContent=`${result.messages.length} ${result.messages.length===1?'message':'messages'}`;
      status.hidden=result.messages.length===1;
      status.title=result.indexed?'':'Conversation assembled from this folder and locally available sent messages';
    },
    hide(){if(typeof inlineComposeControllers!=='undefined')inlineComposeControllers.get(win)?.float();++ticket;query?.cancel();query=null;host.hidden=true;layout.classList.remove('gm-independent-open');clearCards()},
    close(){this.hide();closed=true;previews.close();win.removeEventListener?.('focus',refreshTags);MailServices.mfn?.removeListener(tagListener);host.remove();layoutStyle.remove()},
    refresh:refreshTags,
    print(){runCommand('cmd_print')},
    getMessages(){return currentHeaders.slice()}
  };
}
