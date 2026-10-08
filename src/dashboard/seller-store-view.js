import { getPhoneCountries } from '../services/phone-countries.js';
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { SellerVerification } from '../models/index.js';
import { liveAccountHeader } from './live-account-header.js';
import { getCountries } from '../services/country.js';
import { sellerNavigation, SELLER_LIVE_ROUTES } from './seller-navigation.js';
import { allowedWorkspacesFor } from './access.js';

export async function renderSellerStore(request, response, { error = '', section = '', draft = {}, verificationFlow = null } = {}) {
  const [header, countries, verification] = await Promise.all([
    liveAccountHeader(request), getCountries(),
    SellerVerification.findOne({ storeId: request.store._id }).select('status sellerType legalName reviewReason').lean(),
  ]);
  const store = request.store.toObject();
  const supportPhone = parsePhoneNumberFromString(store.operations?.supportPhone || '');
  const phoneCountry = supportPhone?.country || store.country;
  const completion = Math.round([store.name, store.description, store.operations?.supportEmail, store.operations?.supportPhone].filter(Boolean).length / 4 * 100);
  return response.render('approved-dashboard', {
    ...header, customerRoutes: { ...header.customerRoutes, ...SELLER_LIVE_ROUTES }, workspace: 'seller', initialPage: 'seller-store',
    allowedWorkspaces: allowedWorkspacesFor(request.user),
    liveSeller: { store, countries, phoneCountries: getPhoneCountries(), verification, phoneCountry, supportPhoneNational: supportPhone?.nationalNumber || store.operations?.supportPhone || '', completion, error, draft, verificationFlow, profileRole: 'Seller', section: section || request.query.section || 'identity',
      navigation: sellerNavigation(request),
    },
  });
}
