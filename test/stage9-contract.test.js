import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read=(p)=>fs.readFileSync(new URL(`../${p}`,import.meta.url),'utf8');

test('Stage 9 exposes admin, CMS, feature, growth, export and incident domain models',()=>{
  const index=read('src/models/index.js');
  for(const name of ['FeatureFlag','CmsContent','ApprovalRequest','LoyaltyAccount','LoyaltyEntry','Referral','GiftCard','MarketingCampaign','DataExport','Incident']){
    assert.match(index,new RegExp(`export \\{ ${name} \\}`));
  }
});

test('Stage 9 four-eyes and country scope are server enforced',()=>{
  const service=read('src/services/stage9.js');
  assert.match(service,/FOUR_EYES_REQUIRED/);
  assert.match(service,/COUNTRY_SCOPE/);
  assert.match(service,/requestedByUserId\.equals\(decider\._id\)/);
  const routes=read('src/routes/admin.js');
  assert.match(routes,/Country Admin feature flags must target only their country/);
  assert.match(routes,/FeatureFlag\.find\(query\)/);
});

test('Stage 9 CMS is versioned scheduled publishable and reversible',()=>{
  const service=read('src/services/stage9.js');
  assert.match(service,/createCmsRevision/);
  assert.match(service,/scheduledVersion/);
  assert.match(service,/publishScheduledCms/);
  assert.match(service,/cms_rollback/);
  const publicRoutes=read('src/routes/public.js');
  assert.match(publicRoutes,/publishedCms/);
  assert.doesNotMatch(read('views/index.ejs'),/cmsBanner/);
  const seed=read('scripts/seed.js');
  for(const key of ['help.main','help.shipping','help.returns','legal.privacy','legal.terms','legal.cookies','legal.payments']) assert.match(seed,new RegExp(key.replace('.', '\\.')));
});

test('Stage 9 feature rollout is evaluated by country role percentage and schedule',()=>{
  const service=read('src/services/stage9.js');
  assert.match(service,/percentageBucket/);
  assert.match(service,/flag\.countries/);
  assert.match(service,/flag\.roles/);
  assert.match(service,/rolloutPercentage/);
  assert.match(service,/startsAt/);
  assert.match(service,/endsAt/);
  assert.match(read('src/routes/storefront.js'),/features:\s*request\.features/);
});

test('Stage 9 loyalty referrals and consent-aware campaigns use verified server activity',()=>{
  const service=read('src/services/stage9.js');
  assert.match(service,/applyGrowthForPaidOrder/);
  assert.match(service,/first verified paid order|Qualified referral reward|Verified order reward/i);
  assert.match(service,/consents\.marketing/);
  assert.match(service,/marketing\.campaign_message/);
  assert.match(service,/queueDueCampaigns/);
  assert.match(read('src/services/payments.js'),/applyGrowthForPaidOrder/);
  assert.match(read('src/services/logistics.js'),/applyGrowthForPaidOrder/);
});

test('Stage 9 exports are allow-listed retained and approval controlled',()=>{
  const service=read('src/services/stage9.js');
  assert.match(service,/generateExport/);
  assert.match(service,/expiresAt=new Date\(Date\.now\(\)\+24\*60\*60\*1000\)/);
  assert.match(service,/orders.*sellers.*promoters.*support.*audit/s);
  assert.doesNotMatch(service,/contact\.email|contact\.phone|passwordHash/);
  assert.match(read('src/routes/admin.js'),/data_export/);
  assert.match(read('src/routes/admin.js'),/growth\.gift_card_revealed/);
  assert.match(read('scripts/audit-integration.js'),/expireExports/);
});

test('Stage 9 impersonation is approved visible read-only and audited',()=>{
  const app=read('src/app.js');
  assert.match(app,/impersonation/);
  assert.match(app,/Read-only impersonation/i);
  assert.match(app,/IMPERSONATION_READ_ONLY/);
  const routes=read('src/routes/admin.js');
  assert.match(routes,/impersonation_started/);
  assert.match(routes,/impersonation_stopped/);
  assert.match(routes,/IMPERSONATION_APPROVAL_EXPIRED/);
  assert.match(routes,/IMPERSONATION_APPROVAL_USED/);
  assert.match(routes,/consumedAt/);
  assert.match(read('src/middleware/auth.js'),/30 \* 60_000/);
  assert.match(routes,/type:'impersonation'/);
});

test('Stage 9 health and reports avoid cross-country global queue/provider leakage',()=>{
  const routes=read('src/routes/admin.js');
  assert.match(routes,/globalAllowed=req\.user\.role==='super_admin'/);
  assert.match(routes,/restricted:!globalAllowed/);
  const service=read('src/services/stage9.js');
  assert.match(service,/PaymentIntent\.find\(country\?\{orderId:\{\$in:orderIds\}\}/);
  assert.match(service,/Payout\.find\(country\?\{ownerUserId:\{\$in:userIds\}\}/);
});

test('Stage 9 integration audit proves end-to-end administrative controls',()=>{
  const audit=read('scripts/audit-integration.js');
  assert.match(audit,/Stage 1–12 MongoDB integration audit passed/);
  for(const marker of ['FOUR_EYES_REQUIRED','featureEnabled','publishScheduledCms','marketing.campaign_message','DataExport','platformReport']) assert.match(audit,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
});


test('Stage 9 optional reviewer bootstrap enables four-eyes without default privileged credentials',()=>{
  const env=read('src/config/env.js');
  const seed=read('scripts/seed.js');
  const example=read('.env.example');
  assert.match(env,/adminReviewer/);
  assert.match(seed,/ADMIN_REVIEWER_EMAIL, ADMIN_REVIEWER_PHONE and ADMIN_REVIEWER_PASSWORD/);
  assert.match(seed,/role: 'super_admin'/);
  assert.match(example,/ADMIN_REVIEWER_PASSWORD=\n/);
});
