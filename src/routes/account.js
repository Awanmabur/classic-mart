import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, AppError } from '../core/errors.js';
import { normalizePhone } from '../core/crypto.js';
import { Device, Order, PrivacyRequest, PromoterContactRequest, SellerContactRequest, StoreMember, User } from '../models/index.js';
import { requireAuth, requireVerified } from '../middleware/auth.js';
import { noStore } from '../middleware/request.js';
import { setFlash } from '../middleware/view.js';
import { writeAudit } from '../services/audit.js';
import { getCountries, getCountry } from '../services/country.js';
import { changePassword } from '../services/auth.js';
import { beginMfaEnrollment, confirmMfaEnrollment, disableMfa, mfaRequiredForUser, pendingMfaEnrollment, regenerateRecoveryCodes } from '../services/mfa.js';
import { writeSecurityEvent } from '../services/security.js';
import { env } from '../config/env.js';
import { createPrivacyRequest, privacyExportPayload } from '../services/privacy.js';
import { cursorScope, cursorSort, pageResult } from '../services/pagination.js';
import {
  onboardingSchema,
  passwordChangeSchema,
  profileSchema,
} from '../validation/identity.js';

const router = Router();
function profileReturn(request){return String(request.body?.returnTo||'')==='/dashboard/profile'?'/dashboard/profile':'/account/profile';}
router.use(
  ['/onboarding', '/account'],
  noStore,
  requireAuth,
  requireVerified,
);

router.get(
  '/onboarding',
  asyncHandler(async (request, response) => {
    if (request.user.onboardingCompletedAt) return response.redirect('/');
    response.render('onboarding', {
      pageError: null,
      values: { role: request.query.role || 'customer' },
    });
  }),
);

