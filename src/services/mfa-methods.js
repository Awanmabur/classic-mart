import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { env } from '../config/env.js';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { hashToken, hashValue, normalizePhone, randomCode, safeEqual, verifyPassword } from '../core/crypto.js';
import { canonicalPhone } from '../core/phone.js';
import { Device, MfaChallenge, PasskeyCredential, User } from '../models/index.js';
import { currentCustomerAccess, customerTransaction } from './customer-access.js';
import { enabledMfaMethods, smsMfaAllowed, strongMfaFence } from './mfa-policy.js';
import { hydratePlatformAuthorization } from './platform-grants.js';
import { sendMfaVerificationCode } from './sms.js';
import { clearMfa, verifyMfa } from './mfa.js';
import { writeAudit } from './audit.js';

const TTL_MS = 5 * 60_000;
const MANAGEMENT_ACTIONS = new Set(['step-up', 'recovery-codes', 'disable', 'revoke-passkey', 'remove-sms']);
const sessionHash = request => {
  if (typeof request.sessionID !== 'string' || !request.sessionID) throw new AppError('Sign in again before continuing.', 401, 'MFA_SESSION_REQUIRED');
  return hashToken(request.sessionID);
};
const invalidChallenge = () => new AppError('This security request expired or changed. Start again.', 422, 'MFA_CHALLENGE_INVALID');
const invalidCode = () => new AppError('The security code is invalid or expired.', 422, 'MFA_CODE_INVALID');
const phoneHash = actor => hashValue(normalizePhone(actor.phone));
const recoveryHash = code => hashToken(`mfa-recovery:${code.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`);

export function makeRecoveryCodes() {
  return Array.from({ length: 10 }, () => crypto.randomBytes(9).toString('hex').toUpperCase().match(/.{1,6}/g).join('-'));
}

