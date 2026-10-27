const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const scope=vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../thunder-g/inbox.js'),'utf8'),scope);
vm.runInContext(fs.readFileSync(path.join(__dirname,'../thunder-g/compose.js'),'utf8'),scope);
test('thread arrows toggle once per activation, including rapid clicks and keyboard-generated clicks',()=>{
  const events={},calls=[];
  let open=false,container=true,outside=false,inside=true;
  const row={index:3,hasAttribute:()=>outside};
  const arrow={closest:selector=>selector==='tr.table-layout, tr.card-layout'?row:null};
  const target={closest:selector=>selector==='.twisty'?arrow:null};
  const tree={contains:()=>inside,
    addEventListener(name,fn,capture){assert.equal(capture,true);events[name]=fn},
    removeEventListener(name,fn,capture){assert.equal(capture,true);assert.equal(events[name],fn);delete events[name]},
    expandRowAtIndex(index){assert.equal(index,3);open=true;calls.push('expand');return 4},
    collapseRowAtIndex(index){assert.equal(index,3);open=false;calls.push('collapse')},
    scrollExpandedRowIntoView(index,count){assert.equal(index,3);assert.equal(count,4);calls.push('scroll')},
    ensureCorrectFocus(){calls.push('focus')}};
  const win={document:{getElementById:()=>tree},gDBView:{isContainer:()=>container,isContainerOpen:()=>open}};
  const controller=scope.installThreadToggles(win);
  function dispatch(type,detail=1,extra={}) {
    const event={button:0,detail,target,prevented:false,stopped:false,
      preventDefault(){this.prevented=true},stopImmediatePropagation(){this.stopped=true},...extra};
    events[type](event);
    // Thunderbird's row handler runs afterward only if propagation continues.
    if(type==='click' && !event.stopped && event.button===0 && detail===1 && container && inside && !outside)
      throw Error('arrow click must not toggle a second time through the native row handler');
    return event;
  }
  for(const [detail,expected] of [[1,true],[2,false],[3,true],[0,false]]) {
    const event=dispatch('click',detail);
    assert.equal(open,expected,`activation with click detail ${detail} is handled`);
    assert.equal(event.prevented,true);assert.equal(event.stopped,true);
  }
  assert.deepEqual(calls,['expand','scroll','focus','collapse','focus','expand','scroll','focus','collapse','focus']);
  const before=calls.length;
  assert.equal(dispatch('dblclick',2).stopped,true,'double-click cannot open a message window');
  assert.equal(calls.length,before,'dblclick adds no extra toggle');
  for(const modifier of ['ctrlKey','metaKey','altKey','shiftKey'])
    assert.equal(dispatch('click',2,{[modifier]:true}).stopped,false,'modified clicks retain native behavior');
  assert.equal(dispatch('click',1,{button:2}).stopped,false);
  container=false;assert.equal(dispatch('click').stopped,false,'recycled non-container rows cannot be toggled');
  container=true;outside=true;assert.equal(dispatch('click').stopped,false,'hidden off-page rows cannot be toggled');
  outside=false;inside=false;assert.equal(dispatch('click').stopped,false,'foreign rows are ignored');
  assert.equal(calls.length,before);
  controller.close();assert.deepEqual(events,{});
});
test('row actions replace unrelated multi-selection before checking and executing commands',()=>{
  let selected=[1,4],index;
  const tree={set selectedIndex(value){index=value;selected=[value]}};
  const calls=[];
  const win={document:{getElementById:()=>tree},gDBView:{getMsgHdrAt:()=>({})},
    commandController:{isCommandEnabled(name){calls.push(['check',name,selected.slice()]);return true},
      doCommand(name){calls.push(['run',name,selected.slice()])}}};
  scope.runRowAction(win,{index:2,dataset:{}},'cmd_archive');
  assert.equal(index,2);assert.deepEqual(calls,[['check','cmd_archive',[2]],['run','cmd_archive',[2]]]);
  scope.runRowAction(win,{index:3,dataset:{properties:'dummy'}},'cmd_deleteMessage');
  assert.equal(calls.length,2,'group headers cannot execute actions');
  win.commandController.isCommandEnabled=()=>false;
  scope.runRowAction(win,{index:3,dataset:{}},'cmd_deleteMessage');
  assert.equal(calls.length,2,'disabled commands are not executed');
  scope.runRowAction(win,{index:3,dataset:{}},'cmd_archive',{key:99,folderURI:'imap://other'});
  assert.equal(calls.length,2,'a stale action must not target a replacement message');
});
test('virtual row recycling updates actions, avoids duplicates, and cleanup restores the native hook and filter visibility',async()=>{
  const nodes=[];
  function element(){
    return {children:[],events:{},dataset:{},style:{},className:'',classList:{add(){},remove(){}},
      setAttribute(k,v){this[k]=v},append(...items){for(const item of items){item.parent=this;this.children.push(item)}},
      remove(){if(this.parent)this.parent.children=this.parent.children.filter(item=>item!==this)},
      addEventListener(name,fn){this.events[name]=fn},
      querySelector(selector){if(selector==='.subject-line')return this.line;
        if(selector.startsWith('.gm-'))return this.line?.children.find(item=>item.className===selector.slice(1))}};
  }
  class Row{static ROW_HEIGHT=22;fillRow(){}}
  let resets=0;
  const row=Object.assign(new Row(),element());row.index=0;row.line=element();
  const native=Row.prototype.fillRow;let read=false,preview='';
  const doc={head:element(),getElementById:()=>({reset(){resets++}}),createElement:()=>{const e=element();nodes.push(e);return e},
    createElementNS:()=>element(),querySelectorAll:selector=>selector.includes('table-layout')?[row]:selector==='.gm-has-snippet'?[]:row.line.children.slice()};
  const visibility=[];
  const win={document:doc,quickFilterBar:{filterer:{visible:false},_showFilterBar(value){visibility.push(value)}},
    customElements:{whenDefined:async()=>{},get:()=>Row},gViewWrapper:{showThreaded:true,showGroupedBySort:false},gDBView:{rowCount:3,getLevel:index=>index===1?1:0,isContainer:index=>index===0,isContainerOpen:()=>true,getMsgHdrAt:()=>({isRead:read,getStringProperty:()=>preview})},
    addEventListener(){},removeEventListener(){}};
  const controller=scope.installInboxControls(win);await Promise.resolve();
  assert.equal(Row.ROW_HEIGHT,28,'row geometry includes the added vertical space');
  assert.equal(row.line.children.length,1);
  assert.equal(row.line.children[0].children[2].title,'Mark conversation as read');
  assert.equal(row.dataset.gmThreadGuide,'start');
  read=true;row.fillRow();
  assert.equal(row.line.children.length,1,'recycled row has only one action group');
  assert.equal(row.line.children[0].children[2].title,'Mark conversation as unread');
  preview='Text <b>only</b>';row.fillRow();
  assert.equal(row.line.children[0].textContent,'— Text <b>only</b>','preview is literal text, not HTML');
  preview='';row.fillRow();
  assert.equal(row.line.children.length,1,'recycled row clears the preceding message preview');
  row.index=1;row.fillRow();assert.equal(row.dataset.gmThreadGuide,'end');
  row.index=2;row.fillRow();assert.equal(row.dataset.gmThreadGuide,undefined,'recycling cannot connect an unrelated message');
  row.index=0;row.fillRow();controller.setThreadGuides(false);assert.equal(row.dataset.gmThreadGuide,undefined);
  controller.setThreadGuides(true);assert.equal(row.dataset.gmThreadGuide,'start','setting applies without rebuilding rows');
  win.gViewWrapper.showGroupedBySort=true;row.fillRow();assert.equal(row.dataset.gmThreadGuide,undefined,'sort groups are not conversations');
  win.gViewWrapper.showGroupedBySort=false;row.dataset.properties='dummy';row.fillRow();assert.equal(row.line.children.length,0);
  controller.close();assert.equal(Row.ROW_HEIGHT,22);assert.equal(resets,2);assert.equal(Row.prototype.fillRow,native);assert.deepEqual(visibility,[false,false]);
});

