import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { Category, Brand, Product, Store, StoreMember, Review } from '../models/index.js';
import { writeAudit } from './audit.js';
import { clearStorefrontCache } from './storefront.js';
import { moderationReviewPipeline, moderationTrustAction } from './moderation-trust-pages.js';
import { countryAdminAccess, fenceCountryAdminAccess, assertCountryAdminReadAccess, countryAdminPublicContext as publicContext } from './country-admin-workspace-access.js';

const idValue = z.string().trim().min(4).max(100).regex(/^[A-Za-z0-9_-]+$/);
const revision = z.union([z.number(), z.string().regex(/^\d+$/)]).pipe(z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
const same = (a, b) => String(a || '') === String(b || '');
const asArray = value => Array.isArray(value) ? value : [];
const conflict = () => new AppError('The catalogue record changed. Reload before continuing.', 409, 'COUNTRY_ADMIN_CATALOGUE_VERSION_CONFLICT');
const notFound = () => new AppError('Catalogue record not found.', 404, 'COUNTRY_ADMIN_CATALOGUE_NOT_FOUND');
const selectedCountries = context => context.country ? [context.country] : context.countries.map(row => row.code);

function catalogueType(type) {
  if (['category', 'categories'].includes(type)) return { kind: 'category', Model: Category, reference: 'categoryId' };
  if (['brand', 'brands'].includes(type)) return { kind: 'brand', Model: Brand, reference: 'brandId' };
  throw notFound();
}

function booleanValue(value) {
  if (value === true || ['true', 'yes', 'on', '1'].includes(value)) return true;
  if (value === false || ['false', 'no', 'off', '0', ''].includes(value)) return false;
  throw new AppError('Choose a valid catalogue setting.', 422, 'COUNTRY_ADMIN_CATALOGUE_INPUT_INVALID');
}

function countryValues(value) {
  const values = typeof value === 'string' ? value.split(/[\s,]+/).filter(Boolean) : value;
  return [...new Set(z.array(z.string().trim().regex(/^[A-Z]{2}$/)).min(1).max(20).parse(values))];
}

const attributeValue = z.object({
  key: z.string().trim().min(1).max(60).regex(/^[a-z][a-z0-9_]*$/).refine(value => !['__proto__', 'prototype', 'constructor'].includes(value)),
  label: z.string().trim().min(1).max(80), type: z.enum(['text', 'number', 'boolean', 'select']),
  required: z.boolean().default(false), options: z.array(z.string().trim().min(1).max(80)).max(100).default([]),
}).strict();

function categoryAttributes(value) {
  let parsed = value;
  if (typeof value === 'string') {
    if (!value.trim()) parsed = [];
    else if (value.trim().startsWith('[')) {
      try { parsed = JSON.parse(value); }
      catch { throw new AppError('Enter valid category attributes.', 422, 'ATTRIBUTE_INVALID'); }
    } else {
      parsed = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
        const parts = line.split('|').map(part => part.trim());
        if (parts.length < 2 || parts.length > 5) throw new AppError('Use key | label | type | required | options for each attribute.', 422, 'ATTRIBUTE_INVALID');
        return { key: parts[0], label: parts[1], type: parts[2] || 'text', required: booleanValue(parts[3] || 'no'),
          options: parts[4] ? parts[4].split(',').map(option => option.trim()) : [] };
      });
    }
  }
  const attributes = z.array(attributeValue).max(30).parse(parsed), keys = new Set();
  for (const attribute of attributes) {
    if (keys.has(attribute.key) || new Set(attribute.options).size !== attribute.options.length
      || attribute.type === 'select' && !attribute.options.length
      || attribute.type !== 'select' && attribute.options.length) {
      throw new AppError('Use unique attribute keys and valid select options.', 422, 'ATTRIBUTE_INVALID');
    }
    keys.add(attribute.key);
  }
  return attributes;
}

