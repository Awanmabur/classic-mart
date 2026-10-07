import {
  ApprovalRequest,
  AttributionTouch,
  AuditLog,
  AiJob,
  Brand,
  BusinessBudget,
  BusinessDocument,
  BusinessInvoice,
  BusinessMember,
  BusinessOrganization,
  Cart,
  Campaign,
  CampaignApplication,
  Category,
  Chargeback,
  CmsContent,
  CommissionEntry,
  Coupon,
  CustomerAddress,
  CustomerCatalogueState,
  DataExport,
  Dispute,
  FeatureFlag,
  GiftCard,
  InventoryDiscrepancy,
  InventoryMovement,
  LedgerAccount,
  LedgerTransaction,
  LoyaltyAccount,
  LoyaltyEntry,
  MarketplaceConversation,
  MarketingCampaign,
  ModerationQaReview,
  Notification,
  Order,
  OperationalAlert,
  PaymentIntent,
  Parcel,
  Payout,
  PayoutAccount,
  PlatformGrant,
  Product,
  ProductVariant,
  ProviderEvent,
  PromoterLink,
  PromoterContactRequest,
  PromoterVerification,
  PurchaseOrder,
  QuoteRequest,
  ReconciliationRun,
  Referral,
  Refund,
  ReturnRequest,
  Review,
  RiskSignal,
  SearchEvent,
  SecurityEvent,
  SecurityFinding,
  SellerOrder,
  SellerReturnCase,
  SellerShipment,
  SellerVerification,
  Shipment,
  StockItem,
  Store,
  StoreMember,
  SubscriptionEnrollment,
  SubscriptionPlan,
  SupportMacro,
  SupportTicket,
  TrustCase,
  User,
  Warehouse,
  WarehouseTask,
  WarehouseWave,
} from '../models/index.js';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { hasPermission } from '../core/roles.js';
import { operationalCountriesFor, warehouseScopesFor } from '../services/authorization.js';
import { sellerStoreAccesses } from '../services/store.js';
import { promoterSummary } from '../services/promoters.js';
import { businessWorkspace } from '../services/business.js';
import { sellerDashboardDataPlan } from '../services/seller-dashboard-access.js';
import { pageDefinition } from './registry.js';

const MAX_ROWS = 50;
const OPEN_STATUSES = new Set([
  'active','open','pending','requested','submitted','in_progress','processing','scheduled','running','awaiting_payment',
  'awaiting_return','refund_pending','refund_processing','trialing','past_due','escalated','waiting_customer','investigating',
  'awaiting_customer','awaiting_seller','draft','approved','published','verified','ready','confirmed','paid','payable','partially_reversed',
]);

function asObject(value) {
  if (!value) return null;
  return typeof value.toObject === 'function' ? value.toObject() : value;
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countryCodesFor(user) {
  const operational = operationalCountriesFor(user);
  if (operational.includes('*')) return [];
  if (operational.length) return operational;
  const code = String(user?.country || '').trim().toUpperCase();
  return code ? [code] : [];
}

async function businessAccesses(user) {
  const [owned, memberships] = await Promise.all([
    BusinessOrganization.find({ ownerUserId: user._id, status: { $ne: 'suspended' } }).sort({ createdAt: 1 }).lean(),
    BusinessMember.find({ userId: user._id, status: 'active' }).sort({ acceptedAt: 1 }).lean(),
  ]);
  const memberIds = memberships.map((row) => row.organizationId);
  const memberOrganizations = memberIds.length
    ? await BusinessOrganization.find({ _id: { $in: memberIds }, status: { $ne: 'suspended' } }).lean()
    : [];
  const byId = new Map(memberships.map((row) => [String(row.organizationId), row]));
  const rows = [];
  const seen = new Set();
  for (const organization of [...owned, ...memberOrganizations]) {
    if (seen.has(organization.publicId)) continue;
    seen.add(organization.publicId);
    rows.push({ organization, membership: byId.get(String(organization._id)) || null });
  }
  return rows;
}

export async function resolveDashboardDataScope({ request, workspace }) {
  const user = request.user;
  const scope = {
    user,
    workspace,
    countryCodes: countryCodesFor(user),
    currency: user?.currency || 'UGX',
    store: null,
    sellerRole: '',
    sellerDataPlan: null,
    organization: null,
    warehousePublicIds: [],
  };
  if (workspace === 'seller') {
    const accesses = await sellerStoreAccesses(user);
    const preferred = String(request.session?.activeStorePublicId || '').trim();
    const selected = accesses.find((row) => row.store.publicId === preferred) || accesses[0] || null;
    scope.store = selected?.store || null;
    scope.sellerRole = selected?.role || '';
    scope.sellerDataPlan = sellerDashboardDataPlan(scope.sellerRole);
  }
  if (workspace === 'business') {
    const accesses = await businessAccesses(user);
    const preferred = String(request.session?.activeBusinessPublicId || user?.$locals?.activeBusinessPublicId || '').trim();
    const selected = accesses.find((row) => row.organization.publicId === preferred) || accesses[0] || null;
    scope.organization = selected?.organization || null;
    if (scope.organization) {
      user.$locals = user.$locals || {};
      user.$locals.activeBusinessPublicId = scope.organization.publicId;
    }
  }
  if (workspace === 'warehouse') scope.warehousePublicIds = warehouseScopesFor(user);
  return scope;
}

function dateValue(row) {
  return row?.updatedAt || row?.createdAt || row?.postedAt || row?.requestedAt || row?.submittedAt || row?.startedAt || null;
}

function statusValue(row) {
  if (typeof row?.status === 'string') return row.status;
  if (typeof row?.state === 'string') return row.state;
  if (typeof row?.active === 'boolean') return row.active ? 'active' : 'inactive';
  if (row?.readAt !== undefined) return row.readAt ? 'read' : 'unread';
  return '';
}

function titleValue(row) {
  return String(
    row?.title || row?.name || row?.companyName || row?.subject || row?.description || row?.code || row?.key ||
    row?.invoiceNumber || row?.documentNumber || row?.reference || row?.publicId || 'Record',
  );
}

function secondaryValue(row) {
  const candidates = [
    row?.email,
    row?.requesterName,
    row?.category,
    row?.type,
    row?.role,
    row?.country,
    row?.currency,
    row?.storePublicId,
    row?.orderPublicId,
    row?.referenceType,
  ];
  return String(candidates.find((value) => value !== undefined && value !== null && String(value).trim()) || '');
}

function moneyCandidate(row) {
  for (const key of ['amountMinor','priceMinor','totalMinor','subtotalMinor','balanceMinor','initialValueMinor','paidMinor','estimatedTotalMinor']) {
    if (Number.isFinite(Number(row?.[key]))) return Number(row[key]);
  }
  if (Number.isFinite(Number(row?.totals?.totalMinor))) return Number(row.totals.totalMinor);
  return null;
}

function formatMoney(minor, currency) {
  if (minor === null || minor === undefined) return '';
  const code=String(currency||'UGX').toUpperCase();
  const zeroDecimal=new Set(['UGX','RWF','JPY','KRW']);
  const major=zeroDecimal.has(code)?Number(minor):Number(minor)/100;
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: code, maximumFractionDigits: zeroDecimal.has(code)?0:2 }).format(major);
  } catch {
    return `${code} ${major}`.trim();
  }
}

function normalizeRecord(row, scope) {
  const plain = asObject(row) || {};
  const date = dateValue(plain);
  return {
    id: String(plain.publicId || plain._id || ''),
    primary: titleValue(plain),
    secondary: secondaryValue(plain),
    status: statusValue(plain),
    amount: formatMoney(moneyCandidate(plain), plain.currency || scope.currency),
    date: date ? new Date(date) : null,
    raw: plain,
  };
}

function countryFilter(Model, scope) {
  if (scope.workspace === 'superadmin' || !scope.countryCodes.length) return {};
  if (Model.schema.path('country')) return { country: scope.countryCodes.length === 1 ? scope.countryCodes[0] : { $in: scope.countryCodes } };
  if (Model.schema.path('countries')) return { countries: { $in: scope.countryCodes } };
  return {};
}

function scopedFilter(Model, scope, extra = {}) {
  const schema = Model.schema;
  const userId = scope.user?._id;
  let query = {};

  if (scope.workspace === 'customer') {
    if (schema.path('userId')) query.userId = userId;
    else if (schema.path('ownerUserId')) query.ownerUserId = userId;
    else if (schema.path('promoterUserId')) query.promoterUserId = userId;
    else if (Model === User) query._id = userId;
    else if (![Category, Brand].includes(Model)) query._id = { $in: [] };
  } else if (scope.workspace === 'seller') {
    if (!scope.store) query._id = { $in: [] };
    else if (schema.path('storeId')) query.storeId = scope.store._id;
    else if (schema.path('ownerStoreId')) query.ownerStoreId = scope.store._id;
    else if (schema.path('storePublicId')) query.storePublicId = scope.store.publicId;
    else if (schema.path('ownerStorePublicId')) query.ownerStorePublicId = scope.store.publicId;
    else if (Model === Store) query._id = scope.store._id;
    else if (schema.path('ownerUserId')) query.ownerUserId = scope.user._id;
    else query._id = { $in: [] };
  } else if (scope.workspace === 'promoter') {
    if (schema.path('promoterUserId')) query.promoterUserId = userId;
    else if (schema.path('referrerUserId')) query.referrerUserId = userId;
    else if (schema.path('ownerUserId')) query.ownerUserId = userId;
    else if (schema.path('userId')) query.userId = userId;
    else if (Model === User) query._id = userId;
    else query._id = { $in: [] };
  } else if (scope.workspace === 'business') {
    if (!scope.organization) query._id = { $in: [] };
    else if (schema.path('organizationId')) query.organizationId = scope.organization._id;
    else if (schema.path('businessOrganizationId')) query.businessOrganizationId = scope.organization._id;
    else if (Model === BusinessOrganization) query._id = scope.organization._id;
    else query._id = { $in: [] };
  } else {
    query = countryFilter(Model, scope);
    if (scope.workspace === 'warehouse' && scope.warehousePublicIds.length && schema.path('warehouseId')) {
      // Warehouse ids are public ids in grants; resolve with a sub-query before task loading.
      query.__warehouseScoped = true;
    }
  }
  return { ...query, ...extra };
}

async function resolveWarehouseFilter(Model, query, scope) {
  if (!query.__warehouseScoped) return query;
  const copy = { ...query };
  delete copy.__warehouseScoped;
  const warehouses = await Warehouse.find({ publicId: { $in: scope.warehousePublicIds } }).select('_id').lean();
  copy.warehouseId = { $in: warehouses.map((row) => row._id) };
  return copy;
}

async function loadModelRecords(Model, scope, { extra = {}, select = '', populate = [], sort = { updatedAt: -1, createdAt: -1 }, limit = MAX_ROWS } = {}) {
  let query = scopedFilter(Model, scope, extra);
  query = await resolveWarehouseFilter(Model, query, scope);
  let cursor = Model.find(query).sort(sort).limit(limit);
  if (select) cursor = cursor.select(select);
  for (const item of populate) cursor = cursor.populate(...item);
  const [rows, total] = await Promise.all([cursor.lean(), Model.countDocuments(query)]);
  const since = new Date(Date.now() - 7 * 86_400_000);
  const recentField = Model.schema.path('updatedAt') ? 'updatedAt' : Model.schema.path('createdAt') ? 'createdAt' : null;
  const recent = recentField ? await Model.countDocuments({ ...query, [recentField]: { $gte: since } }) : 0;
  return { rows, total, recent, query };
}

