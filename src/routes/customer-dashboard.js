import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { normalizePhone } from '../core/crypto.js';
import { CustomerAddress, Notification, User } from '../models/index.js';
import { requireAuth, requireOnboarding, requireVerified } from '../middleware/auth.js';
import { noStore } from '../middleware/request.js';
import { setFlash } from '../middleware/view.js';
import { loadCustomerDashboard } from '../services/customer-dashboard.js';
import { createTicket } from '../services/trust.js';
import { writeAudit } from '../services/audit.js';
import { getCountry } from '../services/country.js';
import { profileSchema } from '../validation/identity.js';

const router = Router();

function customerOnly(request, response, next) {
  if (request.user?.role === 'customer') return next();
  if (request.user?.role === 'seller') return response.redirect('/seller');
  if (request.user?.role === 'promoter') return response.redirect('/promoter');
  if (request.user?.role === 'business') return response.redirect('/business');
  if (request.user?.role === 'support') return response.redirect('/operations/support');
  if (request.user?.role === 'warehouse') return response.redirect('/operations/logistics');
  if (request.user?.role === 'finance') return response.redirect('/finance');
  if (request.user?.role === 'moderator') return response.redirect('/moderation');
  if (request.user?.role === 'country_admin') return response.redirect('/admin');
  if (request.user?.role === 'super_admin') return response.redirect('/super-admin');
  setFlash(request, 'info', 'Your role dashboard will be activated after its rebuild is complete.');
  return response.redirect('/');
}

router.use('/dashboard', noStore, requireAuth, requireVerified, requireOnboarding, customerOnly);

router.get(
  '/dashboard',
  asyncHandler(async (request, response) => {
    const dashboard = await loadCustomerDashboard(request);
    response.set('Cache-Control', 'private, no-store');
    return response.render('customer-dashboard', { dashboard });
  }),
);

const addressSchema = z.object({
  label: z.string().trim().min(1).max(80).default('Address'),
  fullName: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(5).max(32),
  address: z.string().trim().min(3).max(240),
  city: z.string().trim().min(2).max(120),
  country: z.string().trim().length(2).optional(),
  note: z.string().trim().max(500).optional().default(''),
  isDefault: z.union([z.literal('on'), z.literal('true'), z.literal('1')]).optional(),
});

router.post('/dashboard/addresses', asyncHandler(async (request, response) => {
  const input = addressSchema.parse(request.body);
  const country = String(input.country || request.user.shoppingCountry || request.user.country || '').toUpperCase();
  const shouldDefault = Boolean(input.isDefault) || !(await CustomerAddress.exists({ userId: request.user._id, archivedAt: null }));
  if (shouldDefault) await CustomerAddress.updateMany({ userId: request.user._id, archivedAt: null }, { $set: { isDefault: false } });
  const address = await CustomerAddress.create({
    publicId: publicId('adr'), userId: request.user._id, label: input.label, fullName: input.fullName,
    phone: input.phone, address: input.address, city: input.city, country, note: input.note, isDefault: shouldDefault,
  });
  await writeAudit(request, 'customer.address_created', { targetType: 'customer_address', targetPublicId: address.publicId, country });
  setFlash(request, 'success', 'Delivery address saved.');
  return response.redirect('/dashboard#addresses');
}));

router.post('/dashboard/addresses/:id/default', asyncHandler(async (request, response) => {
  const address = await CustomerAddress.findOne({ publicId: request.params.id, userId: request.user._id, archivedAt: null });
  if (!address) throw new AppError('Address not found.', 404, 'ADDRESS_NOT_FOUND');
  await CustomerAddress.updateMany({ userId: request.user._id, archivedAt: null }, { $set: { isDefault: false } });
  address.isDefault = true;
  await address.save();
  await writeAudit(request, 'customer.address_defaulted', { targetType: 'customer_address', targetPublicId: address.publicId, country: address.country });
  setFlash(request, 'success', 'Default delivery address updated.');
  return response.redirect('/dashboard#addresses');
}));

router.post('/dashboard/addresses/:id/delete', asyncHandler(async (request, response) => {
  const address = await CustomerAddress.findOne({ publicId: request.params.id, userId: request.user._id, archivedAt: null });
  if (!address) throw new AppError('Address not found.', 404, 'ADDRESS_NOT_FOUND');
  address.archivedAt = new Date();
  address.isDefault = false;
  await address.save();
  const replacement = await CustomerAddress.findOne({ userId: request.user._id, archivedAt: null }).sort({ updatedAt: -1 });
  if (replacement && !(await CustomerAddress.exists({ userId: request.user._id, archivedAt: null, isDefault: true }))) {
    replacement.isDefault = true;
    await replacement.save();
  }
  await writeAudit(request, 'customer.address_archived', { targetType: 'customer_address', targetPublicId: address.publicId, country: address.country });
  setFlash(request, 'success', 'Address removed.');
  return response.redirect('/dashboard#addresses');
}));

router.post('/dashboard/notifications/:id/read', asyncHandler(async (request, response) => {
  const notification = await Notification.findOne({ publicId: request.params.id, userId: request.user._id });
  if (!notification) throw new AppError('Notification not found.', 404, 'NOTIFICATION_NOT_FOUND');
  notification.readAt ||= new Date();
  await notification.save();
  return response.redirect('/dashboard#notifications');
}));

router.post('/dashboard/notifications/read-all', asyncHandler(async (request, response) => {
  await Notification.updateMany({ userId: request.user._id, readAt: null }, { $set: { readAt: new Date() } });
  await writeAudit(request, 'customer.notifications_read_all', { targetType: 'user', targetPublicId: request.user.publicId });
  return response.redirect('/dashboard#notifications');
}));

const ticketSchema = z.object({
  orderId: z.string().trim().max(100).optional(),
  category: z.enum(['order','payment','delivery','return','refund','account','product','seller','other']),
  subject: z.string().trim().min(4).max(180),
  priority: z.enum(['low','normal','high','urgent']).default('normal'),
  message: z.string().trim().min(10).max(2000),
});

router.post('/dashboard/support', asyncHandler(async (request, response) => {
  const ticket = await createTicket(request, ticketSchema.parse(request.body));
  await writeAudit(request, 'customer.support_ticket_created', { targetType: 'support_ticket', targetPublicId: ticket.publicId, country: ticket.country });
  setFlash(request, 'success', `Support ticket ${ticket.publicId} created.`);
  return response.redirect('/dashboard#support');
}));

router.post('/dashboard/profile', asyncHandler(async (request, response) => {
  try {
    const input = profileSchema.parse(request.body);
    const phoneNormalized = normalizePhone(input.phone);
    const duplicate = await User.exists({ _id: { $ne: request.user._id }, phoneNormalized });
    if (duplicate) throw new AppError('That phone number is already in use.', 409, 'PHONE_IN_USE');
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
    await writeAudit(request, 'customer.profile_updated', { targetType: 'user', targetPublicId: request.user.publicId, metadata: { phoneChanged, shoppingCountry: country.code } });
    if (phoneChanged) {
      setFlash(request, 'info', 'Profile saved. Verify your new phone number to continue using protected features.');
      return response.redirect('/verify-phone');
    }
    setFlash(request, 'success', 'Profile updated.');
    return response.redirect('/dashboard#profile');
  } catch (error) {
    setFlash(request, 'error', error.message);
    return response.redirect('/dashboard#profile');
  }
}));

export default router;
