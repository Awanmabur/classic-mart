import fs from 'node:fs';
import path from 'node:path';
import { approvedDashboardLayerFailures } from './check-approved-dashboard-layer.js';

const root=process.cwd();
const failures=[...approvedDashboardLayerFailures(root)];
const exists=rel=>fs.existsSync(path.join(root,rel));
const read=rel=>fs.readFileSync(path.join(root,rel),'utf8');
const requireFile=rel=>{if(!exists(rel))failures.push(`Missing release file: ${rel}`);};
const requireMatch=(rel,pattern,message)=>{if(!(pattern instanceof RegExp))throw new TypeError(`Pattern for ${rel} must be RegExp`);if(!exists(rel)||!pattern.test(read(rel)))failures.push(message);};
const forbidMatch=(rel,pattern,message)=>{if(exists(rel)&&pattern.test(read(rel)))failures.push(message);};

const pkg=JSON.parse(read('package.json')); const version=pkg.version;
for(const rel of ['.gitignore','scripts/migrate-production.js','scripts/build-release.js','scripts/build-clean-app-release.js','scripts/build-production-release.js','scripts/security-check.js','scripts/audit-frontend.js','scripts/audit-functionality.js','scripts/check-imports.js','scripts/check-project.js','scripts/check-customer-dashboard-layer.js','test/customer-dashboard-final19-v2.13.71.test.js','test/customer-dashboard-backend-v2.13.71.test.js','test/customer-wallet-checkout-v2.13.71.test.js']) requireFile(rel);
for(const script of ['release:build','release:clean-app','release:production','check:imports','security:check','frontend:audit','functionality:audit']) if(!pkg.scripts?.[script]) failures.push(`package.json missing release gate ${script}`);

requireMatch('scripts/migrate-production.js',/ordersNeedingLineBackfill:await Order\.countDocuments\(\{items:\{\$elemMatch:/,'Migration must detect partially backfilled order item arrays.');
requireMatch('scripts/migrate-production.js',/if\(indexResult\.failures\.length\)/,'Migration must fail certification when production index creation fails.');
requireMatch('src/app.js',/import dashboardRoutes from ['"]\.\/routes\/dashboard\.js['"]/,'src/app.js must import the Customer dashboard router.');
requireMatch('src/app.js',/app\.use\(dashboardRoutes\)/,'src/app.js must mount the Customer dashboard router.');
requireMatch('src/routes/dashboard.js',/accountOnly/,'Customer dashboard actions require account permission.');
requireMatch('src/routes/dashboard.js',/const gates=\[noStore,requireAuth,requireVerified,requireOnboarding,accountOnly\]/,'Customer action auth boundary is missing.');
requireMatch('src/routes/dashboard.js',/router\.(?:get|post)\(paths\([^)]*\),\.\.\.gates/, 'Customer actions must apply the auth boundary.');
requireMatch('src/dashboard/customer-data.js',/LOADERS\[pageId\]/,'Customer dashboard data loading must remain page-scoped.');
requireMatch('src/services/customer-wallet.js',/wallet-topup:/,'Classic Wallet verified top-up ledger path is missing.');
requireMatch('src/services/payments.js',/WALLET_BALANCE_INSUFFICIENT/,'Classic Wallet checkout balance guard is missing.');
requireMatch('src/services/payments.js',/provider==='wallet'/,'Classic Wallet refund path is missing.');
requireMatch('views/partials/customer-live-pages.ejs',/data-page="notifications"/,'Approved Notifications page is missing.');
requireMatch('views/partials/customer-live-pages.ejs',/data-page="club"/,'Approved Classic Club page is missing.');

requireMatch('src/routes/account.js',/\/account\/orders/,'Customer order history must remain available outside dashboards.');
requireMatch('src/routes/checkout.js',/\/orders\/:orderId\/receipt/,'Customer receipt route is missing.');
requireMatch('src/routes/payments.js',/\/webhooks\/pesapal/,'Pesapal webhook route is missing.');
requireMatch('src/routes/payments.js',/\/payments\/return/,'Pesapal return route is missing.');
requireMatch('src/routes/promoters.js',/\/r\/:token/,'Promoter attribution route is missing.');
requireMatch('src/routes/trust.js',/\/account\/returns/,'Customer returns/support route is missing.');
requireMatch('src/routes/ai.js',/\/ask-classic/,'Ask Classic route is missing.');
requireMatch('src/models/Order.js',/paymentState[\s\S]*fulfillmentState[\s\S]*cancellationState[\s\S]*returnState[\s\S]*refundState/,'Order lifecycle dimensions are missing.');
requireMatch('src/services/payments.js',/verifyAndApplyPayment/,'Authoritative provider payment verification is missing.');
requireMatch('src/services/pesapal.js',/GetTransactionStatus/,'Pesapal status verification endpoint is missing.');
requireMatch('src/services/audit.js',/AuditLog/,'Audit service is missing.');
requireFile('src/worker.js');

const lock=JSON.parse(read('package-lock.json'));if(lock.version!==version||lock.packages?.['']?.version!==version)failures.push('package-lock root version does not match package.json.');
const verification=`docs/FULL_VERIFICATION_v${version}.md`,notes=`RELEASE_NOTES_v${version}.md`,sbom=`docs/SBOM_v${version}.cdx.json`;
if(exists(verification)||exists(notes)||exists(sbom)){requireFile(verification);requireFile(notes);requireFile(sbom);}
if(exists(sbom)){try{const data=JSON.parse(read(sbom));const componentVersion=data.metadata?.component?.version||'';if(componentVersion&&componentVersion!==version)failures.push(`SBOM version ${componentVersion} does not match ${version}.`);}catch(error){failures.push(`Invalid SBOM JSON: ${error.message}`);}}
if(failures.length){console.error('Release-script preflight failed:\n- '+failures.join('\n- '));process.exit(1);}console.log(`Release-script preflight passed for Classic Mart v${version} approved role dashboard UI checkpoint.`);
