import { Router } from 'express';
import { accountWorkspaceView } from '../dashboard/account-workspace-view.js';
import { mfaContinuation, mfaSecurityPath } from '../dashboard/mfa-continuation.js';
import { dashboardLanding } from '../dashboard/landing.js';
import { PUBLIC_ACCOUNT_TYPES, publicAccountType, assertPublicRegistrationOpen } from '../core/registration.js';
import { z } from 'zod';
import rateLimit from '../middleware/rate-limit.js';
import { asyncHandler, AppError } from '../core/errors.js';
import { normalizePhone, verifyPassword } from '../core/crypto.js';
import { Device, Order, PrivacyRequest, PromoterContactRequest, SellerContactRequest, StoreMember, User } from '../models/index.js';
import { requireAuth, requireVerified } from '../middleware/auth.js';
import { noStore } from '../middleware/request.js';
import { setFlash } from '../middleware/view.js';
import { writeAudit } from '../services/audit.js';
import { enrollCustomerAsSeller, sellerEnrollmentPreview } from '../services/seller-enrollment.js';
import { getCountries, getCountry } from '../services/country.js';
import { changePassword } from '../services/auth.js';
import { beginMfaEnrollment, confirmMfaEnrollment, disableMfa, mfaRequiredForUser, pendingMfaEnrollment, regenerateRecoveryCodes, verifyMfa } from '../services/mfa.js';
import { currentCustomerAccess, customerTransaction } from '../services/customer-access.js';
import { writeSecurityEvent } from '../services/security.js';
import { env } from '../config/env.js';
import { cancelPrivacyRequest, createPrivacyRequest, privacyExportPayload } from '../services/privacy.js';
import { assertOptionalProcessing } from '../services/optional-processing.js';
import { cursorScope, cursorSort, pageResult } from '../services/pagination.js';
import {
  onboardingSchema,
  sellerEnrollmentSchema,
  passwordChangeSchema,
  profileSchema,
} from '../validation/identity.js';

const router = Router();
function profileReturn(request){return ['/profile','/dashboard/profile'].includes(String(request.body?.returnTo||''))?'/profile':'/account/profile';}
router.use(
  ['/onboarding', '/account'],
  noStore,
  (request, response, next) => {
    const path = new URL(request.originalUrl, 'http://localhost').pathname;
    const sellerIntent = path === '/onboarding/seller' || (path === '/onboarding' && request.query.role === 'seller');
    if (request.method === 'GET' && sellerIntent && !request.user && path === '/onboarding') return response.redirect('/signup?role=seller');
    if (request.method === 'GET' && sellerIntent && request.user?.role === 'customer' && !request.user.platformAccessManagedAt) request.session.accountSetupNext = '/onboarding/seller';
    return next();
  },
  requireAuth,
  requireVerified,
);

async function renderSellerEnrollment(request, response, pageError = '') {
  const actor = await sellerEnrollmentPreview(request);
  if (actor.role === 'seller') {
    delete request.session.accountSetupNext;
    return response.redirect(dashboardLanding(actor));
  }
  const draft = {};
  if (pageError) for (const field of ['publicName', 'businessName', 'focus', 'location', 'bio', 'transport', 'teamSize']) {
    if (typeof request.body?.[field] === 'string') draft[field] = request.body[field].slice(0, 1000);
  }
  // Continuation is needed only until the verified enrollment page is reached.
  // Leaving it must not trap an incomplete customer in seller setup.
  delete request.session.accountSetupNext;
  return response.render('onboarding', { sellerEnrollment: true, pageError,
    values: { ...actor.roleProfile?.toObject(), ...draft, role: 'seller', version: actor.__v } });
}
router.get('/onboarding/seller', asyncHandler((request, response) => renderSellerEnrollment(request, response)));
const sellerEnrollmentLimit = rateLimit({ scope: 'account:1', windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false,
  keyGenerator: request => String(request.user._id) });
