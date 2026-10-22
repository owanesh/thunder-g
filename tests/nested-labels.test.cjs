const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const scope=vm.createContext({});vm.runInContext(fs.readFileSync(path.join(__dirname,'../inline-labels/nested-labels.js'),'utf8'),scope);
const tags=['Other','Work/PhD/Project','Work','Work/PhD','Workshops/2026','Work/Teaching'].map((tag,i)=>({key:`key${i}`,tag}));
test('hierarchy uses whole path segments and preserves native keys and full paths',()=>{
 const rows=scope.nestedLabelRows(tags);
 assert.deepEqual(Array.from(rows,r=>[r.path,r.depth,r.name]),[
  ['Other',0,'Other'],['Work',0,'Work'],['Work/PhD',1,'PhD'],['Work/PhD/Project',2,'Project'],['Work/Teaching',1,'Teaching'],['Workshops/2026',0,'Workshops/2026']]);
 assert.equal(rows.find(r=>r.path==='Work/PhD/Project').tag,tags[1]);
 assert.equal(scope.nestedLabelRows(tags,'',new Set(['Work'])).length,3);
 assert.deepEqual(Array.from(scope.nestedLabelRows(tags,'project',new Set(['Work'])),r=>r.path),['Work/PhD/Project']);
 assert.equal(scope.nestedLabelRows(tags,'WORK/PHD').length,2);
});
test('nested creation validates duplicates, missing parents and empty segments without changing tags',()=>{
 assert.equal(scope.nestedLabelName('  New project  ','Work/PhD',tags),'Work/PhD/New project');
 assert.equal(scope.nestedLabelName('Loose/Path','',tags),'Loose/Path');
 assert.throws(()=>scope.nestedLabelName('','Work',tags),/label name/);
 assert.throws(()=>scope.nestedLabelName('A//B','Work',tags),/empty path/);
 assert.throws(()=>scope.nestedLabelName('project','Work/PhD',tags),/already exists/);
 assert.throws(()=>scope.nestedLabelName('Child','Deleted',tags),/no longer exists/);
 assert.equal(tags.length,6);
});