test('cached previews collapse whitespace, bound length, and never request missing bodies',()=>{
  assert.equal(scope.cachedMessagePreview({getStringProperty:key=>key==='preview'?'  Hello\n world\t test ':''}),'Hello world test');
  assert.equal(scope.cachedMessagePreview({getStringProperty:()=>''}), '');
  assert.equal(scope.cachedMessagePreview({getStringProperty(){throw Error('unavailable')}}), '');
  assert.equal(scope.cachedMessagePreview({getStringProperty:()=> 'x'.repeat(1000)}).length,240);
});

test('missing previews are extracted only from local streams and streams always close',()=>{
  let closed=0,calls=0;
  const header={charset:'utf-8',getStringProperty:()=>'',folder:{
    getMsgInputStream(){calls++;return {close(){closed++}}},
    getMsgTextFromStream(stream,charset,bytes,length,quotes,strip){
      assert.equal(bytes,16384);assert.equal(length,240);assert.equal(strip,true);
      return ' Local\n body text ';
    }
  }};
  assert.equal(scope.localMessagePreview(header),'Local body text');
  assert.equal(calls,1);assert.equal(closed,1);
  header.getStringProperty=()=> 'cached';
  assert.equal(scope.localMessagePreview(header),'cached');assert.equal(calls,1);
  header.getStringProperty=()=>'';
  header.folder.getMsgTextFromStream=()=>{throw Error('bad MIME')};
  assert.equal(scope.localMessagePreview(header),'');assert.equal(closed,2);
  header.folder.getMsgInputStream=()=>{throw Error('not stored locally')};
  assert.equal(scope.localMessagePreview(header),'');
});