function standardResult({ pageId, scope, entityLabel, rows = [], total = 0, recent = 0, actions = [], form = null, columns = null }) {
  const records = rows.map((row) => normalizeRecord(row, scope));
  const active = records.filter((record) => OPEN_STATUSES.has(record.status)).length;
  const metrics = [
    { label: `Total ${entityLabel}`, value: String(total), detail: `${records.length} shown` },
    { label: 'Active / open', value: String(active), detail: 'From visible records' },
    { label: 'Updated 7 days', value: String(recent), detail: 'Persisted changes' },
    { label: 'Scope', value: scopeLabel(scope), detail: scope.workspace },
  ];
  const insights = total
    ? [`${total} ${entityLabel.toLowerCase()} available in this authorized scope.`, `${recent} changed during the last seven days.`]
    : [`No ${entityLabel.toLowerCase()} are stored in this authorized scope yet.`];
  return {
    pageId,
    entityLabel,
    metrics,
    records,
    columns: columns || ['Reference', 'Item', 'Status', 'Amount / detail', 'Updated'],
    insights,
    actions,
    form,
    total,
    empty: total === 0,
  };
}

function scopeLabel(scope) {
  if (scope.workspace === 'seller') return scope.store?.name || 'No store';
  if (scope.workspace === 'business') return scope.organization?.companyName || 'No organization';
  if (scope.workspace === 'superadmin') return 'Platform';
  if (scope.countryCodes.length === 1) return scope.countryCodes[0];
  if (scope.countryCodes.length > 1) return `${scope.countryCodes.length} countries`;
  return scope.user?.name || 'Account';
}

const PAGE_ACTIONS = Object.freeze({
  orders: [{ label: 'Track an order', href: '/track-order' }],
  wishlist: [{ label: 'Open storefront wishlist', href: '/wishlist' }],
  cart: [{ label: 'Open checkout cart', href: '/cart' }],
  categories: [{ label: 'Browse marketplace', href: '/categories' }],
  returns: [{ label: 'Buyer protection centre', href: '/account/returns' }],
  profile: [{ label: 'Edit profile', href: '/account/profile' }, { label: 'Security', href: '/account/security' }],
  support: [{ label: 'Help centre', href: '/help' }],

  'super-analytics': [{ label: 'Reports centre', href: '/admin/reports' }],
  'super-users': [{ label: 'Staff & access', href: '/admin/staff' }],
  'super-roles': [{ label: 'Manage access grants', href: '/admin/staff' }],
  'super-admins': [{ label: 'Admin accounts', href: '/admin/staff' }],
  'super-sellers': [{ label: 'Seller approvals', href: '/admin/approvals' }],
  'super-promoters': [{ label: 'Promoter operations', href: '/admin/promoters' }],
  'super-products': [{ label: 'Product moderation', href: '/moderation/products' }],
  'super-categories': [{ label: 'Catalogue control', href: '/moderation/catalogue' }],
  'super-finance': [{ label: 'Export ledger', href: '/finance/ledger.csv' }],
  'super-disputes': [{ label: 'Incident centre', href: '/admin/incidents' }],
  'super-reports': [{ label: 'Reports centre', href: '/admin/reports' }],
  'super-audit': [{ label: 'Security evidence', href: '/admin/security' }],
  'super-security': [{ label: 'Security & health', href: '/admin/security' }, { label: 'System health', href: '/admin/health' }, { label: 'Incident centre', href: '/admin/incidents' }],
  'super-settings': [{ label: 'Country settings', href: '/admin/countries' }, { label: 'Feature flags', href: '/admin/features' }, { label: 'Four-eyes approvals', href: '/admin/approvals' }],

  'admin-seller-approvals': [{ label: 'Approval centre', href: '/admin/approvals' }],
  'admin-promoter-approvals': [{ label: 'Approval centre', href: '/admin/approvals' }],
  'admin-products': [{ label: 'Moderate products', href: '/moderation/products' }],
  'admin-categories': [{ label: 'Catalogue control', href: '/moderation/catalogue' }],
  'admin-campaigns': [{ label: 'Growth operations', href: '/admin/growth' }],
  'admin-reviews': [{ label: 'Review quality queue', href: '/moderation/qa' }],
  'admin-content': [{ label: 'Content management', href: '/admin/cms' }],
  'admin-reports': [{ label: 'Reports centre', href: '/admin/reports' }],
  'admin-settings': [{ label: 'Country settings', href: '/admin/countries' }, { label: 'Feature flags', href: '/admin/features' }],

  'seller-add-product': [{ label: 'Open product editor', href: '/seller/products/new' }],
  'seller-products': [{ label: 'Manage catalogue', href: '/seller/products' }],
  'seller-inventory': [{ label: 'Inventory operations', href: '/seller/inventory' }],
  'seller-orders': [{ label: 'Order operations', href: '/seller/orders' }],
  'seller-shipping': [{ label: 'Fulfilment queue', href: '/seller/orders' }],
  'seller-returns': [{ label: 'Return cases', href: '/seller/returns' }],
  'seller-promotions': [{ label: 'Campaign operations', href: '/seller/campaigns' }],
  'seller-messages': [{ label: 'Message centre', href: '/seller/messages' }],
  'seller-store': [{ label: 'Store onboarding & settings', href: '/seller/onboarding' }],

  'promoter-commissions': [{ label: 'Export commissions', href: '/promoter/commissions.csv' }],
  'promoter-brands': [{ label: 'Browse sellers', href: '/sellers' }],
  'promoter-profile': [{ label: 'Edit account profile', href: '/account/profile' }],

  'finance-payments': [{ label: 'Export ledger', href: '/finance/ledger.csv' }],
  'finance-reports': [{ label: 'Export ledger', href: '/finance/ledger.csv' }],
  'finance-settings': [{ label: 'Account security', href: '/account/security' }],

  'warehouse-inventory': [{ label: 'Export inventory audit', href: '/operations/logistics/inventory-audit.csv' }],
  'warehouse-reports': [{ label: 'Export inventory audit', href: '/operations/logistics/inventory-audit.csv' }],
  'warehouse-settings': [{ label: 'Account security', href: '/account/security' }],

  'moderator-products': [{ label: 'Product review queue', href: '/moderation/products' }],
  'moderator-reviews': [{ label: 'Catalogue QA', href: '/moderation/qa' }],
  'moderator-sellers': [{ label: 'Seller verification', href: '/moderation/verifications' }],
  'moderator-settings': [{ label: 'Account security', href: '/account/security' }],

  'business-payments': [{ label: 'Download statement', href: '/business/statement.csv' }],
  'business-reports': [{ label: 'Download statement', href: '/business/statement.csv' }],
  'business-settings': [{ label: 'Edit account profile', href: '/account/profile' }],
});

function actionsFor(pageId) { return PAGE_ACTIONS[pageId] || []; }

async function productIdsForSeller(scope) {
  if (!scope.store) return [];
  return Product.find({ storeId: scope.store._id }).distinct('_id');
}

async function loadWishlist(ctx) {
  const state = await CustomerCatalogueState.findOne({ userId: ctx.scope.user._id }).lean();
  const ids = state?.wishlistProductIds || [];
  const rows = ids.length ? await Product.find({ _id: { $in: ids } }).sort({ updatedAt: -1 }).limit(MAX_ROWS).lean() : [];
  return standardResult({ pageId: ctx.pageId, scope: ctx.scope, entityLabel: 'Wishlist products', rows, total: ids.length, recent: 0, actions: actionsFor(ctx.pageId) });
}

async function loadWallet(ctx) {
  const { scope } = ctx;
  let ownerType = 'customer';
  let ownerPublicId = scope.user.publicId;
  if (scope.workspace === 'seller' && scope.store) { ownerType = 'store'; ownerPublicId = scope.store.publicId; }
  if (scope.workspace === 'promoter') ownerType = 'promoter';
  const accounts = await LedgerAccount.find({ ownerType, ownerPublicId, active: true }).lean();
  const accountIds = accounts.map((row) => row._id);
  const query = accountIds.length ? { 'entries.accountId': { $in: accountIds } } : { _id: { $in: [] } };
  const [rows, total] = await Promise.all([
    LedgerTransaction.find(query).sort({ postedAt: -1 }).limit(MAX_ROWS).lean(),
    LedgerTransaction.countDocuments(query),
  ]);
  return standardResult({ pageId: ctx.pageId, scope, entityLabel: 'Wallet transactions', rows, total, recent: 0, actions: actionsFor(ctx.pageId) });
}

async function loadSellerReviews(ctx) {
  const ids = await productIdsForSeller(ctx.scope);
  const query = ids.length ? { productId: { $in: ids } } : { _id: { $in: [] } };
  const [rows,total] = await Promise.all([Review.find(query).sort({createdAt:-1}).limit(MAX_ROWS).lean(),Review.countDocuments(query)]);
  return standardResult({pageId:ctx.pageId,scope:ctx.scope,entityLabel:'Reviews',rows,total,recent:0,actions:actionsFor(ctx.pageId)});
}

async function loadSellerCustomers(ctx) {
  if (!ctx.scope.store) return standardResult({pageId:ctx.pageId,scope:ctx.scope,entityLabel:'Customers'});
  const rows = await SellerOrder.find({storeId:ctx.scope.store._id}).populate('orderId','publicId userId contact createdAt').sort({createdAt:-1}).limit(MAX_ROWS).lean();
  const unique = new Map();
  for (const row of rows) {
    const order=row.orderId; const key=String(order?.userId||order?.contact?.email||row.publicId);
    if(!unique.has(key)) unique.set(key,{publicId:order?.publicId||row.publicId,title:order?.contact?.fullName||'Customer',email:order?.contact?.email||'',status:row.status,createdAt:row.createdAt});
  }
  return standardResult({pageId:ctx.pageId,scope:ctx.scope,entityLabel:'Customers',rows:[...unique.values()],total:unique.size,recent:0,actions:actionsFor(ctx.pageId)});
}

async function loadAddresses(ctx) {
  const result = await loadModelRecords(CustomerAddress, ctx.scope, { extra: { archivedAt: null } });
  return standardResult({ pageId: ctx.pageId, scope: ctx.scope, entityLabel: 'Addresses', ...result, actions: actionsFor(ctx.pageId) });
}

async function loadNotifications(ctx) {
  const result = await loadModelRecords(Notification, ctx.scope);
  return standardResult({ pageId: ctx.pageId, scope: ctx.scope, entityLabel: 'Notifications', ...result, actions: actionsFor(ctx.pageId) });
}

async function loadMessages(ctx) {
  const query={participantUserIds:ctx.scope.user._id};
  const [rows,total]=await Promise.all([MarketplaceConversation.find(query).sort({lastMessageAt:-1}).limit(MAX_ROWS).lean(),MarketplaceConversation.countDocuments(query)]);
  return standardResult({pageId:ctx.pageId,scope:ctx.scope,entityLabel:'Conversations',rows,total,recent:0,actions:actionsFor(ctx.pageId)});
}