router.post('/onboarding/seller', sellerEnrollmentLimit, asyncHandler(async (request, response) => {
  try {
    const actor = await enrollCustomerAsSeller(request, sellerEnrollmentSchema.parse(request.body));
    request.user = actor;
    delete request.session.accountSetupNext;
    setFlash(request, 'success', 'Your seller account is ready. Complete store verification before publishing products.');
    return response.redirect(dashboardLanding(actor));
  } catch (error) {
    const status = error.name === 'ZodError' ? 422 : error.status;
    if (![409, 422].includes(status) || request.accepts(['html', 'json']) === 'json') throw error;
    response.status(status);
    return renderSellerEnrollment(request, response, error.name === 'ZodError' ? error.issues[0].message : error.message);
  }
}));

router.get(
  '/onboarding',
  asyncHandler(async (request, response) => {
    if (request.user.role === 'customer' && request.query.role === 'seller') return response.redirect('/onboarding/seller');
    if (request.user.onboardingCompletedAt) return response.redirect(dashboardLanding(request.user));
    response.render('onboarding', {
      pageError: null,
      values: { role: publicAccountType(request.query.role || request.user.role) },
    });
  }),
);

router.post(
  '/onboarding',
  asyncHandler(async (request, response) => {
    try {
      if (request.user.onboardingCompletedAt) return response.redirect(dashboardLanding(request.user));
      const input = onboardingSchema.parse(request.body);
      // Profile completion never overwrites administrator-managed staff access.
      if (!request.user.platformAccessManagedAt && PUBLIC_ACCOUNT_TYPES.includes(request.user.role)) {
        assertPublicRegistrationOpen(input.role, { production: env.isProduction, configured: env.auth.publicRegistrationTypes.join(',') });
        request.user.role = input.role;
      }
      request.user.roleProfile = {
        publicName: input.publicName,
        businessName: input.businessName,
        focus: input.focus,
        location: input.location,
        bio: input.bio,
        transport: input.transport,
        teamSize: input.teamSize,
      };
      request.user.onboardingCompletedAt = new Date();
      await request.user.save();
      setFlash(
        request,
        'success',
        `${request.user.role === 'customer' ? 'Customer' : request.user.role} account role saved.`,
      );
      await writeAudit(request, 'identity.onboarding_completed', {
        targetType: 'user',
        targetPublicId: request.user.publicId,
        metadata: { role: request.user.role },
      });
      return response.redirect(dashboardLanding(request.user));
    } catch (error) {
      return response.status(error.status || 422).render('onboarding', {
        pageError: error.message,
        values: request.body,
      });
    }
  }),
);

function accountCenterDefaults() {
  const emptyPage = { hasMore: false, next: '', count: 0, total: 0, direction: -1 };
  return {
    devices: [], countries: [], productAlerts: [], sellerContacts: [], promoterContacts: [], orders: [],
    activeSessionCount: 0,
    queuePages: {
      devices: { ...emptyPage }, alerts: { ...emptyPage }, sellerContacts: { ...emptyPage },
      promoterContacts: { ...emptyPage }, orders: { ...emptyPage },
    },
    mfaEnrollment: null,
    mfaRecoveryCodes: null,
  };
}

function accountMfaRequired(request, view) {
  return mfaRequiredForUser(request.user, env.security.privilegedMfaRequired)
    || Boolean(!env.auth.simpleLogin && env.security.privilegedMfaRequired
      && view.liveSeller?.navigation.some(item => item.ready));
}

async function postedMfaContinuation(request) {
  const view = await accountWorkspaceView(request, 'security');
  return { view, continuation: mfaContinuation(request.body.next, request.user, view) };
}

