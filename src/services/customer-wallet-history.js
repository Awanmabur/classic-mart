import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { LedgerAccount, LedgerTransaction, WalletTopUp } from '../models/index.js';
import { currentCustomerAccess } from './customer-access.js';
import { customerHistoryPage } from './customer-history.js';
import { writeAudit } from './audit.js';

const dates = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
const factor = currency => 10 ** new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;

async function walletScope(request) {
  const actor = await currentCustomerAccess(request);
  const country = request.country?.code || actor.country, currency = request.country?.currency || actor.currency;
  const account = await LedgerAccount.findOne({ code: 'customer_wallet', ownerType: 'customer', ownerPublicId: actor.publicId, country, currency }).lean();
  return { actor, country, currency, account };
}

export async function customerWalletActivity(request) {
  const { actor, country, currency, account } = await walletScope(request);
  const [page, topUpPage] = await Promise.all([
    customerHistoryPage(LedgerTransaction, { country, currency, 'entries.accountId': account?._id || new mongoose.Types.ObjectId() }, request, 'walletCursor', { field: 'postedAt', binding: `${country}:${currency}` }),
    customerHistoryPage(WalletTopUp, { userId: actor._id, country, currency }, request, 'topUpsCursor', { binding: `${country}:${currency}`, limit: 12 }),
  ]);
  return { country, currency, entries: page.items.map(row => {
    const owned = row.entries.filter(entry => String(entry.accountId) === String(account?._id));
    return { publicId: row.publicId, type: row.referenceType, referencePublicId: row.referencePublicId, description: row.description,
      postedAt: row.postedAt, currency: row.currency, amountMinor: owned.reduce((sum, entry) => sum + entry.creditMinor - entry.debitMinor, 0) };
  }), pagination: page.pagination, topUps: topUpPage.items, topUpsPagination: topUpPage.pagination };
}

const csvCell = value => {
  const raw = String(value ?? '');
  return `"${(/^[\s]*[=+@-]/.test(raw) ? "'" + raw : raw).replaceAll('"', '""')}"`;
};
const isoDay = (value, name) => {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new AppError(`Choose a valid ${name} date.`, 422, 'WALLET_STATEMENT_DATE_INVALID');
  return date;
};

function drain(response) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { response.off('drain', ready); response.off('close', closed); response.off('error', failed); };
    const ready = () => { cleanup(); resolve(); }, closed = () => { cleanup(); reject(new AppError('Statement connection closed.', 499, 'EXPORT_CLOSED')); }, failed = error => { cleanup(); reject(error); };
    response.once('drain', ready); response.once('close', closed); response.once('error', failed);
    if (response.destroyed) closed();
  });
}

/** Every ledger posting is exported with a true opening and running balance. */
export async function streamCustomerWalletStatement(request, response) {
  const input = dates.parse(request.query || {}), snapshot = new Date();
  const from = isoDay(input.from, 'start') || new Date(0), toDay = isoDay(input.to, 'end');
  if (toDay && toDay > snapshot) throw new AppError('Choose a valid statement date range.', 422, 'WALLET_STATEMENT_RANGE_INVALID');
  const until = toDay ? new Date(Math.min(toDay.getTime() + 86_400_000, snapshot.getTime())) : snapshot;
  if (from >= until) throw new AppError('Choose a valid statement date range.', 422, 'WALLET_STATEMENT_RANGE_INVALID');
  const original = await walletScope(request), { actor, account, country, currency } = original;
  const asOf = { createdAt: { $lt: snapshot } };
  const owned = account ? { country, currency, 'entries.accountId': account._id, ...asOf } : null;
  const totals = owned ? await LedgerTransaction.aggregate([
    { $match: { ...owned, postedAt: { $lt: from } } }, { $unwind: '$entries' }, { $match: { 'entries.accountId': account._id } },
    { $group: { _id: null, amountMinor: { $sum: { $subtract: ['$entries.creditMinor', '$entries.debitMinor'] } } } },
  ]) : [];
  let balance = Number(totals[0]?.amountMinor || 0), count = 0;
  const assertAccess = async () => {
    const current = await walletScope(request);
    if (String(current.account?._id || '') !== String(account?._id || '') || current.country !== country || current.currency !== currency || current.actor.publicId !== actor.publicId) {
      throw new AppError('The wallet selection changed during export.', 403, 'WALLET_STATEMENT_SCOPE_CHANGED');
    }
  };
  const amount = minor => (minor / factor(currency)).toFixed(Math.log10(factor(currency)));
  const line = async values => {
    await assertAccess();
    if (response.destroyed) throw new AppError('Statement connection closed.', 499, 'EXPORT_CLOSED');
    if (!response.write(values.map(csvCell).join(',') + '\r\n')) await drain(response);
  };
  await assertAccess();
  response.set({ 'Cache-Control': 'private, no-store', 'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="classic-wallet-${country}-${currency}.csv"`, 'X-Robots-Tag': 'noindex, nofollow, noarchive' });
  await line(['Date (UTC)', 'Type', 'Reference', 'Description', 'Debit', 'Credit', 'Balance', 'Currency', 'Country']);
  await line([from.toISOString(), 'opening_balance', '', 'Opening balance', '', '', amount(balance), currency, country]);
  if (owned) {
    const cursor = LedgerTransaction.find(mongoose.trusted({ ...owned, postedAt: { $gte: from, $lt: until } })).sort({ postedAt: 1, _id: 1 }).lean().cursor({ batchSize: 100 });
    try {
      for await (const row of cursor) {
        const entries = row.entries.filter(entry => String(entry.accountId) === String(account._id));
        const debit = entries.reduce((sum, entry) => sum + entry.debitMinor, 0), credit = entries.reduce((sum, entry) => sum + entry.creditMinor, 0);
        balance += credit - debit; count++;
        await line([new Date(row.postedAt).toISOString(), row.referenceType, row.referencePublicId, row.description, amount(debit), amount(credit), amount(balance), currency, country]);
      }
    } finally { await cursor.close(); }
  }
  await line([until.toISOString(), 'closing_balance', '', 'Closing balance', '', '', amount(balance), currency, country]);
  await writeAudit(request, 'customer.wallet_statement_exported', { targetType: 'user', targetPublicId: actor.publicId, country,
    metadata: { currency, rows: count, from: from.toISOString(), until: until.toISOString() } });
  response.end();
}