test('preview queue yields between messages, skips stale rows, retries unavailable content and cancels on close',()=>{
  let now=100;scope.Date={now:()=>now};
  const timers=new Map();let sequence=0,reads=0,ready=0,body='';
  const win={setTimeout(fn){timers.set(++sequence,fn);return sequence},clearTimeout(id){timers.delete(id)}};
  const next=()=>{const [id,fn]=timers.entries().next().value;timers.delete(id);fn()};
  const header={messageKey:1,flags:0,getStringProperty:()=>'',folder:{URI:'imap://test/INBOX',
    getMsgInputStream(){reads++;return {close(){}}},getMsgTextFromStream:()=>body}};
  const queue=scope.createPreviewQueue(win);
  queue.get(header,()=>true,()=>ready++);
  assert.equal(reads,0,'rendering must not read body streams');
  next();assert.equal(reads,1);assert.equal(ready,1);
  queue.get(header,()=>true,()=>ready++);assert.equal(timers.size,0,'empty results are throttled');
  now+=30001;body='available after download';
  queue.get(header,()=>true,()=>ready++);next();
  assert.equal(queue.get(header,()=>true,()=>{}),'available after download');
  const stale={...header,messageKey:2};queue.get(stale,()=>false,()=>{throw Error('stale callback')});
  next();assert.equal(reads,2,'stale virtual rows do not start IO');
  const changed={...header,messageKey:3};body='';queue.get(changed,()=>true,()=>{});next();
  changed.flags=128;body='downloaded';queue.get(changed,()=>true,()=>{});next();
  assert.equal(queue.get(changed,()=>true,()=>{}),'downloaded','offline flag changes allow an immediate retry');
  queue.get({...header,messageKey:4},()=>true,()=>{});queue.close();
  assert.equal(timers.size,0,'shutdown cancels scheduled work');
  assert.equal(queue.get(header,()=>true,()=>{}),'');
});

function columnElement(id,type,width){const values=new Map([['width',[`${width}px`,'']]]);return {id,dataset:{type},
    style:{getPropertyValue:n=>values.get(n)?.[0]||'',getPropertyPriority:n=>values.get(n)?.[1]||'',setProperty:(n,v,p='')=>values.set(n,[v,p]),removeProperty:n=>values.delete(n)},
    getBoundingClientRect(){return {width:this.width()}},
    width(){const value=values.get('width')?.[0]||'0';const match=value.match(/^var\(([^)]+)\)$/);return parseFloat(match?values.get(match[1])?.[0]:value)},values};}

