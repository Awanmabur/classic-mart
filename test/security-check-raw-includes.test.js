import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

test('reviewed raw partial calls remain bound to their caller and exact arguments', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'classicmart-raw-includes-'));
  try {
    for (const directory of ['scripts', 'src', 'public', 'views/partials']) fs.mkdirSync(path.join(root, directory), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
    for (const name of ['security-check.js', 'security-check-path.js']) {
      fs.copyFileSync(path.join(projectRoot, 'scripts', name), path.join(root, 'scripts', name));
    }
    const view = path.join(root, 'views', 'approved-dashboard.ejs');
    const run = () => spawnSync(process.execPath, ['scripts/security-check.js'], { cwd: root, encoding: 'utf8' });
    fs.writeFileSync(view, "<%- include('partials/business-main') %>\n<%- include('partials/customer-live-pages', { pageId: 'profile', pageData, walletIdempotencyKey: '' }) %>\n");
    let result = run();
    assert.equal(result.status, 0, result.stderr);

    fs.renameSync(view, path.join(root, 'views', 'unreviewed.ejs'));
    result = run();
    assert.equal(result.status, 1, 'A reviewed partial cannot be introduced in a different caller without review.');
    assert.match(result.stderr, /unreviewed\.ejs: unapproved raw EJS output/);
    fs.rmSync(path.join(root, 'views', 'unreviewed.ejs'));

    for (const expression of [
      "include('partials/customer-live-pages', { pageId: 'profile', pageData: request.body, walletIdempotencyKey: '' })",
      "include('partials/flash-assets', request.body)",
      'include(request.query.partial)',
      'pageData.html',
    ]) {
      fs.writeFileSync(view, `<%- ${expression} %>\n`);
      result = run();
      assert.equal(result.status, 1, 'Unreviewed arguments, dynamic includes and raw data must remain rejected.');
      assert.match(result.stderr, /unapproved raw EJS output/);
    }
    fs.writeFileSync(view, "<%- include('partials/flash-assets') %>\n");
    result = run();
    assert.equal(result.status, 0, 'The shared static asset partial needs no raw data or dynamic arguments.');

    fs.rmSync(view);
    const catalogueView = path.join(root, 'views', 'products.ejs');
    const reviewedJson = "typeof initialCatalogueJson !== 'undefined' ? initialCatalogueJson : '{}'";
    fs.writeFileSync(catalogueView, `<script type="application/json"><%- ${reviewedJson} %></script>\n`);
    result = run();
    assert.equal(result.status, 0, 'Only the reviewed HTML-safe catalogue serialization is allowed.');
    for (const expression of ['request.body', 'initialCatalogue', 'JSON.stringify(initialCatalogue)', "typeof initialCatalogueJson !== 'undefined' ? request.body : '{}'"]) {
      fs.writeFileSync(catalogueView, `<%- ${expression} %>\n`);
      result = run();
      assert.equal(result.status, 1, 'Raw catalogue objects and unreviewed fallback expressions stay rejected.');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