export function passkeyRelyingParty() {
  let site;
  try { site = new URL(env.baseUrl); } catch { throw new AppError('Passkey access is not configured.', 503, 'PASSKEY_NOT_CONFIGURED'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(site.hostname);
  if (site.username || site.password || site.protocol !== 'https:' && !(local && !env.isProduction && site.protocol === 'http:')) {
    throw new AppError('Passkeys require the configured secure website address.', 503, 'PASSKEY_NOT_CONFIGURED');
  }
  return { rpID: site.hostname, origin: site.origin };
}

export function maskedMfaPhone(actor) {
  const phone = normalizePhone(actor.phone);
  return phone.length > 5 ? `${phone.slice(0, 4)}${'•'.repeat(Math.min(7, phone.length - 7))}${phone.slice(-3)}` : 'your saved phone';
}

export async function currentLoginMfaActor(request) {
  const challenge = request.session?.mfaChallenge;
  if (!challenge?.userId || !Number.isSafeInteger(challenge.tokenVersion) || !Number.isFinite(challenge.issuedAt)
    || challenge.issuedAt > Date.now() || Date.now() - challenge.issuedAt > 10 * 60_000) throw invalidChallenge();
  const actor = await User.findById(challenge.userId).select('+security.mfaSmsPhoneHash');
  if (!actor || actor.status !== 'active' || !actor.security?.mfaEnabled || actor.security.tokenVersion !== challenge.tokenVersion) throw invalidChallenge();
  await hydratePlatformAuthorization(actor);
  return actor;
}

export async function mfaSecurityOptions(request, actor = request.user) {
  const credentials = await PasskeyCredential.find({ userId: actor._id, revokedAt: null }).select('publicId name createdAt lastUsedAt deviceType backedUp').sort({ createdAt: -1 }).limit(20).lean();
  const strong = Boolean(await User.exists({ _id: actor._id, $and: [strongMfaFence()] }));
  return { methods: enabledMfaMethods(actor), managementMethods: enabledMfaMethods(actor).filter(method => method !== 'sms' || !strong), strong,
    smsAllowed: smsMfaAllowed(actor), phone: maskedMfaPhone(actor), credentials,
    smsEnrollmentChallengeId: typeof request.session?.mfaSmsEnrollmentChallengeId === 'string' ? request.session.mfaSmsEnrollmentChallengeId : '',
    smsChallengeIds: request.session?.mfaSmsChallengeIds || {} };
}

async function passwordActor(request, password) {
  if (typeof password !== 'string' || !password || password.length > 256) throw new AppError('Enter your current password.', 422, 'INVALID_CURRENT_PASSWORD');
  const actor = await currentCustomerAccess(request);
  await hydratePlatformAuthorization(actor);
  const secret = await User.findById(actor._id).select('+passwordHash +security.mfaSmsPhoneHash');
  if (!secret || secret.security.tokenVersion !== actor.security.tokenVersion || !(await verifyPassword(secret.passwordHash, String(password || '')))) {
    throw new AppError('The current password is incorrect.', 422, 'INVALID_CURRENT_PASSWORD');
  }
  return { actor, passwordHashDigest: hashToken(secret.passwordHash) };
}

async function requireRecentFactor(request, actor) {
  if (!actor.security.mfaEnabled) return;
  const verified = Number(request.session?.mfaVerifiedAt || 0), age = Date.now() - verified;
  if (!Number.isFinite(verified) || age < 0 || age > TTL_MS
    || request.session?.mfaVerifiedMethod === undefined && request.session?.mfaVerifiedStrong === false
    || request.session?.mfaVerifiedMethod === 'sms' && request.session?.mfaPhoneHash !== phoneHash(actor)) {
    throw new AppError('Confirm your identity below before adding or changing a security method.', 403, 'MFA_VERIFICATION_REQUIRED');
  }
  const strong = Boolean(await User.exists({ _id: actor._id, 'security.tokenVersion': actor.security.tokenVersion, $and: [strongMfaFence()] }));
  if (strong && (request.session?.mfaVerifiedMethod === 'sms' || request.session?.mfaVerifiedStrong === false)) {
    throw new AppError('Confirm with your passkey, authenticator or a strong recovery code before changing security methods.', 403, 'MFA_STRONG_REQUIRED');
  }
}

export async function assertMfaMethodAddition(request) {
  const actor = await currentCustomerAccess(request);
  await requireRecentFactor(request, actor);
  return actor;
}

async function requireSmsAllowed(actor) {
  await hydratePlatformAuthorization(actor);
  if (!smsMfaAllowed(actor)) throw new AppError('Use an authenticator or passkey for this operational account.', 403, 'MFA_STRONG_REQUIRED');
  if (!canonicalPhone(actor.phone)) throw new AppError('Save a valid phone number in your profile first.', 422, 'MFA_PHONE_REQUIRED');
}

async function createChallenge(request, actor, purpose, token, extra = {}) {
  const scope = { userId: actor._id, sessionHash: sessionHash(request), purpose, ...(extra.action ? { action: extra.action } : {}) };
  await MfaChallenge.updateMany({ ...scope, consumedAt: null }, { $set: { consumedAt: new Date() } });
  return MfaChallenge.create({ ...scope, publicId: publicId('mfc'), tokenVersion: actor.security.tokenVersion,
    tokenHash: hashToken(token), expiresAt: new Date(Date.now() + TTL_MS), ...extra });
}

function challengeScope(request, actor, id, purpose, extra = {}) {
  if (!/^mfc_[a-f0-9]{32}$/.test(String(id || ''))) throw invalidChallenge();
  return { publicId: id, userId: actor._id, sessionHash: sessionHash(request), tokenVersion: actor.security.tokenVersion,
    purpose, consumedAt: null, expiresAt: mongoose.trusted({ $gt: new Date() }), ...extra };
}

async function loadChallenge(request, actor, id, purpose, extra = {}, session = null) {
  const challenge = await MfaChallenge.findOne(challengeScope(request, actor, id, purpose, extra))
    .select('+tokenHash +phoneHash +passwordHashDigest').session(session);
  if (!challenge) throw invalidChallenge();
  if (challenge.passwordHashDigest) {
    const current = await User.findById(actor._id).select('+passwordHash').session(session);
    if (!current || !safeEqual(hashToken(current.passwordHash), challenge.passwordHashDigest)) throw invalidChallenge();
  }
  return challenge;
}

async function claimChallenge(challenge, session = null) {
  const result = await MfaChallenge.updateOne({ _id: challenge._id, consumedAt: null,
    tokenVersion: challenge.tokenVersion, expiresAt: mongoose.trusted({ $gt: new Date() }), attempts: mongoose.trusted({ $lte: 5 }) },
  { $set: { consumedAt: new Date() } }, { session });
  if (result.modifiedCount !== 1) throw invalidChallenge();
}

async function sendSmsChallenge(request, actor, purpose, extra = {}) {
  await requireSmsAllowed(actor);
  const now = new Date();
  const reserved = await User.updateOne({ _id: actor._id, status: 'active', 'security.tokenVersion': actor.security.tokenVersion,
    phone: actor.phone, $or: [{ 'security.mfaSmsLastSentAt': mongoose.trusted({ $exists: false }) },
      { 'security.mfaSmsLastSentAt': mongoose.trusted({ $lte: new Date(now.getTime() - 60_000) }) }] },
  { $set: { 'security.mfaSmsLastSentAt': now } });
  if (reserved.modifiedCount !== 1) throw new AppError('Wait one minute before requesting another security SMS.', 429, 'MFA_SMS_COOLDOWN');
  const code = randomCode();
  const challenge = await createChallenge(request, actor, purpose, code, { ...extra, phoneHash: phoneHash(actor) });
  try {
    const delivery = await sendMfaVerificationCode({ phone: normalizePhone(actor.phone), name: actor.name, code });
    if (!delivery.accepted && !delivery.developmentCode) throw new AppError('SMS delivery is unavailable.', 503, 'SMS_NOT_CONFIGURED');
    await MfaChallenge.updateOne({ _id: challenge._id, consumedAt: null }, { $set: { deliveredAt: new Date() } });
    return { challengeId: challenge.publicId, developmentCode: !env.isProduction ? delivery.developmentCode : undefined };
  } catch (error) {
    await MfaChallenge.updateOne({ _id: challenge._id }, { $set: { consumedAt: new Date() } });
    throw error;
  }
}

async function prepareSmsProof(request, actor, id, purpose, code, extra = {}) {
  await requireSmsAllowed(actor);
  const challenge = await loadChallenge(request, actor, id, purpose, extra);
  if (!challenge.deliveredAt || challenge.phoneHash !== phoneHash(actor)) throw invalidChallenge();
  const attempt = await MfaChallenge.updateOne({ _id: challenge._id, consumedAt: null,
    attempts: mongoose.trusted({ $lt: 5 }), expiresAt: mongoose.trusted({ $gt: new Date() }) }, { $inc: { attempts: 1 } });
  if (attempt.modifiedCount !== 1 || !/^\d{6}$/.test(String(code || '')) || !safeEqual(hashToken(String(code)), challenge.tokenHash)) throw invalidCode();
  return challenge;
}

async function activateMethod(request, actor, method, extra, session) {
  const current = await currentCustomerAccess(request, { session, write: true });
  await hydratePlatformAuthorization(current);
  if (String(current._id) !== String(actor._id) || current.security.tokenVersion !== actor.security.tokenVersion) throw invalidChallenge();
  const wasStrong = Boolean(await User.exists({ _id: actor._id, $and: [strongMfaFence()] }).session(session));
  const methods = current.security.mfaEnabled ? enabledMfaMethods(current) : [];
  const nextMethods = [...new Set([...methods, method])];
  const codes = !current.security.mfaEnabled || method === 'passkey' && !wasStrong ? makeRecoveryCodes() : null;
  const changed = await User.findOneAndUpdate({ _id: current._id, __v: current.__v, 'security.tokenVersion': current.security.tokenVersion }, {
    $set: { 'security.mfaEnabled': true, 'security.mfaMethods': nextMethods, 'security.mfaEnrolledAt': current.security.mfaEnrolledAt || new Date(),
      ...(codes ? { 'security.mfaRecoveryCodeHashes': codes.map(recoveryHash), 'security.mfaRecoveryGeneratedAt': new Date(), 'security.mfaRecoveryStrong': wasStrong || method === 'passkey' } : {}), ...extra },
    $inc: { 'security.tokenVersion': 1, __v: 1 },
  }, { returnDocument: 'after', session });
  if (!changed) throw invalidChallenge();
  await Device.updateMany({ userId: changed._id, revokedAt: null, publicId: { $ne: request.device.publicId } },
    { $set: { revokedAt: new Date(), revokedReason: 'mfa_method_added' } }, { session });
  await writeAudit(request, 'account.mfa_method_added', { actor: changed, targetType: 'user', targetPublicId: changed.publicId, metadata: { method }, session });
  return { user: changed, codes };
}

export async function beginSmsMfaEnrollment(request, password) {
  const { actor, passwordHashDigest } = await passwordActor(request, password);
  await requireSmsAllowed(actor); await requireRecentFactor(request, actor);
  if (enabledMfaMethods(actor).includes('sms')) throw new AppError('SMS security is already enabled.', 409, 'MFA_ALREADY_ENABLED');
  return sendSmsChallenge(request, actor, 'sms_enroll', { passwordHashDigest });
}

export async function confirmSmsMfaEnrollment(request, id, code) {
  const actor = await currentCustomerAccess(request);
  const proof = await prepareSmsProof(request, actor, id, 'sms_enroll', code);
  return customerTransaction(async session => {
    const current = await currentCustomerAccess(request, { session });
    await requireSmsAllowed(current);
    await loadChallenge(request, current, id, 'sms_enroll', {}, session);
    if (proof.phoneHash !== phoneHash(current)) throw invalidChallenge();
    await claimChallenge(proof, session);
    return activateMethod(request, current, 'sms', { 'security.mfaSmsPhoneHash': proof.phoneHash,
      'security.mfaSmsEnrolledAt': new Date(), phoneVerifiedAt: current.phoneVerifiedAt || new Date() }, session);
  });
}

export async function sendLoginSmsMfa(request) {
  const actor = await currentLoginMfaActor(request);
  if (!enabledMfaMethods(actor).includes('sms') || !actor.phoneVerifiedAt || actor.security.mfaSmsPhoneHash !== phoneHash(actor)) throw invalidChallenge();
  return sendSmsChallenge(request, actor, 'sms_auth');
}

export async function verifyLoginSmsMfa(request, id, code) {
  const actor = await currentLoginMfaActor(request);
  if (!enabledMfaMethods(actor).includes('sms') || !actor.phoneVerifiedAt || actor.security.mfaSmsPhoneHash !== phoneHash(actor)) throw invalidChallenge();
  const proof = await prepareSmsProof(request, actor, id, 'sms_auth', code);
  await customerTransaction(async session => {
    const current = await User.findOne({ _id: actor._id, status: 'active', phone: actor.phone,
      phoneVerifiedAt: mongoose.trusted({ $ne: null }), 'security.tokenVersion': actor.security.tokenVersion,
      'security.mfaEnabled': true, 'security.mfaMethods': 'sms', 'security.mfaSmsPhoneHash': proof.phoneHash }).session(session);
    if (!current) throw invalidChallenge();
    await requireSmsAllowed(current);
    await loadChallenge(request, current, id, 'sms_auth', {}, session);
    const fenced = await User.updateOne({ _id: current._id, __v: current.__v,
      'security.tokenVersion': current.security.tokenVersion, phone: current.phone, 'security.mfaSmsPhoneHash': proof.phoneHash },
    { $inc: { __v: 1 } }, { session });
    if (fenced.modifiedCount !== 1) throw invalidChallenge();
    await claimChallenge(proof, session);
  });
  return { user: actor, method: 'sms', strong: false };
}

export async function sendAccountSmsMfa(request, password, action, credentialPublicId = '') {
  if (!MANAGEMENT_ACTIONS.has(action)) throw invalidChallenge();
  const { actor, passwordHashDigest } = await passwordActor(request, password);
  if (await User.exists({ _id: actor._id, $and: [strongMfaFence()] })) throw new AppError('Use your passkey or authenticator for security changes.', 403, 'MFA_STRONG_REQUIRED');
  const secret = await User.findById(actor._id).select('+security.mfaSmsPhoneHash');
  if (!enabledMfaMethods(actor).includes('sms') || !actor.phoneVerifiedAt || secret.security.mfaSmsPhoneHash !== phoneHash(actor)) throw invalidChallenge();
  return sendSmsChallenge(request, actor, 'sms_manage', { passwordHashDigest, action, credentialPublicId });
}

export async function verifyAccountSmsMfa(request, code, action, credentialPublicId = '') {
  const actor = await currentCustomerAccess(request);
  const secret = await User.findById(actor._id).select('+security.mfaSmsPhoneHash');
  if (!enabledMfaMethods(actor).includes('sms') || !actor.phoneVerifiedAt || secret.security.mfaSmsPhoneHash !== phoneHash(actor)) throw invalidChallenge();
  const id = request.body.challengeId || request.session?.mfaSmsChallengeIds?.[`${action}:${credentialPublicId}`];
  const proof = await prepareSmsProof(request, actor, id, 'sms_manage', code, { action, credentialPublicId });
  await claimChallenge(proof);
  return { user: actor, method: 'sms', strong: false };
}

export async function beginPasskeyEnrollment(request, password, name = '') {
  const { actor, passwordHashDigest } = await passwordActor(request, password);
  await requireRecentFactor(request, actor);
  const existing = await PasskeyCredential.find({ userId: actor._id, revokedAt: null }).select('+credentialId transports').limit(20);
  if (existing.length >= 10) throw new AppError('Remove an unused passkey before adding another.', 409, 'PASSKEY_LIMIT');
  const { rpID } = passkeyRelyingParty();
  const options = await generateRegistrationOptions({ rpName: 'Classic Mart', rpID, userName: actor.email,
    userID: new Uint8Array(crypto.createHash('sha256').update(actor.publicId).digest()), userDisplayName: actor.name,
    timeout: 60_000, attestationType: 'none', supportedAlgorithmIDs: [-7, -257],
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    excludeCredentials: existing.map(item => ({ id: item.credentialId, transports: item.transports })) });
  const challenge = await createChallenge(request, actor, 'passkey_enroll', options.challenge,
    { passwordHashDigest, name: String(name || 'My passkey').trim().slice(0, 80) || 'My passkey' });
  return { options, challengeId: challenge.publicId };
}

function responseShape(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response) || response.type !== 'public-key'
    || typeof response.id !== 'string' || !/^[A-Za-z0-9_-]{1,4096}$/.test(response.id)
    || JSON.stringify(response).length > 100_000) throw new AppError('The passkey response is invalid.', 422, 'PASSKEY_INVALID');
}

