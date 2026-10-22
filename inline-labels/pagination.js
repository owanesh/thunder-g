/* Page boundaries on the original virtual tree; indices and renderer stay native. */
function nativePageBounds(total, size, page) {
  const pages=Math.max(1,Math.ceil(total/size));
  page=Math.min(Math.max(0,page),pages-1);
  return {page,pages,start:page*size,end:Math.min(total,(page+1)*size)};
}
function mailZoomAction(event) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.defaultPrevented || event.isComposing ||
      event.target?.isContentEditable || event.target?.closest?.('input,textarea,select,[contenteditable="true"],[role="textbox"]')) return null;
  if (event.key === '+' || event.key === '=' || event.code === 'NumpadAdd') return 'increaseSize';
  if (event.key === '-' || event.code === 'NumpadSubtract') return 'reduceSize';
  if (event.key === '0' || event.code === 'Numpad0') return 'resetSize';
  return null;
}
function installMailZoom(win, fontSize) {
  function keydown(event) {
    const tab=win.document.getElementById('tabmail')?.currentTabInfo;
    if (tab && tab.mode?.name !== 'mail3PaneTab') return;
    const action=mailZoomAction(event);
    if (!action) return;
    event.preventDefault(); event.stopImmediatePropagation(); fontSize[action]();
  }
  win.addEventListener('keydown',keydown,true);
  return {close(){win.removeEventListener('keydown',keydown,true)}};
}
function installNativePagination(win, reader) {
  const doc=win.document, tree=doc.getElementById('threadTree');
  if (!tree?.parentNode) return {setSize(){},close(){}};
  let size=0,page=0,frame=null,closed=false,lastView=null;
  const bar=doc.createElement('div');bar.className='gm-native-pagination';bar.hidden=true;
  bar.setAttribute('role','navigation');bar.setAttribute('aria-label','Message pages');
  const count=doc.createElement('span');count.setAttribute('aria-live','polite');
  const previous=doc.createElement('button'),next=doc.createElement('button');
  for(const [button,label,glyph] of [[previous,'Previous page','‹'],[next,'Next page','›']]) {
    button.type='button';button.title=label;button.setAttribute('aria-label',label);button.textContent=glyph;
  }
  bar.append(count,previous,next);
  const quickFilter=doc.getElementById('threadPaneQuickFilterButton');
  if(quickFilter) quickFilter.after(bar);
  else tree.before(bar);
  // Extra scroll room allows a short final page to begin beneath the native header.
  const tail=doc.createElement('div');tail.setAttribute('aria-hidden','true');tail.hidden=true;
  tail.style.cssText='position:absolute;inset-inline-start:0;inline-size:1px;pointer-events:none;';tree.append(tail);
  // Keep native global row indices, but expose a scrollbar whose extent is
  // only the current page. The native tree still renders and selects messages.
  const pageScroll=doc.createElement('div');pageScroll.className='gm-page-scroll';pageScroll.hidden=true;
  pageScroll.setAttribute('aria-label','Scroll current message page');
  const pageExtent=doc.createElement('div');pageExtent.style.inlineSize='1px';pageScroll.append(pageExtent);
  doc.documentElement.append(pageScroll);
  const style=doc.createElement('style');style.textContent=`
    .gm-native-pagination[hidden] { display:none !important; }
    .gm-native-pagination { display:inline-flex !important; justify-content:flex-end; align-items:center;
      gap:.25em; padding:0; margin-inline-start:.5em; flex:0 0 auto !important;
      inline-size:auto !important; color:inherit; font:inherit; white-space:nowrap; }
    .gm-native-pagination > span { margin-inline-end:.35em; font-size:.9em; }
    .gm-native-pagination > button { appearance:none !important; box-sizing:border-box !important;
      display:inline-flex !important; align-items:center; justify-content:center;
      flex:0 0 2em !important; inline-size:2em !important; min-inline-size:2em !important; max-inline-size:2em !important;
      block-size:2em !important; min-block-size:2em !important; max-block-size:2em !important;
      padding:0 !important; margin:0 !important; font:inherit !important; line-height:1 !important;
      background:transparent; color:inherit; border:0 !important; border-radius:50% !important;
      box-shadow:none !important; cursor:pointer; }
    .gm-native-pagination > button:hover:enabled { background:var(--treeitem-background-hover,#e9eef6); }
    .gm-native-pagination > button:focus-visible { outline:2px solid var(--focus-outline-color,#1a73e8); outline-offset:-2px; }
    .gm-native-pagination > button:disabled { opacity:.35;cursor:default;background:transparent; }
    #threadTree[data-gm-paginated] { scroll-behavior:auto !important; overflow-anchor:none !important; scrollbar-width:none !important; }
    .gm-page-scroll { position:fixed; z-index:2; overflow-y:scroll; overflow-x:hidden;
      scrollbar-width:auto; scrollbar-color:auto; width:16px; }
    .gm-page-scroll[hidden] { display:none !important; }
    #threadTree tr[data-gm-outside-page] { visibility:hidden !important; pointer-events:none !important; }
  `;doc.head.append(style);
  function bounds(){return nativePageBounds(win.gDBView?.rowCount || 0,size,page)}
  function rowHeight(){return tree._rowElementClass?.ROW_HEIGHT || tree.getRowAtIndex?.(0)?.getBoundingClientRect().height || 0}
  function paint(alignStart=false) {
    if (!size || closed) return;
    if (lastView!==win.gDBView) {lastView=win.gDBView;page=0;alignStart=true}
    // rowCount excludes children of collapsed threads; numMsgsInView includes
    // them. Expand before calculating boundaries so every message is reachable.
    // Recheck on each paint: users and native view updates can collapse threads.
    const view=win.gDBView;
    if(view && view.rowCount<view.numMsgsInView) {
      win.threadPane?.saveSelection();
      view.doCommand(Ci.nsMsgViewCommandType.expandAll);
      win.threadPane?.restoreSelection();
    }
    const range=bounds();page=range.page;
    const total=win.gDBView?.rowCount || 0;
    count.textContent=total?`${(range.start+1).toLocaleString()}–${range.end.toLocaleString()} of ${total.toLocaleString()}`:'0 of 0';
    previous.disabled=page===0;next.disabled=page===range.pages-1;
    const height=rowHeight();
    if(height && tree.clientHeight) {
      const header=doc.querySelector('#threadTree thead')?.getBoundingClientRect().height || 0;
      // threadTree is a ROW flex container: a normal child sits beside the
      // table and adds no vertical scroll room. Extend the scroll area below
      // the native table only by the deficit needed to align this page.
      const tableEnd=total*height+header;
      tail.style.top=tableEnd+'px';
      tail.style.height=Math.max(0,range.start*height+tree.clientHeight-tableEnd)+'px';
      const min=range.start*height,max=Math.max(min,range.end*height+header-tree.clientHeight);
      const top=alignStart?min:Math.min(Math.max(tree.scrollTop,min),max);
      const rect=tree.getBoundingClientRect();
      const viewport=Math.max(0,tree.clientHeight-header);
      pageScroll.hidden=max===min || tree.checkVisibility?.()===false;
      pageScroll.style.top=(rect.top+header)+'px';
      pageScroll.style.left=(doc.documentElement.dir==='rtl'?rect.left:rect.right-16)+'px';
      pageScroll.style.height=viewport+'px';
      pageExtent.style.height=((range.end-range.start)*height)+'px';
      if(Math.abs((pageScroll.scrollTop || 0)-(top-min))>.5) pageScroll.scrollTop=top-min;
      // A page change is a jump, never a smooth scroll through hidden rows.
      // Compute the short-page tail first, then move once; cancel any native
      // animation that was already running even when the destination matches.
      if(alignStart || Math.abs(tree.scrollTop-top)>.5) tree.scrollTo({top,behavior:'instant'});
    }
    for(const row of tree.querySelectorAll('tr.table-layout, tr.card-layout')) {
      row.toggleAttribute('data-gm-outside-page',row.index<range.start || row.index>=range.end);
    }
  }
  function scrollPage(){
    if(!size || closed || pageScroll.hidden)return;
    const range=bounds(),height=rowHeight();
    tree.scrollTo({top:range.start*height+pageScroll.scrollTop,behavior:'instant'});
    schedule();
  }
  pageScroll.addEventListener('scroll',scrollPage);
  win.addEventListener('resize',schedule);
  function schedule(){
    if (!size || closed || frame!==null) return;
    frame=win.requestAnimationFrame(()=>{frame=null;paint()});
  }
  function turn(direction) {
    if(!size) return;
    const range=bounds(),target=page+direction;
    if(target<0 || target>=range.pages) return;
    reader.selectIndices([]);page=target;
    paint(true);
  }
  previous.addEventListener('click',()=>turn(-1));next.addEventListener('click',()=>turn(1));
  function viewChanged(){lastView=null;page=0;schedule()}
  function selectionChanged(){
    if(size) {
      const index=tree.currentIndex;
      // Native keyboard/reader navigation may move to a message on another page.
      if(Number.isInteger(index) && index>=0 && (tree.selectedIndices || []).includes(index)) page=Math.floor(index/size);
    }
    schedule();
  }
  function selectPage(event){
    if(!size || !(event.type==='click'?event.target.closest('#selectColButton'):
      (event.ctrlKey || event.metaKey) && event.key?.toLowerCase()==='a' && !event.target?.closest?.('input,textarea'))) return;
    event.preventDefault();event.stopImmediatePropagation();
    const range=bounds(),indices=[];
    for(let i=range.start;i<range.end;i++) {
      try {if(!(win.gDBView.getFlagsAt(i)&0x20000000)) indices.push(i)}catch(_){}
    }
    const selected=new Set(tree.selectedIndices || []);
    reader.selectIndices(indices.every(i=>selected.has(i))?[]:indices);schedule();
  }
  const observer=new win.MutationObserver(schedule);
  const resize=new win.ResizeObserver(schedule);
  tree.addEventListener('scroll',schedule);tree.addEventListener('viewchange',viewChanged);tree.addEventListener('select',selectionChanged);
  tree.addEventListener('click',selectPage,true);tree.addEventListener('keydown',selectPage,true);
  function clear(){
    observer.disconnect();resize.disconnect();
    if(frame!==null) win.cancelAnimationFrame(frame);frame=null;
    for(const row of tree.querySelectorAll('[data-gm-outside-page]')) row.removeAttribute('data-gm-outside-page');
    pageScroll.hidden=true;tail.hidden=true;tail.style.height='0px';tree.removeAttribute('data-gm-paginated');
  }
  return {
    setSize(value){
      clear();size=[25,50,100].includes(value)?value:0;page=0;lastView=null;bar.hidden=!size;
      if(size) {
        tail.hidden=false;tree.setAttribute('data-gm-paginated','');
        observer.observe(tree,{childList:true,subtree:true,attributes:true,attributeFilter:['aria-rowindex']});
        resize.observe(tree);paint(true);
      }
    },
    close(){
      closed=true;clear();
      tree.removeEventListener('scroll',schedule);tree.removeEventListener('viewchange',viewChanged);tree.removeEventListener('select',selectionChanged);
      tree.removeEventListener('click',selectPage,true);tree.removeEventListener('keydown',selectPage,true);
      win.removeEventListener('resize',schedule);pageScroll.removeEventListener('scroll',scrollPage);
      bar.remove();tail.remove();pageScroll.remove();style.remove();
    }
  };
}
