import mongoose from 'mongoose';
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getStorefront, publishedProduct } from '../services/storefront.js';
import { publishedCms, publishedCmsList } from '../services/stage9.js';
import { Review, User } from '../models/index.js';
import { activeSponsoredProducts } from '../services/seller-growth.js';

const router = Router();

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

async function decorateSponsored(catalogue, countryCode) {
  const map = await activeSponsoredProducts(countryCode, (catalogue.products || []).map((product) => product.id));
  return {
    ...catalogue,
    products: (catalogue.products || []).map((product) => decoratePromotedProduct(product, map.get(product.id))),
  };
}


const pages = new Map([
  ['/about', 'about'],
  ['/careers', 'careers'],
  ['/cart', 'cart'],
  ['/contact', 'contact'],
  ['/cookies', 'cookies'],
  ['/help', 'help'],
  ['/payments', 'payment-policy'],
  ['/privacy', 'privacy'],
  ['/promoters', 'promoters'],
  ['/returns', 'returns'],
  ['/shipping', 'shipping'],
  ['/terms', 'terms'],
  ['/track-order', 'track-order'],
]);

const cmsPageKeys = new Map([['/help','help.main'],['/privacy','legal.privacy'],['/terms','legal.terms'],['/cookies','legal.cookies'],['/payments','legal.payments'],['/shipping','help.shipping'],['/returns','help.returns']]);
for (const [path, view] of pages) {
  router.get(path, async (request, response, next) => {
    try {
      const key = cmsPageKeys.get(path);
      const cmsContent = key && mongoose.connection.readyState === 1 ? await publishedCms(key, request.country?.code) : null;
      response.render(view, { cmsContent });
    } catch (error) { next(error); }
  });
}

async function publishedTestimonials(countryCode, limit = 3) {
  const reviews = await Review.find({ country: String(countryCode || '').toUpperCase(), status: 'published', verifiedPurchase: true })
    .sort({ publishedAt: -1, createdAt: -1 })
    .limit(Math.min(6, Math.max(1, Number(limit) || 3)))
    .select('userId rating body title publishedAt')
    .lean();
  if (!reviews.length) return [];
  const users = await User.find({ _id: { $in: reviews.map((review) => review.userId) }, status: 'active' })
    .select('name roleProfile.publicName')
    .lean();
  const names = new Map(users.map((user) => [String(user._id), user.roleProfile?.publicName || user.name || 'Verified customer']));
  return reviews.filter((review) => names.has(String(review.userId))).map((review) => ({
    name: names.get(String(review.userId)), rating: Number(review.rating || 0), body: review.body,
    title: review.title || '', publishedAt: review.publishedAt, image: '/assets/image-placeholder.svg',
  }));
}

router.get('/', async (request, response, next) => {
  try {
    const connected = mongoose.connection.readyState === 1;
    const catalogue = connected
      ? await getStorefront(request.country).then((row) => decorateSponsored(row, request.country.code))
      : { country: request.country, products: [], categories: [], brands: [], sellers: [] };
    response.set('Cache-Control', 'public, max-age=10, stale-while-revalidate=30');
    const [cmsBanner, cmsHomeModule, cmsCollection, homeHeroSlides, pressArticles, homeTestimonials] = connected
      ? await Promise.all([
          publishedCms('home.banner.primary', request.country?.code),
          publishedCms('home.module.primary', request.country?.code),
          publishedCms('home.collection.primary', request.country?.code),
          publishedCmsList({ prefix: 'home.hero.', type: 'hero', country: request.country?.code, limit: 6 }),
          publishedCmsList({ prefix: 'press.article.', type: 'press', country: request.country?.code, limit: 6 }),
          publishedTestimonials(request.country?.code, 3),
        ])
      : [null, null, null, [], [], []];
    return response.render('index', {
      initialStorefront: catalogue,
      initialStorefrontJson: JSON.stringify(catalogue).replace(/</g, '\u003c'),
      cmsBanner, cmsHomeModule, cmsCollection, homeHeroSlides, pressArticles, homeTestimonials,
    });
  } catch (error) { return next(error); }
});

