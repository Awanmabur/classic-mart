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
function payoutFunction(name) {
  const start = payments.indexOf('export async function ' + name + '(');
  assert.ok(start >= 0, name + ' must remain an exported payout operation.');
  const end = payments.indexOf('\nexport ', start + 1);
  return payments.slice(start, end < 0 ? undefined : end);
}

test('payout submission uses an atomic approved-to-submitting claim with a frozen attempt id', () => {
  const submit = payoutFunction('submitPayout');
  assert.match(submit, /return payoutTransaction\(async session=>/);
  assert.match(submit, /guardedPayout\(request,payout,session\)/);
  assert.match(submit, /findOneAndUpdate\(\s*\{publicId:payoutPublicId,status:'approved',approvedByUserId:\{\$ne:request\.user\._id\},__v:payout\.__v\|\|0\}/s);
  assert.match(submit, /\$set:\{status:'submitting'/);
  assert.match(submit, /\$inc:\{__v:1\}/);
  assert.match(submit, /\{returnDocument:'after',session\}/);
  assert.match(submit, /submissionAttemptId=crypto\.randomUUID\(\)/);
  assert.match(submit, /PAYOUT_SUBMISSION_CLAIMED/);
  assert.match(payoutModel, /submissionStartedAt:Date/);
  assert.match(payoutModel, /submissionAttemptId:\{type:String,maxlength:80,index:true\}/);
});

test('manual external handoff has explicit confirm and UNKNOWN transitions', () => {
  const confirmation = payoutFunction('confirmPayoutSubmission'), unknown = payoutFunction('markPayoutUnknown');
  for (const operation of [confirmation, unknown]) {
    assert.match(operation, /return payoutTransaction\(async session=>/);
    assert.match(operation, /Payout\.findOne\([\s\S]*?\.session\(session\)/);
    assert.match(operation, /payoutVersion\(payout,version\);payoutAttempt\(payout,submissionAttemptId\)/);
    assert.match(operation, /guardedPayout\(request,payout,session\)/);
    assert.match(operation, /await payout\.save\(\{session\}\)/);
  }
  assert.match(confirmation, /String\(payout\.submittedByUserId\)!==String\(access\.actor\._id\)/);
  assert.match(confirmation, /PAYOUT_SUBMITTER_REQUIRED/);
  assert.match(confirmation, /PAYOUT_REFERENCE_FROZEN/);
  assert.match(confirmation, /payout\.status='submitted';payout\.providerReference=ref;payout\.submittedAt=new Date\(\)/);
  assert.match(unknown, /independentPayoutActor\(payout,access\.actor\)/);
  assert.match(unknown, /payout\.status='unknown';payout\.unknownByUserId=access\.actor\._id;payout\.unknownAt=new Date\(\)/);
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
  assert.match(payments, /settlePromoterCommissions\(payout\.ownerUserId,payout\.amountMinor,session,\{country:account\.country,currency:payout\.currency\}\)/);
  assert.match(promoters, /settlePromoterCommissions\(userId, amountMinor, session = null, context = \{\}\)/);
  assert.match(promoters, /\.session\(session\)/);
  assert.match(promoters, /return attributionTransaction\(session, async transactionSession =>/);
  assert.match(promoters, /commission\.save\(\{ session: transactionSession \}\)/);
});

test('payout ambiguity is covered by concurrency, privacy and invariant controls', () => {
  assert.match(concurrency, /Exactly one finance operator may claim an approved payout for external submission/);
  assert.match(concurrency, /submissionAttemptId: crypto\.randomUUID\(\)/);
  assert.match(privacy, /'requested','approved','submitting','submitted','unknown'/);
  assert.match(invariants, /submissionStartedAt:\{\$lt:cutoff\}/);
  assert.match(invariants, /PAYOUT_AMBIGUOUS/);
});
