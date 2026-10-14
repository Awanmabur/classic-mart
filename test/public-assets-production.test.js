import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { assetUrl, isVersionedAsset, versionHtmlAssets } from '../src/core/public-assets.js';

test('marketing, dashboard and brand assets receive content fingerprints', () => {
  for (const pathname of ['/styles.css', '/script.js', '/approved-dashboard/live-controls.css', '/favicon.png', '/assets/classic-mart-logo.png']) {
    const actual = new URL(assetUrl(pathname), 'https://assets.invalid');
    const expected = createHash('sha256').update(fs.readFileSync('public' + pathname)).digest('hex').slice(0, 16);
    assert.equal(actual.pathname, pathname);
    assert.equal(actual.searchParams.get('v'), expected);
    assert.equal(isVersionedAsset(pathname, expected), true);
    assert.equal(isVersionedAsset(pathname, 'wrong'), false);
  }
});

test('HTML versioning changes static tags without touching canonical, private media or existing queries', () => {
  const input = '<link rel="canonical" href="/products"><link href="/styles.css"><script src="/script.js"></script><img src="/favicon.png"><img src="/media/private/key"><script src="/script.js?v=existing"></script>';
  const output = versionHtmlAssets(input);
  assert.ok(output.includes('href="' + assetUrl('/styles.css') + '"'));
  assert.ok(output.includes('src="' + assetUrl('/script.js') + '"'));
  assert.ok(output.includes('src="' + assetUrl('/favicon.png') + '"'));
  assert.ok(output.includes('href="/products"'));
  assert.ok(output.includes('src="/media/private/key"'));
  assert.ok(output.includes('src="/script.js?v=existing"'));
  assert.equal(versionHtmlAssets(output), output);
});