router.get('/press', async (request, response, next) => {
  try {
    const pressArticles = mongoose.connection.readyState === 1
      ? await publishedCmsList({ prefix: 'press.article.', type: 'press', country: request.country?.code, limit: 50 })
      : [];
    response.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
    return response.render('press', { cmsContent: null, pressArticles });
  } catch (error) { return next(error); }
});
router.get('/products', (_request, response) => response.render('products'));
router.get('/categories', (_request, response) =>
  response.render('categories'),
);
router.get('/search', (_request, response) => response.render('search'));
router.get('/sellers', (_request, response) => response.render('sellers'));
router.get('/sellers/profile', (request, response) => {
  const slug = String(request.query.slug || '').trim();
  return response.redirect(301, slug ? `/sellers/${encodeURIComponent(slug)}` : '/sellers');
});
router.get('/sellers/:slug', (_request, response) =>
  response.render('seller-profile'),
);
router.get('/promoters/profile', (request, response) => {
  const id = String(request.query.id || '').trim();
  return response.redirect(301, id ? `/promoters/${encodeURIComponent(id)}` : '/promoters');
});
router.get('/promoters/:id', (_request, response) => response.render('promoter-profile'));
router.get('/products/:productId', async (request, response, next) => {
  try {
    const product = await publishedProduct(request.params.productId, request.country);
    if (!product) return response.status(404).render('error', { status: 404, code: 'PRODUCT_NOT_FOUND', message: 'Product not found.' });
    response.set('Cache-Control', 'public, max-age=10, stale-while-revalidate=30');
    const canonical = `${request.protocol}://${request.get('host')}/products/${encodeURIComponent(product.id)}`;
    const absoluteImage = new URL(product.images?.[0] || product.image || '/assets/product-placeholder.svg', `${request.protocol}://${request.get('host')}`).toString();
    const jsonLd = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': product.variants?.length > 1 ? 'ProductGroup' : 'Product',
      name: product.name,
      description: String(product.description || product.subtitle || product.name).slice(0, 500),
      image: (product.images || [product.image]).filter(Boolean).map((image) => new URL(image, `${request.protocol}://${request.get('host')}`).toString()),
      sku: product.sku || undefined,
      brand: product.brand ? { '@type': 'Brand', name: product.brand } : undefined,
      url: canonical,
      offers: {
        '@type': 'Offer',
        priceCurrency: product.currency,
        price: String(product.price),
        availability: product.stock > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
        url: canonical,
        seller: { '@type': 'Organization', name: product.seller?.name || 'Classic Mart seller' },
      },
    }).replace(/</g, '\\u003c');
    const catalogue = await getStorefront(request.country).then((row) => decorateSponsored(row, request.country.code));
    if (!catalogue.products.some((item) => item.id === product.id)) {
      catalogue.products = [product, ...catalogue.products];
    }
    return response.render('index', {
      initialStorefront: catalogue,
      initialStorefrontJson: JSON.stringify(catalogue).replace(/</g, '\\u003c'),
      cmsBanner: null, cmsHomeModule: null, cmsCollection: null, homeHeroSlides: [], pressArticles: [], homeTestimonials: [],
      productMeta: {
        name: product.name,
        description: String(product.description || product.subtitle || product.name).slice(0, 220),
        image: absoluteImage,
        canonical,
        jsonLd,
      },
    });
  } catch (error) { return next(error); }
});
router.get('/wishlist', requireAuth, (_request, response) => {
  response.set('Cache-Control', 'private, no-store');
  response.render('wishlist');
});
router.get('/compare', requireAuth, (_request, response) => {
  response.set('Cache-Control', 'private, no-store');
  response.render('compare');
});

const legacy = [
  'about',
  'careers',
  'cart',
  'categories',
  'contact',
  'cookies',
  'help',
  'press',
  'privacy',
  'products',
  'promoters',
  'returns',
  'search',
  'sellers',
  'shipping',
  'terms',
  'track-order',
  'wishlist',
];

router.get('/index.html', (_request, response) => response.redirect(301, '/'));
router.get('/login.html', (request, response) =>
  response.redirect(301, `/login${request.url.slice(request.path.length)}`),
);
router.get('/signup.html', (request, response) =>
  response.redirect(301, `/signup${request.url.slice(request.path.length)}`),
);
router.get('/forgot-password.html', (_request, response) =>
  response.redirect(301, '/forgot-password'),
);
router.get('/reset-password.html', (_request, response) =>
  response.redirect(301, '/reset-password'),
);
router.get('/onboarding.html', (request, response) =>
  response.redirect(301, `/onboarding${request.url.slice(request.path.length)}`),
);
router.get('/profile.html', (_request, response) =>
  response.redirect(301, '/dashboard'),
);
router.get('/payment-policy.html', (_request, response) =>
  response.redirect(301, '/payments'),
);
router.get('/seller-profile.html', (request, response) => {
  const slug = String(request.query.slug || '').trim();
  return response.redirect(301, slug ? `/sellers/${encodeURIComponent(slug)}` : '/sellers');
});
router.get('/promoter-profile.html', (request, response) => {
  const id = String(request.query.id || '').trim();
  return response.redirect(301, id ? `/promoters/${encodeURIComponent(id)}` : '/promoters');
});
for (const name of legacy) {
  router.get(`/${name}.html`, (request, response) =>
    response.redirect(
      301,
      `/${name}${request.url.slice(request.path.length)}`,
    ),
  );
}

export default router;
