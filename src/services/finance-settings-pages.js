import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { env } from '../config/env.js';
import { CountrySetting, Device, FinanceDigest, User } from '../models/index.js';
import { assertFinanceExportAccess, financeAccess, financePublicContext, fenceFinanceAccess } from './finance-workspace-access.js';
import { writeAudit } from './audit.js';
import { DASHBOARD_PAGES } from '../dashboard/registry.js';
import { FINANCE_LIVE_ROUTES } from '../dashboard/finance-routes.js';

export async function loadFinanceSettingsPage(request) {
  const context = await financeAccess(request);
  const section = z.enum(['profile', 'business', 'payments', 'notifications', 'security']).parse(request.query?.section || 'profile');
  const configurations = await CountrySetting.find({ code: mongoose.trusted({ $in: context.country ? [context.country] : context.countries.map(row => row.code) }) })
    .select('code currency timeZone taxBps platformFeeBps policyVersion payments growth.promoterCommissionBps').sort({ code: 1 }).lean();
  const providerConfigured = Boolean(env.pesapal.consumerKey && env.pesapal.consumerSecret && env.pesapal.notificationId);
  const preferences = { defaultCountry: context.actor.preferences.financeDefaultCountry || '', reportingPeriod: context.actor.preferences.financeReportingPeriod || '30days',
    landingPage: FINANCE_LIVE_ROUTES[context.actor.preferences.financeLandingPage] ? context.actor.preferences.financeLandingPage : 'finance-overview',
    priorityAlerts: context.actor.preferences.financePriorityAlerts !== false, escalationAlerts: context.actor.preferences.financeEscalationAlerts !== false,
    weeklyReport: context.actor.preferences.financeWeeklyReport === true, version: context.actorVersion };
  const [activeSessions, latestDigest] = await Promise.all([
    Device.countDocuments({ userId: context.actor._id, revokedAt: null }),
    FinanceDigest.findOne({ userId: context.actor._id }).select('publicId status createdAt processedAt').sort({ createdAt: -1 }).lean(),
  ]);
  const rows = configurations.flatMap(row => [
    { id: row.code + '-currency', cells: ['Settlement currency', row.code, row.currency, row.currency] },
    { id: row.code + '-calendar', cells: ['Reporting time zone', row.code, row.currency, row.timeZone] },
    { id: row.code + '-fee', cells: ['Platform fee', row.code, row.currency, (row.platformFeeBps / 100).toFixed(2) + '%'] },
    { id: row.code + '-tax', cells: ['Tax policy', row.code, row.currency, (row.taxBps / 100).toFixed(2) + '%'] },
    { id: row.code + '-promoter', cells: ['Marketplace Promoter commission', row.code, row.currency, ((row.growth?.promoterCommissionBps || 0) / 100).toFixed(2) + '%'] },
    { id: row.code + '-policy', cells: ['Policy version', row.code, row.currency, row.policyVersion] },
  ]);
  await assertFinanceExportAccess(request, context);
  return { kind: 'settings', pageId: 'finance-settings', context: financePublicContext(context), country: context.country,
    currency: context.currency, timeZone: context.timeZone, preferences, section,
    profile: { name: context.actor.name, teamName: context.actor.roleProfile?.businessName || '', email: context.actor.email, phone: context.actor.phone,
      registrationCountry: context.actor.country, bio: context.actor.roleProfile?.bio || '', version: context.actorVersion },
    coverage: context.grant ? { startsAt: context.grant.startsAt, expiresAt: context.grant.expiresAt } : null,
    security: { mfaEnabled: context.actor.security.mfaEnabled, activeSessions },
    payments: { providerConfigured, providerMode: env.pesapal.sandbox ? 'Sandbox' : 'Live', countries: configurations.map(({ code, currency, payments }) => ({ code, currency, methods: payments })) },
    landingOptions: DASHBOARD_PAGES.finance.map(([id, label]) => ({ id, label })), latestDigest: latestDigest ? { publicId: latestDigest.publicId, status: latestDigest.status, createdAt: latestDigest.createdAt, processedAt: latestDigest.processedAt } : null,
    metrics: [{ label: 'Assigned active countries', value: context.countries.length, detail: 'Current operational authorization' },
      { label: 'Scoped currencies', value: new Set(context.countries.map(row => row.currency)).size, detail: 'Reported separately by country and currency' },
      { label: 'Authenticator', value: context.actor.security.mfaEnabled ? 'Enabled' : 'Not enrolled', detail: 'Personal account security' },
      { label: 'Pesapal configuration', value: providerConfigured ? 'Configured' : 'Incomplete', detail: 'Configuration does not confirm delivery or settlement' }],
    columns: ['Control', 'Country', 'Currency', 'Current value'], rows,
    page: { count: rows.length, total: rows.length, hasMore: false, next: '' }, exportHref: '/finance/settings/export.csv' + (context.country ? '?country=' + context.country : ''),
    filters: { search: '', status: '', statuses: [], params: { country: context.country } },
    insights: ['Country policy changes require the existing administrator approval process.', 'Report defaults do not change operational permissions.'],
    workflow: [{ title: 'Reporting preferences', detail: 'Save the default scope and reporting period used by your Finance pages.', href: '#finance-report-preferences', label: 'Preferences' },
      { title: 'Password & Security', detail: 'Manage your authenticator, sessions and password.', href: '/account/security', label: 'Security centre' }],
  };
}

