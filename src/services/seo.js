import { env } from '../config/env.js';

export const SITE_NAME = 'Classic Mart';
const configuredBase = new URL(env.baseUrl);
if (!['https:', 'http:'].includes(configuredBase.protocol) || configuredBase.username || configuredBase.password || configuredBase.search || configuredBase.hash) throw new Error('BASE_URL must be an HTTP(S) site URL without credentials, query or fragment.');
export const SITE_URL = configuredBase.href.replace(/\/+$/, '');
export const PRIVATE_PATHS = Object.freeze(['/dashboard','/orders','/wishlist','/compare','/addresses','/rewards','/wallet','/support','/profile','/notifications','/club','/account','/cart','/checkout','/api','/webhooks','/login','/signup','/verify-email','/verify-phone','/onboarding','/forgot-password','/reset-password','/mfa','/track-order','/ask-classic','/seller','/promoter','/admin','/super-admin','/super','/delivery','/operations','/finance','/warehouse','/moderation','/business','/evidence','/receipts','/offline']);
export const PUBLIC_PAGE_META = Object.freeze({
  '/': ['Classic Mart | Shop Products, Sell & Earn as a Promoter', 'Shop products from verified sellers. Sell through your own store or promote eligible products for commissions without owning stock. Explore Classic Mart AI shopping help.'],
  '/products': ['Shop Products Online | Classic Mart Marketplace', 'Find products, compare current prices and browse available stock from verified sellers in your country on Classic Mart.'],
  '/categories': ['Shop by Category — Classic Mart', 'Explore Classic Mart product categories and discover published listings from verified marketplace sellers.'],
  '/sellers': ['Verified Online Sellers & Stores | Classic Mart', 'Discover verified Classic Mart sellers and published products. Marketplace promoters can help sellers reach buyers through eligible campaigns.'],
  '/promoters': ['Earn Commissions Promoting Products | Classic Mart', 'Explore Classic Mart product promoters. Eligible members can promote approved seller products and earn commissions on qualifying sales without holding stock.'],
  '/about': ['About Classic Mart | Shopping, Selling & Product Promotion', 'Classic Mart connects buyers, verified sellers and product promoters, with AI-assisted discovery and eligible sales commission opportunities.'],
  '/contact': ['Contact Classic Mart', 'Find Classic Mart contact information and ways to get help with marketplace enquiries.'],
  '/careers': ['Careers at Classic Mart', 'Explore career information and published opportunities at Classic Mart.'],
  '/press': ['News & Buying Guides — Classic Mart', 'Read published Classic Mart marketplace announcements, product guides and updates.'],
  '/help': ['Help Centre — Classic Mart', 'Find help with Classic Mart accounts, ordering, payments, delivery and returns.'],
  '/payments': ['Payment Policy — Classic Mart', 'Read about Classic Mart payment methods, checkout and payment support.'],
  '/privacy': ['Privacy Policy — Classic Mart', 'Read how Classic Mart handles personal information and privacy requests.'],
  '/terms': ['Terms of Service — Classic Mart', 'Read the terms for using the Classic Mart marketplace.'],
  '/cookies': ['Cookie Policy — Classic Mart', 'Read about cookies and cookie preferences on Classic Mart.'],
  '/shipping': ['Shipping & Delivery — Classic Mart', 'Find Classic Mart delivery information and country-specific shipping policies.'],
  '/return-policy': ['Returns Policy — Classic Mart', 'Read Classic Mart return eligibility, return requests and refund policies.'],
});
const globalPages = new Set(['/about','/contact','/careers']);
export const isPrivatePath = path => PRIVATE_PATHS.some(prefix => path === prefix || path.startsWith(prefix + '/'));
export const isPublicPath = path => Boolean(PUBLIC_PAGE_META[path]) || /^\/(?:products|categories|sellers|promoters|press)\/[^/]+$/.test(path) || path === '/returns';
export const isCountryPage = path => isPublicPath(path) && !globalPages.has(path);
export const plainText = (value, limit = 180) => String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
export const jsonForHtml = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
export function absoluteUrl(path) {
  const value = String(path || '/');
  const url = /^https?:\/\//i.test(value) ? new URL(value) : new URL(value.replace(/^[\\/]+/, ''), SITE_URL + '/');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return SITE_URL + '/';
  return url.href;
}
export function canonicalUrl(path, country) {
  const cleanPath = String(path || '/').split(/[?#]/)[0];
  const url = new URL(SITE_URL);
  url.pathname = url.pathname.replace(/\/+$/, '') + '/' + cleanPath.replace(/^[\\/]+/, '');
  if (country && isCountryPage(cleanPath)) url.searchParams.set('country', String(country).toUpperCase());
  return url.href;
}
export function hasDuplicateQuery(request) {
  const params = new URL(request.originalUrl || request.url || request.path, SITE_URL).searchParams;
  const allowed = new Set(['country', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid']);
  return [...params.keys()].some(key => !allowed.has(key) || params.getAll(key).length > 1);
}
export function pageSeo(request, overrides = {}) {
  const path = request.path === '/returns' ? '/return-policy' : request.path;
  const meta = PUBLIC_PAGE_META[path];
  const countryName = plainText(request.country?.name, 100);
  const countrySuffix = isCountryPage(path) && countryName ? ` · ${countryName}` : '';
  const seo = {
    title: meta ? meta[0] + countrySuffix : path === '/search' ? 'Search Products — Classic Mart' : SITE_NAME,
    description: meta?.[1] || 'Classic Mart marketplace.',
    canonical: isPublicPath(path) ? canonicalUrl(path, request.country?.code) : '',
    type: 'website', image: '', imageAlt: '', locale: String(request.country?.locale || 'en').replace('-', '_'),
    noindex: !meta || isPrivatePath(path) || hasDuplicateQuery(request),
    schema: path === '/' ? [
      { '@context': 'https://schema.org', '@type': 'Organization', name: SITE_NAME,
        url: SITE_URL + '/', description: 'Marketplace connecting buyers, verified sellers and eligible product promoters.' },
      { '@context': 'https://schema.org', '@type': 'WebSite', name: SITE_NAME, url: SITE_URL + '/' },
    ] : [], ...overrides,
  };
  seo.title = plainText(seo.title, 180);
  seo.description = plainText(seo.description, 220);
  seo.jsonLd = seo.schema?.length ? jsonForHtml(seo.schema.length === 1 ? seo.schema[0] : { '@context': 'https://schema.org', '@graph': seo.schema }) : '';
  return seo;
}
export function breadcrumbSchema(items, country) {
  return { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items.map(([name, path], index) => ({ '@type': 'ListItem', position: index + 1, name, item: canonicalUrl(path, country) })) };
}
export function productSeo(request, product) {
  const canonical = canonicalUrl('/products/' + encodeURIComponent(product.id), request.country?.code);
  const variants = product.variants?.length ? product.variants : [product];
  const images = (product.images?.length ? product.images : [product.image]).filter(Boolean).map(absoluteUrl);
  const offers = variants.filter(variant => Number.isFinite(Number(variant.price)) && Number(variant.price) > 0 && /^[A-Z]{3}$/.test(variant.currency || product.currency)).map(variant => ({
    '@type': 'Offer', priceCurrency: variant.currency || product.currency, price: String(variant.price),
    availability: Number(variant.stock) > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
    url: canonical, sku: variant.sku || undefined,
    seller: product.seller?.name ? { '@type': 'Organization', name: product.seller.name, url: canonicalUrl('/sellers/' + encodeURIComponent(product.seller.slug), request.country?.code) } : undefined,
  }));
  const schema = { '@context': 'https://schema.org', '@type': 'Product', '@id': canonical + '#product', url: canonical,
    name: product.name, description: plainText(product.description || product.subtitle || product.name, 5000), image: images,
    sku: product.sku || undefined, brand: product.brand && product.brand !== 'Independent' ? { '@type': 'Brand', name: product.brand } : undefined,
    offers: offers.length === 1 ? offers[0] : offers.length ? offers : undefined,
  };
  if (Number.isInteger(product.reviews) && product.reviews > 0 && product.rating >= 1 && product.rating <= 5) schema.aggregateRating = { '@type': 'AggregateRating', ratingValue: product.rating, reviewCount: product.reviews, bestRating: 5, worstRating: 1 };
  return pageSeo(request, { title: `${product.name} — Classic Mart${request.country?.name ? ' · ' + request.country.name : ''}`, description: product.description || product.subtitle || product.name,
    canonical, image: images[0] || '', imageAlt: product.imageAlt || product.name, type: 'product', noindex: hasDuplicateQuery(request),
    schema: [schema, breadcrumbSchema([['Home','/'],[product.categoryName || 'Products', '/categories/' + encodeURIComponent(product.category)], [product.name, '/products/' + encodeURIComponent(product.id)]], request.country?.code)],
  });
}
export function collectionSchema(request, title, items) {
  return { '@context': 'https://schema.org', '@type': 'CollectionPage', name: title, url: canonicalUrl(request.path, request.country?.code),
    mainEntity: { '@type': 'ItemList', itemListElement: items.slice(0, 100).map(([name, path], index) => ({ '@type': 'ListItem', position: index + 1, name, url: canonicalUrl(path, request.country?.code) })) } };
}
