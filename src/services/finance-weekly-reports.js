import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { FinanceDigest, User } from '../models/index.js';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { financeAccess } from './finance-workspace-access.js';
import { financeReportSummary } from './finance-report-pages.js';
import { addOutboxEvent } from './outbox.js';
import { writeAudit } from './audit.js';
import { scanMaintenanceBatch } from './maintenance-scan.js';

function calendarParts(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(now);
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
}

function localMidnight(year, month, day, timeZone) {
  const target = Date.UTC(year, month - 1, day); let instant = target;
  for (let pass = 0; pass < 5; pass += 1) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant)).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
    const delta = target - Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    if (!delta) return new Date(instant); instant += delta;
  }
  throw new AppError('The weekly reporting calendar needs configuration.', 503, 'FINANCE_CALENDAR_UNAVAILABLE');
}

export function financeWeeklyWindow(now, timeZone) {
  const local = calendarParts(now, timeZone);
  if (local.weekday !== 'Mon' || Number(local.hour) !== 8) return null;
  const weekKey = `${local.year}-${local.month}-${local.day}`, date = new Date(Date.UTC(Number(local.year), Number(local.month) - 1, Number(local.day) - 7));
  return { weekKey, start: localMidnight(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), timeZone), end: localMidnight(Number(local.year), Number(local.month), Number(local.day), timeZone), timeZone };
}

const digestScope = context => (context.country ? context.countries.filter(row => row.code === context.country) : context.countries).map(row => row.code).sort();
const digestCurrencies = context => (context.country ? context.countries.filter(row => row.code === context.country) : context.countries).map(row => row.code + ':' + row.currency).sort();
const jobRequest = actor => ({ user: actor, query: {}, session: { tokenVersion: actor.security.tokenVersion }, id: randomUUID(), ip: '', get: () => '' });

/** The recurring job queues one reviewable aggregate report per opted-in operator/week. */
export async function queueWeeklyFinanceReports({ now = new Date(), limit = 200 } = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new AppError('Weekly report time is invalid.', 422, 'FINANCE_REPORT_TIME_INVALID');
  let checked = 0, queued = 0, skipped = 0;
  const batch = await scanMaintenanceBatch(User, 'finance_weekly_reports', { status: 'active', 'preferences.financeWeeklyReport': true }, { limit });
  for (const actor of batch.rows) {
      checked += 1; const request = jobRequest(actor); let context;
      try { context = await financeAccess(request); } catch (error) { if (error instanceof AppError && error.status < 500) { skipped += 1; continue; } throw error; }
      const window = financeWeeklyWindow(now, context.timeZone);
      if (!window || await FinanceDigest.exists({ userId: actor._id, weekKey: window.weekKey })) { skipped += 1; continue; }
      const session = await mongoose.startSession();
      try {
        let created = false;
        await session.withTransaction(async () => {
          const current = await financeAccess(request, { session, write: true });
          if (current.actor.preferences.financeWeeklyReport !== true || current.timeZone !== window.timeZone || current.country !== context.country) return;
          if (await FinanceDigest.exists({ userId: actor._id, weekKey: window.weekKey }).session(session)) return;
          const summary = await financeReportSummary({ ...current, session }, window, now);
          const [digest] = await FinanceDigest.create([{ publicId: publicId('fdg'), userId: actor._id, weekKey: window.weekKey, country: current.country,
            timeZone: current.timeZone, scopeCountries: digestScope(current), scopeCurrencies: digestCurrencies(current), tokenVersion: current.actor.security.tokenVersion,
            email: current.actor.email, periodStart: window.start, periodEnd: window.end, groups: summary.groups, status: 'queued' }], { session });
          await addOutboxEvent({ type: 'finance.weekly_report', aggregateType: 'finance_digest', aggregatePublicId: digest.publicId,
            payload: { digestPublicId: digest.publicId, userId: String(actor._id), tokenVersion: current.actor.security.tokenVersion, email: current.actor.email,
              country: current.country, scopeCountries: digestScope(current), scopeCurrencies: digestCurrencies(current) } }, session);
          await writeAudit(request, 'finance.weekly_report_queued', { session, actor: current.actor, country: current.country || current.countries[0].code,
            targetType: 'finance_digest', targetPublicId: digest.publicId, metadata: { weekKey: window.weekKey, countryScope: digestScope(current) } });
          created = true;
        });
        if (created) queued += 1; else skipped += 1;
      } catch (error) {
        if (error.code === 11000 && await FinanceDigest.exists({ userId: actor._id, weekKey: window.weekKey })) skipped += 1;
        else if (error instanceof AppError && ['ACCOUNT_UNAVAILABLE', 'FINANCE_ACCESS_CHANGED', 'FINANCE_GRANT_UNAVAILABLE'].includes(error.code)) skipped += 1;
        else throw error;
      } finally { await session.endSession(); }
  }
  return { checked, queued, skipped, passCompleted: batch.passCompleted };
}

