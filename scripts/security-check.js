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
for(const file of files){
  const text=fs.readFileSync(file,'utf8');
  if(privateKey.test(text))failures.push(`${file}: committed private key material`);
  if(highRiskKey.test(text))failures.push(`${file}: common production credential pattern`);
  if(!isSecurityChecker(file)&&/\beval\s*\(/.test(text))failures.push(`${file}: eval() is forbidden`);
  if(!isSecurityChecker(file)&&/new\s+Function\s*\(/.test(text))failures.push(`${file}: new Function() is forbidden`);
  if(file.startsWith('views'+path.sep)){
    const raw=[...text.matchAll(/<%-(.*?)%>/gs)].map(match=>match[1].trim());
    const allowed=new Set(["include(\"partials/product-preview-modal\")","include(\"partials/social-links\")","include(\"partials/storefront-header\")","include(\"partials/storefront-footer\")","include(\"social-links\")"]);
    if(file.startsWith('views'+path.sep)) {
      for (const expression of raw) {
        if (/^include\('partials\/approved-account-(security|messages|privacy|returns|rewards|apps|invitation)'\)$/.test(expression) && file === path.join('views','approved-dashboard.ejs')) allowed.add(expression);
        if (expression === "include('partials/seller-store-live')" && file === path.join('views','approved-dashboard.ejs')) allowed.add(expression);
        if (/^include\(['"]partials\/customer-live-pages['"]\s*,\s*\{ pageId: initialPage, pageData, walletIdempotencyKey \}\)$/.test(expression) && file === path.join('views','approved-dashboard.ejs')) allowed.add(expression);
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
