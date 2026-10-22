// DNS-published logo discovery only: no certificate, favicon or directory requests.
const thunderGBimiCache=new Map();
function thunderGBimiURL(records) {
  const candidates=(records || []).filter(value=>/^v=BIMI1\s*;/i.test(value.trim()));
  if(candidates.length!==1)return null;
  const tags=new Map();
  for(const item of candidates[0].split(';')) {
    if(!item.trim())continue;
    const match=item.trim().match(/^([a-z]+)\s*=\s*(.*)$/i);
    if(!match || tags.has(match[1].toLowerCase()))return null;
    tags.set(match[1].toLowerCase(),match[2].trim());
  }
  if(tags.get('v')!=='BIMI1' || !tags.get('l'))return null;
  try {
    const url=new URL(tags.get('l'));
    if(url.protocol!=='https:' || url.username || url.password || url.port || url.hash)return null;
    if(!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(url.hostname) || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname) || /^[\d.]+$/.test(url.hostname))return null;
    return url.href;
  }catch(_){return null;}
}
async function thunderGBimiLookup(domain,{txt,fetchLogo,baseDomain,now=Date.now}={}) {
  if(typeof domain!=='string' || domain.length>253 || !domain.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) || !domain.includes('.'))return null;
  domain=domain.toLowerCase();
  const cached=thunderGBimiCache.get(domain);if(cached && cached.expires>now())return cached.promise;
  const promise=(async()=>{
    let result=await txt(`default._bimi.${domain}`);
    if(result.bogus || ![0,3].includes(result.rcode))return null;
    const hasRecord=(result.data || []).some(value=>/^v=BIMI1\s*;/i.test(value.trim()));
    if(!hasRecord && baseDomain && domain.endsWith('.'+baseDomain) && /^[a-z0-9.-]+$/i.test(baseDomain)) {
      result=await txt(`default._bimi.${baseDomain}`);
      if(result.bogus || result.rcode!==0)return null;
    }
    const url=thunderGBimiURL(result.data);if(!url)return null;
    return await fetchLogo(url);
  })().catch(()=>null);
  if(thunderGBimiCache.size>=128)thunderGBimiCache.delete(thunderGBimiCache.keys().next().value);
  thunderGBimiCache.set(domain,{expires:now()+3600000,promise});return promise;
}
async function thunderGFetchBimiLogo(url) {
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try {
    const response=await fetch(url,{credentials:'omit',referrerPolicy:'no-referrer',redirect:'error',cache:'force-cache',signal:controller.signal});
    if(!response.ok || !/^image\/svg\+xml(?:\s*;|$)/i.test(response.headers.get('content-type') || ''))return null;
    if(Number(response.headers.get('content-length'))>65536)return null;
    const reader=response.body.getReader(),chunks=[];let length=0;
    while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>65536){await reader.cancel();return null;}chunks.push(value);}
    const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    const svg=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    // Only a static, self-contained SVG is accepted; never insert downloaded markup in a document.
    if(/<\?(?!xml\s)/i.test(svg))return null;
    const parsed=new DOMParser().parseFromString(svg,'image/svg+xml');
    if(parsed.documentElement.localName!=='svg' || parsed.querySelector('parsererror') || parsed.doctype)return null;
    const allowed=new Set(['svg','g','path','rect','circle','ellipse','line','polyline','polygon','defs','linearGradient','radialGradient','stop','clipPath','title','desc']);
    for(const element of parsed.querySelectorAll('*')) {
      if(element.namespaceURI!=='http://www.w3.org/2000/svg' || !allowed.has(element.localName))return null;
      for(const attr of element.attributes) {
        if(attr.namespaceURI==='http://www.w3.org/2000/xmlns/')continue;
        if(/^on/i.test(attr.name) || /(?:href|src|base)$/i.test(attr.localName) || /(?:https?:|data:|@import|expression\s*\(|\\)/i.test(attr.value))return null;
        for(const match of attr.value.matchAll(/url\s*\(([^)]*)\)/gi))if(!/^\s*['"]?#[a-z0-9_-]+['"]?\s*$/i.test(match[1]))return null;
      }
    }
    return 'data:image/svg+xml;base64,'+btoa(String.fromCharCode(...bytes));
  }finally{clearTimeout(timer);}
}
