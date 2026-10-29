/* Resolve the stable native key, never Gmail's lossy slash-to-hyphen query syntax. */
function openNativeLabelView(source,key,mail=MailServices,smart=null) {
  const tag=mail.tags.getAllTags().find(tag=>tag.key===key);
  if(!tag)throw new Error(gmText("This label no longer exists."));
  const main=source.browsingContext?.topChromeWindow || source;
  const tabmail=main.document.getElementById('tabmail');
  if(!tabmail)throw new Error(gmText("The mail window is unavailable."));
  let pane=tabmail.currentAbout3Pane;
  if(!pane){const tab=tabmail.tabInfo.find(tab=>tab.chromeBrowser?.contentWindow?.document?.documentURI==='about:3pane');if(tab){tabmail.switchToTab(tab);pane=tab.chromeBrowser.contentWindow;}}
  if(!pane)throw new Error(gmText("Open a mail tab first."));
  smart ||= ChromeUtils.importESModule('resource:///modules/SmartMailboxUtils.sys.mjs').SmartMailboxUtils;
  if(!pane.folderPane.activeModes.includes('tags'))pane.folderPane.activeModes=[...pane.folderPane.activeModes,'tags'];
  const folder=smart.getSmartMailbox().getTagFolder(tag);
  if(!folder)throw new Error(gmText("The label view is unavailable."));
  const previousURI=pane.gFolder?.URI;
  if(previousURI && previousURI!==folder.URI){
    const history=pane._gmLabelHistory ||= [];
    history.push({uri:previousURI,filters:{...pane.quickFilterBar?.filterer?.filterValues}});
  }
  // Leave the reader even when clicking a chip while already in this tag's view.
  pane.dispatchEvent(new pane.CustomEvent('gm-open-label-view'));
  const bar=pane.quickFilterBar,filter=bar?.filterer;
  if(filter?.clear){const sticky=filter.filterValues?.sticky;filter.clear();if(sticky)filter.setFilterValue('sticky',sticky);bar.updateSearch();bar.reflectFiltererState();}
  pane.displayFolder(folder.URI);
  pane.dispatchEvent(new pane.CustomEvent('gm-label-navigation'));
  return folder.URI;
}
function bindLabelNavigation(node,tag,win,navigate=openNativeLabelView) {
  let name=tag.tag || tag.name;
  if(!name){try{name=globalThis.MailServices?.tags?.getTagForKey?.(tag.key);}catch(_){}name ||= tag.key;}
  const previous={};for(const attr of ['role','tabindex','title','data-gm-label-link'])previous[attr]=node.getAttribute?.(attr) ?? null;
  const cursor=node.style.cursor;
  node.setAttribute('data-gm-label-link',tag.key);node.setAttribute('role','link');node.setAttribute('tabindex','0');
  gmBindValue(node, "title", () => gmText("Show all messages with label $1", name));node.style.cursor='pointer';
  function click(event){
    if(event.target?.closest?.('button,.tag-x,.tag-remove,.gm-remove-message-tag'))return;
    event.preventDefault();event.stopImmediatePropagation?.();event.stopPropagation();
    try{navigate(win,tag.key);}catch(error){console.error(gmText("Open label view:"),error);}
  }
  function keydown(event){if(event.target!==node || !['Enter',' '].includes(event.key))return;click(event);}
  node.addEventListener('click',click,true);node.addEventListener('keydown',keydown,true);
  return ()=>{node.removeEventListener('click',click,true);node.removeEventListener('keydown',keydown,true);for(const [attr,value] of Object.entries(previous)){if(value===null)node.removeAttribute(attr);else node.setAttribute(attr,value);}node.style.cursor=cursor;};
}

function returnFromNativeLabelView(pane){
  const previous=pane._gmLabelHistory?.pop();
  if(!previous)return false;
  pane.dispatchEvent(new pane.CustomEvent('gm-open-label-view'));
  pane.displayFolder(previous.uri);
  const bar=pane.quickFilterBar,filter=bar?.filterer;
  if(filter?.clear){
    filter.clear();
    for(const [key,value] of Object.entries(previous.filters))filter.setFilterValue(key,value);
    bar.updateSearch();bar.reflectFiltererState();
  }
  pane.dispatchEvent(new pane.CustomEvent('gm-label-navigation'));
  return true;
}
