import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { publicId } from '../core/ids.js';
import { randomToken } from '../core/crypto.js';
import { AppError } from '../core/errors.js';
import { requireAuth, requireVerified, requirePermission } from '../middleware/auth.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import {
  CustomerCatalogueState,
  Product,
  ProductAlert,
  ProductQuestion,
  PromoterContactRequest,
  PromoterVerification,
  Review,
  SearchEvent,
  SellerContactRequest,
  Store,
  StoreMember,
  User,
} from '../models/index.js';
import {
  getStorefront,
  publicIdsForMongoIds,
  publishedProduct,
  publishedProductsByPublicIds,
  publishedSeller,
  publishedSellers,
  searchStorefront,
} from '../services/storefront.js';
import { hybridSearch, recommendationsFor } from '../services/ai.js';
import { activeSponsoredProducts } from '../services/seller-growth.js';
import { publicPromoter, publicPromoters } from '../services/promoters.js';
import { scanUpload } from '../services/malware.js';
import { visualSearchProducts } from '../services/visual-search.js';
import { cursorScope, pageResult } from '../services/pagination.js';

const router = Router();

const visualSearchLimit = rateLimit({
  windowMs: 15 * 60_000,
  limit: 12,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});

const visualSearchUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024, files: 1, fields: 2, fieldArrayIndexLimit: 16 },
  fileFilter(_request, file, callback) {
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/avif'].includes(file.mimetype)) {
      return callback(new AppError('Upload a JPEG, PNG, WebP or AVIF image.', 422, 'VISUAL_SEARCH_TYPE_INVALID'));
    }
    return callback(null, true);
  },
}).single('image');


function decoratePromotedProduct(product, offer) {
  if (!offer) return product;
  return {
    ...product,
    sponsored: Boolean(offer.sponsored),
    sponsoredDisclosure: offer.disclosure,
    promoterCommissionBps: Number(offer.promoterCommissionBps) || 0,
    promoterCampaignId: offer.promoterCampaignId || '',
  };
}

async function withSponsored(catalogue, countryCode) {
  const sponsored = await activeSponsoredProducts(countryCode, (catalogue.products || []).map((product) => product.id));
  return {
    ...catalogue,
    products: (catalogue.products || []).map((product) => decoratePromotedProduct(product, sponsored.get(product.id))),
  };
}


const contactSchema = z.object({
  subject: z.string().trim().min(3).max(160),
  message: z.string().trim().min(10).max(2_000),
});
const searchSchema = z.object({
  q: z.string().trim().max(120).optional().default(''),
  category: z.string().trim().regex(/^[a-z0-9-]{0,100}$/).optional().default(''),
  brand: z.string().trim().regex(/^[a-z0-9-]{0,100}$/).optional().default(''),
  seller: z.string().trim().regex(/^[a-z0-9-]{0,100}$/).optional().default(''),
});

const alertSchema = z.object({ type: z.enum(['price_drop','restock']), targetPriceMinor: z.coerce.number().int().min(0).optional() });
const questionSchema = z.object({ question: z.string().trim().min(5).max(1000) });
const answerSchema = z.object({ answer: z.string().trim().min(2).max(2000) });

function browsingSessionKey(request) {
  if (!request.session.catalogueKey) request.session.catalogueKey = publicId('browse');
  return request.session.catalogueKey;
}

