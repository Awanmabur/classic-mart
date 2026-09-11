import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();
const TRACE_ID = /^[0-9a-f]{32}$/i;
const SPAN_ID = /^[0-9a-f]{16}$/i;
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

function nonZero(value) {
  return value && !/^0+$/.test(value);
}

function randomTraceId() {
  let value = '';
  while (!nonZero(value)) value = crypto.randomBytes(16).toString('hex');
  return value;
}

function randomSpanId() {
  let value = '';
  while (!nonZero(value)) value = crypto.randomBytes(8).toString('hex');
  return value;
}

export function parseTraceparent(value = '') {
  const match = TRACEPARENT.exec(String(value || '').trim());
  if (!match) return null;
  const [, traceId, spanId, flags] = match.map((part) => part.toLowerCase());
  if (!nonZero(traceId) || !nonZero(spanId)) return null;
  return { traceId, spanId, flags };
}

export function formatTraceparent(context = storage.getStore()) {
  if (!context || !TRACE_ID.test(context.traceId || '') || !SPAN_ID.test(context.spanId || '')) return '';
  return `00-${context.traceId}-${context.spanId}-${String(context.flags || '01').toLowerCase()}`;
}

export function createTraceContext(incomingTraceparent = '') {
  const parent = parseTraceparent(incomingTraceparent);
  return {
    traceId: parent?.traceId || randomTraceId(),
    spanId: randomSpanId(),
    parentSpanId: parent?.spanId || '',
    flags: parent?.flags || '01',
  };
}

export function createChildTraceContext(parent = storage.getStore()) {
  return {
    traceId: TRACE_ID.test(parent?.traceId || '') ? String(parent.traceId).toLowerCase() : randomTraceId(),
    spanId: randomSpanId(),
    parentSpanId: SPAN_ID.test(parent?.spanId || '') ? String(parent.spanId).toLowerCase() : '',
    flags: /^[0-9a-f]{2}$/i.test(parent?.flags || '') ? String(parent.flags).toLowerCase() : '01',
  };
}

export function createStoredTraceContext({ traceId = '', spanId = '', flags = '01' } = {}) {
  const validTraceId = TRACE_ID.test(String(traceId)) && nonZero(String(traceId)) ? String(traceId).toLowerCase() : randomTraceId();
  return {
    traceId: validTraceId,
    spanId: randomSpanId(),
    parentSpanId: SPAN_ID.test(String(spanId)) && nonZero(String(spanId)) ? String(spanId).toLowerCase() : '',
    flags: /^[0-9a-f]{2}$/i.test(String(flags)) ? String(flags).toLowerCase() : '01',
  };
}

export function runWithTraceContext(context, callback) {
  return storage.run(context, callback);
}

export function runWithStoredTrace(stored, callback) {
  return storage.run(createStoredTraceContext(stored), callback);
}

export function getTraceContext() {
  return storage.getStore() || null;
}

export function currentTraceFields() {
  const context = storage.getStore();
  return context ? { traceId: context.traceId, traceSpanId: context.spanId } : { traceId: '', traceSpanId: '' };
}

export async function withTraceSpan(_name, callback) {
  const child = createChildTraceContext();
  return storage.run(child, callback);
}
