const checkbox = document.getElementById('hide-today-pane');
const status = document.getElementById('status');
let statusTimer = null;
function reportStatus(message) {
  if (statusTimer !== null) clearTimeout(statusTimer);
  statusTimer = null;
  status.textContent = message;
  status.dataset.kind = message.startsWith('Unable') ? 'error' : 'success';
  if (status.dataset.kind === 'success') {
    // Leave explanatory confirmations readable longer than a simple "Saved".
    statusTimer = setTimeout(() => {
      statusTimer = null;
      status.textContent = '';
    }, message.length > 20 ? 6000 : 3000);
  }
}
window.addEventListener('pagehide', () => {
  if (statusTimer !== null) clearTimeout(statusTimer);
  statusTimer = null;
});
const manifest = browser.runtime.getManifest();
document.getElementById('version').textContent = `v${manifest.version}`;
if (manifest.homepage_url) document.getElementById('repository').href = manifest.homepage_url;
checkbox.disabled = true;
browser.storage.local.get({hideTodayPane:false}).then(settings => {
  checkbox.checked = settings.hideTodayPane === true;
  checkbox.disabled = false;
}).catch(() => { reportStatus('Unable to load settings.'); });
checkbox.addEventListener('change',async () => {
  checkbox.disabled = true;
  try {
    await browser.storage.local.set({hideTodayPane:checkbox.checked});
    reportStatus('Saved.');
  } catch (_) {
    checkbox.checked = !checkbox.checked;
    reportStatus('Unable to save. Please try again.');
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
}).catch(() => { reportStatus('Unable to load settings.'); });
async function saveAutosave() {
  autosave.disabled = autosaveMinutes.disabled = true;
  const settings = {composeAutosave:autosave.checked,composeAutosaveMinutes:Number(autosaveMinutes.value)};
  try {
    await browser.storage.local.set(settings); savedAutosave = settings;
    reportStatus('Saved. Applies to newly opened compose windows.');
  } catch (_) {
    autosave.checked = savedAutosave.composeAutosave !== false;
    autosaveMinutes.value = String(savedAutosave.composeAutosaveMinutes);
    reportStatus('Unable to save. Please try again.');
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
}).catch(() => { reportStatus('Unable to load settings.'); });
pageSize.addEventListener('change', async () => {
  pageSize.disabled = true;
  try {
    const value = Number(pageSize.value);
    await browser.storage.local.set({messagesPerPage:value}); savedPageSize = value;
    reportStatus('Saved.');
  } catch (_) {
    pageSize.value = String(savedPageSize); reportStatus('Unable to save. Please try again.');
  } finally { pageSize.disabled = false; }
});

const independentReader = document.getElementById('independent-reader');
independentReader.disabled = true;
browser.storage.local.get({independentReader:false}).then(settings => {
  independentReader.checked = settings.independentReader === true;
  independentReader.disabled = false;
}).catch(() => { reportStatus('Unable to load settings.'); });
independentReader.addEventListener('change', async () => {
  independentReader.disabled = true;
  try {
    await browser.storage.local.set({independentReader:independentReader.checked});
    reportStatus('Saved. Open a message from the list to use the selected reader.');
  } catch (_) {
    independentReader.checked = !independentReader.checked;
    reportStatus('Unable to save. Please try again.');
  } finally { independentReader.disabled = false; }
});

const bimi = document.getElementById('bimi-enabled');
bimi.disabled=true;
browser.storage.local.get({bimiEnabled:false}).then(settings=>{bimi.checked=settings.bimiEnabled===true;bimi.disabled=false;}).catch(()=>{reportStatus('Unable to load settings.');});
bimi.addEventListener('change',async()=>{
  bimi.disabled=true;
  try {await browser.storage.local.set({bimiEnabled:bimi.checked});reportStatus('Saved.');}
  catch(_){bimi.checked=!bimi.checked;reportStatus('Unable to save. Please try again.');}
  finally{bimi.disabled=false;}
});

const inlineReply=document.getElementById('inline-reply-enabled');
inlineReply.disabled=true;
browser.storage.local.get({inlineReplyEnabled:false}).then(settings=>{inlineReply.checked=settings.inlineReplyEnabled===true;inlineReply.disabled=false;}).catch(()=>{reportStatus('Unable to load settings.');});
inlineReply.addEventListener('change',async()=>{
 inlineReply.disabled=true;
 try{await browser.storage.local.set({inlineReplyEnabled:inlineReply.checked});reportStatus('Saved. Applies to new replies; an open reply stays available.');}
 catch(_){inlineReply.checked=!inlineReply.checked;reportStatus('Unable to save. Please try again.');}
 finally{inlineReply.disabled=false;}
});

const inlineNewMessage=document.getElementById('inline-new-message');
inlineNewMessage.disabled=true;
browser.storage.local.get({inlineNewMessageEnabled:false}).then(settings=>{inlineNewMessage.checked=settings.inlineNewMessageEnabled===true;inlineNewMessage.disabled=false;}).catch(()=>{reportStatus('Unable to load settings.');});
inlineNewMessage.addEventListener('change',async()=>{
 inlineNewMessage.disabled=true;
 try{await browser.storage.local.set({inlineNewMessageEnabled:inlineNewMessage.checked});reportStatus('Saved. Applies to new messages; an open message stays available.');}
 catch(_){inlineNewMessage.checked=!inlineNewMessage.checked;reportStatus('Unable to save. Please try again.');}
 finally{inlineNewMessage.disabled=false;}
});

const threadGuides = document.getElementById('thread-guides');
threadGuides.disabled = true;
browser.storage.local.get({threadGuides:true}).then(settings => {
  threadGuides.checked = settings.threadGuides !== false;
  threadGuides.disabled = false;
}).catch(() => { reportStatus('Unable to load settings.'); });
threadGuides.addEventListener('change', async () => {
  threadGuides.disabled = true;
  try {
    await browser.storage.local.set({threadGuides:threadGuides.checked});
    reportStatus('Saved.');
  } catch (_) {
    threadGuides.checked = !threadGuides.checked;
    reportStatus('Unable to save. Please try again.');
  } finally { threadGuides.disabled = false; }
});

const columnHeaders = document.getElementById('show-column-headers');
columnHeaders.disabled = true;
browser.storage.local.get({showColumnHeaders:false}).then(settings => {
  columnHeaders.checked = settings.showColumnHeaders === true;
  columnHeaders.disabled = false;
}).catch(() => reportStatus('Unable to load settings.'));
columnHeaders.addEventListener('change', async () => {
  columnHeaders.disabled = true;
  try {
    await browser.storage.local.set({showColumnHeaders:columnHeaders.checked});
    reportStatus('Saved.');
  } catch (_) {
    columnHeaders.checked = !columnHeaders.checked;
    reportStatus('Unable to save. Please try again.');
  } finally { columnHeaders.disabled = false; }
});

const searchResultsAsList=document.getElementById('search-results-as-list');
searchResultsAsList.disabled=true;
browser.storage.local.get({searchResultsAsList:true}).then(settings=>{
 searchResultsAsList.checked=settings.searchResultsAsList!==false;searchResultsAsList.disabled=false;
}).catch(()=>reportStatus('Unable to load settings.'));
searchResultsAsList.addEventListener('change',async()=>{
 searchResultsAsList.disabled=true;
 try{await browser.storage.local.set({searchResultsAsList:searchResultsAsList.checked});reportStatus('Saved. Applies to new searches.');}
 catch(_){searchResultsAsList.checked=!searchResultsAsList.checked;reportStatus('Unable to save. Please try again.');}
 finally{searchResultsAsList.disabled=false;}
});
