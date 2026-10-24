import { randomUUID, randomInt } from 'node:crypto';
import { test, expect } from '@playwright/test';

// Approved f941fbd geometry is component-specific: product frames round only
// their top edge, category frames stay circular, and supporting cards clip photos.
const topCorners = radius => [radius, radius, 0, 0];
const corners = radius => (Array.isArray(radius) ? radius : Array(4).fill(radius)).map(value =>
  typeof value === 'number' ? `${value}px` : value);

async function expectPhotos(images, radius = 0) {
  await expect(images.first()).toBeVisible();
  const photos = await images.evaluateAll(nodes => nodes.map(image => {
    const style = getComputedStyle(image);
    return {
      name: image.alt || image.currentSrc,
      corners: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius],
      fit: style.objectFit,
    };
  }));
  expect(photos.length).toBeGreaterThan(0);
  for (const photo of photos) {
    expect(photo.corners, `${photo.name}: photo retains its approved component geometry`).toEqual(corners(radius));
    expect(['cover', 'contain'], `${photo.name}: photography preserves its aspect ratio`).toContain(photo.fit);
  }
}

async function expectFrames(frames, radius) {
  await expect(frames.first()).toBeVisible();
  const styles = await frames.evaluateAll(nodes => nodes.map(frame => {
    const style = getComputedStyle(frame);
    return {
      name: frame.className,
      corners: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius],
      overflow: [style.overflowX, style.overflowY],
    };
  }));
  expect(styles.length).toBeGreaterThan(0);
  for (const frame of styles) {
    expect(frame.corners, `${frame.name}: frame retains its approved corner geometry`).toEqual(corners(radius));
    expect(frame.overflow.every(value => ['hidden', 'clip'].includes(value)), `${frame.name}: zoomed photos stay inside the frame`).toBe(true);
  }
}

async function expectQuantityBadgesUnclipped(badges) {
  await expect(badges.first()).toBeVisible();
  for (const badge of await badges.all()) {
    await badge.scrollIntoViewIfNeeded();
    const geometry = await badge.evaluate(node => {
      const box = node.getBoundingClientRect();
      const frame = node.parentElement.getBoundingClientRect();
      const style = getComputedStyle(node.parentElement);
      const samples = [
        [box.left + box.width / 2, box.top + 1],
        [box.right - 1, box.top + box.height / 2],
      ];
      return {
        overflow: [style.overflowX, style.overflowY],
        extendsAbove: box.top < frame.top,
        extendsRight: box.right > frame.right,
        visibleOutsideFrame: samples.every(([x, y]) => node.contains(document.elementFromPoint(x, y))),
      };
    });
    expect(geometry.overflow, 'quantity badges can extend beyond the rounded photo').toEqual(['visible', 'visible']);
    expect(geometry.extendsAbove).toBe(true);
    expect(geometry.extendsRight).toBe(true);
    expect(geometry.visibleOutsideFrame, 'badge pixels above and beside the image remain visible').toBe(true);
  }
}

async function expectPreview(page, testInfo) {
  const modal = page.locator('#productModal');
  await expect(modal).toBeVisible();
  const galleryRadius = testInfo.project.name.startsWith('mobile') ? 22 : 26;
  await expectPhotos(modal.locator('.gallery-main > img'), galleryRadius);
  await expectFrames(modal.locator('.gallery-main'), galleryRadius);
  const thumbnailRadius = testInfo.project.name.startsWith('mobile') ? 12 : 14;
  await expectPhotos(modal.locator('.gallery-thumb > img'), thumbnailRadius);
  await expectFrames(modal.locator('.gallery-thumb'), thumbnailRadius);
  await expectPhotos(modal.locator('.preview-related-image > img'));
  await expectFrames(modal.locator('.preview-related-card'), 19);
  await expectFrames(modal.locator('.preview-related-image'), 0);
}

async function signUpCustomer(page) {
  await page.goto('/signup');
  const identity = randomUUID();
  await page.locator('#signUpName').fill('Image Corners Customer');
  await page.locator('#signUpEmail').fill(`image-corners-${identity}@example.test`);
  await page.getByLabel('Phone country code').selectOption('UG');
  await page.locator('#signUpPhone').fill(`77${randomInt(1000000, 9999999)}`);
  await page.locator('#signUpPassword').fill(`PhotoCorners7-${identity}`);
  await page.locator('#signUpConfirmPassword').fill(`PhotoCorners7-${identity}`);
  await page.locator('#acceptTerms').check();
  await page.getByRole('button', { name: 'Create My Account', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

test('homepage retains approved image shapes while only small promotional banners gain rounder corners', async ({ page }, testInfo) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  const mobile = testInfo.project.name.startsWith('mobile');
  for (const [selector, radius] of [
    ['.category-image', '50%'],
    ['#trendingGrid .product-image', topCorners(23)],
    ['.compact-image', 21],
    ['.recommend-image', topCorners(23)],
    ['.mini-product-image', topCorners(mobile ? 17 : 23)],
    ['.collection-card', 24],
    ['.blog-card:has(> img)', 24],
  ]) {
    await expectFrames(page.locator(selector), radius);
    await expectPhotos(page.locator(`${selector} > img`));
  }
  await expectPhotos(page.locator('.hero-product'), 24);
  await expectFrames(page.locator('.promo-card'), 32);
  await expectPhotos(page.locator('.promo-card > img'), 24);
  await page.locator('.promo-card').first().hover();
  await expectFrames(page.locator('.promo-card'), 32);
  await expectPhotos(page.locator('.promo-card > img'), 24);

  const search = page.getByRole('combobox', { name: 'Search products', exact: true });
  await search.fill('Classic');
  await expectPhotos(page.locator('.search-result-option > img'), mobile ? 13 : 14);
  await search.press('ArrowDown');
  await search.press('Enter');
  await expectPreview(page, testInfo);
  // Decorative toolbar icons retain their original geometry.
  await expect(page.locator('#productModalShare > img')).toHaveCSS('border-radius', '0px');
});

test('catalogue, category directory, search previews and direct product details keep matching photo frames', async ({ page }, testInfo) => {
  await page.goto('/products', { waitUntil: 'networkidle' });
  await expectFrames(page.locator('.catalog-product-card'), 24);
  await expectFrames(page.locator('.catalog-product-image'), 0);
  await expectPhotos(page.locator('.catalog-product-image > img'));
  const productPath = await page.locator('.catalog-product-image').first().getAttribute('href');
  await page.locator('.catalog-product-image').first().click();
  await expectPreview(page, testInfo);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'List view', exact: true }).click();
  await expectFrames(page.locator('.catalog-product-card'), 24);
  await expectFrames(page.locator('.catalog-product-image'), 0);
  await expectPhotos(page.locator('.catalog-product-image > img'));

  await page.goto('/categories', { waitUntil: 'networkidle' });
  await expectFrames(page.locator('.category-directory-card'), 24);
  await expectFrames(page.locator('.category-directory-image'), 0);
  await expectPhotos(page.locator('.category-directory-image > img'));
  await page.goto('/search?q=Classic', { waitUntil: 'networkidle' });
  await expectPhotos(page.locator('.catalog-product-image > img'));
  await page.locator('.catalog-product-image').first().click();
  await expectPreview(page, testInfo);

  await page.goto(productPath, { waitUntil: 'networkidle' });
  await expectPreview(page, testInfo);
});

