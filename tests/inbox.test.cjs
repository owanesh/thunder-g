const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const scope=vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../inline-labels/inbox.js'),'utf8'),scope);
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
    customElements:{whenDefined:async()=>{},get:()=>Row},gDBView:{getMsgHdrAt:()=>({isRead:read,getStringProperty:()=>preview})},
    addEventListener(){},removeEventListener(){}};
  const controller=scope.installInboxControls(win);await Promise.resolve();
  assert.equal(Row.ROW_HEIGHT,28,'row geometry includes the added vertical space');
  assert.equal(row.line.children.length,1);
  assert.equal(row.line.children[0].children[2].title,'Mark conversation as read');
  read=true;row.fillRow();
  assert.equal(row.line.children.length,1,'recycled row has only one action group');
  assert.equal(row.line.children[0].children[2].title,'Mark conversation as unread');
  preview='Text <b>only</b>';row.fillRow();
  assert.equal(row.line.children[0].textContent,'— Text <b>only</b>','preview is literal text, not HTML');
  preview='';row.fillRow();
  assert.equal(row.line.children.length,1,'recycled row clears the preceding message preview');
  row.dataset.properties='dummy';row.fillRow();assert.equal(row.line.children.length,0);
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

test('responsive columns fit the pane on resize, reserve date space and restore saved widths without persistence',()=>{
  function element(id,type,width){const values=new Map([['width',[`${width}px`,'']]]);return {id,dataset:{type},
    style:{getPropertyValue:n=>values.get(n)?.[0]||'',getPropertyPriority:n=>values.get(n)?.[1]||'',setProperty:(n,v,p='')=>values.set(n,[v,p]),removeProperty:n=>values.delete(n)},
    getBoundingClientRect(){return {width:this.width()}},
    width(){const value=values.get('width')?.[0]||'0';const match=value.match(/^var\(([^)]+)\)$/);return parseFloat(match?values.get(match[1])?.[0]:value)},values};}
  const icons=element('selectCol','icon',32),sender=element('senderCol','text',260),subject=element('subjectCol','text',900),date=element('dateCol','text',120);
  const headers=[icons,sender,subject,date],table=element('table','',1400);table.querySelectorAll=()=>headers;
  const events={};
  const tree={table,clientWidth:640,addEventListener:(n,fn)=>events[n]=fn,removeEventListener:n=>delete events[n]};let resized,changed;const frames=[];
  const win={document:{getElementById:()=>tree},getComputedStyle:()=>({display:'table-cell',fontSize:'14px'}),
    ResizeObserver:class{constructor(fn){resized=fn}observe(){}disconnect(){}},
    MutationObserver:class{constructor(fn){changed=fn}observe(){}disconnect(){}},
    requestAnimationFrame:fn=>{frames.push(fn);return frames.length},cancelAnimationFrame(){}};
  const controller=scope.installResponsiveColumns(win);frames.shift()();
  const size=h=>h.width();
  assert.equal(size(table),640);assert.equal(size(date),112);
  assert.ok(size(sender)+size(subject)+size(date)+32<=640,'date remains inside available width');
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
  const nextHeaders=[element('selectCol','icon',32),element('senderCol','text',200),element('subjectCol','text',700),element('dateCol','text',100)];
  nextHeaders[1].style.setProperty('--senderColSplitter-width','140px');
  const nextTable=element('next-table','',1032);nextTable.querySelectorAll=()=>nextHeaders;tree.table=nextTable;changed();frames.shift()();
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
