import { isSecurityChecker } from './security-check-path.js';
import fs from 'node:fs';
import path from 'node:path';

const roots=['src','public','views','scripts'];
const files=[];
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else if(/\.(?:js|ejs|json|yml|yaml|md)$/.test(entry.name))files.push(full);}}
for(const root of roots)if(fs.existsSync(root))walk(root);
const failures=[];
const privateKey=/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/;
const highRiskKey=/(?:AKIA[0-9A-Z]{16}|sk_live_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,})/;
// Reviewed, static partial calls. Both the caller and the complete expression
// are fixed: a new argument, dynamic path or raw data expression still fails.
const recoveredIncludes = new Map([
  ['views/approved-dashboard.ejs', [
    "include('partials/super-admin-main')",
    "include('partials/business-main')",
    "include('partials/delivery-live')",
    "include('partials/delivery-operations-live')",
    "include('partials/store-invitations-live')",
    "include('partials/customer-live-pages', { pageId: 'profile', pageData, walletIdempotencyKey: '' })",
  ]],
  ['views/partials/approved-account-returns.ejs', [
    "include('customer-return-details',{returnRequest:row,proposalReturnTo:'/account/returns'})",
  ]],
  ['views/partials/business-main.ejs', [
    "include('business-procurement-forms',{flow,money,link,statusTone})",
    "include('business-quote-forms',{flow,money,link,statusTone})",
    "include('business-invoice-forms',{flow,money,link,statusTone})",
    "include('business-settings-forms',{flow,money,link,statusTone})",
  ]],
  ['views/partials/customer-case-history.ejs', [
    "include('customer-history-navigation',{historyPage:pageData.pagination?.refunds,historyLabel:'refunds'})",
    "include('customer-history-navigation',{historyPage:pageData.pagination?.disputes,historyLabel:'disputes'})",
    "include('customer-history-navigation',{historyPage:pageData.pagination?.cases,historyLabel:'reports'})",
  ]],
  ['views/partials/customer-live-pages.ejs', [
    "include('customer-reward-catalogue',{pageData,walletIdempotencyKey})",
    "include('customer-history-navigation',{historyPage:wallet.pagination,historyLabel:'transactions'})",
    "include('customer-history-navigation',{historyPage:wallet.topUpsPagination,historyLabel:'top-ups'})",
    "include('customer-return-details',{returnRequest:item,proposalReturnTo:'/returns'})",
    "include('customer-history-navigation',{historyPage:pageData.pagination,historyLabel:pageId==='orders'?'orders':pageId==='wishlist'?'saved products':pageId==='rewards'?'points entries':'notifications'})",
    "include('customer-history-navigation',{historyPage:pageData.pagination?.tickets,historyLabel:'tickets'})",
    "include('customer-history-navigation',{historyPage:pageData.pagination?.orders,historyLabel:'orders to select'})",
    "include('customer-history-navigation',{historyPage:pageData.pagination?.returns,historyLabel:'return requests'})",
    "include('customer-history-navigation',{historyPage:pageData.pagination?.eligible,historyLabel:'delivered orders'})",
    "include('customer-case-history',{pageData})",
  ]],
  ['views/partials/customer-return-details.ejs', [
    "include('customer-refund-proposal', { returnRequest, proposalReturnTo: typeof proposalReturnTo !== 'undefined' ? proposalReturnTo : '/account/returns' })",
  ]],
  ['views/partials/country-admin-main.ejs', ["include('specialist-order-case-forms')"]],
  ['views/partials/finance-standard-live.ejs', ["include('specialist-order-case-forms')"]],
  ['views/partials/moderation-standard-live.ejs', ["include('specialist-order-case-forms')"]],
  ['views/partials/seller-affiliate-forms.ejs', [
    "include('seller-affiliate-editor-fields', { draft: {} })",
    "include('seller-affiliate-editor-fields', { draft: campaign })",
  ]],
  ['views/partials/seller-growth-forms.ejs', ["include('seller-subscription-billing')"]],
  ['views/partials/seller-standard-live.ejs', [
    "include('specialist-order-case-forms')",
    "include('seller-team-forms')",
    "include('seller-affiliate-forms')",
    "include('seller-policy-case-forms')",
    "include('seller-business-forms')",
  ]],
  ['views/partials/super-admin-main.ejs', ["include('super-admin-forms')"]],
  ['views/partials/warehouse-live.ejs', ["include('warehouse-measured-report', { measured: flow.measured })"]],
].map(([file, expressions]) => [path.normalize(file), new Set(expressions)]));
for(const file of files){
  const text=fs.readFileSync(file,'utf8');
  if(privateKey.test(text))failures.push(`${file}: committed private key material`);
  if(highRiskKey.test(text))failures.push(`${file}: common production credential pattern`);
  if(!isSecurityChecker(file)&&/\beval\s*\(/.test(text))failures.push(`${file}: eval() is forbidden`);
  if(!isSecurityChecker(file)&&/new\s+Function\s*\(/.test(text))failures.push(`${file}: new Function() is forbidden`);
  if(file.startsWith('views'+path.sep)){
    const raw=[...text.matchAll(/<%-(.*?)%>/gs)].map(match=>match[1].trim());
    const allowed=new Set(["include(\"partials/product-preview-modal\")","include(\"partials/social-links\")","include(\"partials/storefront-header\")","include(\"partials/storefront-footer\")","include(\"social-links\")", "include('partials/brand-icons')", 'include("partials/seo-meta")']);
    for (const expression of recoveredIncludes.get(file) || []) allowed.add(expression);
    if(file.startsWith('views'+path.sep)) {
      for (const expression of raw) {
        if (file === path.join('views', 'partials', 'seo-meta.ejs') && expression === 'pageMetadata.jsonLd') allowed.add(expression);
        if (file === path.join('views', 'products.ejs') && expression === "include('partials/catalogue-cards')") allowed.add(expression);
        if (['sellers.ejs','promoters.ejs'].some(name => file === path.join('views',name)) && /^include\("partials\/people-cards", \{directoryKind: "(?:sellers|promoters)"\}\)$/.test(expression)) allowed.add(expression);
        if (['seller-profile.ejs','promoter-profile.ejs'].some(name => file === path.join('views',name)) && expression === 'include("partials/profile-products")') allowed.add(expression);
        if (file === path.join('views','index.ejs') && expression === "include('partials/product-details-readable')") allowed.add(expression);
        if (/^include\('partials\/approved-account-(security|messages|privacy|returns|rewards|apps|invitation)'\)$/.test(expression) && file === path.join('views','approved-dashboard.ejs')) allowed.add(expression);
        if (expression === "include('partials/seller-store-live')" && file === path.join('views','approved-dashboard.ejs')) allowed.add(expression);
        if (expression === "include('partials/seller-overview-live')" && file === path.join('views','approved-dashboard.ejs')) allowed.add(expression);
        if (expression === "include('partials/seller-standard-live')" && file === path.join('views','approved-dashboard.ejs')) allowed.add(expression);
        if (["include('partials/promoter-overview-live')", "include('partials/promoter-profile-live')", "include('partials/promoter-standard-live')"].includes(expression) && file === path.join('views','approved-dashboard.ejs')) allowed.add(expression);
        if (["include('partials/finance-overview-live')", "include('partials/finance-settings-live')", "include('partials/finance-standard-live')"].includes(expression) && file === path.join('views','approved-dashboard.ejs')) allowed.add(expression);
        if (["include('partials/country-admin-header')", "include('partials/country-admin-main')", "include('partials/country-admin-sidebar')"].includes(expression) && file === path.join('views','approved-dashboard.ejs')) allowed.add(expression);
        if (["include('country-admin-catalogue-forms')", "include('country-admin-commerce-forms')", "include('country-admin-growth-forms')", "include('country-admin-report-forms')", "include('country-admin-support-forms')"].includes(expression) && file === path.join('views','partials','country-admin-main.ejs')) allowed.add(expression);
        if (["include('partials/moderation-overview-live')", "include('partials/moderation-settings-live')", "include('partials/moderation-standard-live')"].includes(expression) && file === path.join('views','approved-dashboard.ejs')) allowed.add(expression);
        if (["include('moderation-catalogue-forms')", "include('moderation-trust-forms')", "include('moderation-report-forms')"].includes(expression) && file === path.join('views','partials','moderation-standard-live.ejs')) allowed.add(expression);
        if (["include('partials/support-overview-live')", "include('partials/support-settings-live')", "include('partials/support-standard-live')"].includes(expression) && file === path.join('views','approved-dashboard.ejs')) allowed.add(expression);
        if (["include('support-ticket-forms')", "include('support-case-forms')", "include('support-context-forms')", "include('support-report-forms')"].includes(expression) && file === path.join('views','partials','support-standard-live.ejs')) allowed.add(expression);
        if (["include('finance-payment-forms')", "include('finance-payout-forms')", "include('finance-reconciliation-forms')", "include('finance-report-forms')"].includes(expression) && file === path.join('views','partials','finance-standard-live.ejs')) allowed.add(expression);
        if (["include('promoter-campaign-forms')", "include('promoter-finance-forms')", "include('promoter-relationship-forms')"].includes(expression) && file === path.join('views','partials','promoter-standard-live.ejs')) allowed.add(expression);
        if (expression === "include('seller-promoter-conversation')" && file === path.join('views','partials','seller-standard-live.ejs')) allowed.add(expression);
        if (["include('seller-inventory-forms')", "include('seller-relationship-forms')", "include('seller-finance-forms')", "include('seller-growth-forms')"].includes(expression) && file === path.join('views','partials','seller-standard-live.ejs')) allowed.add(expression);
        if (["include('partials/seller-verification-live')", "include('partials/seller-verification-notice')", "include('partials/verification-review-live')"].includes(expression) && file === path.join('views','approved-dashboard.ejs')) allowed.add(expression);
        if (["include('partials/seller-products-live')", "include('partials/product-review-live')"].includes(expression) && file === path.join('views','approved-dashboard.ejs')) allowed.add(expression);
        if (expression === "include('partials/seller-orders-live')" && file === path.join('views','approved-dashboard.ejs')) allowed.add(expression);
        if (expression === "include('partials/warehouse-live')" && file === path.join('views','approved-dashboard.ejs')) allowed.add(expression);
        if (/^include\(['"]partials\/customer-live-pages['"]\s*,\s*\{ pageId: initialPage, pageData, walletIdempotencyKey \}\)$/.test(expression) && file === path.join('views','approved-dashboard.ejs')) allowed.add(expression);
        if (["include('partials/customer-live-pages', { pageId: accountPage, pageData, walletIdempotencyKey })", "include('partials/customer-live-pages', { pageId: 'notifications', pageData, walletIdempotencyKey: '' })"].includes(expression) && file === path.join('views','approved-dashboard.ejs')) allowed.add(expression);
        if (/^include\('approved-dashboard', \{ workspace: '(customer|seller|promoter|business|warehouse|support|moderator|finance|admin|superadmin)', initialPage: '[a-z-]+', allowedWorkspaces: \['[a-z]+'\] \}\)$/.test(expression)) allowed.add(expression);
      }
    }
    if(file===path.join('views','index.ejs')){
      allowed.add("productMeta.jsonLd");
      allowed.add("typeof initialStorefrontJson !== 'undefined' ? initialStorefrontJson : '{}'");
    }
    for(const expression of raw)if(!allowed.has(expression))failures.push(`${file}: unapproved raw EJS output (${expression.slice(0,80)})`);
  }
}
if(failures.length){console.error('Stage 12 security static gate failed:\n- '+failures.join('\n- '));process.exit(1);}
console.log(`Stage 12 security static gate passed (${files.length} files scanned).`);
