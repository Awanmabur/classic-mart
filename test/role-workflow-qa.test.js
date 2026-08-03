import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=file=>fs.readFileSync(new URL(`../${file}`,import.meta.url),'utf8');

test('seller campaign creation is scoped to published products owned by the verified store',()=>{
  const service=read('src/services/promoters.js');
  assert.match(service,/Product\.find\(\{ publicId: mongoose\.trusted\(\{ \$in: productIds \}\), storeId: store\._id, status: 'published', countries: store\.country \}\)/);
  assert.match(service,/CAMPAIGN_PRODUCT_SCOPE/);
  assert.match(service,/productPublicIds: productIds/);
});

test('seller campaign UI uses database-backed product choices instead of raw IDs',()=>{
  const routes=read('src/routes/promoters.js');
  const view=read('views/seller-campaigns.ejs');
  assert.match(routes,/Product\.find\(\{storeId:store\._id,status:'published',countries:store\.country\}\)/);
  assert.match(view,/name="productPublicIds" value="<%=product\.publicId%>"/);
  assert.doesNotMatch(view,/Product public IDs, comma separated/);
});

test('business buyer workspace supplies sellable product and seller choices',()=>{
  const service=read('src/services/business.js');
  const view=read('views/business-workspace.ejs');
  assert.match(service,/ProductVariant\.find\(\{productId:mongoose\.trusted\(\{\$in:catalogProducts\.map/);
  assert.match(service,/currency:organization\.currency/);
  assert.match(service,/sellerStores:eligibleStores/);
  assert.match(view,/Select a published product/);
  assert.match(view,/Select verified seller/);
  assert.doesNotMatch(view,/Seller store public ID/);
});
