import { CustomerAddress } from '../models/CustomerAddress.js';
import { CountrySetting } from '../models/CountrySetting.js';
import { AppError } from '../core/errors.js';
import { currentCustomerAccess } from './customer-access.js';
import { customerRewardSummary } from './customer-rewards.js';

export async function checkoutProfile(request) {
  const actor = await currentCustomerAccess(request);
  const setting = await CountrySetting.findOne({ code: request.country.code, active: true }).lean();
  if (!setting) throw new AppError('The selected marketplace is unavailable.', 409, 'COUNTRY_UNAVAILABLE');
  const [addresses, benefits] = await Promise.all([
    CustomerAddress.find({ userId: actor._id, country: setting.code, archivedAt: null }).sort({ isDefault: -1, updatedAt: -1, _id: -1 }).limit(50).lean(),
    customerRewardSummary({ userId: actor._id, country: setting.code, currency: setting.currency, setting }),
  ]);
  return {
    contact: { fullName: actor.name, email: actor.email, phone: actor.phone },
    country: { code: setting.code, name: request.country.name, currency: setting.currency },
    addresses: addresses.map(row => ({ id: row.publicId, version: row.__v || 0, label: row.label, fullName: row.fullName,
      phone: row.phone, address: row.address, city: row.city, country: row.country, note: row.note, isDefault: row.isDefault })),
    rewards: benefits.benefitsPaused ? [] : benefits.rewards.filter(row => row.status === 'issued' && ['voucher', 'shipping'].includes(row.kind)),
    benefitsPaused: benefits.benefitsPaused,
  };
}