async function renderAccountPage(request, response, requestedSection = 'profile') {
  const allowedSections = new Set(['profile', 'security', 'messages']);
  const section = allowedSections.has(requestedSection) ? requestedSection : 'profile';
  const size = 50;
  const data = accountCenterDefaults();

  if (section === 'profile') {
    data.countries = await getCountries();
  }

  if (section === 'security') {
    const deviceBase = { userId: request.user._id };
    const [deviceRows, deviceTotal, activeSessionCount, mfaEnrollment] = await Promise.all([
      Device.find(cursorScope(deviceBase, request.query.devicesAfter, { field: 'lastSeenAt' })).sort(cursorSort('lastSeenAt')).limit(size + 1).lean(),
      Device.countDocuments(deviceBase),
      Device.countDocuments({ userId: request.user._id, revokedAt: null }),
      pendingMfaEnrollment(request.user._id),
    ]);
    const devicePage = pageResult(deviceRows, { field: 'lastSeenAt', limit: size, total: deviceTotal });
    data.devices = devicePage.items;
    data.queuePages.devices = devicePage.page;
    data.activeSessionCount = activeSessionCount;
    data.mfaEnrollment = mfaEnrollment;
    data.mfaRecoveryCodes = Array.isArray(request.session.mfaRecoveryCodes) ? request.session.mfaRecoveryCodes : null;
    if (request.session.mfaRecoveryCodes) delete request.session.mfaRecoveryCodes;
  }

  if (section === 'messages') {
    const sellerBase = { customerUserId: request.user._id };
    const promoterBase = { customerUserId: request.user._id };
    const [sellerRows, promoterRows, sellerTotal, promoterTotal] = await Promise.all([
      SellerContactRequest.find(cursorScope(sellerBase, request.query.sellerContactsAfter, { field: 'lastMessageAt' })).populate('storeId', 'name slug').sort(cursorSort('lastMessageAt')).limit(size + 1).lean(),
      PromoterContactRequest.find(cursorScope(promoterBase, request.query.promoterContactsAfter, { field: 'lastMessageAt' })).populate('promoterUserId', 'name roleProfile').sort(cursorSort('lastMessageAt')).limit(size + 1).lean(),
      SellerContactRequest.countDocuments(sellerBase),
      PromoterContactRequest.countDocuments(promoterBase),
    ]);
    const sellerPage = pageResult(sellerRows, { field: 'lastMessageAt', limit: size, total: sellerTotal });
    const promoterPage = pageResult(promoterRows, { field: 'lastMessageAt', limit: size, total: promoterTotal });
    data.sellerContacts = sellerPage.items;
    data.promoterContacts = promoterPage.items;
    data.queuePages.sellerContacts = sellerPage.page;
    data.queuePages.promoterContacts = promoterPage.page;
  }

  const view = await accountWorkspaceView(request, section);
  response.render('approved-dashboard', {
    ...view, section,
    ...data,
    currentDeviceId: request.device.publicId,
    mfaRequired: accountMfaRequired(request, view),
    mfaContinuation: section === 'security' ? mfaContinuation(request.query.next, request.user, view) : null,
  });
}

router.get(
  '/account/profile',
  asyncHandler((request, response) =>
    response.redirect(dashboardLanding(request.user) === '/dashboard' ? '/profile' : dashboardLanding(request.user)),
  ),
);
router.get(
  '/account/security',
  asyncHandler((request, response) =>
    renderAccountPage(request, response, 'security'),
  ),
);
router.get('/account/orders', (_request, response) => response.redirect('/orders'));

router.get('/account/privacy',asyncHandler(async(request,response)=>{const size=50,base={userId:request.user._id};const [rows,total]=await Promise.all([PrivacyRequest.find(cursorScope(base,request.query.after)).sort(cursorSort()).limit(size+1).lean(),PrivacyRequest.countDocuments(base)]);const page=pageResult(rows,{limit:size,total});response.set('Cache-Control','private, no-store');response.render('approved-dashboard', { ...await accountWorkspaceView(request,'privacy'),requests:page.items,queuePage:page.page});}));
router.post('/account/privacy/request',asyncHandler(async(request,response)=>{const input=z.object({type:z.enum(['export','deletion','correction','restriction','consent_withdrawal']),password:z.string().min(1).max(200),details:z.string().trim().max(2000).optional().default('')}).parse(request.body);const doc=await createPrivacyRequest(request,input);await writeAudit(request,'privacy.request_created',{targetType:'privacy_request',targetPublicId:doc.publicId,country:doc.country,metadata:{type:doc.type}});setFlash(request,'success',doc.type==='export'?'Your verified export request is queued.':'Your privacy request was recorded.');response.redirect('/account/privacy');}));
router.post('/account/privacy/:id/cancel',asyncHandler(async(request,response)=>{await cancelPrivacyRequest(request,request.params.id);setFlash(request,'success','Privacy request cancelled.');response.redirect('/account/privacy');}));
router.get('/account/privacy/:id/download',asyncHandler(async(request,response)=>{
  const actor=await currentCustomerAccess(request);
  const doc=await PrivacyRequest.findOne({publicId:request.params.id,userId:actor._id,type:'export',status:'ready'}).select('+storageKey');
  if(!doc)throw new AppError('Privacy export not found.',404,'PRIVACY_EXPORT_NOT_FOUND');
  const payload=await privacyExportPayload(doc,{request});
  await writeAudit(request,'privacy.export_downloaded',{targetType:'privacy_request',targetPublicId:doc.publicId,country:doc.country});
  await currentCustomerAccess(request);
  if(!await PrivacyRequest.exists({_id:doc._id,userId:actor._id,type:'export',status:'ready',storageKey:doc.storageKey,expiresAt:{$gt:new Date()},'legalHold.active':{$ne:true}}))throw new AppError('Privacy export is not available.',404,'PRIVACY_EXPORT_NOT_READY');
  response.set('Cache-Control','private, no-store');response.set('Content-Disposition',`attachment; filename="classic-mart-data-${doc.publicId}.json"`);response.type('application/json').send(payload);
}));

