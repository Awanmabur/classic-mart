import { test, expect } from '@playwright/test';

const adminEmail = process.env.ADMIN_EMAIL || 'admin@classicmart.local';
const adminPassword = process.env.ADMIN_PASSWORD || '';

function monitorBrowserFailures(page) {
  const failures = [];
  page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(`console: ${message.text()}`);
  });
  return failures;
}

test('public catalogue survives search, refresh and browser back navigation', async ({ page }) => {
  const failures = monitorBrowserFailures(page);
  await page.goto('/products', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/Browse products/i);
  const search = page.locator('#searchInput');
  await expect(search).toBeVisible();
  await search.fill('Classic');
  await search.press('Enter');
  await page.waitForLoadState('networkidle');
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.locator('#catalogProductGrid')).toBeVisible();
  await page.goto('/login');
  await page.goBack({ waitUntil: 'networkidle' });
  await expect(page).toHaveURL(/\/products/);
  expect(failures).toEqual([]);
});

test('seeded privileged account can sign in and reach scoped admin/seller workspaces', async ({ page }, testInfo) => {
  test.skip(!adminPassword, 'ADMIN_PASSWORD is required for authenticated browser coverage.');
  if (testInfo.project.name.startsWith('mobile')) test.skip(true, 'Authenticated control-plane smoke runs once on desktop.');
  const failures = monitorBrowserFailures(page);
  await page.goto('/login');
  await page.getByLabel('Email address').fill(adminEmail);
  await page.getByLabel('Password').fill(adminPassword);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith('/login')),
    page.getByRole('button', { name: /Sign In to Classic Mart/i }).click(),
  ]);
  await page.goto('/admin', { waitUntil: 'networkidle' });
  await expect(page.locator('body')).toContainText(/Admin|Approval|Support|Finance/i);
  await page.goto('/seller/products', { waitUntil: 'networkidle' });
  await expect(page.locator('body')).toContainText(/Product|Seller|Catalogue/i);
  expect(failures).toEqual([]);
});

test('mobile storefront does not create horizontal page overflow and exposes mobile search', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile'), 'Mobile-only layout assertion.');
  await page.goto('/', { waitUntil: 'networkidle' });
  await expect(page.locator('#mobileSearchButton')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(2);
});

test('double activation of navigation does not create duplicate browser errors', async ({ page }) => {
  const failures = monitorBrowserFailures(page);
  await page.goto('/');
  const productsLink = page.getByRole('link', { name: /Products/i }).first();
  await expect(productsLink).toBeVisible();
  await productsLink.dblclick();
  await page.waitForLoadState('domcontentloaded');
  expect(failures).toEqual([]);
});


test('authenticated operational tables become labelled phone cards without page overflow', async ({ page }, testInfo) => {
  test.skip(!adminPassword, 'ADMIN_PASSWORD is required for authenticated browser coverage.');
  test.skip(!testInfo.project.name.startsWith('mobile'), 'Operational phone-card assertion runs in the mobile project.');
  await page.goto('/login');
  await page.getByLabel('Email address').fill(adminEmail);
  await page.getByLabel('Password').fill(adminPassword);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith('/login')),
    page.getByRole('button', { name: /Sign In to Classic Mart/i }).click(),
  ]);
  await page.goto('/admin', { waitUntil: 'networkidle' });
  const responsiveCells = page.locator('.ops-responsive-table tbody td:not([colspan])');
  if (await responsiveCells.count()) {
    await expect(responsiveCells.first()).toHaveAttribute('data-label', /\S+/);
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(2);
});
