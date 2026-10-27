const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');

test('settings confirmations expire, newer feedback replaces timers, and errors stay visible',()=>{
  const elements=new Map(),timers=new Map(),events={};let sequence=0;
  const element=id=>{
    if(!elements.has(id))elements.set(id,{dataset:{},textContent:'',addEventListener(){}});
    return elements.get(id);
  };
  const scope=vm.createContext({
    document:{getElementById:element},window:{addEventListener:(name,fn)=>events[name]=fn},
    browser:{runtime:{getManifest:()=>({version:'test'})},storage:{local:{get:()=>new Promise(()=>{})}}},
    setTimeout(fn,delay){timers.set(++sequence,{fn,delay});return sequence},
    clearTimeout:id=>timers.delete(id)
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../thunder-g/options.js'),'utf8'),scope);
  const status=element('status');
  function expire(){const [id,timer]=timers.entries().next().value;timers.delete(id);timer.fn();}
  scope.reportStatus('Saved.');
  assert.equal(status.textContent,'Saved.');assert.equal(status.dataset.kind,'success');
  assert.equal(timers.values().next().value.delay,3000);
  expire();assert.equal(status.textContent,'');assert.equal(timers.size,0);

  scope.reportStatus('Saved.');const previous=timers.keys().next().value;
  scope.reportStatus('Saved. Applies to newly opened compose windows.');
  assert.equal(timers.has(previous),false);assert.equal(timers.size,1);
  assert.equal(timers.values().next().value.delay,6000,'longer explanations remain readable');
  scope.reportStatus('Unable to save. Please try again.');
  assert.equal(status.dataset.kind,'error');assert.equal(timers.size,0,'an earlier success cannot dismiss an error');
  assert.equal(status.textContent,'Unable to save. Please try again.');
  scope.reportStatus('Saved.');assert.equal(timers.size,1);
  events.pagehide();assert.equal(timers.size,0,'closing settings cancels its timeout');
});