export async function confirmPasskeyEnrollment(request, id, response) {
  responseShape(response);
  const actor = await currentCustomerAccess(request);
  const proof = await loadChallenge(request, actor, id, 'passkey_enroll');
  const { rpID, origin } = passkeyRelyingParty();
  let verified;
  try { verified = await verifyRegistrationResponse({ response, expectedChallenge: value => safeEqual(hashToken(value), proof.tokenHash),
    expectedOrigin: origin, expectedRPID: rpID, requireUserPresence: true, requireUserVerification: true, supportedAlgorithmIDs: [-7, -257] }); }
  catch { throw new AppError('The passkey could not be verified. Start again on the configured website.', 422, 'PASSKEY_INVALID'); }
  if (!verified.verified || !verified.registrationInfo?.userVerified) throw invalidChallenge();
  return customerTransaction(async session => {
    const current = await currentCustomerAccess(request, { session });
    await loadChallenge(request, current, id, 'passkey_enroll', {}, session);
    await claimChallenge(proof, session);
    const count = await PasskeyCredential.countDocuments({ userId: current._id, revokedAt: null }).session(session);
    if (count >= 10) throw new AppError('Remove an unused passkey before adding another.', 409, 'PASSKEY_LIMIT');
    const info = verified.registrationInfo;
    try { await PasskeyCredential.create([{ publicId: publicId('pky'), userId: current._id, credentialId: info.credential.id,
      publicKey: Buffer.from(info.credential.publicKey), counter: info.credential.counter, name: proof.name,
      transports: Array.isArray(response.response?.transports) ? response.response.transports.filter(value => ['internal', 'usb', 'nfc', 'ble', 'hybrid', 'smart-card'].includes(value)) : [],
      deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp }], { session }); }
    catch (error) { if (error.code === 11000) throw new AppError('This passkey is already registered.', 409, 'PASSKEY_ALREADY_REGISTERED'); throw error; }
    return activateMethod(request, current, 'passkey', { 'security.mfaPasskeyCount': count + 1 }, session);
  });
}

