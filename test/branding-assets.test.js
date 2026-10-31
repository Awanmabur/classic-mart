import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import sharp from 'sharp';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'branding-test-session-secret-at-least-32-characters';
process.env.TOKEN_PEPPER = 'branding-test-token-pepper-at-least-32-characters';
process.env.REDIS_URL = '';
const { createApp } = await import('../src/app.js');
const app = createApp(null);
const root = fileURLToPath(new URL('..', import.meta.url));
const read = (name) => fs.readFile(path.join(root, name));

function binary(response, callback) {
  const chunks = [];
  response.on('data', (chunk) => chunks.push(chunk));
  response.on('end', () => callback(null, Buffer.concat(chunks)));
  response.on('error', callback);
}

function links(html) {
  const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1];
  assert.ok(head, 'rendered page has a document head');
  return [...head.matchAll(/<link\b[^>]*>/gi)].map(([tag]) => Object.fromEntries(
    [...tag.matchAll(/([\w-]+)\s*=\s*["']([^"']*)["']/g)].map((match) => [match[1].toLowerCase(), match[2]])
  ));
}

test('public, sign-in, offline and error responses expose the same real brand icons', async () => {
  const cases = [
    ['/', 200], ['/products', 200], ['/categories', 200], ['/about', 200],
    ['/search', 200], ['/login', 200], ['/signup', 200], ['/app', 200],
    ['/offline', 200], ['/branding-page-that-does-not-exist', 404],
  ];
  for (const [url, status] of cases) {
    const response = await request(app).get(url).expect(status);
    const headLinks = links(response.text);
    assert.deepEqual(headLinks.filter((link) => link.rel === 'icon').map((link) => new URL(link.href, 'http://localhost').pathname).sort(),
      ['/favicon.ico', '/favicon.png'], url);
    assert.deepEqual(headLinks.filter((link) => link.rel === 'apple-touch-icon').map((link) => new URL(link.href, 'http://localhost').pathname),
      ['/assets/apple-touch-icon.png'], url);
    assert.deepEqual(headLinks.filter((link) => link.rel === 'manifest').map((link) => link.href),
      ['/manifest.webmanifest'], url);
  }
  const denied = await request(app).post('/login').type('form').send({ email: 'brand@example.com' }).expect(403);
  assert.equal(links(denied.text).find((link) => link.rel === 'icon' && link.type === 'image/png')?.href, '/favicon.png');
});

test('every runtime EJS document, including authenticated dashboards and documents, uses the shared brand head', async () => {
  for (const name of (await fs.readdir(path.join(root, 'views'))).filter((name) => name.endsWith('.ejs'))) {
    const source = String(await read(`views/${name}`));
    assert.match(source, /<head>[\s\S]*<%- include\('partials\/brand-icons'\) %>[\s\S]*<\/head>/i, name);
    assert.doesNotMatch(source, /<link\b[^>]*rel=["'](?:icon|apple-touch-icon)["']/i, `${name} must not override shared icons`);
  }
});

async function normaliseArtwork(image) {
  const flattened = await sharp(image).flatten({ background: '#ffffff' }).png().toBuffer();
  return sharp(flattened).trim({ background: '#ffffff', threshold: 20 })
    .resize(128, 128, { fit: 'contain', background: '#ffffff' }).removeAlpha().raw().toBuffer();
}

test('HTTP PNG assets have valid sizes and retain the cart and red bag from the actual homepage logo', async () => {
  const source = await sharp(await read('public/assets/classic-mart-logo.png'))
    .extract({ left: 0, top: 0, width: 476, height: 517 }).png().toBuffer();
  const reference = await normaliseArtwork(source);
  for (const [url, size] of [
    ['/favicon.png', 64], ['/assets/apple-touch-icon.png', 180],
    ['/assets/pwa-192.png', 192], ['/assets/pwa-512.png', 512], ['/assets/pwa-maskable-512.png', 512],
  ]) {
    const response = await request(app).get(url).buffer(true).parse(binary).expect(200).expect('content-type', /^image\/png/);
    const metadata = await sharp(response.body).metadata();
    assert.equal(metadata.format, 'png', url);
    assert.equal(metadata.width, size, url);
    assert.equal(metadata.height, size, url);
    const artwork = await normaliseArtwork(response.body);
    const error = artwork.reduce((total, value, index) => total + Math.abs(value - reference[index]), 0) / artwork.length;
    assert.ok(error < 25, `${url} must depict the homepage mark (mean colour error ${error.toFixed(2)})`);
  }
});

test('HTTP favicon.ico contains genuine decodable images for small tabs and high resolution launchers', async () => {
  const response = await request(app).get('/favicon.ico').buffer(true).parse(binary).expect(200)
    .expect('content-type', /^image\/(?:x-icon|vnd\.microsoft\.icon)/);
  const ico = response.body;
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 5);
  let expectedOffset = 6 + 5 * 16;
  for (const [index, size] of [16, 32, 48, 64, 256].entries()) {
    const entry = 6 + index * 16;
    assert.equal(ico[entry] || 256, size);
    assert.equal(ico[entry + 1] || 256, size);
    assert.equal(ico.readUInt16LE(entry + 4), 1);
    assert.equal(ico.readUInt16LE(entry + 6), 32);
    const length = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    assert.equal(offset, expectedOffset);
    assert.ok(offset + length <= ico.length);
    const embedded = ico.subarray(offset, offset + length);
    const metadata = await sharp(embedded).metadata();
    assert.equal(metadata.format, 'png');
    assert.equal(metadata.width, size);
    assert.equal(metadata.height, size);
    if (size === 64) assert.deepEqual(embedded, await read('public/favicon.png'));
    expectedOffset += length;
  }
  assert.equal(expectedOffset, ico.length);
});

test('manifest icon URLs resolve and maskable artwork stays in the launcher safe circle', async () => {
  const response = await request(app).get('/manifest.webmanifest').expect(200).expect('content-type', /manifest\+json/);
  const manifest = JSON.parse(response.text);
  assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192' && icon.purpose === 'any'));
  assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512' && icon.purpose === 'any'));
  const declared = [...manifest.icons, ...manifest.shortcuts.flatMap((shortcut) => shortcut.icons)];
  for (const icon of declared) {
    const asset = await request(app).get(icon.src).buffer(true).parse(binary).expect(200).expect('content-type', /^image\/png/);
    const dimensions = await sharp(asset.body).metadata();
    assert.equal(`${dimensions.width}x${dimensions.height}`, icon.sizes);
  }
  const maskable = manifest.icons.find((icon) => icon.purpose === 'maskable');
  assert.ok(maskable, 'launchers have a dedicated icon with safe padding');
  const { data, info } = await sharp(await read(`public${maskable.src}`)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const pixel = (y * info.width + x) * info.channels;
      if (data[pixel] > 235 && data[pixel + 1] > 235 && data[pixel + 2] > 235) continue;
      assert.ok(Math.hypot(x + 0.5 - info.width / 2, y + 0.5 - info.height / 2) <= info.width * 0.4,
        `maskable artwork at ${x},${y} exceeds the safe circle`);
    }
  }
});
