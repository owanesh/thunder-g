// Local compatibility bridge for DKIM Verifier 6.4.0 (background module).
// The original popup and DisplayAction methods run in the provider's own context.
const thunderGPopupMessages=new Map();let thunderGPopupSequence=-1000;
async function thunderGDisplayedMessage(tabId) {
  if(tabId < -1000)return thunderGPopupMessages.get(tabId)?.message ?? null;
  return await browser.messageDisplay.getDisplayedMessage(tabId);
}
function thunderGReleasePopup(contextId) {
  const item=thunderGPopupMessages.get(contextId);if(!item)return;
  clearTimeout(item.timer);thunderGPopupMessages.delete(contextId);displayedResultsCache.delete(contextId);
}
browser.runtime.onMessageExternal.addListener((request,sender)=>{
  if(sender.id !== 'thunder-g@vschiavoni' || request?.module !== 'ThunderG' || !['verify','bimi','details','release'].includes(request.method))return undefined;
  if(request.method==='bimi')return (async()=>{await isInitialized;const {default:DNS}=await import('../modules/dns.mjs.js');return {logo:await thunderGBimiLookup(request.domain,{baseDomain:request.baseDomain,txt:name=>DNS.txt(name),fetchLogo:thunderGFetchBimiLogo})};})();
  if(!Number.isInteger(request.messageId))return Promise.reject(new Error('Invalid message ID'));
  return (async()=>{
    await isInitialized;
    if(request.method==='release') {
      const item=thunderGPopupMessages.get(request.contextId);
      if(item?.message.id===request.messageId)thunderGReleasePopup(request.contextId);
      return {released:true};
    }
    const message=await browser.messages.get(request.messageId);
    const result=await verifier.verify(message);
    if(request.method==='details') {
      if(thunderGPopupMessages.size>=32)thunderGReleasePopup(thunderGPopupMessages.keys().next().value);
      const contextId=--thunderGPopupSequence;
      const timer=setTimeout(()=>thunderGReleasePopup(contextId),3600000);
      thunderGPopupMessages.set(contextId,{message,timer});displayedResultsCache.set(contextId,result);
      return {contextId};
    }
    return result;
  })();
});