router.get(
  '/account/messages',
  asyncHandler((request, response) => renderAccountPage(request, response, 'messages')),
);

router.post('/account/promoter-messages/:id/reply', asyncHandler(async (request, response) => {
  const body = String(request.body.message || '').trim();
  if (body.length < 2 || body.length > 2000) throw new AppError('Message must be between 2 and 2000 characters.', 422, 'MESSAGE_INVALID');
  const thread = await PromoterContactRequest.findOne({ publicId: request.params.id, customerUserId: request.user._id, status: { $ne: 'resolved' } });
  if (!thread) throw new AppError('Conversation not found or already resolved.', 404, 'CONTACT_NOT_FOUND');
  thread.replies.push({ sender: 'customer', senderUserId: request.user._id, body, at: new Date() });
  thread.status = 'new'; thread.lastMessageAt = new Date(); await thread.save();
  await writeAudit(request, 'promoter_contact.customer_reply', { targetType: 'promoter_contact', targetPublicId: thread.publicId });
  setFlash(request, 'success', 'Your reply was sent to the promoter.'); response.redirect('/account/messages');
}));

router.post(
  '/account/messages/:id/reply',
  asyncHandler(async (request, response) => {
    const body = String(request.body.message || '').trim();
    if (body.length < 2 || body.length > 2000) throw new AppError('Message must be between 2 and 2000 characters.', 422, 'MESSAGE_INVALID');
    const thread = await SellerContactRequest.findOne({ publicId: request.params.id, customerUserId: request.user._id, status: { $ne: 'resolved' } });
    if (!thread) throw new AppError('Conversation not found or already resolved.', 404, 'CONTACT_NOT_FOUND');
    thread.replies.push({ sender: 'customer', senderUserId: request.user._id, body, at: new Date() });
    thread.status = 'new';
    thread.lastMessageAt = new Date();
    await thread.save();
    await writeAudit(request, 'seller_contact.customer_reply', { targetType: 'seller_contact', targetPublicId: thread.publicId });
    setFlash(request, 'success', 'Your reply was sent to the seller.');
    response.redirect('/account/messages');
  }),
);




router.post(
  '/account/preferences/low-data',
  asyncHandler(async (request, response) => {
    request.user.preferences = request.user.preferences || {};
    request.user.preferences.lowData = String(request.body.enabled || '') === 'true';
    await request.user.save();
    await writeAudit(request, 'account.low_data_updated', {
      targetType: 'user', targetPublicId: request.user.publicId,
      metadata: { enabled: request.user.preferences.lowData },
    });
    setFlash(request, 'success', request.user.preferences.lowData ? 'Low-data mode enabled.' : 'Low-data mode disabled.');
    response.redirect(request.get('referer')?.startsWith(`${request.protocol}://${request.get('host')}`) ? request.get('referer') : '/account/profile');
  }),
);

