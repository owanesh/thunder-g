const checkbox = document.getElementById('hide-today-pane');
const status = document.getElementById('status');
checkbox.disabled = true;
browser.storage.local.get({hideTodayPane:false}).then(settings => {
  checkbox.checked = settings.hideTodayPane === true;
  checkbox.disabled = false;
}).catch(() => { status.textContent = 'Unable to load settings.'; });
checkbox.addEventListener('change',async () => {
  checkbox.disabled = true;
  try {
    await browser.storage.local.set({hideTodayPane:checkbox.checked});
    status.textContent = 'Saved.';
  } catch (_) {
    checkbox.checked = !checkbox.checked;
    status.textContent = 'Unable to save. Please try again.';
  } finally { checkbox.disabled = false; }
});

const autosave = document.getElementById('compose-autosave');
const autosaveMinutes = document.getElementById('compose-autosave-minutes');
autosave.disabled = autosaveMinutes.disabled = true;
let savedAutosave = {composeAutosave:true,composeAutosaveMinutes:1};
browser.storage.local.get(savedAutosave).then(settings => {
  savedAutosave = settings;
  autosave.checked = settings.composeAutosave !== false;
  autosaveMinutes.value = String([1,2,5,10].includes(settings.composeAutosaveMinutes) ? settings.composeAutosaveMinutes : 1);
  autosave.disabled = false; autosaveMinutes.disabled = !autosave.checked;
}).catch(() => { status.textContent = 'Unable to load settings.'; });
async function saveAutosave() {
  autosave.disabled = autosaveMinutes.disabled = true;
  const settings = {composeAutosave:autosave.checked,composeAutosaveMinutes:Number(autosaveMinutes.value)};
  try {
    await browser.storage.local.set(settings); savedAutosave = settings;
    status.textContent = 'Saved. Applies to newly opened compose windows.';
  } catch (_) {
    autosave.checked = savedAutosave.composeAutosave !== false;
    autosaveMinutes.value = String(savedAutosave.composeAutosaveMinutes);
    status.textContent = 'Unable to save. Please try again.';
  } finally { autosave.disabled = false; autosaveMinutes.disabled = !autosave.checked; }
}
autosave.addEventListener('change',saveAutosave);
autosaveMinutes.addEventListener('change',saveAutosave);

const pageSize = document.getElementById('messages-per-page');
pageSize.disabled = true;
let savedPageSize = 0;
browser.storage.local.get({messagesPerPage:0}).then(settings => {
  savedPageSize = [25,50,100].includes(settings.messagesPerPage) ? settings.messagesPerPage : 0;
  pageSize.value = String(savedPageSize); pageSize.disabled = false;
}).catch(() => { status.textContent = 'Unable to load settings.'; });
pageSize.addEventListener('change', async () => {
  pageSize.disabled = true;
  try {
    const value = Number(pageSize.value);
    await browser.storage.local.set({messagesPerPage:value}); savedPageSize = value;
    status.textContent = 'Saved.';
  } catch (_) {
    pageSize.value = String(savedPageSize); status.textContent = 'Unable to save. Please try again.';
  } finally { pageSize.disabled = false; }
});

const independentReader = document.getElementById('independent-reader');
independentReader.disabled = true;
browser.storage.local.get({independentReader:false}).then(settings => {
  independentReader.checked = settings.independentReader === true;
  independentReader.disabled = false;
}).catch(() => { status.textContent = 'Unable to load settings.'; });
independentReader.addEventListener('change', async () => {
  independentReader.disabled = true;
  try {
    await browser.storage.local.set({independentReader:independentReader.checked});
    status.textContent = 'Saved. Open a message from the list to use the selected reader.';
  } catch (_) {
    independentReader.checked = !independentReader.checked;
    status.textContent = 'Unable to save. Please try again.';
  } finally { independentReader.disabled = false; }
});

const bimi = document.getElementById('bimi-enabled');
bimi.disabled=true;
browser.storage.local.get({bimiEnabled:false}).then(settings=>{bimi.checked=settings.bimiEnabled===true;bimi.disabled=false;}).catch(()=>{status.textContent='Unable to load settings.';});
bimi.addEventListener('change',async()=>{
  bimi.disabled=true;
  try {await browser.storage.local.set({bimiEnabled:bimi.checked});status.textContent='Saved.';}
  catch(_){bimi.checked=!bimi.checked;status.textContent='Unable to save. Please try again.';}
  finally{bimi.disabled=false;}
});

const inlineReply=document.getElementById('inline-reply-enabled');
inlineReply.disabled=true;
browser.storage.local.get({inlineReplyEnabled:false}).then(settings=>{inlineReply.checked=settings.inlineReplyEnabled===true;inlineReply.disabled=false;}).catch(()=>{status.textContent='Unable to load settings.';});
inlineReply.addEventListener('change',async()=>{
 inlineReply.disabled=true;
 try{await browser.storage.local.set({inlineReplyEnabled:inlineReply.checked});status.textContent='Saved. Applies to new replies; an open reply stays available.';}
 catch(_){inlineReply.checked=!inlineReply.checked;status.textContent='Unable to save. Please try again.';}
 finally{inlineReply.disabled=false;}
});

const inlineNewMessage=document.getElementById('inline-new-message');
inlineNewMessage.disabled=true;
browser.storage.local.get({inlineNewMessageEnabled:false}).then(settings=>{inlineNewMessage.checked=settings.inlineNewMessageEnabled===true;inlineNewMessage.disabled=false;}).catch(()=>{status.textContent='Unable to load settings.';});
inlineNewMessage.addEventListener('change',async()=>{
 inlineNewMessage.disabled=true;
 try{await browser.storage.local.set({inlineNewMessageEnabled:inlineNewMessage.checked});status.textContent='Saved. Applies to new messages; an open message stays available.';}
 catch(_){inlineNewMessage.checked=!inlineNewMessage.checked;status.textContent='Unable to save. Please try again.';}
 finally{inlineNewMessage.disabled=false;}
});
