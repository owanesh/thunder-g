// The provider authenticates our extension ID; no sender or result is synthesized.
browser.inlineLabels.onDkimRequest.addListener(async(request,messageId,domain,baseDomain,details,popupContext)=>{
  let result;
  try {result=await browser.runtime.sendMessage('dkim_verifier@pl',domain?{module:'ThunderG',method:'bimi',domain,baseDomain}:{module:'ThunderG',method:popupContext?'release':details?'details':'verify',messageId,contextId:popupContext});if(!(domain?result && 'logo' in result:popupContext?result?.released:details?Number.isInteger(result?.contextId):result?.dkim))throw new Error('DKIM bridge unavailable');}
  catch(_){result={error:'DKIM Verifier integration unavailable'};}
  await browser.inlineLabels.resolveDkim(request,JSON.stringify(result));
});
async function startThunderG() {
  // Optional settings must never prevent the companion from starting.
  let independentReader = false, hideTodayPane = false, messagesPerPage = 0, composeAutosave = true, composeAutosaveMinutes = 1;
  try {
    const settings = await browser.storage.local.get({independentReader:false,hideTodayPane:false,messagesPerPage:0,composeAutosave:true,composeAutosaveMinutes:1});
    hideTodayPane = settings.hideTodayPane === true;
    independentReader = settings.independentReader === true;
    messagesPerPage = settings.messagesPerPage;
    composeAutosave = settings.composeAutosave !== false;
    composeAutosaveMinutes = settings.composeAutosaveMinutes;
  } catch (error) { console.warn('Thunder-G: using default settings.',error); }
  await browser.inlineLabels.setHideTodayPane(hideTodayPane);
  await browser.inlineLabels.setComposeAutosave(composeAutosave,composeAutosaveMinutes || 1);
  await browser.inlineLabels.setMessagesPerPage(messagesPerPage || 0);
  await browser.inlineLabels.setIndependentReader(independentReader);
  await browser.inlineLabels.setBimiEnabled?.((await browser.storage.local.get({bimiEnabled:false})).bimiEnabled===true);
  await browser.inlineLabels.setInlineReplyEnabled?.((await browser.storage.local.get({inlineReplyEnabled:false})).inlineReplyEnabled===true);
  await browser.inlineLabels.start();
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.composeAutosave || changes.composeAutosaveMinutes)) {
      if (changes.composeAutosave) composeAutosave = changes.composeAutosave.newValue !== false;
      if (changes.composeAutosaveMinutes) composeAutosaveMinutes = changes.composeAutosaveMinutes.newValue || 1;
      browser.inlineLabels.setComposeAutosave(composeAutosave,composeAutosaveMinutes || 1).catch(console.error);
    }
    if (area === 'local' && changes.messagesPerPage) {
      browser.inlineLabels.setMessagesPerPage(changes.messagesPerPage.newValue || 0).catch(console.error);
    }
    if (area === 'local' && changes.independentReader) {
      browser.inlineLabels.setIndependentReader(changes.independentReader.newValue === true).catch(console.error);
    }
    if(area==='local' && changes.inlineReplyEnabled)browser.inlineLabels.setInlineReplyEnabled(changes.inlineReplyEnabled.newValue===true).catch(console.error);
    if(area==='local' && changes.bimiEnabled)browser.inlineLabels.setBimiEnabled(changes.bimiEnabled.newValue===true).catch(console.error);
    if (area === 'local' && changes.hideTodayPane) {
      browser.inlineLabels.setHideTodayPane(changes.hideTodayPane.newValue === true).catch(console.error);
    }
  });
}
startThunderG().catch(console.error);
