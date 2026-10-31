import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import { publicId } from '../src/core/ids.js';
import { displayDashboardReference, dashboardRecordHeading } from '../src/dashboard/display-labels.js';

const account = 'usr_4421b6567d414b95a3d11269713cc71b';

test('visible account labels use only an already authorized name and never query or invent another identity', () => {
  const columns = ['Account', 'Name', 'Role'];
  const row = { id: account, cells: [account, 'Amina Namuli', 'Customer'] };
  assert.equal(displayDashboardReference(account, { column: 'Account', columns, row }), 'Amina Namuli');
  assert.equal(displayDashboardReference(account, { user: { publicId: account, name: 'Current member' } }), 'Current member');
  assert.equal(displayDashboardReference(account), 'Account holder');
  assert.equal(displayDashboardReference('507f1f77bcf86cd799439011', { column: 'Account' }), 'Account holder');
  assert.equal(displayDashboardReference(account, { column: 'Actor', columns, row }), 'Account holder',
    'a target account name must not be attributed to an unrelated audit actor');
  assert.equal(displayDashboardReference(account, { column: 'Account', columns, row: { cells: [account, account] } }), 'Account holder');
  assert.equal(row.id, account);
  assert.equal(row.cells[0], account, 'formatting must not mutate the source or its tracking identity');
  assert.equal(displayDashboardReference(125), 125);
  assert.equal(displayDashboardReference('UGX 25,000'), 'UGX 25,000');
  assert.equal(displayDashboardReference('usr_external_reference'), 'usr_external_reference',
    'ordinary user-authored strings and non-generated references are left intact');
  assert.equal(displayDashboardReference('usr_' + 'a'.repeat(32)), 'Account holder', 'legacy32hex account IDs remain supported');
  for (const freeText of ['usr_' + 'a'.repeat(16), 'usr_' + 'a'.repeat(31), 'usr_' + 'a'.repeat(33),
    'User ' + account, 'A note about ' + account, 'other_' + account.slice(4)]) {
    assert.equal(displayDashboardReference(freeText), freeText, 'free text is not searched or rewritten for embedded IDs');
  }
});

test('operational reference labels and record headings retain meaningful source context', () => {
  assert.equal(displayDashboardReference('ord_4421b6567d414b95a3d11269713cc71b'), 'Order · 713CC71B');
  assert.equal(displayDashboardReference('ref_4421b6567d414b95a3d11269713cc71b'), 'Referral · 713CC71B');
  assert.equal(dashboardRecordHeading({ publicId: account, name: 'Amina Namuli' }), 'Amina Namuli');
  assert.equal(dashboardRecordHeading({ publicId: 'prd_4421b6567d414b95a3d11269713cc71b', title: 'Coffee beans' }), 'Coffee beans');
  assert.equal(dashboardRecordHeading({ publicId: account }), 'Account holder');
  assert.equal(displayDashboardReference('prv_' + account.slice(4), { column: 'Privacy request' }), 'Privacy request · 713CC71B');
  assert.equal(displayDashboardReference('prv_' + account.slice(4), { column: 'Promoter verification' }), 'Promoter verification · 713CC71B');
  assert.equal(displayDashboardReference('spr_' + account.slice(4), { column: 'Referral' }), 'Referral · 713CC71B');
});

test('all current production generators have readable labels for their real UUID references', async () => {
  const prefixes = new Set();
  async function readSources(directory) {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, item.name);
      if (item.isDirectory()) await readSources(target);
      else if (item.name.endsWith('.js')) {
        const source = await fs.readFile(target, 'utf8');
        for (const match of source.matchAll(/\bpublicId\(['"]([a-z_]+)['"]\)/g)) prefixes.add(match[1]);
      }
    }
  }
  await readSources(fileURLToPath(new URL('../src', import.meta.url)));
  assert.ok(prefixes.size > 100, 'the production-source inventory must actually execute');
  for (const prefix of prefixes) {
    const id = publicId(prefix);
    assert.notEqual(displayDashboardReference(id), id, `Missing readable reference type: ${prefix}`);
  }
});

test('the real Super Admin table escapes readable names while preserving its complete action identity', async () => {
  const name = '<script>unsafe account name</script>';
  const href = '/super/users?id=' + account;
  const flow = { filters: {}, selected: null, context: { countries: [], timeZone: 'UTC' }, parameters: {},
    page: { total: 1 }, country: 'UG', tabs: [], statusOptions: [], metrics: [],
    columns: ['Account', 'Name', 'Role', 'Country', 'Status'],
    rows: [{ id: account, href, cells: [account, name, 'Customer', 'UG', 'Active'] }],
    exportHref: '/super/users/export.csv' };
  const html = await ejs.renderFile(fileURLToPath(new URL('../views/partials/super-admin-main.ejs', import.meta.url)), {
    superAdminFlow: flow, superAdminPage: { id: 'super-users', href: '/super/users', title: 'Platform accounts', label: 'Accounts' },
    dashboardDisplay: displayDashboardReference, dashboardRecordHeading,
  });
  assert.ok(html.includes('href="' + href + '"'), 'the complete source ID stays in the authorized action URL');
  assert.ok(html.includes('&lt;script&gt;unsafe account name&lt;/script&gt;'));
  assert.ok(!html.includes(name), 'untrusted names must remain escaped in cells and action labels');
  assert.ok(!html.includes('>' + account + '<'), 'the visible table does not print a machine account ID');
  assert.equal(flow.rows[0].cells[0], account);
});
