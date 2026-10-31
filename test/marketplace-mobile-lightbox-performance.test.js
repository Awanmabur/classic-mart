import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium, expect } from '@playwright/test';

const source = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const mobileCss = source('public/approved-dashboard/mobile-header.css');
const loaderCss = source('public/loading-feedback.css');
const loaderJs = source('public/loading-feedback.js');
const previewJs = source('public/product-preview.js');
const modalCss = source('public/platform-polish.css');
const dashboard = source('views/approved-dashboard.ejs');

test('approved dashboard includes the cross-role phone header and non-blocking centered brand loader', () => {
  assert.match(dashboard, /approved-dashboard\/mobile-header\.css/);
  assert.match(mobileCss, /max-width:\s*760px/);
  assert.match(mobileCss, /\.topbar #searchForm\s*\{\s*display:\s*none !important/);
  assert.match(mobileCss, /\.topbar \.dashboard-brand-logo/);
  assert.match(mobileCss, /\.topbar \.mobile-menu/);
  assert.match(loaderCss, /top:\s*50%/);
  assert.match(loaderCss, /left:\s*50%/);
  assert.match(loaderJs, /platform-loading-brand/);
  assert.match(loaderJs, /approved-dashboard\/assets\/classic-mart-icon\.png/);
  assert.match(modalCss, /body \.modal-backdrop/);
  assert.match(modalCss, /body \.product-preview-loading/);
});

test('single-product preview does not block on full catalog and still validates current product before rendering', () => {
  const start = previewJs.indexOf('async function openProduct(productId)');
  const end = previewJs.indexOf('async function addSelectedToCart', start);
  const body = previewJs.slice(start, end);
  assert.ok(body.indexOf('openModal(returnFocus)') < body.indexOf('const response = await fetch('));
  assert.doesNotMatch(body, /await ensureCatalogue\(\)/);
  assert.match(body, /payload\.product\?\.id !== id/);
  assert.match(body, /renderProduct\(product\)/);
  assert.match(body, /const catalogueTask =/);
  assert.match(body, /configureToolbar\(product\)/);
});

test('mobile dashboard header preserves logo left, AI then menu right, and hides search', { timeout: 30_000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox'] });
  try {
    for (const workspace of ['customer', 'seller', 'admin']) {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>*{box-sizing:border-box}body{margin:0}.topbar{position:fixed;top:0;width:100%;height:88px;display:grid;grid-template-columns:260px 1fr auto}.brand-area,.top-actions{display:flex;align-items:center}.mobile-menu{display:none}.dashboard-brand-logo{width:188px;height:60px}.search{display:flex}.ai-button{width:90px;height:42px}.dashboard{padding:150px 12px}</style><style>'+mobileCss+'</style></head><body data-dashboard-workspace="'+workspace+'"><header class="topbar"><div class="brand-area"><a class="dashboard-brand" href="/"><img class="dashboard-brand-logo" alt="Classic Mart" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E"></a></div><form id="searchForm" class="search"><input aria-label="Search dashboard"></form><div class="top-actions"><button id="classicAiBtn" class="ai-button"><span>AI</span></button><button id="mobileMenuBtn" class="mobile-menu" aria-label="Open navigation">Menu</button><button class="categories-button">Categories</button></div></header><main class="dashboard">Content</main></body></html>');
      const search = page.locator('#searchForm');
      await expect(search).toBeHidden();
      const logo = await page.locator('.dashboard-brand-logo').boundingBox();
      const ai = await page.locator('#classicAiBtn').boundingBox();
      const menu = await page.locator('#mobileMenuBtn').boundingBox();
      assert.ok(logo.x < ai.x && ai.x < menu.x, 'logo / AI / menu order: ' + workspace);
      assert.ok(menu.x + menu.width <= 390 && logo.x >= 0);
      assert.ok(!await page.evaluate(() => document.documentElement.scrollWidth > innerWidth));
      await page.close();
    }
  } finally { await browser.close(); }
});