test('responsive columns fit the pane on resize, reserve date space and restore saved widths without persistence',()=>{

  const icons=columnElement('selectCol','icon',32),sender=columnElement('senderCol','text',260),subject=columnElement('subjectCol','text',900),date=columnElement('dateCol','text',120);
  const headers=[icons,sender,subject,date],table=columnElement('table','',1400);table.querySelectorAll=()=>headers;
  const events={};
  const tree={table,clientWidth:640,addEventListener:(n,fn)=>events[n]=fn,removeEventListener:n=>delete events[n]};let resized,changed;const frames=[];
  const win={document:{getElementById:()=>tree},getComputedStyle:()=>({display:'table-cell',fontSize:'14px'}),
    ResizeObserver:class{constructor(fn){resized=fn}observe(){}disconnect(){}},
    MutationObserver:class{constructor(fn){changed=(records=[{type:'childList',target:tree}])=>fn(records)}observe(){}disconnect(){}},
    requestAnimationFrame:fn=>{frames.push(fn);return frames.length},cancelAnimationFrame(){}};
  const controller=scope.installResponsiveColumns(win);frames.shift()();
  const size=h=>h.width();
  assert.equal(size(table),640);assert.equal(size(date),112);
  assert.ok(size(sender)+size(subject)+size(date)+32<=640,'date remains inside available width');
  const cell={closest:()=>null};
  for(let i=0;i<200;i++)changed([{type:'childList',target:cell}]);
  changed([{type:'attributes',attributeName:'hidden',target:cell}]);
  assert.equal(frames.length,0,'preview/text/cell changes must not schedule column layout work');
  changed([{type:'childList',target:{closest:selector=>selector==='thead'?{}:null}}]);
  assert.equal(frames.length,1,'native header changes still refit the columns');frames.shift()();
  tree.clientWidth=420;resized();frames.shift()();
  assert.ok(size(sender)+size(subject)+size(date)+32<=420,'shrinking reallocates text columns');
  tree.clientWidth=1200;resized();frames.shift()();
  assert.equal(size(table),1200);assert.ok(size(subject)>500,'growing the pane gives space back to the subject');
  tree.clientWidth=640;resized();frames.shift()();
  const visibleSender=size(sender),visibleSubject=size(subject);
  events.pointerdown({target:{closest:()=>({})}});
  assert.equal(size(sender),visibleSender,'drag starts from the visible sender width');
  assert.equal(size(subject),visibleSubject,'drag must not restore the fullscreen subject width');
  assert.equal(size(table),640,'drag keeps the current pane width');
  sender.style.setProperty('--senderColSplitter-width','160px');
  events['column-resized']({detail:{column:'senderCol',splitter:{width:160}}});
  changed();frames.shift()();assert.equal(size(sender),160,'row updates do not override a manual resize');
  tree.clientWidth=900;resized();frames.shift()();assert.equal(size(sender),160,'window resize preserves chosen sender width when it fits');
  // A last-column drag can request more space than the entire pane.
  events.pointerdown({target:{closest:()=>({})}});
  date.style.setProperty('--dateColSplitter-width','2000px');
  events['column-resized']({detail:{column:'dateCol',splitter:{width:2000}}});
  frames.shift()();
  function fits() {
    assert.ok(headers.every(header=>Number.isFinite(size(header)) && size(header)>=0));
    assert.ok(headers.reduce((sum,header)=>sum+size(header),0)<=tree.clientWidth,'last column stays inside pane');
    assert.equal(size(table),tree.clientWidth);
  }
  fits();assert.ok(size(subject)>=100,'oversized last column leaves room to read subjects');
  changed();frames.shift()();fits();
  tree.clientWidth=160;resized();frames.shift()();fits();
  tree.clientWidth=2400;resized();frames.shift()();fits();
  assert.equal(size(date),2000,'chosen last-column width returns when sufficient space is available');
  events.pointerdown({target:{closest:()=>({})}});
  date.style.setProperty('--dateColSplitter-width','90px');
  events['column-resized']({detail:{column:'dateCol',splitter:{width:90}}});
  frames.shift()();fits();assert.equal(size(date),90);
  tree.clientWidth=500;changed();frames.shift()();fits();
  sender.style.setProperty('--senderColSplitter-width','190px');changed();frames.shift()();
  assert.equal(size(sender),190,'a native restored width overrides the previous folder preference');
  const nextHeaders=[columnElement('selectCol','icon',32),columnElement('senderCol','text',200),columnElement('subjectCol','text',700),columnElement('dateCol','text',100)];
  nextHeaders[1].style.setProperty('--senderColSplitter-width','140px');
  const nextTable=columnElement('next-table','',1032);nextTable.querySelectorAll=()=>nextHeaders;tree.table=nextTable;changed();frames.shift()();
  assert.equal(size(nextHeaders[1]),140,'rebuilding columns uses the destination native widths');
  assert.equal(size(nextTable),500);controller.close();
  assert.equal(size(subject),900);assert.equal(size(table),1400);assert.equal(size(sender),190,'disable preserves the latest native width');
});

