const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../inline-labels/independent-reader.js'),'utf8');
function context(extra={}) {const scope=vm.createContext(extra);vm.runInContext(source,scope);return scope;}
function message(key,id,folder='inbox',date=key){return {messageKey:key,messageId:id,dateInSeconds:date,folder:{URI:folder},mime2DecodedSubject:'Subject',mime2DecodedAuthor:'Sender',getStringProperty(name){return name==='keywords' && this.tagged?'work':''}}}
test('conversation grouping deduplicates physical and logical copies, retains selected copy and sorts by date',()=>{
  const scope=context(),anchor=message(1,'same','inbox',20),sent=message(2,'other','sent',10);
  const result=scope.independentMessages([message(3,'same','allmail',20),sent,anchor],anchor);
  assert.equal(result.length,2);assert.equal(result[0],sent);assert.equal(result[1],anchor);
  const blank1=message(4,''),blank2=message(5,'');
  assert.equal(scope.independentMessages([blank1,blank2],anchor).length,3,'missing message ids must not collapse unrelated mail');
});
test('unavailable index returns real folder thread without matching by subject',async()=>{
  const scope=context(),anchor=message(1,'a'),reply=message(2,'b');
  anchor.folder.msgDatabase={getThreadContainingMsgHdr:()=>({numChildren:2,getChildHdrAt:i=>[anchor,reply][i]})};
  const query=scope.independentConversation({},anchor,null),result=await query.promise;
  assert.equal(result.indexed,false);assert.equal(result.messages.length,2);
});
test('index queries include Sent and cancel stale conversations; timeouts preserve fallback',async()=>{
  const scope=context(),anchor=message(1,'a'),sent=message(2,'b','sent');
  let first,second,timer,cleared=false;
  const win={setTimeout(fn){timer=fn;return 1},clearTimeout(){cleared=true}};
  const gloda={getMessageCollectionForHeader(header,listener){assert.equal(header,anchor);first=listener;return {}}};
  let query=scope.independentConversation(win,anchor,gloda);
  first.onQueryCompleted({items:[{conversation:{getMessagesCollection(listener){second=listener;return {}}}}]});
  second.onQueryCompleted({items:[{folderMessage:sent},{folderMessage:anchor},{folderMessage:null}]});
  let result=await query.promise;assert.equal(result.indexed,true);assert.equal(result.messages.length,2);assert.equal(cleared,true);
  query=scope.independentConversation(win,anchor,gloda);query.cancel();
  first.onQueryCompleted({items:[]});result=await query.promise;assert.equal(result.indexed,false);assert.equal(result.messages[0],anchor);
  query=scope.independentConversation(win,anchor,gloda);timer();result=await query.promise;assert.equal(result.messages.length,1);assert.equal(result.indexed,false);
});
function readerFixture({photo=null,tagged=false,verifyIndependentDkim}={}) {
  function node(tag='div') {
    const attrs=new Map(),classes=new Set();
    return {tag,children:[],events:{},style:{},hidden:false,classList:{add:key=>classes.add(key),remove:key=>classes.delete(key),contains:key=>classes.has(key)},
      append(...items){for(const item of items){item.parentNode=this;this.children.push(item)}},
      replaceChildren(...items){this.children=[];this.append(...items)},remove(){this.removed=true;if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(item=>item!==this)},
      setAttribute:(key,value)=>attrs.set(key,value),getAttribute:key=>attrs.get(key),removeAttribute:key=>attrs.delete(key),
      scrollIntoView(options){this.scrolled=options},
      attachShadow(){this.shadow=node('shadow');return this.shadow},
      addEventListener(name,fn){(this.events[name]??=[]).push(fn)},removeEventListener(name,fn){this.events[name]=(this.events[name] || []).filter(item=>item!==fn)},
      emit(name,event={}){for(const fn of this.events[name] || [])fn(event)}};
  }
  const layout=node(),head=node(),browsers=[],loads=[],commands=[],timers=new Map(),animationFrames=new Map(),removals=[];
  const resizes=[],mutations=[];let seq=0,zoomClosed=0,tagListener,removedListener;
  const doc={getElementById:id=>id==='paneLayout'?layout:null,createElement:node,createTextNode:value=>({textContent:value}),head,
    createXULElement(tag){
      const browser=node(tag);browser.clientHeight=500;browser.docShell={allowDNSPrefetch:true};
      const content=node('content');content.bottom=1208;content.quotes=[];
      content.querySelectorAll=()=>content.quotes;content.createElement=node;content.documentElement=node();
      content.body={scrollHeight:2000,getBoundingClientRect:()=>({top:8})};
      content.createRange=()=>({selectNodeContents(){},getBoundingClientRect:()=>({bottom:content.bottom})});
      content.defaultView={getComputedStyle:()=>({marginTop:'8px',marginBottom:'8px',paddingBottom:'0px'})};
      const pane={clientHeight:400,contentDocument:content};
      browser.contentDocument={...node('document'),documentURI:'about:message',createElement:node,documentElement:node(),getElementById:id=>id==='messagepane'?pane:null};
      browser.contentWindow={displayMessage:uri=>{loads.push(uri);browser.uri=uri},commandController:{isCommandEnabled:()=>true,doCommand:name=>commands.push([name,browser.uri])}};
      browser.pane=pane;browser.content=content;browsers.push(browser);return browser;
    }};
  const tags=[{key:'work',tag:'Work',color:'#336699'}];
  const scope=context({verifyIndependentDkim,Services:{prefs:{getBoolPref:()=>false}},Ci:{nsIMsgFolderNotificationService:{msgPropertyChanged:1}},
    MailServices:{headerParser:{parseDecodedHeader:name=>[{name,email:`${name.toLowerCase()}@example.org`}]},
      ab:{cardForEmailAddress:()=>photo?{photoURL:photo}:null},tags:{getAllTags:()=>tags},
      mfn:{addListener(fn){tagListener=fn},removeListener(fn){removedListener=fn}}},
    assignedTags:header=>header.tagged?tags:[],chipColors:()=>({background:'#ddeeff',foreground:'#123456'}),
    applyConversationLabel(headers,key,add){removals.push({headers,key,add});for(const header of headers)header.tagged=add},
    createPreviewQueue:()=>({get:()=>'<img src=x onerror=bad()>',close(){}}),
    cachedMessagePreview:()=>'<img src=x onerror=bad()>',installMailZoom:()=>({close(){zoomClosed++}}),ChromeUtils:{importESModule:()=>({UIFontSize:{}})}});
  const win={document:doc,
    ResizeObserver:class{constructor(fn){this.fn=fn;this.disconnected=false;resizes.push(this)}observe(){}disconnect(){this.disconnected=true}},
    MutationObserver:class{constructor(fn){this.fn=fn;this.disconnected=false;mutations.push(this)}observe(){}disconnect(){this.disconnected=true}},
    requestAnimationFrame(fn){animationFrames.set(++seq,fn);return seq},cancelAnimationFrame:id=>animationFrames.delete(id),
    setTimeout(fn){timers.set(++seq,fn);return seq},clearTimeout:id=>timers.delete(id)};
  const reader=scope.installIndependentReader(win),anchor=message(1,'a');anchor.tagged=tagged;
  const prepare=header=>{header.folder.getUriForMsg=h=>`mailbox://${h.folder.URI}/${h.messageKey}`;return header};prepare(anchor);
  const conversation=layout.children[0].shadow.children[1],cards=conversation.children[3],actions=conversation.children[4];
  const flush=()=>{const pending=[...animationFrames.values()];animationFrames.clear();for(const fn of pending)fn()};
  function loaded(browser=browsers.at(-1)){browser.emit('load',{target:browser.contentDocument});browser.emit('MsgLoaded');flush()}
  return {scope,reader,anchor,prepare,layout,browsers,loads,commands,removals,timers,animationFrames,resizes,mutations,conversation,cards,actions,flush,loaded,
    get tagListener(){return tagListener},get removedListener(){return removedListener},get zoomClosed(){return zoomClosed}};
}
test('reader keeps one footer after all cards, restores print, and delegates commands to native message',async()=>{
  const f=readerFixture();f.anchor.mime2DecodedSubject='<script>bad()</script>';await f.reader.open(f.anchor);
  assert.equal(f.conversation.children[0].textContent,'<script>bad()</script>');
  assert.equal(f.layout.classList.contains('gm-independent-open'),true);
  assert.equal(f.browsers[0].getAttribute('src'),'about:message');assert.equal(f.browsers[0].getAttribute('disablesecurity'),undefined);
  f.loaded();assert.deepEqual(f.loads,['mailbox://inbox/1']);assert.equal(f.browsers[0].docShell.allowDNSPrefetch,false);assert.equal(f.timers.size,0);
  assert.deepEqual(f.actions.children.map(button=>button.textContent),['Reply','Reply all','Forward']);
  assert.equal(f.conversation.children.at(-1),f.actions,'reply controls follow the entire conversation');
  f.actions.children[0].emit('click');f.reader.print();
  assert.deepEqual(f.commands,[['cmd_replySender','mailbox://inbox/1'],['cmd_print','mailbox://inbox/1']]);
  const envelopeStyle=f.browsers[0].contentDocument.documentElement.children[0].textContent;
  assert.match(envelopeStyle,/#expandedfromRow/);
  assert.doesNotMatch(envelopeStyle,/#messageHeader\s*\{[^}]*display:\s*none/);
  f.reader.close();assert.equal(f.zoomClosed,1);assert.equal(f.browsers[0].removed,true);assert.equal(f.removedListener,f.tagListener);
});
test('short messages shrink independently of viewport, growing images and pane resizing refit without retained blank space',async()=>{
  const f=readerFixture();await f.reader.open(f.anchor);f.loaded();const frame=f.browsers[0];
  assert.equal(frame.style.blockSize,'1316px');
  frame.content.bottom=108;frame.content.body.scrollHeight=2000;f.resizes[0].fn();f.flush();
  assert.equal(frame.style.blockSize,'216px','short content is measured rather than the old 2000px viewport');
  frame.content.bottom=1808;frame.content.emit('load');f.flush();assert.equal(frame.style.blockSize,'1916px');
  frame.content.bottom=908;f.mutations[0].fn();f.flush();assert.equal(frame.style.blockSize,'1016px');
  f.resizes[0].fn();assert.equal(f.animationFrames.size,1);f.reader.hide();assert.equal(f.animationFrames.size,0);
  assert.equal(f.resizes[0].disconnected,true);assert.equal(f.mutations[0].disconnected,true);assert.equal(frame.content.events.load.length,0);
});
test('opening an old conversation message always expands and reveals the newest reply with older cards compact',async()=>{
  const f=readerFixture();const middle=f.prepare(message(2,'b','sent',2)),latest=f.prepare(message(3,'c','sent',3));
  f.anchor.folder.msgDatabase={getThreadContainingMsgHdr:()=>({numChildren:3,getChildHdrAt:i=>[latest,f.anchor,middle][i]})};
  await f.reader.open(f.anchor);f.flush();
  assert.equal(f.cards.children.length,3);assert.equal(f.conversation.children[2].textContent,'3 messages');
  assert.equal(f.browsers.length,1,'only the newest message expands when an older row opens the conversation');
  assert.equal(f.cards.children[0].children[1].hidden,true);assert.equal(f.cards.children[1].children[1].hidden,true);
  assert.equal(f.cards.children[2].children[1].hidden,false);
  assert.equal(f.cards.children[2].scrolled.block,'nearest','the newest reply is brought into view');
  assert.equal(f.cards.children[0].scrolled,undefined,'the older selected message must not steal the viewport');
  assert.equal(f.actions.children[0].disabled,true);f.loaded();
  f.actions.children[1].emit('click');assert.deepEqual(f.commands,[['cmd_replyall','mailbox://sent/3']]);
  const toggle=f.cards.children[1].children[0].children[0];toggle.emit('click');assert.equal(f.browsers.length,2);
  f.loaded();toggle.emit('click');assert.notEqual(f.browsers[1].removed,true);assert.equal(f.actions.children[0].disabled,false);
  toggle.emit('click');assert.equal(f.browsers.length,2,'reopening a folded message reuses its native frame');
  const latestToggle=f.cards.children[2].children[0].children[0];latestToggle.emit('click');
  assert.equal(f.cards.children[2].children[1].hidden,false,'latest message cannot accidentally be folded away');
  f.actions.children[0].emit('click');assert.deepEqual(f.commands.at(-1),['cmd_replySender','mailbox://sent/3']);
  f.reader.close();
});
test('chips have a visible accessible X, remove only their own message tag, and follow native changes',async()=>{
  const f=readerFixture({tagged:true});await f.reader.open(f.anchor);
  const tags=f.cards.children[0].children[0].children[0].children[1].children[3],remove=tags.children[0].children[1];
  assert.equal(remove.textContent,'×');assert.equal(remove.getAttribute('aria-label'),'Remove Work from this message');
  remove.emit('click',{preventDefault(){},stopPropagation(){}});
  assert.equal(f.removals.length,1);assert.equal(f.removals[0].headers[0],f.anchor);assert.equal(f.removals[0].key,'work');assert.equal(tags.children.length,0);
  f.anchor.tagged=true;f.tagListener.msgPropertyChanged(f.anchor,'keywords');assert.equal(tags.children.length,1);
  const stale=tags.children[0].children[1];f.reader.hide();stale.emit('click',{preventDefault(){},stopPropagation(){}});assert.equal(f.removals.length,1);
  f.reader.close();
});
test('sender uses the existing contact photo and falls back to initials when unavailable',async()=>{
  const f=readerFixture({photo:'file:///profile/Photos/sender.jpg'});await f.reader.open(f.anchor);
  const avatar=f.cards.children[0].children[0].children[0].children[0];assert.equal(avatar.children[0].getAttribute('src'),'file:///profile/Photos/sender.jpg');
  avatar.children[0].emit('error');assert.equal(avatar.children[0].textContent,'S');f.reader.close();
  const empty=readerFixture();await empty.reader.open(empty.anchor);assert.equal(empty.cards.children[0].children[0].children[0].children[0].textContent,'S');empty.reader.close();
});
function references(header,...ids) {header.numReferences=ids.length;header.getStringReference=i=>ids[i];return header}
test('local sent summaries recover own replies without a global index and never group by subject',async()=>{
  const scope=context(),anchor=references(message(1,'inbound','inbox',20),'<root>');
  const parent=message(2,'root','sent',10),outgoing=references(message(3,'my-reply','sent',30),'inbound');
  const second=references(message(4,'my-followup','sent',40),'my-reply');
  const unrelated=message(5,'other','sent',50);unrelated.mime2DecodedSubject=anchor.mime2DecodedSubject;
  const copy=references(message(6,'my-reply','custom-sent',30),'inbound');
  const result=await scope.independentConversation({},anchor,null,[{messages:[second,unrelated,outgoing,parent]},{messages:[copy]},{get messages(){throw Error('unavailable')}}]).promise;
  assert.equal(result.indexed,false);
  assert.deepEqual(Array.from(result.messages,h=>h.messageId),['root','inbound','my-reply','my-followup']);
  assert.equal(result.messages.at(-1),second,'latest sent reply becomes the last message');
});
test('sent replies supplement an incomplete global index rather than disappearing when the index returns first',async()=>{
  const scope=context(),anchor=message(1,'a'),sent=references(message(2,'b','sent',2),'a');
  let lookup,conversation;
  const win={setTimeout:()=>1,clearTimeout(){}};
  const gloda={getMessageCollectionForHeader(header,listener){lookup=listener;return {}}};
  const query=scope.independentConversation(win,anchor,gloda,[{messages:[sent]}]);
  lookup.onQueryCompleted({items:[{conversation:{getMessagesCollection(listener){conversation=listener;return {}}}}]});
  conversation.onQueryCompleted({items:[{folderMessage:anchor}]});
  const result=await query.promise;assert.equal(result.indexed,true);
  assert.deepEqual(Array.from(result.messages,h=>h.messageId),['a','b']);
});
test('local Sent scanning yields and stops when the conversation is left',async()=>{
  const scope=context(),anchor=message(1,'a');let yields=0;
  const win={setTimeout(){yields++;return 1},clearTimeout(){}};
  const sent=Array.from({length:1000},(_,i)=>references(message(i+2,`sent-${i}`,'sent'),'a'));
  const query=scope.independentConversation(win,anchor,null,[{messages:sent}]);
  assert.equal(yields,1,'a large Sent folder does not block the UI');query.cancel();
  const result=await query.promise;assert.equal(result.messages.length,1);
});
test('Sent discovery includes configured custom destinations and folders marked Sent across accounts',()=>{
  const custom={URI:'custom',isSpecialFolder:()=>false},sent={URI:'sent',isSpecialFolder:flag=>flag===512},other={URI:'inbox',isSpecialFolder:()=>false};
  const scope=context({Ci:{nsMsgFolderFlags:{SentMail:512}},MailServices:{accounts:{allIdentities:[{fccFolderURI:'custom'}],allFolders:[other,custom,sent]}}});
  assert.deepEqual(Array.from(scope.independentSentFolders()),[custom,sent]);
});
test('Gmail layout keeps previews with the sender and folds quoted history behind a reversible control',async()=>{
  const f=readerFixture(),old=f.prepare(message(2,'older','inbox',0));
  f.anchor.folder.msgDatabase={getThreadContainingMsgHdr:()=>({numChildren:2,getChildHdrAt:i=>[old,f.anchor][i]})};
  await f.reader.open(f.anchor);
  const older=f.cards.children[0],sender=older.children[0].children[0].children[1];
  assert.equal(sender.children[2].className,'preview','collapsed preview shares the sender column');
  const frame=f.browsers[0];frame.content.quotes=[{}];f.loaded();
  const body=f.cards.children[1].children[1],quoteButton=body.children[2];
  assert.equal(quoteButton.hidden,false);assert.equal(quoteButton.getAttribute('aria-label'),'Show quoted text');
  assert.equal(frame.content.documentElement.getAttribute('data-gm-fold-quotes'),'');
  quoteButton.emit('click');f.flush();
  assert.equal(frame.content.documentElement.getAttribute('data-gm-fold-quotes'),undefined);
  assert.equal(quoteButton.getAttribute('aria-label'),'Hide quoted text');
  quoteButton.emit('click');f.flush();assert.equal(frame.content.documentElement.getAttribute('data-gm-fold-quotes'),'');
  f.reader.close();
});
test('title aggregates labels across incoming and sent cards and stays synchronized with native changes',async()=>{
  const f=readerFixture({tagged:true}),sent=f.prepare(message(2,'sent','sent',2));
  f.anchor.folder.msgDatabase={getThreadContainingMsgHdr:()=>({numChildren:2,getChildHdrAt:i=>[f.anchor,sent][i]})};
  await f.reader.open(f.anchor);
  const titleTags=f.conversation.children[0].children[0];
  assert.equal(titleTags.className,'title-tags');assert.equal(titleTags.children.length,1);
  assert.equal(titleTags.children[0].textContent,'Work');
  f.anchor.tagged=false;sent.tagged=true;f.tagListener.msgPropertyChanged(sent,'keywords');
  assert.equal(titleTags.children.length,1,'sent-only labels remain next to the conversation title');
  sent.tagged=false;f.tagListener.msgPropertyChanged(sent,'keywords');assert.equal(titleTags.children.length,0);
  f.reader.close();
});
test('numeric shortcuts and native tag menu target the opened Sent reply, never the first inbox message',async()=>{
  const f=readerFixture(),sent=f.prepare(message(2,'sent','sent',2)),latest=f.prepare(message(3,'latest','inbox',3));
  f.anchor.folder.msgDatabase={getThreadContainingMsgHdr:()=>({numChildren:3,getChildHdrAt:i=>[f.anchor,sent,latest][i]})};
  await f.reader.open(f.anchor);f.loaded();
  const active=()=>f.cards.children.filter(card=>card.getAttribute('aria-current')==='true');
  assert.deepEqual(active(),[f.cards.children[2]],'the latest message starts as the visible numeric-tag target');
  assert.equal(f.cards.children[2].getAttribute('data-active-message'),'');
  const toggle=f.cards.children[1].children[0].children[0];toggle.emit('click');f.loaded();
  assert.deepEqual(active(),[f.cards.children[1]],'opening a Sent reply moves the marker to the exact target');
  assert.equal(f.cards.children[2].getAttribute('data-active-message'),undefined);
  const event=()=>({key:'1',target:{closest:()=>null},preventDefault(){this.prevented=true},stopImmediatePropagation(){this.stopped=true}});
  const key=event();assert.equal(f.reader.handleTagKey(key),true);assert.equal(key.prevented,true);
  assert.equal(sent.tagged,true);assert.notEqual(f.anchor.tagged,true);assert.notEqual(latest.tagged,true);
  assert.equal(f.removals[0].headers[0],sent);
  f.reader.handleTagKey(event());assert.equal(sent.tagged,false,'pressing 1 twice toggles only that reply');
  const frame=f.browsers[1];frame.contentWindow.commandController._toggleMessageTagKey(1);
  assert.equal(f.removals.at(-1).headers[0],sent,'native menu and command routing also use the exact embedded header');
  frame.contentWindow.commandController._toggleMessageTag('work',false);assert.equal(sent.tagged,false);
  f.cards.children[2].emit('pointerdown');f.reader.handleTagKey(event());assert.equal(latest.tagged,true);
  assert.deepEqual(active(),[f.cards.children[2]]);
  // Events originating inside another message use that document, even if focus tracking was stale.
  f.reader.handleTagKey({...event(),currentTarget:frame.contentDocument});assert.equal(sent.tagged,true);
  assert.deepEqual(active(),[f.cards.children[1]],'document-based key routing also corrects the visible marker');
  f.cards.children[0].emit('focusin');assert.deepEqual(active(),[f.cards.children[0]],'keyboard focus on a folded card selects only that message');
  assert.notEqual(f.anchor.tagged,true,'moving focus never changes labels');
  frame.content.emit('focusin');assert.deepEqual(active(),[f.cards.children[1]],'focus inside native message content restores its marker');
  f.cards.children[2].emit('pointerdown');frame.contentWindow.commandController._toggleMessageTag('work',false);
  assert.deepEqual(active(),[f.cards.children[1]],'native tag menu and marker agree even after stale focus');
  assert.equal(f.reader.handleTagKey({...event(),ctrlKey:true}),false);
  assert.equal(f.reader.handleTagKey({...event(),target:{closest:()=>({})}}),false);
  assert.equal(f.reader.handleTagKey({...event(),key:'l'}),false,'L remains reserved for the whole-conversation picker');
  f.reader.close();assert.equal(frame.contentWindow.commandController._toggleMessageTagKey,undefined,'native controller is restored on teardown');
});
test('DKIM chips use verifier results with warnings and missing evidence kept distinct from verified success',()=>{
  const scope=context();
  const status=data=>scope.independentDkimStatus({getStringProperty:key=>{assert.equal(key,'dkim_verifier@pl-result');return typeof data==='string'?data:JSON.stringify(data)}});
  assert.equal(status({version:'3.0',dkim:[{result:'SUCCESS',sdid:'example.org'}]}).tone,'success');
  assert.equal(status({version:'3.0',dkim:[{result:'SUCCESS',warnings:[{name:'weak-key'}]}]}).tone,'warning');
  assert.equal(status({version:'2.0',dkim:[{result:'PERMFAIL'}]}).tone,'failure');
  assert.equal(status({version:'3.0',dkim:[{result:'TEMPFAIL'}]}).tone,'warning');
  assert.equal(status({version:'3.0',dkim:[{result:'none'}]}).label,'DKIM unsigned');
  assert.equal(status({version:'1.0',result:'SUCCESS'}).label,'DKIM verified');
  for(const invalid of ['', '{broken', {version:'4.0',dkim:[{result:'SUCCESS'}]}])assert.equal(status(invalid).label,'DKIM not checked');
});
test('each message renders its own DKIM chip and keeps tags beside the sender instead of adding a row',async()=>{
  const f=readerFixture({tagged:true});
  f.anchor.getStringProperty=name=>name==='dkim_verifier@pl-result'?JSON.stringify({version:'3.0',dkim:[{result:'SUCCESS',sdid:'example.org'}]}):'work';
  await f.reader.open(f.anchor);
  const card=f.cards.children[0],sender=card.children[0].children[0].children[1];
  assert.equal(sender.children[3].className,'tags');assert.equal(card.children.length,2,'no separate tag row occupies body space');
  const dkim=card.children[0].children[1].children[1];assert.equal(dkim.textContent,'DKIM verified');assert.equal(dkim.getAttribute('data-tone'),'success');
  f.anchor.getStringProperty=name=>name==='dkim_verifier@pl-result'?JSON.stringify({version:'3.0',dkim:[{result:'PERMFAIL'}]}):'work';
  f.tagListener.msgPropertyChanged(f.anchor,'dkim_verifier@pl-result');assert.equal(dkim.getAttribute('data-tone'),'failure');
  f.reader.close();
});
test('live verifier results work when saving results is disabled and cannot update a replaced conversation',async()=>{
  const pending=[];
  const f=readerFixture({verifyIndependentDkim:header=>new Promise(resolve=>pending.push({header,resolve}))});
  await f.reader.open(f.anchor);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(pending.length,1);
  const chip=f.cards.children[0].children[0].children[1].children[1];
  assert.equal(chip.textContent,'DKIM checking…');
  pending[0].resolve({dkim:[{result:'SUCCESS',sdid:'google.com'}]});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(chip.textContent,'DKIM verified');
  // The pure status decoder accepts the provider result without needing a stored header property.
  const scope=context();
  assert.equal(scope.independentDkimStatus(f.anchor,{version:'2.1',dkim:[{result:'SUCCESS',sdid:'google.com'}]}).label,'DKIM verified');
  f.reader.close();
  for(const item of pending)item.resolve({dkim:[{result:'SUCCESS'}]});
});

test('sent metadata scans are shared, expire, invalidate on changes and stay bounded',async()=>{
 const scope=context();let now=0,reads=0,count=1;
 const sent=references(message(2,'reply','sent',2),'a');
 const folder={URI:'sent',getTotalMessages:()=>count,get messages(){reads++;return [sent]}};
 const cache=scope.createSentCandidateCache({},()=>now);
 const first=cache.get([folder]),concurrent=cache.get([folder]);assert.equal(first,concurrent,'concurrent lookups share the scan');
 assert.equal((await first)[0].header,sent);await cache.get([folder]);assert.equal(reads,1);
 now=30001;await cache.get([folder]);assert.equal(reads,2);
 count=2;await cache.get([folder]);assert.equal(reads,3,'new Sent messages invalidate the folder signature');
 cache.invalidate();await cache.get([folder]);assert.equal(reads,4,'native notifications invalidate immediately');
 cache.close();assert.equal((await cache.get([folder])).length,0);
 const bounded=scope.createSentCandidateCache({},()=>now,0);await bounded.get([folder]);await bounded.get([folder]);assert.equal(reads,6,'oversized scans remain complete but are not retained');bounded.close();
});
test('native body starts before index lookup while conversation-wide actions wait for full scope',async()=>{
 const f=readerFixture();let lookup;
 f.scope.Services.prefs.getBoolPref=()=>true;
 f.scope.ChromeUtils.importESModule=url=>url.includes('GlodaPublic')?{Gloda:{getMessageCollectionForHeader(header,listener){lookup=listener;return {}}}}:{UIFontSize:{}};
 const opening=f.reader.open(f.anchor);
 assert.equal(f.browsers.length,1,'native renderer is created before the index completes');
 assert.equal(f.reader.getMessages().length,0,'L cannot label a partial conversation without sent replies');
 f.loaded();assert.equal(f.actions.children[0].disabled,true,'Reply waits for the actual newest message');
 lookup.onQueryCompleted({items:[]});await opening;
 assert.equal(f.browsers.length,1,'identical membership does not reload the native message');
 assert.equal(f.reader.getMessages().length,1);assert.equal(f.actions.children[0].disabled,false);
 f.reader.close();
});

test('unindexed conversations include replies from an identity-configured unflagged Sent folder',async()=>{
  const anchor=message(1,'root');
  anchor.folder.msgDatabase={getThreadContainingMsgHdr:()=>({numChildren:1,getChildHdrAt:()=>anchor})};
  const reply=references(message(2,'reply','custom',2),'root');
  const custom={URI:'custom',isSpecialFolder:()=>false,messages:[reply]};
  const scope=context({Ci:{nsMsgFolderFlags:{SentMail:512}},MailServices:{accounts:{allIdentities:[{fccFolderURI:'custom'}],allFolders:[custom]}}});
  const result=await scope.independentConversation({},anchor,null,scope.independentSentFolders()).promise;
  assert.deepEqual(Array.from(result.messages),[anchor,reply]);
  assert.equal(result.indexed,false);
});
