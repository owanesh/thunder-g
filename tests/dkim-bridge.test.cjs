const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
test('DKIM provider bridge authenticates the caller and verifies the exact requested message',async()=>{
  let listener;const verified=[];
  vm.runInNewContext(fs.readFileSync('integrations/dkim-thunderg-bridge.js','utf8'),{
    browser:{runtime:{onMessageExternal:{addListener(fn){listener=fn}}},messages:{async get(id){return {id}}}},
    isInitialized:Promise.resolve(),verifier:{async verify(message){verified.push(message.id);return {dkim:[{result:'SUCCESS',sdid:'accounts.google.com'}]}}}
  });
  const request={module:'ThunderG',method:'verify',messageId:42},sender={id:'thunder-g@vschiavoni'};
  assert.equal(listener(request,{id:'other-extension'}),undefined);
  assert.equal(listener({...request,module:'other'},sender),undefined);
  await assert.rejects(listener({...request,messageId:'42'},sender));
  const result=await listener(request,sender);assert.equal(result.dkim[0].result,'SUCCESS');assert.deepEqual(verified,[42]);
});
test('original popup contexts keep exact messages isolated and release their results without opening windows',async()=>{
 let listener;const cache=new Map(),timers=new Map();let sequence=0;
 const scope=require('./localization-context.cjs').createContext({
 browser:{runtime:{onMessageExternal:{addListener(fn){listener=fn}}},messages:{async get(id){return {id}}},messageDisplay:{getDisplayedMessage(){throw Error('must not use the selected native message')}}},
 isInitialized:Promise.resolve(),displayedResultsCache:cache,
 verifier:{async verify(message){return {dkim:[{result:'SUCCESS',sdid:`message-${message.id}.example`}]}}},
 setTimeout(fn){timers.set(++sequence,fn);return sequence},clearTimeout(id){timers.delete(id)}
 });
 vm.runInContext(fs.readFileSync('integrations/dkim-thunderg-bridge.js','utf8'),scope);
 const sender={id:'thunder-g@vschiavoni'},request=messageId=>({module:'ThunderG',method:'details',messageId});
 const first=await listener(request(72),sender),second=await listener(request(81),sender);
 assert.notEqual(first.contextId,second.contextId);assert.ok(first.contextId < -1000);
 assert.equal(cache.get(first.contextId).dkim[0].sdid,'message-72.example');
 assert.equal((await scope.thunderGDisplayedMessage(second.contextId)).id,81);
 await listener({module:'ThunderG',method:'release',messageId:81,contextId:first.contextId},sender);
 assert.ok(cache.has(first.contextId),'another message cannot release this context');
 await listener({module:'ThunderG',method:'release',messageId:72,contextId:first.contextId},sender);
 assert.equal(cache.has(first.contextId),false);assert.equal(await scope.thunderGDisplayedMessage(first.contextId),null);
 assert.equal((await scope.thunderGDisplayedMessage(second.contextId)).id,81);
});
