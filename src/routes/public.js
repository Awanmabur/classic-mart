import mongoose from 'mongoose';
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getStorefront, publishedCategory, publishedProduct, publishedSeller, publishedSellers } from '../services/storefront.js';
import { publicPromoter, publicPromoters } from '../services/promoters.js';
import { AppError } from '../core/errors.js';
import { absoluteUrl, breadcrumbSchema, canonicalUrl, collectionSchema, hasDuplicateQuery, jsonForHtml, pageSeo, plainText, productSeo } from '../services/seo.js';
import { publishedCms, publishedCmsList } from '../services/stage9.js';
import { Review, User } from '../models/index.js';
import { activeSponsoredProducts } from '../services/seller-growth.js';

const router = Router();

function publicCache(response, value = 'public, max-age=10, stale-while-revalidate=30') {
  response.vary('Cookie');
  response.vary('CF-IPCountry');
  if (!response.get('Set-Cookie') && !String(response.get('Cache-Control') || '').includes('no-store')) response.set('Cache-Control', value);
}
function setSeo(request, response, overrides = {}) {
  const seo = pageSeo(request, overrides);
  response.locals.seo = seo;
  if (seo.noindex) response.set('X-Robots-Tag', 'noindex, follow');
  return seo;
}
const emptyCatalogue = country => ({ country, products: [], categories: [], brands: [], sellers: [] });
async function publicCatalogue(request) {
  return mongoose.connection.readyState === 1 ? getStorefront(request.country) : emptyCatalogue(request.country);
}

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
  ['/return-policy', 'returns'],
  ['/shipping', 'shipping'],
  ['/terms', 'terms'],
  ['/track-order', 'track-order'],
]);

