import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { SellerVerification } from '../models/index.js';
import { liveAccountHeader } from './live-account-header.js';
import { getCountries } from '../services/country.js';
import { DASHBOARD_PAGES, routeForPage } from './registry.js';
import { allowedWorkspacesFor } from './access.js';

export async function renderSellerStore(request, response, { error = '', section = '', draft = {}, verificationFlow = null } = {}) {
  const [header, countries, verification] = await Promise.all([
    liveAccountHeader(request), getCountries(),
    SellerVerification.findOne({ storeId: request.store._id }).select('status sellerType legalName reviewReason').lean(),
  ]);
  const store = request.store.toObject();
  const phoneCountry = parsePhoneNumberFromString(store.operations?.supportPhone || '')?.country || store.country;
  const completion = Math.round([store.name, store.description, store.operations?.supportEmail, store.operations?.supportPhone].filter(Boolean).length / 4 * 100);
  return response.render('approved-dashboard', {
    ...header, customerRoutes: { ...header.customerRoutes, 'seller-store': '/seller/store' }, workspace: 'seller', initialPage: 'seller-store',
    allowedWorkspaces: allowedWorkspacesFor(request.user),
    liveSeller: { store, countries, verification, phoneCountry, completion, error, draft, verificationFlow, profileRole: 'Seller', section: section || request.query.section || 'identity',
      navigation: DASHBOARD_PAGES.seller.map(row => ({ id: row[0], label: row[1], icon: row[2], href: routeForPage(row[0]), ready: row[0] === 'seller-store' })),
    },
  });
}