router.post(
  '/account/profile',
  asyncHandler(async (request, response) => {
    try {
      const input = profileSchema.parse(request.body);
      const phoneNormalized = normalizePhone(input.phone);
      const country = await getCountry(input.country);
      const { actor, phoneChanged } = await customerTransaction(async session => {
        const actor = await currentCustomerAccess(request, { session, write: true });
        const duplicate = await User.exists({ _id: { $ne: actor._id }, phoneNormalized }).session(session);
        if (duplicate) throw new AppError('That phone number is already in use.', 409, 'PHONE_IN_USE');
        const phoneChanged = phoneNormalized !== normalizePhone(actor.phone);
        actor.name = input.name;
        actor.phone = input.phone;
        actor.phoneNormalized = phoneNormalized;
        if (phoneChanged) actor.phoneVerifiedAt = null;
        actor.shoppingCountry = country.code;
        actor.currency = country.currency;
        actor.locale = input.locale;
        actor.timeZone = country.timeZone;
        if (input.marketing) await assertOptionalProcessing(actor._id, { session });
        actor.consents.marketing = Boolean(input.marketing);
        actor.consents.recordedAt = new Date();
        await actor.save({ session });
        await writeAudit(request, 'account.profile_updated', { session, targetType: 'user',
          targetPublicId: actor.publicId, metadata: { phoneChanged, shoppingCountry: country.code } });
        return { actor, phoneChanged };
      });
      request.user = actor;
      setFlash(request, 'success', 'Your profile was updated.');
      if (phoneChanged) {
        setFlash(request, 'info', 'Verify your new phone number to continue using protected account features.');
        return response.redirect('/verify-phone');
      }
      response.redirect(profileReturn(request));
    } catch (error) {
      setFlash(request, 'error', error.message);
      response.redirect(profileReturn(request));
    }
  }),
);



const mfaMutationLimit = rateLimit({ scope: 'account:2', windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false,
  keyGenerator: request => String(request.user._id) });
router.post('/account/mfa/begin', mfaMutationLimit, asyncHandler(async (request, response) => {
  const { continuation } = await postedMfaContinuation(request);
  try {
    await beginMfaEnrollment(request.user._id, request.body.currentPassword);
    await writeAudit(request, 'account.mfa_enrollment_started', { targetType: 'user', targetPublicId: request.user.publicId });
    await writeSecurityEvent(request, 'mfa.enrollment_started', { category: 'mfa', severity: 'low', result: 'success' });
    setFlash(request, 'success', 'Authenticator setup started. Add the secret to your authenticator and confirm a current code.');
  } catch (error) { setFlash(request, 'error', error.message); }
  response.redirect(mfaSecurityPath(continuation));
}));

router.post('/account/mfa/confirm', mfaMutationLimit, asyncHandler(async (request, response) => {
  const { continuation } = await postedMfaContinuation(request);
  try {
    const { user, codes } = await confirmMfaEnrollment(request.user._id, request.body.code, request.device.publicId);
    request.session.tokenVersion = user.security.tokenVersion;
    request.session.mfaVerifiedAt = Date.now();
    request.user.security.mfaEnabled = true;
    request.user.security.mfaEnrolledAt = user.security.mfaEnrolledAt;
    request.session.mfaRecoveryCodes = codes;
    await writeAudit(request, 'account.mfa_enabled', { targetType: 'user', targetPublicId: request.user.publicId });
    await writeSecurityEvent(request, 'mfa.enabled', { category: 'mfa', severity: 'medium', result: 'success' });
    setFlash(request, 'success', 'Multi-factor authentication is now enabled. Store the recovery codes shown below offline.');
  } catch (error) { setFlash(request, 'error', error.message); }
  // Render the one-time recovery codes before offering the intended workspace.
  response.redirect(mfaSecurityPath(continuation));
}));

router.post('/account/mfa/recovery-codes', mfaMutationLimit, asyncHandler(async (request, response) => {
  const { continuation } = await postedMfaContinuation(request);
  try {
    const codes = await regenerateRecoveryCodes(request.user._id, request.body.currentPassword, request.body.code);
    request.session.mfaRecoveryCodes = codes;
    request.session.mfaVerifiedAt = Date.now();
    await writeAudit(request, 'account.mfa_recovery_codes_regenerated', { targetType: 'user', targetPublicId: request.user.publicId });
    await writeSecurityEvent(request, 'mfa.recovery_codes_regenerated', { category: 'mfa', severity: 'medium', result: 'success' });
    setFlash(request, 'success', 'New recovery codes were generated. Previous recovery codes no longer work.');
  } catch (error) { setFlash(request, 'error', error.message); }
  response.redirect(mfaSecurityPath(continuation));
}));