async function loadSubscriptions(ctx) {
  if (ctx.scope.workspace === 'superadmin' || ctx.scope.workspace === 'admin') {
    const result = await loadModelRecords(SubscriptionPlan, ctx.scope);
    return standardResult({pageId:ctx.pageId,scope:ctx.scope,entityLabel:'Subscription plans',...result,actions:actionsFor(ctx.pageId)});
  }
  const result = await loadModelRecords(SubscriptionEnrollment, ctx.scope);
  return standardResult({pageId:ctx.pageId,scope:ctx.scope,entityLabel:'Subscriptions',...result,actions:actionsFor(ctx.pageId)});
}

async function loadCoupons(ctx) {
  const extra = ctx.scope.workspace === 'seller'
    ? { scope: 'seller', storeId: ctx.scope.store?._id || null }
    : { scope: 'platform' };
  const result = await loadModelRecords(Coupon, ctx.scope, { extra });
  return standardResult({pageId:ctx.pageId,scope:ctx.scope,entityLabel:'Coupons',...result,actions:actionsFor(ctx.pageId)});
}

async function loadCategories(ctx) {
  const result = await loadModelRecords(Category, ctx.scope, { extra: ctx.scope.workspace === 'customer' ? { active: true } : {} });
  return standardResult({pageId:ctx.pageId,scope:ctx.scope,entityLabel:'Categories',...result,actions:actionsFor(ctx.pageId)});
}

async function loadProfile(ctx) {
  const row = await User.findById(ctx.scope.user._id).select('publicId name email phone role status country currency locale timeZone roleProfile preferences createdAt updatedAt').lean();
  return standardResult({pageId:ctx.pageId,scope:ctx.scope,entityLabel:'Profile records',rows:row?[row]:[],total:row?1:0,recent:0,actions:actionsFor(ctx.pageId)});
}

async function loadOverview(ctx) {
  const model = entityModelFor('overview', ctx);
  const result = await loadModelRecords(model, ctx.scope, entityOptionsFor('overview', ctx));
  const base = standardResult({pageId:ctx.pageId,scope:ctx.scope,entityLabel:'Activity records',...result,actions:actionsFor(ctx.pageId)});
  if (ctx.scope.workspace !== 'customer') return base;
  const [storeInvitations, businessInvitations] = await Promise.all([
    StoreMember.find({ userId: ctx.scope.user._id, status: 'invited' })
      .populate('storeId', 'publicId name country status')
      .sort({ updatedAt: -1 })
      .limit(20)
      .lean(),
    BusinessMember.find({ userId: ctx.scope.user._id, status: 'invited' })
      .populate('organizationId', 'publicId companyName country status')
      .sort({ updatedAt: -1 })
      .limit(20)
      .lean(),
  ]);
  return { ...base, storeInvitations, businessInvitations };
}


async function loadCart(ctx) {
  const cart = await Cart.findOne({ userId: ctx.scope.user._id })
    .populate('items.productId', 'publicId title status')
    .populate('items.variantId', 'publicId title sku priceMinor currency active')
    .lean();
  if (!cart) {
    return {
      ...standardResult({ pageId: ctx.pageId, scope: ctx.scope, entityLabel: 'Cart items', rows: [], total: 0, recent: 0, actions: actionsFor(ctx.pageId) }),
      cart: null,
      cartItems: [],
      cartSubtotalMinor: 0,
    };
  }
  const rows = (cart.items || []).map((item) => ({
    publicId: item.variantId?.publicId || item.productId?.publicId || cart.publicId,
    title: item.productId?.title || item.variantId?.title || 'Cart item',
    sku: item.variantId?.sku || '',
    status: item.variantId?.active === false ? 'unavailable' : 'in_cart',
    priceMinor: Number(item.variantId?.priceMinor || 0) * Number(item.quantity || 1),
    currency: item.variantId?.currency || ctx.scope.currency,
    quantity: Number(item.quantity || 1),
    productPublicId: item.productId?.publicId || '',
    variantPublicId: item.variantId?.publicId || '',
    updatedAt: cart.updatedAt,
  }));
  const subtotalMinor = rows.reduce((sum, row) => sum + Number(row.priceMinor || 0), 0);
  return {
    ...standardResult({ pageId: ctx.pageId, scope: ctx.scope, entityLabel: 'Cart items', rows, total: rows.length, recent: 0, actions: actionsFor(ctx.pageId) }),
    cart: { publicId: cart.publicId, country: cart.country, promotionCodes: cart.promotionCodes || [] },
    cartItems: rows,
    cartSubtotalMinor: subtotalMinor,
    cartSubtotal: formatMoney(subtotalMinor, rows[0]?.currency || ctx.scope.currency),
  };
}

async function loadRewards(ctx) {
  const [account, entries] = await Promise.all([
    LoyaltyAccount.findOne({ userId: ctx.scope.user._id }).lean(),
    LoyaltyEntry.find({ userId: ctx.scope.user._id }).sort({ createdAt: -1 }).limit(MAX_ROWS).lean(),
  ]);
  return {
    ...standardResult({ pageId: ctx.pageId, scope: ctx.scope, entityLabel: 'Reward activity', rows: entries, total: entries.length, recent: 0, actions: actionsFor(ctx.pageId) }),
    loyalty: account ? {
      publicId: account.publicId,
      points: Number(account.points || 0),
      lifetimeEarned: Number(account.lifetimeEarned || 0),
      lifetimeRedeemed: Number(account.lifetimeRedeemed || 0),
      tier: account.tier || 'classic',
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    } : { points: 0, lifetimeEarned: 0, lifetimeRedeemed: 0, tier: 'classic' },
  };
}


async function loadProductEditor(ctx) {
  const store = ctx.scope.store;
  const country = store?.country || ctx.scope.countryCodes[0] || ctx.scope.user?.country || '';
  const [categories, brands] = await Promise.all([
    Category.find({
      active: true,
      $or: [{ countries: { $size: 0 } }, ...(country ? [{ countries: country }] : [])],
    }).sort({ name: 1 }).select('publicId name slug').lean(),
    Brand.find({ status: 'approved' }).sort({ name: 1 }).select('publicId name slug').lean(),
  ]);
  const base = await loadGenericKind('products', ctx);
  return {
    ...base,
    editor: {
      categories,
      brands,
      country,
      currency: store?.currency || ctx.scope.currency,
      store: store ? { publicId: store.publicId, name: store.name } : null,
    },
  };
}


function dashboardPreferenceView(user) {
  const dashboard = user?.preferences?.dashboard || {};
  return {
    density: dashboard.density || 'comfortable',
    landingPage: dashboard.landingPage || '',
    idleReminderMinutes: Number(dashboard.idleReminderMinutes || 30),
    priorityUpdates: dashboard.priorityUpdates !== false,
    escalations: dashboard.escalations !== false,
    weeklyReport: Boolean(dashboard.weeklyReport),
  };
}

function profileCompletion(settings, workspace) {
  const values = workspace === 'seller'
    ? [settings.store?.name, settings.store?.description, settings.user?.phone, settings.user?.email]
    : workspace === 'business'
      ? [settings.organization?.companyName, settings.organization?.billingEmail, settings.organization?.billingContactName, settings.organization?.billingPhone]
      : workspace === 'promoter'
        ? [settings.user?.name, settings.user?.phone, settings.user?.roleProfile?.publicName, settings.user?.roleProfile?.bio]
        : [settings.user?.name, settings.user?.phone, settings.user?.email, settings.user?.shoppingCountry];
  const filled = values.filter((value) => String(value || '').trim()).length;
  return Math.round((filled / Math.max(1, values.length)) * 100);
}

async function loadSettings(ctx) {
  const adminWorkspace = ['admin','superadmin'].includes(ctx.scope.workspace);
  const [user, promoterVerification, pendingApprovals] = await Promise.all([
    User.findById(ctx.scope.user._id)
      .select('publicId name email phone role status country shoppingCountry currency locale timeZone roleProfile preferences emailVerifiedAt phoneVerifiedAt createdAt updatedAt')
      .lean(),
    ctx.scope.workspace === 'promoter'
      ? PromoterVerification.findOne({ userId: ctx.scope.user._id })
          .select('publicId country status channels niches audienceSize audienceLocation submittedAt reviewedAt updatedAt')
          .lean()
      : Promise.resolve(null),
    adminWorkspace
      ? ApprovalRequest.find({ ...countryFilter(ApprovalRequest, ctx.scope), status: 'requested' })
          .select('publicId type country targetType targetPublicId reason status requestedByUserId createdAt')
          .populate('requestedByUserId', 'publicId name role country')
          .sort({ createdAt: 1 }).limit(20).lean()
      : Promise.resolve([]),
  ]);
  const settings = {
    workspace: ctx.scope.workspace,
    user: user || {
      publicId: ctx.scope.user.publicId,
      name: ctx.scope.user.name,
      email: ctx.scope.user.email,
      phone: ctx.scope.user.phone,
      country: ctx.scope.user.country,
      shoppingCountry: ctx.scope.user.shoppingCountry,
      currency: ctx.scope.user.currency,
      locale: ctx.scope.user.locale,
      timeZone: ctx.scope.user.timeZone,
      roleProfile: ctx.scope.user.roleProfile || {},
      preferences: ctx.scope.user.preferences || {},
    },
    store: ctx.scope.store ? {
      publicId: ctx.scope.store.publicId,
      name: ctx.scope.store.name,
      description: ctx.scope.store.description || '',
      country: ctx.scope.store.country,
      currency: ctx.scope.store.currency,
      status: ctx.scope.store.status,
      operations: ctx.scope.store.operations || {},
    } : null,
    organization: ctx.scope.organization ? {
      publicId: ctx.scope.organization.publicId,
      companyName: ctx.scope.organization.companyName,
      country: ctx.scope.organization.country,
      currency: ctx.scope.organization.currency,
      billingEmail: ctx.scope.organization.billingEmail || '',
      billingContactName: ctx.scope.organization.billingContactName || '',
      billingPhone: ctx.scope.organization.billingPhone || '',
      billingAddress: ctx.scope.organization.billingAddress || '',
      billingCity: ctx.scope.organization.billingCity || '',
      deliveryContactName: ctx.scope.organization.deliveryContactName || '',
      deliveryPhone: ctx.scope.organization.deliveryPhone || '',
      deliveryAddress: ctx.scope.organization.deliveryAddress || '',
      deliveryCity: ctx.scope.organization.deliveryCity || '',
      status: ctx.scope.organization.status,
      invoiceTermsApproved: Boolean(ctx.scope.organization.invoiceTermsApproved),
      invoiceTermsDays: Number(ctx.scope.organization.invoiceTermsDays || 0),
      creditLimitMinor: Number(ctx.scope.organization.creditLimitMinor || 0),
    } : null,
    promoter: promoterVerification ? {
      publicId: promoterVerification.publicId,
      country: promoterVerification.country,
      status: promoterVerification.status,
      channels: promoterVerification.channels || [],
      niches: promoterVerification.niches || [],
      audienceSize: Number(promoterVerification.audienceSize || 0),
      audienceLocation: promoterVerification.audienceLocation || '',
    } : null,
    preferences: dashboardPreferenceView(user || ctx.scope.user),
    pendingApprovals,
  };
  settings.completion = profileCompletion(settings, ctx.scope.workspace);
  const entity = settings.store || settings.organization || settings.user;
  const base = standardResult({
    pageId: ctx.pageId,
    scope: ctx.scope,
    entityLabel: 'Settings',
    rows: entity ? [entity] : [],
    total: entity ? 1 : 0,
    recent: 0,
    actions: actionsFor(ctx.pageId),
  });
  return { ...base, settings };
}

