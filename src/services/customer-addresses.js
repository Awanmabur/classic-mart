import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { CustomerAddress } from '../models/index.js';
import { writeAudit } from './audit.js';

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
});

export async function listCustomerAddresses(userId) {
  return CustomerAddress.find({ userId, archivedAt: null }).sort({ isDefault: -1, updatedAt: -1 }).lean();
}

async function normalizeDefault(userId, addressId, session) {
  await CustomerAddress.updateMany({ userId, _id: { $ne: addressId }, archivedAt: null }, { $set: { isDefault: false } }, { session });
}

export async function createCustomerAddress(request, rawInput) {
  const input = customerAddressSchema.parse(rawInput);
  const session = await mongoose.startSession();
  let created;
  try {
    await session.withTransaction(async () => {
      const existing = await CustomerAddress.countDocuments({ userId: request.user._id, archivedAt: null }).session(session);
      const isDefault = input.isDefault || existing === 0;
      [created] = await CustomerAddress.create([{ publicId: publicId('adr'), userId: request.user._id, ...input, isDefault }], { session });
      if (isDefault) await normalizeDefault(request.user._id, created._id, session);
      await writeAudit(request, 'customer.address_created', { session, targetType: 'customer_address', targetPublicId: created.publicId, country: created.country, metadata: { isDefault } });
    });
    return created;
  } finally { await session.endSession(); }
}

export async function updateCustomerAddress(request, publicIdValue, rawInput) {
  const input = customerAddressSchema.parse(rawInput);
  const session = await mongoose.startSession();
  let updated;
  try {
    await session.withTransaction(async () => {
      updated = await CustomerAddress.findOne({ publicId: publicIdValue, userId: request.user._id, archivedAt: null }).session(session);
      if (!updated) throw new AppError('Address not found.', 404, 'ADDRESS_NOT_FOUND');
      Object.assign(updated, input);
      if (input.isDefault) await normalizeDefault(request.user._id, updated._id, session);
      await updated.save({ session });
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
      address = await CustomerAddress.findOne({ publicId: publicIdValue, userId: request.user._id, archivedAt: null }).session(session);
      if (!address) throw new AppError('Address not found.', 404, 'ADDRESS_NOT_FOUND');
      const wasDefault = address.isDefault;
      address.archivedAt = new Date(); address.isDefault = false;
      await address.save({ session });
      if (wasDefault) {
        const replacement = await CustomerAddress.findOne({ userId: request.user._id, archivedAt: null, _id: { $ne: address._id } }).sort({ updatedAt: -1 }).session(session);
        if (replacement) { replacement.isDefault = true; await replacement.save({ session }); }
      }
      await writeAudit(request, 'customer.address_archived', { session, targetType: 'customer_address', targetPublicId: address.publicId, country: address.country });
    });
    return address;
  } finally { await session.endSession(); }
}
