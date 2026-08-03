import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const required = [
  '.gitignore','.dockerignore','.env.example','package-lock.json','RELEASE_NOTES_v2.13.6.md','scripts/reset-local.js',
  'public/styles.css','public/role-dashboard.css','public/cart-store.js','public/cart-page.js','public/delivery-offline.js',
  'public/assets/vendor/qrcode.min.js','public/assets/vendor/qrcodejs-LICENSE.txt',
  'src/app.js','src/server.js','src/core/indexes.js','src/core/procurement.js','src/middleware/csrf.js','src/services/sms.js','src/core/local-mongo.js','src/core/env-file.js',
  'src/models/StoreMember.js','src/models/InventoryLot.js','src/models/SellerOrder.js','src/models/BusinessOrganization.js','src/models/BusinessMember.js','src/models/BusinessBudget.js','src/models/ProcurementRequest.js','src/models/QuoteRequest.js','src/models/PurchaseOrder.js','src/models/ProcurementTemplate.js','src/models/SellerPromotion.js','src/models/PriceSchedule.js','src/models/StoreBroadcast.js',
  'src/models/CampaignApplication.js','src/models/DeliveryOffer.js','src/models/Parcel.js',
  'src/models/EvidenceDocument.js','src/models/SupportKnowledge.js','src/models/SatisfactionSurvey.js',
  'src/models/RiskSignal.js','src/models/OperationAction.js','src/models/Refund.js','src/models/SecurityEvent.js','src/models/IpBlock.js','src/models/SecurityFinding.js','src/models/LaunchEvidence.js','src/models/MfaRecoveryRequest.js','src/models/MobileSession.js','src/models/MobileRefreshUse.js','src/models/PushDevice.js','src/models/ApiClient.js','src/models/ApiIdempotency.js','src/models/WebhookEndpoint.js','src/models/WebhookDelivery.js','src/models/AiModelRegistry.js','src/models/AiPromptVersion.js','src/models/AiJob.js','src/models/AiEmbedding.js','src/models/AiUsage.js','src/models/AiFeedback.js','src/models/AiEvaluationCase.js','src/models/AiEvaluationRun.js','src/models/AiCartDraft.js','src/models/FeatureFlag.js','src/models/CmsContent.js','src/models/ApprovalRequest.js','src/models/LoyaltyAccount.js','src/models/LoyaltyEntry.js','src/models/Referral.js','src/models/GiftCard.js','src/models/MarketingCampaign.js','src/models/DataExport.js','src/models/Incident.js',
  'src/services/storefront.js','src/services/checkout.js','src/services/security.js','src/services/mfa.js','src/services/launch.js','src/services/payments.js','src/services/inventory.js','src/services/stage9.js','src/services/stage11.js','src/services/product-media-url.js','src/services/ai.js','src/services/ai-provider.js','src/services/business.js','src/services/seller-growth.js','src/services/outbox.js',
  'src/services/promoters.js','src/services/logistics.js','src/services/trust.js','src/services/malware.js',
  'src/routes/storefront.js','src/routes/checkout.js','src/routes/payments.js','src/routes/promoters.js',
  'src/routes/logistics.js','src/routes/trust.js','src/routes/seller.js','src/routes/account.js','src/routes/admin.js','src/routes/rewards.js','src/routes/ai.js','src/routes/business.js','src/routes/seller-growth.js','src/routes/stage11.js',
  'views/index.ejs','views/login.ejs','views/mfa.ejs','views/dashboard.ejs','views/cart.ejs',
  'views/catalog-workspace.ejs','views/moderation-workspace.ejs','views/money-workspace.ejs',
  'views/promoter-workspace.ejs','views/logistics-workspace.ejs','views/returns-workspace.ejs','views/support-workspace.ejs','views/admin.ejs','views/rewards.ejs','views/ask-classic.ejs','views/ai-workspace.ejs','views/business-workspace.ejs','views/seller-growth.ejs','views/mobile-app.ejs','views/connected-apps.ejs','views/developer-portal.ejs','views/offline.ejs',
  'scripts/audit-integration.js','scripts/audit-frontend.js','scripts/audit-functionality.js','scripts/check-release-scripts.js','scripts/check-imports.js','scripts/security-check.js','scripts/security-sbom.js','scripts/load-smoke.js','scripts/backup-drill.js','scripts/launch-check.js','scripts/verify-mongo.js','scripts/ensure-local-mongo.js','scripts/stop-local-mongo.js','scripts/cleanup-legacy-infra.js','docs/STAGE_1_8_AUDIT.md','docs/ARCHITECTURE.md','docs/ROUTE_MAP.md',
  'docs/THREAT_MODEL.md','docs/FULL_VERIFICATION_v2.13.6.md','docs/FRONTEND_DATA_FUNCTIONALITY_MATRIX_v2.13.5.md','docs/STAGES.md','docs/STAGE_12_SECURITY_AND_LAUNCH.md','docs/ASVS_SELF_REVIEW.md','docs/SBOM_v2.13.6.cdx.json','docs/ops/cloudflare/README.md','docs/STAGE_9_GATE_MATRIX.md','docs/STAGE_10_GATE_MATRIX.md','docs/STAGE_11_GATE_MATRIX.md','docs/MOBILE_PWA_READINESS.md','docs/UI_MIGRATION.md','test/view-system.test.js','test/project-checker-contract.test.js','test/index-maintenance.test.js','test/stage12-security.test.js','test/stage10-contract.test.js','test/stage11-contract.test.js','test/stage11-readiness.test.js','test/business-seller-growth.test.js','test/procurement-core.test.js','test/local-reset.test.js','test/final-qa.test.js','test/role-qa.test.js','test/role-workflow-qa.test.js','test/frontend-end-to-end.test.js','test/profile-route-qa.test.js','test/commerce-functionality-qa.test.js','test/platform-interaction-qa.test.js','test/storefront-v2.13.6-qa.test.js','public/manifest.webmanifest','public/sw.js','public/pwa.js','public/openapi-v1.json','public/assets/pwa-192.png','public/assets/pwa-512.png',
];
const missing = required.filter((file) => !fs.existsSync(path.join(root, file)));
if (missing.length) throw new Error(`Missing required Stage 1–12 files: ${missing.join(', ')}`);

function filesUnder(directory, extension) {
  return fs.readdirSync(directory,{withFileTypes:true}).flatMap((entry)=>{
    const location=path.join(directory,entry.name);
    return entry.isDirectory()?filesUnder(location,extension):(location.endsWith(extension)?[location]:[]);
  });
}
function read(rel){return fs.readFileSync(path.join(root,rel),'utf8');}
function assertPattern(pattern, helperName, rel) {
  if (!(pattern instanceof RegExp)) {
    throw new TypeError(`${helperName} pattern for ${rel} must be a RegExp.`);
  }
}
function requireMatch(rel,pattern,message){assertPattern(pattern,'requireMatch',rel);if(!pattern.test(read(rel)))throw new Error(message||`${rel} is missing ${pattern}`);}
function forbidMatch(rel,pattern,message){assertPattern(pattern,'forbidMatch',rel);if(pattern.test(read(rel)))throw new Error(message||`${rel} contains forbidden ${pattern}`);}