export async function beginPasskeyAuthentication(request, { action = '', password = '', credentialPublicId = '' } = {}) {
  let actor, passwordHashDigest;
  const purpose = action ? 'passkey_manage' : 'passkey_auth';
  if (action) {
    if (!MANAGEMENT_ACTIONS.has(action)) throw invalidChallenge();
    ({ actor, passwordHashDigest } = await passwordActor(request, password));
  } else actor = await currentLoginMfaActor(request);
  if (!enabledMfaMethods(actor).includes('passkey') || !actor.security.mfaPasskeyCount) throw new AppError('Add a passkey in Password & Security first.', 409, 'PASSKEY_NOT_CONFIGURED');
  const credentials = await PasskeyCredential.find({ userId: actor._id, revokedAt: null }).select('+credentialId transports').limit(20);
  if (!credentials.length) throw invalidChallenge();
  const { rpID } = passkeyRelyingParty();
  const options = await generateAuthenticationOptions({ rpID, timeout: 60_000, userVerification: 'required',
    allowCredentials: credentials.map(item => ({ id: item.credentialId, transports: item.transports })) });
  const challenge = await createChallenge(request, actor, purpose, options.challenge, { action, credentialPublicId, ...(passwordHashDigest ? { passwordHashDigest } : {}) });
  return { options, challengeId: challenge.publicId };
}

