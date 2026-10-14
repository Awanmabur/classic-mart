import { randomUUID, randomInt } from 'node:crypto';
import { test, expect } from '@playwright/test';

// The approved main product frame uses the 24px card radius minus its 1px border.
const photoRadius = 23;

async function expectPhotos(images, radius = photoRadius) {
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
    expect(photo.corners, `${photo.name}: every photo corner uses the same radius`).toEqual(Array(4).fill(`${radius}px`));
    expect(['cover', 'contain'], `${photo.name}: photography preserves its aspect ratio`).toContain(photo.fit);
  }
}

async function expectFrames(frames, radius = photoRadius) {
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
    expect(frame.corners, `${frame.name}: the frame clips all four photo corners`).toEqual(Array(4).fill(`${radius}px`));
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
  await expectPhotos(modal.locator('.gallery-main > img'));
  await expectFrames(modal.locator('.gallery-main'));
  const thumbnailRadius = testInfo.project.name.startsWith('mobile') ? 12 : 14;
  await expectPhotos(modal.locator('.gallery-thumb > img'), thumbnailRadius);
  await expectFrames(modal.locator('.gallery-thumb'), thumbnailRadius);
  await expectPhotos(modal.locator('.preview-related-image > img'));
  await expectFrames(modal.locator('.preview-related-image'));
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

test('homepage photos and small promotional banners share clean product-image corners', async ({ page }, testInfo) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  const reference = page.locator('#trendingGrid .product-image').first();
  await expect(reference).toHaveCSS('border-top-left-radius', `${photoRadius}px`);
  for (const selector of ['.promo-card', '.category-image', '#trendingGrid .product-image', '.compact-image', '.recommend-image', '.mini-product-image', '.collection-card', '.blog-card:has(> img)']) {
    await expectFrames(page.locator(selector));
    await expectPhotos(page.locator(`${selector} > img`));
  }
  await expectPhotos(page.locator('.hero-product'));
  await page.locator('.promo-card').first().hover();
  await expectFrames(page.locator('.promo-card'));
  await expectPhotos(page.locator('.promo-card > img'));

  const search = page.getByRole('combobox', { name: 'Search products', exact: true });
  await search.fill('Classic');
  await expectPhotos(page.locator('.search-result-option > img'), 10);
  await search.press('ArrowDown');
  await search.press('Enter');
  await expectPreview(page, testInfo);
  // Decorative toolbar icons retain their original geometry.
  await expect(page.locator('#productModalShare > img')).toHaveCSS('border-radius', '0px');
});

test('catalogue, category directory, search previews and direct product details keep matching photo frames', async ({ page }, testInfo) => {
  await page.goto('/products', { waitUntil: 'networkidle' });
  await expectFrames(page.locator('.catalog-product-image'));
  await expectPhotos(page.locator('.catalog-product-image > img'));
  const productPath = await page.locator('.catalog-product-image').first().getAttribute('href');
  await page.locator('.catalog-product-image').first().click();
  await expectPreview(page, testInfo);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'List view', exact: true }).click();
  await expectFrames(page.locator('.catalog-product-image'));
  await expectPhotos(page.locator('.catalog-product-image > img'));

  await page.goto('/categories', { waitUntil: 'networkidle' });
  await expectFrames(page.locator('.category-directory-image'));
  await expectPhotos(page.locator('.category-directory-image > img'));
  await page.goto('/search?q=Classic', { waitUntil: 'networkidle' });
  await expectPhotos(page.locator('.catalog-product-image > img'));
  await page.locator('.catalog-product-image').first().click();
  await expectPreview(page, testInfo);

  await page.goto(productPath, { waitUntil: 'networkidle' });
  await expectPreview(page, testInfo);
});

test('cart photography and checkout thumbnails keep their rounded clip after a real cart addition', async ({ page }) => {
  await page.goto('/products', { waitUntil: 'networkidle' });
  await page.locator('[data-catalog-add]:not([disabled])').first().click();
  await expect(page.locator('#cartCount')).toHaveText('1');
  await page.goto('/cart', { waitUntil: 'networkidle' });
  await expectFrames(page.locator('.cart-page-image'));
  await expectPhotos(page.locator('.cart-page-image > img'));
  await expectFrames(page.locator('.cart-recommend-image'));
  await expectPhotos(page.locator('.cart-recommend-image > img'));
  await page.locator('#goToCheckout').click();
  await expectPhotos(page.locator('.checkout-mini-item > span > img'));
  await expectQuantityBadgesUnclipped(page.locator('.checkout-mini-item > span > b'));
});

test('published journal and seller product photographs use the same corners while identity avatars stay circular', async ({ page }) => {
  await page.goto('/press', { waitUntil: 'networkidle' });
  await expectFrames(page.locator('.news-grid article:has(> img)'));
  await expectPhotos(page.locator('.news-grid article > img'));
  await page.goto('/sellers', { waitUntil: 'networkidle' });
  await page.getByRole('link', { name: 'View profile', exact: true }).first().click();
  await expectFrames(page.locator('.profile-product > a'));
  await expectPhotos(page.locator('.profile-product > a > img'));
  await expect(page.locator('#profileAvatar')).toHaveCSS('border-radius', '50%');
});

test('customer wishlist and comparison photographs retain clean corners across server refreshes', async ({ page }, testInfo) => {
  test.skip(process.env.E2E_IMAGE_SIGNUP !== 'true', 'Enable E2E_IMAGE_SIGNUP only for the isolated seeded browser server with simple customer login.');
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

  await page.goto('/products', { waitUntil: 'networkidle' });
  const firstProduct = page.locator('.catalog-product-card').first();
  await firstProduct.locator('[data-catalog-wishlist]').click();
  await expect(firstProduct.locator('[data-catalog-wishlist]')).toHaveClass(/active/);
  await firstProduct.locator('[data-catalog-compare]').click();
  await expect(firstProduct.locator('[data-catalog-compare]')).toHaveText('Compared');
  const mobile = testInfo.project.name.startsWith('mobile');
  for (const { pathname, frame, photo, radius, frameRadius = radius } of [
    // Final 19 clips the whole product card and uses its smaller photo radius.
    { pathname: '/wishlist', frame: '.product-card', photo: '.product-image img', radius: mobile ? 24 : 26, frameRadius: 32 },
    { pathname: '/compare', frame: '.wishlist-card-image', photo: '.wishlist-card-image > img', radius: photoRadius },
  ]) {
    await page.goto(pathname, { waitUntil: 'networkidle' });
    if (pathname === '/wishlist') await expect(page.locator('body')).toHaveAttribute('data-dashboard-workspace', 'customer');
    await expectFrames(page.locator(frame), frameRadius);
    await expectPhotos(page.locator(photo), radius);
    await page.reload({ waitUntil: 'networkidle' });
    await expectPhotos(page.locator(photo), radius);
  }
});