for (const file of [...filesUnder(path.join(root,'src'),'.js'), ...filesUnder(path.join(root,'scripts'),'.js'), ...filesUnder(path.join(root,'public'),'.js'), ...filesUnder(path.join(root,'test'),'.js')]) {
  const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
  if(result.status!==0)throw new Error(`JavaScript syntax error in ${path.relative(root,file)}:\n${result.stderr}`);
}

for(const file of filesUnder(path.join(root,'views'),'.ejs')){
  const source=fs.readFileSync(file,'utf8');
  ejs.compile(source,{filename:file});
  for(const match of source.matchAll(/\b(?:src|href)=["']([^"']+)["']/gi)){
    const reference=match[1].split(/[?#]/,1)[0];
    if(!/\.(?:css|js|svg|png|webp|jpe?g|gif)$/i.test(reference)||/^(?:https?:|data:|<%)/i.test(reference))continue;
    const localPath=path.join(root,'public',reference.replace(/^\/+/,''));
    if(!fs.existsSync(localPath))throw new Error(`Missing local asset ${reference} referenced by ${path.relative(root,file)}`);
  }
  for(const form of source.matchAll(/<form\b[^>]*method=["']?post["']?[^>]*>[\s\S]*?<\/form>/gi)){
    if(!/name=["']_csrf["']/i.test(form[0]))throw new Error(`POST form without CSRF token in ${path.relative(root,file)}`);
  }
  if(/api\.iconify\.design/i.test(source))throw new Error(`Remote interface icon remains in ${path.relative(root,file)}`);
}


// v2.11.1 final presentation contract: real EJS templates, clean URLs and root-relative bundled assets.
const legacyViewFiles = filesUnder(path.join(root,'views'),'.html');
if (legacyViewFiles.length) throw new Error(`Legacy .html view templates remain: ${legacyViewFiles.map((file)=>path.relative(root,file)).join(', ')}`);
requireMatch('src/app.js',/set\(['"]view engine['"],\s*['"]ejs['"]\)/,'Express is not configured with the native EJS view engine.');
forbidMatch('src/app.js',/app\.engine\(['"]html['"]/,'Legacy HTML-as-EJS engine registration remains.');
for (const file of filesUnder(path.join(root,'views'),'.ejs')) {
  const rel = path.relative(root,file);
  const source = fs.readFileSync(file,'utf8');
  if (/\b(?:href|action)=["'][^"']*\.html(?:[?#][^"']*)?["']/i.test(source)) throw new Error(`Legacy .html navigation remains in ${rel}`);
  if (/\b(?:src|href)=["'](?:assets\/|dashboard-assets\/|(?:styles|shared-shell|storefront-pages|marketplace-pages|info-pages|people-pages|profile-pages|server-ui|wishlist|onboarding-role|catalog-workspace|dashboard-workspaces|dashboard)\.css|(?:script|shared-shell|cart-store|cart-page|catalog-page|compare|identity|info-pages|people-page|profile-page|track-order|wishlist|catalog-workspace|dashboard|delivery-offline|country-switcher|pwa|image-fallback)\.js)["']/i.test(source)) throw new Error(`Relative bundled asset path remains in ${rel}; use a root-relative / path.`);
}
for (const file of filesUnder(path.join(root,'src'),'.js')) {
  const rel=path.relative(root,file); const source=fs.readFileSync(file,'utf8');
  if (/\.render\(["'][^"']+\.(?:html|ejs)["']/.test(source)) throw new Error(`Render call in ${rel} should use extensionless EJS view names.`);
}

for(const file of filesUnder(path.join(root,'public'),'.css')){
  const source=fs.readFileSync(file,'utf8');
  if(/\b(?:repeating-)?(?:linear|radial|conic)-gradient\s*\(/i.test(source))throw new Error(`Blueprint-forbidden gradient remains in ${path.relative(root,file)}`);
  for(const match of source.matchAll(/\burl\(["']?([^"')]+)["']?\)/gi)){
    const reference=match[1].split(/[?#]/,1)[0]; if(/^(?:https?:|data:)/i.test(reference))continue;
    if(!fs.existsSync(path.resolve(path.dirname(file),reference)))throw new Error(`Missing CSS asset ${reference} referenced by ${path.relative(root,file)}`);
  }
}


// v2.8.2 audit hotfixes: request-boundary NoSQL injection defense must not rewrite internal operators.
requireMatch('src/config/db.js',/sanitizeFilter', false/,'Global sanitizeFilter must not rewrite trusted server-built Mongo operators.');
requireMatch('src/middleware/request.js',/UNSAFE_INPUT_KEY/,'Mongo operator/path request-key rejection is missing.');
requireMatch('views/error.ejs',/typeof user !== ['"]undefined['"]/,'Error page is unsafe before user middleware runs.');
requireMatch('views/catalog-workspace.ejs',/typeof storeMembership !== ['"]undefined['"]/,'Seller workspace cannot render safely without middleware locals.');
forbidMatch('src/models/ReconciliationRun.js',/\berrors\s*:/,'Reconciliation model uses Mongoose-reserved errors path.');
requireMatch('src/models/ReconciliationRun.js',/errorMessages\s*:/,'Reconciliation errorMessages field is missing.');
forbidMatch('src/models/PromoterLink.js',/couponCode:\{[^}]*index:true/,'Promoter couponCode declares a duplicate inline index.');
requireMatch('src/routes/storefront.js',/authenticated:\s*Boolean\(request\.user\)/,'Public storefront state summary does not distinguish guest/authenticated state.');


// v2.8.12 local-infrastructure gate: development can bootstrap a transaction-capable local MongoDB without Docker or cloud credentials.
requireMatch('src/config/env.js',/mongoUri:\s*projectMongoUri\(\)/,'Runtime database authority must use deterministic project MongoDB resolution.');
requireMatch('src/core/project-env.js',/projectMongoMode/,'Project MongoDB environment resolver is missing.');
requireMatch('src/config/db.js',/MONGO_URI is required/,'Runtime database connection must fail clearly if setup has not provided MONGO_URI.');
requireMatch('src/core/local-mongo.js',/classicmart-rs/,'Local MongoDB replica-set identity is missing.');
requireMatch('scripts/ensure-local-mongo.js',/CLASSIC_MART_LOCAL_REPLICA_SET/,'Local MongoDB bootstrap must consume the shared replica-set identity.');
requireMatch('scripts/ensure-local-mongo.js',/--replSet/,'Local MongoDB must start with replica-set support.');
requireMatch('scripts/ensure-local-mongo.js',/replSetInitiate/,'Local MongoDB bootstrap must initialize its own isolated replica set.');
requireMatch('scripts/ensure-local-mongo.js',/MongoDB\.Server/,'Windows local setup must support trusted MongoDB Community Server installation.');
requireMatch('scripts/ensure-local-mongo.js',/NODE_ENV === 'production'/,'Automatic local database bootstrap must be disabled in production.');
requireMatch('scripts/ensure-local-mongo.js',/managed local MongoDB is not reachable[\s\S]*restarting it with preserved data/i,'Managed local MongoDB must restart automatically after it stops.');
requireMatch('scripts/ensure-local-mongo.js',/SAVED_MANAGED_LOCAL/,'Local MongoDB bootstrap must recover duplicate/stale MONGO_URI entries from older upgrades.');
requireMatch('scripts/ensure-local-mongo.js',/resolveDevelopmentMongoBootstrap/,'Local MongoDB bootstrap must deterministically separate local and external development modes.');
requireMatch('.env.example',/^MONGO_MODE=local$/m,'Fresh local configuration must default to managed local MongoDB.');
requireMatch('scripts/ensure-local-mongo.js',/upsertUniqueEnvValue/,'Local MongoDB bootstrap must canonicalize duplicate environment settings.');
forbidMatch('scripts/ensure-local-mongo.js',/docker compose|Docker Desktop/,'Local MongoDB setup must not depend on Docker.');
requireMatch('scripts/verify-mongo.js',/assertMongoTransactions/,'MongoDB verification must require transaction support without changing topology.');
forbidMatch('scripts/verify-mongo.js',/replSetInitiate|docker compose|spawnSync\(['"]docker/,'MongoDB verification must not initialize topology or depend on Docker.');
requireMatch('scripts/audit-integration.js',/^import ['"]dotenv\/config['"];?/m,'Integration audit must load .env before reading MongoDB configuration.');
requireMatch('scripts/audit-integration.js',/mongoUriWithDatabase/,'Integration audit must derive an isolated audit database when AUDIT_MONGO_URI is blank.');
requireMatch('scripts/audit-integration.js',/classic-mart-audit-test/,'Integration audit database suffix is missing.');
requireMatch('scripts/audit-integration.js',/verify-mongo\.js/,'Integration audit must verify its own MongoDB URI.');
requireMatch('.env.example',/AUDIT_MONGO_URI=/,'Audit MongoDB configuration is missing from .env.example.');
requireMatch('.env.example',/REDIS_URL=\s*(?:\r?\n)/,'Redis must be optional by default.');
requireMatch('.gitignore',/\.classic-mart\//,'Local MongoDB data directory must be ignored by git.');
requireMatch('.dockerignore',/\.classic-mart(?:\/|\s|$)/m,'Local MongoDB data directory must be excluded from Docker build contexts.');
requireMatch('scripts/cleanup-legacy-infra.js',/compose\.yaml/,'Legacy infrastructure cleanup must remove old Classic Mart Compose files when upgrading in place.');

// No Stage 1–8 commerce/identity authority may be restored to browser persistence.
for(const file of filesUnder(path.join(root,'public'),'.js')){
  const source=fs.readFileSync(file,'utf8');
  if(/\b(?:localStorage|sessionStorage)\b/.test(source))throw new Error(`Browser-authoritative persistence remains in ${path.relative(root,file)}`);
  if(/dummyjson\.com|CLASSIC10 applied|EXPRESS_DELIVERY_MINOR/i.test(source))throw new Error(`Demo commerce logic remains in ${path.relative(root,file)}`);
}
for(const file of ['public/auth.js','public/onboarding.js'])if(fs.existsSync(path.join(root,file)))throw new Error(`Obsolete browser identity script remains: ${file}`);

for(const file of filesUnder(path.join(root,'views'),'.ejs')) forbidMatch(path.relative(root,file),/class="app-badge"\s+href="#"|href="#"\s+class="app-badge"/,'Unpublished mobile app CTA is presented as a live download link.');

for(const file of filesUnder(path.join(root,'views'),'.ejs')) {
  forbidMatch(path.relative(root,file),/<form[^>]+id="subscribeForm"/,'Stage 9 newsletter UI must not collect email before the backend exists.');
  forbidMatch(path.relative(root,file),/href="https:\/\/(?:facebook|x|instagram|youtube|pinterest)\.com\/?"/,'Generic social-network homepages must not be presented as official Classic Mart channels.');
  forbidMatch(path.relative(root,file),/id="careerForm"[^>]*>[\s\S]*?<input/s,'Careers must not collect application data without a real backend.');
}

for(const view of ['login.ejs','signup.ejs','forgot-password.ejs','reset-password.ejs','verify-email.ejs','verify-phone.ejs']){
  const source=read(`views/${view}`);
  if(!source.includes('name="_csrf"'))throw new Error(`Missing CSRF field in views/${view}`);
  if(/localStorage|demo account|front-end demo/i.test(source))throw new Error(`Browser-demo identity text remains in views/${view}`);
}

// Stage 1: both email and phone verification are server-side gates; production SMS must fail closed.
requireMatch('src/middleware/auth.js',/phoneVerifiedAt/,'Protected account routes do not require phone verification.');
requireMatch('src/routes/identity.js',/\/verify-phone/,'Phone verification routes are missing.');
requireMatch('src/services/auth.js',/verify_phone/,'Phone verification token lifecycle is missing.');
requireMatch('src/services/sms.js',/SMS_MODE|twilio/i,'Production SMS adapter is missing.');
requireMatch('src/config/env.js',/Production requires SMS_MODE=twilio/,'Production does not require a real SMS provider.');
requireMatch('src/routes/account.js',/phoneChanged[\s\S]*phoneVerifiedAt\s*=\s*null/,'Changing a phone number does not revoke phone verification.');
requireMatch('scripts/seed.js',/phoneVerifiedAt:\s*new Date\(\)/,'Seeded super admin is not explicitly phone verified.');

// Stage 2: secure multipart KYC/media must verify CSRF after Multer and scan/re-encode uploads.
requireMatch('src/routes/seller.js',/verifyDeferredCsrf/,'Seller multipart routes do not perform deferred CSRF verification.');
requireMatch('src/routes/trust.js',/verifyDeferredCsrf/,'Trust evidence multipart routes do not perform deferred CSRF verification.');
requireMatch('src/services/media.js',/scanUpload/,'Upload media pipeline does not invoke malware scanning.');
requireMatch('src/services/media.js',/sharp\(/,'Upload media pipeline does not decode/re-encode images.');
requireMatch('src/config/env.js',/Production requires MALWARE_SCAN_MODE=clamd or clamscan/,'Production does not fail closed when malware scanning is disabled.');

// Stage 3: discovery loops must be connected, not record-only placeholders.
for(const pattern of [/\$text/,/ProductVariant/,/barcode/,/totalResults/,/publishedProductsByPublicIds/,/publishedSellers/])requireMatch('src/services/storefront.js',pattern,'Stage 3 database search/read model is incomplete.');
for(const pattern of [/SearchEvent/,/ProductAlert/,/ProductQuestion/,/search\/:searchId\/click/,/randomToken/])requireMatch('src/routes/storefront.js',pattern,'Stage 3 discovery/analytics route loop is incomplete.');

// Cross-stage order access: a verified tracked-order grant must authorize receipt, payment retry and cancellation consistently.
requireMatch('src/services/order-access.js',/orderAccessQuery/,'Shared tracked-order authorization helper is missing.');
requireMatch('src/services/checkout.js',/orderAccessQuery\(request, orderId\)/,'Checkout cancellation/read access does not use the shared tracked-order grant.');
requireMatch('src/services/payments.js',/orderAccessQuery\(request, orderId\)/,'Payment retry does not honor verified tracked-order grants.');
requireMatch('test/order-access.test.js',/tracked order grant authorizes the exact order/,'Tracked-order grant regression test is missing.');

// Public storefront actions must not discard user input behind decorative forms.
requireMatch('src/routes/checkout.js',/\/api\/v1\/delivery-location/,'Server-backed delivery-location preference is missing.');
requireMatch('public/script.js',/Checking delivery coverage/,'Delivery-location modal is not connected to the server.');
forbidMatch('views/index.ejs',/id="loginEmail"|id="loginPassword"/,'The home account modal still collects credentials without authenticating them.');
forbidMatch('views/index.ejs',/<form class="stack-form" id="sellerForm"/,'The home seller modal still collects business data without onboarding persistence.');

// Cart browser state must be declared and CSRF must come from the server cart/session.
requireMatch('public/cart-page.js',/let catalog\s*=\s*\[\]/,'Cart catalogue state is undeclared in strict mode.');
requireMatch('public/cart-page.js',/let csrfToken\s*=\s*['"]/,'Cart CSRF state is undeclared in strict mode.');
requireMatch('public/cart-store.js',/getCsrfToken/,'Cart store does not expose the server CSRF token to cart-page actions.');
forbidMatch('public/cart-page.js',/else\s*\{\s*(?:delete\s+cart|cart\[id\]\s*=|cart\s*=\s*\{\})/s,'Cart page still contains a browser-only mutation fallback.');

// Stage 4: one marketplace order must create seller orders and re-quote configured fulfilment.
for(const pattern of [/SellerOrder/,/PickupPoint/,/ShippingZone/,/withTransaction/,/idempotency/i])requireMatch('src/services/checkout.js',pattern,'Stage 4 checkout is missing a server-authoritative invariant.');

// Stage 5: verified money, holds, COD/manual refund and strict webhook verification.
for(const pattern of [/verifyFlutterwaveTransaction/,/postLedgerTransaction/,/payout-hold:/,/completeManualRefund/,/cod_clearing/,/refund\.allocations/,/affectedStores/,/payload_hash/,/PARTIAL_REFUND_ALLOCATION_REQUIRED/])requireMatch('src/services/payments.js',pattern,'Stage 5 money workflow is incomplete.');
requireMatch('src/services/payments.js',/createHmac\('sha256'/,'Flutterwave webhook HMAC verification is missing.');
forbidMatch('src/services/payments.js',/signature\s*===\s*env\.flwWebhookSecret/,'Legacy secret-as-signature webhook acceptance must not return.');
requireMatch('views/money-workspace.ejs',/manual-complete/,'Finance UI cannot complete controlled COD refunds.');

// Stage 6: promoter lifecycle must be reviewable and two-sided.
for(const pattern of [/submitted/,/CampaignApplication/,/CommissionEntry/,/revers/i,/fraud/i,/policy/i])requireMatch('src/services/promoters.js',pattern,'Stage 6 promoter lifecycle is incomplete.');
requireMatch('views/promoter-workspace.ejs',/campaign/i,'Promoter campaign UI is missing.');
requireMatch('src/routes/promoters.js',/review|approve/i,'Campaign/promoter review route is missing.');

// Stage 7: jobs must be offered, parcels fulfilled and warehouse actions executable.
for(const pattern of [/DeliveryOffer/,/Parcel/,/PARCEL_HANDOFF_REQUIRED/,/reconcileCod/])requireMatch('src/services/logistics.js',pattern,'Stage 7 logistics workflow is incomplete.');
requireMatch('src/routes/logistics.js',/OperationAction/,'Stage 7 idempotent offline action persistence is missing.');
requireMatch('public/delivery-offline.js',/indexedDB/,'Delivery offline action queue is missing.');
requireMatch('src/core/roles.js',/'warehouse'/,'Dedicated warehouse staff role is missing.');
requireMatch('src/routes/logistics.js',/warehouseOpsOnly/,'Warehouse operations are not permission-separated.');
forbidMatch('src/routes/logistics.js',/role==='support'.*operations\/logistics|operations\/logistics.*role==='support'/s,'Support agents must not receive warehouse/logistics mutation authority.');

// Stage 8: evidence, real exchange/refund separation, support and appeals must be usable from UI.
for(const pattern of [/EvidenceDocument/,/RiskSignal/,/createVerifiedReview/,/createDispute/,/createTicket/])requireMatch('src/services/trust.js',pattern,'Stage 8 trust workflow is incomplete.');
requireMatch('src/routes/trust.js',/trust-cases\/:id\/appeal/,'Customer trust-case appeal route is missing.');
requireMatch('src/routes/trust.js',/\/support\/request/,'Public Help/Contact support intake route is missing.');
requireMatch('src/routes/trust.js',/createPublicSupportTicket/,'Public support intake is not persisted through the trust service.');
requireMatch('views/returns-workspace.ejs',/account\/trust-cases\/<%=c\.publicId%>\/appeal/,'Buyer Protection UI cannot appeal trust decisions.');

// Two-sided seller/customer interactions cannot be backend-only.
requireMatch('src/routes/account.js',/\/account\/messages/,'Customer seller-message inbox is missing.');
requireMatch('src/routes/seller.js',/\/seller\/messages/,'Seller message inbox is missing.');
requireMatch('src/routes/seller.js',/\/seller\/questions/,'Seller Q&A inbox is missing.');

// A Stage 1–11 release must require a real database smoke audit, not string-only contract checks.
const pkg=JSON.parse(read('package.json'));
if(!String(pkg.scripts?.['release:check']||'').includes('audit:integration'))throw new Error('release:check does not execute the Stage 1–11 MongoDB integration audit.');
requireMatch('scripts/audit-integration.js',/Stage 1–12 MongoDB integration audit passed/,'Integration audit success gate is missing.');
requireMatch('scripts/audit-integration.js',/audit-test/,'Integration audit is not isolated to a dedicated audit database.');
for(const pattern of [/secondStore/,/sellerOrderPublicIds\.length, 2/,/parcels\.length, 2/,/must never debit Seller B payable/,/refundAllocations/])requireMatch('scripts/audit-integration.js',pattern,'Integration audit does not prove multi-seller Stage 4–8 isolation.');
requireMatch('src/models/Refund.js',/allocations/,'Refund model does not preserve item/store allocation snapshots.');
requireMatch('src/models/ReturnRequest.js',/storePublicId/,'Return items do not preserve seller ownership for exact refunds.');


// Stage 9: Admin, CMS, analytics and measured growth must be server-authoritative and country scoped.
for(const pattern of [/ApprovalRequest/,/FeatureFlag/,/CmsContent/,/LoyaltyAccount/,/Referral/,/GiftCard/,/MarketingCampaign/,/DataExport/,/Incident/])requireMatch('src/models/index.js',pattern,'Stage 9 domain model is missing.');
for(const pattern of [/FOUR_EYES_REQUIRED/,/COUNTRY_SCOPE/,/featureEnabled/,/createCmsRevision/,/publishScheduledCms/,/applyGrowthForPaidOrder/,/queueConsentCampaign/,/generateExport/,/platformReport/])requireMatch('src/services/stage9.js',pattern,'Stage 9 service invariant is missing.');
requireMatch('src/routes/admin.js',/Country Admin feature flags must target only their country/,'Country Admin feature rollout scope is not enforced.');
requireMatch('src/routes/admin.js',/globalAllowed=req\.user\.role==='super_admin'/,'Country Admin platform-health view leaks global system state.');
requireMatch('src/app.js',/IMPERSONATION_READ_ONLY/,'Read-only impersonation mutation blocker is missing.');
requireMatch('src/app.js',/Read-only impersonation/,'Visible impersonation banner is missing.');
requireMatch('src/routes/admin.js',/IMPERSONATION_APPROVAL_EXPIRED/,'Impersonation approval expiry is missing.');
requireMatch('src/routes/admin.js',/IMPERSONATION_APPROVAL_USED/,'Impersonation approvals are not single-use.');
requireMatch('src/middleware/auth.js',/30 \* 60_000/,'Impersonation session expiry is missing.');
requireMatch('src/routes/public.js',/publishedCms/,'Published CMS is not connected to public pages.');
requireMatch('src/routes/storefront.js',/features:\s*request\.features/,'Evaluated feature flags are not exposed to storefront clients.');
requireMatch('src/services/maintenance.js',/stage9Maintenance/,'Scheduled CMS/campaign/export maintenance is not registered.');
requireMatch('scripts/seed.js',/home\.banner\.primary/,'Stage 9 seed does not provide database-backed default CMS content.');
requireMatch('scripts/seed.js',/rewards\.center/,'Stage 9 seed does not provide default feature configuration.');
requireMatch('scripts/seed.js',/ADMIN_REVIEWER_EMAIL, ADMIN_REVIEWER_PHONE and ADMIN_REVIEWER_PASSWORD/,'Optional Stage 9 four-eyes reviewer bootstrap is missing.');
requireMatch('scripts/audit-integration.js',/Stage 1–12 MongoDB integration audit passed/,'Stage 9/10/11 real MongoDB integration gate is missing.');
for(const pattern of [/FOUR_EYES_REQUIRED/,/publishScheduledCms/,/marketing\.campaign_message/,/DataExport/,/platformReport/])requireMatch('scripts/audit-integration.js',pattern,'Stage 9 integration audit does not prove a required workflow.');
requireMatch('test/stage9-contract.test.js',/Stage 9 four-eyes/,'Stage 9 regression suite is missing.');
requireMatch('.gitignore',/storage\/exports/,'Generated privacy exports must be ignored by git.');
requireMatch('.dockerignore',/storage\/exports/,'Generated privacy exports must be excluded from Docker build contexts.');



// Cross-section blueprint commitments completed in the cumulative Stage 10 build.
for(const pattern of [/BusinessOrganization/,/BusinessMember/,/BusinessBudget/,/ProcurementRequest/,/QuoteRequest/,/PurchaseOrder/,/ProcurementTemplate/,/SellerPromotion/,/PriceSchedule/,/StoreBroadcast/])requireMatch('src/models/index.js',pattern,'Business-buyer or Seller Growth domain model is missing.');
for(const pattern of [/FOUR_EYES_REQUIRED/,/SPENDING_LIMIT_EXCEEDED/,/BUDGET_EXCEEDED/,/createQuoteRequest/,/approvedAmountMinor/,/QUOTE_ALREADY_ACTIVE/,/acceptQuote/,/cancelProcurementRequest/,/BUDGET_RELEASE_CONFLICT/,/processRecurringProcurement/])requireMatch('src/services/business.js',pattern,'Business-buyer workflow invariant is missing.');
requireMatch('src/services/business.js',/status:'submitted'/,'Recurring procurement must create an approval request rather than auto-purchasing.');
requireMatch('src/services/business.js',/parseProcurementCsv/,'Business procurement CSV bulk import is missing.');
requireMatch('src/routes/business.js',/business\/requests\/import/,'Business procurement bulk-import route is missing.');
requireMatch('views/business-workspace.ejs',/Business audit history/,'Business audit history is not visible.');
requireMatch('src/services/business.js',/QUOTE_EXCEEDS_APPROVAL/,'Seller quotation can exceed the approved procurement amount.');
requireMatch('src/models/QuoteRequest.js',/procurementRequestId/,'Quotation requests are not bound to approved procurement requests.');
requireMatch('src/models/QuoteRequest.js',/approvedAmountMinor/,'Seller-specific approved quotation amount is not snapshotted.');
requireMatch('src/models/BusinessBudget.js',/spentMinor/,'Business budget does not distinguish actual spend from open commitment.');
requireMatch('src/models/ProcurementRequest.js',/partially_ordered/,'Multi-seller procurement partial-order state is missing.');
requireMatch('src/routes/business.js',/business\/requests\/:id\/cancel/,'Explicit procurement cancellation route is missing.');

for(const pattern of [/MINIMUM_PRICE_VIOLATION/,/voucher/,/bundle/,/quantity_break/,/free_shipping/,/sponsored/,/queueStoreBroadcast/,/'consents\.marketing':true/,/sellerRespondQuote/,/decidePurchaseOrder/,/partially_ordered/,/seller_rejected/,/fulfilled/,/spentMinor/])requireMatch('src/services/seller-growth.js',pattern,'Seller Growth workflow invariant is missing.');
requireMatch('src/services/seller-growth.js',/promotionMarginPreview/,'Seller campaign margin preview is missing.');
requireMatch('src/services/seller-growth.js',/availableCapacity/,'Stacked promotions are not capped against minimum-price floors.');
requireMatch('views/seller-growth.ejs',/Preview margin/,'Seller campaign margin preview is not exposed in the Seller Center.');
requireMatch('src/services/checkout.js',/promotionQuote/,'Seller promotions are not recomputed by the server checkout.');
requireMatch('src/services/money.js',/export function sellerSettlementBreakdown\(sellerOrder\)/,'Shared seller settlement calculation is missing.');
requireMatch('src/services/money.js',/subtotalMinor - appliedDiscountMinor/,'Seller settlement does not subtract seller-funded discounts.');
requireMatch('src/services/payments.js',/sellerSettlementBreakdown\s*}\s*from ['"]\.\/money\.js['"]/,'Verified payment flow does not import the shared seller settlement calculation.');
requireMatch('src/services/payments.js',/sellerSettlementBreakdown\(sellerOrder\)/,'Verified payment flow does not use the shared seller settlement calculation.');
requireMatch('src/services/logistics.js',/sellerSettlementBreakdown\s*}\s*from ['"]\.\/money\.js['"]/,'COD reconciliation does not import the shared seller settlement calculation.');
requireMatch('src/services/logistics.js',/sellerSettlementBreakdown\(sellerOrder\)/,'COD reconciliation does not use the shared seller settlement calculation.');
requireMatch('src/services/trust.js',/discountMinor/,'Returns/refunds ignore the actual discounted amount paid.');
forbidMatch('public/script.js',/Promo\s*3%/i,'Fake fixed storefront promotion badge remains.');
requireMatch('src/routes/storefront.js',/activeSponsoredProducts/,'Sponsored placements are not driven by server promotion records.');
requireMatch('src/services/outbox.js',/processNotificationOutbox/,'Consent-aware notification outbox processor is missing.');
requireMatch('src/services/outbox.js',/Development mail sink: no external email was sent\./,'Development notifications must not pretend an external email was delivered.');
requireMatch('scripts/audit-integration.js',/createProcurementRequest/,'Real integration audit does not exercise business procurement.');
requireMatch('scripts/audit-integration.js',/one seller acceptance must leave/,'Real integration audit does not prove multi-seller procurement isolation.');
requireMatch('scripts/audit-integration.js',/cancelProcurementRequest/,'Real integration audit does not prove committed-budget cancellation release.');
requireMatch('src/services/business.js',/remainingApprovedMinor\(row\.items,covered\)/,'Procurement cancellation does not calculate remaining commitment from authoritative item fields.');
forbidMatch('src/services/business.js',/\{\.\.\.item,quantity:/,'Mongoose procurement subdocuments must not be spread into plain objects for budget math.');
requireMatch('scripts/audit-integration.js',/applyCartPromotionCode/,'Real integration audit does not exercise seller-funded cart discounts.');
requireMatch('scripts/audit-integration.js',/processNotificationOutbox/,'Real integration audit does not exercise seller broadcast delivery.');
requireMatch('test/business-seller-growth.test.js',/business buyer domain covers/,'Business/seller-growth regression suite is missing.');
requireMatch('test/procurement-core.test.js',/remainingProcurementItems/,'Procurement-core regression suite is missing.');
requireMatch('test/local-reset.test.js',/local reset is explicit/,'Local-reset regression suite is missing.');


// v2.13.6 cumulative UI/PWA and end-to-end commerce functionality contract.
for (const rel of ['views/index.ejs','views/mobile-app.ejs','views/connected-apps.ejs']) {
  requireMatch(rel,/manifest\.webmanifest/,`${rel} is missing the PWA manifest link.`);
  requireMatch(rel,/\/pwa\.js/,`${rel} is missing the PWA install bootstrap.`);
}
requireMatch('views/index.ejs',/id=["']categoryCountBadge["']/, 'Homepage category count is not bound to the database-driven catalogue.');
forbidMatch('views/index.ejs',/tiny-badge["']>9</, 'Homepage still contains the old hard-coded category count.');
requireMatch('public/shared-shell.js',/locationModal:\s*["']\/\?location=1#top["']/, 'Internal delivery-location control does not deep-link to the existing location workflow.');
requireMatch('public/script.js',/params\.get\(["']location["']\)\s*===\s*["']1["']/, 'Homepage cannot open the delivery-location workflow from an internal-page deep link.');
requireMatch('public/sw.js',/classic-mart-public-v17/, 'Service-worker cache namespace was not advanced for the frontend data/functionality release.');
requireMatch('test/final-qa.test.js',/PWA install surfaces load the manifest/, 'Final UI/PWA QA regression suite is missing.');


// v2.13.6 role-by-role UI and workflow QA contract.
for (const pattern of [/\.catalog-topbar \{/,/\.catalog-actions \{/,/\.catalog-form \{/,/\.table-wrap \{/,/\.catalogue-table-wrap \{/,/\.secondary-button \{/]) requireMatch('public/server-ui.css',pattern,'Shared operational workspace styling is incomplete.');
requireMatch('src/middleware/view.js',/formatMoney\(value, currency/,'Role workspaces are missing shared locale-aware money formatting.');
requireMatch('src/services/promoters.js',/CAMPAIGN_PRODUCT_SCOPE/,'Seller campaigns are not restricted to owned published products.');
requireMatch('views/seller-campaigns.ejs',/name="productPublicIds" value="<%=product\.publicId%>"/,'Seller campaign UI is not using database-backed product choices.');
forbidMatch('views/seller-campaigns.ejs',/Product public IDs, comma separated/,'Seller campaign UI still asks users to type raw product IDs.');
requireMatch('src/services/business.js',/sellerStores:eligibleStores/,'Business buyer workspace does not expose eligible seller choices.');
requireMatch('views/business-workspace.ejs',/Select a published product/,'Business buyer workspace does not offer database-backed product choices.');
requireMatch('views/business-workspace.ejs',/Select verified seller/,'Business buyer workspace does not offer database-backed seller choices.');
requireMatch('test/role-qa.test.js',/role workspaces share a real responsive operational shell/,'Role UI QA regression suite is missing.');
requireMatch('test/role-workflow-qa.test.js',/seller campaign creation is scoped/,'Role workflow QA regression suite is missing.');
requireMatch('test/frontend-end-to-end.test.js',/public discovery, editorial and customer proof surfaces are database backed/,'Frontend end-to-end regression suite is missing.');
requireMatch('test/profile-route-qa.test.js',/profile aliases preserve seller slugs and promoter IDs/,'Profile route regression suite is missing.');


// v2.13.6 product preview, variant cart and reliable mutation contract.
requireMatch('package.json',/"functionality:audit":\s*"node scripts\/audit-functionality\.js"/,'End-to-end functionality audit script is not registered.');
requireMatch('package.json',/frontend:audit && npm run functionality:audit && npm test/,'Functionality audit is not part of the release gate.');
requireMatch('public/script.js',/setText\('#previewUnitPrice', money\(product\.price \* quantity, product\.currency\)\)/,'Product preview original price does not increase with quantity.');
forbidMatch('public/script.js',/previewLineTotal|previewUnitPriceNote|preview-line-total/,'Product preview still renders a duplicate quantity price.');
requireMatch('public/script.js',/setPreviewVariant\(previewOption\.dataset\.previewOption\)/,'Product preview option selection does not update price/stock state.');
requireMatch('public/script.js',/const added = await addToCart\(buyNow\.dataset\.buyNow, previewState\.quantity, previewState\.variantId\)/,'Buy Now does not persist selected variant and quantity before navigation.');
requireMatch('public/cart-store.js',/id: item\.variantId/,'Browser cart does not keep separate variant lines.');
requireMatch('public/cart-page.js',/data-cart-plus="\$\{escapeHtml\(lineId\)\}"/,'Cart quantity controls do not target the selected variant line.');
forbidMatch('public/cart-page.js',/if \(!latest\.length && Object\.keys\(cart\)\.length\) return/,'Clearing the final cart line can leave stale UI.');
forbidMatch('src/services/checkout.js',/const qty = Math\.min\(quantity, sellable\.available/,'Cart additions still silently clamp insufficient stock.');
requireMatch('scripts/audit-integration.js',/two variants of one product must remain separate cart lines/,'Real MongoDB audit does not prove multi-variant cart behavior.');
requireMatch('test/commerce-functionality-qa.test.js',/product preview recalculates price, stock and SKU/,'Commerce functionality regression suite is missing.');
requireMatch('scripts/audit-functionality.js',/actionless form #\$\{id\} has no handler/,'Platform actionless-form wiring audit is missing.');
requireMatch('scripts/audit-functionality.js',/non-submit button “\$\{label\}” has no handler/,'Platform button wiring audit is missing.');
forbidMatch('views/cart.ejs',/id=["'](?:orderComplete|copyOrderNumber)["']/,'Dead client-only order confirmation remains in the cart page.');
requireMatch('test/platform-interaction-qa.test.js',/all actionless forms and non-submit buttons are wired/,'Platform interaction regression suite is missing.');


// Stage 10: Classic AI production must remain grounded, provider-neutral, observable and incapable of protected actions.
for(const pattern of [/AiModelRegistry/,/AiPromptVersion/,/AiJob/,/AiEmbedding/,/AiUsage/,/AiFeedback/,/AiEvaluationCase/,/AiEvaluationRun/,/AiCartDraft/])requireMatch('src/models/index.js',pattern,'Stage 10 AI domain model is missing.');
requireMatch('src/services/ai-provider.js',/configuredModel/,'Provider-neutral AI model registry resolution is missing.');
requireMatch('src/services/ai-provider.js',/AI_PROVIDER_UNAVAILABLE/,'AI provider must fail honestly when not configured.');
requireMatch('src/services/ai-provider.js',/detectPromptInjection/,'Prompt-injection protection is missing.');
forbidMatch('src/models/AiModelRegistry.js',/apiKey|secretKey|password/i,'AI provider secrets must not be stored in the model registry.');
for(const pattern of [/safeGenerate/,/moderateInput/,/assertAiQuota/,/recordAiUsage/,/hybridSearch/,/similarProducts/,/recommendationsFor/,/askClassic/,/applyCartDraft/,/approveSellerAiJob/,/approveSupportAiJob/,/runEvaluationSuite/,/aiObservability/])requireMatch('src/services/ai.js',pattern,'Stage 10 AI service invariant is missing.');
requireMatch('src/services/ai.js',/retrieval_fallback/,'Ask Classic does not expose an honest no-provider fallback.');
requireMatch('src/services/ai.js',/status:'published'/,'Semantic discovery does not preserve publication hard filters.');
requireMatch('src/services/ai.js',/stock>0/,'Semantic discovery/recommendations do not preserve stock hard filters.');
forbidMatch('src/services/ai.js',/refundOrder|approvePayout|suspendUser|postLedgerTransaction/,'AI service exposes protected financial/enforcement authority.');
requireMatch('src/routes/ai.js',/memoryStorage/,'Visual search must process query images in memory.');
requireMatch('src/routes/ai.js',/verifyDeferredCsrf/,'Visual-search multipart CSRF protection is missing.');
requireMatch('src/routes/ai.js',/CAMPAIGN_APPROVAL_REQUIRED/,'Promoter AI is not constrained to approved campaign access.');
requireMatch('src/models/AiEvaluationRun.js',/country:\{type:String,required:true/,'AI evaluation runs are not country scoped.');
requireMatch('src/routes/ai.js',/AiEvaluationRun\.find\(countryAdmin\?\{country:req\.user\.country\}:\{\}\)/,'Country Admin AI evaluation history is not country scoped.');
requireMatch('src/routes/ai.js',/countryAdmin\?Promise\.resolve\(\[\]\):AiModelRegistry/,'Country Admin can see global AI model registry internals.');
requireMatch('src/models/ApprovalRequest.js',/ai_model_registry/,'High-risk AI model registry changes are outside the four-eyes approval domain.');
requireMatch('src/services/stage9.js',/approval\.type==='ai_model_registry'/,'Four-eyes AI model registry application is missing.');
requireMatch('src/routes/ai.js',/createApproval\(\{user:req\.user,type:'ai_model_registry'/,'AI model registry route bypasses Stage 9 approvals.');
requireMatch('src/services/maintenance.js',/stage10Maintenance/,'Asynchronous Stage 10 AI worker is not registered in maintenance.');
requireMatch('scripts/seed.js',/promoter\.content\.v1/,'Promoter AI prompt version is missing.');
requireMatch('scripts/seed.js',/stage10-core/,'Stage 10 evaluation seed suite is missing.');
requireMatch('public/script.js',/review-summary/,'Product review-summary AI is not connected to the storefront.');
requireMatch('public/script.js',/\/similar/,'Similar-products AI is not connected to the storefront.');
requireMatch('views/index.ejs',/Ask Classic/,'Ask Classic is not discoverable from the storefront.');
requireMatch('test/stage10-contract.test.js',/Stage 10 release gate/,'Stage 10 regression suite is missing.');
requireMatch('scripts/audit-integration.js',/Stage 1–12 MongoDB integration audit passed/,'Stage 10/11 real MongoDB integration gate is missing.');
for(const pattern of [/ensureProductEmbedding/,/hybridSearch/,/detectPromptInjection/,/retrieval_fallback/,/runEvaluationSuite/,/ai_model_registry/,/aiObservability/])requireMatch('scripts/audit-integration.js',pattern,'Stage 10 integration audit does not prove a required workflow.');


// Stage 11: installable PWA, shared mobile authority and scoped external integrations.
for(const pattern of [/MobileSession/,/MobileRefreshUse/,/PushDevice/,/ApiClient/,/ApiIdempotency/,/WebhookEndpoint/,/WebhookDelivery/])requireMatch('src/models/index.js',pattern,'Stage 11 domain model is missing.');
for(const pattern of [/issueMobileTokens/,/refreshMobileTokens/,/REFRESH_REUSE/,/authenticateApiClient/,/SELLER_API_SCOPES/,/executeExternalIdempotency/,/assertWebhookTarget/,/postPinnedWebhook/,/deliverWebhookBatch/,/processPushOutbox/])requireMatch('src/services/stage11.js',pattern,'Stage 11 service invariant is missing.');
requireMatch('src/services/stage11.js',/safeEqual\(client\.secretHash,candidate\)/,'Seller API key verification is not timing-safe.');
requireMatch('src/services/stage11.js',/https\.request/,'Webhook delivery is not pinned to a vetted DNS result.');
for(const pattern of [/\/api\/v1\/mobile\/catalogue/,/\/api\/v1\/mobile\/cart/,/\/api\/v1\/mobile\/checkout\/review/,/\/api\/v1\/mobile\/orders/,/\/api\/v1\/seller\/inventory/,/If-Match/,/requestId/])requireMatch('src/routes/stage11.js',pattern,'Stage 11 API route or concurrency guard is missing.');
requireMatch('src/middleware/csrf.js',/Bearer-authenticated mobile\/seller APIs/,'Token-authenticated APIs are not separated from browser-cookie CSRF semantics.');
requireMatch('public/sw.js',/PRIVATE_PREFIXES/,'PWA private-route cache denylist is missing.');
requireMatch('public/sw.js',/cache:'no-store'/,'PWA trusted commerce routes are not forced network-only.');
for(const icon of ['public/assets/pwa-192.png','public/assets/pwa-512.png'])if(!fs.existsSync(path.join(root,icon)))throw new Error(`Stage 11 install icon missing: ${icon}`);
requireMatch('public/manifest.webmanifest',/"display"\s*:\s*"standalone"/,'PWA manifest is not installable.');
requireMatch('views/index.ejs',/Classic Mart PWA/,'Installable app is not discoverable from the storefront.');
forbidMatch('views/index.ejs',/PLANNED FOR<strong>Stage 11/,'Storefront still claims Stage 11 app is only planned.');
forbidMatch('src/app.js',/images\.unsplash\.com/,'Storefront image rendering still depends on remote Unsplash assets.');
requireMatch('src/services/product-media-url.js',/source === 'seed_asset'/,'Seeded catalogue media does not use bundled local image assets.');
requireMatch('src/routes/seller.js',/\/seller\/developers/,'Seller Developer Portal is not registered.');
requireMatch('views/developer-portal.ejs',/will not be shown again/i,'Developer secrets are not presented as one-time reveal values.');
const openapi=JSON.parse(read('public/openapi-v1.json'));for(const pathName of ['/api/v1/mobile/catalogue','/api/v1/mobile/cart','/api/v1/mobile/orders','/api/v1/seller/inventory','/api/v1/seller/orders'])if(!openapi.paths?.[pathName])throw new Error(`OpenAPI missing ${pathName}`);
requireMatch('src/routes/stage11.js',/assetlinks\.json/,'Android app-link association route is missing.');
requireMatch('src/routes/stage11.js',/apple-app-site-association/,'Apple universal-link association route is missing.');
requireMatch('src/services/maintenance.js',/deliverWebhookBatch/,'Webhook delivery worker is not registered.');
requireMatch('src/services/maintenance.js',/processPushOutbox/,'Push delivery worker is not registered.');
requireMatch('scripts/audit-integration.js',/Stage 1–12 MongoDB integration audit passed/,'Stage 11 real MongoDB integration gate is missing.');
for(const pattern of [/issueMobileTokens/,/mobile cart price must equal/,/mobile cart availability must equal the authoritative published variant stock/,/liveVariantForMobile/,/REFRESH_REUSE/,/createApiClient/,/INVENTORY_VERSION_CONFLICT/,/WEBHOOK_SSRF_BLOCKED/,/image fix/])requireMatch('scripts/audit-integration.js',pattern,'Stage 11 integration audit does not prove a required workflow.');
requireMatch('test/stage11-readiness.test.js',/Stage 11 mobile network contract/,'Stage 11 network/background/store readiness suite is missing.');

// Stage 12: detection/prevention, real MFA, SIEM integrity, recovery evidence and fail-closed launch gates.
for(const pattern of [/SecurityEvent/,/IpBlock/,/SecurityFinding/,/LaunchEvidence/,/MfaRecoveryRequest/])requireMatch('src/models/index.js',pattern,'Stage 12 security domain model is missing.');
requireMatch('src/models/User.js',/mfaSecretEncrypted/,'Encrypted MFA secret storage is missing.');
requireMatch('src/models/User.js',/mfaRecoveryCodeHashes/,'One-way MFA recovery code storage is missing.');
requireMatch('src/services/mfa.js',/createHmac\('sha1'/,'TOTP HMAC implementation is missing.');
requireMatch('src/services/mfa.js',/mfaLastCounter':\{\$lt:counter\}/,'Atomic TOTP replay protection is missing.');
requireMatch('src/services/mfa.js',/\$pull:\{'security\.mfaRecoveryCodeHashes'/,'Single-use recovery code consumption is missing.');
requireMatch('src/routes/identity.js',/mfaChallenge/,'Password login does not stop at a partial MFA challenge.');
requireMatch('src/middleware/auth.js',/MFA_ENROLLMENT_REQUIRED/,'Privileged MFA enrollment enforcement is missing.');
for(const pattern of [/createHmac\('sha256'/,/recon\.secret_probe/,/attack\.path_traversal/,/attack\.xss_probe/,/attack\.sql_injection_probe/,/attack\.jndi_probe/,/ips\.ip_blocked/,/processSiemQueue/,/Integrity verification failed/,/BLOCK_CACHE_LIMIT/])requireMatch('src/services/security.js',pattern,'Stage 12 IDS/IPS/SIEM invariant is missing.');
requireMatch('src/routes/admin.js',/\/admin\/security/,'Security & Launch admin workspace is missing.');
requireMatch('src/routes/admin.js',/different administrator must approve risk acceptance/,'Security finding risk acceptance is not four-eyes controlled.');
requireMatch('src/routes/admin.js',/different administrator who is not the target/,'Administrative MFA recovery is not four-eyes controlled.');
requireMatch('src/services/launch.js',/penetration-test/,'Independent penetration-test evidence is missing from launch readiness.');
requireMatch('src/services/launch.js',/backup-restore/,'Backup restoration evidence is missing from launch readiness.');
requireMatch('src/config/env.js',/PRIVILEGED_MFA_REQUIRED=true/,'Production privileged MFA fail-closed configuration is missing.');
requireMatch('src/config/env.js',/SIEM_MODE=http or SIEM_MODE=udp/,'Production SIEM fail-closed configuration is missing.');
requireMatch('src/config/env.js',/explicit private\/loopback IP collector/,'UDP SIEM collector boundary is missing.');
requireMatch('scripts/security-check.js',/Stage 12 security static gate passed/,'Stage 12 static security scanner is missing.');
requireMatch('scripts/launch-check.js',/launchReadiness/,'Stage 12 launch evidence gate is missing.');
requireMatch('scripts/backup-drill.js',/restore-test/,'Stage 12 guarded backup restoration drill is missing.');
requireMatch('scripts/load-smoke.js',/LOAD_TEST_MAX_P95_MS/,'Stage 12 performance smoke threshold is missing.');
requireMatch('scripts/audit-integration.js',/Stage 1–12 MongoDB integration audit passed/,'Stage 12 real MongoDB integration gate is missing.');
requireMatch('test/stage12-security.test.js',/Stage 12 security contract/,'Stage 12 dependency-free security regression suite is missing.');

process.stdout.write('Project structure, syntax, EJS, visual contract and Stage 1–12 completeness checks passed.\\n');
