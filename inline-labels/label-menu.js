const HIDDEN_MESSAGE_LABELS_PREF='extensions.thunderg.hiddenMessageLabels';
function hiddenMessageLabelKeys(prefs) {
  try {const value=JSON.parse(prefs?.getStringPref(HIDDEN_MESSAGE_LABELS_PREF,'[]') || '[]');return new Set(Array.isArray(value)?value.filter(key=>typeof key==='string'):[]);}catch(_){return new Set();}
}
function labelRenamePlan(tags,key,path) {
  const original=tags.find(tag=>tag.key===key);if(!original)throw new Error('This label no longer exists.');
  path=path.trim();if(!path || path.split('/').some(part=>!part.trim()))throw new Error('Enter a name without empty path segments.');
  if(path.startsWith(original.tag+'/'))throw new Error('A label cannot be nested under itself.');
  const plan=tags.filter(tag=>tag.key===key || tag.tag.startsWith(original.tag+'/')).map(tag=>({key:tag.key,before:tag.tag,after:path+tag.tag.slice(original.tag.length)}));
  const moved=new Set(plan.map(item=>item.key));
  const occupied=new Set(tags.filter(tag=>!moved.has(tag.key)).map(tag=>tag.tag.normalize('NFKC').toLocaleLowerCase()));
  for(const item of plan){const name=item.after.normalize('NFKC').toLocaleLowerCase();if(occupied.has(name))throw new Error('A label with that path already exists.');occupied.add(name);}
  return plan;
}
function renameNativeLabel(tags,key,path,service) {
  const plan=labelRenamePlan(tags,key,path),done=[];
  try{for(const item of plan){service.setTagForKey(item.key,item.after);done.push(item);}}
  catch(error){for(const item of done.reverse())service.setTagForKey(item.key,item.before);throw error;}
  return plan;
}
function installSidebarLabelMenu(win,service,prefs) {
  const doc=win.document,buttons=new Set();let currentKey=null;
  const panel=doc.createXULElement('panel');panel.className='gm-sidebar-label-popup';panel.setAttribute('aria-label','Label options');
  const content=doc.createElement('div');content.className='gm-sidebar-label-menu';panel.append(content);doc.documentElement.append(panel);
  const style=doc.createElement('style');style.textContent=`
    [data-tag-key] > .container > .name { min-width:0; }
    [data-tag-key] > .container > .folder-count-badge { flex:0 0 auto; }
    [data-tag-key] > .container .gm-label-more { opacity:0; box-sizing:border-box; flex:0 0 28px !important; min-width:28px !important; max-width:28px !important; min-inline-size:28px !important; max-inline-size:28px !important; margin-block:0; margin-inline:6px 0; padding:0; width:28px; height:28px; border:0; border-radius:50%; color:inherit; background:transparent; font-size:22px; cursor:pointer; }
    [data-tag-key] > .container:hover .gm-label-more,[data-tag-key] > .container:focus-within .gm-label-more,.gm-label-more[aria-expanded=true] { opacity:1; }
    [data-tag-key] > .container .gm-label-more:hover { background:var(--layout-background-2,#e8eaed); }
    .gm-sidebar-label-menu { min-width:240px; max-width:min(440px,80vw); padding:8px 0; color:var(--layout-color-0,#202124); background:var(--layout-background-0,#fff); }
    .gm-sidebar-label-menu > button { display:block; box-sizing:border-box; width:100%; text-align:start; border:0; border-radius:0; padding:10px 22px; background:transparent; color:inherit; font:inherit; cursor:pointer; }
    .gm-sidebar-label-menu > button:hover,.gm-sidebar-label-menu > button:focus-visible { background:var(--layout-background-2,#f1f3f4); }
    .gm-sidebar-label-menu hr { border:0; border-top:1px solid var(--layout-border-0,#dadce0); margin:8px 0; }
    .gm-sidebar-label-menu p { margin:10px 22px; overflow-wrap:anywhere; }
    .gm-sidebar-label-menu form { margin:12px 22px; }
    .gm-sidebar-label-menu input[type=text] { box-sizing:border-box; width:100%; margin:10px 0; padding:8px; color:inherit; background:var(--layout-background-0,#fff); border:1px solid var(--layout-border-0,#888); border-radius:4px; font:inherit; }
    .gm-label-colors { display:grid; grid-template-columns:repeat(6,22px); gap:4px; padding:4px 22px 8px 42px; }
    .gm-label-colors button { appearance:none; box-sizing:border-box; width:22px; min-width:22px; max-width:22px; height:22px; min-height:22px; padding:0; margin:0; border:1px solid color-mix(in srgb,currentColor 15%,transparent); border-radius:50%; font:500 15px/20px sans-serif; cursor:pointer; }
    .gm-label-colors button:hover,.gm-label-colors button:focus-visible { outline:2px solid var(--layout-color-0,#202124); outline-offset:1px; }
    .gm-label-colors button[aria-pressed=true] { box-shadow:0 0 0 2px var(--layout-background-0,#fff),0 0 0 3px var(--layout-color-0,#202124); }
    .gm-sidebar-label-menu > .gm-color-back { width:auto; min-width:0; padding:4px 12px; font-size:.85em; }
    .gm-sidebar-label-menu form button { margin-inline-end:8px; padding:6px 12px; font:inherit; }
  `;doc.head.append(style);
  function tag(){const item=service.getAllTags().find(t=>t.key===currentKey);if(!item)throw new Error('This label no longer exists.');return item;}
  function text(value){const node=doc.createElement('p');node.textContent=value;content.append(node);return node;}
  function failure(error){const node=text(error.message || 'The label could not be updated.');node.setAttribute('role','alert');}
  function button(label,action){const node=doc.createElement('button');node.type='button';node.textContent=label;node.addEventListener('click',()=>{try{action();}catch(error){failure(error);}});content.append(node);return node;}
  function separator(){content.append(doc.createElement('hr'));}
  function home(){
    const item=tag();content.replaceChildren();panel.setAttribute('aria-label',`Options for ${item.tag}`);
    button('Label color  ›',colors);separator();text('In message list');
    const hidden=hiddenMessageLabelKeys(prefs).has(currentKey);
    for(const [title,hide] of [['Show',false],['Hide',true]]){
      const node=button(`${hidden===hide?'✓  ':'    '}${title}`,()=>{tag();const keys=hiddenMessageLabelKeys(prefs);if(hide)keys.add(currentKey);else keys.delete(currentKey);prefs.setStringPref(HIDDEN_MESSAGE_LABELS_PREF,JSON.stringify([...keys]));panel.hidePopup();});
      node.setAttribute('aria-label',title);node.setAttribute('role','menuitemradio');node.setAttribute('aria-checked',String(hidden===hide));
    }
    separator();button('Edit',()=>editor(false));button('Remove label',()=>{
      const item=tag();
      if(!Services.prompt.confirm(win.top,'Remove label',`Remove “${item.tag}”? Emails and sublabels will be kept.`))return;
      service.deleteKey(currentKey);panel.hidePopup();
    });button('Add sublabel',()=>editor(true));
  }
  function colors(){
    tag();content.replaceChildren();const back=button('‹ Back',home);back.className='gm-color-back';text('Label color');
    const grid=doc.createElement('div');grid.className='gm-label-colors';content.append(grid);
    grid.setAttribute('role','group');grid.setAttribute('aria-label','Label colors');
    for(const color of ['#cccccc','#6d9eeb','#76a5af','#8e7cc3','#c27ba0','#cc0000',
      '#666666','#1155cc','#134f5c','#674ea7','#a64d79','#990000',
      '#e69138','#f6b26b','#f1c232','#ffd966','#93c47d','#6aa84f',
      '#ff6d01','#fbbc04','#d5a6bd','#a64d79','#34a853','#0b804b',
      '#000000','#ffffff','#ead1dc','#a142f4','#4285f4','#24c1e0']){
      const preview=chipColors(color);
      const node=doc.createElement('button');node.type='button';node.textContent='a';
      node.style.backgroundColor=preview.background;node.style.color=preview.foreground;
      node.title=`Label color ${color}`;node.setAttribute('aria-label',`Set label color ${color}`);
      node.setAttribute('aria-pressed',String((tag().color || '').toLowerCase()===color));
      node.addEventListener('click',()=>{try{tag();service.setColorForKey(currentKey,color);panel.hidePopup();}catch(error){failure(error);}});grid.append(node);
    }
    const custom=doc.createElement('input');custom.type='color';custom.hidden=true;custom.value=/^#[0-9a-f]{6}$/i.test(tag().color)?tag().color:'#5f6368';custom.setAttribute('aria-label','Custom label color');
    custom.addEventListener('change',()=>{try{tag();service.setColorForKey(currentKey,custom.value);panel.hidePopup();}catch(error){failure(error);}});
    content.append(custom);button('Add custom color',()=>custom.click());
    button('Remove color',()=>{tag();service.setColorForKey(currentKey,'');panel.hidePopup();});
  }
  function editor(child){
    const item=tag();content.replaceChildren();button('‹  Back',home);text(child?'New sublabel':'Edit label');
    text(child?`Nest label under: ${item.tag}`:'Changing this path also updates its sublabels.');
    const form=doc.createElement('form'),label=doc.createElement('label'),input=doc.createElement('input');
    label.textContent=child?'Label name':'Full label path';input.type='text';input.value=child?'':item.tag;input.setAttribute('aria-label',child?'Sublabel name':'Full label path');label.append(input);form.append(label);
    const save=doc.createElement('button');save.type='submit';save.textContent=child?'Create':'Save';const cancel=doc.createElement('button');cancel.type='button';cancel.textContent='Cancel';cancel.addEventListener('click',()=>panel.hidePopup());form.append(cancel,save);content.append(form);
    form.addEventListener('submit',event=>{event.preventDefault();try{
      const current=tag(),tags=service.getAllTags();
      if(child)service.addTag(nestedLabelName(input.value,current.tag,tags),'','');
      else renameNativeLabel(tags,currentKey,input.value,service);
      panel.hidePopup();
    }catch(error){failure(error);}});input.focus();
  }
  panel.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();panel.hidePopup();}});
  panel.addEventListener('popuphidden',()=>{for(const node of buttons)node.setAttribute('aria-expanded','false');});
  panel.addEventListener('popupshown',()=>content.querySelector('button')?.focus());
  return {decorate(row,item){
    const existing=row.querySelector(':scope > .container > .gm-label-more');if(existing){existing.setAttribute('aria-label',`Options for ${item.tag}`);return;}
    const more=doc.createElement('button');more.type='button';more.className='gm-label-more';more.textContent='⋮';more.setAttribute('aria-label',`Options for ${item.tag}`);more.setAttribute('aria-haspopup','true');more.setAttribute('aria-expanded','false');
    more.addEventListener('mousedown',event=>event.stopPropagation());
    more.addEventListener('keydown',event=>{if(['Enter',' ','ArrowDown'].includes(event.key)){event.preventDefault();event.stopPropagation();more.click();}});
    more.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();currentKey=row.dataset.tagKey;try{home();more.setAttribute('aria-expanded','true');panel.openPopup(more,'after_start',0,0,false,false);}catch(error){console.error(error);}});
    row.querySelector(':scope > .container').append(more);buttons.add(more);
  },close(){panel.hidePopup();panel.remove();style.remove();for(const more of buttons)more.remove();buttons.clear();}};
}
