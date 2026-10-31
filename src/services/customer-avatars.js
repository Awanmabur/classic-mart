import crypto from 'node:crypto';
import multer from 'multer';
import sharp from 'sharp';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { decryptPrivateBuffer, encryptPrivateBuffer } from '../core/sensitive.js';
import { CustomerAvatar } from '../models/CustomerAvatar.js';
import { currentCustomerAccess, customerTransaction } from './customer-access.js';
import { scanUpload } from './malware.js';
import { deleteMediaObject, putMediaObject, readMediaObjectBuffer } from './object-storage.js';
import { writeAudit } from './audit.js';

const mimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
export const uploadCustomerAvatar = multer({ storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 4, parts: 5 },
  fileFilter(_request, file, callback) {
    callback(mimeTypes.has(file.mimetype) ? null : new AppError('Choose a JPEG, PNG or WebP photo.', 422, 'AVATAR_TYPE_INVALID'), mimeTypes.has(file.mimetype));
  },
}).single('avatar');

export async function customerAvatarUrl(userId) {
  const avatar = await CustomerAvatar.findOne({ userId, current: true, status: 'active' }).select('publicId').lean();
  return avatar ? `/account/avatar?v=${encodeURIComponent(avatar.publicId)}` : '/approved-dashboard/assets/avatar.svg';
}

async function sanitizedAvatar(file) {
  if (!file?.buffer || !mimeTypes.has(file.mimetype)) throw new AppError('Choose a JPEG, PNG or WebP photo.', 422, 'AVATAR_REQUIRED');
  await scanUpload(file.buffer);
  try {
    const metadata = await sharp(file.buffer, { failOn: 'warning', limitInputPixels: 16_000_000, animated: false }).metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format) || metadata.width < 320 || metadata.height < 320 || metadata.pages > 1) {
      throw new AppError('Choose a still photo at least 320 × 320 pixels.', 422, 'AVATAR_DIMENSIONS_INVALID');
    }
    // Decode and re-encode removes metadata and untrusted embedded payloads.
    return await sharp(file.buffer, { failOn: 'warning', limitInputPixels: 16_000_000 }).rotate()
      .resize(320, 320, { fit: 'cover' }).webp({ quality: 84, effort: 4 }).toBuffer();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('The selected photo is not a valid image.', 422, 'AVATAR_INVALID');
  }
}

export async function updateCustomerAvatar(request, file) {
  await currentCustomerAccess(request);
  const bytes = await sanitizedAvatar(file), id = publicId('avt');
  const storageKey = `customer-avatar-${request.user.publicId}/${crypto.randomUUID()}.cmv`;
  // Persist the cleanup obligation before storage, so a crash cannot orphan bytes.
  const staged = await CustomerAvatar.create({ publicId: id, userId: request.user._id, storageKey,
    mimeType: 'image/webp', sizeBytes: bytes.length, width: 320, height: 320,
    checksumSha256: crypto.createHash('sha256').update(bytes).digest('hex'), status: 'staged',
    cleanupAfter: new Date(Date.now() + 15 * 60_000) });
  try {
    await putMediaObject(storageKey, encryptPrivateBuffer(bytes, storageKey), { contentType: 'application/octet-stream', cacheControl: 'private, no-store' });
    await customerTransaction(async session => {
      const actor = await currentCustomerAccess(request, { session, write: true });
      const asset = await CustomerAvatar.findOne({ _id: staged._id, userId: actor._id, status: 'staged', current: false }).session(session);
      if (!asset) throw new AppError('This photo upload expired. Choose the photo again.', 409, 'AVATAR_UPLOAD_EXPIRED');
      await CustomerAvatar.updateMany({ userId: actor._id, current: true }, { $set: { current: false, status: 'pending_delete', cleanupAfter: new Date() } }, { session });
      asset.current = true; asset.status = 'active'; asset.cleanupAfter = undefined; await asset.save({ session });
      await writeAudit(request, 'customer.avatar_updated', { session, targetType: 'customer_avatar', targetPublicId: asset.publicId, country: actor.country });
    });
  } catch (error) {
    await CustomerAvatar.updateOne({ _id: staged._id, current: false, status: { $ne: 'active' } }, { $set: { status: 'pending_delete', cleanupAfter: new Date() } });
    throw error;
  }
  return { publicId: id, url: `/account/avatar?v=${encodeURIComponent(id)}` };
}

