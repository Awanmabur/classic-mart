import { searchStorefront } from './storefront.js';

// Links are maintained by the application, never supplied by a model or a caller.
const destinations = [
  { pattern: /\b(password|security|authenticator|mfa|passkey)\b/i, label: 'Account security', href: '/account/security', answer: 'Open Account security to manage your password and sign-in methods.' },
  { pattern: /\b(track|tracking|shipment|parcel)\b/i, label: 'Track an order', href: '/track-order', answer: 'Use Track an order with your order reference. Your account also shows your own orders.' },
  { pattern: /\b(wishlist|favourites|favorites)\b/i, label: 'Your wishlist', href: '/wishlist', answer: 'Your wishlist keeps the products you have saved. Open a listing to check its current price and availability.' },
  { pattern: /\b(address|addresses)\b/i, label: 'Saved addresses', href: '/addresses', answer: 'Open Saved addresses to review or update your delivery details. The address you choose at checkout determines the actual delivery options.' },
  { pattern: /\b(refund|return|damaged|cancel.*order)\b/i, label: 'Your orders', href: '/orders', answer: 'Open your order to see its available return, cancellation and support actions. Eligibility is checked on the order.' },
  { pattern: /\b(orders?|purchases?|receipts?)\b/i, label: 'Your orders', href: '/orders', answer: 'Your orders page shows the purchases belonging to your account, their status and available actions.' },
  { pattern: /\b(delivery|shipping|location|country|countries)\b/i, label: 'Delivery information', href: '/shipping', answer: 'Choose your shopping country at the top left and use Choose delivery location in the header. Delivery availability and charges are confirmed for your address at checkout.' },
  { pattern: /\b(sell|seller|store|vendor)\b/i, label: 'Sell on Classic Mart', href: '/signup?role=seller', answer: 'Start with a Seller account, then complete store setup and verification. Existing sellers can open their workspace.' },
  { pattern: /\b(wallet|balance|top.?up)\b/i, label: 'Your wallet', href: '/wallet', answer: 'Your wallet page shows your own balance and supported funding options. Check the details there before authorizing any payment.' },
  { pattern: /\b(cart|basket|checkout|payment|pay)\b/i, label: 'Your cart', href: '/cart', answer: 'Review your cart, quantities and delivery details before checkout. Current stock, prices and payment options are checked by the server.' },
  { pattern: /\b(support|contact|help.*account)\b/i, label: 'Help centre', href: '/help', answer: 'The Help centre explains marketplace workflows and how to contact support.' },
  { pattern: /\b(dashboard|workspace|account|profile)\b/i, label: 'Your workspace', href: '/dashboard', answer: 'Open your workspace for the pages available to your account and role. Protected actions still require your sign-in and authorization.' },
];
const stopWords = new Set('a an the i me my we our you your please can could would do does have has is are to for from of in on at and or with that this what which where want need find show buy looking look get product products item items available cost costs price prices how much under below less than maximum budget cheap cheapest affordable compare best some any'.split(' '));

export function guideIntent(message, currency = 'UGX') {
  const clean = String(message || '').trim().slice(0, 2000);
  const budget = clean.match(/\b(?:under|below|budget(?:\s+of)?|less\s+than|maximum|up\s+to)\s*(?:([A-Z]{3})\s*)?([\d,]+(?:\.\d+)?)\s*([km])?\b/i);
  const amount = budget ? Number(budget[2].replaceAll(',', '')) * ({ k: 1000, m: 1_000_000 }[budget[3]?.toLowerCase()] || 1) : null;
  const budgetCurrency = budget?.[1]?.toUpperCase();
  const currencyMismatch = Boolean(budgetCurrency && budgetCurrency !== currency);
  const query = clean.replace(budget?.[0] || /$^/, '').replace(/\b(?:UGX|KES|TZS|RWF|USD|EUR|GBP)\b/gi, '')
    .toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter(word => word && !stopWords.has(word)).join(' ').slice(0, 120);
  // Shopping questions take priority over incidental words such as "seller".
  const shopping = /\b(find|buy|price|cost|stock|compare|under|below|budget|looking|products?|items?)\b/i.test(clean);
  const destination = shopping ? null : destinations.find(item => item.pattern.test(clean));
  return { query, destination, maxPrice: Number.isFinite(amount) && amount > 0 && !currencyMismatch ? amount : null, currencyMismatch };
}

export async function platformGuide(request, message, { search = searchStorefront } = {}) {
  const country = request.country;
  const intent = guideIntent(message, country.currency);
  if (intent.destination) {
    const { label, href, answer } = intent.destination;
    return { answer, links: [{ label, href }], products: [], mode: 'platform_guide', aiGenerated: false, country: country.code };
  }
  if (/^(?:hi|hello|hey|help|what can you do)[!?.\s]*$/i.test(message.trim())) {
    return { answer: 'I can help you find products and current prices in your selected country, track orders, choose a delivery location or find the right account page. What would you like to do?', links: [{ label: 'Browse products', href: '/products' }, { label: 'Help centre', href: '/help' }], products: [], mode: 'platform_guide', aiGenerated: false, country: country.code };
  }
  const catalogue = await search(country, { query: intent.query });
  const products = catalogue.products.filter(product => product.currency === country.currency && Number.isFinite(product.price) && product.price > 0 && product.stock > 0 && (intent.maxPrice === null || product.price <= intent.maxPrice))
    .slice(0, 5).map(product => ({ id: product.id, name: product.name, price: product.price, currency: product.currency, stock: product.stock,
      href: `/products/${encodeURIComponent(product.id)}?country=${encodeURIComponent(country.code)}`, seller: product.seller?.name || '' }));
  const money = value => new Intl.NumberFormat(country.locale || 'en', { style: 'currency', currency: country.currency }).format(value);
  let answer = products.length ? `Here are ${products.length} in-stock matches in ${country.name || country.code}${intent.maxPrice !== null ? ` within ${money(intent.maxPrice)}` : ''}. ${products.slice(0, 3).map(product => `${product.name}: ${money(product.price)}`).join('. ')}. Open a listing for its full details; the final price and delivery are confirmed at checkout.`
    : `I could not find an in-stock match in ${country.name || country.code}${intent.maxPrice !== null ? ' within that budget' : ''}. Try a product name, brand or category, or change your shopping country at the top left.`;
  if (intent.currencyMismatch) answer += ` This market uses ${country.currency}; I have not converted or applied a budget in another currency.`;
  return { answer, links: [{ label: 'See catalogue results', href: `/products?${new URLSearchParams({ q: intent.query, country: country.code })}` }, { label: 'Ask Classic AI', href: '/ask-classic' }], products, mode: 'catalogue_guide', aiGenerated: false, country: country.code };
}