test('Copy view also copies native columns across accounts and keeps descendant scope',()=>{
 const source={URI:'imap://source.example/Inbox'},target={URI:'imap://destination.example/Inbox'},calls=[];
 const pane={columns:[{id:'dateCol',hidden:false,ordinal:1},{id:'senderCol',hidden:false,ordinal:2},{id:'subjectCol',hidden:false,ordinal:3},{id:'tagsCol',hidden:true,ordinal:4}],
 _applyColumns(folder,children){calls.push(['columns',folder,children]);folder.columns=this.columns.map(column=>({...column}));},
 _applyView(folder,children){calls.push(['view',folder,children]);folder.sort='date-desc';}};
 const original=pane._applyView,win={gFolder:source,threadPane:pane};
 const controller=scope.installCompleteViewCopy(win);
 for(const children of [false,true]){
  pane._applyView(target,children);assert.deepEqual(target.columns,pane.columns);
  assert.equal(target.sort,'date-desc');assert.deepEqual(calls.splice(0),[['columns',target,children],['view',target,children]]);
 }
 pane._applyView(null);assert.equal(calls.length,0);
 win.gFolder=null;pane._applyView(target);assert.equal(calls.length,0);
 controller.close();assert.equal(pane._applyView,original);
});

test('list and conversation preview queues share bounded expiring text without duplicate local reads',()=>{
 let now=0,sequence=0,reads=0,body='first';scope.Date={now:()=>now};
 const timers=new Map(),win={setTimeout(fn){timers.set(++sequence,fn);return sequence},clearTimeout(id){timers.delete(id)}};
 const flush=()=>{while(timers.size){const [id,fn]=timers.entries().next().value;timers.delete(id);fn()}};
 const header={messageKey:1,messageId:'a',flags:0,getStringProperty:()=>'',folder:{URI:'local://inbox',
  getMsgInputStream(){reads++;return {close(){}}},getMsgTextFromStream:()=>body}};
 const list=scope.createPreviewQueue(win),reader=scope.createPreviewQueue(win);
 list.get(header,()=>true,()=>{});reader.get(header,()=>true,()=>{});flush();assert.equal(reads,1,'simultaneous consumers read a local body once');
 list.close();assert.equal(reader.get(header,()=>true,()=>{}),'first','closing one consumer preserves the shared cache');
 header.messageId='replacement';body='replacement';assert.equal(reader.get(header,()=>true,()=>{}),'');flush();assert.equal(reads,2,'a reused message key cannot return another message\'s text');
 now=300001;body='fresh';assert.equal(reader.get(header,()=>true,()=>{}),'');flush();assert.equal(reads,3,'positive results expire');
 for(let i=2;i<=302;i++) {reader.get({...header,messageKey:i},()=>true,()=>{});flush()}
 assert.equal(reader.get(header,()=>true,()=>{}),'','least recently used previews are evicted');flush();
 reader.close();const reopened=scope.createPreviewQueue(win);assert.equal(reopened.get(header,()=>true,()=>{}),'','last consumer releases all cached text');reopened.close();
});


