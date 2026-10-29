const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm'),fs=require('node:fs');
function scope(){const s=require('./localization-context.cjs').createContext({URL});vm.runInContext(fs.readFileSync('integrations/bimi-lookup.js','utf8'),s);return s;}
test('BIMI requires a single unambiguous DNS record with a public HTTPS logo URL',()=>{
 const s=scope(),url=r=>s.thunderGBimiURL(r);
 assert.equal(url(['v=BIMI1; l=https://brand.example/logo.svg; a=https://brand.example/cert.pem']),'https://brand.example/logo.svg');
 for(const records of [[],['v=BIMI1;l='],['v=BIMI1;l=http://brand.example/logo.svg'],['v=BIMI1;l=https://user@brand.example/logo.svg'],['v=BIMI1;l=https://127.0.0.1/logo.svg'],['v=BIMI1;l=https://brand.example/a;l=https://brand.example/b'],['v=BIMI1;l=https://brand.example/a','v=BIMI1;l=https://brand.example/b']])assert.equal(url(records),null);
});
test('BIMI fetches only the DNS-declared logo once and caches both absence and failures',async()=>{
 const s=scope(),queries=[],downloads=[];const options={txt:async name=>{queries.push(name);return {rcode:0,data:['v=BIMI1;l=https://brand.example/logo.svg;a=https://brand.example/cert.pem']}},fetchLogo:async url=>{downloads.push(url);return 'logo'}};
 assert.equal(await s.thunderGBimiLookup('brand.example',options),'logo');assert.equal(await s.thunderGBimiLookup('brand.example',options),'logo');
 assert.deepEqual(queries,['default._bimi.brand.example']);assert.deepEqual(downloads,['https://brand.example/logo.svg']);
 let count=0;const missing={txt:async()=>{count++;return {rcode:3}},fetchLogo:()=>{throw Error('must not download')}};
 assert.equal(await s.thunderGBimiLookup('absent.example',missing),null);assert.equal(await s.thunderGBimiLookup('absent.example',missing),null);assert.equal(count,1);
 assert.equal(await s.thunderGBimiLookup('bad/domain',options),null);
});
test('BIMI organizational fallback respects explicit opt-out and DNS failures',async()=>{
 for(const [data,rcode,expected] of [[null,3,2],[['v=BIMI1;l='],0,1],[null,2,1]]){
 const s=scope();let calls=0;await s.thunderGBimiLookup('mail.brand.example',{baseDomain:'brand.example',txt:async()=>{calls++;return {data,rcode}},fetchLogo:async()=>null});assert.equal(calls,expected);
 }
});
test('BIMI discovery is gated by aligned successful DKIM rather than the display name',()=>{
 const s=require('./localization-context.cjs').createContext({});vm.runInContext(fs.readFileSync('thunder-g/independent-reader.js','utf8'),s);
 const base=domain=>domain.split('.').slice(-2).join('.');
 assert.equal(s.independentBimiDomain('sender@mail.brand.example',{dkim:[{result:'SUCCESS',sdid:'brand.example'}]},base),'mail.brand.example');
 for(const result of [null,{dkim:[{result:'PERMFAIL',sdid:'brand.example'}]},{dkim:[{result:'SUCCESS',sdid:'attacker.example'}]}])assert.equal(s.independentBimiDomain('sender@brand.example',result,base),null);
});
test('logo download accepts a static SVG namespace and blocks additional requests, active SVG and oversized data',async()=>{
 for(const variant of ['valid','script','external','oversize','redirect']){
  let requests=0,cancelled=false,read=false;
  const bytes=new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>');
  const elements=[{localName:variant==='script'?'script':'svg',namespaceURI:'http://www.w3.org/2000/svg',attributes:[{name:'xmlns',localName:'xmlns',namespaceURI:'http://www.w3.org/2000/xmlns/',value:'http://www.w3.org/2000/svg'},...(variant==='external'?[{name:'style',localName:'style',value:'fill:url(https://other.example/tracker)'}]:[])]}];
  const s=require('./localization-context.cjs').createContext({URL,AbortController,TextDecoder,Uint8Array,setTimeout,clearTimeout,btoa:value=>Buffer.from(value,'binary').toString('base64'),
   DOMParser:class{parseFromString(){return {documentElement:{localName:'svg'},querySelector:()=>null,querySelectorAll:()=>elements}}},
   fetch:async(url,options)=>{requests++;assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.referrerPolicy,'no-referrer');if(variant==='redirect')throw Error('redirect');return {ok:true,headers:{get:name=>name==='content-type'?'image/svg+xml':null},body:{getReader:()=>({async read(){if(read)return {done:true};read=true;return {value:variant==='oversize'?new Uint8Array(65537):bytes}},async cancel(){cancelled=true}})}};}
  });vm.runInContext(fs.readFileSync('integrations/bimi-lookup.js','utf8'),s);
  let logo;try{logo=await s.thunderGFetchBimiLogo('https://brand.example/logo.svg')}catch(_){}
  if(variant==='valid')assert.match(logo,/^data:image\/svg\+xml;base64,/);else assert.ok(!logo);
  assert.equal(requests,1);if(variant==='oversize')assert.equal(cancelled,true);
 }
});
