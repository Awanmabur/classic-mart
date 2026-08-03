import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('all actionless forms and non-submit buttons are wired by scripts loaded on their page', () => {
  const result = spawnSync(process.execPath, ['scripts/audit-functionality.js'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /54 views/);
});

test('checkout uses the real tracked-order flow without a dead client-only confirmation button', () => {
  const cartView = read('views/cart.ejs');
  const cartPage = read('public/cart-page.js');
  assert.doesNotMatch(cartView, /id="(?:orderComplete|copyOrderNumber)"/);
  assert.match(cartPage, /location\.href = `\/track-order\?order=/);
  assert.match(cartPage, /await window\.ClassicMartCart\?\.clear\?\.\(\)/);
});
