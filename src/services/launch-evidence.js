import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { z } from 'zod';
import { env } from '../config/env.js';
import { AppError } from '../core/errors.js';
import { AuditLog, LaunchEvidence } from '../models/index.js';
import { REQUIRED_LAUNCH_EVIDENCE, RECOVERY_EVIDENCE_KEYS, recoveryEvidenceIssues, satisfiesLaunchEvidence } from './launch.js';
import { authenticateOperator, authorizeOperator, fenceOperatorAuthentication } from './operator-auth.js';

const LABELS = new Map(REQUIRED_LAUNCH_EVIDENCE);
const sourceSchema = z.object({
  key: z.string().max(80),
  url: z.string().url().max(800),
  description: z.string().trim().min(20).max(1800),
  performedAt: z.string().datetime({ offset: true }),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
}).strict();
const metricsSchema = z.object({
  rpoMinutes: z.number().finite().nonnegative().optional(),
  rtoMinutes: z.number().finite().nonnegative().optional(),
  sourceSnapshotAt: z.string().datetime({ offset: true }).optional(),
  restoredAt: z.string().datetime({ offset: true }).optional(),
  drillId: z.string().trim().min(1).max(160),
  provider: z.string().trim().min(1).max(120),
  scope: z.string().trim().min(10).max(500),
}).strict();
const inputSchema = z.object({
  key: z.string().max(80),
  expectedVersion: z.number().int().nonnegative().nullable(),
  status: z.enum(['missing', 'passed', 'failed', 'not_applicable']),
  reason: z.string().trim().min(10).max(500),
  source: sourceSchema,
  validUntil: z.string().datetime({ offset: true }).optional(),
  recoveryMetrics: metricsSchema.optional(),
}).strict();
const fail = (message, code = 'LAUNCH_EVIDENCE_INVALID', status = 422) => new AppError(message, status, code);