test('native final-column splitter stays enabled and subject dragging gives space to Date',()=>{
 const sender=columnElement('senderCol','text',180),subject=columnElement('subjectCol','text',600),date=columnElement('dateCol','text',112);
 const headers=[sender,subject,date],table=columnElement('table','',900),persisted=[];
 table.querySelectorAll=()=>headers;table.columns=headers.map(header=>({id:header.id}));
 table.setColumnsWidths=(url,event)=>persisted.push([url,event.detail.column,event.detail.splitter.width]);
 date.resizable=false;
 const events={},mouse={},frames=[];let changed;
 const tree={table,clientWidth:900,addEventListener:(name,fn)=>events[name]=fn,removeEventListener:name=>delete events[name]};
 const win={document:{getElementById:()=>tree},getComputedStyle:()=>({display:'table-cell',fontSize:'14px'}),
 addEventListener:(name,fn)=>mouse[name]=fn,removeEventListener:name=>delete mouse[name],
 ResizeObserver:class{observe(){}disconnect(){}},MutationObserver:class{constructor(fn){changed=(records=[{type:'childList',target:tree}])=>fn(records)}observe(){}disconnect(){}},
 requestAnimationFrame(fn){frames.push(fn);return frames.length},cancelAnimationFrame(){}};
 const controller=scope.installResponsiveColumns(win),flush=()=>{while(frames.length)frames.shift()()};flush();
 assert.equal(date.resizable,true,'native fit-to-pane disabling is overridden');
 assert.equal(date.dataset.gmLastResizable,'true','CSS can expose the native final splitter beside the picker');
 date.resizable=false;changed();flush();assert.equal(date.resizable,true,'native column updates cannot disable the final grip again');
 const initialSubject=subject.width(),initialDate=date.width();
 events.pointerdown({clientX:1000,target:{closest:()=>({resizeElement:subject})}});
 mouse.mousemove({clientX:940});assert.equal(date.style.getPropertyValue('--dateColSplitter-width'),`${initialDate+60}px`,'space is balanced before the native splitter measures the subject');
 subject.style.setProperty('--subjectColSplitter-width',`${initialSubject-60}px`);
 events['column-resized']({detail:{column:'subjectCol',splitter:{width:initialSubject-60}}});flush();
 assert.equal(date.width(),initialDate+60);assert.equal(subject.width(),initialSubject-60,'the subject divider no longer springs back');
 assert.deepEqual(persisted,[['messenger','dateCol',initialDate+60]],'the balancing width uses native persistence');
 changed();flush();assert.equal(date.width(),initialDate+60,'repainting preserves the resized width');
 events.pointerdown({clientX:1000,target:{closest:()=>({resizeElement:subject})}});
 mouse.mousemove({clientX:980});mouse.mouseup();flush();
 assert.equal(date.width(),initialDate+80,'mouse release refits even when the native widget omits column-resized');
 assert.deepEqual(persisted.at(-1),['messenger','dateCol',initialDate+80],'mouse release persists the balancing width');
 controller.close();assert.equal(date.resizable,false);assert.equal(date.dataset.gmLastResizable,undefined);assert.equal(Object.keys(mouse).length,0);
 date.resizable=true;const enabled=scope.installResponsiveColumns(win);flush();assert.equal(date.dataset.gmLastResizable,'true','a natively enabled final splitter is also exposed');enabled.close();assert.equal(date.resizable,true);
 // Explicitly non-resizable columns remain native even when physically last.
 table.columns.at(-1).resizable=false;date.resizable=false;
 const disabled=scope.installResponsiveColumns(win);flush();assert.equal(date.resizable,false);disabled.close();
});