function catalogueInput(body, kind) {
  const allowed = new Set(['_csrf', 'version', 'reason', 'name', 'slug', 'action', 'type']);
  for (const name of kind === 'category' ? ['description', 'active', 'restricted', 'countries', 'attributes'] : ['status', 'decision']) allowed.add(name);
  if (Object.keys(body).some(name => !allowed.has(name))) throw new AppError('This field cannot be changed through country administration.', 422, 'COUNTRY_ADMIN_CATALOGUE_FIELD_FORBIDDEN');
  const input = z.object({ version: revision, reason: z.string().trim().min(3).max(1000),
    name: z.string().trim().min(2).max(100).optional(), slug: z.string().trim().min(2).max(100).regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/).optional(),
    action: z.enum(['update', 'approve', 'reject']).optional() }).parse(body);
  const changes = {};
  if (input.name !== undefined) changes.name = input.name;
  if (input.slug !== undefined) changes.slug = input.slug;
  if (kind === 'category') {
    if (input.action && input.action !== 'update') throw new AppError('Choose a category update.', 422, 'COUNTRY_ADMIN_CATALOGUE_INPUT_INVALID');
    if (body.description !== undefined) changes.description = z.string().trim().max(500).parse(body.description);
    if (body.active !== undefined) changes.active = booleanValue(body.active);
    if (body.restricted !== undefined) changes.restricted = booleanValue(body.restricted);
    if (body.countries !== undefined) changes.countries = countryValues(body.countries);
    if (body.attributes !== undefined) changes.attributes = categoryAttributes(body.attributes);
  } else {
    const decision = body.decision === undefined ? input.action : z.enum(['approve', 'reject']).parse(body.decision);
    if (body.status !== undefined) changes.status = z.enum(['pending', 'approved', 'rejected']).parse(body.status);
    if (decision === 'approve' || decision === 'reject') {
      const status = decision === 'approve' ? 'approved' : 'rejected';
      if (changes.status && changes.status !== status) throw new AppError('Choose one brand decision.', 422, 'COUNTRY_ADMIN_CATALOGUE_INPUT_INVALID');
      changes.status = status;
    }
  }
  if (!Object.keys(changes).length) throw new AppError('Choose at least one catalogue change.', 422, 'COUNTRY_ADMIN_CATALOGUE_INPUT_INVALID');
  return { ...input, changes };
}

/** Read every current source; labels alone never establish authority over a shared record. */
async function catalogueSources(config, record, session = null) {
  const products = await Product.find({ [config.reference]: record._id }).select('publicId storeId countries attributes status __v').session(session).lean();
  const storeIds = [...new Set(products.map(row => String(row.storeId)))];
  if (config.kind === 'brand' && record.requestedByStoreId) storeIds.push(String(record.requestedByStoreId));
  const stores = storeIds.length ? await Store.find({ _id: mongoose.trusted({ $in: [...new Set(storeIds)] }) })
    .select('publicId country ownerUserId status __v').session(session).lean() : [];
  const storeById = new Map(stores.map(row => [String(row._id), row]));
  const countries = [...new Set([...(config.kind === 'category' ? asArray(record.countries) : []),
    ...products.flatMap(row => asArray(row.countries)), ...stores.map(row => row.country)])].sort();
  const invalid = products.some(row => !storeById.has(String(row.storeId)) || !asArray(row.countries).length)
    || config.kind === 'brand' && record.requestedByStoreId && !storeById.has(String(record.requestedByStoreId));
  return { products, stores, countries, invalid };
}

function editRestriction(context, config, record, source, nextCountries = []) {
  if (config.kind === 'category' && !asArray(record.countries).length) return 'Global categories require platform-wide administration.';
  if (config.kind === 'brand' && record.status === 'approved') return 'Approved brands are shared across markets and require platform-wide administration.';
  if (config.kind === 'brand' && !record.requestedByStoreId) return 'A verified requesting store is required to change this brand.';
  if (source.invalid || !source.countries.length) return 'The current catalogue source linkage needs investigation.';
  const allowed = new Set(context.countries.map(row => row.code));
  if ([...source.countries, ...nextCountries].some(code => !/^[A-Z]{2}$/.test(code) || !allowed.has(code))) return 'Every affected selling market and source store must be within your authorized countries.';
  return '';
}

function assertVisible(context, config, record, source) {
  const codes = new Set(selectedCountries(context));
  const global = config.kind === 'category' ? !asArray(record.countries).length : record.status === 'approved';
  if (!global && !source.countries.some(code => codes.has(code))) throw notFound();
}

function catalogueDto(record, kind) {
  const result = { publicId: record.publicId, name: record.name, slug: record.slug, version: Number(record.__v || 0), createdAt: record.createdAt, updatedAt: record.updatedAt };
  if (kind === 'category') Object.assign(result, { description: record.description || '', active: Boolean(record.active), restricted: Boolean(record.restricted),
    countries: [...asArray(record.countries)], attributes: asArray(record.attributes).map(row => ({ key: row.key, label: row.label, type: row.type, required: Boolean(row.required), options: [...asArray(row.options)] })) });
  else result.status = record.status;
  return result;
}

