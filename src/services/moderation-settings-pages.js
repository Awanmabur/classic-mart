import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { Device, User } from '../models/index.js';
import { assertModerationReadAccess, fenceModerationAccess, moderationAccess, moderationPublicContext } from './moderation-workspace-access.js';
import { writeAudit } from './audit.js';
import { DASHBOARD_PAGES, defaultPageFor } from '../dashboard/registry.js';
import { MODERATION_LIVE_ROUTES } from '../dashboard/moderation-routes.js';

const version = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
function preferencesFor(actor) {
  const prefs = actor.preferences || {};
  return { defaultCountry: prefs.moderationDefaultCountry || '',
    reportingPeriod: prefs.moderationReportingPeriod || '30days', landingPage: MODERATION_LIVE_ROUTES[prefs.moderationLandingPage] ? prefs.moderationLandingPage : defaultPageFor('moderator'),
    density: prefs.moderationDensity || 'comfortable', idleReminderMinutes: prefs.moderationIdleReminderMinutes || 30,
    highRiskAlerts: prefs.moderationHighRiskAlerts !== false, escalationAlerts: prefs.moderationEscalationAlerts !== false };
}
export async function loadModerationSettingsPage(request) {
  const context = await moderationAccess(request);
  const section = z.enum(['profile', 'business', 'payments', 'notifications', 'security']).parse(request.query?.section || 'profile');
  const activeSessions = await Device.countDocuments({ userId: context.actor._id, revokedAt: null });
  const preferences = { ...preferencesFor(context.actor), version: context.actorVersion };
  const countries = context.country ? context.countries.filter(row => row.code === context.country) : context.countries;
  const rows = countries.flatMap(row => [
    { id: row.code + '-calendar', cells: ['Reporting calendar', row.code, row.timeZone] },
    { id: row.code + '-currency', cells: ['Market currency', row.code, row.currency] },
    { id: row.code + '-status', cells: ['Operational market', row.code, 'Active and assigned'] },
  ]);
  await assertModerationReadAccess(request, context);
  return { kind: 'settings', pageId: 'moderator-settings', context: moderationPublicContext(context), country: context.country, timeZone: context.timeZone,
    section, preferences, profile: { name: context.actor.name, teamName: context.actor.roleProfile?.businessName || '', email: context.actor.email,
      phone: context.actor.phone, registrationCountry: context.actor.country, bio: context.actor.roleProfile?.bio || '', version: context.actorVersion },
    coverage: context.grant ? { startsAt: context.grant.startsAt, expiresAt: context.grant.expiresAt } : null,
    security: { mfaEnabled: context.actor.security.mfaEnabled, activeSessions },
    landingOptions: DASHBOARD_PAGES.moderator.map(([id, label]) => ({ id, label })),
    columns: ['Control', 'Country', 'Current value'], rows, page: { count: rows.length, total: rows.length, hasMore: false, next: '' },
    exportHref: '/moderation/settings/export.csv' + (context.country ? '?country=' + context.country : '') };
}

export async function saveModerationSettings(request, input) {
  const values = z.object({ version, defaultCountry: z.string().regex(/^(?:[A-Z]{2})?$/).optional(),
    reportingPeriod: z.enum(['30days', '7months', 'year']).optional(), landingPage: z.enum(Object.keys(MODERATION_LIVE_ROUTES)).optional(),
    density: z.enum(['comfortable', 'compact']).optional(), idleReminderMinutes: z.coerce.number().int().refine(value => [15, 30, 60].includes(value), 'Choose a supported reminder interval.').optional() }).parse(input);
  if (Object.keys(values).length < 2) throw new AppError('Choose a workspace preference before saving.', 422, 'MODERATION_SETTINGS_EMPTY');
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const context = await moderationAccess(request, { session });
      if (values.version !== context.actorVersion) throw new AppError('Your preferences changed. Reload before saving.', 409, 'MODERATION_SETTINGS_VERSION_CONFLICT');
      const { version: _version, ...changes } = values, preferences = { ...preferencesFor(context.actor), ...changes };
      if (preferences.defaultCountry && !context.countries.some(row => row.code === preferences.defaultCountry)) throw new AppError('Choose an assigned active country.', 403, 'MODERATION_COUNTRY_FORBIDDEN');
      await fenceModerationAccess(context, session, { allMarkets: true });
      const changed = await User.updateOne({ _id: context.actor._id, __v: context.actorVersion }, { $set: {
        'preferences.moderationDefaultCountry': preferences.defaultCountry,
        'preferences.moderationReportingPeriod': preferences.reportingPeriod, 'preferences.moderationLandingPage': preferences.landingPage,
        'preferences.moderationDensity': preferences.density, 'preferences.moderationIdleReminderMinutes': preferences.idleReminderMinutes }, $inc: { __v: 1 } }, { session });
      if (changed.modifiedCount !== 1) throw new AppError('Your preferences changed. Reload before saving.', 409, 'MODERATION_SETTINGS_VERSION_CONFLICT');
      await writeAudit(request, 'moderation.preferences_saved', { session, actor: context.actor, targetType: 'user', targetPublicId: context.actor.publicId,
        country: preferences.defaultCountry || context.country || context.countries[0].code, metadata: { defaultCountry: preferences.defaultCountry,
          reportingPeriod: preferences.reportingPeriod, landingPage: preferences.landingPage, density: preferences.density, idleReminderMinutes: preferences.idleReminderMinutes } });
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
      const context = await moderationAccess(request, { session });
      if (values.version !== context.actorVersion) throw new AppError('Your settings changed. Reload before saving.', 409, 'MODERATION_SETTINGS_VERSION_CONFLICT');
      await fenceModerationAccess(context, session);
      const changed = await User.updateOne({ _id: context.actor._id, __v: context.actorVersion }, { $set: fields, $inc: { __v: 1 } }, { session });
      if (changed.modifiedCount !== 1) throw new AppError('Your settings changed. Reload before saving.', 409, 'MODERATION_SETTINGS_VERSION_CONFLICT');
      await writeAudit(request, action, { session, actor: context.actor, targetType: 'user', targetPublicId: context.actor.publicId, country: context.country || context.countries[0].code });
      result = { version: context.actorVersion + 1 };
    });
    return result;
  } finally { await session.endSession(); }
}
export async function saveModerationProfile(request, input) {
  const values = z.object({ version, name: z.string().trim().min(2).max(120), teamName: z.string().trim().max(140).default(''), bio: z.string().trim().max(1000).default('') }).parse(input);
  return savePersonalFields(request, values, { name: values.name, 'roleProfile.businessName': values.teamName, 'roleProfile.bio': values.bio }, 'moderation.profile_saved');
}
export async function saveModerationCommunication(request, input) {
  const checked = value => [true, 'true', 'on', '1'].includes(value);
  const toggle = z.union([z.boolean(), z.enum(['on', 'true', 'false', '1', '0'])]).optional();
  const values = z.object({ version, highRiskAlerts: toggle, escalationAlerts: toggle }).parse(input);
  return savePersonalFields(request, values, { 'preferences.moderationHighRiskAlerts': checked(values.highRiskAlerts),
    'preferences.moderationEscalationAlerts': checked(values.escalationAlerts) }, 'moderation.communication_saved');
}
