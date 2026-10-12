import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { Device, SupportDigest, User } from '../models/index.js';
import { assertSupportReadAccess, fenceSupportAccess, supportAccess, supportPublicContext } from './support-workspace-access.js';
import { writeAudit } from './audit.js';
import { DASHBOARD_PAGES } from '../dashboard/registry.js';
import { SUPPORT_LIVE_ROUTES } from '../dashboard/support-routes.js';

const QUEUES = ['general', 'orders', 'payments', 'delivery', 'returns', 'accounts', 'seller'];
const version = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const label = value => value.replaceAll('_', ' ').replace(/\b\w/g, char => char.toUpperCase());
function preferencesFor(actor) {
  const prefs = actor.preferences || {};
  return { defaultCountry: prefs.supportDefaultCountry || '', defaultQueue: prefs.supportDefaultQueue || '',
    reportingPeriod: prefs.supportReportingPeriod || '30days', landingPage: SUPPORT_LIVE_ROUTES[prefs.supportLandingPage] ? prefs.supportLandingPage : 'support-overview',
    density: prefs.supportDensity || 'comfortable', idleReminderMinutes: prefs.supportIdleReminderMinutes || 30,
    priorityAlerts: prefs.supportPriorityAlerts !== false, escalationAlerts: prefs.supportEscalationAlerts !== false, weeklyReport: prefs.supportWeeklyReport === true };
}
export async function loadSupportSettingsPage(request) {
  const context = await supportAccess(request);
  const section = z.enum(['profile', 'business', 'payments', 'notifications', 'security']).parse(request.query?.section || 'profile');
  const [activeSessions, digest] = await Promise.all([
    Device.countDocuments({ userId: context.actor._id, revokedAt: null }),
    SupportDigest.findOne({ userId: context.actor._id }).select('publicId status createdAt processedAt').sort({ createdAt: -1 }).lean(),
  ]);
  const preferences = { ...preferencesFor(context.actor), version: context.actorVersion };
  const countries = context.country ? context.countries.filter(row => row.code === context.country) : context.countries;
  const rows = countries.flatMap(row => [
    { id: row.code + '-calendar', cells: ['Reporting calendar', row.code, row.timeZone] },
    { id: row.code + '-urgent', cells: ['Urgent ticket SLA', row.code, '4 hours'] },
    { id: row.code + '-high', cells: ['High priority ticket SLA', row.code, '12 hours'] },
    { id: row.code + '-standard', cells: ['Standard ticket SLA', row.code, '48 hours'] },
  ]);
  await assertSupportReadAccess(request, context);
  return { kind: 'settings', pageId: 'support-settings', context: supportPublicContext(context), country: context.country, timeZone: context.timeZone,
    section, preferences, profile: { name: context.actor.name, teamName: context.actor.roleProfile?.businessName || '', email: context.actor.email,
      phone: context.actor.phone, registrationCountry: context.actor.country, bio: context.actor.roleProfile?.bio || '', version: context.actorVersion },
    coverage: context.grant ? { startsAt: context.grant.startsAt, expiresAt: context.grant.expiresAt } : null,
    security: { mfaEnabled: context.actor.security.mfaEnabled, activeSessions },
    latestDigest: digest ? { publicId: digest.publicId, status: digest.status, createdAt: digest.createdAt, processedAt: digest.processedAt } : null,
    landingOptions: DASHBOARD_PAGES.support.map(([id, label]) => ({ id, label })),
    queueOptions: [{ value: '', label: 'All queues' }, ...QUEUES.map(value => ({ value, label: label(value) }))],
    columns: ['Control', 'Country', 'Current value'], rows, page: { count: rows.length, total: rows.length, hasMore: false, next: '' },
    exportHref: '/support/settings/export.csv' + (context.country ? '?country=' + context.country : '') };
}