export async function loadCountryAdminCategoryDetail(request, rawId, type = 'categories') {
  const config = catalogueType(type), id = idValue.parse(rawId), context = await countryAdminAccess(request);
  const record = await config.Model.findOne({ publicId: id }).lean();
  if (!record) throw notFound();
  const source = await catalogueSources(config, record);
  assertVisible(context, config, record, source);
  const readOnlyReason = editRestriction(context, config, record, source);
  await assertCountryAdminReadAccess(request, context);
  return { kind: config.kind, context: publicContext(context), record: catalogueDto(record, config.kind),
    canEdit: !readOnlyReason, readOnlyReason, affectedCountries: source.countries, referencedProducts: source.products.length };
}

function preserveProductAttributes(attributes, products) {
  const declared = new Map(attributes.map(row => [row.key, row]));
  for (const product of products) {
    const supplied = product.attributes instanceof Map ? Object.fromEntries(product.attributes) : product.attributes || {};
    for (const [key, rawValue] of Object.entries(supplied)) {
      const field = declared.get(key), value = String(rawValue);
      if (!field || field.type === 'number' && !/^-?\d{1,12}(?:\.\d{1,6})?$/.test(value)
        || field.type === 'boolean' && !['true', 'false'].includes(value)
        || field.type === 'select' && !field.options.includes(value)) {
        throw new AppError('This change would invalidate attributes on an existing product.', 409, 'COUNTRY_ADMIN_CATEGORY_ATTRIBUTES_IN_USE');
      }
    }
    if (['submitted', 'approved', 'published', 'suspended'].includes(product.status)
      && attributes.some(field => field.required && !String(supplied[field.key] || '').trim())) {
      throw new AppError('Existing reviewed products must retain every required category attribute.', 409, 'COUNTRY_ADMIN_CATEGORY_ATTRIBUTES_IN_USE');
    }
  }
}

async function fenceCatalogueSources(source, session) {
  for (const [Model, records] of [[Product, source.products], [Store, source.stores]]) {
    for (const record of records) {
      const result = await Model.updateOne({ _id: record._id, publicId: record.publicId, __v: record.__v || 0 }, { $inc: { __v: 1 } }, { session });
      if (result.modifiedCount !== 1) throw conflict();
    }
  }
}

export async function actCountryAdminCategory(request, type = 'categories') {
  const config = catalogueType(type), id = idValue.parse(request.params?.publicId || request.params?.id), input = catalogueInput(request.body || {}, config.kind);
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const context = await countryAdminAccess(request, { session }), record = await config.Model.findOne({ publicId: id }).session(session).lean();
      if (!record) throw notFound();
      if (Number(record.__v || 0) !== input.version) throw conflict();
      const source = await catalogueSources(config, record, session);
      assertVisible(context, config, record, source);
      const restriction = editRestriction(context, config, record, source, input.changes.countries || []);
      if (restriction) throw new AppError(restriction, 403, 'COUNTRY_ADMIN_CATALOGUE_COUNTRY_FORBIDDEN');
      if (config.kind === 'category') {
        if (input.changes.countries && source.products.some(product => product.countries.some(code => !input.changes.countries.includes(code)))) {
          throw new AppError('The category must retain every market used by an existing product.', 409, 'COUNTRY_ADMIN_CATEGORY_COUNTRIES_IN_USE');
        }
        if (input.changes.attributes) preserveProductAttributes(input.changes.attributes, source.products);
      }
      if (input.changes.slug && await config.Model.exists({ slug: input.changes.slug, _id: mongoose.trusted({ $ne: record._id }) }).session(session)) {
        throw new AppError('Choose a unique catalogue slug.', 409, 'COUNTRY_ADMIN_CATALOGUE_DUPLICATE');
      }
      await fenceCountryAdminAccess(context, session, { allMarkets: true });
      await fenceCatalogueSources(source, session);
      const changes = { ...input.changes };
      if (config.kind === 'brand' && changes.status) changes.reviewedByUserId = context.actor._id;
      const saved = await config.Model.findOneAndUpdate({ _id: record._id, publicId: id, __v: input.version }, { $set: changes, $inc: { __v: 1 } },
        { session, runValidators: true, returnDocument: 'after' }).lean();
      if (!saved) throw conflict();
      await writeAudit(request, 'country_admin.' + config.kind + '_updated', { session, actor: context.actor, targetType: config.kind, targetPublicId: id,
        country: context.country || source.countries[0], metadata: { reason: input.reason, changedFields: Object.keys(input.changes), countries: source.countries,
          version: saved.__v, ...(config.kind === 'brand' ? { previousStatus: record.status, status: saved.status } : {}) } });
      result = catalogueDto(saved, config.kind);
    });
    clearStorefrontCache();
    return result;
  } catch (error) {
    if (error.code === 11000) throw new AppError('Choose a unique catalogue name and slug.', 409, 'COUNTRY_ADMIN_CATALOGUE_DUPLICATE');
    throw error;
  } finally { await session.endSession(); }
}