export async function saveFinanceSettings(request, input) {
  const values = z.object({ version: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    defaultCountry: z.string().regex(/^(?:[A-Z]{2})?$/), reportingPeriod: z.enum(['30days', '7months', 'year']),
    landingPage: z.enum(Object.keys(FINANCE_LIVE_ROUTES)).default('finance-overview') }).parse(input);
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const context = await financeAccess(request, { session });
      if (values.version !== context.actorVersion) throw new AppError('Your preferences changed. Reload before saving.', 409, 'FINANCE_SETTINGS_VERSION_CONFLICT');
      if (values.defaultCountry && !context.countries.some(row => row.code === values.defaultCountry)) throw new AppError('The default country must be within your current Finance scope.', 403, 'FINANCE_COUNTRY_FORBIDDEN');
      await fenceFinanceAccess(context, session, { allMarkets: true });
      const saved = await User.updateOne({ _id: context.actor._id, __v: context.actorVersion }, {
        $set: { 'preferences.financeDefaultCountry': values.defaultCountry, 'preferences.financeReportingPeriod': values.reportingPeriod, 'preferences.financeLandingPage': values.landingPage }, $inc: { __v: 1 },
      }, { session });
      if (saved.modifiedCount !== 1) throw new AppError('Your preferences changed. Reload before saving.', 409, 'FINANCE_SETTINGS_VERSION_CONFLICT');
      await writeAudit(request, 'finance.preferences_saved', { session, actor: context.actor, targetType: 'user', targetPublicId: context.actor.publicId,
        country: values.defaultCountry || context.country || context.countries[0].code, metadata: { defaultCountry: values.defaultCountry, reportingPeriod: values.reportingPeriod, landingPage: values.landingPage } });
      result = { defaultCountry: values.defaultCountry, reportingPeriod: values.reportingPeriod, landingPage: values.landingPage, version: context.actorVersion + 1 };
    });
    return result;
  } finally { await session.endSession(); }
}

async function savePersonalFinanceFields(request, values, updates, action) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const context = await financeAccess(request, { session });
      if (values.version !== context.actorVersion) throw new AppError('Your settings changed. Reload before saving.', 409, 'FINANCE_SETTINGS_VERSION_CONFLICT');
      await fenceFinanceAccess(context, session);
      const updated = await User.updateOne({ _id: context.actor._id, __v: context.actorVersion }, { $set: updates, $inc: { __v: 1 } }, { session });
      if (updated.modifiedCount !== 1) throw new AppError('Your settings changed. Reload before saving.', 409, 'FINANCE_SETTINGS_VERSION_CONFLICT');
      await writeAudit(request, action, { session, actor: context.actor, targetType: 'user', targetPublicId: context.actor.publicId, country: context.country || context.countries[0].code });
      result = { version: context.actorVersion + 1 };
    });
    return result;
  } finally { await session.endSession(); }
}

export async function saveFinanceProfile(request, input) {
  const values = z.object({ version: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), name: z.string().trim().min(2).max(120),
    teamName: z.string().trim().max(140).default(''), bio: z.string().trim().max(1000).default('') }).parse(input);
  return savePersonalFinanceFields(request, values, { name: values.name, 'roleProfile.businessName': values.teamName, 'roleProfile.bio': values.bio }, 'finance.profile_saved');
}
export async function saveFinanceCommunication(request, input) {
  const checked = value => [true, 'true', 'on', '1'].includes(value);
  const values = z.object({ version: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    priorityAlerts: z.union([z.boolean(), z.enum(['on', 'true', 'false', '1', '0'])]).optional(), escalationAlerts: z.union([z.boolean(), z.enum(['on', 'true', 'false', '1', '0'])]).optional(), weeklyReport: z.union([z.boolean(), z.enum(['on', 'true', 'false', '1', '0'])]).optional() }).parse(input);
  return savePersonalFinanceFields(request, values, { 'preferences.financePriorityAlerts': checked(values.priorityAlerts),
    'preferences.financeEscalationAlerts': checked(values.escalationAlerts), 'preferences.financeWeeklyReport': checked(values.weeklyReport) }, 'finance.communication_saved');
}
