import { AppError } from '../core/errors.js';
import {
  AuditLog,
  Chargeback,
  LedgerAccount,
  LedgerTransaction,
  Order,
  PaymentIntent,
  Payout,
  PayoutAccount,
  ProviderEvent,
  ReconciliationRun,
  Refund,
  Shipment,
} from '../models/index.js';
import { operationalCountriesFor } from './authorization.js';

const PAYMENT_STATUSES = ['created','requires_action','pending','succeeded','failed','cancelled','pending_collection','refunded','partially_refunded','reversed'];
const PAYMENT_PROVIDERS = ['pesapal','cod','sandbox'];
const REFUND_STATUSES = ['pending','processing','completed','failed','cancelled'];
const PAYOUT_STATUSES = ['requested','approved','submitting','submitted','unknown','paid','failed','rejected'];
const EVENT_STATUSES = ['received','processing','processed','ignored','failed','dead'];
const CHARGEBACK_STATUSES = ['open','reviewing','won','lost'];
const RECONCILIATION_STATUSES = ['running','completed','failed'];

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sum(rows, field) {
  return rows.reduce((total, row) => total + Number(row?.[field] || 0), 0);
}

function countBy(rows, field) {
  const result = {};
  for (const row of rows) {
    const key = String(row?.[field] || 'unknown');
    result[key] = (result[key] || 0) + 1;
  }
  return result;
}

function filtersFor(query = {}) {
  return {
    requestedCountry: String(query.country || '').trim().toUpperCase(),
    paymentStatus: PAYMENT_STATUSES.includes(String(query.paymentStatus || '')) ? String(query.paymentStatus) : '',
    paymentProvider: PAYMENT_PROVIDERS.includes(String(query.paymentProvider || '')) ? String(query.paymentProvider) : '',
    refundStatus: REFUND_STATUSES.includes(String(query.refundStatus || '')) ? String(query.refundStatus) : '',
    payoutStatus: PAYOUT_STATUSES.includes(String(query.payoutStatus || '')) ? String(query.payoutStatus) : '',
    providerEventStatus: EVENT_STATUSES.includes(String(query.providerEventStatus || '')) ? String(query.providerEventStatus) : '',
    chargebackStatus: CHARGEBACK_STATUSES.includes(String(query.chargebackStatus || '')) ? String(query.chargebackStatus) : '',
    reconciliationStatus: RECONCILIATION_STATUSES.includes(String(query.reconciliationStatus || '')) ? String(query.reconciliationStatus) : '',
    paymentSearch: String(query.paymentSearch || '').trim().slice(0, 180),
    providerEventSearch: String(query.providerEventSearch || query.paymentSearch || '').trim().slice(0, 180),
    refundSearch: String(query.refundSearch || '').trim().slice(0, 180),
    payoutSearch: String(query.payoutSearch || '').trim().slice(0, 180),
    chargebackSearch: String(query.chargebackSearch || '').trim().slice(0, 180),
  };
}

function financeCountryContext(user, requestedCountry = '') {
  const scopes = operationalCountriesFor(user);
  const allowedCountries = scopes.includes('*') ? [] : scopes;
  const requested = String(requestedCountry || '').trim().toUpperCase();
  if (requested && !/^[A-Z]{2}$/.test(requested)) throw new AppError('Choose a valid two-letter finance country.', 422, 'FINANCE_COUNTRY_INVALID');
  if (requested) {
    if (!scopes.includes('*') && !allowedCountries.includes(requested)) throw new AppError('Finance country is outside your operational scope.', 403, 'FINANCE_COUNTRY_FORBIDDEN');
    return { allowedCountries, countryScope: { country: requested } };
  }
  if (scopes.includes('*')) return { allowedCountries, countryScope: {} };
  return { allowedCountries, countryScope: { country: { $in: allowedCountries } } };
}

function searchPattern(value) {
  return value ? new RegExp(escapeRegex(value), 'i') : null;
}

async function ledgerBalances(countryScope) {
  const accounts = await LedgerAccount.find(countryScope)
    .select('publicId code type ownerType ownerPublicId country currency active')
    .sort({ country: 1, currency: 1, code: 1 }).limit(160).lean();
  const ids = accounts.map((row) => row._id);
  if (!ids.length) return accounts.map((row) => ({ ...row, debitMinor: 0, creditMinor: 0, balanceMinor: 0 }));
  const totals = await LedgerTransaction.aggregate([
    { $match: { ...countryScope, 'entries.accountId': { $in: ids } } },
    { $unwind: '$entries' },
    { $match: { 'entries.accountId': { $in: ids } } },
    { $group: { _id: '$entries.accountId', debitMinor: { $sum: '$entries.debitMinor' }, creditMinor: { $sum: '$entries.creditMinor' } } },
  ]);
  const byId = new Map(totals.map((row) => [String(row._id), row]));
  return accounts.map((row) => {
    const values = byId.get(String(row._id)) || { debitMinor: 0, creditMinor: 0 };
    const debitMinor = Number(values.debitMinor || 0);
    const creditMinor = Number(values.creditMinor || 0);
    const balanceMinor = ['asset','expense'].includes(row.type) ? debitMinor - creditMinor : creditMinor - debitMinor;
    return { ...row, debitMinor, creditMinor, balanceMinor };
  });
}

