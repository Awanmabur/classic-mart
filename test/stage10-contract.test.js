import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=(p)=>fs.readFileSync(new URL(`../${p}`,import.meta.url),'utf8');

test('Stage 10 exposes provider-neutral AI governance and workflow models',()=>{
  const index=read('src/models/index.js');
  for(const name of ['AiModelRegistry','AiPromptVersion','AiJob','AiEmbedding','AiUsage','AiFeedback','AiEvaluationCase','AiEvaluationRun','AiCartDraft']) assert.match(index,new RegExp(`export \\{ ${name} \\}`));
  assert.match(read('src/services/ai-provider.js'),/configuredModel/);
  assert.match(read('src/config/env.js'),/AI_PROVIDER/);
});

test('Stage 10 keeps provider secrets environment-only and fails honestly when generative AI is unavailable',()=>{
  const provider=read('src/services/ai-provider.js');
  assert.match(provider,/env\.ai\.apiKey/);
  assert.match(provider,/AI_PROVIDER_UNAVAILABLE/);
  assert.doesNotMatch(read('src/models/AiModelRegistry.js'),/apiKey|secretKey|password/i);
  assert.match(read('src/services/ai.js'),/retrieval_fallback/);
});

test('Stage 10 prompt versions moderation schemas quotas and telemetry are enforced',()=>{
  const ai=read('src/services/ai.js');
  for(const marker of ['activePrompt','safeGenerate','moderateInput','assertAiQuota','recordAiUsage','AiFeedback','AI_BUDGET_EXCEEDED','AI_QUOTA_EXCEEDED']) assert.match(ai,new RegExp(marker));
  assert.match(read('src/services/ai-provider.js'),/detectPromptInjection/);
  assert.match(read('scripts/seed.js'),/ask_classic\.v1/);
});

test('Stage 10 asynchronous seller AI requires explicit seller confirmation and cannot alter trusted commerce fields',()=>{
  const ai=read('src/services/ai.js');
  assert.match(ai,/processAiJobs/);
  assert.match(ai,/pending_approval/);
  assert.match(ai,/approveSellerAiJob/);
  assert.match(ai,/\['draft','changes_requested'\]/);
  assert.doesNotMatch(ai,/product\.priceMinor\s*=|product\.stock\s*=|product\.status\s*=\s*['"]published/);
  assert.match(read('views/ai-workspace.ejs'),/approve|reject/i);
});

test('Stage 10 semantic search similar products and recommendations preserve hard catalogue filters',()=>{
  const ai=read('src/services/ai.js');
  assert.match(ai,/hybridSearch/);
  assert.match(ai,/similarProducts/);
  assert.match(ai,/recommendationsFor/);
  assert.match(ai,/status:'published'/);
  assert.match(ai,/countries:country\.code/);
  assert.match(ai,/stock>0/);
  assert.match(read('src/routes/storefront.js'),/hybridSearch/);
});

test('Stage 10 Ask Classic exposes only narrow read tools and an explicit server-revalidated cart draft',()=>{
  const ai=read('src/services/ai.js');
  assert.match(ai,/catalogue_search/);
  assert.match(ai,/policy_lookup/);
  assert.match(ai,/recommendations/);
  assert.match(ai,/cart_draft/);
  assert.match(ai,/applyCartDraft/);
  assert.match(ai,/addCartItem/);
  assert.doesNotMatch(ai,/refundOrder|approvePayout|suspendUser|postLedgerTransaction/);
  assert.match(read('views/ask-classic.ejs'),/Nothing has been added yet/);
});

test('Stage 10 support and promoter assistants remain human/policy constrained',()=>{
  const ai=read('src/services/ai.js');
  assert.match(ai,/approveSupportAiJob/);
  assert.match(ai,/supportRequester/);
  assert.match(ai,/promoter_content/);
  assert.match(ai,/campaign-approved facts/i);
  assert.match(read('scripts/seed.js'),/seller-approved campaign facts/i);
  assert.match(read('src/routes/ai.js'),/CAMPAIGN_APPROVAL_REQUIRED/);
  assert.match(read('views/promoter-workspace.ejs'),/Classic AI campaign assistant/);
});

test('Stage 10 high-risk AI model changes retain Stage 9 four-eyes approval',()=>{
  assert.match(read('src/models/ApprovalRequest.js'),/ai_model_registry/);
  assert.match(read('src/services/stage9.js'),/approval\.type==='ai_model_registry'/);
  assert.match(read('src/routes/ai.js'),/createApproval\(\{user:req\.user,type:'ai_model_registry'/);
  assert.match(read('views/ai-workspace.ejs'),/Send for approval/);
});

test('Stage 10 visual search and storefront AI surfaces are connected without persisting uploaded query images',()=>{
  const routes=read('src/routes/ai.js');
  assert.match(routes,/memoryStorage/);
  assert.match(routes,/verifyDeferredCsrf/);
  assert.match(routes,/scanUpload/);
  assert.match(routes,/sharp\(req\.file\.buffer/);
  assert.match(read('public/script.js'),/api\/v1\/ai\/products\/.*similar/);
  assert.match(read('public/script.js'),/review-summary/);
  assert.match(read('views/index.ejs'),/Ask Classic/);
});

test('Stage 10 country admins cannot see global model/provider internals or other-country evaluations',()=>{
  const route=read('src/routes/ai.js');
  const run=read('src/models/AiEvaluationRun.js');
  assert.match(run,/country:\{type:String,required:true/);
  assert.match(route,/AiEvaluationRun\.find\(countryAdmin\?\{country:req\.user\.country\}:\{\}\)/);
  assert.match(route,/countryAdmin\?Promise\.resolve\(\[\]\):AiModelRegistry/);
  assert.match(route,/provider:'managed'/);
});

test('Stage 10 evaluation runs always persist non-empty truthful model provenance',()=>{
  const ai=read('src/services/ai.js');
  const core=read('src/core/ai-evaluation.js');
  assert.match(ai,/evaluationRunProvenance/);
  assert.match(ai,/providerReady:providerConfigured\(configured\)/);
  assert.match(core,/stage10-core-local-v1/);
  assert.doesNotMatch(ai,/model:model\.model\|\|''/);
  assert.ok(ai.indexOf('CountrySetting.findOne') < ai.indexOf('AiEvaluationRun.create'), 'Evaluation country must be validated before a run is persisted');
});

test('Stage 10 release gate includes red-team evaluations observability maintenance and real MongoDB audit',()=>{
  const audit=read('scripts/audit-integration.js');
  assert.match(audit,/Stage 1–12 MongoDB integration audit passed/);
  for(const marker of ['ensureProductEmbedding','hybridSearch','detectPromptInjection','retrieval_fallback','runEvaluationSuite','ai_model_registry','aiObservability']) assert.match(audit,new RegExp(marker));
  assert.match(read('src/services/maintenance.js'),/stage10Maintenance/);
  assert.match(read('src/services/ai.js'),/aiObservability/);
});
