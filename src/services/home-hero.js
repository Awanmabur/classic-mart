const MAX_SLIDES = 6;
const PUBLIC_ORIGIN = 'https://classicmart.invalid';
const PLACEHOLDER = '/assets/product-placeholder.svg';

function text(value, limit) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, limit) : '';
}

function publicImage(value) {
  if (typeof value !== 'string' || value.length > 800 || /[\\\u0000-\u0020\u007f]/.test(value)
    || value.includes('..') || value.includes('//') || !/^\/(?:assets|media)\//.test(value)
    || /%(?:2e|2f|5c)/i.test(value)) return '';
  try {
    const url = new URL(value, PUBLIC_ORIGIN);
    return url.origin === PUBLIC_ORIGIN && !url.hash && !url.pathname.includes('..') ? value : '';
  } catch { return ''; }
}

function destination(path, country, category) {
  const query = new URLSearchParams();
  if (/^[A-Z]{2}$/.test(country || '')) query.set('country', country);
  if (category) query.set('category', category);
  return path + (query.size ? '?' + query : '');
}

/** A published editorial carousel wins. Without it, use the existing public
 * catalogue projection: publication, seller, market, price and media eligibility
 * are resolved by getStorefront before this presentation-only selection runs.
 * It creates no CMS records, stock, discounts or product claims.
 */
export function homeHero({ publishedSlides = [], catalogue = {}, country = catalogue.country } = {}) {
  const market = text(country?.code, 2).toUpperCase();
  const currency = text(country?.currency, 3).toUpperCase();
  const categories = new Set((Array.isArray(catalogue.categories) ? catalogue.categories : [])
    .map(row => row?.id).filter(value => typeof value === 'string'));
  const products = [];
  const productIds = new Set();
  for (const row of Array.isArray(catalogue.products) ? catalogue.products : []) {
    if (!row || !/^[A-Za-z0-9_-]{1,160}$/.test(row.id || '') || !text(row.name, 180)
      || !Number.isFinite(row.stock) || row.stock <= 0 || !Number.isFinite(row.price) || row.price <= 0
      || (currency && row.currency !== currency) || (row.status && row.status !== 'published')
      || productIds.has(row.id)) continue;
    productIds.add(row.id);
    products.push(row);
  }

  const byKey = new Map();
  for (const row of Array.isArray(publishedSlides) ? publishedSlides : []) {
    if (!row || row.type !== 'hero' || !/^home\.hero\.[a-z0-9][a-z0-9._-]{0,109}$/.test(row.key || '')
      || !Number.isSafeInteger(row.version) || row.version < 1 || !text(row.title, 180)
      || !['', market].includes(row.country || '')) continue;
    const previous = byKey.get(row.key);
    if (previous?.country === market && market) continue;
    byKey.set(row.key, row);
  }
  if (byKey.size) {
    const slides = [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key)).slice(0, MAX_SLIDES).map(row => {
      const category = categories.has(row.data?.category) ? row.data.category : '';
      const illustration = products.find(product => !category || product.category === category);
      return {
        key: row.key, title: text(row.title, 180), body: text(row.body, 500),
        data: {
          eyebrow: text(row.data?.eyebrow, 100) || 'Classic Mart',
          action: text(row.data?.action, 100) || 'Browse products',
          image: publicImage(row.data?.image) || publicImage(illustration?.image) || PLACEHOLDER,
          category,
          href: destination('/products', market, category),
        },
      };
    });
    return { source: 'cms', slides };
  }

  const slides = products.slice(0, MAX_SLIDES).map(product => ({
    key: product.id, title: text(product.name, 180),
    body: text(product.description, 220) || `Explore the current details and availability for ${text(product.name, 180)}.`,
    data: {
      eyebrow: text(product.categoryName, 100) || 'Featured products',
      action: 'View product', category: text(product.category, 100),
      image: publicImage(product.image) || PLACEHOLDER,
      href: destination('/products/' + encodeURIComponent(product.id), market),
    },
  }));
  return { source: slides.length ? 'catalogue' : 'empty', slides };
}