export async function loadFinanceDashboard(request) {
  const user = request.user;
  const filters = filtersFor(request.query || {});
  const { allowedCountries, countryScope } = financeCountryContext(user, filters.requestedCountry);
  const paymentSearch = filters.paymentSearch;
  const providerEventSearch = filters.providerEventSearch;
  const paymentQuery = { ...countryScope };
  if (filters.paymentStatus) paymentQuery.status = filters.paymentStatus;
  if (filters.paymentProvider) paymentQuery.provider = filters.paymentProvider;
  if (paymentSearch) {
    const pattern = searchPattern(paymentSearch);
    paymentQuery.$or = [
      { publicId: pattern }, { orderPublicId: pattern }, { traceId: pattern }, { providerReference: pattern },
      { providerTrackingId: pattern }, { providerTransactionId: pattern }, { providerConfirmationCode: pattern },
    ];
  }
  const providerEventQuery = { provider: 'pesapal', ...countryScope };
  if (filters.providerEventStatus) providerEventQuery.status = filters.providerEventStatus;
  if (providerEventSearch) {
    const pattern = searchPattern(providerEventSearch);
    providerEventQuery.$or = [
      { publicId: pattern }, { eventId: pattern }, { traceId: pattern }, { orderPublicId: pattern },
      { paymentIntentPublicId: pattern }, { merchantReference: pattern }, { providerTrackingId: pattern },
    ];
  }

  const [countryOrderIds, payoutAccountIds] = await Promise.all([
    Order.find(countryScope).distinct('_id'),
    PayoutAccount.find(countryScope).distinct('_id'),
  ]);
  const refundQuery = { orderId: { $in: countryOrderIds } };
  if (filters.refundStatus) refundQuery.status = filters.refundStatus;
  if (filters.refundSearch) {
    const pattern = searchPattern(filters.refundSearch);
    refundQuery.$or = [{ publicId: pattern }, { providerRefundId: pattern }, { manualReference: pattern }];
  }
  const payoutQuery = { payoutAccountId: { $in: payoutAccountIds } };
  if (filters.payoutStatus) payoutQuery.status = filters.payoutStatus;
  if (filters.payoutSearch) {
    const pattern = searchPattern(filters.payoutSearch);
    payoutQuery.$or = [{ publicId: pattern }, { providerReference: pattern }, { ownerStorePublicId: pattern }];
  }
  const chargebackQuery = { ...countryScope };
  if (filters.chargebackStatus) chargebackQuery.status = filters.chargebackStatus;
  if (filters.chargebackSearch) {
    const pattern = searchPattern(filters.chargebackSearch);
    chargebackQuery.$or = [{ publicId: pattern }, { orderPublicId: pattern }, { paymentIntentPublicId: pattern }, { providerTrackingId: pattern }, { providerReference: pattern }];
  }
  const reconciliationQuery = { ...countryScope };
  if (filters.reconciliationStatus) reconciliationQuery.status = filters.reconciliationStatus;

  const [
    payments,
    providerEvents,
    refunds,
    payouts,
    payoutAccounts,
    reconciliations,
    chargebacks,
    accounts,
    ledgerTransactions,
    auditLogs,
    codShipments,
    paymentCount,
    failedPaymentCount,
    providerExceptionCount,
    staleRefundCount,
    payoutUnknownCount,
    openChargebackCount,
    reconciliationExceptionCount,
  ] = await Promise.all([
    PaymentIntent.find(paymentQuery).select('publicId traceId orderPublicId country provider method status amountMinor refundReservedMinor refundedMinor currency providerReference providerTrackingId providerTransactionId providerConfirmationCode providerStatus failureCode failureMessage paidAt lastVerifiedAt createdAt updatedAt').sort({ createdAt: -1 }).limit(120).lean(),
    ProviderEvent.find(providerEventQuery).select('publicId eventId traceId orderPublicId paymentIntentPublicId merchantReference providerTrackingId country eventType status attempts nextAttemptAt error manualReplayCount lastManualReplayAt createdAt').sort({ createdAt: -1 }).limit(80).lean(),
    Refund.find(refundQuery).select('publicId orderId paymentIntentId amountMinor currency reason provider providerStatus providerMessage providerRefundId manualReference status completedAt createdAt updatedAt').sort({ createdAt: -1 }).limit(100).lean(),
    Payout.find(payoutQuery).select('publicId ownerUserId ownerStorePublicId requestedByUserId payoutAccountId amountMinor currency status requestedAt approvedByUserId approvedAt submittedByUserId submissionStartedAt submittedAt submissionAttemptId unknownAt ambiguityReason completedAt providerReference failureMessage createdAt updatedAt').populate('payoutAccountId','publicId ownerType country currency method label status verifiedAt').populate('requestedByUserId','publicId name').populate('approvedByUserId','publicId name').sort({ requestedAt: -1, createdAt: -1 }).limit(100).lean(),
    PayoutAccount.find(countryScope).select('publicId ownerUserId ownerStorePublicId ownerType country currency method label verifiedAt status createdAt').sort({ createdAt: -1 }).limit(100).lean(),
    ReconciliationRun.find(reconciliationQuery).select('publicId country provider businessDate currency expectedAmountMinor declaredAmountMinor status checked matched updated failed startedAt completedAt createdAt').sort({ createdAt: -1 }).limit(80).lean(),
    Chargeback.find(chargebackQuery).select('publicId orderPublicId paymentIntentPublicId providerTrackingId providerReference country currency amountMinor status reviewedAt reviewNote resolvedAt resolutionNote openedAt createdAt updatedAt').sort({ openedAt: -1, createdAt: -1 }).limit(100).lean(),
    ledgerBalances(countryScope),
    LedgerTransaction.find(countryScope).select('publicId traceId referenceType referencePublicId country currency description entries postedAt createdAt').sort({ postedAt: -1 }).limit(120).lean(),
    AuditLog.find({ ...countryScope, action: /^finance\./ }).select('requestId actorPublicId action targetType targetPublicId country result metadata createdAt').sort({ createdAt: -1 }).limit(120).lean(),
    Shipment.find({ ...countryScope, kind: 'outbound', status: 'delivered', 'cod.required': true, 'cod.reconciledAt': null }).select('publicId orderPublicId country cod deliveredAt').sort({ deliveredAt: 1 }).limit(80).lean(),
    PaymentIntent.countDocuments(paymentQuery),
    PaymentIntent.countDocuments({ ...countryScope, status: 'failed' }),
    ProviderEvent.countDocuments({ ...countryScope, provider: 'pesapal', status: { $in: ['failed','dead'] } }),
    Refund.countDocuments({ orderId: { $in: countryOrderIds }, status: 'processing', updatedAt: { $lt: new Date(Date.now() - (2 * 60 * 60 * 1000)) } }),
    Payout.countDocuments({ payoutAccountId: { $in: payoutAccountIds }, status: 'unknown' }),
    Chargeback.countDocuments({ ...countryScope, status: { $in: ['open','reviewing'] } }),
    ReconciliationRun.countDocuments({ ...countryScope, $or: [{ status: 'failed' }, { failed: { $gt: 0 } }] }),
  ]);

  const exceptionCount = providerExceptionCount + staleRefundCount + payoutUnknownCount + openChargebackCount + reconciliationExceptionCount;
  return {
    user: {
      publicId: user.publicId,
      name: user.name,
      email: user.email,
      role: user.role,
      country: user.country,
      currency: user.currency,
      preferences: user.preferences?.dashboard || {},
    },
    operationalCountries: operationalCountriesFor(user),
    allowedCountries,
    filters,
    payments,
    providerEvents,
    refunds,
    payouts,
    payoutAccounts,
    reconciliations,
    chargebacks,
    accounts,
    ledgerTransactions,
    auditLogs,
    codShipments,
    summary: {
      paymentCount,
      failedPaymentCount,
      capturedMinor: sum(payments.filter((row) => row.status === 'succeeded'), 'amountMinor'),
      refundMinor: sum(refunds.filter((row) => row.status === 'completed'), 'amountMinor'),
      payoutMinor: sum(payouts.filter((row) => ['submitted','paid'].includes(row.status)), 'amountMinor'),
      providerExceptionCount,
      staleRefundCount,
      payoutUnknownCount,
      openChargebackCount,
      reconciliationExceptionCount,
      exceptionCount,
      pendingPayoutAccounts: payoutAccounts.filter((row) => row.status === 'pending').length,
      pendingCodCount: codShipments.length,
    },
    reports: {
      paymentStatusCounts: countBy(payments, 'status'),
      refundStatusCounts: countBy(refunds, 'status'),
      payoutStatusCounts: countBy(payouts, 'status'),
      chargebackStatusCounts: countBy(chargebacks, 'status'),
      reconciliationStatusCounts: countBy(reconciliations, 'status'),
    },
  };
}
