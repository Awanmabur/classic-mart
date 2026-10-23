import { sellerOperationsAccess } from './seller-operations-access.js';
import { assertSellerAnalytics } from './seller-entitlements.js';
import { sellerOverviewWindow } from './seller-overview.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { env } from '../config/env.js';
import { AppError } from '../core/errors.js';
import { CountrySetting, LedgerAccount, Payout, PayoutAccount, Store, StoreMember, User } from '../models/index.js';
import { storeCapabilities } from './store.js';
import { accountBalanceMinor } from './money.js';
import { sellerFinanceStatement } from './seller-finance.js';
import { loadSellerOverview } from './seller-overview.js';
import { cursorScope, cursorSort, pageResult } from './pagination.js';
import { requestPayout, savePayoutAccount } from './payments.js';
import { formatMinorUnits } from './catalogue.js';

const PAYOUT_STATUSES = ['requested', 'approved', 'submitting', 'submitted', 'unknown', 'paid', 'failed', 'rejected'];
const integer = value => {
  if (!Number.isSafeInteger(value)) throw new AppError('Seller finance amounts are unavailable.', 500, 'SELLER_FINANCE_INVALID');
  return value;
};
const statusLabel = value => String(value || '').replaceAll('_', ' ');
const publicStore = store => ({ publicId: store.publicId, name: store.name, country: store.country, currency: store.currency, status: store.status });
const publicPayout = row => ({ publicId: row.publicId, amountMinor: row.amountMinor, currency: row.currency,
  status: row.status, requestedAt: row.requestedAt, createdAt: row.createdAt, completedAt: row.completedAt });
const publicAccount = row => ({ publicId: row.publicId, label: row.label, method: row.method, status: row.status,
  country: row.country, currency: row.currency, createdAt: row.createdAt });
function scopedPaymentRequest(request, store) {
  // Pin the generic payments service to the freshly authorized store even
  // when a direct service caller has no persisted session.
  return Object.assign(Object.create(request), { session: { ...request.session, activeStorePublicId: store.publicId } });
}

/** Fresh authorization also protects direct service callers and mutations. */
export async function sellerFinanceAccess(request) {
  if (!request.user?._id || !request.store?._id) throw new AppError('Seller authentication is required.', 401, 'UNAUTHENTICATED');
  const [actor, store, member] = await Promise.all([
    User.findById(request.user._id).select('status security.tokenVersion security.mfaEnabled emailVerifiedAt onboardingCompletedAt').lean(),
    Store.findById(request.store._id),
    StoreMember.findOne({ storeId: request.store._id, userId: request.user._id, status: 'active' }).lean(),
  ]);
  if (!actor || actor.status !== 'active' || actor.security.tokenVersion !== request.user.security?.tokenVersion
    || (request.session?.tokenVersion !== undefined && request.session.tokenVersion !== actor.security.tokenVersion)) {
    throw new AppError('Your account or session is unavailable.', 403, 'ACCOUNT_UNAVAILABLE');
  }
  if (!env.auth.simpleLogin && (!actor.emailVerifiedAt || !actor.onboardingCompletedAt)) {
    throw new AppError('Complete account verification and onboarding first.', 403, 'ACCOUNT_UNAVAILABLE');
  }
  if (!env.auth.simpleLogin && env.security.privilegedMfaRequired && !actor.security.mfaEnabled) {
    throw new AppError('Authenticator enrollment is required for store operations.', 403, 'MFA_ENROLLMENT_REQUIRED');
  }
  const capabilities = storeCapabilities(member?.role);
  if (!member || (!capabilities.has('*') && !capabilities.has('finance'))) throw new AppError('Your store role cannot access finance.', 403, 'STORE_PERMISSION_DENIED');
  if (!store || !['pending_verification', 'verified'].includes(store.status)) throw new AppError('This store is unavailable.', 409, 'STORE_LOCKED');
  const country = await CountrySetting.findOne({ code: store.country, active: true }).select('currency timeZone').lean();
  if (!country || country.currency !== store.currency) throw new AppError('The store country and currency need configuration.', 409, 'SELLER_COUNTRY_UNAVAILABLE');
  if (request.session) request.session.activeStorePublicId = store.publicId;
  request.store = store;
  request.storeMembership = member;
  return { store, member, country };
}

