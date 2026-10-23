import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
import { env } from '../config/env.js';

const invalid = () => new AppError('This history link is invalid. Open the history again.', 422, 'CUSTOMER_HISTORY_CURSOR_INVALID');
const scope = (request, key, binding) => `${request.user._id}:${key}:${binding || ''}`;
const sign = value => crypto.createHmac('sha256', env.tokenPepper).update(value).digest('base64url');

/** Signed keysets bind tie-breakers and filters to one account and history. */
function decodeCursor(request, key, binding) {
  const value = request.query?.[key];
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 1000 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) throw invalid();
  const [body, signature] = value.split('.');
  const expected = sign(body);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw invalid();
  let parsed;
  try { parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw invalid(); }
  if (parsed.s !== scope(request, key, binding) || !/^[a-f0-9]{24}$/.test(parsed.id || '')
    || typeof parsed.at !== 'string' || !Number.isFinite(Date.parse(parsed.at))
    || new Date(parsed.at).toISOString() !== parsed.at) throw invalid();
  return { at: new Date(parsed.at), id: new mongoose.Types.ObjectId(parsed.id) };
}

export function customerHistoryWindow(request, key, { binding = '', field = 'createdAt', limit = 30 } = {}) {
  limit=Math.min(100,Math.max(1,limit));
  const cursor = decodeCursor(request, key, binding);
  const filter = cursor ? { $or: [{ [field]: mongoose.trusted({ $lt: cursor.at }) },
    { [field]: cursor.at, _id: mongoose.trusted({ $lt: cursor.id }) }] } : {};
  return {
    filter, sort: { [field]: -1, _id: -1 }, limit: Math.min(100, Math.max(1, limit)),
    finish(rows) {
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      let nextHref = '';
      if (rows.length > limit && last) {
        const body = Buffer.from(JSON.stringify({ s: scope(request, key, binding), at: new Date(last[field]).toISOString(), id: String(last._id) })).toString('base64url');
        const url = new URL(request.originalUrl || request.path || '/dashboard', 'http://localhost');
        url.searchParams.set(key, `${body}.${sign(body)}`);
        nextHref = url.pathname + url.search;
      }
      const first = new URL(request.originalUrl || request.path || '/dashboard', 'http://localhost');
      first.searchParams.delete(key);
      return { items, pagination: { nextHref, firstHref: cursor ? first.pathname + first.search : '', hasMore: Boolean(nextHref) } };
    },
  };
}

export async function customerHistoryPage(Model, filter, request, key, { select, binding = '', field = 'createdAt', limit = 30 } = {}) {
  const window = customerHistoryWindow(request, key, { binding, field, limit });
  let query = Model.find(mongoose.trusted({ $and: [filter, window.filter] }));
  if (select) query = query.select(select);
  const rows = await query.sort(window.sort).limit(window.limit + 1).lean();
  return window.finish(rows);
}
