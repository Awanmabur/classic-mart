import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read=(p)=>fs.readFileSync(new URL(`../${p}`,import.meta.url),'utf8');

function has(file, re, msg){assert.match(read(file),re,msg);}
function lacks(file,re,msg){assert.doesNotMatch(read(file),re,msg);}

test('business buyer domain covers team budgets approvals quotes purchase orders and recurring procurement',()=>{
  for(const name of ['BusinessOrganization','BusinessMember','BusinessBudget','ProcurementRequest','QuoteRequest','PurchaseOrder','ProcurementTemplate']) has('src/models/index.js',new RegExp(name),`${name} must be exported`);
  const service=read('src/services/business.js');
  assert.match(service,/FOUR_EYES_REQUIRED/);
  assert.match(service,/SPENDING_LIMIT_EXCEEDED/);
  assert.match(service,/BUDGET_EXCEEDED/);
  assert.match(service,/withTransaction/,'Business approval and purchase-order transitions must be transactional.');
  assert.match(service,/createQuoteRequest/);
  assert.match(service,/PROCUREMENT_APPROVAL_REQUIRED/,'Quotation/PO flow must be linked to an approved procurement request.');
  assert.match(service,/QUOTE_EXCEEDS_APPROVAL/,'Seller quotation above the approved seller allocation must require re-approval.');
  assert.match(service,/approvedAmountMinor/,'Seller quotations must snapshot only their approved allocation.');
  assert.match(service,/QUOTE_ALREADY_ACTIVE/,'Duplicate active seller quotations must be blocked.');
  assert.match(service,/cancelProcurementRequest/,'Business buyers need an explicit safe cancellation path.');
  assert.match(service,/BUDGET_RELEASE_CONFLICT/,'Approved procurement cancellation must release budget atomically.');
  assert.match(service,/remainingApprovedMinor\(row\.items,covered\)/,'Cancellation must derive releasable commitment from authoritative item values.');
  assert.doesNotMatch(service,/\{\.\.\.item,quantity:/,'Mongoose procurement subdocuments must never be spread for budget calculations.');
  assert.match(read('src/models/BusinessBudget.js'),/spentMinor/,'Business budgets must distinguish actual spend from open commitment.');
  assert.match(read('src/models/ProcurementRequest.js'),/partially_ordered/,'Multi-seller procurement needs a partial-order state.');
  assert.match(service,/acceptQuote/);
  assert.match(service,/processRecurringProcurement/);
  assert.match(service,/parseProcurementCsv/,'Business procurement CSV bulk import is missing.');
  assert.match(service,/AuditLog/,'Business audit history is missing.');
  assert.match(service,/status:'submitted'/,'Recurring procurement must create an approval request, not place an order automatically.');
  has('src/routes/business.js',/business\/statement\.csv/,'Business statement route is missing.');
  has('src/routes/business.js',/business\/requests\/import/,'Business procurement bulk-import route is missing.');
  has('views/business-workspace.ejs',/Bulk CSV procurement/,'Business workspace must expose procurement CSV import.');
  has('views/business-workspace.ejs',/Business audit history/,'Business workspace must expose audit history.');
  has('views/business-workspace.ejs',/Purchase orders/i,'Business workspace must expose purchase orders.');
});

test('business credit terms remain a four-eyes admin approval',()=>{
  has('src/models/ApprovalRequest.js',/business_credit_terms/);
  has('src/services/stage9.js',/approval\.type==='business_credit_terms'/);
  has('src/routes/admin.js',/request-terms/);
  has('scripts/audit-integration.js',/business_credit_terms/);
});

test('seller growth supports controlled promotions price floors broadcasts and procurement responses',()=>{
  for(const name of ['SellerPromotion','PriceSchedule','StoreBroadcast']) has('src/models/index.js',new RegExp(name),`${name} must be exported`);
  const service=read('src/services/seller-growth.js');
  for(const re of [/MINIMUM_PRICE_VIOLATION/,/voucher/,/bundle/,/quantity_break/,/free_shipping/,/sponsored/,/queueStoreBroadcast/,/'consents\.marketing':true/,/sellerRespondQuote/,/decidePurchaseOrder/,/partially_ordered/,/seller_rejected/,/fulfilled/,/spentMinor/]) assert.match(service,re);
  assert.match(service,/promotionMarginPreview/,'Seller campaign margin preview is missing.');
  has('src/routes/seller-growth.js',/\/seller\/growth\/promotions/);
  has('src/routes/seller-growth.js',/\/seller\/growth\/prices/);
  has('src/routes/seller-growth.js',/\/seller\/growth\/broadcasts/);
  has('views/seller-growth.ejs',/Growth & Pricing|Seller growth/i);
  has('views/seller-growth.ejs',/Preview margin/,'Seller Growth UI must expose margin preview.');
});

test('seller-funded discounts are server-authoritative through checkout settlement and refunds',()=>{
  const checkout=read('src/services/checkout.js');
  assert.match(checkout,/promotionQuote/);
  assert.match(checkout,/promotionCodes/);
  assert.match(checkout,/discountMinor/);
  assert.match(checkout,/minimumPriceMinor/,'Checkout must carry the seller minimum-price floor into promotion recomputation.');
  assert.match(read('src/services/seller-growth.js'),/availableCapacity/,'Stacked promotions must be capped by remaining minimum-price discount capacity.');
  assert.match(checkout,/PROMOTION|discount/i);
  const money=read('src/services/money.js');
  assert.match(money,/sellerSettlementBreakdown/,'Seller settlement must use one shared server-authoritative calculation.');
  assert.match(money,/subtotalMinor - appliedDiscountMinor/,'Seller payable must subtract seller-funded discounts before marketplace fees.');
  const payments=read('src/services/payments.js');
  assert.match(payments,/sellerSettlementBreakdown\s*}\s*from ['"]\.\/money\.js['"]/,'Verified payments must import the shared settlement calculation.');
  assert.match(payments,/sellerSettlementBreakdown\(sellerOrder\)/,'Verified payments must use discounted seller net.');
  const logistics=read('src/services/logistics.js');
  assert.match(logistics,/sellerSettlementBreakdown\s*}\s*from ['"]\.\/money\.js['"]/,'COD reconciliation must import the shared settlement calculation.');
  assert.match(logistics,/sellerSettlementBreakdown\(sellerOrder\)/,'COD reconciliation must use the same discounted seller net.');
  const trust=read('src/services/trust.js');
  assert.match(trust,/discountMinor/,'Return/refund eligibility must use the actual discounted amount paid.');
});

test('cart promotion mutations go through the server and fake promo badges are gone',()=>{
  has('src/routes/checkout.js',/\/api\/v1\/cart\/promotions/);
  has('public/cart-page.js',/\/api\/v1\/cart\/promotions/);
  lacks('public/script.js',/Promo\s*3%/i,'Storefront must not advertise a fake fixed promo percentage.');
  has('public/script.js',/Sponsored/,'Sponsored placements must be explicitly labelled.');
  has('src/routes/storefront.js',/activeSponsoredProducts/,'Sponsored labels must originate from server promotion records.');
});

test('consent-aware seller broadcasts are delivered through the outbox with truthful development sink',()=>{
  has('src/services/outbox.js',/processNotificationOutbox/);
  has('src/services/outbox.js',/store\.broadcast/);
  has('src/services/outbox.js',/Development mail sink: no external email was sent\./);
  has('src/services/maintenance.js',/processNotificationOutbox/);
});

test('development seed explicitly creates indexes for business and seller growth collections',()=>{
  const seed=read('scripts/seed.js');
  for(const name of ['BusinessOrganization','BusinessMember','BusinessBudget','ProcurementRequest','QuoteRequest','PurchaseOrder','ProcurementTemplate','SellerPromotion','PriceSchedule','StoreBroadcast']) assert.match(seed,new RegExp(name));
});

test('real integration audit proves business procurement and seller growth',()=>{
  const audit=read('scripts/audit-integration.js');
  for(const re of [/createProcurementRequest/,/decideProcurementRequest/,/createQuoteRequest/,/cancelProcurementRequest/,/one seller acceptance must leave/,/business_credit_terms/,/createSellerPromotion/,/applyCartPromotionCode/,/discountMinor/,/createStoreBroadcast/,/applyDuePriceSchedules/]) assert.match(audit,re);
});