test('thread guides follow native expanded-thread boundaries, nested replies and transient views',()=>{
 const levels=[0,1,2,1,0,0,1,0];let open=true;
 const view={rowCount:levels.length,getLevel:index=>levels[index],getFlagsAt:()=>0,isContainer:index=>index===0 || index===5,isContainerOpen:()=>open};
 assert.deepEqual(levels.map((_,index)=>scope.threadGuidePosition(view,index)),['start','middle','middle','end',null,'start','end',null]);
 open=false;assert.equal(scope.threadGuidePosition(view,0),null,'collapsed threads do not draw a dangling connector');
 view.getFlagsAt=()=>0x20000000;assert.equal(scope.threadGuidePosition(view,1),null,'dummy rows never receive a guide');
 view.getFlagsAt=()=>0;view.getLevel=()=>{throw Error('view changed')};assert.equal(scope.threadGuidePosition(view,1),null);
 assert.equal(scope.threadGuidePosition(view,-1),null);assert.equal(scope.threadGuidePosition(view,99),null);
});

test('threaded views start collapsed, including async searches, and later manual expansion survives updates',()=>{
  scope.Ci={nsMsgViewCommandType:{collapseAll:7}};
  let collapses=0,open=true;
  const view=()=>({doCommand(command){assert.equal(command,7);collapses++;open=false}});
  const listener={allMessagesLoaded:true,
    onCreatedView(){assert.equal(this,listener);open=true;return 'created'},
    onMessagesLoaded(){assert.equal(this,listener);return 'loaded'}};
  const originalCreated=listener.onCreatedView,originalLoaded=listener.onMessagesLoaded;
  const win={gDBView:view(),gViewWrapper:{showThreaded:true,_threadExpandAll:true},dbViewWrapperListener:listener};
  const controller=scope.installCollapsedThreadDefaults(win);
  assert.equal(open,false);assert.equal(win.gViewWrapper._threadExpandAll,false);
  open=true;listener.onMessagesLoaded(true);
  assert.equal(open,true,'live updates preserve threads manually opened after initial loading');
  win.gDBView=view();win.gViewWrapper._threadExpandAll=true;
  assert.equal(listener.onCreatedView(),'created');assert.equal(open,false);
  open=true;assert.equal(listener.onMessagesLoaded(false),'loaded');assert.equal(open,true);
  listener.onMessagesLoaded(true);assert.equal(open,false,'final native search/selection restoration cannot defeat the default');
  open=true;listener.onMessagesLoaded(true);assert.equal(open,true);
  const count=collapses;
  win.gViewWrapper.showGroupedBySort=true;win.gDBView=view();listener.onCreatedView();listener.onMessagesLoaded(true);
  assert.equal(collapses,count,'group headers keep their own native state');
  win.gViewWrapper.showGroupedBySort=false;win.gViewWrapper.showThreaded=false;
  win.gDBView=view();listener.onCreatedView();listener.onMessagesLoaded(true);assert.equal(collapses,count);
  controller.close();assert.equal(listener.onCreatedView,originalCreated);assert.equal(listener.onMessagesLoaded,originalLoaded);
});

test('idle toolbar delegates page selection, refreshes the current account and cleans up',()=>{
 function node(){return {children:[],events:{},setAttribute(k,v){this[k]=v},append(...items){this.children.push(...items)},prepend(item){this.children.unshift(item)},addEventListener(name,fn){this.events[name]=fn},remove(){this.removed=true}}}
 const host=node(),head=node(),tree={selectedIndices:[],hasAttribute:()=>true},selected=[],calls=[],frames=new Map();let id=0,nativeClicks=0;
 const folder={updateFolder(window){calls.push(['update',window])}},msgWindow={};
 const main={msgWindow,MsgGetMessage(folders){calls.push(['download',folders])}};
 const nativeSelect={click(){nativeClicks++;tree.selectedIndices=[50,51,52]}};
 const doc={head,getElementById:key=>({threadPaneHeaderBar:{querySelector:()=>host},threadTree:tree,selectColButton:nativeSelect})[key],createElement:node,createElementNS:node};
 const win={document:doc,gFolder:folder,browsingContext:{topChromeWindow:main},requestAnimationFrame(fn){frames.set(++id,fn);return id},cancelAnimationFrame(key){frames.delete(key)}};
 const controller=scope.installInboxIdleActions(win,{selectIndices(indices){selected.push(indices)}});
 const bar=host.children[0],[checkbox,refresh,more]=bar.children;
 checkbox.checked=true;checkbox.events.change();assert.equal(nativeClicks,1);
 const paint=frames.values().next().value;frames.clear();paint();assert.deepEqual(Array.from(selected[0]),[50,51,52],'preserve native current-page selection');assert.equal(checkbox.checked,false);
 refresh.events.click();assert.equal(calls[0][0],'download');assert.equal(calls[0][1][0],folder);assert.deepEqual(calls[1],['update',msgWindow]);
 assert.equal(more.disabled,true);
 checkbox.events.change();controller.close();assert.equal(frames.size,0);
 assert.equal(bar.removed,true);assert.equal(head.children[0].removed,true);
});

