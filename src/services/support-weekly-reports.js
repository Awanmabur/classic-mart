import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { SupportDigest, User } from '../models/index.js';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { supportAccess } from './support-workspace-access.js';
import { supportReportSummary } from './support-report-pages.js';
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
  throw new AppError('The weekly reporting calendar needs configuration.', 503, 'SUPPORT_CALENDAR_UNAVAILABLE');
}

export function supportWeeklyWindow(now, timeZone) {
  const local = calendarParts(now, timeZone);
  if (local.weekday !== 'Mon' || Number(local.hour) !== 8) return null;
  const weekKey = `${local.year}-${local.month}-${local.day}`, date = new Date(Date.UTC(Number(local.year), Number(local.month) - 1, Number(local.day) - 7));
  return { weekKey, start: localMidnight(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), timeZone), end: localMidnight(Number(local.year), Number(local.month), Number(local.day), timeZone), timeZone };
}

const digestScope = context => (context.country ? context.countries.filter(row => row.code === context.country) : context.countries).map(row => row.code).sort();
const digestCurrencies = context => (context.country ? context.countries.filter(row => row.code === context.country) : context.countries).map(row => row.code + ':' + row.currency).sort();
const jobRequest = actor => ({ user: actor, query: {}, session: { tokenVersion: actor.security.tokenVersion }, id: randomUUID(), ip: '', get: () => '' });

/** The recurring job queues one reviewable aggregate report per opted-in operator/week. */
export async function queueWeeklySupportReports({ now = new Date(), limit = 200 } = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new AppError('Weekly report time is invalid.', 422, 'SUPPORT_REPORT_TIME_INVALID');
  let checked = 0, queued = 0, skipped = 0;
  const batch = await scanMaintenanceBatch(User, 'support_weekly_reports', { status: 'active', 'preferences.supportWeeklyReport': true }, { limit });
  for (const actor of batch.rows) {
      checked += 1; const request = jobRequest(actor); let context;
      try { context = await supportAccess(request); } catch (error) { if (error instanceof AppError && error.status < 500) { skipped += 1; continue; } throw error; }
      const window = supportWeeklyWindow(now, context.timeZone);
      if (!window || await SupportDigest.exists({ userId: actor._id, weekKey: window.weekKey })) { skipped += 1; continue; }
      const session = await mongoose.startSession();
      try {
        let created = false;
        await session.withTransaction(async () => {
          const current = await supportAccess(request, { session, write: true });
          if (current.actor.preferences.supportWeeklyReport !== true || current.timeZone !== window.timeZone || current.country !== context.country) return;
          if (await SupportDigest.exists({ userId: actor._id, weekKey: window.weekKey }).session(session)) return;
          const summary = await supportReportSummary({ ...current, session }, window, now);
          const [digest] = await SupportDigest.create([{ publicId: publicId('sdg'), userId: actor._id, weekKey: window.weekKey, country: current.country,
            timeZone: current.timeZone, scopeCountries: digestScope(current), scopeCurrencies: digestCurrencies(current), tokenVersion: current.actor.security.tokenVersion,
            email: current.actor.email, periodStart: window.start, periodEnd: window.end, groups: summary.groups, status: 'queued' }], { session });
          await addOutboxEvent({ type: 'support.weekly_report', aggregateType: 'support_digest', aggregatePublicId: digest.publicId,
            payload: { digestPublicId: digest.publicId, userId: String(actor._id), tokenVersion: current.actor.security.tokenVersion, email: current.actor.email,
              country: current.country, scopeCountries: digestScope(current), scopeCurrencies: digestCurrencies(current) } }, session);
          await writeAudit(request, 'support.weekly_report_queued', { session, actor: current.actor, country: current.country || current.countries[0].code,
            targetType: 'support_digest', targetPublicId: digest.publicId, metadata: { weekKey: window.weekKey, countryScope: digestScope(current) } });
          created = true;
        });
        if (created) queued += 1; else skipped += 1;
      } catch (error) {
        if (error.code === 11000 && await SupportDigest.exists({ userId: actor._id, weekKey: window.weekKey })) skipped += 1;
        else if (error instanceof AppError && error.status < 500) skipped += 1;
        else throw error;
      } finally { await session.endSession(); }
  }
  return { checked, queued, skipped, passCompleted: batch.passCompleted };
}

