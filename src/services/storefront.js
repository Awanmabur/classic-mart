import mongoose from 'mongoose';
import { publicProductImageUrl } from './product-media-url.js';
import { cursorScope, decodeCursor, pageResult } from './pagination.js';
import {
  Brand,
  Category,
  Product,
  ProductMedia,
  ProductVariant,
  Review,
  Order,
  StockItem,
  Store,
} from '../models/index.js';

const MAX_PRODUCTS = 300;
const CACHE_TTL_MS = 30_000;
const STALE_CACHE_TTL_MS = 5 * 60_000;
const cache = new Map();
let cacheGeneration = 0;

function key(value) {
  return String(value);
}

export function hasPublicProductApproval(product, category, store) {
  if (!product || !category) return false;
  const review = product.moderation || {};
  if (!category.restricted && review.riskLevel !== 'high' && !review.secondReviewRequired) return true;
  const first = review.firstApprovalByUserId;
  const final = review.reviewedByUserId;
  return review.secondReviewRequired === false && Boolean(first && final)
    && key(first) !== key(final)
    && ![product.ownerUserId, store?.ownerUserId].filter(Boolean).some((owner) => key(owner) === key(first) || key(owner) === key(final));
}

function eligibleProduct(product, category, store, brand, country) {
  return product.status === 'published' && product.countries?.includes(country.code)
    && category?.active === true && (!category.countries?.length || category.countries.includes(country.code))
    && store?.status === 'verified' && store.country === country.code && store.currency === country.currency
    && (!product.brandId || (brand?.status === 'approved' && key(brand._id) === key(product.brandId)))
    && hasPublicProductApproval(product, category, store);
}

function publicEligibilityStages(country) {
  return [
    { $lookup: { from: 'categories', localField: 'categoryId', foreignField: '_id', as: '_publicCategory' } },
    { $unwind: '$_publicCategory' },
    { $match: { '_publicCategory.active': true, $or: [{ '_publicCategory.countries': { $size: 0 } }, { '_publicCategory.countries': country.code }] } },
    { $lookup: { from: 'stores', localField: 'storeId', foreignField: '_id', as: '_publicStore' } },
    { $unwind: '$_publicStore' },
    { $match: { '_publicStore.status': 'verified', '_publicStore.country': country.code, '_publicStore.currency': country.currency } },
    { $lookup: { from: 'brands', localField: 'brandId', foreignField: '_id', as: '_publicBrand' } },
    { $match: { $or: [{ brandId: null }, { '_publicBrand.status': 'approved' }] } },
    { $match: { $expr: { $or: [
      { $and: [{ $ne: ['$_publicCategory.restricted', true] }, { $ne: ['$moderation.riskLevel', 'high'] }, { $ne: ['$moderation.secondReviewRequired', true] }] },
      { $and: [
        { $eq: ['$moderation.secondReviewRequired', false] },
        { $ne: [{ $ifNull: ['$moderation.firstApprovalByUserId', null] }, null] },
        { $ne: [{ $ifNull: ['$moderation.reviewedByUserId', null] }, null] },
        { $ne: ['$moderation.firstApprovalByUserId', '$moderation.reviewedByUserId'] },
        { $ne: ['$moderation.firstApprovalByUserId', '$ownerUserId'] },
        { $ne: ['$moderation.reviewedByUserId', '$ownerUserId'] },
        { $ne: ['$moderation.firstApprovalByUserId', '$_publicStore.ownerUserId'] },
        { $ne: ['$moderation.reviewedByUserId', '$_publicStore.ownerUserId'] },
      ] },
    ] } } },
    { $lookup: {
      from: 'productvariants', let: { productId: '$_id', storeId: '$storeId' },
      pipeline: [{ $match: { active: true, currency: country.currency, priceMinor: { $gt: 0 }, $expr: { $and: [{ $eq: ['$productId', '$$productId'] }, { $eq: ['$storeId', '$$storeId'] }, { $eq: [{ $mod: ['$priceMinor', 1] }, 0] }] } } }, { $limit: 1 }, { $project: { _id: 1 } }],
      as: '_publicVariant',
    } },
    { $match: { '_publicVariant.0': { $exists: true } } },
  ];
}