export async function verifyPasskeyAuthentication(request, id, response, { action = '', credentialPublicId = '' } = {}) {
  responseShape(response);
  const actor = action ? await currentCustomerAccess(request) : await currentLoginMfaActor(request);
  if (!enabledMfaMethods(actor).includes('passkey')) throw invalidChallenge();
  const purpose = action ? 'passkey_manage' : 'passkey_auth';
  const proof = await loadChallenge(request, actor, id, purpose, { action, credentialPublicId });
  const credential = await PasskeyCredential.findOne({ userId: actor._id, credentialId: response.id, revokedAt: null }).select('+credentialId +publicKey +counter');
  if (!credential) throw invalidChallenge();
  const { rpID, origin } = passkeyRelyingParty();
  let verified;
  try { verified = await verifyAuthenticationResponse({ response, expectedChallenge: value => safeEqual(hashToken(value), proof.tokenHash),
    expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
    credential: { id: credential.credentialId, publicKey: new Uint8Array(credential.publicKey), counter: credential.counter, transports: credential.transports } }); }
  catch { throw new AppError('The passkey could not be verified. Start again.', 422, 'PASSKEY_INVALID'); }
  if (!verified.verified || !verified.authenticationInfo.userVerified) throw invalidChallenge();
  await customerTransaction(async session => {
    const current = action ? await currentCustomerAccess(request, { session }) : await User.findOne({ _id: actor._id, status: 'active', 'security.mfaEnabled': true,
      'security.tokenVersion': actor.security.tokenVersion, 'security.mfaMethods': 'passkey' }).session(session);
    if (!current) throw invalidChallenge();
    await loadChallenge(request, current, id, purpose, { action, credentialPublicId }, session);
    await claimChallenge(proof, session);
    const result = await PasskeyCredential.updateOne({ _id: credential._id, userId: current._id, revokedAt: null, counter: credential.counter },
      { $set: { counter: verified.authenticationInfo.newCounter, lastUsedAt: new Date(), backedUp: verified.authenticationInfo.credentialBackedUp } }, { session });
    if (result.modifiedCount !== 1) throw invalidChallenge();
  });
  return { user: actor, method: 'passkey', strong: true };
}