/** A source is an operator attestation; this function never fetches or verifies its content. */
export function validateLaunchEvidence(input, { now = new Date() } = {}) {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw fail('Evidence fields do not match the required submission format.');
  const value = parsed.data;
  if (!LABELS.has(value.key) || value.source.key !== value.key) throw fail('The source key must match one of the 19 required evidence keys.');
  const url = new URL(value.source.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw fail('Use a permanent HTTPS evidence URL without credentials, query strings or fragments.');
  const performedAt = new Date(value.source.performedAt);
  if (performedAt > now) throw fail('Evidence cannot describe a future exercise or review.');
  const validUntil = value.validUntil ? new Date(value.validUntil) : undefined;
  const maxAgeMs = env.disasterRecovery.evidenceMaxAgeDays * 86_400_000;
  if (value.status === 'passed' && (!validUntil || validUntil <= now || validUntil > new Date(performedAt.getTime() + maxAgeMs))) throw fail('Passed evidence needs a future validity window within the configured evidence age policy.');
  if (value.status === 'passed' && now - performedAt > maxAgeMs) throw fail('The source is older than the configured evidence age policy.');
  if (!RECOVERY_EVIDENCE_KEYS.has(value.key) && value.recoveryMetrics) throw fail('Recovery measurements belong only to recovery evidence keys.');
  const recoveryMetrics = value.recoveryMetrics ? {
    ...value.recoveryMetrics,
    ...(value.recoveryMetrics.sourceSnapshotAt ? { sourceSnapshotAt: new Date(value.recoveryMetrics.sourceSnapshotAt) } : {}),
    ...(value.recoveryMetrics.restoredAt ? { restoredAt: new Date(value.recoveryMetrics.restoredAt) } : {}),
  } : undefined;
  if (recoveryMetrics) {
    if ((recoveryMetrics.sourceSnapshotAt && recoveryMetrics.sourceSnapshotAt > performedAt) || (recoveryMetrics.restoredAt && recoveryMetrics.restoredAt > performedAt)
      || (recoveryMetrics.sourceSnapshotAt && recoveryMetrics.restoredAt && recoveryMetrics.restoredAt < recoveryMetrics.sourceSnapshotAt)) throw fail('Recovery timestamps must describe a completed, ordered exercise.');
  }
  if (RECOVERY_EVIDENCE_KEYS.has(value.key) && value.status === 'passed') {
    if (!recoveryMetrics) throw fail('Measured recovery evidence is required.');
    if (recoveryMetrics.rpoMinutes !== undefined && recoveryMetrics.rpoMinutes > env.disasterRecovery.maxRpoMinutes) throw fail('Measured RPO exceeds policy.');
    if (recoveryMetrics.rtoMinutes !== undefined && recoveryMetrics.rtoMinutes > env.disasterRecovery.maxRtoMinutes) throw fail('Measured RTO exceeds policy.');
    if (recoveryEvidenceIssues([{ key: value.key, status: value.status, verifiedAt: now, validUntil, recoveryMetrics }], now).length) throw fail('Recovery evidence is incomplete, expired or outside recovery policy.');
  }
  const evidence = JSON.stringify({ schemaVersion: 1, reason: value.reason, source: value.source,
    attestation: 'Operator-submitted evidence; source content was not fetched or independently verified by this tool.' });
  if (evidence.length > 4000) throw fail('The evidence description exceeds the stored evidence limit.');
  return { ...value, label: LABELS.get(value.key), evidence, validUntil: value.status === 'passed' ? validUntil : undefined, recoveryMetrics };
}

/** No ensure/upsert: listing must not convert unknown evidence into persisted records. */
export async function listLaunchEvidence() {
  const rows = await LaunchEvidence.find({ key: { $in: [...LABELS.keys()] } }).select('key status __v verifiedAt validUntil recoveryMetrics').lean();
  const byKey = new Map(rows.map((row) => [row.key, row]));
  return REQUIRED_LAUNCH_EVIDENCE.map(([key, label]) => {
    const row = byKey.get(key);
    return { key, label, status: row?.status || 'missing', expectedVersion: row ? row.__v || 0 : null,
      verifiedAt: row?.verifiedAt || null, validUntil: row?.validUntil || null, satisfiesStatusGate: satisfiesLaunchEvidence(row) };
  });
}

/** Explicit apply only. Actor/grant authorization, single-use MFA, CAS evidence and audit commit together. */
export async function applyLaunchEvidence(input, credentials) {
  validateLaunchEvidence(input);
  const baseline = await authenticateOperator(credentials, { roles: ['super_admin'] });
  // Concurrent creates require the schema's unique key constraint; never manufacture an unindexed gate.
  let indexes = [];
  try { indexes = await LaunchEvidence.collection.indexes(); }
  catch (error) { if (error.code !== 26) throw error; }
  if (!indexes.some((index) => index.unique && Object.keys(index.key).length === 1 && index.key.key === 1)) throw fail('Install the declared LaunchEvidence unique index before applying evidence.', 'LAUNCH_EVIDENCE_INDEX_REQUIRED', 409);
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const now = new Date();
      const value = validateLaunchEvidence(input, { now });
      const authority = await authorizeOperator(baseline, { session });
      const { actor } = authority;
      const current = await LaunchEvidence.findOne({ key: value.key }).session(session);
      if ((current ? current.__v || 0 : null) !== value.expectedVersion) throw fail('Evidence changed; list current versions before submitting again.', 'LAUNCH_EVIDENCE_CHANGED', 409);
      const proof = await fenceOperatorAuthentication(authority, { session, code: credentials.code });
      const fields = { status: value.status, evidence: value.evidence, verifiedByUserId: actor._id, verifiedAt: now,
        ...(value.validUntil ? { validUntil: value.validUntil } : {}), ...(value.recoveryMetrics ? { recoveryMetrics: value.recoveryMetrics } : {}) };
      let saved;
      if (!current) {
        [saved] = await LaunchEvidence.create([{ key: value.key, label: value.label, ...fields }], { session });
      } else {
        const unset = { ...(!value.validUntil ? { validUntil: 1 } : {}), ...(!value.recoveryMetrics ? { recoveryMetrics: 1 } : {}) };
        saved = await LaunchEvidence.findOneAndUpdate({ _id: current._id, key: value.key, __v: value.expectedVersion },
          { $set: fields, $inc: { __v: 1 }, ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { session, runValidators: true, returnDocument: 'after' });
        if (!saved) throw fail('Evidence changed during submission.', 'LAUNCH_EVIDENCE_CHANGED', 409);
      }
      await AuditLog.create([{ requestId: `launch_cli_${crypto.randomUUID()}`, actorId: actor._id, actorPublicId: actor.publicId,
        action: 'security.launch_evidence_updated', targetType: 'launch_evidence', targetPublicId: value.key, result: 'success',
        metadata: { channel: 'operator_cli', priorStatus: current?.status || 'missing', status: value.status,
          priorVersion: value.expectedVersion, version: saved.__v || 0, sourceKey: value.source.key,
          evidenceSha256: crypto.createHash('sha256').update(value.evidence).digest('hex'),
          evidence: JSON.parse(value.evidence), recoveryMetrics: value.recoveryMetrics || null, validUntil: value.validUntil || null,
          authenticationMethod: proof.method, independentVerificationPerformed: false } }], { session });
      result = { key: saved.key, status: saved.status, version: saved.__v || 0, verifiedAt: saved.verifiedAt, validUntil: saved.validUntil || null,
        satisfiesStatusGate: satisfiesLaunchEvidence(saved,now), independentVerificationPerformed: false };
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    return result;
  } finally { await session.endSession(); }
}
