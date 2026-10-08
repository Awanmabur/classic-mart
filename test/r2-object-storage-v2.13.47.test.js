import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read=(file)=>fs.readFileSync(new URL(`../${file}`,import.meta.url),'utf8');

const envSource=read('src/config/env.js');
const storageSource=read('src/services/object-storage.js');
const sigv4Source=read('src/core/aws-sigv4.js');
const mediaSource=read('src/services/media.js');
const mediaRoutes=read('src/routes/media.js');
const productAccess=read('src/services/seller-products.js');
const trustRoutes=read('src/routes/trust.js');
const visualSearch=read('src/services/visual-search.js');
const aiSource=read('src/services/ai.js');
const render=read('render.yaml');
const prodEnv=read('.env.production.example');

test('production requires private Cloudflare R2 media storage credentials',()=>{
  assert.match(envSource,/MEDIA_STORAGE_DRIVER/);
  assert.match(envSource,/Production requires MEDIA_STORAGE_DRIVER=r2/);
  for(const key of ['R2_ENDPOINT','R2_BUCKET','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY']){
    assert.match(envSource,new RegExp(key));
    assert.match(render,new RegExp(`key:\\s*${key}`));
    assert.match(prodEnv,new RegExp(`^${key}=`, 'm'));
  }
  assert.match(render,/key:\s*MEDIA_STORAGE_DRIVER[\s\S]{0,80}value:\s*r2/);
  assert.match(prodEnv,/^MEDIA_STORAGE_DRIVER=r2$/m);
  assert.doesNotMatch(prodEnv,/R2_PUBLIC|r2\.dev/i);
});

test('R2 adapter uses SigV4 over HTTPS and supports put get delete readiness probe',()=>{
  assert.match(sigv4Source,/AWS4-HMAC-SHA256/);
  assert.match(storageSource,/service:\s*'s3'/);
  assert.match(storageSource,/region:\s*env\.r2\.region/);
  assert.match(storageSource,/PutObject|putMediaObject/);
  assert.match(storageSource,/getMediaObject|readMediaObjectBuffer/);
  assert.match(storageSource,/deleteMediaObject/);
  assert.match(storageSource,/ensureMediaStorageReady/);
  assert.match(sigv4Source,/https:/);
  assert.doesNotMatch(storageSource,/R2_PUBLIC|r2\.dev/i);
});

test('all uploaded image classes use object storage rather than filesystem writes',()=>{
  assert.match(mediaSource,/putMediaObject/);
  assert.match(mediaSource,/deleteMediaObject/);
  assert.doesNotMatch(mediaSource,/fs\.writeFile|resolveUploadPath/);
  assert.match(mediaSource,/ProductMedia\.create/);
  assert.match(mediaSource,/VerificationDocument\.create/);
  assert.match(mediaSource,/EvidenceDocument\.create/);
});

test('catalogue and private evidence delivery stream from object storage behind authorization',()=>{
  assert.match(mediaRoutes,/sendStoredMedia/);
  assert.doesNotMatch(mediaRoutes,/sendFile\(resolveUploadPath/);
  assert.match(trustRoutes,/sendStoredMedia/);
  assert.doesNotMatch(trustRoutes,/sendFile\(resolveUploadPath/);
  assert.match(mediaRoutes,/readableSellerProductImage\(request\.user, request\.params\.publicId\)/);
  assert.match(productAccess,/media\.status === 'approved'/);
  assert.match(productAccess,/product\.status === 'published'/);
  assert.match(productAccess,/store\.status === 'verified'/);
  assert.match(productAccess,/hasPublicProductApproval\(product, category, store\)/);
  assert.match(trustRoutes,/Evidence access denied/);
});

test('image analysis reads product bytes from R2 instead of assuming a local path',()=>{
  assert.match(visualSearch,/readMediaObjectBuffer/);
  assert.doesNotMatch(visualSearch,/resolveUploadPath/);
  assert.match(aiSource,/readMediaObjectBuffer/);
  assert.doesNotMatch(aiSource,/resolveUploadPath/);
});

test('SigV4 signer matches an independently verified deterministic R2 request signature', async()=>{
  const { signAwsV4Request } = await import('../src/core/aws-sigv4.js');
  const signed=signAwsV4Request({
    method:'PUT',
    url:'https://abc123.r2.cloudflarestorage.com/classic-mart-media/products/example.webp',
    body:Buffer.from('hello'),
    accessKeyId:'AKIDEXAMPLE',
    secretAccessKey:'secretExampleKey',
    region:'auto',
    service:'s3',
    now:new Date('2026-09-10T16:30:00Z'),
  });
  assert.equal(signed['x-amz-date'],'20260910T163000Z');
  assert.equal(signed['x-amz-content-sha256'],'2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  assert.equal(signed.Authorization,'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260910/auto/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=7cb919b7fde21e5c9c33a4bf599e4c462f3b89b5573c2d34d450826cf4e49b83');
});

test('release exposes a dedicated R2 readiness command for deployment verification',()=>{
  const pkg=JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['media:r2:check'],'node scripts/check-r2.js');
  const check=read('scripts/check-r2.js');
  const builder=read('scripts/build-production-release.js');
  assert.match(check,/ensureMediaStorageReady/);
  assert.match(check,/Cloudflare R2 media storage is ready/);
  assert.match(builder,/scripts\/check-r2\.js/);
  assert.match(builder,/'media:r2:check':'node scripts\/check-r2\.js'/);
});