const cmsPageKeys = new Map([['/help','help.main'],['/privacy','legal.privacy'],['/terms','legal.terms'],['/cookies','legal.cookies'],['/payments','legal.payments'],['/shipping','help.shipping'],['/returns','help.returns'],['/return-policy','help.returns']]);
for (const [path, view] of pages) {
  router.get(path, async (request, response, next) => {
    try {
      if (path === '/returns') return response.redirect(301, '/return-policy');
      if (path === '/promoters') {
        const result = mongoose.connection.readyState === 1 ? await publicPromoters(request.country, { limit: 50 }) : { items: [] };
        setSeo(request, response, { schema: [collectionSchema(request, 'Marketplace promoters', result.items.map(person => [person.name, '/promoters/' + encodeURIComponent(person.id)]))] });
        return response.render(view, { cmsContent: null, initialPeople: result.items });
      }
      const key = cmsPageKeys.get(path);
      const cmsContent = key && mongoose.connection.readyState === 1 ? await publishedCms(key, request.country?.code) : null;
      if (cmsContent) setSeo(request, response, { title: `${cmsContent.title || 'Classic Mart'} — Classic Mart`, description: cmsContent.body });
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
    const emptyCatalogue = { country: request.country, products: [], categories: [], brands: [], sellers: [] };
    const [catalogue, cmsBanner, cmsHomeModule, cmsCollection, homeHeroSlides, pressArticles, homeTestimonials] = connected
      ? await Promise.all([
          getStorefront(request.country).then((row) => decorateSponsored(row, request.country.code)),
          publishedCms('home.banner.primary', request.country?.code),
          publishedCms('home.module.primary', request.country?.code),
          publishedCms('home.collection.primary', request.country?.code),
          publishedCmsList({ prefix: 'home.hero.', type: 'hero', country: request.country?.code, limit: 6 }),
          publishedCmsList({ prefix: 'press.article.', type: 'press', country: request.country?.code, limit: 6 }),
          publishedTestimonials(request.country?.code, 3),
        ])
      : [emptyCatalogue, null, null, null, [], [], []];
    publicCache(response);
    setSeo(request, response, { schema: [
      { '@context': 'https://schema.org', '@type': 'Organization', '@id': absoluteUrl('/') + '#organization', name: 'Classic Mart', url: absoluteUrl('/') },
      { '@context': 'https://schema.org', '@type': 'WebSite', name: 'Classic Mart', url: absoluteUrl('/') },
    ] });
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
    publicCache(response, 'public, max-age=30, stale-while-revalidate=120');
    setSeo(request, response, { schema: [collectionSchema(request, 'Classic Mart news and buying guides', pressArticles.map(article => [article.title, '/press/' + encodeURIComponent(article.key)]))] });
    return response.render('press', { cmsContent: null, pressArticles });
  } catch (error) { return next(error); }
});
router.get('/press/:key', async (request, response, next) => {
  try {
    if (!/^press\.article\.[a-z0-9.-]{1,100}$/.test(request.params.key)) throw new AppError('Article not found.', 404, 'ARTICLE_NOT_FOUND');
    const article = mongoose.connection.readyState === 1 ? await publishedCms(request.params.key, request.country?.code) : null;
    if (!article || article.type !== 'press') throw new AppError('Article not found.', 404, 'ARTICLE_NOT_FOUND');
    const canonical = canonicalUrl(request.path, request.country?.code);
    const image = article.data?.image ? absoluteUrl(article.data.image) : '';
    setSeo(request, response, { title: `${article.title} — Classic Mart`, description: article.body, image, imageAlt: article.title, type: 'article', noindex: hasDuplicateQuery(request), schema: [
      { '@context': 'https://schema.org', '@type': 'Article', headline: article.title, description: plainText(article.body, 220), articleBody: plainText(article.body, 20000), mainEntityOfPage: canonical, url: canonical, image: image || undefined, publisher: { '@type': 'Organization', name: 'Classic Mart', url: absoluteUrl('/') } },
      breadcrumbSchema([['Home','/'],['News & guides','/press'],[article.title,request.path]], request.country?.code),
    ] });
    publicCache(response);
    return response.render('press', { cmsContent: null, pressArticles: [article], currentArticle: article });
  } catch (error) { next(error); }
});
router.get('/products', async (request, response, next) => {
  try {
    const catalogue = await publicCatalogue(request);
    setSeo(request, response, { schema: [collectionSchema(request, 'Marketplace products', catalogue.products.slice(0,12).map(product => [product.name, '/products/' + encodeURIComponent(product.id)]))] });
    publicCache(response);
    return response.render('products', { initialCatalogue: catalogue, initialCategory: null });
  } catch (error) { next(error); }
});
router.get('/categories', async (request, response, next) => {
  try {
    const catalogue = await publicCatalogue(request);
    setSeo(request, response, { schema: [collectionSchema(request, 'Product categories', catalogue.categories.filter(category => category.count > 0).map(category => [category.name, '/categories/' + encodeURIComponent(category.id)]))] });
    publicCache(response);
    return response.render('categories', { initialCatalogue: catalogue });
  } catch (error) { next(error); }
});
router.get('/categories/:slug', async (request, response, next) => {
  try {
    if (!/^[a-z0-9-]{1,100}$/.test(request.params.slug)) throw new AppError('Category not found.', 404, 'CATEGORY_NOT_FOUND');
    const result = mongoose.connection.readyState === 1 ? await publishedCategory(request.params.slug, request.country) : null;
    if (!result) throw new AppError('Category not found.', 404, 'CATEGORY_NOT_FOUND');
    const { category, catalogue: scoped } = result;
    const title = `${category.name} — Classic Mart${request.country?.name ? ' · ' + request.country.name : ''}`;
    setSeo(request, response, { title, description: `${category.note || category.name}. Browse published ${category.name.toLowerCase()} listings, current prices and availability from verified marketplace sellers.`, noindex: !scoped.products.length || hasDuplicateQuery(request), schema: [collectionSchema(request, category.name, scoped.products.slice(0,12).map(product => [product.name, '/products/' + encodeURIComponent(product.id)])), breadcrumbSchema([['Home','/'],['Categories','/categories'],[category.name,request.path]], request.country?.code)] });
    publicCache(response);
    return response.render('products', { initialCatalogue: scoped, initialCategory: category });
  } catch (error) { next(error); }
});
router.get('/search', (_request, response) => response.render('search'));
router.get('/sellers', async (request, response, next) => {
  try {
    const result = mongoose.connection.readyState === 1 ? await publishedSellers(request.country, { limit: 50 }) : { items: [] };
    setSeo(request, response, { schema: [collectionSchema(request, 'Verified marketplace sellers', result.items.map(seller => [seller.name, '/sellers/' + encodeURIComponent(seller.slug)]))] });
    publicCache(response);
    return response.render('sellers', { initialPeople: result.items });
  } catch (error) { next(error); }
});
router.get('/sellers/profile', (request, response) => {
  const slug = String(request.query.slug || '').trim();
  return response.redirect(301, slug ? `/sellers/${encodeURIComponent(slug)}` : '/sellers');
});
router.get('/sellers/:slug', async (request, response, next) => {
  try {
    const seller = mongoose.connection.readyState === 1 ? await publishedSeller(request.params.slug, request.country, { limit: 50 }) : null;
    if (!seller) throw new AppError('Seller not found.', 404, 'SELLER_NOT_FOUND');
    setSeo(request, response, { title: `${seller.name} — Classic Mart`, description: seller.description || `Browse published products from ${seller.name}, a verified Classic Mart seller in ${request.country.name}.`, image: absoluteUrl(seller.image), imageAlt: seller.name, noindex: hasDuplicateQuery(request), schema: [
      { '@context': 'https://schema.org', '@type': 'ProfilePage', name: seller.name, url: canonicalUrl(request.path, request.country.code), mainEntity: { '@type': 'Organization', name: seller.name, description: seller.description, url: canonicalUrl(request.path, request.country.code) } },
      breadcrumbSchema([['Home','/'],['Sellers','/sellers'],[seller.name,request.path]], request.country.code),
    ] });
    publicCache(response);
    return response.render('seller-profile', { initialProfile: seller });
  } catch (error) { next(error); }
});
router.get('/promoters/profile', (request, response) => {
  const id = String(request.query.id || '').trim();
  return response.redirect(301, id ? `/promoters/${encodeURIComponent(id)}` : '/promoters');
});
router.get('/promoters/:id', async (request, response, next) => {
  try {
    const promoter = mongoose.connection.readyState === 1 ? await publicPromoter(request.params.id, request.country) : null;
    if (!promoter) throw new AppError('Promoter not found.', 404, 'PROMOTER_NOT_FOUND');
    setSeo(request, response, { title: `${promoter.name} — Classic Mart`, description: promoter.description || `Explore active product campaigns from ${promoter.name}, a verified Classic Mart promoter.`, noindex: hasDuplicateQuery(request), image: absoluteUrl(promoter.image || '/assets/image-placeholder.svg'), imageAlt: promoter.name });
    publicCache(response);
    return response.render('promoter-profile', { initialProfile: promoter });
  } catch (error) { next(error); }
});
router.get('/products/:productId', async (request, response, next) => {
  try {
    const product = mongoose.connection.readyState === 1 ? await publishedProduct(request.params.productId, request.country) : null;
    if (!product) return response.status(404).render('error', { status: 404, code: 'PRODUCT_NOT_FOUND', message: 'Product not found.' });
    publicCache(response);
    const seo = productSeo(request, product);
    response.locals.seo = seo;
    const catalogue = await getStorefront(request.country).then((row) => decorateSponsored(row, request.country.code));
    if (!catalogue.products.some((item) => item.id === product.id)) {
      catalogue.products = [product, ...catalogue.products];
    }
    return response.render('index', {
      initialStorefront: catalogue,
      initialStorefrontJson: jsonForHtml(catalogue),
      cmsBanner: null, cmsHomeModule: null, cmsCollection: null, homeHeroSlides: [], pressArticles: [], homeTestimonials: [],
      productMeta: { ...product, canonical: seo.canonical, jsonLd: seo.jsonLd },
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
  response.redirect(301, '/account/profile'),
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
