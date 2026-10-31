import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { canonicalPhone } from '../core/phone.js';
import { CountrySetting, CustomerAddress } from '../models/index.js';
import { writeAudit } from './audit.js';
import { currentCustomerAccess } from './customer-access.js';

export const customerAddressSchema = z.object({
  label: z.string().trim().min(1).max(80).default('Address'),
  fullName: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(7).max(32),
  address: z.string().trim().min(5).max(240),
  region: z.string().trim().max(120).optional().default(''),
  postalCode: z.string().trim().max(30).optional().default(''),
  city: z.string().trim().min(2).max(120),
  country: z.string().trim().regex(/^[A-Za-z]{2}$/).transform((value) => value.toUpperCase()),
  note: z.string().trim().max(500).optional().default(''),
  isDefault: z.union([z.boolean(), z.string()]).optional().transform((value) => value === true || value === 'true' || value === 'on' || value === '1'),
  version: z.coerce.number().int().nonnegative().optional(),
});

export async function listCustomerAddresses(userId) {
  return CustomerAddress.find({ userId, archivedAt: null }).sort({ isDefault: -1, updatedAt: -1, _id: -1 }).lean();
}

async function normalizeInput(rawInput, session) {
  const { version, ...input } = customerAddressSchema.parse(rawInput);
  if (!await CountrySetting.exists({ code: input.country, active: true }).session(session)) {
    throw new AppError('Select an available delivery country.', 422, 'ADDRESS_COUNTRY_UNAVAILABLE');
  }
  input.phone = canonicalPhone(input.phone, input.phone.startsWith('+') ? undefined : input.country);
  return { input, version };
}

function checkVersion(address, version) {
  if (version !== undefined && version !== Number(address.__v || 0)) throw new AppError('This address changed. Reload before saving it.', 409, 'ADDRESS_CHANGED');
}

async function normalizeDefault(userId, addressId, session) {
  await CustomerAddress.updateMany({ userId, _id: { $ne: addressId }, archivedAt: null, isDefault: true }, { $set: { isDefault: false } }, { session });
}

async function repairDefault(userId, session) {
  const address=await CustomerAddress.findOne({userId,archivedAt:null}).sort({isDefault:-1,updatedAt:-1,_id:-1}).session(session);
  if(!address)return;
  await normalizeDefault(userId,address._id,session);
  if(!address.isDefault){address.isDefault=true;await address.save({session});}
}

export async function createCustomerAddress(request, rawInput) {
  const session = await mongoose.startSession();
  let created;
  try {
    await session.withTransaction(async () => {
      await currentCustomerAccess(request, { session, write: true });
      const { input } = await normalizeInput(rawInput, session);
      const existing = await CustomerAddress.countDocuments({ userId: request.user._id, archivedAt: null }).session(session);
      if (existing >= 50) throw new AppError('Save up to 50 delivery addresses. Remove an old address before adding another.', 409, 'ADDRESS_LIMIT');
      const isDefault = input.isDefault || existing === 0;
      [created] = await CustomerAddress.create([{ publicId: publicId('adr'), userId: request.user._id, ...input, isDefault }], { session });
      if (isDefault) await normalizeDefault(request.user._id, created._id, session);
      else await repairDefault(request.user._id,session);
      await writeAudit(request, 'customer.address_created', { session, targetType: 'customer_address', targetPublicId: created.publicId, country: created.country, metadata: { isDefault } });
    });
    return created;
  } finally { await session.endSession(); }
}

export async function updateCustomerAddress(request, publicIdValue, rawInput) {
  const session = await mongoose.startSession();
  let updated;
  try {
    await session.withTransaction(async () => {
      await currentCustomerAccess(request, { session, write: true });
      const { input, version } = await normalizeInput(rawInput, session);
      updated = await CustomerAddress.findOne({ publicId: publicIdValue, userId: request.user._id, archivedAt: null }).session(session);
      if (!updated) throw new AppError('Address not found.', 404, 'ADDRESS_NOT_FOUND');
      checkVersion(updated, version);
      // Editing the default address never leaves the account without a default.
      input.isDefault = input.isDefault || updated.isDefault;
      Object.assign(updated, input);
      if (input.isDefault) await normalizeDefault(request.user._id, updated._id, session);
      await updated.save({ session });
      if(!input.isDefault)await repairDefault(request.user._id,session);
      await writeAudit(request, 'customer.address_updated', { session, targetType: 'customer_address', targetPublicId: updated.publicId, country: updated.country, metadata: { isDefault: updated.isDefault } });
    });
    return updated;
  } finally { await session.endSession(); }
}

export async function setDefaultCustomerAddress(request, publicIdValue) {
  const session = await mongoose.startSession();
  let address;
  try {
    await session.withTransaction(async () => {
      await currentCustomerAccess(request, { session, write: true });
      address = await CustomerAddress.findOne({ publicId: publicIdValue, userId: request.user._id, archivedAt: null }).session(session);
      if (!address) throw new AppError('Address not found.', 404, 'ADDRESS_NOT_FOUND');
      await normalizeDefault(request.user._id, address._id, session);
      address.isDefault = true;
      await address.save({ session });
      await writeAudit(request, 'customer.address_defaulted', { session, targetType: 'customer_address', targetPublicId: address.publicId, country: address.country });
    });
    return address;
  } finally { await session.endSession(); }
}

export async function archiveCustomerAddress(request, publicIdValue) {
  const session = await mongoose.startSession();
  let address;
  try {
    await session.withTransaction(async () => {
      await currentCustomerAccess(request, { session, write: true });
      address = await CustomerAddress.findOne({ publicId: publicIdValue, userId: request.user._id, archivedAt: null }).session(session);
      if (!address) throw new AppError('Address not found.', 404, 'ADDRESS_NOT_FOUND');
      address.archivedAt = new Date(); address.isDefault = false;
      await address.save({ session });
      await repairDefault(request.user._id,session);
      await writeAudit(request, 'customer.address_archived', { session, targetType: 'customer_address', targetPublicId: address.publicId, country: address.country });
    });
    return address;
  } finally { await session.endSession(); }
}