test('cart photography and checkout thumbnails keep their approved frame radii after a real cart addition', async ({ page }, testInfo) => {
  test.skip(process.env.E2E_IMAGE_SIGNUP !== 'true', 'Enable E2E_IMAGE_SIGNUP only for the isolated seeded browser server with simple customer login.');
  await page.goto('/products', { waitUntil: 'networkidle' });
  await page.locator('[data-catalog-add]:not([disabled])').first().click();
  await expect(page.locator('#cartCount')).toHaveText('1');
  await page.goto('/cart', { waitUntil: 'networkidle' });
  const cartRadius = testInfo.project.name.startsWith('mobile') ? 16 : 20;
  await expectFrames(page.locator('.cart-page-image'), cartRadius);
  await expectPhotos(page.locator('.cart-page-image > img'), cartRadius);
  await expectFrames(page.locator('.cart-recommend-card'), testInfo.project.name.startsWith('mobile') ? 18 : 23);
  await expectFrames(page.locator('.cart-recommend-image'), 0);
  await expectPhotos(page.locator('.cart-recommend-image > img'));
  await page.locator('#goToCheckout').click();
  await expect(page).toHaveURL(url => url.pathname === '/login' && url.searchParams.get('next') === '/checkout');
  await signUpCustomer(page);
  await page.goto('/cart', { waitUntil: 'networkidle' });
  await expect(page.locator('body')).toHaveAttribute('data-dashboard-workspace', 'customer');
  await expectPhotos(page.locator('.cart-item > img'), 13);
  await page.getByRole('link', { name: 'Proceed to Checkout', exact: true }).click();
  await expect(page).toHaveURL(/\/checkout$/);
  await expectPhotos(page.locator('.checkout-mini-item > span > img'), 16);
  await expectQuantityBadgesUnclipped(page.locator('.checkout-mini-item > span > b'));
});

test('journal and seller product photos retain their approved card clips while identity avatars stay circular', async ({ page }) => {
  await page.goto('/press', { waitUntil: 'networkidle' });
  await expectFrames(page.locator('.news-grid article:has(> img)'), 21);
  await expectPhotos(page.locator('.news-grid article > img'));
  await page.goto('/sellers', { waitUntil: 'networkidle' });
  await page.getByRole('link', { name: 'View profile', exact: true }).first().click();
  await expectFrames(page.locator('.profile-product'), 18);
  await expectPhotos(page.locator('.profile-product > a > img'));
  await expect(page.locator('#profileAvatar')).toHaveCSS('border-radius', '50%');
});

test('customer wishlist and comparison photographs retain clean corners across server refreshes', async ({ page }) => {
  test.skip(process.env.E2E_IMAGE_SIGNUP !== 'true', 'Enable E2E_IMAGE_SIGNUP only for the isolated seeded browser server with simple customer login.');
  await signUpCustomer(page);

  await page.goto('/products', { waitUntil: 'networkidle' });
  const firstProduct = page.locator('.catalog-product-card').first();
  await firstProduct.locator('[data-catalog-wishlist]').click();
  await expect(firstProduct.locator('[data-catalog-wishlist]')).toHaveClass(/active/);
  await firstProduct.locator('[data-catalog-compare]').click();
  await expect(firstProduct.locator('[data-catalog-compare]')).toHaveText('Compared');
  for (const { pathname, frame, photo, radius, frameRadius = radius } of [
    // Approved dashboard photos keep their inset shape inside a 32px card.
    { pathname: '/wishlist', frame: '.product-card', photo: '.product-image img', radius: 0, frameRadius: 32 },
    { pathname: '/compare', frame: '.wishlist-card', photo: '.wishlist-card-image > img', radius: 0, frameRadius: 19 },
  ]) {
    await page.goto(pathname, { waitUntil: 'networkidle' });
    if (pathname === '/wishlist') await expect(page.locator('body')).toHaveAttribute('data-dashboard-workspace', 'customer');
    await expectFrames(page.locator(frame), frameRadius);
    await expectPhotos(page.locator(photo), radius);
    await page.reload({ waitUntil: 'networkidle' });
    await expectPhotos(page.locator(photo), radius);
  }
});