export async function revokePasskey(request, credentialPublicId, { required = false } = {}) {
  return customerTransaction(async session => {
    const actor = await currentCustomerAccess(request, { session, write: true });
    await hydratePlatformAuthorization(actor);
    const credential = await PasskeyCredential.findOne({ publicId: credentialPublicId, userId: actor._id, revokedAt: null }).session(session);
    if (!credential) throw new AppError('This passkey is no longer available.', 404, 'PASSKEY_NOT_FOUND');
    const count = await PasskeyCredential.countDocuments({ userId: actor._id, revokedAt: null }).session(session);
    const methods = enabledMfaMethods(actor).filter(method => method !== 'passkey' || count > 1);
    if (required && !methods.length || !smsMfaAllowed(actor) && !methods.some(method => method === 'totp' || method === 'passkey')) {
      throw new AppError('Add another required security method before removing this passkey.', 409, 'MFA_REQUIRED');
    }
    const result = await PasskeyCredential.updateOne({ _id: credential._id, revokedAt: null }, { $set: { revokedAt: new Date() } }, { session });
    if (result.modifiedCount !== 1) throw invalidChallenge();
    const user = await User.findOneAndUpdate({ _id: actor._id, __v: actor.__v, 'security.tokenVersion': actor.security.tokenVersion }, {
      $set: { 'security.mfaPasskeyCount': count - 1, 'security.mfaMethods': methods, 'security.mfaEnabled': methods.length > 0 },
      $inc: { 'security.tokenVersion': 1, __v: 1 },
    }, { returnDocument: 'after', session });
    if (!user) throw invalidChallenge();
    await Device.updateMany({ userId: actor._id, publicId: { $ne: request.device.publicId }, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: 'passkey_removed' } }, { session });
    await writeAudit(request, 'account.passkey_removed', { actor, targetType: 'passkey', targetPublicId: credential.publicId, session });
    return user;
  });
}

