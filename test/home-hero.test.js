import test from 'node:test';
import assert from 'node:assert/strict';
import { homeHero } from '../src/services/home-hero.js';

const country = { code: 'UG', currency: 'UGX' };
const product = (id, fields = {}) => ({ id, name: `Product ${id}`, description: 'Actual published description.',
  stock: 3, price: 45000, currency: 'UGX', category: 'electronics', categoryName: 'Electronics',
  image: '/media/catalogue/med_public?size=thumb', ...fields });
const catalogue = products => ({ country, categories: [{ id: 'electronics', name: 'Electronics' }], products });
const editorial = (key, fields = {}) => ({ key, type: 'hero', country: '', version: 1,
  title: 'Published editorial title', body: 'Published editorial copy.', data: { category: 'electronics', action: 'Shop electronics' }, ...fields });

test('an empty catalogue has no invented hero products or duplicate fake slides', () => {
  assert.deepEqual(homeHero(), { source: 'empty', slides: [] });
  assert.deepEqual(homeHero({ catalogue: catalogue([]) }), { source: 'empty', slides: [] });
});

test('one real available product produces one honest slide with a country-preserving direct link', () => {
  const result = homeHero({ catalogue: catalogue([product('prd_real')]) });
  assert.equal(result.source, 'catalogue');
  assert.equal(result.slides.length, 1);
  assert.equal(result.slides[0].title, 'Product prd_real');
  assert.equal(result.slides[0].body, 'Actual published description.');
  assert.equal(result.slides[0].data.href, '/products/prd_real?country=UG');
  assert.equal(result.slides[0].data.image, '/media/catalogue/med_public?size=thumb');
});

test('catalogue fallback is bounded and excludes duplicate, unavailable, foreign-currency and malformed records', () => {
  const rows = [product('prd_duplicate'), product('prd_duplicate'), product('prd_oos', { stock: 0 }),
    product('prd_ke', { currency: 'KES' }), product('prd_draft', { status: 'draft' }),
    product('prd_free', { price: 0 }), product('bad/id'), product('prd_blank', { name: ' ' }),
    ...Array.from({ length: 10 }, (_, index) => product(`prd_more_${index}`))];
  const result = homeHero({ catalogue: catalogue(rows) });
  assert.equal(result.source, 'catalogue');
  assert.equal(result.slides.length, 6);
  assert.deepEqual(result.slides.map(row => row.key), ['prd_duplicate', 'prd_more_0', 'prd_more_1', 'prd_more_2', 'prd_more_3', 'prd_more_4']);
});

test('published editorial slides remain authoritative and country copies override the same global key', () => {
  const result = homeHero({ catalogue: catalogue([product('prd_real')]), publishedSlides: [
    editorial('home.hero.shared'),
    editorial('home.hero.shared', { country: 'UG', title: 'Uganda editorial' }),
    editorial('home.hero.shared', { title: 'Later global cannot hide Uganda' }),
    editorial('home.hero.foreign', { country: 'KE', title: 'Foreign private market' }),
    editorial('home.hero.unpublished', { version: 0, title: 'Unpublished revision' }),
    editorial('home.hero.2026.campaign', { title: 'Second active editorial', data: { category: 'missing', action: 'Browse current products' } }),
  ] });
  assert.equal(result.source, 'cms');
  assert.equal(result.slides.length, 2);
  assert.deepEqual(result.slides.map(row => row.title), ['Second active editorial', 'Uganda editorial']);
  assert.equal(result.slides[0].data.href, '/products?country=UG');
  assert.equal(result.slides[1].data.href, '/products?country=UG&category=electronics');
  assert.equal(result.slides[1].data.image, '/media/catalogue/med_public?size=thumb');
  assert.ok(!result.slides.some(row => row.key === 'prd_real'));
});

test('one published editorial banner stays one banner instead of duplicating merchandising content', () => {
  const result = homeHero({ catalogue: catalogue([product('prd_a'), product('prd_b')]), publishedSlides: [editorial('home.hero.only')] });
  assert.equal(result.source, 'cms');
  assert.equal(result.slides.length, 1);
});

test('invalid or foreign editorial data cannot hide the available real-product fallback', () => {
  const result = homeHero({ catalogue: catalogue([product('prd_a')]), publishedSlides: [null,
    editorial('home.hero.foreign', { country: 'KE' }), editorial('home.hero.blank', { title: ' ' }),
    editorial('home.hero.draft', { version: 0 }), editorial('legal.privacy'),
  ] });
  assert.equal(result.source, 'catalogue');
  assert.equal(result.slides[0].key, 'prd_a');
});

test('hero image and action sources cannot become external URLs or scripts', () => {
  for (const image of ['javascript:alert(1)', '//foreign.example/image.png', 'https://foreign.example/image.png',
    '/assets/../private/image.png', '/media/%2e%2e/private', '/assets/image.png\n']) {
    const result = homeHero({ catalogue: catalogue([product('prd_a', { image })]), publishedSlides: [
      editorial('home.hero.image', { data: { image, category: '//foreign.example', href: 'javascript:alert(1)' } }),
    ] });
    assert.equal(result.slides[0].data.image, '/assets/product-placeholder.svg');
    assert.equal(result.slides[0].data.href, '/products?country=UG');
  }
});
