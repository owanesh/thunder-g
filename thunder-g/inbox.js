/* Native quick filters, cached previews, and row-scoped actions. */
function cachedMessagePreview(header) {
  try {
    return (header.getStringProperty?.('preview') || '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
  } catch (_) { return ''; }
}
function localMessagePreview(header) {
  const cached = cachedMessagePreview(header);
  if (cached) return cached;
  let stream;
  try {
    const folder = header.folder;
    if (!folder?.getMsgInputStream || !folder.getMsgTextFromStream) return '';
    // This API reads only the local store, including locally cached IMAP mail.
    stream = folder.getMsgInputStream(header);
    const text = folder.getMsgTextFromStream(stream, header.charset || '', 16384, 240, true, true, {});
    return cachedMessagePreview({getStringProperty:()=>text});
  } catch (_) { return ''; }
  finally { try { stream?.close(); } catch (_) {} }
}

var sharedPreviewCaches=new WeakMap();
function createPreviewQueue(win) {
  let shared=sharedPreviewCaches.get(win);
  if(!shared){shared={cache:new Map(),users:0};sharedPreviewCaches.set(win,shared);}
  shared.users++;
  const cache=shared.cache,jobs=new Map();
  const stamp=header=>JSON.stringify([header.messageId || '',header.messageSize || 0,header.dateInSeconds || 0]);
  function lookup(header,key){
    const entry=cache.get(key);
    if(!entry || entry.stamp!==stamp(header) || entry.expiresAt<=Date.now())return null;
    if(!entry.text && (entry.retryAt<=Date.now() || entry.flags!==header.flags))return null;
    cache.delete(key);cache.set(key,entry);return entry;
  }
  let timer = null, closed = false;
  function schedule() {
    if (!closed && timer === null && jobs.size) timer = win.setTimeout(drain, 16);
  }
  function drain() {
    timer = null;
    if (closed) return;
    const [key, job] = jobs.entries().next().value || [];
    if (!key) return;
    jobs.delete(key);
    if (job.isCurrent()) {
      // Another consumer may already have read this message while queued.
      const found=lookup(job.header,key),text=found?found.text:localMessagePreview(job.header);
      if(!found){
        if(cache.size>=300)cache.delete(cache.keys().next().value);
        cache.set(key,{text,stamp:stamp(job.header),flags:job.header.flags,retryAt:Date.now()+30000,expiresAt:Date.now()+300000});
      }
      if (!closed && job.isCurrent()) job.ready();
    }
    schedule();
  }
  return {
    get(header, isCurrent, ready) {
      if (closed) return '';
      const native = cachedMessagePreview(header);
      if (native) return native;
      const key = header.folder?.URI && header.messageKey !== undefined
        ? header.folder.URI+'#'+header.messageKey : null;
      if (!key) return '';
      const found=lookup(header,key);
      if(found)return found.text;
      // Keep the queue bounded when scrolling through many virtual rows.
      if (jobs.size >= 100 && !jobs.has(key)) jobs.delete(jobs.keys().next().value);
      jobs.set(key,{header,isCurrent,ready}); schedule();
      return '';
    },
    close() {
      if(closed)return;closed = true;
      if (timer !== null) win.clearTimeout(timer);
      timer = null; jobs.clear();
      if(--shared.users===0){cache.clear();sharedPreviewCaches.delete(win);}
    }
  };
}

function runRowAction(win, row, name, expected, reader=null) {
  if (!row || row.index < 0 || (row.dataset.properties || '').split(' ').includes('dummy')) return;
  let header;
  try { header = win.gDBView?.getMsgHdrAt(row.index); } catch (_) { return; }
  if (!header || (expected && (header.messageKey !== expected.key || header.folder?.URI !== expected.folderURI))) return;
  // Replace any earlier multi-selection. A collapsed row retains Thunderbird's
  // native conversation scope; unrelated selected rows are never included.
  const tree=win.document.getElementById('threadTree');
  tree._gmSmartActionPending=false;
  tree.setAttribute?.('data-gm-smart-action-done','');
  tree.selectedIndex = row.index;
  try {
    if (win.commandController.isCommandEnabled(name)) win.commandController.doCommand(name);
  } finally {
    tree._gmSmartActionPending=true;
    if(reader)reader.selectIndices([]);
    else {tree.selectedIndices=[];win.threadPaneHeader?.updateSelectedCount();}
  }
}

function visibleInboxIndices(tree,view) {
  const viewport=tree.getBoundingClientRect(),heading=tree.querySelector('thead')?.getBoundingClientRect().height || 0;
  const indices=[];
  for(const row of tree.querySelectorAll('tr.table-layout, tr.card-layout')) {
    const rect=row.getBoundingClientRect();
    if(row.index>=0 && rect.bottom>viewport.top+heading && rect.top<viewport.bottom &&
      !((view?.getFlagsAt(row.index) || 0)&0x20000000))indices.push(row.index);
  }
  return indices;
}
function inboxSelectionMatches(header,mode) {
  if(mode==='all')return true;
  if(mode==='none')return false;
  if(mode==='read')return !!header.isRead;
  if(mode==='unread')return !header.isRead;
  if(mode==='starred')return !!header.isFlagged;
  if(mode==='unstarred')return !header.isFlagged;
  return false;
}
function selectInboxMode(win,reader,mode) {
  const tree=win.document.getElementById('threadTree'),view=win.gDBView;
  if(!tree || !view)return;
  tree._gmSmartActionPending=false;
  const apply=indices=>{if(reader)reader.selectIndices(indices);else tree.selectedIndices=indices;};
  if(mode==='none'){apply([]);return;}
  if(tree.hasAttribute('data-gm-paginated')){
    tree.dispatchEvent(new win.CustomEvent('gm-select-page',{detail:{mode}}));return;
  }
  // Native commands already own select-all and starred selection, including
  // collapsed threads. Synchronize our toolbar with their resulting selection.
  const command=mode==='all'?'cmd_selectAll':mode==='starred'?'cmd_selectFlagged':null;
  if(command && win.commandController?.isCommandEnabled(command)){
    win.commandController.doCommand(command);
    apply(Array.from(tree.selectedIndices || []));return;
  }
  // Thunderbird exposes no equivalent select-read/unread/unstarred commands.
  // Read its current view and message flags, without changing any filters.
  const indices=[];
  for(let index=0;index<view.rowCount;index++){
    try{
      if(!(view.getFlagsAt(index)&0x20000000) && inboxSelectionMatches(view.getMsgHdrAt(index),mode))indices.push(index);
    }catch(_){ /* A changing view can briefly contain an unavailable row. */ }
  }
  apply(indices);
}
function inboxSelectionState(view,selectedIndices,range=null){
  const selected=new Set(selectedIndices || []);let total=0,count=0;
  const start=range?.rowStart ?? 0,end=range?.rowEnd ?? view?.rowCount ?? 0;
  for(let index=start;index<end;index++){
    try{if(view.getFlagsAt(index)&0x20000000)continue;}catch(_){continue;}
    total++;if(selected.has(index))count++;
  }
  return {checked:total>0 && count===total,indeterminate:count>0 && count<total};
}
function installInboxIdleActions(win,reader=null) {
  const doc=win.document,header=doc.getElementById('threadPaneHeaderBar');
  const host=header?.querySelector?.('.list-header-bar-container-start');
  if(!host)return {close(){}};
  let closed=false,selectionFrame=null;
  const bar=doc.createElement('div');bar.className='gm-inbox-idle-actions';bar.setAttribute('role','toolbar');bar.setAttribute('aria-label','Message list actions');
  const select=doc.createElement('input');select.type='checkbox';select.title='Select all messages on this page';select.setAttribute('aria-label',select.title);
  function syncSelection(){
    if(closed)return;
    const tree=doc.getElementById('threadTree');
    const range=tree?.hasAttribute('data-gm-paginated')?tree._gmPageSelectionBounds?.():null;
    const state=inboxSelectionState(win.gDBView,tree?.selectedIndices,range);
    select.checked=state.checked;select.indeterminate=state.indeterminate;
  }
  select.addEventListener('change',()=>{
    const tree=doc.getElementById('threadTree');
    if(tree)tree._gmSmartActionPending=false;
    if(tree?.hasAttribute('data-gm-paginated')){
      // Native pagination owns page boundaries, including collapsed threads.
      const nativeSelect=doc.getElementById('selectColButton');
      if(!nativeSelect){select.checked=false;return;}
      nativeSelect.click();
    }else{
      selectInboxMode(win,reader,select.checked?'all':'none');
    }
    if(selectionFrame!==null)win.cancelAnimationFrame(selectionFrame);
    selectionFrame=win.requestAnimationFrame(()=>{
      selectionFrame=null;if(closed)return;
      const tree=doc.getElementById('threadTree');
      reader?.selectIndices(Array.from(tree?.selectedIndices || []));syncSelection();
    });
  });
  function button(label,path,handler){
    const node=doc.createElement('button');node.type='button';node.className='gm-inbox-action';node.title=label;node.setAttribute('aria-label',label);
    const svg=doc.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('width','20');svg.setAttribute('height','20');svg.setAttribute('aria-hidden','true');
    const shape=doc.createElementNS('http://www.w3.org/2000/svg','path');shape.setAttribute('d',path);shape.setAttribute('fill','none');shape.setAttribute('stroke','currentColor');shape.setAttribute('stroke-width','1.8');shape.setAttribute('stroke-linecap','round');svg.append(shape);node.append(svg);
    if(handler)node.addEventListener('click',handler);return node;
  }
  const refresh=button('Refresh','M20 7v5h-5 M19 12a7 7 0 1 0-1 5',()=>{
    const main=win.browsingContext?.topChromeWindow;
    try{
      if(typeof main?.MsgGetMessage!=='function')throw new Error('Mail refresh is unavailable.');
      main.MsgGetMessage(win.gFolder?[win.gFolder]:undefined);
      win.gFolder?.updateFolder?.(main.msgWindow);
      refresh.title='Refresh';
    }catch(error){refresh.title=error.message || 'Could not refresh mail.';}
  });
  const group=doc.createElement('div');group.className='gm-inbox-select-group';
  const dropdown=button('Select messages','M8 10l4 4 4-4');dropdown.className='gm-inbox-select-dropdown';
  dropdown.setAttribute('aria-haspopup','menu');dropdown.setAttribute('aria-expanded','false');
  const popup=doc.createXULElement('panel');popup.className='gm-inbox-selection-popup';
  popup.setAttribute('noautofocus','true');
  const menu=doc.createElement('div');menu.setAttribute('role','menu');menu.setAttribute('aria-label','Select messages');
  function choose(mode){
    popup.hidePopup();
    if(!closed){selectInboxMode(win,reader,mode);syncSelection();}
  }
  for(const [label,mode] of [['All','all'],['None','none'],['Read','read'],['Unread','unread'],['Starred','starred'],['Unstarred','unstarred']]){
    const item=doc.createElement('button');item.type='button';item.textContent=label;item.setAttribute('role','menuitem');
    item.addEventListener('click',()=>choose(mode));menu.append(item);
  }
  popup.append(menu);doc.documentElement.append(popup);
  dropdown.addEventListener('click',()=>popup.openPopup(group,'after_start',0,0,false,false));
  popup.addEventListener('popupshown',()=>{dropdown.setAttribute('aria-expanded','true');menu.children[0]?.focus();});
  popup.addEventListener('popuphidden',()=>{dropdown.setAttribute('aria-expanded','false');dropdown.focus();});
  menu.addEventListener('keydown',event=>{
    const items=[...menu.children],index=items.indexOf(doc.activeElement);
    if(event.key==='Escape'){event.preventDefault();popup.hidePopup();}
    if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
      event.preventDefault();
      const next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;
      items[next].focus();
    }
  });
  group.append(select,dropdown);
  const more=button('More options (not available yet)','M12 5v.01 M12 12v.01 M12 19v.01');more.disabled=true;
  bar.append(group,refresh,more);host.prepend(bar);
  reader?.setSelectionControl?.(group,bar);
  const style=doc.createElement('style');style.textContent=`
    #threadPaneFolderName,#threadPaneFolderCountContainer{display:none!important}
    #threadPaneHeaderBar{box-sizing:border-box!important;block-size:44px!important;min-block-size:44px!important;max-block-size:44px!important;padding:3px 5px!important;margin-block:0!important;align-items:center!important;}
    #threadPaneHeaderBar > .list-header-bar-container-start{padding:0!important;margin-block:0!important;min-block-size:0!important;block-size:36px;align-items:center;}
    .gm-inbox-idle-actions{display:flex;align-items:center;gap:8px;min-height:36px;flex:0 0 auto;overflow:visible;}
    .gm-inbox-select-group{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;block-size:36px;flex:0 0 auto;margin:0;padding:0 6px;border-radius:6px;gap:2px;}
    .gm-inbox-select-group{background:transparent!important;}
    .gm-inbox-select-group input{appearance:none!important;box-sizing:border-box;border:2px solid currentColor!important;background:transparent!important;inline-size:16px!important;block-size:16px!important;min-inline-size:16px!important;flex:0 0 16px;padding:0!important;margin:0!important;accent-color:#1a73e8;cursor:pointer;border-radius:2px!important;}
    /* All three states keep the same square shape, independent of OS accent. */
    .gm-inbox-select-group input:checked{appearance:none!important;background:transparent url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2016%2016%22%3E%3Cpath%20d%3D%22m3%208%203%203%207-7%22%20fill%3D%22none%22%20stroke%3D%22%23444746%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%3C%2Fsvg%3E") center/14px 14px no-repeat!important;}
    .gm-inbox-select-group input:indeterminate{appearance:none!important;background:linear-gradient(currentColor,currentColor) center/8px 2px no-repeat!important;}
    @media(prefers-color-scheme:dark){.gm-inbox-select-group input:checked{background-image:url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2016%2016%22%3E%3Cpath%20d%3D%22m3%208%203%203%207-7%22%20fill%3D%22none%22%20stroke%3D%22%23e3e3e3%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%3C%2Fsvg%3E")!important;}}
    .gm-inbox-select-dropdown{display:inline-flex;align-items:center;justify-content:center;appearance:none;inline-size:22px;block-size:24px;min-inline-size:0;min-block-size:0;margin:0!important;padding:0!important;border:0!important;border-radius:0!important;box-shadow:none!important;background:transparent!important;color:inherit;cursor:pointer;}
    .gm-inbox-select-dropdown:is(:hover,:focus-visible){background:var(--treeitem-background-hover,#e9eef6)!important;border-radius:4px!important;}
    .gm-inbox-select-group input:focus-visible{outline:2px solid Highlight;outline-offset:3px;}
    .gm-inbox-select-dropdown svg{width:16px;height:16px;}
    .gm-inbox-selection-popup{--panel-padding:0;--panel-border-radius:4px;}
    .gm-inbox-selection-popup [role=menu]{padding:8px 0;min-width:160px;background:var(--layout-background-0,#fff);color:var(--layout-color-0,#202124);}
    .gm-inbox-selection-popup [role=menuitem]{display:block;width:100%;padding:8px 24px;border:0;border-radius:0;text-align:start;font:inherit;background:transparent;color:inherit;cursor:pointer;}
    .gm-inbox-selection-popup [role=menuitem]:is(:hover,:focus-visible){background:var(--treeitem-background-hover,#e9eef6);outline:none;}

    .gm-inbox-action{appearance:none;box-sizing:border-box;display:inline-flex;flex:0 0 36px;align-items:center;justify-content:center;inline-size:36px;min-inline-size:36px;max-inline-size:36px;block-size:36px;min-block-size:36px;max-block-size:36px;margin:0;padding:8px;border:0;border-radius:50%;background:transparent;color:inherit;cursor:pointer}
    .gm-inbox-action:hover:enabled{background:var(--treeitem-background-hover,#e9eef6)}
    .gm-inbox-action:disabled{opacity:.5;cursor:default}
    .gm-inbox-action:focus-visible{outline:2px solid #1a73e8;outline-offset:-2px}
  `;doc.head.append(style);
  const alignmentTree=doc.getElementById('threadTree');
  function alignCheckbox(){
    const rowCheckbox=alignmentTree?.querySelector?.('tr.table-layout .tree-view-row-select img, tr.card-layout .tree-view-row-select img');
    if(group.parentNode!==bar || !rowCheckbox || !select.getBoundingClientRect)return;
    const target=rowCheckbox.getBoundingClientRect(),current=select.getBoundingClientRect();
    if(!target.width || !current.width)return;
    const rtl=win.getComputedStyle(bar).direction==='rtl';
    const offset=parseFloat(bar.style.marginInlineStart)||0;
    const delta=(target.left+target.width/2)-(current.left+current.width/2);
    // Never use a negative offset: the rounded header clips the checkbox.
    const next=Math.max(0,offset+(rtl?-delta:delta));
    if(Math.abs(next-offset)>.5)bar.style.marginInlineStart=`${next}px`;
  }
  const alignmentObserver=win.ResizeObserver?new win.ResizeObserver(alignCheckbox):null;
  alignmentObserver?.observe(header);
  if(alignmentTree)alignmentObserver?.observe(alignmentTree);
  for(const name of ['select','viewchange','rowcountchange','gm-page-changed'])alignmentTree?.addEventListener?.(name,syncSelection);
  syncSelection();
  alignmentTree?.addEventListener?.('viewchange',alignCheckbox);
  alignmentTree?.addEventListener?.('scroll',alignCheckbox);
  alignCheckbox();
  return {close(){closed=true;reader?.setSelectionControl?.(null);alignmentObserver?.disconnect();
    for(const name of ['select','viewchange','rowcountchange','gm-page-changed'])alignmentTree?.removeEventListener?.(name,syncSelection);
    alignmentTree?.removeEventListener?.('viewchange',alignCheckbox);
    alignmentTree?.removeEventListener?.('scroll',alignCheckbox);
    if(selectionFrame!==null)win.cancelAnimationFrame(selectionFrame);popup.hidePopup();popup.remove();bar.remove();style.remove();}};
}

