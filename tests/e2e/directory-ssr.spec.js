import { test, expect } from './browser-fixture.js';

for (const path of ['/sellers', '/promoters']) {
  test(path + ' shows guest directory from SSR without immediately refetching it', async ({ page }) => {
    const calls = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname === '/api/v1/storefront/sellers' || url.pathname === '/api/v1/storefront/promoters') {
        calls.push(url.pathname);
      }
    });

    const result = await page.goto(path, { waitUntil: 'networkidle' });
    expect(result.status()).toBe(200);
    const snapshot = await page.locator('#initialPeopleData').evaluate(element => JSON.parse(element.textContent));
    expect(Array.isArray(snapshot.people)).toBe(true);
    expect(snapshot.page).toBeTruthy();
    await expect(page.locator('#peopleGrid > .person-card')).toHaveCount(snapshot.people.length);
    await expect(page.locator('#peopleCount')).not.toContainText('Loading');
    expect(calls, 'the SSR document already contains public directory data').toEqual([]);
  });
}
