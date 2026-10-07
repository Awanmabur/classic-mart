import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const payments = fs.readFileSync(new URL('../src/services/payments.js', import.meta.url), 'utf8');
const routes = fs.readFileSync(new URL('../src/routes/payments.js', import.meta.url), 'utf8');
const payoutModel = fs.readFileSync(new URL('../src/models/Payout.js', import.meta.url), 'utf8');
const concurrency = fs.readFileSync(new URL('../scripts/audit-concurrency.js', import.meta.url), 'utf8');
const privacy = fs.readFileSync(new URL('../src/services/privacy.js', import.meta.url), 'utf8');
const promoters = fs.readFileSync(new URL('../src/services/promoters.js', import.meta.url), 'utf8');
const invariants = fs.readFileSync(new URL('../src/services/invariants.js', import.meta.url), 'utf8');

test('payout submission uses an atomic approved-to-submitting claim with a frozen attempt id', () => {
  assert.match(payments, /findOneAndUpdate\(\s*\{publicId:payoutPublicId,status:'approved',approvedByUserId:\{\$ne:request\.user\._id\}\}/s);
  assert.match(payments, /status:'submitting'/);
  assert.match(payments, /submissionAttemptId=crypto\.randomUUID\(\)/);
  assert.match(payments, /PAYOUT_SUBMISSION_CLAIMED/);
  assert.match(payoutModel, /submissionStartedAt:Date/);
  assert.match(payoutModel, /submissionAttemptId:\{type:String,maxlength:80,index:true\}/);
});

test('manual external handoff has explicit confirm and UNKNOWN transitions', () => {
  assert.match(payments, /export async function confirmPayoutSubmission/);
  assert.match(payments, /PAYOUT_SUBMITTER_REQUIRED/);
  assert.match(payments, /status:'submitted',providerReference:ref,submittedAt:new Date\(\)/);
  assert.match(payments, /export async function markPayoutUnknown/);
  assert.match(payments, /status:'unknown',unknownByUserId:request\.user\._id,unknownAt:new Date\(\)/);
  assert.match(routes, /payouts\/:id\/submission-confirm/);
  assert.match(routes, /payouts\/:id\/unknown/);
});

test('payout rejection releases the hold only inside the state-change transaction', () => {
  assert.match(payments, /export async function rejectPayout/);
  assert.match(payments, /session\.withTransaction/);
  assert.match(payments, /releasePayoutHold\(payout,account,rejectionReason,session\)/);
  assert.match(payments, /payout\.status='rejected';payout\.failureMessage=rejectionReason;await payout\.save\(\{session\}\)/);
  assert.match(routes, /api\/v1\/finance\/payouts\/:id\/reject/);
  assert.match(concurrency, /Payout submission and rejection must be mutually exclusive decisions from the approved state/);
});

test('payout reconciliation is transaction-bound and preserves four-eyes settlement', () => {
  assert.match(payments, /const session=await mongoose\.startSession\(\)/);
  assert.match(payments, /session\.withTransaction/);
  assert.match(payments, /postLedgerTransaction\([\s\S]*?payout-paid:[\s\S]*?\},session\)/);
  assert.match(payments, /postLedgerTransaction\([\s\S]*?payout-reverse:[\s\S]*?\},session\)/);
  assert.match(payments, /settlePromoterCommissions\(payout\.ownerUserId,payout\.amountMinor,session\)/);
  assert.match(promoters, /settlePromoterCommissions\(userId, amountMinor, session = null\)/);
  assert.match(promoters, /\.session\(session\)/);
  assert.match(promoters, /commission\.save\(\{ session \}\)/);
});

test('payout ambiguity is covered by concurrency, privacy and invariant controls', () => {
  assert.match(concurrency, /Exactly one finance operator may claim an approved payout for external submission/);
  assert.match(concurrency, /submissionAttemptId: crypto\.randomUUID\(\)/);
  assert.match(privacy, /'requested','approved','submitting','submitted','unknown'/);
  assert.match(invariants, /submissionStartedAt:\{\$lt:cutoff\}/);
  assert.match(invariants, /PAYOUT_AMBIGUOUS/);
});