async function stateFor(userId) {
  return CustomerCatalogueState.findOneAndUpdate(
    { userId },
    { $setOnInsert: { userId } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  );
}

async function statePayload(userId, country, includeProducts = false) {
  if (!userId) {
    return {
      wishlist: [],
      comparison: [],
      recent: [],
      followedStores: [],
    };
  }
  const state =
    (await CustomerCatalogueState.findOne({ userId })) ||
    {
      wishlistProductIds: [],
      comparisonProductIds: [],
      recentProducts: [],
      followedStoreIds: [],
    };
  const [wishlist, comparison, recent] = await Promise.all([
    publicIdsForMongoIds(state.wishlistProductIds),
    publicIdsForMongoIds(state.comparisonProductIds),
    publicIdsForMongoIds(state.recentProducts.map((item) => item.productId)),
  ]);
  const followed = await Store.find(
    { _id: { $in: state.followedStoreIds }, status: 'verified' },
    { slug: 1 },
  ).lean();
  const requestedIds = [...new Set([...wishlist, ...comparison, ...recent])];
  const availableProducts = await publishedProductsByPublicIds(requestedIds, country);
  const availableProductIds = new Set(availableProducts.map((product) => product.id));
  const payload = {
    wishlist: wishlist.filter((id) => availableProductIds.has(id)),
    comparison: comparison.filter((id) => availableProductIds.has(id)),
    recent: recent.filter((id) => availableProductIds.has(id)),
    followedStores: followed.map((store) => store.slug),
  };
  if (!includeProducts) return payload;

  const byId = new Map(availableProducts.map((product) => [product.id, product]));
  const catalogue = await getStorefront(country);
  return {
    ...payload,
    wishlistProducts: payload.wishlist.map((id) => byId.get(id)).filter(Boolean),
    comparisonProducts: payload.comparison.map((id) => byId.get(id)).filter(Boolean),
    recentProducts: payload.recent.map((id) => byId.get(id)).filter(Boolean),
    recommendations: catalogue.products.filter((product) => !payload.wishlist.includes(product.id)).slice(0, 8),
  };
}

async function resolveProduct(request) {
  const publicProduct = await publishedProduct(
    request.params.productId,
    request.country,
  );
  if (!publicProduct) {
    throw new AppError('Product not found.', 404, 'PRODUCT_NOT_FOUND');
  }
  const product = await Product.findOne({
    publicId: publicProduct.id,
    status: 'published',
    countries: request.country.code,
  });
  if (!product) {
    throw new AppError('Product not found.', 404, 'PRODUCT_NOT_FOUND');
  }
  return { product, publicProduct };
}


router.get('/api/v1/storefront/action-token', (request, response) => {
  if (!request.session.csrfToken) request.session.csrfToken = randomToken();
  response.set('Cache-Control', 'no-store');
  response.json({ csrfToken: request.session.csrfToken });
});

router.post('/api/v1/storefront/search-by-image', visualSearchLimit, visualSearchUpload, async (request, response, next) => {
  try {
    verifyDeferredCsrf(request);
    if (!request.file?.buffer) throw new AppError('Choose a product image.', 422, 'VISUAL_SEARCH_IMAGE_REQUIRED');
    await scanUpload(request.file.buffer);
    const products = await visualSearchProducts(request.country, request.file.buffer, { limit: 24 });
    const transferResults = request.body?.transfer === '1';
    if (transferResults) {
      request.session.visualSearch = {
        country: request.country.code,
        createdAt: Date.now(),
        productIds: products.map((product) => product.id).filter(Boolean).slice(0, 24),
      };
      await new Promise((resolve, reject) => request.session.save((error) => error ? reject(error) : resolve()));
    }
    response.set('Cache-Control', 'private, no-store');
    response.json({ products, count: products.length, visualSearchReady: transferResults });
  } catch (error) { next(error); }
});

router.get('/api/v1/storefront/visual-search-results', async (request, response, next) => {
  try {
    const saved = request.session.visualSearch;
    delete request.session.visualSearch;
    const isFresh = saved
      && saved.country === request.country.code
      && Array.isArray(saved.productIds)
      && Date.now() - Number(saved.createdAt || 0) <= 10 * 60_000;
    if (!isFresh) {
      response.set('Cache-Control', 'private, no-store');
      return response.json({ products: [], count: 0 });
    }
    const baseProducts = await publishedProductsByPublicIds(saved.productIds, request.country);
    const sponsored = await activeSponsoredProducts(request.country.code, baseProducts.map((product) => product.id));
    const products = baseProducts.map((product) => decoratePromotedProduct(product, sponsored.get(product.id)));
    response.set('Cache-Control', 'private, no-store');
    return response.json({ products, count: products.length });
  } catch (error) { return next(error); }
});

router.get('/api/v1/storefront/catalogue', async (request, response, next) => {
  try {
    const [catalogue, customerState] = await Promise.all([
      getStorefront(request.country).then((catalogue) => withSponsored(catalogue, request.country.code)),
      statePayload(request.user?._id, request.country),
    ]);
    if (request.user) response.set('Cache-Control', 'private, no-store');
    else response.set('Cache-Control', 'public, max-age=10, stale-while-revalidate=30');
    response.json({
      ...catalogue,
      state: customerState,
      csrfToken: request.user ? request.session.csrfToken : null,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/api/v1/storefront/search', async (request, response, next) => {
  try {
    const input = searchSchema.parse(request.query);
    const [catalogue, customerState] = await Promise.all([
      input.q ? hybridSearch(request.country, {
        query: input.q,
        category: input.category,
        brand: input.brand,
        seller: input.seller,
        limit: 80,
      }).then((catalogue) => withSponsored(catalogue, request.country.code)) : searchStorefront(request.country, {
        query: input.q,
        category: input.category,
        brand: input.brand,
        seller: input.seller,
      }).then((catalogue) => withSponsored(catalogue, request.country.code)),
      statePayload(request.user?._id, request.country),
    ]);
    if (!request.session.csrfToken) request.session.csrfToken = randomToken();
    const searchEvent = await SearchEvent.create({
      publicId: publicId('sea'), sessionKey: browsingSessionKey(request), userId: request.user?._id,
      country: request.country.code, query: input.q, category: input.category, brand: input.brand, seller: input.seller,
      resultCount: catalogue.products.length, zeroResult: catalogue.products.length === 0,
    });
    response.set(
      'Cache-Control',
      request.user ? 'private, no-store' : 'public, max-age=10',
    );
    response.json({
      ...catalogue,
      state: customerState,
      csrfToken: request.session.csrfToken,
      searchId: searchEvent.publicId,
    });
  } catch (error) {
    next(error);
  }
});

router.get(
  '/api/v1/storefront/products/:productId',
  async (request, response, next) => {
    try {
      const product = await publishedProduct(
        request.params.productId,
        request.country,
      );
      if (!product) {
        throw new AppError('Product not found.', 404, 'PRODUCT_NOT_FOUND');
      }
      const mongoProduct = await Product.findOne({ publicId: product.id, status: 'published', countries: request.country.code }).select('_id').lean();
      let reviewPage={items:[],page:{count:0,total:0,hasMore:false,next:''}},questionPage={items:[],page:{count:0,total:0,hasMore:false,next:''}},ratingDistribution={1:0,2:0,3:0,4:0,5:0};
      if(mongoProduct){
        const reviewBase={productId:mongoProduct._id,country:request.country.code,status:'published',verifiedPurchase:true},questionBase={productId:mongoProduct._id,country:request.country.code,status:'answered'},initialLimit=4;
        const [reviewRows,reviewTotal,questionRows,questionTotal,ratingRows]=await Promise.all([
          Review.find(reviewBase).select('publicId rating title body verifiedPurchase publishedAt').sort({publishedAt:-1,_id:-1}).limit(initialLimit+1).lean(),
          Review.countDocuments(reviewBase),
          ProductQuestion.find(questionBase).select('publicId question answer createdAt').sort({createdAt:-1,_id:-1}).limit(initialLimit+1).lean(),
          ProductQuestion.countDocuments(questionBase),
          Review.aggregate([{$match:reviewBase},{$group:{_id:'$rating',count:{$sum:1}}}]),
        ]);
        reviewPage=pageResult(reviewRows,{field:'publishedAt',limit:initialLimit,total:reviewTotal});
        questionPage=pageResult(questionRows,{limit:initialLimit,total:questionTotal});
        ratingDistribution=Object.fromEntries([1,2,3,4,5].map((rating)=>[rating,Number(ratingRows.find((row)=>Number(row._id)===rating)?.count||0)]));
      }
      response.set('Cache-Control', 'public, max-age=10, stale-while-revalidate=30');
      const sponsored = await activeSponsoredProducts(request.country.code, [product.id]); response.json({ product: { ...decoratePromotedProduct(product, sponsored.get(product.id)), reviewItems: reviewPage.items, questions: questionPage.items, reviewPage:reviewPage.page, questionPage:questionPage.page, ratingDistribution } });
    } catch (error) {
      next(error);
    }
  },
);

router.get('/api/v1/storefront/sellers', async (request, response, next) => {
  try {
    const sellerPage = await publishedSellers(request.country,{after:request.query.after,limit:request.query.limit});
    const sellers = sellerPage.items;
    const followed = request.user
      ? new Set(
          (await statePayload(request.user._id, request.country)).followedStores,
        )
      : new Set();
    response.set(
      'Cache-Control',
      request.user ? 'private, no-store' : 'public, max-age=10',
    );
    response.json({
      sellers: sellers.map((seller) => ({
        ...seller,
        followed: followed.has(seller.slug),
      })),
      csrfToken: request.user ? request.session.csrfToken : null,
      page: sellerPage.page,
    });
  } catch (error) {
    next(error);
  }
});

router.get(
  '/api/v1/storefront/sellers/:slug',
  async (request, response, next) => {
    try {
      const seller = await publishedSeller(request.params.slug, request.country,{after:request.query.after,limit:request.query.limit});
      if (!seller) {
        throw new AppError('Seller not found.', 404, 'SELLER_NOT_FOUND');
      }
      const followed = request.user
        ? (
            await statePayload(request.user._id, request.country)
          ).followedStores.includes(seller.slug)
        : false;
      response.set(
        'Cache-Control',
        request.user ? 'private, no-store' : 'public, max-age=10',
      );
      response.json({
        seller: { ...seller, followed },
        csrfToken: request.user ? request.session.csrfToken : null,
        features: request.features || {},
      });
    } catch (error) {
      next(error);
    }
  },
);



router.get('/api/v1/storefront/promoters', async (request, response, next) => {
  try {
    const promoterPage = await publicPromoters(request.country,{after:request.query.after,limit:request.query.limit});
    const rows = promoterPage.items;
    const state = request.user ? await stateFor(request.user._id) : null;
    const followed = new Set((state?.followedPromoterUserIds || []).map(String));
    const promoters = rows.map(({ userMongoId, earnedMinor, ...row }) => ({ ...row, followed: followed.has(userMongoId) }));
    response.set('Cache-Control', request.user ? 'private, no-store' : 'public, max-age=10');
    response.json({ promoters, csrfToken: request.user ? request.session.csrfToken : null, page: promoterPage.page });
  } catch (error) { next(error); }
});

router.get('/api/v1/storefront/promoters/:id', async (request, response, next) => {
  try {
    const row = await publicPromoter(request.params.id, request.country);
    if (!row) throw new AppError('Promoter not found.', 404, 'PROMOTER_NOT_FOUND');
    const state = request.user ? await stateFor(request.user._id) : null;
    const followed = (state?.followedPromoterUserIds || []).some((id) => String(id) === row.userMongoId);
    const { userMongoId, earnedMinor, ...promoter } = row;
    response.set('Cache-Control', request.user ? 'private, no-store' : 'public, max-age=10');
    response.json({ promoter: { ...promoter, followed }, csrfToken: request.user ? request.session.csrfToken : null });
  } catch (error) { next(error); }
});

router.post('/api/v1/storefront/promoters/:id/follow', requireAuth, async (request, response, next) => {
  try {
    const verification = await PromoterVerification.findOne({ publicId: request.params.id, country: request.country.code, status: 'verified' }).lean();
    if (!verification || !(await User.exists({ _id: verification.userId, role: 'promoter', status: 'active', country: request.country.code }))) throw new AppError('Promoter not found.', 404, 'PROMOTER_NOT_FOUND');
    const state = await stateFor(request.user._id);
    if (!(state.followedPromoterUserIds || []).some((id) => id.equals(verification.userId))) {
      if ((state.followedPromoterUserIds || []).length >= 100) throw new AppError('You have reached the followed-promoter limit.', 409, 'FOLLOW_LIMIT');
      state.followedPromoterUserIds = state.followedPromoterUserIds || [];
      state.followedPromoterUserIds.push(verification.userId);
      await state.save();
    }
    response.status(201).json({ followed: true });
  } catch (error) { next(error); }
});

router.delete('/api/v1/storefront/promoters/:id/follow', requireAuth, async (request, response, next) => {
  try {
    const verification = await PromoterVerification.findOne({ publicId: request.params.id, country: request.country.code, status: 'verified' }).lean();
    if (!verification) throw new AppError('Promoter not found.', 404, 'PROMOTER_NOT_FOUND');
    const state = await stateFor(request.user._id);
    state.followedPromoterUserIds = (state.followedPromoterUserIds || []).filter((id) => !id.equals(verification.userId));
    await state.save();
    response.json({ followed: false });
  } catch (error) { next(error); }
});

router.post('/api/v1/storefront/promoters/:id/contact', requireAuth, async (request, response, next) => {
  try {
    const input = contactSchema.parse(request.body);
    const verification = await PromoterVerification.findOne({ publicId: request.params.id, country: request.country.code, status: 'verified' }).lean();
    if (!verification || !(await User.exists({ _id: verification.userId, role: 'promoter', status: 'active' }))) throw new AppError('Promoter not found.', 404, 'PROMOTER_NOT_FOUND');
    if (verification.userId.equals(request.user._id)) throw new AppError('You cannot message your own promoter profile.', 409, 'SELF_CONTACT_BLOCKED');
    const duplicate = await PromoterContactRequest.exists({ customerUserId: request.user._id, promoterUserId: verification.userId, createdAt: { $gte: new Date(Date.now() - 60_000) } });
    if (duplicate) throw new AppError('Please wait before sending another message.', 429, 'CONTACT_RATE_LIMIT');
    const contact = await PromoterContactRequest.create({ publicId: publicId('pcontact'), customerUserId: request.user._id, promoterUserId: verification.userId, promoterVerificationId: verification._id, country: request.country.code, subject: input.subject, message: input.message });
    response.status(201).json({ request: { id: contact.publicId, status: contact.status } });
  } catch (error) { next(error); }
});

router.get(
  '/api/v1/storefront/state',
  async (request, response, next) => {
    try {
      response.set('Cache-Control', request.user ? 'private, no-store' : 'public, max-age=10');
      const baseState = request.user
        ? await statePayload(request.user._id, request.country, true)
        : { wishlist: [], comparison: [], recent: [], followedStores: [], wishlistProducts: [], comparisonProducts: [], recentProducts: [], recommendations: [] };
      if (request.user) {
        baseState.recommendations = await recommendationsFor(request, { limit: 8 });
      }
      response.json({
        authenticated: Boolean(request.user),
        state: baseState,
        csrfToken: request.user ? request.session.csrfToken : null,
        features: request.features || {},
      });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/api/v1/storefront/wishlist/:productId',
  requireAuth,
  async (request, response, next) => {
    try {
      const { product } = await resolveProduct(request);
      const state = await stateFor(request.user._id);
      if (
        !state.wishlistProductIds.some((id) => id.equals(product._id))
      ) {
        if (state.wishlistProductIds.length >= 500) {
          throw new AppError(
            'Your wishlist is full.',
            409,
            'WISHLIST_LIMIT',
          );
        }
        state.wishlistProductIds.push(product._id);
        await state.save();
      }
      response.status(201).json({
        wishlist: await publicIdsForMongoIds(state.wishlistProductIds),
      });
    } catch (error) {
      next(error);
    }
  },
);

router.delete(
  '/api/v1/storefront/wishlist/:productId',
  requireAuth,
  async (request, response, next) => {
    try {
      const { product } = await resolveProduct(request);
      const state = await stateFor(request.user._id);
      state.wishlistProductIds = state.wishlistProductIds.filter(
        (id) => !id.equals(product._id),
      );
      await state.save();
      response.json({
        wishlist: await publicIdsForMongoIds(state.wishlistProductIds),
      });
    } catch (error) {
      next(error);
    }
  },
);

router.delete(
  '/api/v1/storefront/wishlist',
  requireAuth,
  async (request, response, next) => {
    try {
      const state = await stateFor(request.user._id);
      state.wishlistProductIds = [];
      await state.save();
      response.json({ wishlist: [] });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/api/v1/storefront/comparison/:productId',
  requireAuth,
  async (request, response, next) => {
    try {
      const { product } = await resolveProduct(request);
      const state = await stateFor(request.user._id);
      if (!state.comparisonProductIds.some((id) => id.equals(product._id))) {
        if (state.comparisonProductIds.length >= 4) {
          throw new AppError(
            'You can compare up to four products.',
            409,
            'COMPARISON_LIMIT',
          );
        }
        state.comparisonProductIds.push(product._id);
        await state.save();
      }
      response.status(201).json({
        comparison: await publicIdsForMongoIds(state.comparisonProductIds),
      });
    } catch (error) {
      next(error);
    }
  },
);

router.delete(
  '/api/v1/storefront/comparison/:productId',
  requireAuth,
  async (request, response, next) => {
    try {
      const { product } = await resolveProduct(request);
      const state = await stateFor(request.user._id);
      state.comparisonProductIds = state.comparisonProductIds.filter(
        (id) => !id.equals(product._id),
      );
      await state.save();
      response.json({
        comparison: await publicIdsForMongoIds(state.comparisonProductIds),
      });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/api/v1/storefront/recent/:productId',
  requireAuth,
  async (request, response, next) => {
    try {
      const { product } = await resolveProduct(request);
      const state = await stateFor(request.user._id);
      state.recentProducts = state.recentProducts.filter(
        (item) => !item.productId.equals(product._id),
      );
      state.recentProducts.unshift({
        productId: product._id,
        viewedAt: new Date(),
      });
      state.recentProducts = state.recentProducts.slice(0, 50);
      await state.save();
      response.status(201).json({ recorded: true });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/api/v1/storefront/follow/:slug',
  requireAuth,
  async (request, response, next) => {
    try {
      const seller = await publishedSeller(request.params.slug, request.country);
      if (!seller) {
        throw new AppError('Seller not found.', 404, 'SELLER_NOT_FOUND');
      }
      const store = await Store.findOne({ slug: seller.slug, status: 'verified' });
      if (!store) {
        throw new AppError('Seller not found.', 404, 'SELLER_NOT_FOUND');
      }
      const state = await stateFor(request.user._id);
      if (!state.followedStoreIds.some((id) => id.equals(store._id))) {
        if (state.followedStoreIds.length >= 100) {
          throw new AppError(
            'You have reached the followed-store limit.',
            409,
            'FOLLOW_LIMIT',
          );
        }
        state.followedStoreIds.push(store._id);
        await state.save();
      }
      response.status(201).json({ followed: true });
    } catch (error) {
      next(error);
    }
  },
);

router.delete(
  '/api/v1/storefront/follow/:slug',
  requireAuth,
  async (request, response, next) => {
    try {
      const store = await Store.findOne({
        slug: request.params.slug,
        status: 'verified',
      });
      if (!store) {
        throw new AppError('Seller not found.', 404, 'SELLER_NOT_FOUND');
      }
      const state = await stateFor(request.user._id);
      state.followedStoreIds = state.followedStoreIds.filter(
        (id) => !id.equals(store._id),
      );
      await state.save();
      response.json({ followed: false });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/api/v1/storefront/sellers/:slug/contact',
  requireAuth,
  async (request, response, next) => {
    try {
      const input = contactSchema.parse(request.body);
      const seller = await publishedSeller(request.params.slug, request.country);
      if (!seller) {
        throw new AppError('Seller not found.', 404, 'SELLER_NOT_FOUND');
      }
      const store = await Store.findOne({ slug: seller.slug, status: 'verified' });
      if (!store) {
        throw new AppError('Seller not found.', 404, 'SELLER_NOT_FOUND');
      }
      const oneMinuteAgo = new Date(Date.now() - 60_000);
      const duplicate = await SellerContactRequest.exists({
        customerUserId: request.user._id,
        storeId: store._id,
        createdAt: { $gte: oneMinuteAgo },
      });
      if (duplicate) {
        throw new AppError(
          'Please wait before sending another message.',
          429,
          'CONTACT_RATE_LIMIT',
        );
      }
      const contact = await SellerContactRequest.create({
        publicId: publicId('contact'),
        customerUserId: request.user._id,
        storeId: store._id,
        country: request.country.code,
        subject: input.subject,
        message: input.message,
      });
      response.status(201).json({
        request: { id: contact.publicId, status: contact.status },
      });
    } catch (error) {
      next(error);
    }
  },
);


router.get('/api/v1/storefront/autocomplete', async (request, response, next) => {
  try {
    const q = String(request.query.q || '').trim().toLowerCase().slice(0, 80);
    if (q.length < 2) return response.json({ suggestions: [] });
    const catalogue = await getStorefront(request.country);
    const suggestions = [];
    const seen = new Set();
    const push = (type, label, value) => { const key=`${type}:${value}`; if(!seen.has(key)&&suggestions.length<12){seen.add(key);suggestions.push({type,label,value});} };
    catalogue.products.forEach((product) => {
      if (String(product.name).toLowerCase().includes(q)) push('product', product.name, product.id);
      if (String(product.brand || '').toLowerCase().includes(q)) push('brand', product.brand, String(product.brandSlug || product.brand || '').toLowerCase().replace(/[^a-z0-9]+/g,'-'));
      if (String(product.categoryName || '').toLowerCase().includes(q)) push('category', product.categoryName, product.category);
      if (String(product.seller?.name || '').toLowerCase().includes(q)) push('seller', product.seller.name, product.seller.slug);
      if ([product.sku, product.barcode, ...(product.variants || []).flatMap(v => [v.sku, v.barcode])].some(value => String(value || '').toLowerCase().includes(q))) push('product', `${product.name} · ${product.sku}`, product.id);
    });
    response.set('Cache-Control','public, max-age=15').json({ suggestions });
  } catch (error) { next(error); }
});

router.post('/api/v1/storefront/search/:searchId/click', async (request, response, next) => {
  try {
    const productId = z.string().trim().min(4).max(100).parse(request.body.productId);
    await SearchEvent.updateOne({ publicId: request.params.searchId, sessionKey: browsingSessionKey(request) }, { $set: { clickedProductPublicId: productId } });
    response.status(204).end();
  } catch (error) { next(error); }
});

router.get('/api/v1/storefront/alerts', requireAuth, async (request, response, next) => {
  try {
    const limit=Math.max(1,Math.min(100,Number(request.query.limit)||50));const base={userId:request.user._id,country:request.country.code};
    const [rows,total]=await Promise.all([ProductAlert.find(cursorScope(base,request.query.after)).select('-productId -userId').sort({createdAt:-1,_id:-1}).limit(limit+1).lean(),ProductAlert.countDocuments(base)]);
    const page=pageResult(rows,{limit,total});
    response.set('Cache-Control','private, no-store').json({ alerts:page.items,page:page.page });
  } catch (error) { next(error); }
});

router.post('/api/v1/storefront/alerts/:productId', requireAuth, requireVerified, async (request, response, next) => {
  try {
    const input = alertSchema.parse(request.body);
    const { product, publicProduct } = await resolveProduct(request);
    if(input.type==='restock'&&Number(publicProduct.stock||0)>0)throw new AppError('This product is already in stock.',409,'PRODUCT_ALREADY_IN_STOCK');
    const priceRow = await ProductVariant.findOne({ productId: product._id, active: true }).sort({ priceMinor: 1 }).select('priceMinor').lean();
    const firstPrice = Number(priceRow?.priceMinor);
    const row = await ProductAlert.findOneAndUpdate(
      { userId: request.user._id, productId: product._id, type: input.type },
      { $set: { country: request.country.code, productPublicId: product.publicId, status:'active', targetPriceMinor: input.targetPriceMinor, lastKnownPriceMinor: Number.isFinite(firstPrice) ? firstPrice : undefined }, $setOnInsert:{ publicId: publicId('alt') } },
      { upsert:true, returnDocument:'after', setDefaultsOnInsert:true },
    );
    response.status(201).json({ alert: { id: row.publicId, productId: row.productPublicId, type: row.type, status: row.status, targetPriceMinor: row.targetPriceMinor } });
  } catch (error) { next(error); }
});

router.delete('/api/v1/storefront/alerts/:alertId', requireAuth, async (request, response, next) => {
  try {
    const result = await ProductAlert.updateOne({ publicId: request.params.alertId, userId: request.user._id, country:request.country.code }, { $set:{ status:'cancelled' } });
    if (!result.matchedCount) throw new AppError('Alert not found.',404,'ALERT_NOT_FOUND');
    response.status(204).end();
  } catch (error) { next(error); }
});

router.get('/api/v1/storefront/products/:productId/questions', async (request, response, next) => {
  try {
    const { product } = await resolveProduct(request);
    const base={productId:product._id,country:request.country.code,status:'answered'},limit=Math.min(Math.max(Number(request.query.limit)||50,10),100);
    const [rows,total]=await Promise.all([ProductQuestion.find(cursorScope(base,request.query.after)).select('publicId question answer createdAt').sort({createdAt:-1,_id:-1}).limit(limit+1).lean(),ProductQuestion.countDocuments(base)]);
    const questionPage=pageResult(rows,{limit,total});
    response.set('Cache-Control','public, max-age=30').json({ questions:questionPage.items, page:questionPage.page });
  } catch (error) { next(error); }
});

router.post('/api/v1/storefront/products/:productId/questions', requireAuth, requireVerified, async (request, response, next) => {
  try {
    const input = questionSchema.parse(request.body);
    const { product } = await resolveProduct(request);
    if (product.ownerUserId?.equals(request.user._id) || await StoreMember.exists({ storeId: product.storeId, userId: request.user._id, status: 'active' })) throw new AppError('Store owners and staff cannot ask questions on their own listing.',403,'SELF_QUESTION_BLOCKED');
    const row = await ProductQuestion.create({ publicId:publicId('que'), productId:product._id, productPublicId:product.publicId, storeId:product.storeId, customerUserId:request.user._id, country:request.country.code, question:input.question });
    response.status(201).json({ question:{ id:row.publicId,status:row.status } });
  } catch (error) { next(error); }
});

router.post('/api/v1/seller/questions/:questionId/answer', requireAuth, requireVerified, async (request, response, next) => {
  try {
    const input = answerSchema.parse(request.body);
    let store = await Store.findOne({ ownerUserId:request.user._id, status:'verified' });
    if (!store) { const membership = await StoreMember.findOne({ userId:request.user._id, status:'active', role:{ $in:['owner','admin','support'] } }); if (membership) store = await Store.findOne({ _id:membership.storeId, status:'verified' }); }
    if (!store) throw new AppError('Verified seller store support access required.',403,'STORE_REQUIRED');
    const question = await ProductQuestion.findOne({ publicId:request.params.questionId, storeId:store._id, status:'open' });
    if (!question) throw new AppError('Question not found.',404,'QUESTION_NOT_FOUND');
    question.answer={body:input.answer,sellerUserId:request.user._id,answeredAt:new Date()}; question.status='answered'; await question.save();
    response.json({ question:{ id:question.publicId,status:question.status } });
  } catch (error) { next(error); }
});

export default router;
