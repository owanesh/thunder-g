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

function createPreviewQueue(win) {
  const cache = new Map(), jobs = new Map();
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
      const text = localMessagePreview(job.header);
      if (cache.size >= 300) cache.delete(cache.keys().next().value);
      cache.set(key, {text, flags:job.header.flags, retryAt:Date.now()+30000});
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
      const found = cache.get(key);
      if (found && (found.text || (found.retryAt > Date.now() && found.flags === header.flags))) return found.text;
      // Keep the queue bounded when scrolling through many virtual rows.
      if (jobs.size >= 100 && !jobs.has(key)) jobs.delete(jobs.keys().next().value);
      jobs.set(key,{header,isCurrent,ready}); schedule();
      return '';
    },
    close() {
      closed = true;
      if (timer !== null) win.clearTimeout(timer);
      timer = null; jobs.clear(); cache.clear();
    }
  };
}

function runRowAction(win, row, name, expected) {
  if (!row || row.index < 0 || (row.dataset.properties || '').split(' ').includes('dummy')) return;
  let header;
  try { header = win.gDBView?.getMsgHdrAt(row.index); } catch (_) { return; }
  if (!header || (expected && (header.messageKey !== expected.key || header.folder?.URI !== expected.folderURI))) return;
  // Replace any earlier multi-selection. A collapsed row retains Thunderbird's
  // native conversation scope; unrelated selected rows are never included.
  win.document.getElementById('threadTree').selectedIndex = row.index;
  if (win.commandController.isCommandEnabled(name)) win.commandController.doCommand(name);
}

function installComposeLabel(doc) {
  const button = doc.getElementById('folderPaneWriteMessage');
  if (!button?.getAttribute) return {close(){}};
  const attributes = ['data-l10n-id', 'data-l10n-args', 'aria-label'];
  const saved = attributes.map(name => [name, button.getAttribute(name)]);
  const text = button.textContent;
  button.removeAttribute('data-l10n-id');
  button.removeAttribute('data-l10n-args');
  button.textContent = 'Write';
  button.setAttribute('aria-label', 'Write a new message');
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

function installInboxControls(win) {
  const doc = win.document;
  const tree = doc.getElementById('threadTree');
  if (!tree) return {close(){}};
  const compose = installComposeLabel(doc);
  const responsive = installResponsiveColumns(win);
  const viewCopy = installCompleteViewCopy(win);
  const newMessage = installInlineNewMessage(win);
  const threadToggles = installThreadToggles(win);
  let closed = false, prototype, original, wrapped, rowClass, originalHeight;
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
    #threadTree tr:is(:hover,:focus-within) .gm-row-actions {
      display:flex !important;
    }
    #threadTree .gm-row-actions button {
      display:inline-flex !important; align-items:center; justify-content:center;
      pointer-events:auto; flex:0 0 auto; box-sizing:border-box;
      width:28px; height:28px; padding:5px; border:0; border-radius:50%;
      background:transparent; color:inherit; cursor:pointer;
    }
    #threadTree .gm-row-actions button:hover { background:var(--gm-selected, ButtonFace); }
    #threadTree .gm-row-actions button:focus-visible { outline:2px solid Highlight; }
    #threadTree .gm-row-actions svg { width:18px; height:18px; }
    #threadTree tr:is(:hover,:focus-within) .subject-line > span:not(.gm-inline-labels) {
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
        if (!closed) runRowAction(win, row, command, {key:header.messageKey, folderURI:header.folder?.URI});
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
  function close() {
    if (closed) return;
    closed = true;
    if (prototype?.fillRow === wrapped) prototype.fillRow = original;
    for (const node of doc.querySelectorAll('.gm-row-actions, .gm-message-snippet')) node.remove();
    for (const line of doc.querySelectorAll('.gm-has-snippet')) line.classList.remove('gm-has-snippet');
    style.remove();
    previews.close();
    compose.close();
    responsive.close();
    viewCopy.close();
    newMessage.close();
    threadToggles.close();
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
  return {close};
}