function installComposeLabel(doc) {
  const button = doc.getElementById('folderPaneWriteMessage');
  if (!button?.getAttribute) return {close(){}};
  const attributes = ['data-l10n-id', 'data-l10n-args', 'aria-label'];
  const saved = attributes.map(name => [name, button.getAttribute(name)]);
  const text = button.textContent;
  button.removeAttribute('data-l10n-id');
  button.removeAttribute('data-l10n-args');
  button.textContent = 'Compose';
  button.setAttribute('aria-label', 'Compose a new message');
  return {close() {
    button.textContent = text;
    for (const [name, value] of saved) {
      if (value === null) button.removeAttribute(name);
      else button.setAttribute(name, value);
    }
  }};
}

function installResponsiveColumns(win) {
  const tree = win.document.getElementById('threadTree');
  if (!tree || !win.ResizeObserver) return {close(){}};
  const saved = new Map();
  const preferred = new Map();
  const enabledSplitters = new Map();
  let dragWidths = null;
  let subjectDrag = null;
  let currentTable = null;
  let manualWidth = null;
  let closed = false, frame = null;
  function set(element, name, value) {
    if (!saved.has(element)) saved.set(element,new Map());
    const properties = saved.get(element);
    if (!properties.has(name)) properties.set(name,[element.style.getPropertyValue(name),element.style.getPropertyPriority(name)]);
    if(element.style.getPropertyValue(name)!==value || element.style.getPropertyPriority(name)!=='important')
      element.style.setProperty(name,value,'important');
  }
  function restore() {
    for (const [element,properties] of saved) for (const [name,[value,priority]] of properties) {
      if (value) element.style.setProperty(name,value,priority); else element.style.removeProperty(name);
    }
    saved.clear();
    const last = [...(currentTable?.querySelectorAll('thead th') || [])].filter(item =>
      !item.hidden && item.dataset.type !== 'icon' &&
      currentTable.columns?.find(column => column.id === item.id)?.resizable !== false).at(-1);
    for (const [header,wasResizable] of enabledSplitters) {
      delete header.dataset.gmLastResizable;
      // Native layout enables this column itself if it is no longer last.
      if (header === last && !wasResizable) header.resizable = false;
    }
    enabledSplitters.clear();
  }
  function fit() {
    frame = null;
    if (closed || manualWidth === tree.clientWidth) return;
    manualWidth = null;
    const table = tree.table;
    const width = tree.clientWidth;
    if (!table || width <= 0) return;
    if (table !== currentTable) {restore();preferred.clear();currentTable=table;}
    const headers = [...table.querySelectorAll('thead th')].filter(header =>
      !header.hidden && win.getComputedStyle(header).display !== 'none');
    const lastResizable = headers.filter(header => header.dataset.type !== 'icon' &&
      table.columns?.find(column => column.id === header.id)?.resizable !== false).at(-1);
    for (const header of enabledSplitters.keys()) if (header !== lastResizable) {
      delete header.dataset.gmLastResizable;
      enabledSplitters.delete(header);
    }
    if (lastResizable && typeof lastResizable.resizable === 'boolean') {
      if (!enabledSplitters.has(lastResizable)) enabledSplitters.set(lastResizable,lastResizable.resizable);
      if(lastResizable.dataset.gmLastResizable!=='true')lastResizable.dataset.gmLastResizable = 'true';
      if (!lastResizable.resizable) lastResizable.resizable = true;
    }
    for (const header of headers) {
      const value=parseFloat(header.style.getPropertyValue(`--${header.id}Splitter-width`));
      if(Number.isFinite(value) && value>0){
        preferred.set(header.id,value);
        const properties=saved.get(header);
        if(properties?.has(`--${header.id}Splitter-width`))properties.set(`--${header.id}Splitter-width`,[`${value}px`,'']);
      }
    }
    const subject = headers.find(header=>header.id==='subjectCol');
    const date = headers.find(header=>header.id==='dateCol');
    if (!subject || !date) return;
    const icons = headers.filter(header=>header.dataset.type==='icon');
    const fixed = icons.reduce((sum,header)=>sum+header.getBoundingClientRect().width,0);
    const others = headers.filter(header=>header!==subject && header!==date && !icons.includes(header));
    const available = Math.max(0,width-fixed-4);
    const desiredDate = preferred.get('dateCol') ?? Math.max(88,8*(parseFloat(win.getComputedStyle(tree).fontSize)||14));
    const dateWidth = Math.min(desiredDate,Math.max(0,available-Math.min(100,available*.4)));
    const space = Math.max(0,width-fixed-dateWidth-4);
    const desired = others.map(header => preferred.get(header.id) ?? Math.min(180,width*.18));
    const total = desired.reduce((sum,value)=>sum+value,0);
    const budget = Math.max(0,space-Math.min(100,space));
    const ratio = total > budget ? budget/total : 1;
    const widths = desired.map(value=>value*ratio);
    const subjectWidth = Math.max(0,space-widths.reduce((sum,value)=>sum+value,0));
    for (const [header,pixels] of [[date,dateWidth],[subject,subjectWidth],...others.map((header,index)=>[header,widths[index]])]) {
      set(header,'width',`${pixels}px`); set(header,'inline-size',`${pixels}px`);
      set(header,'min-inline-size','0');
    }
    set(table,'width',`${width}px`); set(table,'inline-size',`${width}px`);
    set(table,'max-inline-size',`${width}px`); set(table,'min-inline-size','0');
    set(table,'flex',`0 1 ${width}px`);
  }
  function schedule() { if (!closed && frame === null) frame=win.requestAnimationFrame(fit); }
  function manualResize(event) {
    const splitter = event.target.closest?.('hr[is="pane-splitter"]');
    if (!splitter) return;
    // Hand the native splitter the CURRENT geometry, never the old wide layout.
    manualWidth = tree.clientWidth;
    if (frame !== null) { win.cancelAnimationFrame(frame); frame = null; }
    const headers = [...(tree.table?.querySelectorAll('thead th') || [])].filter(header =>
      !header.hidden && header.dataset.type !== 'icon' && win.getComputedStyle(header).display !== 'none');
    const widths = headers.map(header=>header.getBoundingClientRect().width);
    dragWidths = new Map(headers.map((header,index)=>[header.id,widths[index]]));
    subjectDrag = splitter.resizeElement?.id === 'subjectCol' && Number.isFinite(event.clientX) ?
      {x:event.clientX,date:headers.find(header=>header.id==='dateCol'),rtl:win.getComputedStyle(tree).direction==='rtl'} : null;
    headers.forEach((header,index) => {
      const variable = `--${header.id}Splitter-width`;
      set(header,variable,`${widths[index]}px`);
      set(header,'width',`var(${variable})`);
      set(header,'inline-size',`var(${variable})`);
    });
  }
  function resizingSubject(event) {
    if (!subjectDrag?.date || !dragWidths) return;
    const delta = (event.clientX-subjectDrag.x)*(subjectDrag.rtl?-1:1);
    // Balance while dragging: a fixed-width HTML table would otherwise give
    // the freed space straight back to Subject before the native splitter reads it.
    const width = Math.max(48,Math.min(dragWidths.get('dateCol')+dragWidths.get('subjectCol')-100,
      dragWidths.get('dateCol')-delta));
    subjectDrag.date.style.setProperty('--dateColSplitter-width',`${width}px`);
    subjectDrag.width = width;
  }
  function finishResize() {
    if (manualWidth === null) return;
    if (Number.isFinite(subjectDrag?.width) && Math.abs(subjectDrag.width-dragWidths.get('dateCol')) >= 1) {
      tree.table?.setColumnsWidths?.('messenger',{detail:{column:'dateCol',splitter:{width:subjectDrag.width}}});
    }
    manualWidth = null;
    subjectDrag = null;
    schedule();
  }
  function resizedColumn(event) {
    const {column,splitter} = event.detail || {};
    // Subject fills the remaining space. Its native divider must redistribute
    // that space to Date rather than have the next fit undo the user's drag.
    if (column === 'subjectCol' && Number.isFinite(splitter?.width) && dragWidths?.has('dateCol')) {
      const date = [...(tree.table?.querySelectorAll('thead th') || [])].find(item=>item.id==='dateCol');
      const width = Math.max(48,dragWidths.get('dateCol')+dragWidths.get('subjectCol')-splitter.width);
      if (date) {
        date.style.setProperty('--dateColSplitter-width',`${width}px`);
        tree.table.setColumnsWidths?.('messenger',{detail:{column:'dateCol',splitter:{width}}});
      }
    }
    if (column && Number.isFinite(splitter?.width) && splitter.width > 0) {
      preferred.set(column,splitter.width);
      const header = [...(tree.table?.querySelectorAll('thead th') || [])].find(item=>item.id===column);
      const properties = saved.get(header);
      if (properties) {
        // Keep the native choice when removing our temporary sizing styles.
        properties.set(`--${column}Splitter-width`,[`${splitter.width}px`,'']);
        properties.set('width',[`var(--${column}Splitter-width)`,'']);
      }
    }
    // Refit after the native drag finishes, including a drag of the last
    // column: its preferred width must not push the table beyond the pane.
    manualWidth = null;
    dragWidths = null;
    subjectDrag = null;
    schedule();
  }
  tree.addEventListener('pointerdown',manualResize,true);
  tree.addEventListener('column-resized',resizedColumn);
  win.addEventListener?.('mousemove',resizingSubject,true);
  win.addEventListener?.('mouseup',finishResize);
  const resize = new win.ResizeObserver(schedule); resize.observe(tree);
  const changes = new win.MutationObserver(records=>{
    // Row text, previews and recycled cells do not change the column layout.
    if(records.some(record=>record.target===tree || record.target===tree.table ||
      record.target.closest?.('thead')))schedule();
  });
  changes.observe(tree,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','data-resizable']});
  tree.addEventListener('viewchange',schedule);
  schedule();
  return {close(){closed=true;resize.disconnect();changes.disconnect();if(frame!==null)win.cancelAnimationFrame(frame);
    win.removeEventListener?.('mousemove',resizingSubject,true);win.removeEventListener?.('mouseup',finishResize);
    tree.removeEventListener('pointerdown',manualResize,true);tree.removeEventListener('column-resized',resizedColumn);
    tree.removeEventListener('viewchange',schedule);restore();}};
}

// Copy view includes the visible column layout, using Thunderbird's own folder
// propagation (including its From/Recipient swap for outgoing folders).
// Folder layouts are independent: Drafts/Sent may never have had selection
// enabled. Keep native checkboxes available before native templates are built.
function installSelectionColumn(win) {
  const pane=win.threadPane,original=pane?.updateColumns;
  if(typeof original!=='function')return {close(){}};
  const saved=new WeakMap();
  function enable() {
    const columns=pane.columns;
    if(!Array.isArray(columns))return;
    const index=columns.findIndex(column=>column.id==='selectCol');
    if(index<0)return;
    const column=columns[index];
    if(!saved.has(columns))saved.set(columns,{column,index,hidden:column.hidden});
    column.hidden=false;
    if(index>0){columns.splice(index,1);columns.unshift(column);return true;}
    return false;
  }
  function updateColumns(...args) {
    const moved=enable();
    // Moving the checkbox column requires a full header rebuild.
    return original.call(this,moved?false:args[0],...args.slice(1));
  }
  pane.updateColumns=updateColumns;
  updateColumns.call(pane);
  win.document.getElementById('threadTree')?.reset?.();
  return {close(){
    if(pane.updateColumns!==updateColumns)return;
    pane.updateColumns=original;
    const columns=pane.columns,state=saved.get(columns);
    if(state){
      const index=columns.indexOf(state.column);
      if(index>=0){columns.splice(index,1);columns.splice(state.index,0,state.column);state.column.hidden=state.hidden;}
      original.call(pane);
      win.document.getElementById('threadTree')?.reset?.();
    }
  }};
}

// Search lists have their own native defaults instead of a folder's saved
// layout. Apply the same Gmail column arrangement without persisting it.
function installSearchColumns(win) {
  const pane=win.threadPane,original=pane?.updateColumns,saved=new WeakMap();
  if(typeof original!=='function')return {close(){}};
  function update(...args){
    const columns=pane.columns;
    if(win.gViewWrapper?.isSynthetic && Array.isArray(columns)){
      if(!saved.has(columns))saved.set(columns,columns.map(column=>({column,hidden:column.hidden,ordinal:column.ordinal})));
      const order=['selectCol','threadCol','flaggedCol','senderCol','subjectCol','attachmentCol','dateCol'];
      for(const column of columns)column.hidden=!order.includes(column.id);
      columns.sort((a,b)=>(order.includes(a.id)?order.indexOf(a.id):order.length)-(order.includes(b.id)?order.indexOf(b.id):order.length));
      columns.forEach((column,index)=>{column.ordinal=index+1});
      return original.call(this,false,...args.slice(1));
    }
    return original.apply(this,args);
  }
  pane.updateColumns=update;update.call(pane);win.document.getElementById('threadTree')?.reset?.();
  return {close(){
    if(pane.updateColumns!==update)return;pane.updateColumns=original;
    const snapshot=saved.get(pane.columns);if(snapshot){pane.columns.splice(0,pane.columns.length,...snapshot.map(item=>item.column));for(const item of snapshot){item.column.hidden=item.hidden;item.column.ordinal=item.ordinal;}original.call(pane);win.document.getElementById('threadTree')?.reset?.();}
  }};
}

function installCompleteViewCopy(win) {
  const pane=win.threadPane, original=pane?._applyView;
  if(typeof original!=='function' || typeof pane._applyColumns!=='function')return {close(){}};
  function applyView(folder,useChildren=false){
    if(!win.gFolder || !folder)return;
    pane._applyColumns(folder,useChildren);
    return original.call(this,folder,useChildren);
  }
  pane._applyView=applyView;
  return {close(){if(pane._applyView===applyView)pane._applyView=original;}};
}

function installThreadToggles(win) {
  const tree=win.document.getElementById('threadTree');
  if(!tree?.expandRowAtIndex || !tree.collapseRowAtIndex)return {close(){}};
  function threadRow(event) {
    if(event.button!==0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)return null;
    const row=event.target.closest?.('.twisty')?.closest('tr.table-layout, tr.card-layout');
    return row && tree.contains(row) && !row.hasAttribute('data-gm-outside-page') ? row : null;
  }
  function click(event) {
    const row=threadRow(event),view=win.gDBView;
    if(!row || !view?.isContainer(row.index))return;
    // The native row-click handler ignores detail=0 (button activation) and
    // detail>1 (rapid clicks). Each arrow activation must toggle exactly once.
    event.preventDefault();event.stopImmediatePropagation();
    if(view.isContainerOpen(row.index))tree.collapseRowAtIndex(row.index);
    else {
      const added=tree.expandRowAtIndex(row.index);
      tree.scrollExpandedRowIntoView?.(row.index,added);
    }
    tree.ensureCorrectFocus?.();
  }
  function doubleClick(event) {
    if(!threadRow(event))return;
    // Both click events have already toggled the thread. Do not let dblclick
    // open a message window or apply a second native thread operation.
    event.preventDefault();event.stopImmediatePropagation();
  }
  tree.addEventListener('click',click,true);
  tree.addEventListener('dblclick',doubleClick,true);
  return {close(){
    tree.removeEventListener('click',click,true);
    tree.removeEventListener('dblclick',doubleClick,true);
  }};
}

function threadGuidePosition(view,index) {
  if(!view || !Number.isInteger(index) || index<0 || index>=view.rowCount)return null;
  try {
    if((view.getFlagsAt?.(index) || 0)&0x20000000)return null;
    const level=view.getLevel(index),next=index+1<view.rowCount?view.getLevel(index+1):0;
    if(level>0)return next>0?'middle':'end';
    if(view.isContainer(index) && view.isContainerOpen(index) && next>0)return 'start';
  }catch(_){/* A changing native view can briefly invalidate a virtual row. */}
  return null;
}

function installCollapsedThreadDefaults(win) {
  const listener=win.dbViewWrapperListener;
  if(!listener?.onCreatedView || !listener.onMessagesLoaded)return {close(){}};
  const created=listener.onCreatedView,loaded=listener.onMessagesLoaded;
  const completed=new WeakSet();
  function collapse() {
    const view=win.gDBView,wrapper=win.gViewWrapper;
    if(!view || !wrapper?.showThreaded || wrapper.showGroupedBySort)return;
    wrapper._threadExpandAll=false;
    view.doCommand(Ci.nsMsgViewCommandType.collapseAll);
  }
  function onCreatedView(...args) {
    if(win.gViewWrapper?.showThreaded && !win.gViewWrapper.showGroupedBySort)
      win.gViewWrapper._threadExpandAll=false;
    const result=created.apply(this,args);
    collapse();
    return result;
  }
  function onMessagesLoaded(all,...args) {
    const result=loaded.call(this,all,...args),view=win.gDBView;
    // Native search and selection restoration can re-expand threads during
    // loading. Apply the default once, then allow the user to expand freely.
    if(all && view && !completed.has(view)){completed.add(view);collapse();}
    return result;
  }
  listener.onCreatedView=onCreatedView;listener.onMessagesLoaded=onMessagesLoaded;
  collapse();
  if(win.gDBView && listener.allMessagesLoaded)completed.add(win.gDBView);
  return {close(){
    if(listener.onCreatedView===onCreatedView)listener.onCreatedView=created;
    if(listener.onMessagesLoaded===onMessagesLoaded)listener.onMessagesLoaded=loaded;
  }};
}

function installInboxControls(win,{threadGuides=true,reader=null}={}) {
  const doc = win.document;
  const tree = doc.getElementById('threadTree');
  if (!tree) return {close(){}};
  const compose = installComposeLabel(doc);
  const selectionColumn=installSelectionColumn(win);
  const searchColumns=installSearchColumns(win);
  const idleActions=installInboxIdleActions(win,reader);
  const responsive = installResponsiveColumns(win);
  const viewCopy = installCompleteViewCopy(win);
  const newMessage = installInlineNewMessage(win);
  const threadToggles = installThreadToggles(win);
  const threadDefaults = installCollapsedThreadDefaults(win);
  let closed = false, prototype, original, wrapped, rowClass, originalHeight;
  let showThreadGuides=threadGuides===true;
  function renderThreadGuide(row) {
    delete row.dataset.gmThreadGuide;
    if(!showThreadGuides || (row.dataset.properties || '').split(' ').includes('dummy') ||
      win.gViewWrapper?.showGroupedBySort || win.gViewWrapper?.showThreaded===false)return;
    const position=threadGuidePosition(win.gDBView,row.index);
    if(position)row.dataset.gmThreadGuide=position;
  }
  function setThreadGuides(enabled) {
    showThreadGuides=enabled===true;
    if(!closed)for(const row of doc.querySelectorAll('#threadTree tr.table-layout'))renderThreadGuide(row);
  }
  const previews = createPreviewQueue(win);
  const filter = win.quickFilterBar;
  const wasVisible = filter?.filterer?.visible;
  if (filter?._showFilterBar) filter._showFilterBar(false);
  const style = doc.createElement('style');
  style.textContent = `
    #quick-filter-bar .quickFilterButtons {
      gap:6px; flex-wrap:wrap; border:0 !important; box-shadow:none !important;
    }
    #quick-filter-bar :is(#qfb-unread,#qfb-starred,#qfb-tags,#qfb-attachment,#qfb-inaddrbook) {
      border:0 !important; box-shadow:none !important; border-radius:18px !important;
      padding:6px 12px 6px 32px !important;
      background-color:transparent; color:inherit;
      background-size:16px !important; background-repeat:no-repeat !important;
      background-position:10px center !important;
      -moz-context-properties:fill,stroke; fill:currentColor; stroke:currentColor;
    }
    #quick-filter-bar .quickFilterButtons button:dir(rtl) {
      padding-inline:32px 12px !important; background-position:right 10px center !important;
    }
    #quick-filter-bar .quickFilterButtons button span { display:inline !important; }
    #quick-filter-bar .quickFilterButtons button:hover { background-color:var(--gm-hover, ButtonFace); }
    #quick-filter-bar .quickFilterButtons button[aria-pressed="true"] {
      background-color:var(--gm-selected, Highlight); color:var(--gm-selection-ink, HighlightText);
    }
    #threadTree .subject-line.gm-has-snippet > span:not(.gm-inline-labels) {
      flex:0 1 auto !important; max-width:65%; min-width:32px;
    }
    #threadTree .gm-message-snippet {
      flex:1 1 0; min-width:0; margin-inline-start:6px; overflow:hidden;
      white-space:nowrap; text-overflow:ellipsis; font-weight:400;
      color:var(--gm-snippet, #9aa0a6) !important;
      font-weight:400 !important;
    }
    #threadTree .gm-row-actions {
      display:none; flex:0 0 auto; gap:2px; margin-inline-start:auto;
      pointer-events:auto;
    }
    #threadTree tr:is(:hover,:has(.gm-row-actions button:focus-visible)) .gm-row-actions {
      display:flex !important;
    }
    #threadTree[data-gm-smart-action-done] .gm-row-actions { display:none !important; }
    #threadTree .gm-row-actions button {
      display:inline-flex !important; align-items:center; justify-content:center;
      pointer-events:auto; flex:0 0 auto; box-sizing:border-box;
      width:28px; height:28px; padding:5px; border:0; border-radius:50%;
      background:transparent; color:inherit; cursor:pointer;
    }
    #threadTree .gm-row-actions button:hover { background:var(--gm-selected, ButtonFace); }
    #threadTree .gm-row-actions button:focus-visible { outline:2px solid Highlight; }
    #threadTree .gm-row-actions svg { width:18px; height:18px; }
    #threadTree tr:is(:hover,:has(.gm-row-actions button:focus-visible)) .subject-line > span:not(.gm-inline-labels) {
      min-width:0 !important;
    }
    @media (hover:none) { #threadTree .gm-row-actions { display:flex; } }
    @media (prefers-contrast:more) {
      #threadTree .gm-message-snippet { color:CanvasText !important; }
      #quick-filter-bar .quickFilterButtons button[aria-pressed="true"] { background:Highlight; color:HighlightText; }
    }
  `;
  doc.head.append(style);
  function render(row) {
    renderThreadGuide(row);
    row.querySelector('.gm-row-actions')?.remove();
    row.querySelector('.gm-message-snippet')?.remove();
    row.querySelector('.subject-line')?.classList?.remove('gm-has-snippet');
    if ((row.dataset.properties || '').split(' ').includes('dummy')) return;
    const line = row.querySelector('.subject-line');
    if (!line) return;
    let header;
    try { header = win.gDBView?.getMsgHdrAt(row.index); } catch (_) { return; }
    if (!header) return;
    const view = win.gDBView, index = row.index;
    const isCurrent = () => {
      if (closed || row.index !== index || win.gDBView !== view) return false;
      try {
        const current = view.getMsgHdrAt(index);
        return current?.messageKey === header.messageKey && current?.folder?.URI === header.folder?.URI;
      } catch (_) { return false; }
    };
    function showPreview(text) {
      if (!text || !isCurrent()) return;
      line.querySelector('.gm-message-snippet')?.remove();
      const snippet = doc.createElement('div');
      snippet.className = 'gm-message-snippet';
      snippet.textContent = '— ' + text;
      snippet.title = text;
      line.classList.add('gm-has-snippet');
      const actions = line.querySelector('.gm-row-actions');
      if (actions) line.insertBefore(snippet, actions);
      else line.append(snippet);
    }
    const preview = previews.get(header, isCurrent, () => {
      // Update only the snippet: replacing action buttons here would steal
      // keyboard focus while the user is interacting with the row.
      showPreview(previews.get(header,isCurrent,()=>{}));
    });
    showPreview(preview);
    const actions = doc.createElement('div');
    actions.className = 'gm-row-actions';
    const commands = [
      ['Archive conversation', 'cmd_archive', 'M4 8h16v13H4z M3 3h18v5H3z M9 12h6'],
      ['Delete conversation', 'cmd_deleteMessage', 'M5 6h14 M9 6V3h6v3 M7 6l1 15h8l1-15'],
      [header.isRead ? 'Mark conversation as unread' : 'Mark conversation as read',
        header.isRead ? 'cmd_markAsUnread' : 'cmd_markAsRead', 'M3 5h18v14H3z M3 6l9 7 9-7']
    ];
    for (const [label, command, path] of commands) {
      const button = doc.createElement('button');
      button.type = 'button'; button.title = label;
      button.setAttribute('aria-label', label);
      const svg = doc.createElementNS('http://www.w3.org/2000/svg','svg');
      svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('fill','none');
      svg.setAttribute('stroke','currentColor'); svg.setAttribute('stroke-width','1.8');
      svg.setAttribute('aria-hidden','true');
      const shape = doc.createElementNS(svg.namespaceURI,'path');
      shape.setAttribute('d',path); svg.append(shape); button.append(svg);
      button.addEventListener('mousedown', event => event.stopPropagation());
      button.addEventListener('dblclick', event => event.stopPropagation());
      button.addEventListener('click', event => {
        event.preventDefault(); event.stopPropagation();
        button.blur();
        if (!closed) runRowAction(win, row, command, {key:header.messageKey, folderURI:header.folder?.URI},reader);
      });
      actions.append(button);
    }
    line.append(actions);
  }
  win.customElements.whenDefined('thread-row').then(() => {
    if (closed) return;
    rowClass = win.customElements.get('thread-row');
    originalHeight = rowClass.ROW_HEIGHT;
    if (Number.isFinite(originalHeight)) rowClass.ROW_HEIGHT = originalHeight + 6;
    prototype = rowClass.prototype;
    original = prototype.fillRow;
    wrapped = function(...args) {
      const result = original.apply(this,args);
      render(this);
      return result;
    };
    prototype.fillRow = wrapped;
    if (Number.isFinite(originalHeight)) tree.reset();
    for (const row of doc.querySelectorAll('#threadTree tr.table-layout')) render(row);
  });
  let clearingSmartSelection=false;
  function clearSmartSelection(event){
    if(!tree._gmSmartActionPending || clearingSmartSelection)return;
    event.stopImmediatePropagation?.();
    if(!tree.selectedIndices?.length)return;
    clearingSmartSelection=true;
    try{if(reader)reader.selectIndices([]);else tree.selectedIndices=[];}
    finally{clearingSmartSelection=false;}
  }
  function resumeSelection(){tree._gmSmartActionPending=false;}
  function resumeHover(event){
    const focused=doc.activeElement;
    const focusedActions=focused?.closest?.('.gm-row-actions');
    const hoveredRow=event.target?.closest?.('tr.table-layout, tr.card-layout');
    if(focusedActions && focusedActions.closest('tr')!==hoveredRow)focused.blur();
    tree.removeAttribute?.('data-gm-smart-action-done');
  }
  tree.addEventListener('select',clearSmartSelection,true);
  tree.addEventListener('pointerdown',resumeSelection,true);
  tree.addEventListener('keydown',resumeSelection,true);
  tree.addEventListener('pointermove',resumeHover);
  function close() {
    if (closed) return;
    closed = true;
    tree.removeEventListener('select',clearSmartSelection,true);
    tree.removeEventListener('pointerdown',resumeSelection,true);
    tree.removeEventListener('keydown',resumeSelection,true);
    tree.removeEventListener('pointermove',resumeHover);
    delete tree._gmSmartActionPending;tree.removeAttribute?.('data-gm-smart-action-done');
    if (prototype?.fillRow === wrapped) prototype.fillRow = original;
    for (const node of doc.querySelectorAll('.gm-row-actions, .gm-message-snippet')) node.remove();
    for (const line of doc.querySelectorAll('.gm-has-snippet')) line.classList.remove('gm-has-snippet');
    for (const row of doc.querySelectorAll('#threadTree tr.table-layout')) delete row.dataset.gmThreadGuide;
    style.remove();
    previews.close();
    compose.close();
    responsive.close();
    viewCopy.close();
    newMessage.close();idleActions.close();searchColumns.close();selectionColumn.close();
    threadToggles.close();
    threadDefaults.close();
    if (rowClass && Number.isFinite(originalHeight) && rowClass.ROW_HEIGHT === originalHeight + 6) {
      rowClass.ROW_HEIGHT = originalHeight;
      tree.reset();
    }
    if (wasVisible !== undefined) filter._showFilterBar(wasVisible);
    win.removeEventListener('unload',close);
    win.removeEventListener('focus',refreshPreviews);
  }
  function refreshPreviews() {
    if (!closed) for (const row of doc.querySelectorAll('#threadTree tr.table-layout')) render(row);
  }
  win.addEventListener('focus',refreshPreviews);
  win.addEventListener('unload',close,{once:true});
  return {close,setThreadGuides};
}
