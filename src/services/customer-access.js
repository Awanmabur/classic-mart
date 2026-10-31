import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
import { hashToken } from '../core/crypto.js';
import { env } from '../config/env.js';
import { Device, User, MobileSession } from '../models/index.js';

/** Customer controls always operate on the current identity, never a role label. */
export async function currentCustomerAccess(request, { session = null, write = false } = {}) {
  if (!request.user?._id) throw new AppError('Sign in to manage your account.', 401, 'UNAUTHENTICATED');
  // A hydrated schema default must not invent version zero for a sparse or
  // incorrectly typed legacy identity record.
  const actorQuery = () => User.findById(request.user._id).where({ 'security.tokenVersion': mongoose.trusted({ $type: 'number' }) }).session(session);
  const needsDevice = request.sessionID !== undefined || Boolean(request.device?._id);
  const deviceQuery = () => Device.findOne({ userId: request.user._id, sessionHash: hashToken(request.sessionID), revokedAt: null,
    ...(request.device?._id ? { _id: request.device._id } : {}) }).select('+sessionHash').session(session).lean();
  let actor, device = null, deviceLoaded = false;
  if (!session && needsDevice && typeof request.sessionID === 'string' && request.sessionID
    && (request.session?.userId === undefined || String(request.session.userId) === String(request.user._id))) {
    // Both lookup keys come from the current request. Validate the freshly read
    // identity and device below; never reuse either result across access checks.
    [actor, device] = await Promise.all([actorQuery(), deviceQuery()]);
    deviceLoaded = true;
  } else actor = await actorQuery();
  const actorVersion = actor?.security?.tokenVersion;
  const callerVersion = request.user.security?.tokenVersion;
  const sessionVersion = request.session?.tokenVersion;
  if (!actor || actor.status !== 'active' || !Number.isSafeInteger(actorVersion) || actorVersion < 0
    || !Number.isSafeInteger(callerVersion) || callerVersion < 0 || actorVersion !== callerVersion
    || sessionVersion !== undefined && (!Number.isSafeInteger(sessionVersion) || sessionVersion < 0 || actorVersion !== sessionVersion)
    || !env.auth.simpleLogin && (!actor.emailVerifiedAt || !actor.onboardingCompletedAt)) {
    throw new AppError('Your verified account or session is unavailable.', 403, 'ACCOUNT_UNAVAILABLE');
  }
  let mobile = null;
  if (request.mobileSession) {
    mobile = await MobileSession.findOne({ _id: request.mobileSession._id, userId: actor._id,
      userTokenVersion: actor.security.tokenVersion, revokedAt: null, accessExpiresAt: mongoose.trusted({ $gt: new Date() }) }).session(session).lean();
    if (!mobile || mobile.publicId !== request.mobileSession.publicId) throw new AppError('Your connected app session is unavailable.', 403, 'ACCOUNT_UNAVAILABLE');
  }
  if (needsDevice) {
    if (typeof request.sessionID !== 'string' || !request.sessionID
      || request.session?.userId !== undefined && String(request.session.userId) !== String(actor._id)) {
      throw new AppError('Your account session is unavailable.', 403, 'ACCOUNT_UNAVAILABLE');
    }
    if (!deviceLoaded) device = await deviceQuery();
    if (!device) throw new AppError('Your account session is unavailable.', 403, 'ACCOUNT_UNAVAILABLE');
  }
  if (write) {
    if (!session?.inTransaction()) throw new AppError('Account changes require a transaction.', 500, 'CUSTOMER_TRANSACTION_REQUIRED');
    const fenced = await User.updateOne({ _id: actor._id, status: 'active', __v: actor.__v || 0,
      'security.tokenVersion': actor.security.tokenVersion }, { $inc: { __v: 1 } }, { session });
    if (fenced.modifiedCount !== 1) throw new AppError('Your account changed. Reload before continuing.', 409, 'ACCOUNT_ACCESS_CHANGED');
    actor.__v = (actor.__v || 0) + 1;
    if (device) {
      const fencedDevice = await Device.updateOne({ _id: device._id, userId: actor._id,
        sessionHash: device.sessionHash, revokedAt: null, __v: device.__v || 0 }, { $inc: { __v: 1 } }, { session });
      if (fencedDevice.modifiedCount !== 1) throw new AppError('Your account session changed. Reload before continuing.', 409, 'ACCOUNT_ACCESS_CHANGED');
    }
    if (mobile) {
      const fencedMobile = await MobileSession.updateOne({ _id: mobile._id, userId: actor._id,
        userTokenVersion: actor.security.tokenVersion, revokedAt: null, accessExpiresAt: mongoose.trusted({ $gt: new Date() }),
        __v: mobile.__v || 0 }, { $inc: { __v: 1 } }, { session });
      if (fencedMobile.modifiedCount !== 1) throw new AppError('Your connected app session changed. Sign in again.', 403, 'ACCOUNT_UNAVAILABLE');
    }
  }
  return actor;
}

export async function customerTransaction(work) {
  const session = await mongoose.startSession();
  try { return await session.withTransaction(() => work(session)); }
  finally { await session.endSession(); }
}