async function cancelDigest(digest, reason) {
  await SupportDigest.updateOne({ _id: digest._id, status: 'queued' }, { $set: { status: 'cancelled', processedAt: new Date(), cancellationReason: reason } });
  return null;
}

export async function prepareSupportDigestDelivery(event) {
  if (event.type !== 'support.weekly_report') return null;
  const digest = await SupportDigest.findOne({ publicId: event.aggregatePublicId, status: 'queued' }).select('+tokenVersion +email +groups');
  if (!digest) return null;
  if (event.payload?.digestPublicId !== digest.publicId || event.payload?.userId !== String(digest.userId) || event.payload?.tokenVersion !== digest.tokenVersion || event.payload?.email !== digest.email) return cancelDigest(digest, 'Delivery snapshot does not match.');
  const actor = await User.findById(digest.userId);
  if (!actor || actor.status !== 'active' || actor.preferences.supportWeeklyReport !== true || actor.security.tokenVersion !== digest.tokenVersion || actor.email !== digest.email) return cancelDigest(digest, 'Account, email, session or communication preference changed.');
  let context;
  try { context = await supportAccess(jobRequest(actor), { country: digest.country }); }
  catch (error) { if (error instanceof AppError && error.status < 500) return cancelDigest(digest, 'Current Support authorization is unavailable.'); throw error; }
  const preferred = actor.preferences.supportDefaultCountry;
  const currentDefault = context.countries.some(row => row.code === preferred) ? preferred : context.countries.length === 1 ? context.countries[0].code : '';
  if (currentDefault !== digest.country || context.timeZone !== digest.timeZone || JSON.stringify(digestScope(context)) !== JSON.stringify([...digest.scopeCountries].sort()) || JSON.stringify(digestCurrencies(context)) !== JSON.stringify([...digest.scopeCurrencies].sort())) return cancelDigest(digest, 'Authorized markets or report defaults changed.');
  const lines = [`Classic Mart weekly Support report`, `Reporting period: ${digest.periodStart.toISOString()} to ${digest.periodEnd.toISOString()} (${digest.timeZone})`, '', 'Country | created | resolved | open | overdue | verified ratings | satisfaction', ''];
  for (const row of digest.groups) lines.push(`${row.country} | ${row.createdCount} | ${row.resolvedCount} | ${row.openCount} | ${row.overdueCount} | ${row.surveyCount} | ${row.csatAverage === null ? 'No observations' : row.csatAverage + ' / 5'}`);
  lines.push('', 'Use Support Reports for complete scoped workload, public-response timing and anonymous survey exports. This report contains aggregate counts and no customer identities, contacts or message content.');
  let text = lines.join('\n');
  if (text.length > 10000) text = `${lines.slice(0, 4).join('\n')}\n\n${digest.groups.length} separate market groups are available in Support Reports. Open the authenticated report page for complete counts and CSV exports.`;
  return { email: actor.email, subject: `Classic Mart Support weekly report — ${digest.weekKey}`, text };
}

export async function finishSupportDigestDelivery(event, result) {
  if (event.type !== 'support.weekly_report') return;
  if (!result?.developmentSink && result?.delivered !== true) throw new AppError('Weekly report delivery was not confirmed.', 502, 'SUPPORT_DIGEST_DELIVERY_UNCONFIRMED');
  await SupportDigest.updateOne({ publicId: event.aggregatePublicId, status: 'queued' }, { $set: { status: result.developmentSink ? 'development_sink' : 'sent', processedAt: new Date() } });
}