function formForPage(pageId, scope) {
  if (pageId === 'addresses') return {
    action: '/dashboard/addresses',
    title: 'Add Delivery Address',
    description: 'Save a real address to your Classic Mart account.',
    submitLabel: 'Save Address',
    fields: [
      { name: 'label', label: 'Address label', value: 'Home', required: true },
      { name: 'fullName', label: 'Full name', value: scope.user?.name || '', required: true },
      { name: 'phone', label: 'Phone number', value: scope.user?.phone || '', required: true },
      { name: 'country', label: 'Country code', value: scope.user?.country || scope.countryCodes[0] || '', required: true },
      { name: 'city', label: 'City', required: true },
      { name: 'address', label: 'Street / area / delivery details', required: true, wide: true },
      { name: 'note', label: 'Delivery note', type: 'textarea', wide: true },
      { name: 'isDefault', label: 'Default address', type: 'select', options: [{ value: '', label: 'No' }, { value: 'true', label: 'Yes' }] },
    ],
  };
  if (pageId === 'seller-messages' || pageId === 'promoter-messages') return {
    action: '/dashboard/messages', title: 'New Message', description: 'Start a persisted marketplace conversation.', submitLabel: 'Send Message',
    fields: [
      { name: 'recipientPublicId', label: 'Recipient user ID', required: true },
      { name: 'subject', label: 'Subject', required: true },
      { name: 'contextType', label: 'Context', type: 'select', value: 'general', options: ['general','order','product','campaign','store','support'].map((value)=>({value,label:value.replace('_',' ')})) },
      { name: 'contextPublicId', label: 'Related record ID' },
      { name: 'body', label: 'Message', type: 'textarea', required: true, wide: true },
    ],
  };
  if (pageId === 'seller-coupons' || pageId === 'admin-coupons') return {
    action: '/dashboard/coupons', title: 'Create Coupon', description: 'Create a database-backed coupon definition.', submitLabel: 'Create Draft Coupon',
    fields: [
      { name: 'scope', label: 'Coupon owner', type: 'select', value: pageId === 'seller-coupons' ? 'seller' : 'platform', options: pageId === 'seller-coupons' ? [{value:'seller',label:'This seller store'}] : [{value:'platform',label:'Platform'}] },
      ...(pageId === 'seller-coupons' && scope.store ? [{ name: 'storePublicId', label: 'Store', value: scope.store.publicId, required: true }] : []),
      { name: 'code', label: 'Coupon code', required: true },
      { name: 'name', label: 'Name', required: true },
      { name: 'country', label: 'Country', value: scope.store?.country || scope.countryCodes[0] || scope.user?.country || '', required: true },
      { name: 'currency', label: 'Currency', value: scope.store?.currency || scope.currency || 'UGX', required: true },
      { name: 'discountType', label: 'Discount type', type: 'select', value: 'percent', options: [{value:'percent',label:'Percentage'},{value:'fixed',label:'Fixed amount'},{value:'free_shipping',label:'Free shipping'}] },
      { name: 'discountPercent', label: 'Discount %', type: 'number', value: '0' },
      { name: 'discountMinor', label: 'Fixed discount (minor units)', type: 'number', value: '0' },
      { name: 'usageLimit', label: 'Usage limit (0 = unlimited)', type: 'number', value: '0' },
      { name: 'perUserLimit', label: 'Per-user limit', type: 'number', value: '1' },
      { name: 'startsAt', label: 'Starts', type: 'datetime-local' },
      { name: 'endsAt', label: 'Ends', type: 'datetime-local' },
      { name: 'description', label: 'Description', type: 'textarea', wide: true },
    ],
  };
  if (pageId === 'super-subscriptions') return {
    action: '/dashboard/subscription-plans', title: 'Create Subscription Plan', description: 'Configure a real seller or promoter plan.', submitLabel: 'Create Plan',
    fields: [
      { name: 'key', label: 'Plan key', required: true }, { name: 'name', label: 'Plan name', required: true },
      { name: 'audience', label: 'Audience', type: 'select', value: 'seller', options: [{value:'seller',label:'Seller'},{value:'promoter',label:'Promoter'}] },
      { name: 'country', label: 'Country', value: scope.countryCodes[0] || scope.user?.country || 'UG', required: true },
      { name: 'currency', label: 'Currency', value: scope.currency || 'UGX', required: true },
      { name: 'priceMinor', label: 'Price (minor units)', type: 'number', value: '0', required: true },
      { name: 'cadence', label: 'Billing cadence', type: 'select', value: 'monthly', options: ['monthly','quarterly','yearly','one_time'].map((value)=>({value,label:value.replace('_',' ')})) },
      { name: 'status', label: 'Status', type: 'select', value: 'draft', options: ['draft','active','retired'].map((value)=>({value,label:value})) },
      { name: 'features', label: 'Features (one per line)', type: 'textarea', wide: true },
      { name: 'description', label: 'Description', type: 'textarea', wide: true },
    ],
  };
  if (pageId === 'super-notifications') return {
    action: '/dashboard/notifications/send', title: 'Send Platform Notification', description: 'Create a persisted in-app notification for an active account.', submitLabel: 'Send Notification',
    fields: [
      { name: 'userPublicId', label: 'Recipient user ID', required: true }, { name: 'title', label: 'Title', required: true },
      { name: 'importance', label: 'Importance', type: 'select', value: 'normal', options: ['normal','high','urgent'].map((value)=>({value,label:value})) },
      { name: 'href', label: 'Destination path' }, { name: 'body', label: 'Message', type: 'textarea', required: true, wide: true },
    ],
  };
  return null;
}

function entityModelFor(kind, ctx) {
  const w=ctx.scope.workspace;
  if(kind==='orders') return w==='seller'?SellerOrder:w==='business'?PurchaseOrder:w==='warehouse'?WarehouseTask:Order;
  if(kind==='returns') return w==='seller'?SellerReturnCase:w==='finance'?Refund:ReturnRequest;
  if(kind==='support') return SupportTicket;
  if(kind==='rewards'||kind==='club') return LoyaltyEntry;
  if(kind==='products'||kind==='form-product') return Product;
  if(kind==='users'||kind==='customers'||kind==='admins') return User;
  if(kind==='roles') return PlatformGrant;
  if(kind==='sellers') return Store;
  if(kind==='promoters') return w==='admin'||w==='superadmin'?PromoterVerification:User;
  if(kind==='finance') return w==='seller'?SellerOrder:w==='promoter'?CommissionEntry:w==='business'?BusinessInvoice:PaymentIntent;
  if(kind==='commissions') return CommissionEntry;
  if(kind==='disputes') return w==='finance'?Chargeback:Dispute;
  if(kind==='reports') return w==='finance'?ReconciliationRun:w==='warehouse'?WarehouseWave:w==='business'?BusinessDocument:DataExport;
  if(kind==='audit') return AuditLog;
  if(kind==='security') return SecurityFinding;
  if(kind==='settings') return w==='superadmin'||w==='admin'?FeatureFlag:w==='business'?BusinessOrganization:User;
  if(kind==='approvals') return ctx.pageId.includes('promoter')?PromoterVerification:SellerVerification;
  if(kind==='campaigns') return w==='admin'||w==='superadmin'?MarketingCampaign:Campaign;
  if(kind==='reviews') return Review;
  if(kind==='content') return w==='promoter'?Campaign:CmsContent;
  if(kind==='inventory') return StockItem;
  if(kind==='shipping') return w==='seller'?SellerShipment:Shipment;
  if(kind==='payouts') return Payout;
  if(kind==='settings-store') return Store;
  if(kind==='campaigns-market') return Campaign;
  if(kind==='links') return PromoterLink;
  if(kind==='traffic') return AttributionTouch;
  if(kind==='conversions') return CommissionEntry;
  if(kind==='referrals') return Referral;
  if(kind==='brands') return Brand;
  if(kind==='settings-promoter') return User;
  if(kind==='analytics') return w==='promoter'?AttributionTouch:w==='seller'?SellerOrder:SearchEvent;
  if(kind==='overview') {
    return w==='seller'?SellerOrder:w==='promoter'?CommissionEntry:w==='business'?PurchaseOrder:w==='finance'?PaymentIntent:w==='support'?SupportTicket:w==='warehouse'?WarehouseTask:w==='moderator'?Product:Order;
  }
  return OperationalAlert;
}

function entityOptionsFor(kind, ctx) {
  const extra={}; const w=ctx.scope.workspace;
  if((kind==='users'||kind==='customers'||kind==='admins')&&w!=='customer') {
    if(kind==='customers') extra.role='customer';
    if(kind==='admins') extra.role={$in:['country_admin','super_admin']};
  }
  if(kind==='promoters' && (w==='admin'||w==='superadmin') && entityModelFor(kind,ctx)===PromoterVerification) extra.status={$in:['submitted','under_review','approved','rejected']};
  if(kind==='products'&&w==='moderator') extra.status={$in:['submitted','changes_requested','approved','rejected','suspended']};
  if(kind==='campaigns-market') extra.status='active';
  if(kind==='settings-store'&&ctx.scope.store) extra._id=ctx.scope.store._id;
  if(kind==='settings-promoter') extra._id=ctx.scope.user._id;
  if(kind === 'settings' && !['superadmin','admin','business'].includes(w)) extra['_id'] = ctx.scope.user._id;
  return {extra};
}


async function loadPromoterCommissionControl(ctx) {
  const summary = await promoterSummary(ctx.scope.user, ctx.request.query || {});
  const rows = summary.commissions || [];
  const result = standardResult({
    pageId: ctx.pageId,
    scope: ctx.scope,
    entityLabel: ctx.pageId === 'promoter-analytics' ? 'Campaign analytics' : 'Commissions',
    rows,
    total: Number(summary.queuePages?.commissions?.total || rows.length),
    recent: 0,
    actions: actionsFor(ctx.pageId),
  });
  return { ...result, promoterControl: summary };
}

async function loadPromoterCampaignMarketplace(ctx) {
  const now = new Date();
  const query = {
    status: 'active',
    visibility: 'public',
    $and: [
      { $or: [{ startsAt: null }, { startsAt: { $exists: false } }, { startsAt: { $lte: now } }] },
      { $or: [{ endsAt: null }, { endsAt: { $exists: false } }, { endsAt: { $gt: now } }] },
    ],
  };
  if (ctx.scope.countryCodes.length === 1) query.country = ctx.scope.countryCodes[0];
  else if (ctx.scope.countryCodes.length > 1) query.country = { $in: ctx.scope.countryCodes };
  else if (ctx.scope.user?.country) query.country = String(ctx.scope.user.country).toUpperCase();
  else query._id = { $in: [] };
  const [rows, total] = await Promise.all([
    Campaign.find(query).sort({ updatedAt: -1, createdAt: -1 }).limit(MAX_ROWS).lean(),
    Campaign.countDocuments(query),
  ]);
  const form = rows.length ? {
    action: '/dashboard/promoter-campaigns/apply',
    title: 'Apply to Campaign',
    description: 'Request or activate access to a live campaign using the production promoter approval workflow.',
    submitLabel: 'Apply to Campaign',
    fields: [
      { name: 'campaignId', label: 'Campaign', type: 'select', required: true, options: rows.map((campaign) => ({ value: campaign.publicId, label: campaign.name || campaign.publicId })) },
      { name: 'note', label: 'Application note', type: 'textarea', wide: true },
    ],
  } : null;
  return standardResult({ pageId: ctx.pageId, scope: ctx.scope, entityLabel: 'Available campaigns', rows, total, recent: 0, actions: actionsFor(ctx.pageId), form });
}

