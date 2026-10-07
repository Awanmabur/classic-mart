import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { SellerVerification } from '../models/index.js';
import { customerLoyalty, customerWallet, customerCatalogue, customerCartBadge, customerUnread } from './customer-reads.js';
import { CUSTOMER_ROUTES } from './customer-routes.js';
import { getCountries } from '../services/country.js';
import { DASHBOARD_PAGES, routeForPage } from './registry.js';
import { allowedWorkspacesFor } from './access.js';

export async function renderSellerStore(request, response, { error = '', section = '', draft = {} } = {}) {
  const [loyalty, wallet, catalogue, cart, unread, countries, verification] = await Promise.all([
    customerLoyalty(request), customerWallet(request), customerCatalogue(request), customerCartBadge(request), customerUnread(request), getCountries(),
    SellerVerification.findOne({ storeId: request.store._id }).select('status sellerType legalName reviewReason').lean(),
  ]);
  const store = request.store.toObject();
  const phoneCountry = parsePhoneNumberFromString(store.operations?.supportPhone || '')?.country || store.country;
  const completion = Math.round([store.name, store.description, store.operations?.supportEmail, store.operations?.supportPhone].filter(Boolean).length / 4 * 100);
  return response.render('approved-dashboard', {
    customerRoutes: { ...CUSTOMER_ROUTES, 'seller-store': '/seller/store' }, workspace: 'seller', initialPage: 'seller-store',
    liveHeader: { points: Math.max(0, loyalty?.points || 0), balanceMinor: wallet.balanceMinor, tier: loyalty?.tier || 'Classic',
      wishlistCount: catalogue?.wishlistProductIds?.length || 0, cartCount: (cart?.items || []).reduce((sum, item) => sum + item.quantity, 0), unread },
    allowedWorkspaces: allowedWorkspacesFor(request.user),
    liveSeller: { store, countries, verification, phoneCountry, completion, error, draft, section: section || request.query.section || 'identity',
      navigation: DASHBOARD_PAGES.seller.map(row => ({ id: row[0], label: row[1], icon: row[2], href: routeForPage(row[0]), ready: row[0] === 'seller-store' })),
    },
  });
}
