import rateLimit from '../middleware/rate-limit.js';
import { Router } from 'express';
import { env } from '../config/env.js';
import { CmsContent, Product } from '../models/index.js';
import { AppError, asyncHandler } from '../core/errors.js';
import { getCountries } from '../services/country.js';
import { publicEligibilityStages } from '../services/storefront.js';
import { canonicalUrl, isCountryPage, PRIVATE_PATHS, PUBLIC_PAGE_META, SITE_URL } from '../services/seo.js';

const router = Router();
const discoveryLimit = rateLimit({ scope: 'discovery:1', windowMs: 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false });
router.use(['/robots.txt', '/llms.txt', '/sitemap.xml', '/sitemaps'], discoveryLimit);
const PAGE_SIZE = 1000;
const MAX_SITEMAPS = 50_000;
const MAX_CACHE_ENTRIES = 64;
const CACHE_MS = 60_000;
const cache = new Map();
const pending = new Map();
const xml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
const missing = () => new AppError('Sitemap page not found.', 404, 'SITEMAP_NOT_FOUND');
const xmlDocument = body => '<?xml version="1.0" encoding="UTF-8"?>\n' + body;
const urlset = entries => xmlDocument('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + entries.map(({ url, updatedAt }) => {
  const date = updatedAt ? new Date(updatedAt) : null;
  return `<url><loc>${xml(url)}</loc>${date && Number.isFinite(date.valueOf()) ? `<lastmod>${date.toISOString()}</lastmod>` : ''}</url>`;
}).join('') + '</urlset>');

// Bound both cache size and concurrent regenerations; cache only successful public XML.
export function clearDiscoveryCache() { cache.clear(); }
async function cached(key, loader) {
  const current = cache.get(key);
  if (current && current.expiresAt > Date.now()) return current.body;
  if (pending.has(key)) return pending.get(key);
  if (pending.size >= MAX_CACHE_ENTRIES) throw new AppError('Discovery is temporarily busy.', 503, 'SITEMAP_BUSY');
  const promise = Promise.resolve().then(loader);
  pending.set(key, promise);
  try {
    const body = await promise;
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(key, { body, expiresAt: Date.now() + CACHE_MS });
    return body;
  } finally { pending.delete(key); }
}
const sendXml = (response, body) => response.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=60').type('application/xml').send(body);
async function launchCountries() {
  const countries = await getCountries();
  return countries.filter(country => country.active !== false && (!env.security.launchCountries.length ? country.code === 'UG' : env.security.launchCountries.includes(country.code)));
}
function query(request, allowed) {
  const params = new URL(request.originalUrl, SITE_URL).searchParams;
  if ([...params.keys()].some(key => !allowed.includes(key) || params.getAll(key).length !== 1)) throw missing();
  return params;
}
async function sitemapCountry(params) {
  const code = params.get('country') || 'UG';
  if (!/^[A-Z]{2}$/.test(code)) throw missing();
  const country = (await launchCountries()).find(row => row.code === code);
  if (!country) throw missing();
  return country;
}
function pageNumber(params) {
  const raw = params.get('page') || '1';
  if (!/^[1-9]\d{0,4}$/.test(raw) || Number(raw) > MAX_SITEMAPS) throw missing();
  return Number(raw);
}
function eligible(country) {
  return [{ $match: { status: 'published', countries: country.code } }, ...publicEligibilityStages(country)];
}
function articlePipeline(country) {
  return [
    { $match: { status: { $in: ['published', 'scheduled'] }, type: 'press', key: /^press\.article\.[a-z0-9.-]{1,100}$/, country: { $in: [country.code, ''] }, activeVersion: { $gt: 0 } } },
    { $set: { _activeRevision: { $arrayElemAt: [{ $filter: { input: '$revisions', as: 'revision', cond: { $eq: ['$$revision.version', '$activeVersion'] } } }, 0] } } },
    { $match: { '_activeRevision.version': { $exists: true } } },
    { $sort: { country: -1, key: 1 } },
    { $group: { _id: '$key', key: { $first: '$key' } } },
  ];
}
const sitemapUrl = (kind, country, page) => `${SITE_URL}/sitemaps/${kind}.xml?country=${country}${page ? '&page=' + page : ''}`;

router.get('/robots.txt', (_request, response) => {
  const disallows = PRIVATE_PATHS.flatMap(path => [`Disallow: ${path}$`, `Disallow: ${path}/`, `Disallow: ${path}?`]);
  // Public /sellers and /promoters do not share private path prefixes.
  response.set('Cache-Control', 'public, max-age=300').type('text/plain').send('User-agent: *\nAllow: /\nAllow: /sellers\nAllow: /promoters\n' + disallows.join('\n') + '\nDisallow: /search\nDisallow: /*?*q=\nDisallow: /*?*token=\n' + `Sitemap: ${SITE_URL}/sitemap.xml\n`);
});
router.get('/llms.txt', (_request, response) => response.set('Cache-Control', 'public, max-age=300').type('text/plain').send(
  `# Classic Mart\n\n> Classic Mart is a marketplace connecting shoppers with verified sellers and published product listings.\n\n` +
  `## Public sources\n\n- [Marketplace](${SITE_URL}/)\n- [Products](${SITE_URL}/products)\n- [Categories](${SITE_URL}/categories)\n- [Sellers](${SITE_URL}/sellers)\n- [News and guides](${SITE_URL}/press)\n- [Help](${SITE_URL}/help)\n- [Sitemap](${SITE_URL}/sitemap.xml)\n\n` +
  `## Reading this site\n\nPublic pages may be crawled subject to robots.txt and our terms. Use the canonical URL and its country parameter to identify the market. Prices, currency, inventory and delivery options can change; confirm them on the current product page and at checkout. Cite the source URL when describing a listing.\n\n` +
  `Accounts, dashboards, checkout, private documents and API responses are not public reference material. Do not request or reproduce private customer or seller information. This file is a human-readable discovery aid; it does not grant account access, override robots.txt or establish a machine-enforced AI protocol.\n\n- [Terms](${SITE_URL}/terms)\n- [Privacy](${SITE_URL}/privacy)\n`
));