test('unpaginated Select all scope includes only viewport rows and excludes dummy group headers',()=>{
 const rows=[{index:0,top:-20,bottom:10},{index:1,top:10,bottom:30},{index:2,top:30,bottom:50},{index:3,top:50,bottom:80},{index:4,top:80,bottom:110}].map(row=>({...row,getBoundingClientRect:()=>row}));
 const tree={getBoundingClientRect:()=>({top:0,bottom:80}),querySelector:()=>({getBoundingClientRect:()=>({height:20})}),querySelectorAll:()=>rows};
 assert.deepEqual(Array.from(scope.visibleInboxIndices(tree,{getFlagsAt:index=>index===2?0x20000000:0})),[1,3]);
});

test('native selection column is enabled first for every folder layout and restored on disable',()=>{
  const calls=[],tree={reset(){calls.push('reset')}};
  const inbox=[{id:'subjectCol',hidden:false},{id:'selectCol',hidden:false}];
  const drafts=[{id:'flaggedCol',hidden:false},{id:'selectCol',hidden:true},{id:'subjectCol',hidden:false}];
  const original=function(simple){calls.push(simple);assert.equal(this,pane)};
  const pane={columns:inbox,updateColumns:original};
  const controller=scope.installSelectionColumn({threadPane:pane,document:{getElementById:()=>tree}});
  assert.equal(inbox[0].id,'selectCol');assert.equal(inbox[0].hidden,false);
  pane.columns=drafts;pane.updateColumns(true);
  assert.equal(drafts[0].id,'selectCol');assert.equal(drafts[0].hidden,false);
  assert.equal(drafts[1].id,'flaggedCol');assert.equal(drafts[2].id,'subjectCol');
  pane.updateColumns(true);assert.equal(drafts.length,3,'no duplicate cells on repeated updates');
  assert.deepEqual(calls.slice(0,4),[false,'reset',false,true],'only column movement requires a full native rebuild');
  controller.close();
  assert.equal(pane.updateColumns,original);assert.equal(drafts[1].id,'selectCol');assert.equal(drafts[1].hidden,true);
});

test('synthetic search results use Gmail columns without changing regular folder layouts',()=>{
 const columns=['subjectCol','correspondentCol','dateCol','locationCol','selectCol','senderCol','attachmentCol','flaggedCol','threadCol'].map((id,index)=>({id,hidden:!['subjectCol','correspondentCol','dateCol','locationCol'].includes(id),ordinal:index+1}));
 const snapshot=columns.map(column=>({...column})),calls=[];
 const original=function(simple){calls.push(simple)};const pane={columns,updateColumns:original};
 const win={threadPane:pane,gViewWrapper:{isSynthetic:true},document:{getElementById:()=>({reset(){}})}};
 const controller=scope.installSearchColumns(win);
 assert.deepEqual(columns.filter(column=>!column.hidden).map(column=>column.id),['selectCol','threadCol','flaggedCol','senderCol','subjectCol','attachmentCol','dateCol']);
 controller.close();assert.equal(pane.updateColumns,original);assert.deepEqual(columns,snapshot);
 win.gViewWrapper.isSynthetic=false;const regular=scope.installSearchColumns(win);assert.deepEqual(columns,snapshot);regular.close();
});
