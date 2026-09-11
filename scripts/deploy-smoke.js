import fs from 'node:fs';

const pkg=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8'));
const base=String(process.env.DEPLOY_BASE_URL||'').replace(/\/$/,'');
const expectedSha=String(process.env.EXPECTED_BUILD_SHA||'').trim().toLowerCase();
const expectedVersion=String(process.env.EXPECTED_VERSION||pkg.version||'').trim();
const timeoutMs=Math.max(30_000,Math.min(30*60_000,Number(process.env.DEPLOY_SMOKE_TIMEOUT_MS)||15*60_000));
const pollMs=Math.max(2_000,Math.min(60_000,Number(process.env.DEPLOY_SMOKE_POLL_MS)||10_000));
if(!base)throw new Error('DEPLOY_BASE_URL is required.');
const url=new URL(base);
if(url.protocol!=='https:'&&process.env.DEPLOY_SMOKE_ALLOW_HTTP!=='true')throw new Error('Deployment smoke requires HTTPS.');
if(!expectedSha||expectedSha.length<12)throw new Error('EXPECTED_BUILD_SHA must contain at least 12 hexadecimal commit characters.');
if(!/^[0-9a-f]+$/.test(expectedSha))throw new Error('EXPECTED_BUILD_SHA must be hexadecimal.');

function shaMatches(actual,expected){
  actual=String(actual||'').trim().toLowerCase();expected=String(expected||'').trim().toLowerCase();
  if(!actual||actual==='unknown'||actual.length<12||!/^[0-9a-f]+$/.test(actual))return false;
  return actual===expected || (actual.length>=12&&expected.length>=12&&(actual.startsWith(expected)||expected.startsWith(actual)));
}
async function getJson(path){
  const response=await fetch(`${base}${path}`,{headers:{'user-agent':'Classic-Mart-Deploy-Smoke/2.13'},signal:AbortSignal.timeout(10_000),redirect:'manual'});
  const text=await response.text();let body={};try{body=JSON.parse(text);}catch{}
  return {response,body,text};
}
async function ready(){
  const [readyResult,versionResult]=await Promise.all([getJson('/health/ready'),getJson('/health/version')]);
  if(!readyResult.response.ok||readyResult.body?.status!=='ready')return {ok:false,reason:`ready=${readyResult.response.status}:${readyResult.body?.status||'invalid'}`};
  if(!versionResult.response.ok||versionResult.body?.status!=='ok')return {ok:false,reason:`version=${versionResult.response.status}`};
  if(expectedVersion&&String(versionResult.body.version||'')!==expectedVersion)return {ok:false,reason:`version mismatch ${versionResult.body.version||'missing'} != ${expectedVersion}`};
  if(!shaMatches(versionResult.body.buildSha,expectedSha))return {ok:false,reason:`build SHA mismatch ${versionResult.body.buildSha||'missing'} != ${expectedSha}`};
  return {ok:true,version:versionResult.body.version,buildSha:versionResult.body.buildSha,checks:readyResult.body.checks||{}};
}

const started=Date.now();let last='not checked';
while(Date.now()-started<timeoutMs){
  try{const result=await ready();if(result.ok){
    const live=await getJson('/health/live');if(!live.response.ok||live.body?.status!=='ok')throw new Error(`live probe failed (${live.response.status})`);
    const publicPage=await fetch(`${base}/products`,{headers:{'user-agent':'Classic-Mart-Deploy-Smoke/2.13'},signal:AbortSignal.timeout(10_000),redirect:'manual'});
    if(publicPage.status>=500)throw new Error(`public products smoke returned ${publicPage.status}`);
    console.log(JSON.stringify({status:'pass',baseUrl:url.origin,expectedVersion,expectedBuildSha:expectedSha,actualBuildSha:result.buildSha,checks:result.checks,elapsedMs:Date.now()-started},null,2));
    process.exit(0);
  }last=result.reason;}catch(error){last=error.message;}
  console.log(`Deployment not ready yet: ${last}`);await new Promise(resolve=>setTimeout(resolve,pollMs));
}
throw new Error(`Deployment smoke timed out after ${timeoutMs} ms: ${last}`);