router.get('/sitemap.xml', asyncHandler(async (request, response) => {
  query(request, []);
  const body = await cached('index', async () => {
    const countries = await launchCountries();
    const entries = [`${SITE_URL}/sitemaps/pages.xml`];
    for (const country of countries) {
      const [counts] = await Product.aggregate([...eligible(country), { $facet: {
        products: [{ $count: 'total' }],
        categories: [{ $group: { _id: '$categoryId' } }, { $count: 'total' }],
        sellers: [{ $group: { _id: '$storeId' } }, { $count: 'total' }],
      } }]).option({ maxTimeMS: 15_000 });
      for (const kind of ['products', 'categories', 'sellers']) {
        const pages = Math.ceil((counts?.[kind]?.[0]?.total || 0) / PAGE_SIZE);
        if (entries.length + pages > MAX_SITEMAPS - 1) throw new AppError('Sitemap index capacity exceeded.', 503, 'SITEMAP_CAPACITY');
        for (let page = 1; page <= pages; page++) entries.push(sitemapUrl(kind, country.code, page));
      }
      const [articleCount] = await CmsContent.aggregate([...articlePipeline(country), { $count: 'total' }]).option({ maxTimeMS: 15_000 });
      const articlePages = Math.max(1, Math.ceil((articleCount?.total || 0) / PAGE_SIZE));
      if (entries.length + articlePages > MAX_SITEMAPS) throw new AppError('Sitemap index capacity exceeded.', 503, 'SITEMAP_CAPACITY');
      for (let page = 1; page <= articlePages; page++) entries.push(sitemapUrl('articles', country.code, page));
      if (entries.length > MAX_SITEMAPS) throw new AppError('Sitemap index capacity exceeded.', 503, 'SITEMAP_CAPACITY');
    }
    return xmlDocument('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + entries.map(url => `<sitemap><loc>${xml(url)}</loc></sitemap>`).join('') + '</sitemapindex>');
  });
  sendXml(response, body);
}));
router.get('/sitemaps/pages.xml', asyncHandler(async (request, response) => {
  query(request, []);
  sendXml(response, await cached('pages', async () => {
    const countries = await launchCountries();
    const entries = Object.keys(PUBLIC_PAGE_META).flatMap(path => isCountryPage(path) ? countries.map(country => ({ url: canonicalUrl(path, country.code) })) : [{ url: canonicalUrl(path) }]);
    return urlset(entries);
  }));
}));
for (const kind of ['products', 'categories', 'sellers']) {
  router.get(`/sitemaps/${kind}.xml`, asyncHandler(async (request, response) => {
    const params = query(request, ['country', 'page']);
    const country = await sitemapCountry(params);
    const page = pageNumber(params);
    sendXml(response, await cached(`${kind}:${country.code}:${page}`, async () => {
      const group = kind === 'categories' ? [{ $group: { _id: '$categoryId', slug: { $first: '$_publicCategory.slug' }, updatedAt: { $max: '$updatedAt' } } }]
        : kind === 'sellers' ? [{ $group: { _id: '$storeId', slug: { $first: '$_publicStore.slug' }, updatedAt: { $max: '$updatedAt' } } }] : [];
      const rows = await Product.aggregate([...eligible(country), ...group, { $sort: { _id: 1 } }, { $skip: (page - 1) * PAGE_SIZE }, { $limit: PAGE_SIZE }, { $project: { publicId: 1, slug: 1, updatedAt: 1 } }]).option({ maxTimeMS: 15_000 });
      if (!rows.length && page > 1) throw missing();
      return urlset(rows.map(row => ({ url: canonicalUrl(`/${kind}/${encodeURIComponent(kind === 'products' ? row.publicId : row.slug)}`, country.code), updatedAt: row.updatedAt })));
    }));
  }));
}
router.get('/sitemaps/articles.xml', asyncHandler(async (request, response) => {
  const params = query(request, ['country', 'page']);
  const country = await sitemapCountry(params);
  const page = pageNumber(params);
  sendXml(response, await cached(`articles:${country.code}:${page}`, async () => {
    const articles = await CmsContent.aggregate([...articlePipeline(country), { $sort: { _id: 1 } }, { $skip: (page - 1) * PAGE_SIZE }, { $limit: PAGE_SIZE }]).option({ maxTimeMS: 15_000 });
    if (!articles.length && page > 1) throw missing();
    return urlset(articles.map(article => ({ url: canonicalUrl('/press/' + encodeURIComponent(article.key), country.code) })));
  }));
}));
export default router;