export async function saveSupportSettings(request, input) {
  const values = z.object({ version, defaultCountry: z.string().regex(/^(?:[A-Z]{2})?$/).optional(), defaultQueue: z.enum(['', ...QUEUES]).optional(),
    reportingPeriod: z.enum(['30days', '7months', 'year']).optional(), landingPage: z.enum(Object.keys(SUPPORT_LIVE_ROUTES)).optional(),
    density: z.enum(['comfortable', 'compact']).optional(), idleReminderMinutes: z.coerce.number().int().refine(value => [15, 30, 60].includes(value), 'Choose a supported reminder interval.').optional() }).parse(input);
  if (Object.keys(values).length < 2) throw new AppError('Choose a workspace preference before saving.', 422, 'SUPPORT_SETTINGS_EMPTY');
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const context = await supportAccess(request, { session });
      if (values.version !== context.actorVersion) throw new AppError('Your preferences changed. Reload before saving.', 409, 'SUPPORT_SETTINGS_VERSION_CONFLICT');
      const { version: _version, ...changes } = values, preferences = { ...preferencesFor(context.actor), ...changes };
      if (preferences.defaultCountry && !context.countries.some(row => row.code === preferences.defaultCountry)) throw new AppError('Choose an assigned active country.', 403, 'SUPPORT_COUNTRY_FORBIDDEN');
      await fenceSupportAccess(context, session, { allMarkets: true });
      const changed = await User.updateOne({ _id: context.actor._id, __v: context.actorVersion }, { $set: {
        'preferences.supportDefaultCountry': preferences.defaultCountry, 'preferences.supportDefaultQueue': preferences.defaultQueue,
        'preferences.supportReportingPeriod': preferences.reportingPeriod, 'preferences.supportLandingPage': preferences.landingPage,
        'preferences.supportDensity': preferences.density, 'preferences.supportIdleReminderMinutes': preferences.idleReminderMinutes }, $inc: { __v: 1 } }, { session });
      if (changed.modifiedCount !== 1) throw new AppError('Your preferences changed. Reload before saving.', 409, 'SUPPORT_SETTINGS_VERSION_CONFLICT');
      await writeAudit(request, 'support.preferences_saved', { session, actor: context.actor, targetType: 'user', targetPublicId: context.actor.publicId,
        country: preferences.defaultCountry || context.country || context.countries[0].code, metadata: { defaultCountry: preferences.defaultCountry,
          defaultQueue: preferences.defaultQueue, reportingPeriod: preferences.reportingPeriod, landingPage: preferences.landingPage, density: preferences.density, idleReminderMinutes: preferences.idleReminderMinutes } });
      result = { ...preferences, version: context.actorVersion + 1 };
    });
    return result;
  } finally { await session.endSession(); }
}

async function savePersonalFields(request, values, fields, action) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const context = await supportAccess(request, { session });
      if (values.version !== context.actorVersion) throw new AppError('Your settings changed. Reload before saving.', 409, 'SUPPORT_SETTINGS_VERSION_CONFLICT');
      await fenceSupportAccess(context, session);
      const changed = await User.updateOne({ _id: context.actor._id, __v: context.actorVersion }, { $set: fields, $inc: { __v: 1 } }, { session });
      if (changed.modifiedCount !== 1) throw new AppError('Your settings changed. Reload before saving.', 409, 'SUPPORT_SETTINGS_VERSION_CONFLICT');
      await writeAudit(request, action, { session, actor: context.actor, targetType: 'user', targetPublicId: context.actor.publicId, country: context.country || context.countries[0].code });
      result = { version: context.actorVersion + 1 };
    });
    return result;
  } finally { await session.endSession(); }
}
export async function saveSupportProfile(request, input) {
  const values = z.object({ version, name: z.string().trim().min(2).max(120), teamName: z.string().trim().max(140).default(''), bio: z.string().trim().max(1000).default('') }).parse(input);
  return savePersonalFields(request, values, { name: values.name, 'roleProfile.businessName': values.teamName, 'roleProfile.bio': values.bio }, 'support.profile_saved');
}
export async function saveSupportCommunication(request, input) {
  const checked = value => [true, 'true', 'on', '1'].includes(value);
  const toggle = z.union([z.boolean(), z.enum(['on', 'true', 'false', '1', '0'])]).optional();
  const values = z.object({ version, priorityAlerts: toggle, escalationAlerts: toggle, weeklyReport: toggle }).parse(input);
  return savePersonalFields(request, values, { 'preferences.supportPriorityAlerts': checked(values.priorityAlerts),
    'preferences.supportEscalationAlerts': checked(values.escalationAlerts), 'preferences.supportWeeklyReport': checked(values.weeklyReport) }, 'support.communication_saved');
}
