import { publicProductImageUrl } from './product-media-url.js';

const identity = value => String(value ?? '');

/**
 * Assemble only the information shown in public seller directory cards.
 * The caller must supply products already filtered with publicEligibilityStages.
 * This intentionally never assembles checkout variants, inventory or full product DTOs.
 */
export function assembleSellerDirectoryCards({
  stores = [], products = [], media = [], reviewMetrics = [], salesMetrics = [],
} = {}) {
  const byStoreId = new Map(stores.map(store => [identity(store._id), {
    images: [], categories: new Set(), reviews: 0, weightedRating: 0, sold: 0,
  }]));
  const firstMedia = new Map();
  for (const item of media) {
    const id = identity(item.productId);
    // Caller orders by productId, position, createdAt; keep the first approved image.
    if (!firstMedia.has(id)) firstMedia.set(id, item);
  }
  const reviewByProduct = new Map(reviewMetrics.map(row => [identity(row._id), row]));
  const salesByProduct = new Map(salesMetrics.map(row => [identity(row._id), row]));

  for (const product of products) {
    const summary = byStoreId.get(identity(product.storeId));
    if (!summary) continue;
    const image = publicProductImageUrl(firstMedia.get(identity(product._id)));
    if (summary.images.length < 4) summary.images.push(image);
    const categoryName = String(product._publicCategory?.name || '').trim();
    if (categoryName) summary.categories.add(categoryName);

    const review = reviewByProduct.get(identity(product._id));
    const count = Math.max(0, Number(review?.reviews) || 0);
    const roundedRating = Number((Number(review?.rating) || 0).toFixed(2));
    summary.reviews += count;
    summary.weightedRating += roundedRating * count;
    summary.sold += Math.max(0, Number(salesByProduct.get(identity(product._id))?.sold) || 0);
  }

  return stores.map(store => {
    const summary = byStoreId.get(identity(store._id));
    const productImages = summary?.images || [];
    const reviews = summary?.reviews || 0;
    return {
      id: store.publicId,
      slug: store.slug,
      name: store.name,
      description: store.description,
      country: store.country,
      currency: store.currency,
      verified: true,
      image: productImages[0] || '/assets/product-placeholder.svg',
      productImages,
      productCount: Number(store.productCount || 0),
      categories: [...(summary?.categories || [])],
      rating: reviews ? Number((summary.weightedRating / reviews).toFixed(2)) : 0,
      reviews,
      sold: summary?.sold || 0,
      followed: false,
    };
  });
}
