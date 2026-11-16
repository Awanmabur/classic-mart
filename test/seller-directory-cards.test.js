import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET ||= 'seller-directory-cache-test-session-secret';
process.env.TOKEN_PEPPER ||= 'seller-directory-cache-test-token-pepper';

const { assembleSellerDirectoryCards } = await import('../src/services/seller-directory-cards.js');

test('directory cards retain ratings, products, media and categories without disclosing database IDs', () => {
  const stores = [
    { _id: 'store-1', publicId: 'store_1', slug: 'fruit-shop', name: 'Fruit shop', description: 'Fresh fruit', country: 'UG', currency: 'UGX', productCount: 12 },
    { _id: 'store-2', publicId: 'store_2', slug: 'electronics', name: 'Electronics', description: 'Phones', country: 'UG', currency: 'UGX', productCount: 2 },
  ];
  const products = [
    { _id: 'product-1', storeId: 'store-1', _publicCategory: { name: 'Food' } },
    { _id: 'product-2', storeId: 'store-1', _publicCategory: { name: 'Food' } },
    { _id: 'product-3', storeId: 'store-2', _publicCategory: { name: 'Phones' } },
  ];
  const cards = assembleSellerDirectoryCards({
    stores, products,
    media: [{ productId: 'product-1', publicId: 'media_1' }, { productId: 'product-3', publicId: 'media_3' }],
    reviewMetrics: [
      { _id: 'product-1', reviews: 2, rating: 4.5 },
      { _id: 'product-2', reviews: 1, rating: 3 },
    ],
    salesMetrics: [{ _id: 'product-1', sold: 7 }, { _id: 'product-2', sold: 4 }],
  });
  assert.equal(cards.length, 2);
  assert.equal(cards[0].rating, 4);
  assert.equal(cards[0].reviews, 3);
  assert.equal(cards[0].sold, 11);
  assert.equal(cards[0].productCount, 12); // authoritative eligible count, not sample size
  assert.deepEqual(cards[0].categories, ['Food']);
  assert.equal(cards[0].image, '/media/catalogue/media_1?size=thumb');
  assert.deepEqual(cards[0].productImages, ['/media/catalogue/media_1?size=thumb', '/assets/product-placeholder.svg']);
  assert.equal(cards[0].followed, false);
  assert.equal(cards[1].rating, 0);
  assert.equal(cards[1].productCount, 2);
  assert.equal(cards[1].image, '/media/catalogue/media_3?size=thumb');
  for (const card of cards) {
    assert.equal('_id' in card, false);
    assert.equal('ownerUserId' in card, false);
    assert.equal('earnedMinor' in card, false);
    assert.equal('userMongoId' in card, false);
  }
});

test('directory summary ignores products not belonging to the eligible seller page', () => {
  const cards = assembleSellerDirectoryCards({
    stores: [{ _id: 'allowed', publicId: 'safe', slug: 'safe', name: 'Safe', country: 'UG', currency: 'UGX', productCount: 1 }],
    products: [{ _id: 'foreign', storeId: 'other', _publicCategory: { name: 'Private' } }],
    media: [{ productId: 'foreign', publicId: 'foreign_media' }],
    reviewMetrics: [{ _id: 'foreign', reviews: 9, rating: 5 }],
    salesMetrics: [{ _id: 'foreign', sold: 20 }],
  });
  assert.equal(cards[0].image, '/assets/product-placeholder.svg');
  assert.deepEqual(cards[0].categories, []);
  assert.equal(cards[0].rating, 0);
  assert.equal(cards[0].sold, 0);
});

test('directory keeps the first four eligible public product thumbnails in published order', () => {
  const products = Array.from({ length: 6 }, (_, i) => ({
    _id: 'prd-' + i, storeId: 'store-1', _publicCategory: { name: 'Cat-' + i },
  }));
  const cards = assembleSellerDirectoryCards({
    stores: [{ _id: 'store-1', publicId: 'store_1', slug: 'shop', name: 'Shop', country: 'UG', currency: 'UGX', productCount: 6 }],
    products,
    media: products.map((p, i) => ({ productId: p._id, publicId: 'med_' + i })),
  });
  assert.equal(cards[0].productImages.length, 4);
  assert.equal(cards[0].productImages[3], '/media/catalogue/med_3?size=thumb');
  assert.equal(cards[0].categories.length, 6);
});