async function loadPromoterLinks(ctx) {
  const [result, applications] = await Promise.all([
    loadModelRecords(PromoterLink, ctx.scope),
    CampaignApplication.find({ promoterUserId: ctx.scope.user._id, status: 'approved' })
      .sort({ reviewedAt: -1, updatedAt: -1 })
      .limit(100)
      .lean(),
  ]);
  const form = applications.length ? {
    action: '/dashboard/promoter-links',
    title: 'Create Tracking Link',
    description: 'Create a real attributed link for one of your approved campaigns.',
    submitLabel: 'Create Link',
    fields: [
      { name: 'campaignId', label: 'Approved campaign', type: 'select', required: true, options: applications.map((application) => ({ value: application.campaignPublicId, label: application.campaignPublicId })) },
      { name: 'destination', label: 'Marketplace destination', value: '/', required: true, wide: true },
      { name: 'couponCode', label: 'Promoter code (optional)' },
      { name: 'subId', label: 'Sub ID (optional)' },
      { name: 'channel', label: 'Channel (optional)' },
      { name: 'utmContent', label: 'UTM content (optional)' },
    ],
  } : null;
  return standardResult({ pageId: ctx.pageId, scope: ctx.scope, entityLabel: 'Tracking links', ...result, actions: actionsFor(ctx.pageId), form });
}

async function loadPromoterCampaigns(ctx, { approvedOnly = false } = {}) {
  const extra = approvedOnly ? { status: 'approved' } : {};
  const result = await loadModelRecords(CampaignApplication, ctx.scope, { extra });
  return standardResult({ pageId: ctx.pageId, scope: ctx.scope, entityLabel: approvedOnly ? 'Approved campaign access' : 'Campaign applications', ...result, actions: actionsFor(ctx.pageId) });
}

async function loadPromoterContent(ctx) {
  const [summary, aiJobs] = await Promise.all([
    promoterSummary(ctx.scope.user, ctx.request.query || {}),
    AiJob.find({ type: 'promoter_content', actorUserId: ctx.scope.user._id })
      .select('publicId type status country result provider model promptKey promptVersion attempts availableAt startedAt completedAt errorCode errorMessage createdAt updatedAt')
      .sort({ createdAt: -1 })
      .limit(MAX_ROWS)
      .lean(),
  ]);
  const contentKit = ctx.request.session?.promoterContentKit || null;
  return {
    ...standardResult({ pageId: ctx.pageId, scope: ctx.scope, entityLabel: 'Promoter content tools', rows: aiJobs, total: aiJobs.length, recent: 0, actions: actionsFor(ctx.pageId) }),
    promoterControl: { ...summary, aiJobs, contentKit },
  };
}

async function loadPromoterBrands(ctx) {
  const productQuery = { status: 'published', brandId: { $ne: null } };
  if (ctx.scope.countryCodes.length === 1) productQuery.countries = ctx.scope.countryCodes[0];
  else if (ctx.scope.countryCodes.length > 1) productQuery.countries = { $in: ctx.scope.countryCodes };
  else if (ctx.scope.user?.country) productQuery.countries = String(ctx.scope.user.country).toUpperCase();
  else productQuery._id = { $in: [] };
  const brandIds = await Product.find(productQuery).distinct('brandId');
  const query = brandIds.length ? { _id: { $in: brandIds }, status: 'approved' } : { _id: { $in: [] } };
  const [rows, total] = await Promise.all([
    Brand.find(query).sort({ name: 1 }).limit(MAX_ROWS).lean(),
    Brand.countDocuments(query),
  ]);
  return standardResult({ pageId: ctx.pageId, scope: ctx.scope, entityLabel: 'Promotable brands', rows, total, recent: 0, actions: actionsFor(ctx.pageId) });
}

async function loadBusinessOrders(ctx) {
  if (!ctx.scope.organization) {
    return { ...standardResult({ pageId: ctx.pageId, scope: ctx.scope, entityLabel: 'Business orders', rows: [], total: 0, recent: 0, actions: actionsFor(ctx.pageId) }), businessControl: null };
  }
  const q = ctx.request.query || {};
  const control = await businessWorkspace(ctx.scope.user, {
    requestsAfter: String(q.requestsAfter || ''), quotesAfter: String(q.quotesAfter || ''), purchaseOrdersAfter: String(q.purchaseOrdersAfter || ''),
    invoicesAfter: String(q.invoicesAfter || ''), auditAfter: String(q.auditAfter || ''), catalogQ: String(q.catalogQ || q.search || ''),
    catalogAfter: String(q.catalogAfter || ''), quoteTargetsAfter: String(q.quoteTargetsAfter || ''), businessDocumentsAfter: String(q.businessDocumentsAfter || ''),
    financialDocumentsAfter: String(q.financialDocumentsAfter || ''),
  });
  const rows = control.purchaseOrders || [];
  return {
    ...standardResult({ pageId: ctx.pageId, scope: ctx.scope, entityLabel: 'Purchase orders', rows, total: Number(control.queuePages?.purchaseOrders?.total || rows.length), recent: 0, actions: actionsFor(ctx.pageId) }),
    businessControl: control,
  };
}

async function loadBusinessSuppliers(ctx) {
  if (!ctx.scope.organization) return standardResult({ pageId: ctx.pageId, scope: ctx.scope, entityLabel: 'Suppliers', rows: [], total: 0, recent: 0, actions: actionsFor(ctx.pageId) });
  const [quoteStoreIds, orderStoreIds] = await Promise.all([
    QuoteRequest.find({ organizationId: ctx.scope.organization._id }).distinct('storeId'),
    PurchaseOrder.find({ organizationId: ctx.scope.organization._id }).distinct('storeId'),
  ]);
  const uniqueIds = [...new Set([...quoteStoreIds, ...orderStoreIds].map((value) => String(value)))];
  const query = uniqueIds.length ? { _id: { $in: uniqueIds }, status: { $ne: 'closed' } } : { _id: { $in: [] } };
  const [rows, total] = await Promise.all([
    Store.find(query).sort({ name: 1 }).limit(MAX_ROWS).lean(),
    Store.countDocuments(query),
  ]);
  return standardResult({ pageId: ctx.pageId, scope: ctx.scope, entityLabel: 'Suppliers', rows, total, recent: 0, actions: actionsFor(ctx.pageId) });
}

async function loadCustomerOrders(ctx) {
  const query = { userId: ctx.scope.user._id };
  const [rows, total] = await Promise.all([
    Order.find(query)
      .select('publicId status paymentState fulfillmentState cancellationState returnState refundState totals items paymentMethod deliveryMethod createdAt updatedAt')
      .sort({ createdAt: -1 })
      .limit(MAX_ROWS)
      .lean(),
    Order.countDocuments(query),
  ]);
  return standardResult({
    pageId: ctx.pageId,
    scope: ctx.scope,
    entityLabel: 'Orders',
    rows,
    total,
    recent: rows.filter((row) => row.createdAt && new Date(row.createdAt) >= new Date(Date.now() - 7 * 86_400_000)).length,
    actions: actionsFor(ctx.pageId),
  });
}


async function loadPromoterMessages(ctx) {
  const query = { promoterUserId: ctx.scope.user._id };
  const [threads, total, newCount, resolvedCount] = await Promise.all([
    PromoterContactRequest.find(query)
      .populate('customerUserId', 'name')
      .sort({ lastMessageAt: -1, _id: -1 })
      .limit(MAX_ROWS)
      .lean(),
    PromoterContactRequest.countDocuments(query),
    PromoterContactRequest.countDocuments({ ...query, status: 'new' }),
    PromoterContactRequest.countDocuments({ ...query, status: 'resolved' }),
  ]);
  return {
    ...standardResult({ pageId: ctx.pageId, scope: ctx.scope, entityLabel: 'Customer messages', rows: threads, total, recent: newCount, actions: actionsFor(ctx.pageId) }),
    promoterControl: {
      threads,
      messageStats: { total, newCount, openCount: Math.max(0, total - resolvedCount), resolvedCount },
    },
  };
}

async function loadPromoterPayouts(ctx) {
  const accountQuery = { ownerUserId: ctx.scope.user._id, ownerType: 'promoter' };
  const payoutAccounts = await PayoutAccount.find(accountQuery)
    .select('publicId ownerUserId ownerType country currency method label verifiedAt status createdAt updatedAt')
    .sort({ createdAt: -1 }).lean();
  const accountIds = payoutAccounts.map((row) => row._id).filter(Boolean);
  const payoutQuery = accountIds.length ? { ownerUserId: ctx.scope.user._id, payoutAccountId: { $in: accountIds } } : { _id: { $in: [] } };
  const payouts = await Payout.find(payoutQuery)
    .select('publicId payoutAccountId amountMinor currency status requestedAt providerReference failureMessage createdAt updatedAt')
    .populate('payoutAccountId', 'publicId label method country currency status')
    .sort({ requestedAt: -1, createdAt: -1 }).limit(MAX_ROWS).lean();
  return {
    ...standardResult({ pageId: ctx.pageId, scope: ctx.scope, entityLabel: 'Promoter payouts', rows: payouts, total: payouts.length, recent: 0, actions: actionsFor(ctx.pageId) }),
    promoterControl: {
      payoutAccounts,
      payouts,
      payoutIdempotencyKey: publicId('idem'),
      totals: { currency: ctx.scope.currency },
    },
  };
}

function financeCountryScope(scope, requestedCountry = '') {
  const requested = String(requestedCountry || '').trim().toUpperCase();
  if (requested && !/^[A-Z]{2}$/.test(requested)) throw new AppError('Choose a valid two-letter finance country.', 422, 'FINANCE_COUNTRY_INVALID');
  const allowed = scope.countryCodes || [];
  if (requested) {
    if (scope.user?.role !== 'super_admin' && allowed.length && !allowed.includes(requested)) {
      throw new AppError('Finance country is outside your operational scope.', 403, 'FINANCE_COUNTRY_FORBIDDEN');
    }
    return { country: requested };
  }
  if (scope.user?.role === 'super_admin' || !allowed.length) return {};
  return { country: allowed.length === 1 ? allowed[0] : { $in: allowed } };
}

function financeFilterState(ctx) {
  return {
    requestedCountry: String(ctx.request.query.country || '').trim().toUpperCase(),
    paymentStatus: String(ctx.request.query.paymentStatus || '').trim(),
    paymentProvider: String(ctx.request.query.paymentProvider || '').trim(),
    refundStatus: String(ctx.request.query.refundStatus || '').trim(),
    payoutStatus: String(ctx.request.query.payoutStatus || '').trim(),
    chargebackStatus: String(ctx.request.query.chargebackStatus || '').trim(),
    providerEventStatus: String(ctx.request.query.providerEventStatus || '').trim(),
    reconciliationStatus: String(ctx.request.query.reconciliationStatus || '').trim(),
  };
}

async function financeRelatedScopes(ctx, baseScope) {
  const [countryOrderIds, payoutAccountIds] = await Promise.all([
    Object.keys(baseScope).length ? Order.find(baseScope).distinct('_id') : Promise.resolve(null),
    Object.keys(baseScope).length ? PayoutAccount.find(baseScope).distinct('_id') : Promise.resolve(null),
  ]);
  return {
    countryOrderIds,
    payoutAccountIds,
    refundScope: countryOrderIds ? { orderId: { $in: countryOrderIds } } : {},
    payoutScope: payoutAccountIds ? { payoutAccountId: { $in: payoutAccountIds } } : {},
    codScope: { ...baseScope, kind: 'outbound', status: 'delivered', 'cod.required': true, 'cod.reconciledAt': null },
  };
}