router.post(
  '/onboarding',
  asyncHandler(async (request, response) => {
    try {
      const input = onboardingSchema.parse(request.body);
      request.user.role = input.role;
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
        `${input.role === 'customer' ? 'Customer' : input.role} account role saved.`,
      );
      await writeAudit(request, 'identity.onboarding_completed', {
        targetType: 'user',
        targetPublicId: request.user.publicId,
        metadata: { role: input.role },
      });
      return response.redirect('/');
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

  const view = section === 'profile' ? 'account-profile' : section === 'security' ? 'account-security' : 'account-messages';
  response.render(view, {
    section,
    ...data,
    currentDeviceId: request.device.publicId,
    mfaRequired: mfaRequiredForUser(request.user, env.security.privilegedMfaRequired),
  });
}

router.get(
  '/account/profile',
  asyncHandler((request, response) =>
    renderAccountPage(request, response, 'profile'),
  ),
);
router.get(
  '/account/security',
  asyncHandler((request, response) =>
    renderAccountPage(request, response, 'security'),
  ),
);
router.get('/account/orders', asyncHandler(async (request, response) => {
  const size = 50;
  const base = { userId: request.user._id };
  const [rows, total] = await Promise.all([
    Order.find(cursorScope(base, request.query.after))
      .select('publicId status paymentState fulfillmentState cancellationState returnState refundState totals items paymentMethod deliveryMethod createdAt updatedAt')
      .sort(cursorSort())
      .limit(size + 1)
      .lean(),
    Order.countDocuments(base),
  ]);
  const page = pageResult(rows, { limit: size, total });
  response.set('Cache-Control', 'private, no-store');
  response.render('account-orders', { orders: page.items, queuePage: page.page });
}));

router.get('/account/privacy',asyncHandler(async(request,response)=>{const size=50,base={userId:request.user._id};const [rows,total]=await Promise.all([PrivacyRequest.find(cursorScope(base,request.query.after)).sort(cursorSort()).limit(size+1).lean(),PrivacyRequest.countDocuments(base)]);const page=pageResult(rows,{limit:size,total});response.set('Cache-Control','private, no-store');response.render('account-privacy',{requests:page.items,queuePage:page.page});}));
router.post('/account/privacy/request',asyncHandler(async(request,response)=>{const input=z.object({type:z.enum(['export','deletion','correction','restriction','consent_withdrawal']),password:z.string().min(1).max(200),details:z.string().trim().max(2000).optional().default('')}).parse(request.body);const doc=await createPrivacyRequest(request,input);await writeAudit(request,'privacy.request_created',{targetType:'privacy_request',targetPublicId:doc.publicId,country:doc.country,metadata:{type:doc.type}});setFlash(request,'success',doc.type==='export'?'Your verified export request is queued.':'Your privacy request was recorded.');response.redirect('/account/privacy');}));
router.post('/account/privacy/:id/cancel',asyncHandler(async(request,response)=>{const doc=await PrivacyRequest.findOne({publicId:request.params.id,userId:request.user._id,status:{$in:['requested','blocked']}});if(!doc)throw new AppError('Cancelable privacy request not found.',404,'PRIVACY_REQUEST_NOT_FOUND');doc.status='cancelled';doc.completedAt=new Date();await doc.save();await writeAudit(request,'privacy.request_cancelled',{targetType:'privacy_request',targetPublicId:doc.publicId,country:doc.country});setFlash(request,'success','Privacy request cancelled.');response.redirect('/account/privacy');}));
router.get('/account/privacy/:id/download',asyncHandler(async(request,response)=>{const doc=await PrivacyRequest.findOne({publicId:request.params.id,userId:request.user._id,type:'export',status:'ready'}).select('+storageKey');if(!doc)throw new AppError('Privacy export not found.',404,'PRIVACY_EXPORT_NOT_FOUND');const payload=await privacyExportPayload(doc);await writeAudit(request,'privacy.export_downloaded',{targetType:'privacy_request',targetPublicId:doc.publicId,country:doc.country});response.set('Cache-Control','private, no-store');response.set('Content-Disposition',`attachment; filename="classic-mart-data-${doc.publicId}.json"`);response.type('application/json').send(payload);}));

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



router.post('/account/store-invitations/:publicId/accept', asyncHandler(async (request, response) => {
  const invitation = await StoreMember.findOne({ publicId: request.params.publicId, userId: request.user._id, status: 'invited' }).populate('storeId');
  if (!invitation?.storeId || invitation.storeId.status === 'closed') throw new AppError('Store invitation is no longer available.', 404, 'STORE_INVITATION_NOT_FOUND');
  invitation.status = 'active'; invitation.acceptedAt = new Date(); await invitation.save();
  await writeAudit(request, 'seller.staff_invitation_accepted', { targetType: 'store_member', targetPublicId: invitation.publicId });
  setFlash(request, 'success', `You now have ${invitation.role} access to ${invitation.storeId.name}.`);
  response.redirect('/account/profile');
}));

router.post('/account/store-invitations/:publicId/reject', asyncHandler(async (request, response) => {
  const invitation = await StoreMember.findOne({ publicId: request.params.publicId, userId: request.user._id, status: 'invited' });
  if (!invitation) throw new AppError('Store invitation was not found.', 404, 'STORE_INVITATION_NOT_FOUND');
  invitation.status = 'revoked'; invitation.revokedAt = new Date(); await invitation.save();
  await writeAudit(request, 'seller.staff_invitation_rejected', { targetType: 'store_member', targetPublicId: invitation.publicId });
  setFlash(request, 'success', 'Store invitation declined.'); response.redirect('/account/profile');
}));

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
      const duplicate = await User.exists({
        _id: { $ne: request.user._id },
        phoneNormalized,
      });
      if (duplicate) {
        throw new AppError(
          'That phone number is already in use.',
          409,
          'PHONE_IN_USE',
        );
      }
      const country = await getCountry(input.country);
      const phoneChanged = phoneNormalized !== request.user.phoneNormalized;
      request.user.name = input.name;
      request.user.phone = input.phone;
      request.user.phoneNormalized = phoneNormalized;
      if (phoneChanged) request.user.phoneVerifiedAt = null;
      request.user.shoppingCountry = country.code;
      request.user.currency = country.currency;
      request.user.locale = input.locale;
      request.user.timeZone = country.timeZone;
      request.user.consents.marketing = Boolean(input.marketing);
      request.user.consents.recordedAt = new Date();
      await request.user.save();
      setFlash(request, 'success', 'Your profile was updated.');
      await writeAudit(request, 'account.profile_updated', {
        targetType: 'user',
        targetPublicId: request.user.publicId,
        metadata: { phoneChanged, shoppingCountry: country.code },
      });
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



router.post('/account/mfa/begin', asyncHandler(async (request, response) => {
  try {
    await beginMfaEnrollment(request.user._id, request.body.currentPassword);
    await writeAudit(request, 'account.mfa_enrollment_started', { targetType: 'user', targetPublicId: request.user.publicId });
    await writeSecurityEvent(request, 'mfa.enrollment_started', { category: 'mfa', severity: 'low', result: 'success' });
    setFlash(request, 'success', 'Authenticator setup started. Add the secret to your authenticator and confirm a current code.');
  } catch (error) { setFlash(request, 'error', error.message); }
  response.redirect('/account/security');
}));

router.post('/account/mfa/confirm', asyncHandler(async (request, response) => {
  try {
    const { user, codes } = await confirmMfaEnrollment(request.user._id, request.body.code, request.device.publicId);
    request.session.tokenVersion = user.security.tokenVersion;
    request.user.security.mfaEnabled = true;
    request.user.security.mfaEnrolledAt = user.security.mfaEnrolledAt;
    request.session.mfaRecoveryCodes = codes;
    await writeAudit(request, 'account.mfa_enabled', { targetType: 'user', targetPublicId: request.user.publicId });
    await writeSecurityEvent(request, 'mfa.enabled', { category: 'mfa', severity: 'medium', result: 'success' });
    setFlash(request, 'success', 'Multi-factor authentication is now enabled. Store the recovery codes shown below offline.');
  } catch (error) { setFlash(request, 'error', error.message); }
  response.redirect('/account/security');
}));

router.post('/account/mfa/recovery-codes', asyncHandler(async (request, response) => {
  try {
    const codes = await regenerateRecoveryCodes(request.user._id, request.body.currentPassword, request.body.code);
    request.session.mfaRecoveryCodes = codes;
    await writeAudit(request, 'account.mfa_recovery_codes_regenerated', { targetType: 'user', targetPublicId: request.user.publicId });
    await writeSecurityEvent(request, 'mfa.recovery_codes_regenerated', { category: 'mfa', severity: 'medium', result: 'success' });
    setFlash(request, 'success', 'New recovery codes were generated. Previous recovery codes no longer work.');
  } catch (error) { setFlash(request, 'error', error.message); }
  response.redirect('/account/security');
}));

router.post('/account/mfa/disable', asyncHandler(async (request, response) => {
  try {
    const user = await disableMfa(request.user._id, request.body.currentPassword, request.body.code, 'mfa_disabled', request.device.publicId);
    request.session.tokenVersion = user.security.tokenVersion;
    request.user.security.mfaEnabled = false;
    await writeAudit(request, 'account.mfa_disabled', { targetType: 'user', targetPublicId: request.user.publicId });
    await writeSecurityEvent(request, 'mfa.disabled', { category: 'mfa', severity: 'high', result: 'success' });
    setFlash(request, 'success', 'Multi-factor authentication was disabled and other sessions were revoked.');
  } catch (error) { setFlash(request, 'error', error.message); }
  response.redirect('/account/security');
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
