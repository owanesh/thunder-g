const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const scope=vm.createContext({Ci:{nsMsgViewCommandType:{expandAll:1}}});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../inline-labels/pagination.js'),'utf8'),scope);
test('native page bounds handle empty, short last pages and deletion on last page',()=>{
  const bounds=(...args)=>JSON.parse(JSON.stringify(scope.nativePageBounds(...args)));
  assert.deepEqual(bounds(0,25,0),{page:0,pages:1,start:0,end:0});
  assert.deepEqual(bounds(1014,100,10),{page:10,pages:11,start:1000,end:1014});
  assert.deepEqual(bounds(20,25,9),{page:0,pages:1,start:0,end:20});
});
test('zoom delegates Ctrl/Cmd plus/minus/reset to native controls and leaves text entry alone',()=>{
  const target={closest:()=>null};
  for(const modifier of ['ctrlKey','metaKey']) {
    assert.equal(scope.mailZoomAction({[modifier]:true,key:'+',target}),'increaseSize');
    assert.equal(scope.mailZoomAction({[modifier]:true,key:'=',target}),'increaseSize');
    assert.equal(scope.mailZoomAction({[modifier]:true,key:'-',target}),'reduceSize');
    assert.equal(scope.mailZoomAction({[modifier]:true,key:'0',target}),'resetSize');
  }
  assert.equal(scope.mailZoomAction({key:'+',target}),null);
  assert.equal(scope.mailZoomAction({ctrlKey:true,key:'+',target:{closest:()=>({})}}),null);
  assert.equal(scope.mailZoomAction({ctrlKey:true,key:'+',defaultPrevented:true,target}),null);
  let listener,removed,zoomed=0,stopped=0;
  const win={document:{getElementById:()=>null},addEventListener(name,fn){listener=fn},removeEventListener(name,fn){removed=fn}};
  const zoom=scope.installMailZoom(win,{increaseSize(){zoomed++}});
  listener({ctrlKey:true,key:'+',target,preventDefault(){},stopImmediatePropagation(){stopped++}});
  assert.equal(zoomed,1);assert.equal(stopped,1);zoom.close();assert.equal(removed,listener);
});
for (const collapsed of [false,true,'short-last']) test(`native pagination retains native rows and reaches every message (collapsed threads: ${collapsed})`,()=>{
  function node() {
    const attrs=new Set(),events={};
    return {events,children:[],style:{},hidden:false,
      setAttribute(name){attrs.add(name)},toggleAttribute(name,on){on?attrs.add(name):attrs.delete(name)},
      removeAttribute(name){attrs.delete(name)},hasAttribute:name=>attrs.has(name),
      addEventListener(name,fn){events[name]=fn},removeEventListener(name,fn){if(events[name]===fn)delete events[name]},
      append(...items){this.children.push(...items)},before(item){this.bar=item},remove(){this.removed=true}};
  }
  const total=collapsed==='short-last'?219:collapsed?218:53;
  const rows=Array.from({length:total},(_,index)=>Object.assign(node(),{index}));
  const tree=node();tree.getBoundingClientRect=()=>({top:0,left:260,right:1000});tree.parentNode={};tree.clientHeight=200;tree.scrollTop=0;tree._rowElementClass={ROW_HEIGHT:20};
  if(collapsed==='short-last') {
    tree.clientHeight=900;tree._rowElementClass.ROW_HEIGHT=34;
    let actualTop=0;
    Object.defineProperty(tree,'scrollTop',{get:()=>actualTop,set(value){
      const tail=tree.children[0],tableEnd=nativeView.rowCount*tree._rowElementClass.ROW_HEIGHT+20;
      const tailEnd=tail.hidden?0:parseFloat(tail.style.top || 0)+parseFloat(tail.style.height || 0);
      actualTop=Math.max(0,Math.min(value,Math.max(tableEnd,tailEnd)-tree.clientHeight));
    }});
  }
  const scrolls=[];tree.scrollTo=options=>{scrolls.push({...options,tailHeight:tree.children[0].style.height});assert.equal(options.behavior,'instant');tree.scrollTop=options.top};
  tree.currentIndex=-1;tree.selectedIndices=[];
  tree.querySelectorAll=selector=>selector==='[data-gm-outside-page]'?rows.filter(r=>r.hasAttribute('data-gm-outside-page')):rows;
  let expansions=0;
  const nativeView={rowCount:collapsed===true?195:total,numMsgsInView:total,getFlagsAt:()=>0,
    doCommand(command){assert.equal(command,1);expansions++;this.rowCount=this.numMsgsInView}};tree.view=nativeView;
  const frames=[];let mutation,resize;
  const quickFilter=node();quickFilter.after=bar=>{quickFilter.pagination=bar;tree.bar=bar};
  const root=node();const head=node(),doc={documentElement:root,getElementById:id=>id==='threadPaneQuickFilterButton'?quickFilter:tree,querySelector:()=>({getBoundingClientRect:()=>({height:20})}),createElement:node,head};
  const win={document:doc,gDBView:nativeView,addEventListener(){},removeEventListener(){},
    requestAnimationFrame(fn){frames.push(fn);return frames.length},cancelAnimationFrame(){},
    MutationObserver:class{constructor(fn){mutation=fn}observe(){}disconnect(){}},
    ResizeObserver:class{constructor(fn){resize=fn}observe(){}disconnect(){}}};
  const selections=[];
  const pages=scope.installNativePagination(win,{selectIndices(indices){tree.selectedIndices=indices;selections.push(indices)}});
  assert.equal(quickFilter.pagination,tree.bar,'pager is placed directly beside Quick Filter');
  if(collapsed==='short-last') {
    pages.setSize(100);
    assert.equal(tree.children[0].style.height,'0px','full pages need no extra blank scroll room');
    tree.bar.children[2].events.click();tree.bar.children[2].events.click();
    assert.equal(tree.bar.children[0].textContent,'201–219 of 219');
    assert.equal(scrolls.length,3,'initial positioning and each turn make exactly one instant jump');
    assert.equal(scrolls.at(-1).tailHeight,'234px','short-page extent exists before the only scroll request');
    assert.equal(tree.hasAttribute('data-gm-paginated'),true);
    assert.match(head.children[0].textContent,/scroll-behavior:auto !important/);
    assert.equal(tree.scrollTop,200*34,'browser scroll clamp must still allow the first of the 19 rows to reach the header');
    assert.equal(rows.filter(row=>!row.hasAttribute('data-gm-outside-page')).length,19);
    assert.equal(tree.children[0].style.height,'234px','only the missing scroll height is added, never a full viewport');
    assert.equal(root.children[0].hidden,true,'a final page fitting the viewport has no scrollbar');
    assert.equal(root.children[0].children[0].style.height,'646px','scroll extent counts only the 19 displayed messages');
    tree.scrollTop=999999;tree.events.scroll();frames.shift()();
    assert.equal(tree.scrollTop,200*34,'no blank scrolling past the short final page');
    tree.clientHeight=500;resize();frames.shift()();
    assert.equal(tree.children[0].style.height,'0px','no padding when all 19 rows exceed the viewport');
    assert.equal(tree.scrollTop,200*34);
    tree._rowElementClass.ROW_HEIGHT=20;resize();frames.shift()();
    assert.equal(tree.scrollTop,200*20,'density changes keep the final page aligned');
    assert.equal(tree.children[0].style.height,'100px');
    pages.setSize(0);assert.equal(tree.hasAttribute('data-gm-paginated'),false,'continuous native scrolling is restored');assert.equal(tree.children[0].hidden,true);pages.close();return;
  }
  if(collapsed) {
    pages.setSize(100);
    assert.equal(expansions,1);
    const reached=[];
    for(let page=0;page<3;page++) {
      assert.equal(tree.bar.children[0].textContent,`${page*100+1}–${Math.min(total,(page+1)*100)} of 218`);
      reached.push(...rows.filter(row=>!row.hasAttribute('data-gm-outside-page')).map(row=>row.index));
      if(page<2) tree.bar.children[2].events.click();
    }
    assert.deepEqual(reached,Array.from({length:218},(_,i)=>i),'all 218 messages occur exactly once across pages');
    assert.equal(tree.bar.children[2].disabled,true);
    nativeView.rowCount=195;mutation();frames.shift()();
    assert.equal(nativeView.rowCount,218,'collapsing a thread cannot hide messages from pagination');
    pages.setSize(0);
    nativeView.rowCount=195;
    assert.equal(expansions,2,'disabled pagination does not expand threads');
    pages.close();return;
  }
  const originalRows=rows.slice();pages.setSize(25);
  assert.equal(tree.view,nativeView);assert.equal(rows[0],originalRows[0]);assert.equal(tree.style.cssText,undefined);
  assert.equal(tree._rowElementClass.ROW_HEIGHT,20,'native row height is never overwritten');
  assert.equal(rows[24].hasAttribute('data-gm-outside-page'),false);assert.equal(rows[25].hasAttribute('data-gm-outside-page'),true);
  tree.bar.children[2].events.click();assert.equal(tree.scrollTop,500);
  const scrollbar=root.children[0];
  assert.equal(scrollbar.children[0].style.height,'500px','scrollbar extent is 25 messages, not the 53-message inbox');
  assert.equal(scrollbar.style.height,'180px');assert.equal(scrollbar.scrollTop || 0,0,'each page starts at the top of its own scrollbar');
  scrollbar.scrollTop=320;scrollbar.events.scroll();assert.equal(tree.scrollTop,820,'dragging to page bottom maps onto native global row indices');
  frames.shift()();assert.equal(scrollbar.scrollTop,320);
  tree.bar.children[1].events.click();tree.bar.children[2].events.click();assert.equal(scrollbar.scrollTop,0);
  assert.equal(rows[0].hasAttribute('data-gm-outside-page'),true);assert.equal(rows[25].hasAttribute('data-gm-outside-page'),false);
  tree.scrollTop=0;tree.events.scroll();frames.shift()();assert.equal(tree.scrollTop,500,'cannot scroll into the previous page');
  tree._rowElementClass.ROW_HEIGHT=32;resize();frames.shift()();assert.equal(tree.scrollTop,800,'density/zoom uses new native metrics');
  tree.events.keydown({ctrlKey:true,key:'a',target:{closest:()=>null},preventDefault(){},stopImmediatePropagation(){}});
  assert.equal(selections.at(-1).length,25);assert.equal(selections.at(-1)[0],25);assert.equal(selections.at(-1)[24],49);
  tree.bar.children[2].events.click();assert.equal(tree.scrollTop,1600);assert.equal(tree.bar.children[2].disabled,true);
  nativeView.rowCount=20;nativeView.numMsgsInView=20;mutation();frames.shift()();assert.equal(tree.bar.children[1].disabled,true);
  pages.setSize(0);assert.equal(rows.some(r=>r.hasAttribute('data-gm-outside-page')),false);
  assert.equal(tree.view,nativeView);assert.equal(tree._rowElementClass.ROW_HEIGHT,32);
  pages.close();assert.equal(tree.bar.removed,true);
});