/** A password and one freshly consumed, action-bound factor protect changes. */
export async function verifyAccountMfaProof(request, action, credentialPublicId = '') {
  const { actor } = await passwordActor(request, request.body.currentPassword);
  const method = request.body.mfaMethod || 'totp';
  let result;
  if (method === 'passkey') {
    let credential = request.body.credential;
    if (!credential && typeof request.body.credentialResponse === 'string' && request.body.credentialResponse.length <= 100_000) {
      try { credential = JSON.parse(request.body.credentialResponse); } catch { throw invalidChallenge(); }
    }
    result = await verifyPasskeyAuthentication(request, request.body.challengeId, credential, { action, credentialPublicId });
  } else if (method === 'sms') {
    if (await User.exists({ _id: actor._id, $and: [strongMfaFence()] })) throw new AppError('Use a passkey, authenticator or strong recovery code for security changes.', 403, 'MFA_STRONG_REQUIRED');
    result = await verifyAccountSmsMfa(request, request.body.code, action, credentialPublicId);
  } else if (method === 'totp' || method === 'recovery') {
    result = await verifyMfa(actor._id, request.body.code);
  } else throw invalidChallenge();
  const current = await currentCustomerAccess(request);
  if (!current.security.mfaEnabled || result.user.security.tokenVersion !== current.security.tokenVersion) throw invalidChallenge();
  if (!result.strong && await User.exists({ _id: current._id, $and: [strongMfaFence()] })) throw new AppError('A strong security method is required for this change.', 403, 'MFA_STRONG_REQUIRED');
  return result;
}