async function loadFinancePayments(ctx) {
  const filters = financeFilterState(ctx);
  const baseScope = financeCountryScope(ctx.scope, filters.requestedCountry);
  const paymentSearch = String(ctx.request.query.paymentSearch || ctx.request.query.search || '').trim().slice(0, 180);
  const providerEventSearch = String(ctx.request.query.providerEventSearch || paymentSearch || '').trim().slice(0, 180);
  const paymentScope = { ...baseScope };
  if (['created','requires_action','pending','succeeded','failed','cancelled','pending_collection','refunded','partially_refunded','reversed'].includes(filters.paymentStatus)) paymentScope.status = filters.paymentStatus;
  if (['pesapal','cod','sandbox'].includes(filters.paymentProvider)) paymentScope.provider = filters.paymentProvider;
  if (paymentSearch) {
    paymentScope.$or = [
      { publicId: paymentSearch },
      { orderPublicId: paymentSearch },
      { traceId: paymentSearch.toLowerCase() },
      { providerReference: paymentSearch },
      { providerTrackingId: paymentSearch },
      { providerTransactionId: paymentSearch },
      { providerConfirmationCode: paymentSearch },
    ];
  }
  const providerScope = { provider: 'pesapal', ...baseScope };
  if (['received','processing','processed','ignored','failed','dead'].includes(filters.providerEventStatus)) providerScope.status = filters.providerEventStatus;
  if (providerEventSearch) {
    providerScope.$or = [
      { publicId: providerEventSearch },
      { eventId: providerEventSearch },
      { traceId: providerEventSearch.toLowerCase() },
      { orderPublicId: providerEventSearch },
      { paymentIntentPublicId: providerEventSearch },
      { merchantReference: providerEventSearch },
      { providerTrackingId: providerEventSearch },
    ];
  }

  const related = await financeRelatedScopes(ctx, baseScope);
  const [payments, paymentTotal, providerEvents, providerExceptionCount, payoutUnknownCount, reconciliationExceptionCount, staleRefundCount, staleRefunds, openChargebackCount, ledgerAccounts, codShipments] = await Promise.all([
    PaymentIntent.find(paymentScope).sort({ createdAt: -1 }).limit(MAX_ROWS).lean(),
    PaymentIntent.countDocuments(paymentScope),
    ProviderEvent.find(providerScope).select('publicId eventId traceId orderPublicId paymentIntentPublicId providerTrackingId status attempts error createdAt nextAttemptAt').sort({ createdAt: -1 }).limit(20).lean(),
    ProviderEvent.countDocuments({ ...baseScope, provider: 'pesapal', $or: [{ status: { $in: ['failed', 'dead'] } }, { orderPublicId: '' }] }),
    Payout.countDocuments({ ...related.payoutScope, status: 'unknown' }),
    ReconciliationRun.countDocuments({ ...baseScope, $or: [{ status: 'failed' }, { failed: { $gt: 0 } }] }),
    Refund.countDocuments({ ...related.refundScope, status: 'processing', updatedAt: { $lt: new Date(Date.now() - 2 * 60 * 60_000) } }),
    Refund.find({ ...related.refundScope, status: 'processing', updatedAt: { $lt: new Date(Date.now() - 2 * 60 * 60_000) } }).sort({ updatedAt: 1 }).limit(20).lean(),
    Chargeback.countDocuments({ ...baseScope, status: { $in: ['open', 'reviewing'] } }),
    LedgerAccount.find(baseScope).sort({ code: 1 }).limit(MAX_ROWS).lean(),
    Shipment.find(related.codScope).select('publicId country orderPublicId cod deliveredAt').sort({ deliveredAt: 1 }).limit(20).lean(),
  ]);
  const ledgerAccountIds = ledgerAccounts.map((account) => account._id);
  const balanceRows = ledgerAccountIds.length ? await LedgerTransaction.aggregate([
    { $match: { ...baseScope, 'entries.accountId': { $in: ledgerAccountIds } } },
    { $unwind: '$entries' },
    { $match: { 'entries.accountId': { $in: ledgerAccountIds } } },
    { $group: { _id: '$entries.accountId', debits: { $sum: '$entries.debitMinor' }, credits: { $sum: '$entries.creditMinor' } } },
  ]) : [];
  const balanceByAccount = new Map(balanceRows.map((row) => [String(row._id), { debits: Number(row.debits || 0), credits: Number(row.credits || 0) }]));
  const accountsWithBalance = ledgerAccounts.map((account) => {
    const totals = balanceByAccount.get(String(account._id)) || { debits: 0, credits: 0 };
    const balanceMinor = ['asset', 'expense'].includes(account.type) ? totals.debits - totals.credits : totals.credits - totals.debits;
    return { ...account, balanceMinor, debitsMinor: totals.debits, creditsMinor: totals.credits };
  });
  const financeExceptions = {
    providerEvents: providerExceptionCount,
    payoutUnknown: payoutUnknownCount,
    reconciliation: reconciliationExceptionCount,
    staleRefunds: staleRefundCount,
    openChargebacks: openChargebackCount,
    total: providerExceptionCount + payoutUnknownCount + reconciliationExceptionCount + staleRefundCount + openChargebackCount,
  };
  const result = standardResult({
    pageId: ctx.pageId,
    scope: ctx.scope,
    entityLabel: 'Payment intents',
    rows: payments,
    total: paymentTotal,
    recent: payments.filter((row) => row.createdAt && new Date(row.createdAt) >= new Date(Date.now() - 7 * 86_400_000)).length,
    actions: actionsFor(ctx.pageId),
  });
  return {
    ...result,
    financeControl: {
      ...filters,
      paymentSearch,
      providerEventSearch,
      payments,
      providerEvents,
      accountsWithBalance,
      financeExceptions,
      codScope: related.codScope,
      codShipments,
      staleRefunds,
      ledgerExportHref: '/finance/ledger.csv',
      traceFallback: 'legacy unavailable',
    },
  };
}

async function loadFinanceRefunds(ctx) {
  const filters = financeFilterState(ctx);
  const baseScope = financeCountryScope(ctx.scope, filters.requestedCountry);
  const { refundScope } = await financeRelatedScopes(ctx, baseScope);
  const refundSearch = String(ctx.request.query.refundSearch || ctx.request.query.search || '').trim().slice(0, 180);
  const query = { ...refundScope };
  if (['pending','processing','completed','failed','cancelled'].includes(filters.refundStatus)) query.status = filters.refundStatus;
  if (refundSearch) query.$or = [{ publicId: refundSearch }, { providerRefundId: refundSearch }, { manualReference: refundSearch }];
  const [rows, total] = await Promise.all([
    Refund.find(query).sort({ createdAt: -1 }).limit(MAX_ROWS).lean(),
    Refund.countDocuments(query),
  ]);
  return {
    ...standardResult({ pageId: ctx.pageId, scope: ctx.scope, entityLabel: 'Refunds', rows, total, recent: 0, actions: actionsFor(ctx.pageId) }),
    financeControl: { ...filters, refundSearch, refunds: rows },
  };
}

async function loadFinancePayouts(ctx) {
  const filters = financeFilterState(ctx);
  const baseScope = financeCountryScope(ctx.scope, filters.requestedCountry);
  const accountIds = await PayoutAccount.find(baseScope).distinct('_id');
  const payoutSearch = String(ctx.request.query.payoutSearch || ctx.request.query.search || '').trim().slice(0, 180);
  const query = accountIds.length ? { payoutAccountId: { $in: accountIds } } : { _id: { $in: [] } };
  if (['requested','approved','submitting','submitted','unknown','paid','failed','rejected'].includes(filters.payoutStatus)) query.status = filters.payoutStatus;
  if (payoutSearch) query.$or = [{ publicId: payoutSearch }, { providerReference: payoutSearch }, { ownerStorePublicId: payoutSearch }];
  const [rows, total] = await Promise.all([
    Payout.find(query).sort({ requestedAt: -1, createdAt: -1 }).limit(MAX_ROWS).lean(),
    Payout.countDocuments(query),
  ]);
  return {
    ...standardResult({ pageId: ctx.pageId, scope: ctx.scope, entityLabel: 'Payouts', rows, total, recent: 0, actions: actionsFor(ctx.pageId) }),
    financeControl: { ...filters, payoutSearch, payouts: rows },
  };
}

async function loadFinanceDisputes(ctx) {
  const filters = financeFilterState(ctx);
  const baseScope = financeCountryScope(ctx.scope, filters.requestedCountry);
  const chargebackSearch = String(ctx.request.query.chargebackSearch || ctx.request.query.search || '').trim().slice(0, 180);
  const query = { ...baseScope };
  if (['open','reviewing','won','lost'].includes(filters.chargebackStatus)) query.status = filters.chargebackStatus;
  if (chargebackSearch) query.$or = [{ publicId: chargebackSearch }, { orderPublicId: chargebackSearch }, { paymentIntentPublicId: chargebackSearch }, { providerTrackingId: chargebackSearch }, { providerReference: chargebackSearch }];
  const [rows, total] = await Promise.all([
    Chargeback.find(query).sort({ openedAt: -1 }).limit(MAX_ROWS).lean(),
    Chargeback.countDocuments(query),
  ]);
  return {
    ...standardResult({ pageId: ctx.pageId, scope: ctx.scope, entityLabel: 'Chargebacks', rows, total, recent: 0, actions: actionsFor(ctx.pageId) }),
    financeControl: { ...filters, chargebackSearch, chargebacks: rows },
  };
}

async function loadFinanceReconciliation(ctx) {
  const filters = financeFilterState(ctx);
  const baseScope = financeCountryScope(ctx.scope, filters.requestedCountry);
  const { codScope } = await financeRelatedScopes(ctx, baseScope);
  const reconciliationQuery = { ...baseScope };
  if (['running','completed','failed'].includes(filters.reconciliationStatus)) reconciliationQuery.status = filters.reconciliationStatus;
  const [runs, total, codShipments] = await Promise.all([
    ReconciliationRun.find(reconciliationQuery).sort({ createdAt: -1 }).limit(MAX_ROWS).lean(),
    ReconciliationRun.countDocuments(reconciliationQuery),
    Shipment.find(codScope).select('publicId country orderPublicId cod deliveredAt').sort({ deliveredAt: 1 }).limit(MAX_ROWS).lean(),
  ]);
  return {
    ...standardResult({ pageId: ctx.pageId, scope: ctx.scope, entityLabel: 'Reconciliation runs', rows: runs, total, recent: 0, actions: actionsFor(ctx.pageId) }),
    financeControl: { ...filters, reconciliationRuns: runs, codScope, codShipments },
  };
}