function reviewDto(row, actor) {
  const assignment = !row.assignedUserId ? 'unassigned' : same(row.assignedUserId, actor._id) ? 'mine' : 'other';
  const history = entries => asArray(entries).map(entry => ({ action: entry.action, status: entry.status, reason: entry.reason || '', at: entry.at,
    actor: same(entry.actorUserId, actor._id) ? 'You' : 'Another reviewer' }));
  return { publicId: row.publicId, country: row.country, orderPublicId: row.orderPublicId, orderLinePublicId: row.orderLinePublicId || '', productPublicId: row.productPublicId,
    rating: row.rating, title: row.title || '', body: row.body, verifiedPurchase: Boolean(row.verifiedPurchase), status: row.status, version: Number(row.__v || 0),
    assignment: { state: assignment, mine: assignment === 'mine', unassigned: assignment === 'unassigned', other: assignment === 'other' },
    assignedAt: row.assignedAt || null, moderationReason: row.moderationReason || '', disputeReason: row.disputeReason || '',
    createdAt: row.createdAt, updatedAt: row.updatedAt, publishedAt: row.publishedAt || null, moderatedAt: row.moderatedAt || null,
    publicMessages: asArray(row.publicMessages).map(message => ({ author: message.author, message: message.message, at: message.at })),
    assignmentHistory: history(row.assignmentHistory), decisionHistory: history(row.decisionHistory) };
}

export async function loadCountryAdminReviewDetail(request, rawId) {
  const id = idValue.parse(rawId), context = await countryAdminAccess(request);
  const [row] = await Review.aggregate([...moderationReviewPipeline(context, { record: id }),
    { $match: { 'sourceStore.country': { $in: context.countries.map(market => market.code) } } }, { $limit: 1 }]);
  if (!row) throw new AppError('Verified review not found.', 404, 'REVIEW_NOT_FOUND');
  let independenceReason = '';
  if ([row.userId, row.disputedByUserId, row.sourceProduct.ownerUserId, row.sourceStore.ownerUserId].some(value => value && same(value, context.actor._id))
    || await StoreMember.exists({ storeId: row.sourceStore._id, userId: context.actor._id, status: mongoose.trusted({ $in: ['active', 'invited'] }) })) {
    independenceReason = 'An independent reviewer must handle this review.';
  }
  const record = reviewDto(row, context.actor), active = ['pending', 'disputed'].includes(row.status), canAct = active && !independenceReason;
  await assertCountryAdminReadAccess(request, context);
  return { kind: 'review', context: publicContext(context), record, canAct, independenceReason,
    canClaim: canAct && record.assignment.unassigned, canRelease: canAct && record.assignment.mine, canDecide: canAct && record.assignment.mine,
    product: { publicId: row.sourceProduct.publicId, title: row.sourceProduct.title, countries: [...asArray(row.sourceProduct.countries)], status: row.sourceProduct.status },
    store: { publicId: row.sourceStore.publicId, name: row.sourceStore.name, country: row.sourceStore.country, status: row.sourceStore.status },
    order: { publicId: row.sourceOrder.publicId, country: row.sourceOrder.country, fulfillmentState: row.sourceOrder.fulfillmentState,
      orderLinePublicId: row.orderLinePublicId || '' } };
}

export async function actCountryAdminReview(request, action) {
  const id = idValue.parse(request.params?.publicId || request.params?.id), chosen = z.enum(['claim', 'release', 'publish', 'reject', 'reply', 'decision']).parse(action || request.body?.action);
  const context = await countryAdminAccess(request), input = z.object({ version: revision, reason: z.string().trim().max(500).optional(),
    message: z.string().trim().max(1000).optional(), decision: z.enum(['publish', 'reject']).optional() }).parse(request.body || {});
  if (chosen === 'decision' && !input.decision) throw new AppError('Choose a review decision.', 422, 'COUNTRY_ADMIN_REVIEW_INPUT_INVALID');
  const scoped = Object.create(request);
  Object.defineProperty(scoped, 'requiredOperationalWorkspace', { value: 'admin' });
  const saved = await moderationTrustAction(scoped, 'reviews', id, { action: chosen === 'decision' ? input.decision : chosen,
    version: input.version, reason: input.reason, message: input.message }, { workspace: false, requireClaim: true });
  clearStorefrontCache();
  return reviewDto(saved, context.actor);
}
