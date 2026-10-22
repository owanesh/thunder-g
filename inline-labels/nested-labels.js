/* Hierarchy is encoded in native tag names. Tag keys and assignments never change. */
function nestedLabelTree(tags) {
  const nodes=tags.map(tag=>({tag,path:tag.tag,parent:null,children:[]}));
  const byPath=new Map(nodes.map(node=>[node.path,node]));
  const roots=[];
  for(const node of nodes) {
    let path=node.path;
    while(path.includes('/')) {
      path=path.slice(0,path.lastIndexOf('/'));
      if(byPath.has(path)){node.parent=byPath.get(path);break;}
    }
    (node.parent?node.parent.children:roots).push(node);
  }
  const sort=items=>{items.sort((a,b)=>a.path.localeCompare(b.path,undefined,{numeric:true}));for(const item of items)sort(item.children)};
  sort(roots);return roots;
}
function nestedLabelRows(tags,query='',collapsed=new Set()) {
  const needle=query.trim().normalize('NFKC').toLocaleLowerCase(),rows=[];
  function visit(nodes,depth=0) {
    for(const node of nodes) {
      const match=!needle || node.path.normalize('NFKC').toLocaleLowerCase().includes(needle);
      if(match)rows.push({...node,depth,name:node.parent?node.path.slice(node.parent.path.length+1):node.path});
      // Search reveals matches even when their ancestors are collapsed.
      if(needle || !collapsed.has(node.path))visit(node.children,depth+1);
    }
  }
  visit(nestedLabelTree(tags));return rows;
}
function nestedLabelName(name,parent,tags) {
  name=name.trim();parent=parent || '';
  if(!name || name.split('/').some(part=>!part.trim()))throw new Error('Enter a label name without empty path segments.');
  if(parent && !tags.some(tag=>tag.tag===parent))throw new Error('The parent label no longer exists. Choose another label.');
  const path=parent?`${parent}/${name}`:name;
  if(tags.some(tag=>tag.tag.normalize('NFKC').toLocaleLowerCase()===path.normalize('NFKC').toLocaleLowerCase()))throw new Error('A label with this name already exists.');
  return path;
}
function installNestedLabelSidebar(win,mailServices=MailServices,prefs=Services.prefs) {
  const doc=win.document,tree=doc.getElementById('folderTree');
  if(!tree)return {close(){}};
  const saved=new Map();let closed=false,timer=null;
  function refresh() {
    timer=null;if(closed)return;
    const list=win.folderPane?._modes?.tags?.containerList;
    if(!list?.isConnected)return;
    const tags=mailServices.tags.getAllTags(),keys=new Set(tags.map(tag=>tag.key));
    for(const row of list.querySelectorAll('[data-tag-key]'))saved.set(row.dataset.tagKey,row);
    // A native parent deletion can detach children too. Retain each still-valid native row.
    for(const [key,row] of saved)if(!keys.has(key))saved.delete(key);
    observer.disconnect();
    function place(nodes,container) {
      nodes.forEach((node,index)=>{
        const row=saved.get(node.tag.key);if(!row)return;
        if(container.children[index]!==row)container.insertBefore(row,container.children[index] || null);
        const name=node.parent?node.path.slice(node.parent.path.length+1):node.path;
        row.name=name;row.fullName=node.path;
        row.dataset.gmNestedLabel='true';
        place(node.children,row.childList);
      });
    }
    try {place(nestedLabelTree(tags),list);}finally{observer.observe(tree,{childList:true,subtree:true});}
  }
  function schedule(){if(!closed && timer===null)timer=win.setTimeout(refresh,0)}
  const observer=new win.MutationObserver(schedule);observer.observe(tree,{childList:true,subtree:true});
  const prefObserver={observe:schedule};prefs.addObserver('mailnews.tags.',prefObserver);
  schedule();
  return {refresh:schedule,close(){
    closed=true;observer.disconnect();prefs.removeObserver('mailnews.tags.',prefObserver);if(timer!==null)win.clearTimeout(timer);
    const list=win.folderPane?._modes?.tags?.containerList;
    if(list?.isConnected)for(const tag of mailServices.tags.getAllTags()) {
      const row=saved.get(tag.key);if(!row)continue;
      list.append(row);row.name=tag.tag;row.fullName=tag.tag;delete row.dataset.gmNestedLabel;
    }
    saved.clear();
  }};
}