async function loadSupportQueue(ctx) {
  const ticketSearch = String(ctx.request.query.ticketSearch || '').trim().slice(0, 80);
  const ticketStatus = String(ctx.request.query.ticketStatus || '').trim();
  const ticketPriority = String(ctx.request.query.ticketPriority || '').trim();
  const ticketQueue = String(ctx.request.query.ticketQueue || '').trim();
  const ticketAssignment = String(ctx.request.query.ticketAssignment || '').trim();
  const ticketOverdue = String(ctx.request.query.ticketOverdue || '') === '1';
  const clauses = [countryFilter(SupportTicket, ctx.scope)];
  if (['open','in_progress','waiting_customer','escalated','resolved','closed'].includes(ticketStatus)) clauses.push({ status: ticketStatus });
  if (['low','normal','high','urgent'].includes(ticketPriority)) clauses.push({ priority: ticketPriority });
  if (['general','orders','payments','delivery','returns','accounts','seller'].includes(ticketQueue)) clauses.push({ queue: ticketQueue });
  if (ticketAssignment === 'mine') clauses.push({ assignedUserId: ctx.scope.user._id });
  else if (ticketAssignment === 'unassigned') clauses.push({ $or: [{ assignedUserId: null }, { assignedUserId: { $exists: false } }] });
  if (ticketOverdue) clauses.push({ status: { $nin: ['resolved','closed'] }, slaDueAt: { $lt: new Date() } });
  if (ticketSearch) {
    const pattern = new RegExp(escapeRegex(ticketSearch), 'i');
    clauses.push({ $or: [{ publicId: pattern }, { subject: pattern }, { orderPublicId: pattern }, { requesterName: pattern }] });
  }
  const query = clauses.length === 1 ? clauses[0] : { $and: clauses };
  const macroQuery = { ...countryFilter(SupportMacro, ctx.scope), active: true };
  const [tickets, total, macros] = await Promise.all([
    SupportTicket.find(query).select('publicId userId requesterName requesterEmailMasked orderPublicId country category subject status priority queue slaDueAt assignedUserId createdAt updatedAt').populate('assignedUserId','publicId name email').sort({ slaDueAt: 1, createdAt: -1 }).limit(MAX_ROWS).lean(),
    SupportTicket.countDocuments(query),
    SupportMacro.find(macroQuery).sort({ updatedAt: -1 }).limit(30).lean(),
  ]);
  return {
    ...standardResult({ pageId: ctx.pageId, scope: ctx.scope, entityLabel: 'Support tickets', rows: tickets, total, recent: 0, actions: actionsFor(ctx.pageId) }),
    supportControl: {
      tickets,
      macros,
      filters: { ticketSearch, ticketStatus, ticketPriority, ticketQueue, ticketAssignment, ticketOverdue },
    },
  };
}


function supportCanTrust(user) {
  return hasPermission(user, 'trust:manage') || hasPermission(user, 'catalogue:moderate') || user?.role === 'super_admin';
}

async function loadSupportCustomers(ctx) {
  const customerSearch = String(ctx.request.query.customerSearch || '').trim().slice(0, 100);
  let customers = [];
  if (customerSearch.length >= 2) {
    const pattern = new RegExp(escapeRegex(customerSearch), 'i');
    customers = await User.find({
      ...countryFilter(User, ctx.scope),
      role: 'customer',
      status: { $ne: 'deleted' },
      $or: [{ publicId: pattern }, { name: pattern }, { email: pattern }, { phone: pattern }],
    }).select('publicId name email phone country status createdAt').sort({ createdAt: -1 }).limit(20).lean();
  }
  return {
    ...standardResult({ pageId: ctx.pageId, scope: ctx.scope, entityLabel: 'Customers', rows: customers, total: customers.length, recent: 0, actions: actionsFor(ctx.pageId) }),
    supportControl: { customerSearch, customers, canTrust: supportCanTrust(ctx.scope.user) },
  };
}

async function loadSupportReturns(ctx) {
  const query = countryFilter(ReturnRequest, ctx.scope);
  const rows = await ReturnRequest.find(query)
    .select('publicId orderPublicId userId country status reason resolution returnMethod eligibleUntil inspection refundPublicId replacementOrderPublicId items createdAt updatedAt')
    .sort({ createdAt: -1 }).limit(MAX_ROWS).lean();
  const orderPublicIds = [...new Set(rows.map((row) => String(row.orderPublicId || '')).filter(Boolean))];
  const orders = orderPublicIds.length
    ? await Order.find({ ...countryFilter(Order, ctx.scope), publicId: { $in: orderPublicIds } }).select('publicId totals.currency').lean()
    : [];
  const currencyByOrder = new Map(orders.map((row) => [String(row.publicId), String(row.totals?.currency || '')]));
  const returns = rows.map((row) => ({ ...row, currency: currencyByOrder.get(String(row.orderPublicId)) || ctx.scope.currency }));
  return {
    ...standardResult({ pageId: ctx.pageId, scope: ctx.scope, entityLabel: 'Returns', rows: returns, total: returns.length, recent: 0, actions: actionsFor(ctx.pageId) }),
    supportControl: { returns, canTrust: supportCanTrust(ctx.scope.user) },
  };
}

async function loadSupportDisputes(ctx) {
  const query = countryFilter(Dispute, ctx.scope);
  const disputes = await Dispute.find(query)
    .select('publicId userId orderPublicId country category status subject priority assignedUserId resolvedAt createdAt updatedAt')
    .sort({ createdAt: -1 }).limit(MAX_ROWS).lean();
  return {
    ...standardResult({ pageId: ctx.pageId, scope: ctx.scope, entityLabel: 'Escalated cases', rows: disputes, total: disputes.length, recent: 0, actions: actionsFor(ctx.pageId) }),
    supportControl: { disputes, canTrust: supportCanTrust(ctx.scope.user) },
  };
}

async function loadSupportReviews(ctx) {
  const query = { ...countryFilter(Review, ctx.scope), status: { $in: ['pending', 'disputed'] } };
  const reviews = await Review.find(query)
    .select('publicId orderPublicId productPublicId country rating title body status disputeReason moderationReason createdAt disputedAt')
    .sort({ createdAt: -1 }).limit(MAX_ROWS).lean();
  return {
    ...standardResult({ pageId: ctx.pageId, scope: ctx.scope, entityLabel: 'Review issues', rows: reviews, total: reviews.length, recent: 0, actions: actionsFor(ctx.pageId) }),
    supportControl: { reviews, canTrust: supportCanTrust(ctx.scope.user) },
  };
}

async function loadModeratorReviews(ctx) {
  const reviewSearch = String(ctx.request.query.reviewSearch || '').trim().slice(0, 160);
  const query = { status: { $in: ['pending', 'disputed'] }, ...countryFilter(Review, ctx.scope) };
  if (reviewSearch) {
    const pattern = new RegExp(escapeRegex(reviewSearch), 'i');
    query.$or = [{ publicId: pattern }, { productPublicId: pattern }, { orderPublicId: pattern }, { title: pattern }, { body: pattern }];
  }
  const reviews = await Review.find(query)
    .select('publicId userId orderPublicId productPublicId country rating title body verifiedPurchase status moderationReason disputeReason disputedAt publishedAt createdAt updatedAt')
    .populate('userId', 'publicId name')
    .sort({ updatedAt: 1, createdAt: 1 }).limit(MAX_ROWS).lean();
  const rows = reviews.map((review) => ({ ...review, moderationAction: `/moderation/reviews/${encodeURIComponent(review.publicId)}/decision` }));
  return {
    ...standardResult({ pageId: ctx.pageId, scope: ctx.scope, entityLabel: 'Review moderation', rows, total: rows.length, recent: 0, actions: actionsFor(ctx.pageId) }),
    moderatorControl: { reviewSearch, reviews: rows },
  };
}

async function loadModeratorRiskCases(ctx) {
  const caseSearch = String(ctx.request.query.caseSearch || '').trim().slice(0, 160);
  const caseQuery = { ...countryFilter(TrustCase, ctx.scope), status: { $in: ['open', 'investigating', 'actioned', 'appealed'] } };
  if (caseSearch) {
    const pattern = new RegExp(escapeRegex(caseSearch), 'i');
    caseQuery.$or = [{ publicId: pattern }, { productPublicId: pattern }, { storePublicId: pattern }, { type: pattern }];
  }
  const [trustCases, riskSignals] = await Promise.all([
    TrustCase.find(caseQuery).select('publicId country type productPublicId storePublicId description status assignedUserId decision resolvedAt createdAt updatedAt').populate('assignedUserId','publicId name role').sort({ updatedAt: 1 }).limit(MAX_ROWS).lean(),
    RiskSignal.find({ ...countryFilter(RiskSignal, ctx.scope), status: 'open' }).select('publicId country subjectType subjectPublicId type severity score status decision reviewedAt createdAt updatedAt').sort({ severity: -1, score: -1 }).limit(MAX_ROWS).lean(),
  ]);
  return {
    ...standardResult({ pageId: ctx.pageId, scope: ctx.scope, entityLabel: 'Risk cases', rows: trustCases, total: trustCases.length, recent: 0, actions: actionsFor(ctx.pageId) }),
    moderatorControl: { caseSearch, trustCases, riskSignals },
  };
}

const WAREHOUSE_OPERATION_PAGES = new Map([
  ['warehouse-inventory', { model: StockItem, extra: {} }],
  ['warehouse-receiving', { model: WarehouseTask, extra: { type: { $in: ['receive', 'put_away'] } } }],
  ['warehouse-picking', { model: WarehouseTask, extra: { type: 'pick' } }],
  ['warehouse-packing', { model: WarehouseTask, extra: { type: 'pack' } }],
  ['warehouse-dispatch', { model: WarehouseTask, extra: { type: 'dispatch' } }],
  ['warehouse-returns', { model: WarehouseTask, extra: { type: 'return_inspection' } }],
]);

async function loadWarehouseOperations(ctx) {
  const config = WAREHOUSE_OPERATION_PAGES.get(ctx.pageId);
  if (!config) return loadGenericKind(ctx.page[6], ctx);
  const taskStatus = String(ctx.request.query.taskStatus || '').trim();
  const taskOverdue = String(ctx.request.query.taskOverdue || '') === '1';
  const scanCode = String(ctx.request.query.scanCode || '').trim().slice(0, 100);
  const extra = { ...config.extra };
  if (config.model === WarehouseTask) {
    if (['open','in_progress','completed','cancelled'].includes(taskStatus)) extra.status = taskStatus;
    if (taskOverdue) {
      extra.status = { $in: ['open','in_progress'] };
      extra.dueAt = { $lt: new Date() };
    }
  }
  const options = { extra };
  if (config.model === WarehouseTask) options.populate = [['warehouseId','publicId name country'],['assignedUserId','publicId name email'],['parcelId','publicId barcode status']];
  if (config.model === StockItem) options.populate = [['warehouseId','publicId name country'],['variantId','publicId sku title barcode']];
  const result = await loadModelRecords(config.model, ctx.scope, options);

  let scanResult = null;
  if (scanCode.length >= 2 && ctx.pageId === 'warehouse-inventory') {
    const warehouseQuery = countryFilter(Warehouse, ctx.scope);
    if (ctx.scope.warehousePublicIds.length) warehouseQuery.publicId = { $in: ctx.scope.warehousePublicIds };
    const warehouseIds = await Warehouse.find(warehouseQuery).distinct('_id');
    const stockScope = warehouseIds.length ? { warehouseId: { $in: warehouseIds } } : { _id: { $in: [] } };
    const variant = await ProductVariant.findOne({ $or: [{ sku: scanCode.toUpperCase() }, { barcode: scanCode }] }).select('_id publicId sku title barcode').lean();
    let stockItem = await StockItem.findOne({ ...stockScope, publicId: scanCode }).populate('warehouseId','publicId name country').populate('variantId','publicId sku title barcode').lean();
    if (!stockItem && variant) stockItem = await StockItem.findOne({ ...stockScope, variantId: variant._id }).populate('warehouseId','publicId name country').populate('variantId','publicId sku title barcode').lean();
    scanResult = stockItem ? {
      type: 'stock',
      publicId: stockItem.publicId,
      title: stockItem.variantId?.sku || stockItem.publicId,
      detail: `${stockItem.warehouseId?.name || ''} · on hand ${stockItem.onHand || 0} · available ${Math.max(0, Number(stockItem.onHand || 0) - Number(stockItem.reserved || 0) - Number(stockItem.damaged || 0) - Number(stockItem.quarantined || 0))}`,
    } : { type: 'not_found', publicId: '', title: 'No matching warehouse item', detail: 'Check the stock ID, SKU or barcode and try again.' };
  }

  const labels = {
    'warehouse-inventory': 'Inventory items',
    'warehouse-receiving': 'Receiving tasks',
    'warehouse-picking': 'Picking tasks',
    'warehouse-packing': 'Packing tasks',
    'warehouse-dispatch': 'Dispatch tasks',
    'warehouse-returns': 'Return inspection tasks',
  };
  return {
    ...standardResult({ pageId: ctx.pageId, scope: ctx.scope, entityLabel: labels[ctx.pageId] || 'Warehouse records', ...result, actions: actionsFor(ctx.pageId) }),
    warehouseControl: {
      taskStatus,
      taskOverdue,
      scanCode,
      scanResult,
      assignedWarehouseScopes: ctx.scope.warehousePublicIds,
    },
  };
}