function queryInput(query = {}) {
  const input = z.object({ search: z.string().trim().max(100).default(''), q: z.string().trim().max(100).optional(), status: z.enum(['all', ...PAYOUT_STATUSES]).default('all'),
    after: z.string().max(512).default('') }).parse(query);
  return { ...input, q: input.q ?? input.search };
}

export async function loadSellerFinancePage(request, pageId) {
  const { store, country } = await sellerFinanceAccess(request);
  const query = queryInput(request.query);
  const money = value => formatMinorUnits(integer(value), store.currency, request.user.locale);
  const date = value => value ? new Intl.DateTimeFormat(request.user.locale || 'en', { timeZone: country.timeZone, dateStyle: 'medium' }).format(new Date(value)) : '—';
  const payable = await LedgerAccount.findOne({ code: 'seller_payable', ownerType: 'store', ownerPublicId: store.publicId,
    country: store.country, currency: store.currency, active: true }).select('_id type').lean();
  const availableMinor = payable ? integer(await accountBalanceMinor(payable._id, null, payable.type)) : 0;
  const finance = await sellerFinanceStatement({ store, activityCursor: pageId === 'seller-earnings' ? query.after : '', activitySearch: pageId === 'seller-earnings' ? query.q : '', limit: 25 });
  const payoutBase = { ownerStoreId: store._id, currency: store.currency };
  if (query.status !== 'all') payoutBase.status = query.status;
  if (query.q) payoutBase.publicId = new RegExp(query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const [accounts, payoutRows, payoutTotal] = pageId === 'seller-payouts' ? await Promise.all([
    PayoutAccount.find({ ownerStoreId: store._id, ownerType: 'seller', country: store.country, currency: store.currency })
      .select('publicId label method status country currency createdAt').sort({ createdAt: -1, _id: -1 }).lean(),
    Payout.find(cursorScope(payoutBase, query.after)).select('publicId amountMinor currency status requestedAt createdAt completedAt')
      .sort(cursorSort()).limit(26).lean(),
    Payout.countDocuments(payoutBase),
  ]) : [[], [], 0];
  const payoutResult = pageResult(payoutRows, { limit: 25, total: payoutTotal });
  const payoutAccounts = accounts.map(publicAccount), payouts = payoutResult.items.map(publicPayout);
  const payoutPage = pageId === 'seller-payouts';
  const base = payoutPage ? '/seller/payouts' : '/seller/earnings';
  const pagination = payoutPage ? payoutResult.page : finance.activity.page;
  const nextQuery = new URLSearchParams({ q: query.q, status: query.status, after: pagination.next });
  const verified = payoutAccounts.filter(row => row.status === 'verified').length;
  return {
    kind: 'finance', pageId, store: publicStore(store), currency: store.currency, availableMinor, finance, payoutAccounts, payouts,
    idempotencyKey: payoutPage ? randomUUID() : '',
    metrics: [
      { label: 'Available balance', value: money(availableMinor), detail: 'Store payable ledger after payout reservations' },
      { label: 'Payouts in progress', value: money(finance.inFlightPayoutMinor), detail: 'Requested through submitted and unknown payouts' },
      { label: 'Completed payouts', value: money(finance.paidPayoutMinor), detail: 'Payouts recorded as paid' },
      { label: 'Refund reversals', value: money(finance.completedRefundSellerMinor), detail: 'Completed store receivable reversals' },
    ],
    columns: payoutPage ? ['Payout', 'Requested', 'Amount', 'Currency', 'Status'] : ['Transaction', 'Recorded', 'Reference', 'Payable change', 'Status'],
    rows: payoutPage ? payouts.map(row => ({ id: row.publicId, cells: [row.publicId, date(row.requestedAt || row.createdAt), money(row.amountMinor), row.currency, statusLabel(row.status)] }))
      : finance.activity.items.map(row => ({ id: row.publicId, cells: [row.publicId, date(row.createdAt), row.referencePublicId || row.referenceType, money(row.deltaMinor), 'Recorded'] })),
    insights: [
      { text: finance.unknownPayoutCount ? `${finance.unknownPayoutCount} payouts await reconciliation before their outcome is known.` : 'Review ledger activity and payout status before requesting funds.', href: '/seller/payouts', label: 'Review payouts' },
      { text: finance.profitability.summary.totalUnknownCostUnits ? `${finance.profitability.summary.totalUnknownCostUnits} sold units have no historical cost snapshot; contribution excludes those units.` : 'Contribution reports use captured order costs and completed refund reversals.', href: '/seller/earnings/contribution.csv', label: 'Download contribution report' },
    ],
    health: { value: null, label: 'Settlement status', rows: [
      { label: 'Currency', value: store.currency }, { label: 'Unknown payouts', value: String(finance.unknownPayoutCount) },
      { label: payoutPage ? 'Verified destinations' : 'Ledger transactions', value: String(payoutPage ? verified : finance.activity.page.total) },
    ] },
    workflow: [
      { title: 'Review earnings', text: 'Download recorded changes to your store payable balance.', href: '/seller/earnings/ledger.csv', label: 'Download ledger' },
      { title: 'Manage payouts', text: 'Add a destination for verification, then request an amount within the available balance.', href: '/seller/payouts#seller-payout-request', label: 'Request payout' },
    ],
    create: { label: payoutPage ? 'Add payout destination' : 'Download ledger', href: payoutPage ? '#seller-payout-destination' : '/seller/earnings/ledger.csv' },
    exportHref: '/seller/earnings/ledger.csv',
    filters: { search: query.q, after: query.after, status: query.status, statuses: payoutPage ? [{ value: 'all', label: 'All payouts' }, ...PAYOUT_STATUSES.map(value => ({ value, label: statusLabel(value) }))] : [] },
    pagination: { ...pagination, nextHref: pagination.hasMore ? `${base}?${nextQuery}` : '' },
    page: pagination,
  };
}

/** Convert entered major units exactly; never silently round a payout. */
export function sellerPayoutAmount(value, currency) {
  const raw = z.string().trim().min(1).max(30).parse(value);
  const fractionDigits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
  const pattern = fractionDigits ? new RegExp(`^\\d+(?:\\.\\d{1,${fractionDigits}})?$`) : /^\d+$/;
  if (!pattern.test(raw)) throw new AppError(`Enter a positive ${currency} amount with up to ${fractionDigits} decimal places.`, 422, 'PAYOUT_AMOUNT_INVALID');
  const [whole, fraction = ''] = raw.split('.');
  const minor = BigInt(whole) * (10n ** BigInt(fractionDigits)) + BigInt(fraction.padEnd(fractionDigits, '0') || '0');
  if (minor < 1n || minor > 2_000_000_000n) throw new AppError('Enter a supported positive payout amount.', 422, 'PAYOUT_AMOUNT_INVALID');
  return Number(minor);
}

export async function createSellerPayoutDestination(request, body) {
  const { store } = await sellerFinanceAccess(request);
  const paymentRequest = scopedPaymentRequest(request, store);
  const input = z.object({ method: z.enum(['mobile_money', 'bank']), label: z.string().trim().min(2).max(100),
    beneficiary_name: z.string().trim().min(2).max(120), network: z.string().trim().max(40).default(''),
    account_bank: z.string().trim().max(40).default(''), account_number: z.string().trim().max(80).default(''),
    phone: z.string().trim().max(32).default('') }).parse(body);
  if (input.method === 'bank' && (input.account_bank.length < 2 || input.account_number.length < 4)) throw new AppError('Bank and account number are required.', 422, 'PAYOUT_DESTINATION_INVALID');
  if (input.method === 'mobile_money' && (input.network.length < 2 || input.phone.length < 7)) throw new AppError('Mobile-money network and phone are required.', 422, 'PAYOUT_DESTINATION_INVALID');
  const destination = input.method === 'bank' ? { beneficiary_name: input.beneficiary_name, account_bank: input.account_bank, account_number: input.account_number }
    : { beneficiary_name: input.beneficiary_name, network: input.network, phone: input.phone };
  return publicAccount(await savePayoutAccount(paymentRequest, { method: input.method, label: input.label, destination }));
}

export async function requestSellerPayout(request, body) {
  const { store } = await sellerFinanceAccess(request);
  const paymentRequest = scopedPaymentRequest(request, store);
  const input = z.object({ payoutAccountId: z.string().trim().min(4).max(100), amount: z.string().optional(),
    amountMinor: z.coerce.number().int().positive().max(2_000_000_000).optional(), idempotencyKey: z.string().trim().min(8).max(120) }).parse(body);
  if ((input.amount === undefined) === (input.amountMinor === undefined)) throw new AppError('Provide one payout amount.', 422, 'PAYOUT_AMOUNT_INVALID');
  const amountMinor = input.amount === undefined ? input.amountMinor : sellerPayoutAmount(input.amount, store.currency);
  const payout = await requestPayout(paymentRequest, { payoutAccountId: input.payoutAccountId, amountMinor, idempotencyKey: input.idempotencyKey });
  if (String(payout.ownerStoreId) !== String(store._id) || payout.amountMinor !== amountMinor) {
    throw new AppError('This request key already belongs to a different payout.', 409, 'PAYOUT_IDEMPOTENCY_CONFLICT');
  }
  return publicPayout(payout);
}

export async function loadSellerAnalyticsPage(request, { period = '30days', now = new Date(), export: exporting = false } = {}) {
  const context = await sellerOperationsAccess(request, 'analytics');
  const window = sellerOverviewWindow(period, context.country.timeZone, now);
  const entitlements = await assertSellerAnalytics(context.store, { export: exporting, from: window.start, to: now });
  const overview = await loadSellerOverview(request, { period, now });
  const current = await sellerOperationsAccess(request, 'analytics');
  await assertSellerAnalytics(current.store, { export: exporting, from: window.start, to: now });
  const money = value => formatMinorUnits(integer(value), overview.store.currency, request.user.locale);
  return { kind: 'analytics', pageId: 'seller-analytics', store: overview.store, currency: overview.store.currency,
    period: overview.period, timeZone: overview.timeZone, range: overview.range,
    trend: overview.trend.map(row => ({ ...row, value: row.paidMinor, display: money(row.paidMinor) })), analytics: overview.metrics,
    trendDescription: `Verified paid item sales · ${overview.store.currency} · ${overview.timeZone}`,
    trendSummary: money(overview.metrics.paidMinor), exportHref: entitlements.analyticsExport ? `/seller/analytics/summary.csv?period=${period}` : '',
    metrics: [
      { label: 'Paid item sales', value: money(overview.metrics.paidMinor), detail: 'Verified paid orders in the selected period' },
      { label: 'Completed refunds', value: money(overview.metrics.refundMinor), detail: 'Item refunds belonging to this store' },
      { label: 'Net paid sales', value: money(overview.metrics.netSalesMinor), detail: 'Paid item sales after completed item refunds' },
      { label: 'Orders created', value: String(overview.metrics.orders), detail: 'Store orders created in the selected period' },
    ],
    columns: ['Period', 'Paid item sales', 'Completed refunds', 'Net paid sales', 'Status'],
    rows: overview.trend.map(row => ({ id: row.key, cells: [row.key, money(row.paidMinor), money(row.refundMinor), money(row.netMinor), 'Recorded'] })),
    insights: [{ text: `Reporting follows the store calendar: ${overview.timeZone}.`, ...(entitlements.analyticsExport ? { href: `/seller/analytics/summary.csv?period=${period}`, label: 'Download summary' } : {}) },
      { text: overview.metrics.rating === null ? 'Your store has no published reviews yet.' : `${overview.metrics.reviews} published reviews give your store a ${overview.metrics.rating} / 5 rating.`, href: '/seller/reviews', label: 'Review feedback' }],
    health: { value: null, label: 'Store activity', rows: [{ label: 'Published products', value: String(overview.metrics.publishedProducts) },
      { label: 'Orders preparing', value: String(overview.metrics.preparation) }, { label: 'Awaiting payment', value: String(overview.metrics.awaitingPayment) }] },
    workflow: [{ title: 'Last 30 days', text: 'Compare daily sales and completed refunds.', href: '/seller/analytics?period=30days', label: 'View 30 days' },
      { title: 'Last seven months', text: 'Compare monthly sales and completed refunds.', href: '/seller/analytics?period=7months', label: 'View seven months' },
      { title: 'This calendar year', text: 'Review store results from the start of the year.', href: '/seller/analytics?period=year', label: 'View this year' }],
    ...(entitlements.analyticsExport ? { create: { label: 'Download summary', href: `/seller/analytics/summary.csv?period=${period}` } } : {}),
  };
}
