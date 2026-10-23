# End-to-end recovery checkpoint

This is a recovery branch, not a production release. The baseline is
`ae0936589e6ef1144ef8ba5495e2d40571b52ebc` (v2.13.74). The missing working copy
has been rebuilt from the recorded remediation scope; previous lost test
results do not validate this replacement.

Current executable evidence:

- `npm run check` passed, including the new complete JavaScript syntax gate
  (721 files at that run). The earlier import-only gate missed two parse errors;
  both were repaired.
- The serialized loyalty recovery, loyalty market migration and funding unit
  suites passed **13 checks, zero failures and zero skips**. They cover immutable
  refund/chargeback lineage, debt recovery, independent provider proof,
  migration failure/retry, and exact funding/rounding conservation.
- The first funded payment test confirmed actual wallet debit, platform expense
  funding and an exact full refund inverse. Its later fixtures violated the
  existing one-store-per-owner constraint; those fixtures were corrected and
  the complete suite is being rerun.

The source checkpoint includes the restored Customer controls, private avatars
and privacy operations; dedicated Business, Delivery, Seller and Super Admin
routes; specialist referrals and buyer-consented refund proposals; typed Seller
subscriptions; and reviewed reward funding. This paragraph describes source
scope, not completed release validation. Some tests and integrations remain in
progress and must pass before merging a release.

Outstanding verification includes the full checkout, privacy, Seller,
Business, Delivery, Super Admin and aftersales journeys; canonical regression
and integration/concurrency audits; worker hooks; browser UI/layout and
accessibility checks; and final security/release checks. Provider credentials
and actual delivery/payment verification remain deployment requirements.

Keep public Business/Delivery registration gated until their release evidence
is complete. Preserve the approved public and dashboard UI throughout recovery.