async function eligibleProductCount(scope, country) {
  const [row] = await Product.aggregate([{ $match: scope }, ...publicEligibilityStages(country), { $count: 'count' }]);
  return row?.count || 0;
}

function currencyDigits(currency) {
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency,
    }).resolvedOptions().maximumFractionDigits;
  } catch {
    return 2;
  }
}

function majorUnits(value, currency) {
  return Number(value || 0) / 10 ** currencyDigits(currency);
}

function imageUrl(media, thumbnail = true) { return publicProductImageUrl(media, thumbnail); }

function productBadge(product, compareAtMinor, priceMinor) {
  if (compareAtMinor > priceMinor) return 'Deal';
  if (
    product.publishedAt &&
    Date.now() - new Date(product.publishedAt).getTime() < 30 * 86_400_000
  ) {
    return 'New Arrival';
  }
  return 'Available';
}

export function assembleStorefront({
  products,
  variants,
  media,
  stock,
  categories,
  brands,
  stores,
  productMetrics = [],
  brandMetrics = [],
  country,
}) {
  const categoryById = new Map(categories.map((item) => [key(item._id), item]));
  const brandById = new Map(brands.map((item) => [key(item._id), item]));
  const storeById = new Map(stores.map((item) => [key(item._id), item]));
  const metricsByProduct = new Map(productMetrics.map((item) => [key(item._id), item]));
  const variantsByProduct = new Map();
  const mediaByProduct = new Map();
  const stockByVariant = new Map(
    stock.map((item) => [key(item._id), Math.max(0, item.available || 0)]),
  );

  for (const variant of variants) {
    const productKey = key(variant.productId);
    const current = variantsByProduct.get(productKey) || [];
    current.push(variant);
    variantsByProduct.set(productKey, current);
  }
  for (const item of media) {
    const productKey = key(item.productId);
    const current = mediaByProduct.get(productKey) || [];
    current.push(item);
    mediaByProduct.set(productKey, current);
  }

  const normalizedProducts = [];
  for (const product of products) {
    const store = storeById.get(key(product.storeId));
    const category = categoryById.get(key(product.categoryId));
    const brand = brandById.get(key(product.brandId));
    if (!eligibleProduct(product, category, store, brand, country)) continue;
    const productVariants = (variantsByProduct.get(key(product._id)) || []).filter((variant) => variant.active === true
      && key(variant.storeId) === key(store._id) && variant.currency === country.currency
      && Number.isSafeInteger(variant.priceMinor) && variant.priceMinor > 0);
    const primaryVariant = productVariants[0];
    if (!primaryVariant) continue;

    const productMedia = mediaByProduct.get(key(product._id)) || [];
    const available = productVariants.reduce(
      (sum, variant) => sum + (stockByVariant.get(key(variant._id)) || 0),
      0,
    );
    const currency = primaryVariant.currency || store.currency;
    const price = majorUnits(primaryVariant.priceMinor, currency);
    const oldPrice = Math.max(
      price,
      majorUnits(primaryVariant.compareAtMinor, currency),
    );
    const metrics = metricsByProduct.get(key(product._id)) || { rating: 0, reviews: 0, sold: 0 };
    const publicVariants = productVariants.map((variant) => ({
      id: variant.publicId,
      title: variant.title,
      sku: variant.sku,
      barcode: variant.barcode || '',
      price: majorUnits(variant.priceMinor, variant.currency),
      oldPrice: Math.max(
        majorUnits(variant.priceMinor, variant.currency),
        majorUnits(variant.compareAtMinor, variant.currency),
      ),
      currency: variant.currency,
      stock: stockByVariant.get(key(variant._id)) || 0,
      weightGrams: variant.weightGrams || 0,
      options:
        variant.options instanceof Map
          ? Object.fromEntries(variant.options)
          : variant.options || {},
    }));
    normalizedProducts.push({
      id: product.publicId,
      name: product.title,
      subtitle:
        primaryVariant.title === 'Default'
          ? category.name
          : primaryVariant.title,
      description: product.description,
      videoUrl: product.videoUrl || '',
      category: category.slug,
      categoryName: category.name,
      brand: brand?.name || 'Independent',
      brandSlug: brand?.slug || '',
      image: imageUrl(productMedia[0]),
      images:
        productMedia.length > 0
          ? productMedia.map((item) => imageUrl(item, false))
          : ['/assets/product-placeholder.svg'],
      imageAlt: productMedia[0]?.altText || product.title,
      price,
      oldPrice,
      currency,
      badge: productBadge(
        product,
        primaryVariant.compareAtMinor,
        primaryVariant.priceMinor,
      ),
      stock: available,
      sku: primaryVariant.sku,
      barcode: primaryVariant.barcode || '',
      tags: product.tags || [],
      variantId: primaryVariant.publicId,
      variants: publicVariants,
      attributes:
        product.attributes instanceof Map
          ? Object.fromEntries(product.attributes)
          : product.attributes || {},
      rating: Number(metrics.rating || 0),
      reviews: Number(metrics.reviews || 0),
      sold: Number(metrics.sold || 0),
      publishedAt: product.publishedAt,
      qualityScore: Math.max(0, Math.min(100, Number(product.qualityScore) || 0)),
      policyVersion: String(country.policyVersion || ''),
      returnWindowDays: Math.max(0, Number(country.returnWindowDays) || 0),
      freeStandardShippingThreshold: majorUnits(country.freeStandardShippingThresholdMinor || 0, currency),
      deliveryOptions: {
        standardEnabled: country.delivery?.standardEnabled !== false,
        expressEnabled: Boolean(country.delivery?.expressEnabled),
        pickupEnabled: Boolean(country.delivery?.pickupEnabled),
        standardSlaHours: Math.max(1, Number(country.delivery?.defaultStandardSlaHours) || 72),
        expressSlaHours: Math.max(1, Number(country.delivery?.defaultExpressSlaHours) || 24),
      },
      paymentMethods: Object.entries(country.payments || {}).filter(([, enabled]) => Boolean(enabled)).map(([method]) => method),
      seller: {
        id: store.publicId,
        slug: store.slug,
        name: store.name,
        description: store.description,
        country: store.country,
        currency: store.currency,
        verified: store.status === 'verified',
        verifiedAt: store.verifiedAt || '',
      },
    });
  }

  const productCountByCategory = new Map();
  const categoryImage = new Map();
  for (const product of normalizedProducts) {
    productCountByCategory.set(
      product.category,
      (productCountByCategory.get(product.category) || 0) + 1,
    );
    if (!categoryImage.has(product.category)) {
      categoryImage.set(product.category, product.image);
    }
  }

  const publicCategories = categories.filter((category) => !category.restricted || productCountByCategory.has(category.slug)).map((category) => ({
    id: category.slug,
    publicId: category.publicId,
    name: category.name,
    note: category.description || `Shop ${category.name}`,
    image:
      categoryImage.get(category.slug) || '/assets/product-placeholder.svg',
    count: productCountByCategory.get(category.slug) || 0,
  }));

  const productCountByBrandId = new Map(
    brandMetrics.map((item) => [key(item._id), Number(item.count || 0)]),
  );
  if (!productCountByBrandId.size) {
    for (const product of normalizedProducts) {
      const brand = brands.find((item) => item.slug === product.brandSlug);
      if (!brand) continue;
      const brandId = key(brand._id);
      productCountByBrandId.set(
        brandId,
        (productCountByBrandId.get(brandId) || 0) + 1,
      );
    }
  }
  const publicBrands = brands
    .map((brand) => ({
      id: brand.slug,
      publicId: brand.publicId,
      name: brand.name,
      count: productCountByBrandId.get(key(brand._id)) || 0,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const sellerBySlug = new Map();
  for (const product of normalizedProducts) {
    const existing = sellerBySlug.get(product.seller.slug);
    if (existing) {
      existing.productCount += 1;
      if (existing.productImages.length < 4) {
        existing.productImages.push(product.image);
      }
      existing.categories.add(product.categoryName);
      existing.reviewScoreTotal += product.rating * product.reviews;
      existing.reviews += product.reviews;
      existing.sold += product.sold;
      continue;
    }
    sellerBySlug.set(product.seller.slug, {
      ...product.seller,
      image: product.image,
      productImages: [product.image],
      productCount: 1,
      categories: new Set([product.categoryName]),
      reviewScoreTotal: product.rating * product.reviews,
      reviews: product.reviews,
      sold: product.sold,
      followed: false,
    });
  }
  const sellers = [...sellerBySlug.values()].map((seller) => ({
    ...seller,
    categories: [...seller.categories],
    rating: seller.reviews ? Number((seller.reviewScoreTotal / seller.reviews).toFixed(2)) : 0,
    reviewScoreTotal: undefined,
  }));

  return {
    country: {
      code: country.code,
      name: country.name,
      currency: country.currency,
      locale: country.locale,
    },
    products: normalizedProducts,
    categories: publicCategories,
    brands: publicBrands,
    sellers,
    generatedAt: new Date().toISOString(),
  };
}

export async function fulfillableStockAvailability(variants, countryCode, { session = null } = {}) {
  const variantIds = variants.map((variant) => variant._id);
  if (!variantIds.length) return [];
  const aggregate = StockItem.aggregate([
    { $match: { variantId: { $in: variantIds } } },
    { $lookup: { from: 'warehouses', localField: 'warehouseId', foreignField: '_id', as: 'warehouse' } },
    { $unwind: '$warehouse' },
    { $match: { 'warehouse.active': true, 'warehouse.country': countryCode, $expr: { $eq: ['$warehouse.storeId', '$storeId'] } } },
    { $lookup: { from: 'productvariants', localField: 'variantId', foreignField: '_id', as: 'variant' } },
    { $unwind: '$variant' },
    { $match: { 'variant.active': true, $expr: { $eq: ['$variant.storeId', '$storeId'] } } },
    {
      $group: {
        _id: '$variantId',
        available: {
          // A checkout line is reserved in one warehouse; separate warehouses cannot fulfill one line together.
          $max: { $max: [0, { $subtract: ['$onHand', { $add: ['$reserved', '$damaged', '$quarantined'] }] }] },
        },
      },
    },
  ]);
  if (session) aggregate.session(session);
  return aggregate;
}

async function hydrateProducts(products, country, { brandMetrics = [] } = {}) {
  const productIds = products.map((product) => product._id);
  if (!productIds.length) {
    const categories = await Category.find({
      active: true,
      $or: [{ countries: mongoose.trusted({ $size: 0 }) }, { countries: country.code }],
    })
      .sort({ name: 1 })
      .lean();
    return assembleStorefront({
      products: [],
      variants: [],
      media: [],
      stock: [],
      categories,
      brands: [],
      stores: [],
      productMetrics: [],
      country,
    });
  }

  const [variants, media] = await Promise.all([
    ProductVariant.find({ productId: mongoose.trusted({ $in: productIds }), active: true })
      .sort({ productId: 1, priceMinor: 1, _id: 1 })
      .lean(),
    ProductMedia.find({
      productId: mongoose.trusted({ $in: productIds }),
      status: 'approved',
    })
      .sort({ productId: 1, position: 1, createdAt: 1 })
      .lean(),
  ]);
  const [stock, categories, brands, stores, reviewMetrics, salesMetrics] = await Promise.all([
    fulfillableStockAvailability(variants, country.code),
    Category.find({
      active: true,
      $or: [{ countries: mongoose.trusted({ $size: 0 }) }, { countries: country.code }],
    })
      .sort({ name: 1 })
      .lean(),
    Brand.find({ status: 'approved' }).sort({ name: 1 }).lean(),
    Store.find({
      _id: mongoose.trusted({ $in: products.map((product) => product.storeId) }),
      status: 'verified',
      country: country.code,
      currency: country.currency,
    }).lean(),
    Review.aggregate([
      { $match: { productId: { $in: productIds }, status: 'published', verifiedPurchase: true } },
      { $group: { _id: '$productId', reviews: { $sum: 1 }, rating: { $avg: '$rating' } } },
    ]),
    Order.aggregate([
      { $match: { country: country.code, status: { $in: ['confirmed', 'paid', 'partially_refunded'] } } },
      { $unwind: '$items' },
      { $match: { 'items.productId': { $in: productIds } } },
      { $group: { _id: '$items.productId', sold: { $sum: '$items.quantity' } } },
    ]),
  ]);
  const metricMap = new Map();
  for (const row of reviewMetrics) metricMap.set(key(row._id), { _id: row._id, reviews: row.reviews || 0, rating: Number((row.rating || 0).toFixed(2)), sold: 0 });
  for (const row of salesMetrics) {
    const current = metricMap.get(key(row._id)) || { _id: row._id, reviews: 0, rating: 0, sold: 0 };
    current.sold = row.sold || 0;
    metricMap.set(key(row._id), current);
  }

  return assembleStorefront({
    products,
    variants,
    media,
    stock,
    categories,
    brands,
    stores,
    productMetrics: [...metricMap.values()],
    brandMetrics,
    country,
  });
}

async function loadStorefront(country) {
  const [products, brandMetrics] = await Promise.all([
    Product.find({
      status: 'published',
      countries: country.code,
    })
      .sort({ publishedAt: -1, _id: -1 })
      .limit(MAX_PRODUCTS)
      .lean(),
    Product.aggregate([
      { $match: { status: 'published', countries: country.code, brandId: { $ne: null } } },
      ...publicEligibilityStages(country),
      { $group: { _id: '$brandId', count: { $sum: 1 } } },
    ]),
  ]);
  return hydrateProducts(products, country, { brandMetrics });
}

async function refreshStorefrontCache(country) {
  const cacheKey = country.code;
  const current = cache.get(cacheKey);
  if (current?.promise) return current.promise;
  const generation = cacheGeneration;
  const promise = loadStorefront(country);
  cache.set(cacheKey, { ...current, promise });
  try {
    const value = await promise;
    if (generation === cacheGeneration) {
      const now = Date.now();
      cache.set(cacheKey, {
        value,
        expiresAt: now + CACHE_TTL_MS,
        staleUntil: now + STALE_CACHE_TTL_MS,
        promise: null,
      });
    }
    return value;
  } catch (error) {
    if (current?.value) cache.set(cacheKey, { ...current, promise: null });
    else cache.delete(cacheKey);
    throw error;
  }
}

export async function getStorefront(country) {
  const cacheKey = country.code;
  const current = cache.get(cacheKey);
  const now = Date.now();
  if (current?.value && current.expiresAt > now) return current.value;
  if (current?.value && current.staleUntil > now) {
    void refreshStorefrontCache(country).catch(() => {});
    return current.value;
  }
  return refreshStorefrontCache(country);
}

export async function searchStorefront(
  country,
  { query = '', category = '', brand = '', seller = '' } = {},
) {
  const trimmedQuery = String(query || '').trim().slice(0, 120);
  const base = { status: 'published', countries: country.code };

  if (category) {
    const row = await Category.findOne({ slug: category, active: true, $or: [{ countries: mongoose.trusted({ $size: 0 }) }, { countries: country.code }] }).select('_id').lean();
    if (!row) return hydrateProducts([], country);
    base.categoryId = row._id;
  }
  if (brand) {
    const row = await Brand.findOne({ slug: brand, status: 'approved' }).select('_id').lean();
    if (!row) return hydrateProducts([], country);
    base.brandId = row._id;
  }
  if (seller) {
    const row = await Store.findOne({ slug: seller, status: 'verified', country: country.code, currency: country.currency }).select('_id').lean();
    if (!row) return hydrateProducts([], country);
    base.storeId = row._id;
  }

  let products = [];
  let totalResults = 0;
  if (!trimmedQuery) {
    [products, totalResults] = await Promise.all([
      Product.find(base).sort({ publishedAt: -1, _id: -1 }).limit(80).lean(),
      eligibleProductCount(base, country),
    ]);
  } else {
    const normalize = (value) => String(value || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
    const synonyms = new Map([
      ['phone', ['smartphone', 'mobile']], ['mobile', ['phone', 'smartphone']],
      ['tv', ['television']], ['television', ['tv']], ['sneakers', ['shoes']], ['shoes', ['sneakers']],
      ['fridge', ['refrigerator']], ['refrigerator', ['fridge']], ['laptop', ['notebook']], ['notebook', ['laptop']],
    ]);
    const tokens = normalize(trimmedQuery).split(' ').filter(Boolean).slice(0, 8);
    const expanded = new Set(tokens);
    for (const token of tokens) for (const synonym of synonyms.get(token) || []) expanded.add(synonym);
    const textQuery = [...expanded].join(' ');
    const textFilter = { ...base, $text: { $search: textQuery || trimmedQuery } };

    let textRows = [];
    try {
      [textRows, totalResults] = await Promise.all([
        Product.find(textFilter, { score: { $meta: 'textScore' } }).sort({ score: { $meta: 'textScore' }, publishedAt: -1 }).limit(120).lean(),
        eligibleProductCount(textFilter, country),
      ]);
    } catch {
      // Text indexes can be unavailable briefly during first-start index creation.
      textRows = [];
      totalResults = 0;
    }

    const escaped = trimmedQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const exactVariantRows = await ProductVariant.find({ active: true, $or: [{ sku: new RegExp(`^${escaped}$`, 'i') }, { barcode: new RegExp(`^${escaped}$`, 'i') }] }).select('productId').limit(40).lean();
    const exactIds = [...new Set(exactVariantRows.map((row) => key(row.productId)))].map((id) => new mongoose.Types.ObjectId(id));
    let identifierProducts = [];
    if (exactIds.length) identifierProducts = await Product.find({ ...base, _id: mongoose.trusted({ $in: exactIds }) }).limit(40).lean();

    const combined = new Map();
    for (const row of identifierProducts) combined.set(key(row._id), { ...row, _searchScore: 10_000 });
    for (const row of textRows) if (!combined.has(key(row._id))) combined.set(key(row._id), { ...row, _searchScore: Number(row.score || 0) });

    // Bounded typo recovery is used only when the indexed search produced no candidates.
    if (!combined.size && tokens.length) {
      const prefix = tokens[0].slice(0, Math.max(2, tokens[0].length - 1)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const fallbackScope = { ...base, title: new RegExp(prefix, 'i') };
      const fallbackRows = await Product.find(fallbackScope).sort({ publishedAt: -1 }).limit(80).lean();
      for (const row of fallbackRows) combined.set(key(row._id), { ...row, _searchScore: 1 });
      totalResults = await eligibleProductCount(fallbackScope, country);
    }
    products = [...combined.values()].sort((a, b) => Number(b._searchScore || 0) - Number(a._searchScore || 0) || new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0)).slice(0, 80);
  }

  const hydrated = await hydrateProducts(products, country);
  // Exact-identifier matches may add public products outside the full-text results.
  totalResults = Math.max(totalResults, hydrated.products.length);
  return { ...hydrated, totalResults, generatedAt: new Date().toISOString() };
}

export function clearStorefrontCache() {
  cacheGeneration += 1;
  cache.clear();
}

export async function publishedProductsByPublicIds(publicIds, country) {
  const ids = [...new Set((publicIds || []).map((value) => String(value)).filter(Boolean))].slice(0, 200);
  if (!ids.length) return [];
  const products = await Product.find({ publicId: mongoose.trusted({ $in: ids }), status: 'published', countries: country.code }).lean();
  const hydrated = await hydrateProducts(products, country);
  const byId = new Map(hydrated.products.map((product) => [product.id, product]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

export async function publishedProduct(publicId, country) {
  return (await publishedProductsByPublicIds([publicId], country))[0] || null;
}

export async function publishedSellers(country, { after = '', limit = 50 } = {}) {
  const pageSize=Math.min(Math.max(Number(limit)||50,10),100),countryCode=country.code;
  const cursor=decodeCursor(after,{type:'date'});
  const common=[
    {$match:{status:'verified',country:countryCode,currency:country.currency}},
    {$lookup:{from:'products',let:{storeId:'$_id'},pipeline:[{$match:{status:'published',countries:countryCode,$expr:{$eq:['$storeId','$$storeId']}}},...publicEligibilityStages(country),{$count:'count'}],as:'productStats'}},
    {$set:{productCount:{$ifNull:[{$arrayElemAt:['$productStats.count',0]},0]}}},
    {$match:{productCount:{$gt:0}}},
  ];
  const itemPipeline=[];
  if(cursor)itemPipeline.push({$match:{$or:[{createdAt:{$lt:cursor.value}},{createdAt:cursor.value,_id:{$lt:cursor.id}}]}});
  itemPipeline.push({$sort:{createdAt:-1,_id:-1}},{$limit:pageSize+1});
  const [facet]=await Store.aggregate([...common,{$facet:{items:itemPipeline,total:[{$count:'count'}]}}]);
  const stores=facet?.items||[],total=facet?.total?.[0]?.count||0;
  const rawPage=pageResult(stores,{field:'createdAt',direction:-1,type:'date',limit:pageSize,total});
  if(!rawPage.items.length)return {items:[],page:rawPage.page};
  const storeIds=rawPage.items.map(store=>store._id);
  const sampleProducts=await Product.find({storeId:mongoose.trusted({$in:storeIds}),status:'published',countries:countryCode}).sort({publishedAt:-1}).limit(Math.min(800,storeIds.length*8)).lean();
  const hydrated=await hydrateProducts(sampleProducts,country),derivedBySlug=new Map(hydrated.sellers.map(seller=>[seller.slug,seller]));
  const items=rawPage.items.map(store=>{const derived=derivedBySlug.get(store.slug);return{id:store.publicId,slug:store.slug,name:store.name,description:store.description,country:store.country,currency:store.currency,verified:true,image:derived?.image||'/assets/product-placeholder.svg',productImages:derived?.productImages||[],productCount:Number(store.productCount||0),categories:derived?.categories||[],rating:derived?.rating||0,reviews:derived?.reviews||0,sold:derived?.sold||0,followed:false};});
  return {items,page:rawPage.page};
}

export async function publishedSeller(slug, country, { after = '', limit = 50 } = {}) {
  const store=await Store.findOne({slug:String(slug),status:'verified',country:country.code,currency:country.currency}).lean();
  if(!store)return null;
  const base={storeId:store._id,status:'published',countries:country.code},pageSize=Math.min(Math.max(Number(limit)||50,10),100);
  const [rows,total]=await Promise.all([
    Product.aggregate([{$match:cursorScope(base,after,{field:'publishedAt',direction:-1,type:'date'})},...publicEligibilityStages(country),{$sort:{publishedAt:-1,_id:-1}},{$limit:pageSize+1}]),
    eligibleProductCount(base, country),
  ]);
  if(!total)return null;
  const productPage=pageResult(rows,{field:'publishedAt',direction:-1,type:'date',limit:pageSize,total});
  const hydrated=await hydrateProducts(productPage.items,country);
  const seller=hydrated.sellers.find(item=>item.slug===store.slug)||{id:store.publicId,slug:store.slug,name:store.name,description:store.description,country:store.country,currency:store.currency,verified:true,image:'/assets/product-placeholder.svg',productImages:[],productCount:total,categories:[],rating:0,reviews:0,sold:0};
  return {...seller,productCount:total,products:hydrated.products,productPage:productPage.page};
}

export async function publicIdsForMongoIds(productIds) {
  if (!productIds?.length) return [];
  const products = await Product.find(
    { _id: mongoose.trusted({ $in: productIds }) },
    { _id: 1, publicId: 1 },
  ).lean();
  const byId = new Map(products.map((product) => [key(product._id), product.publicId]));
  return productIds.map((id) => byId.get(key(id))).filter(Boolean);
}
