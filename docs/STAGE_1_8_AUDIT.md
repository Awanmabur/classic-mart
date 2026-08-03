# Classic Mart Stage 1–8 completeness audit — v2.8.12

This audit was performed before Stage 9 because the earlier staged releases relied too heavily on contract/string checks. The supplied Classic Mart Master Blueprint remains the product/design contract, while the requested production stack is Node.js 24 + Express 5 + EJS + transaction-capable MongoDB. Redis is optional and MongoDB-backed sessions remain supported.

A workflow is no longer counted as complete merely because a page, route or model exists. The cumulative v2.8.12 release gate requires UI + route + server authorization/ownership + MongoDB state + state transition/error handling + automated checks, and adds a real disposable-database integration audit.

## Partial implementations found and corrected

- **Stage 1:** rechecked role escalation and production fail-closed settings; public onboarding cannot create privileged support/finance/admin users. Added/verified store-staff invitation and scoped capabilities.
- **Stage 2:** fixed multipart CSRF ordering that could reject legitimate KYC/product/evidence uploads before Multer exposed `_csrf`. Added damaged/quarantined/bin inventory, lot/batch/serial/expiry tracking and production malware scanning (`clamd` preferred, `clamscan` supported).
- **Stage 3:** removed browser-authoritative commerce persistence; fixed canonical product URLs, search-click analytics loop, real metrics, SKU/barcode/typo recovery, price/restock alerts, product Q&A, verified-review UI, customer↔seller messages and seller answering UI.
- **Stage 4:** replaced hard-coded delivery/tax assumptions with country settings, shipping zones and pickup points; re-quotes inside order transaction; one marketplace order now creates real per-seller orders.
- **Stage 5:** tightened Flutterwave webhook verification, added reconciliation by `tx_ref`, separated tax/platform revenue, reserved payout funds at request time, added hold release, and fixed COD refunds with a real two-finance-operator manual-disbursement/reversing-ledger flow.
- **Stage 6:** campaigns can no longer self-activate; added review/applications, approved facts/channels, UTM/sub-ID/QR, fraud/velocity controls, policy snapshots, refund reversals, payout advancement, analytics and fixed the `approved` vs actual `verified` promoter state mismatch.
- **Stage 7:** removed arbitrary shipment claiming, added expiring offers/per-seller parcels, enforced pick→pack→dispatch before pickup, made warehouse tasks execute actual inventory/parcel changes, added condition-aware returns and idempotent offline delivery queue, and connected COD reconciliation to ledger/order state.
- **Stage 8:** replaced status-only exchanges with real replacement orders/stock; replaced text-only evidence with private sanitized files; added return logistics, review disputes, knowledge/CSAT, risk signals, enforcement and customer-visible trust decisions/appeals. Support remains unable to bypass finance controls.
- **Cross-stage UI truth:** removed stale demo/fake success copy and old fake help/tracking/countdown behavior. Stage 1–8 pages are required to either perform the real workflow or show an explicit unavailable/error/empty state.
- **Late audit corrections in v2.8.2:** fixed strict-mode cart state declarations and coupon CSRF reuse; registered the real public Help/Contact support intake route; unified tracked-order grants so identity-verified guests can use receipt/payment-retry/cancellation consistently; persisted and delivery-zone-validates the home delivery-city selector; removed home modals that collected credentials/business data only to discard it; and added release-check guards for these regressions.
- **Final truthfulness sweep:** removed browser-only cart mutation fallbacks and fake newsletter/careers/app-download/social-link interactions; later-stage features now show explicit unavailable/planned states instead of collecting data or implying live integrations.

## Security and upload boundary

Uploads remain CSRF-protected. Images are malware-scanned in production and then decoded/re-encoded before storage/publication; sensitive evidence/KYC remains private. `MALWARE_SCAN_MODE=clamd` uses ClamAV's INSTREAM daemon protocol and is the recommended fast production mode. `MALWARE_SCAN_MODE=clamscan` is supported when the executable is installed. Production refuses `MALWARE_SCAN_MODE=off`; development may use it explicitly.

The application does not store payment-card PAN/CVV. Online payment uses hosted/tokenized provider entry and server verification. Financial state is expressed through immutable balanced ledger entries, not editable balances.

## Verification rule before Stage 9

`npm run release:check` now includes the real MongoDB integration audit. Stage 9 must not begin until this passes on Node 24 against the explicitly configured transaction-capable MongoDB. Docker is not required. The audit database name is required to end with `audit-test` so the script cannot target the normal development database accidentally.

## Security statement

No software can honestly be promised to have zero vulnerabilities. The target is defence in depth and no known high/critical dependency vulnerability at the checked release point. Independent penetration testing, production infrastructure review, backup/restore drills and load/failure testing remain Stage 12 launch gates.


### Phone verification hardening (v2.8.2 audit)
Protected account workspaces require both server-verified email and phone. Phone verification codes are single-use server tokens; development may use the log adapter, while production requires the configured Twilio adapter. Changing the phone number clears `phoneVerifiedAt` and requires re-verification.