export async function regenerateMethodRecoveryCodes(request, proof) {
  return customerTransaction(async session => {
    const actor = await currentCustomerAccess(request, { session, write: true });
    if (proof.user.security.tokenVersion !== actor.security.tokenVersion) throw invalidChallenge();
    const strong = Boolean(await User.exists({ _id: actor._id, $and: [strongMfaFence()] }).session(session));
    if (strong && !proof.strong) throw new AppError('A strong security method is required.', 403, 'MFA_STRONG_REQUIRED');
    const codes = makeRecoveryCodes();
    const result = await User.updateOne({ _id: actor._id, __v: actor.__v, 'security.tokenVersion': actor.security.tokenVersion },
      { $set: { 'security.mfaRecoveryCodeHashes': codes.map(recoveryHash), 'security.mfaRecoveryGeneratedAt': new Date(), 'security.mfaRecoveryStrong': strong }, $inc: { __v: 1 } }, { session });
    if (result.modifiedCount !== 1) throw invalidChallenge();
    await writeAudit(request, 'account.mfa_recovery_codes_regenerated', { actor, targetType: 'user', targetPublicId: actor.publicId, session });
    return codes;
  });
}

export async function disableMethodsAfterProof(request, proof) {
  return customerTransaction(async session => {
    const actor = await currentCustomerAccess(request, { session, write: true });
    if (proof.user.security.tokenVersion !== actor.security.tokenVersion) throw invalidChallenge();
    if (!proof.strong && await User.exists({ _id: actor._id, $and: [strongMfaFence()] }).session(session)) throw new AppError('A strong security method is required.', 403, 'MFA_STRONG_REQUIRED');
    const user = await clearMfa(actor, 'mfa_disabled', request.device.publicId, session);
    await writeAudit(request, 'account.mfa_disabled', { actor, targetType: 'user', targetPublicId: actor.publicId, session });
    return user;
  });
}

export async function removeSmsMfa(request, { required = false } = {}) {
  return customerTransaction(async session => {
    const actor = await currentCustomerAccess(request, { session, write: true });
    await hydratePlatformAuthorization(actor);
    const methods = enabledMfaMethods(actor).filter(method => method !== 'sms');
    if (!enabledMfaMethods(actor).includes('sms')) throw invalidChallenge();
    if (required && !methods.length) throw new AppError('Add another security method before removing SMS.', 409, 'MFA_REQUIRED');
    const user = await User.findOneAndUpdate({ _id: actor._id, __v: actor.__v, 'security.tokenVersion': actor.security.tokenVersion }, {
      $set: { 'security.mfaMethods': methods, 'security.mfaEnabled': methods.length > 0 },
      $unset: { 'security.mfaSmsPhoneHash': 1, 'security.mfaSmsEnrolledAt': 1 }, $inc: { 'security.tokenVersion': 1, __v: 1 },
    }, { returnDocument: 'after', session });
    if (!user) throw invalidChallenge();
    await MfaChallenge.updateMany({ userId: actor._id, consumedAt: null, purpose: mongoose.trusted({ $in: ['sms_auth', 'sms_enroll', 'sms_manage'] }) }, { $set: { consumedAt: new Date() } }, { session });
    await Device.updateMany({ userId: actor._id, revokedAt: null, publicId: { $ne: request.device.publicId } }, { $set: { revokedAt: new Date(), revokedReason: 'sms_mfa_removed' } }, { session });
    await writeAudit(request, 'account.sms_mfa_removed', { actor, targetType: 'user', targetPublicId: actor.publicId, session });
    return user;
  });
}
