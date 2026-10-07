import 'dotenv/config';
const base=String(process.env.LOAD_TEST_URL||process.env.BASE_URL||'http://localhost:3000').replace(/\/$/,'');
const concurrency=Math.max(1,Math.min(200,Number(process.env.LOAD_TEST_CONCURRENCY)||20));
const requests=Math.max(concurrency,Math.min(20_000,Number(process.env.LOAD_TEST_REQUESTS)||200));
const maxP95=Number(process.env.LOAD_TEST_MAX_P95_MS)||1500;
const maxErrorRate=Number(process.env.LOAD_TEST_MAX_ERROR_RATE)||0.01;
const paths=['/','/products','/categories','/search?q=classic','/health/live'];
let cursor=0;const latencies=[];const statuses={};let errors=0;
async function worker(){while(true){const index=cursor++;if(index>=requests)return;const target=base+paths[index%paths.length];const started=performance.now();try{const response=await fetch(target,{headers:{'user-agent':'Classic-Mart-Load-Smoke/2.12'},signal:AbortSignal.timeout(10_000)});latencies.push(performance.now()-started);statuses[response.status]=(statuses[response.status]||0)+1;if(response.status>=400)errors++;await response.arrayBuffer();}catch{latencies.push(performance.now()-started);errors++;statuses.network_error=(statuses.network_error||0)+1;}}}
await Promise.all(Array.from({length:concurrency},worker));
latencies.sort((a,b)=>a-b);const percentile=p=>latencies[Math.min(latencies.length-1,Math.max(0,Math.ceil((p/100)*latencies.length)-1))]||0;
const result={requests,concurrency,p50Ms:Math.round(percentile(50)),p95Ms:Math.round(percentile(95)),p99Ms:Math.round(percentile(99)),errorRate:Number((errors/requests).toFixed(4)),statuses};
console.log(JSON.stringify(result,null,2));
if(result.p95Ms>maxP95||result.errorRate>maxErrorRate){console.error(`Load smoke gate failed (max p95 ${maxP95} ms, max error rate ${maxErrorRate}).`);process.exit(1);}