async function loadWarehouseReports(ctx) {
  const warehouseQuery = countryFilter(Warehouse, ctx.scope);
  if (ctx.scope.warehousePublicIds.length) warehouseQuery.publicId = { $in: ctx.scope.warehousePublicIds };
  const warehouseIds = await Warehouse.find(warehouseQuery).distinct('_id');
  const scope = warehouseIds.length ? { warehouseId: { $in: warehouseIds } } : { _id: { $in: [] } };
  const [movements, waves, movementCountsRows, waveCountsRows] = await Promise.all([
    InventoryMovement.find(scope).select('publicId warehouseId stockItemId variantId type quantity onHandBefore onHandAfter reservedBefore reservedAfter damagedBefore damagedAfter quarantinedBefore quarantinedAfter reason reference actorUserId createdAt').populate('warehouseId','publicId name country').populate('variantId','publicId sku title').sort({ createdAt: -1 }).limit(MAX_ROWS).lean(),
    WarehouseWave.find(scope).select('publicId warehouseId country status assignedUserId taskCount totalQuantity dueAt startedAt completedAt releasedAt createdAt updatedAt').populate('warehouseId','publicId name country').sort({ createdAt: -1 }).limit(MAX_ROWS).lean(),
    InventoryMovement.aggregate([{ $match: scope }, { $group: { _id: '$type', count: { $sum: 1 }, quantity: { $sum: '$quantity' } } }]),
    WarehouseWave.aggregate([{ $match: scope }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
  ]);
  const movementCounts = Object.fromEntries(movementCountsRows.map((row) => [String(row._id || 'unknown'), { count: Number(row.count || 0), quantity: Number(row.quantity || 0) }]));
  const waveCounts = Object.fromEntries(waveCountsRows.map((row) => [String(row._id || 'unknown'), Number(row.count || 0)]));
  return {
    ...standardResult({ pageId: ctx.pageId, scope: ctx.scope, entityLabel: 'Inventory movements', rows: movements, total: movements.length, recent: 0, actions: actionsFor(ctx.pageId) }),
    warehouseControl: { movements, waves, movementCounts, waveCounts, assignedWarehouseScopes: ctx.scope.warehousePublicIds },
  };
}

async function loadGenericKind(kind, ctx) {
  if (ctx.pageId === 'promoter-messages') return loadPromoterMessages(ctx);
  if (ctx.pageId === 'promoter-payouts') return loadPromoterPayouts(ctx);
  if (ctx.pageId === 'support-customers') return loadSupportCustomers(ctx);
  if (ctx.pageId === 'support-returns') return loadSupportReturns(ctx);
  if (ctx.pageId === 'support-disputes') return loadSupportDisputes(ctx);
  if (ctx.pageId === 'support-reviews') return loadSupportReviews(ctx);
  if (ctx.pageId === 'moderator-reviews') return loadModeratorReviews(ctx);
  if (ctx.pageId === 'moderator-disputes') return loadModeratorRiskCases(ctx);
  if (ctx.pageId === 'warehouse-reports') return loadWarehouseReports(ctx);
  if (ctx.pageId === 'promoter-commissions' || ctx.pageId === 'promoter-analytics') return loadPromoterCommissionControl(ctx);
  if (ctx.pageId === 'promoter-marketplace') return loadPromoterCampaignMarketplace(ctx);
  if (ctx.pageId === 'promoter-links') return loadPromoterLinks(ctx);
  if (ctx.pageId === 'promoter-campaigns') return loadPromoterCampaigns(ctx);
  if (ctx.pageId === 'promoter-content') return loadPromoterContent(ctx);
  if (ctx.pageId === 'promoter-brands') return loadPromoterBrands(ctx);
  if (ctx.pageId === 'business-orders') return loadBusinessOrders(ctx);
  if (ctx.pageId === 'business-suppliers') return loadBusinessSuppliers(ctx);
  if (ctx.pageId === 'support-queue' && ctx.scope.workspace === 'support') return loadSupportQueue(ctx);
  if (ctx.pageId === 'orders' && ctx.scope.workspace === 'customer') return loadCustomerOrders(ctx);
  if (ctx.pageId === 'finance-payments') return loadFinancePayments(ctx);
  if (ctx.pageId === 'finance-refunds') return loadFinanceRefunds(ctx);
  if (ctx.pageId === 'finance-payouts') return loadFinancePayouts(ctx);
  if (ctx.pageId === 'finance-disputes') return loadFinanceDisputes(ctx);
  if (ctx.pageId === 'finance-reconciliation') return loadFinanceReconciliation(ctx);
  if (WAREHOUSE_OPERATION_PAGES.has(ctx.pageId)) return loadWarehouseOperations(ctx);
  if(kind==='reviews'&&ctx.scope.workspace==='seller') return loadSellerReviews(ctx);
  if(kind==='customers'&&ctx.scope.workspace==='seller') return loadSellerCustomers(ctx);
  const Model=entityModelFor(kind,ctx);
  const result=await loadModelRecords(Model,ctx.scope,entityOptionsFor(kind,ctx));
  const label={
    orders:'Orders',returns:'Returns',support:'Support tickets',rewards:'Reward activity',club:'Club activity',products:'Products','form-product':'Products',
    users:'Users',customers:'Customers',admins:'Administrators',roles:'Access grants',sellers:'Sellers',promoters:'Promoters',finance:'Financial records',
    commissions:'Commissions',disputes:'Disputes',reports:'Reports',audit:'Audit events',security:'Security findings',settings:'Settings',approvals:'Approvals',
    campaigns:'Campaigns',reviews:'Reviews',content:'Content',inventory:'Inventory records',shipping:'Shipments',payouts:'Payouts','settings-store':'Store settings',
    'campaigns-market':'Campaigns',links:'Tracking links',traffic:'Traffic events',conversions:'Conversions',referrals:'Referrals',brands:'Brands','settings-promoter':'Profile records',analytics:'Analytics records',
  }[kind]||'Records';
  return standardResult({pageId:ctx.pageId,scope:ctx.scope,entityLabel:label,...result,actions:actionsFor(ctx.pageId)});
}

const kinds = [
  'overview','orders','wishlist','addresses','rewards','wallet','returns','support','profile','categories','notifications','cart','club','analytics','users','roles','admins','sellers','promoters','customers','products','finance','commissions','subscriptions','disputes','reports','audit','security','settings','approvals','coupons','campaigns','reviews','content','form-product','inventory','shipping','payouts','messages','settings-store','campaigns-market','links','traffic','conversions','referrals','brands','settings-promoter',
];

function loaderForKind(kind) {
  if(kind==='overview') return loadOverview;
  if(kind==='wishlist') return loadWishlist;
  if(kind==='addresses') return loadAddresses;
  if(kind==='wallet') return loadWallet;
  if(kind==='profile') return loadProfile;
  if(kind==='categories') return loadCategories;
  if(kind==='notifications') return loadNotifications;
  if(kind==='messages') return loadMessages;
  if(kind==='subscriptions') return loadSubscriptions;
  if(kind==='coupons') return loadCoupons;
  if(kind==='cart') return loadCart;
  if(kind==='rewards'||kind==='club') return loadRewards;
  if(kind==='form-product') return loadProductEditor;
  if(['settings','settings-store','settings-promoter'].includes(kind)) return loadSettings;
  return (ctx)=>loadGenericKind(kind,ctx);
}

export const DASHBOARD_KIND_LOADERS = Object.freeze(Object.fromEntries(kinds.map((kind)=>[kind,loaderForKind(kind)])));


export async function loadDashboardNavigationState({ request, workspace }) {
  const userId = request.user?._id;
  if (!userId) return { wishlistCount: 0, cartCount: 0, notificationCount: 0 };

  const notificationQuery = {
    userId,
    readAt: null,
    $or: [{ expiresAt: null }, { expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }],
  };
  if (workspace !== 'customer') {
    return {
      wishlistCount: 0,
      cartCount: 0,
      notificationCount: await Notification.countDocuments(notificationQuery),
    };
  }

  const [catalogueState, cart, notificationCount] = await Promise.all([
    CustomerCatalogueState.findOne({ userId }).select('wishlistProductIds').lean(),
    Cart.findOne({ userId }).select('items.quantity').lean(),
    Notification.countDocuments(notificationQuery),
  ]);
  return {
    wishlistCount: Array.isArray(catalogueState?.wishlistProductIds) ? catalogueState.wishlistProductIds.length : 0,
    cartCount: (cart?.items || []).reduce((sum, item) => sum + Math.max(0, Number(item.quantity || 0)), 0),
    notificationCount,
  };
}

export async function loadDashboardPageData({ request, workspace, pageId }) {
  const page = pageDefinition(workspace,pageId);
  if(!page) throw new Error(`Unknown dashboard page: ${pageId}`);
  const scope=await resolveDashboardDataScope({request,workspace});
  if (workspace === 'seller' && pageId === 'seller-analytics' && !scope.sellerDataPlan?.analytics) {
    throw new AppError('Analytics access is not available for this seller membership.', 403, 'SELLER_ANALYTICS_FORBIDDEN');
  }
  const kind=page[6];
  const loader=DASHBOARD_KIND_LOADERS[kind];
  if(!loader) throw new Error(`No dashboard data loader for page kind: ${kind}`);
  const data=await loader({request,workspace,pageId,page,scope});
  const form = data.form || formForPage(pageId, scope);
  return {...data,form,kind,access:{canAnalytics:workspace!=='seller'||Boolean(scope.sellerDataPlan?.analytics),sellerRole:scope.sellerRole||''},scope:{workspace,countryCodes:scope.countryCodes,currency:scope.currency,store:scope.store?{publicId:scope.store.publicId,name:scope.store.name,country:scope.store.country,currency:scope.store.currency}:null,organization:scope.organization?{publicId:scope.organization.publicId,companyName:scope.organization.companyName}:null}};
}
