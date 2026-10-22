const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const scope=vm.createContext({console});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../inline-labels/dates.js'),'utf8'),scope);
test('local calendar dates: time today, month/day this year, year for older mail',()=>{
  const now=new Date(2026,9,21,0,5);
  const today=scope.compactMessageDate(new Date(2026,9,21,0,1).getTime(),now,'en-US');
  assert.equal(today.short,'12:01 AM');assert.match(today.full,/2026/);
  assert.equal(scope.compactMessageDate(new Date(2026,9,20,23,59).getTime(),now,'en-US').short,'Oct 20');
  assert.equal(scope.compactMessageDate(new Date(2025,11,31).getTime(),now,'en-US').short,'Dec 31, 2025');
  assert.equal(scope.compactMessageDate(NaN,now,'en-US'),null);
  assert.equal(scope.compactMessageDate(0,now,'en-US'),null);
});
test('formatting hundreds of row dates reuses a bounded set of locale formatters',()=>{
  let constructions=0;
  const measured=vm.createContext({Intl:{DateTimeFormat:class extends Intl.DateTimeFormat {
    constructor(...args){super(...args);constructions++;}
  }}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../inline-labels/dates.js'),'utf8'),measured);
  const now=new Date(2026,9,22,12),cache=new Map();
  for(let i=0;i<500;i++)measured.compactMessageDate(now.getTime()-i*86400000,now,'en-US',cache);
  assert.equal(constructions,4,'time, current-year date, older date and tooltip are reused across all rows');
  cache.clear();measured.compactMessageDate(now.getTime(),now,'it-IT',cache);
  assert.equal(constructions,6,'refresh can pick up a new locale/timezone');
});
test('recycled dates and Fluent tooltip update; closing restores native renderer and strings',async()=>{
  const attrs=new Map([['data-l10n-id','date-cell'],['data-l10n-args','{"title":"native"}'],['title','native']]);
  const cell={textContent:'native',get title(){return attrs.get('title')},set title(v){attrs.set('title',v)},getAttribute:n=>attrs.get(n)??null,setAttribute:(n,v)=>attrs.set(n,v),removeAttribute:n=>attrs.delete(n)};
  let timestamp=Date.now();let native='native';const timers=[];let translations=0;
  const prototype={fillRow(){cell.textContent=native;attrs.set('title',native);attrs.set('data-l10n-args',JSON.stringify({title:native}));}};
  const original=prototype.fillRow;
  const row=Object.assign(Object.create(prototype),{index:0,dataset:{},querySelector:()=>cell});
  const doc={querySelectorAll:()=>[row],l10n:{setAttributes(_cell,_id,args){translations++;attrs.set('data-l10n-args',JSON.stringify(args));}}};
  const win={document:doc,navigator:{languages:['en-US']},gDBView:{getMsgHdrAt:()=>({dateInSeconds:timestamp/1000})},customElements:{whenDefined:()=>Promise.resolve(),get:()=>({prototype})},setTimeout:fn=>{timers.push(fn);return 1},clearTimeout(){},addEventListener(){},removeEventListener(){}};
  const controller=scope.installCompactDates(win);await Promise.resolve();
  assert.notEqual(cell.textContent,'native');assert.equal(JSON.parse(attrs.get('data-l10n-args')).title,cell.title);
  const translated=translations;controller.refresh();
  assert.equal(translations,translated,'unchanged dates do not request repeated Fluent translations');
  timestamp=new Date(2020,0,2).getTime();native='native older';row.fillRow();
  assert.match(cell.textContent,/2020/);assert.match(cell.title,/2020/);
  controller.close();assert.equal(prototype.fillRow,original);assert.equal(cell.textContent,'native older');assert.equal(attrs.get('title'),'native older');
});