router.post('/account/mfa/disable', mfaMutationLimit, asyncHandler(async (request, response) => {
  const { view, continuation } = await postedMfaContinuation(request);
  if (accountMfaRequired(request, view)) throw new AppError('Multi-factor authentication is required for your operational access.', 403, 'MFA_REQUIRED');
  try {
    const user = await disableMfa(request.user._id, request.body.currentPassword, request.body.code, 'mfa_disabled', request.device.publicId);
    request.session.tokenVersion = user.security.tokenVersion;
    request.user.security.mfaEnabled = false;
    delete request.session.mfaVerifiedAt;
    await writeAudit(request, 'account.mfa_disabled', { targetType: 'user', targetPublicId: request.user.publicId });
    await writeSecurityEvent(request, 'mfa.disabled', { category: 'mfa', severity: 'high', result: 'success' });
    setFlash(request, 'success', 'Multi-factor authentication was disabled and other sessions were revoked.');
  } catch (error) { setFlash(request, 'error', error.message); }
  response.redirect(mfaSecurityPath(continuation));
}));

router.post('/account/mfa/step-up', mfaMutationLimit, asyncHandler(async (request, response) => {
  const { continuation } = await postedMfaContinuation(request);
  try {
    const input = z.object({ currentPassword: z.string().min(1).max(256), code: z.string().trim().min(6).max(32) }).parse(request.body);
    const actor = await currentCustomerAccess(request);
    const passwordUser = await User.findById(actor._id).select('+passwordHash');
    if (!passwordUser || !await verifyPassword(passwordUser.passwordHash, input.currentPassword)) throw new AppError('The current password is incorrect.', 422, 'INVALID_CURRENT_PASSWORD');
    const result = await verifyMfa(actor._id, input.code);
    const current = await currentCustomerAccess(request);
    if (!current.security.mfaEnabled || result.user.security.tokenVersion !== current.security.tokenVersion) throw new AppError('Your account changed. Sign in again.', 403, 'ACCOUNT_UNAVAILABLE');
    request.session.mfaVerifiedAt = Date.now();
    await writeAudit(request, 'account.mfa_step_up', { targetType: 'user', targetPublicId: current.publicId, metadata: { method: result.method } });
    setFlash(request, 'success', 'Identity confirmed. You can continue to the protected action.');
    return response.redirect(303, continuation.url);
  } catch (error) {
    setFlash(request, 'error', error.message);
    return response.redirect(303, mfaSecurityPath(continuation));
  }
}));

router.post(
  '/account/password',
  asyncHandler(async (request, response) => {
    try {
      const input = passwordChangeSchema.parse(request.body);
      const user = await changePassword(
        request.user._id,
        input.currentPassword,
        input.password,
      );
      await Device.updateMany(
        {
          userId: user._id,
          publicId: { $ne: request.device.publicId },
          revokedAt: null,
        },
        {
          $set: {
            revokedAt: new Date(),
            revokedReason: 'password_changed',
          },
        },
      );
      request.session.tokenVersion = user.security.tokenVersion;
      setFlash(
        request,
        'success',
        'Password updated. Other signed-in devices were revoked.',
      );
      await writeAudit(request, 'account.password_changed', {
        targetType: 'user',
        targetPublicId: request.user.publicId,
      });
      response.redirect('/account/security');
    } catch (error) {
      setFlash(request, 'error', error.message);
      response.redirect('/account/security');
    }
  }),
);

router.post(
  '/account/devices/:publicId/revoke',
  asyncHandler(async (request, response) => {
    const device = await Device.findOne({
      publicId: request.params.publicId,
      userId: request.user._id,
      revokedAt: null,
    });
    if (!device) {
      throw new AppError('Device session not found.', 404, 'DEVICE_NOT_FOUND');
    }
    device.revokedAt = new Date();
    device.revokedReason = 'user_revoked';
    await device.save();
    await writeAudit(request, 'account.device_revoked', {
      targetType: 'device',
      targetPublicId: device.publicId,
    });
    if (device.publicId === request.device.publicId) {
      return request.session.destroy(() => response.redirect('/login'));
    }
    setFlash(request, 'success', 'The device was signed out.');
    return response.redirect('/account/security');
  }),
);

export default router;
