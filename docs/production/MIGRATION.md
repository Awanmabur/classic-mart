# Production Migration and Backfill

The migration is deliberately dry-run by default.

```bash
npm run migrate:plan
npm run migrate:apply
```

`migrate:apply` is idempotent and performs:
- missing customer `shoppingCountry` from the prior server-owned country;
- platform operational-country grants for legacy privileged accounts (`*` only for Super Admin);
- deterministic immutable order-line identifiers and missing delivery/return/refund counters;
- CSAT country snapshot from its original support ticket;
- HMAC proof hashes where an encrypted historical OTP can still be safely decrypted;
- immutable historical payment/refund financial documents;
- creation of declared MongoDB indexes without dropping unknown indexes.

### Historical provider data
Do **not** rewrite historical Flutterwave/other-provider payment records into Pesapal merely to satisfy a current provider enum. Historical financial provenance must remain truthful. Current new online payment creation uses Pesapal only. If old records need reporting, query them as legacy history and migrate only through a separately reviewed accounting reconciliation plan.

### Order-line inference
For old delivered orders without line counters, delivered quantity is initialized to purchased quantity only when the root order is already authoritatively delivered. Otherwise it stays zero. Return/refund counters are never guessed from money alone.

### Failed OTP backfill
If encrypted historical proof material cannot be decrypted, migration reports the failure rather than inventing a verifier. Rotate/reissue proof for any still-active shipment using an operator-controlled recovery procedure.