async function cancelDigest(digest, reason) {
  await FinanceDigest.updateOne({ _id: digest._id, status: 'queued' }, { $set: { status: 'cancelled', processedAt: new Date(), cancellationReason: reason } });
  return null;
}

export async function prepareFinanceDigestDelivery(event) {
  if (event.type !== 'finance.weekly_report') return null;
  const digest = await FinanceDigest.findOne({ publicId: event.aggregatePublicId, status: 'queued' }).select('+tokenVersion +email +groups');
  if (!digest) return null;
  if (event.payload?.digestPublicId !== digest.publicId || event.payload?.userId !== String(digest.userId) || event.payload?.tokenVersion !== digest.tokenVersion || event.payload?.email !== digest.email) return cancelDigest(digest, 'Delivery snapshot does not match.');
  const actor = await User.findById(digest.userId);
  if (!actor || actor.status !== 'active' || actor.preferences.financeWeeklyReport !== true || actor.security.tokenVersion !== digest.tokenVersion || actor.email !== digest.email) return cancelDigest(digest, 'Account, email, session or communication preference changed.');
  let context;
  try { context = await financeAccess(jobRequest(actor), { country: digest.country }); }
  catch (error) { if (error instanceof AppError && error.status < 500) return cancelDigest(digest, 'Current Finance authorization is unavailable.'); throw error; }
  const preferred = actor.preferences.financeDefaultCountry;
  const currentDefault = context.countries.some(row => row.code === preferred) ? preferred : context.countries.length === 1 ? context.countries[0].code : '';
  if (currentDefault !== digest.country || context.timeZone !== digest.timeZone || JSON.stringify(digestScope(context)) !== JSON.stringify([...digest.scopeCountries].sort()) || JSON.stringify(digestCurrencies(context)) !== JSON.stringify([...digest.scopeCurrencies].sort())) return cancelDigest(digest, 'Authorized markets or report defaults changed.');
  const lines = [`Classic Mart weekly Finance report`, `Reporting period: ${digest.periodStart.toISOString()} to ${digest.periodEnd.toISOString()} (${digest.timeZone})`, '', 'Amounts are minor units, separated by country and currency.', 'Country currency | captured | refunds | paid payouts | open exceptions'];
  for (const row of digest.groups) lines.push(`${row.country} ${row.currency} | ${row.capturedMinor} | ${row.refundedMinor} | ${row.payoutMinor} | ${row.exceptions}`);
  lines.push('', 'Use Finance Reports for the complete scoped ledger and record exports. This report contains aggregate financial totals and no customer contact information.');
  let text = lines.join('\n');
  // SMTP's existing 10,000-character bound must not silently hide a market group.
  if (text.length > 10000) text = `${lines.slice(0, 5).join('\n')}\n\n${digest.groups.length} separate market/currency groups are available in Finance Reports. Open the authenticated report page for all amounts and CSV exports.`;
  return { email: actor.email, subject: `Classic Mart Finance weekly report — ${digest.weekKey}`, text };
}

export async function finishFinanceDigestDelivery(event, result) {
  if (event.type !== 'finance.weekly_report') return;
  if (!result?.developmentSink && result?.delivered !== true) throw new AppError('Weekly report delivery was not confirmed.', 502, 'FINANCE_DIGEST_DELIVERY_UNCONFIRMED');
  await FinanceDigest.updateOne({ publicId: event.aggregatePublicId, status: 'queued' }, { $set: { status: result.developmentSink ? 'development_sink' : 'sent', processedAt: new Date() } });
}
