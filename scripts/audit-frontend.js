import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const failures = [];
const requireText = (rel, pattern, message) => {
  if (!pattern.test(read(rel))) failures.push(`${rel}: ${message}`);
};
const forbidText = (rel, pattern, message) => {
  if (pattern.test(read(rel))) failures.push(`${rel}: ${message}`);
};

for (const [rel, pattern, message] of [
  ['views/index.ejs', /Sarah J\.|Michael T\.|Emma L\./, 'fake customer testimonial identities remain'],
  ['views/index.ejs', /(?:UP TO|SAVE|Minimum)\s*<strong>?\s*\d+%|Save up to\s*<strong>\d+%/i, 'unverified discount claims remain'],
  ['views/index.ejs', /data-open="blogModal"|data-article=/, 'hard-coded browser blog workflow remains'],
  ['public/script.js', /\b(?:blogArticles|articleContent|openBlogHome|openBlogArticle)\b/, 'hard-coded browser article data remains'],
  ['public/script.js', /product\.price\s*<=\s*50/, 'USD-specific budget filtering remains'],
  ['views/cart.ejs', /data-product-id="(?:13|14|16|19)"/, 'static cart recommendation products remain'],
  ['public/cart-page.js', /Number\(product\.id\)/, 'MongoDB/public string product IDs are coerced to numbers'],
  ['views/promoters.ejs', /onboarding not released|0 verified promoters/i, 'promoter directory placeholder copy remains'],
  ['public/profile-page.js', /location\.href\s*=\s*['"]\/promoters['"]/, 'promoter profiles still redirect away'],
  ['views/money-workspace.ejs', /<input[^>]+name="orderId"[^>]+placeholder=/i, 'finance refunds still require a manually typed order ID'],
  ['views/seller-growth.ejs', /Product public IDs|comma\/space separated/i, 'seller promotions still require raw product IDs'],
  ['views/seller-campaigns.ejs', /Product public IDs, comma separated/i, 'seller campaigns still require raw product IDs'],
  ['views/business-workspace.ejs', /Product public ID|Seller store public ID/i, 'business buyers still require raw marketplace IDs'],
]) forbidText(rel, pattern, message);

for (const [rel, pattern, message] of [
  ['src/routes/public.js', /publishedCmsList\(\{ prefix: 'home\.hero\.'/,'homepage heroes are not sourced from published CMS records'],
  ['src/routes/public.js', /publishedTestimonials\(request\.country\?\.code/,'homepage testimonials are not sourced from published verified-purchase reviews'],
  ['src/routes/public.js', /router\.get\('\/press'.*publishedCmsList/s,'press page is not sourced from published CMS records'],
  ['views/index.ejs', /homeHeroSlides/,'homepage does not render database CMS hero records'],
  ['views/index.ejs', /homeTestimonials/,'homepage does not render database review records'],
  ['views/index.ejs', /pressArticles/,'homepage does not render CMS article records'],
  ['src/routes/storefront.js', /\/api\/v1\/storefront\/promoters/,'public promoter directory API is missing'],
  ['src/routes/storefront.js', /promoters\/:id\/contact/,'public promoter contact API is missing'],
  ['src/models/CustomerCatalogueState.js', /followedPromoterUserIds/,'promoter follows are not persisted'],
  ['src/models/PromoterContactRequest.js', /promoterUserId.*customerUserId/s,'promoter contact threads are not persisted'],
  ['views/promoter-workspace.ejs', /Customer messages/,'promoter inbox is not rendered'],
  ['src/routes/promoters.js', /promoter\/messages\/:id\/reply/,'promoter reply action is missing'],
  ['src/routes/account.js', /account\/promoter-messages\/:id\/reply/,'customer promoter reply action is missing'],
  ['public/shared-shell.js', /\/api\/v1\/storefront\/catalogue/,'shared category/search controls are not hydrated from the database catalogue'],
  ['views/cart.ejs', /id="cartRecommendedGrid"[^>]*><\/div>/,'cart recommendations are not an empty database-hydrated target'],
  ['public/cart-page.js', /String\(product\.id/,'cart recommendations do not preserve public string IDs'],
  ['views/money-workspace.ejs', /eligibleRefundOrders/,'finance refund form is not backed by eligible database orders'],
  ['views/seller-growth.ejs', /view\.products/,'seller promotion product picker is not database-backed'],
  ['src/services/seller-growth.js', /Product\.find\(\{storeId:request\.store\._id,status:/,'seller growth workspace does not query eligible store products'],
  ['scripts/seed.js', /prv_demo_promoter_ug/,'development seed does not provide a complete promoter discovery path'],
]) requireText(rel, pattern, message);

const ejsFiles = fs.readdirSync(path.join(root, 'views')).filter((name) => name.endsWith('.ejs'));
for (const name of ejsFiles) {
  const source = read(`views/${name}`);
  if (/<option value="electronics">Electronics<\/option>\s*<option value="fashion">/i.test(source)) {
    failures.push(`views/${name}: hard-coded shared search categories remain`);
  }
  if (/<span class="tiny-badge">\d+<\/span>/.test(source)) {
    failures.push(`views/${name}: hard-coded category count badge remains`);
  }
}

if (failures.length) {
  console.error('Frontend data/functionality audit failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Frontend data/functionality audit passed (${ejsFiles.length} EJS views checked).`);
