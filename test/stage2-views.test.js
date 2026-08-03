import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const user = {
  name: 'Stage Two Seller',
  role: 'seller',
  country: 'UG',
};
const store = {
  name: 'Stage Two Store',
  description: 'A real test store.',
  status: 'verified',
  country: 'UG',
  currency: 'UGX',
};
const common = {
  csrfToken: 'test-csrf',
  flash: null,
  user,
  store,
  roleLabel: () => 'Seller',
  formatDate: () => '30 Jul 2026',
  formatMoney: (amount) => `UGX ${amount}`,
  moneyInput: (amount) => amount,
  firstOption: (options) => Object.entries(options || {})[0] || ['', ''],
};

test('renders the seller product editor with real workflow controls', async () => {
  const html = await ejs.renderFile(
    path.join(root, 'views/catalog-workspace.ejs'),
    {
      ...common,
      view: {
        section: 'product-edit',
        product: {
          publicId: 'prd_test',
          title: 'Test product',
          description: 'A complete product description for runtime rendering.',
          categoryId: 'cat-id',
          brandId: 'brand-id',
          countries: ['UG'],
          tags: ['test'],
          status: 'draft',
          qualityScore: 60,
          moderation: {},
        },
        variants: [
          {
            publicId: 'var_test',
            title: 'Default',
            sku: 'TEST-001',
            priceMinor: 1000,
            currency: 'UGX',
            compareAtMinor: null,
            active: true,
            options: { Color: 'Blue' },
            weightGrams: 0,
          },
        ],
        media: [],
        categories: [{ _id: 'cat-id', publicId: 'cat_test', name: 'Test' }],
        brands: [{ _id: 'brand-id', publicId: 'brd_test', name: 'Test' }],
        countries: [{ code: 'UG', name: 'Uganda' }],
      },
    },
  );
  assert.match(html, /Submit for Review/);
  assert.match(html, /Edit variant/);
});

test('renders database catalogue settings for authorized administration', async () => {
  const html = await ejs.renderFile(
    path.join(root, 'views/moderation-workspace.ejs'),
    {
      ...common,
      user: { ...user, role: 'super_admin' },
      view: {
        section: 'catalogue-settings',
        categories: [
          {
            publicId: 'cat_test',
            name: 'Test Category',
            countries: [],
            attributes: [],
            active: true,
          },
        ],
        brands: [],
        countries: [{ code: 'UG', name: 'Uganda' }],
        canManageCategories: true,
      },
    },
  );
  assert.match(html, /Create category/);
  assert.match(html, /Database reference data/);
});