/** Also called by privacy deletion, in the identity anonymization transaction. */
export async function queueCustomerAvatarRemoval(userId, session) {
  return CustomerAvatar.updateMany({ userId, status: { $in: ['active', 'staged'] } },
    { $set: { current: false, status: 'pending_delete', cleanupAfter: new Date() } }, { session });
}

export async function deleteCustomerAvatar(request) {
  return customerTransaction(async session => {
    const actor = await currentCustomerAccess(request, { session, write: true });
    await queueCustomerAvatarRemoval(actor._id, session);
    await writeAudit(request, 'customer.avatar_removed', { session, targetType: 'user', targetPublicId: actor.publicId, country: actor.country });
  });
}

export async function sendCustomerAvatar(request, response) {
  const actor = await currentCustomerAccess(request);
  const avatar = await CustomerAvatar.findOne({ userId: actor._id, status: 'active', current: true }).select('+storageKey').lean();
  if (!avatar) throw new AppError('Profile photo not found.', 404, 'AVATAR_NOT_FOUND');
  const bytes = decryptPrivateBuffer(await readMediaObjectBuffer(avatar.storageKey), avatar.storageKey);
  // Private reads re-check current authorization and removal after storage I/O.
  await currentCustomerAccess(request);
  if (!await CustomerAvatar.exists({ _id: avatar._id, userId: actor._id, current: true, status: 'active' })) {
    throw new AppError('Profile photo not found.', 404, 'AVATAR_NOT_FOUND');
  }
  response.set({ 'Cache-Control': 'private, no-store', 'Content-Type': 'image/webp',
    'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow, noarchive' });
  return response.send(bytes);
}

/** Durable, idempotent physical cleanup reclaims abandoned uploads and leases. */
export async function processCustomerAvatarCleanup({ workerId = `avatar-${process.pid}`, limit = 20 } = {}) {
  let processed = 0;
  for (let index = 0; index < Math.min(100, Math.max(0, limit)); index++) {
    const now = new Date(), token = crypto.randomUUID();
    const asset = await CustomerAvatar.findOneAndUpdate({ current: false, status: { $in: ['staged', 'pending_delete', 'deleting', 'deleted'] },
      cleanupAfter: { $lte: now }, $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }] },
    { $set: { status: 'deleting', leaseToken: token, lockedUntil: new Date(now.getTime() + 2 * 60_000) }, $inc: { attempts: 1 } },
    { sort: { cleanupAfter: 1, _id: 1 }, returnDocument: 'after' }).select('+storageKey +leaseToken');
    if (!asset) break;
    try {
      await deleteMediaObject(asset.storageKey);
      await CustomerAvatar.updateOne({ _id: asset._id, current: false, status: 'deleting', leaseToken: token },
        // Tombstones remain scheduled: an interrupted old writer may resume
        // after an abandoned staging lease was cleaned. Rechecking also makes
        // historical "deleted" metadata insufficient to skip physical cleanup.
        { $set: { status: 'deleted', deletedAt: asset.deletedAt || new Date(), lastError: '', leaseToken: '',
          cleanupAfter: new Date(Date.now() + 24 * 60 * 60_000) }, $unset: { lockedUntil: 1 } });
      processed++;
    } catch {
      await CustomerAvatar.updateOne({ _id: asset._id, current: false, status: 'deleting', leaseToken: token },
        { $set: { status: 'pending_delete', lastError: 'Private photo cleanup failed; retry scheduled.', leaseToken: '',
          cleanupAfter: new Date(Date.now() + Math.min(60, 2 ** Math.min(asset.attempts, 6)) * 60_000) }, $unset: { lockedUntil: 1 } });
    }
  }
  return processed;
}
