# Stage 10 gate matrix — Classic AI production

Stage 10 follows the master blueprint's AI architecture while using the user-requested MongoDB/EJS stack. The original pgvector requirement is implemented as a MongoDB `AiEmbedding` collection plus bounded cosine/hybrid ranking; every semantic result is re-filtered through the authoritative country catalogue, seller verification, moderation state and live stock before display.

| Blueprint gate | Implementation | Verification |
|---|---|---|
| Provider-neutral AI gateway/model registry | `ai-provider.js` resolves enabled registry entries by purpose; provider secrets remain environment-only; disabled/unavailable providers fail honestly | Stage 10 contract + project check + MongoDB audit |
| Prompt versions, schemas, moderation, minimization | Versioned `AiPromptVersion`, Zod response schemas, local/provider moderation, bounded/minimized contexts | Stage 10 contract |
| Async seller AI jobs | MongoDB `AiJob` queue for draft/category/attributes/translation/image-quality and advisory workflows; seller approval required before product facts are applied | Stage 10 contract + maintenance registration |
| Embeddings and semantic discovery | MongoDB `AiEmbedding`, local deterministic fallback embedding and configured provider embeddings | Stage 10 contract + integration audit |
| Hybrid search / similar products | Lexical + cosine ranking followed by authoritative published/country/stock/seller filters | Stage 10 contract + integration audit |
| Recommendations | Server-side signals/ranking with hard filters and explanation metadata | Stage 10 contract + integration audit |
| Ask Classic | Narrow catalogue read tools; retrieved product IDs are allow-listed; cart changes are only proposed in `AiCartDraft` and explicitly revalidated/applied by the server | Stage 10 contract + integration audit |
| Seller/support/promoter assistants | Seller output requires seller confirmation; support reply requires human approval; promoter content requires verified promoter + approved active campaign/channel | Stage 10 contract |
| No protected AI actions | AI services expose no refund, payout, ledger posting, account enforcement or irreversible trust action | Project check + Stage 10 contract |
| Model changes are controlled | Model-registry changes use Stage 9 four-eyes `ApprovalRequest`; second Super Admin required | Stage 10 contract + integration audit |
| Evals/red-team | Seeded `stage10-core` evaluation cases cover prompt injection and hard catalogue filtering; evaluation runs are persisted | Stage 10 contract + integration audit |
| Cost/quota/failure observability | Per-user quota, daily budget, provider/model/prompt/version/latency/token/cost/failure usage records, admin observability | Stage 10 contract + integration audit |
| Visual search minimization | Uploaded query image stays in memory, deferred multipart CSRF/malware checks apply, normalized image is not persisted | Stage 10 contract |
| Honest fallback | With `AI_PROVIDER=disabled`, Ask Classic uses grounded retrieval fallback and development does not claim external generation | Stage 10 contract + integration audit |
| End-to-end release gate | Real Stage 1–10 MongoDB audit runs with external AI disabled so release verification never depends on API credits | `npm run audit:integration` |

## Cross-section commitments closed in the cumulative v2.10.0 build

The prior Stage 1–9 audit explicitly tracked two broader blueprint areas outside the numbered Stage 9 gate. They are now implemented rather than deferred:

- Business purchasing organizations, team roles/spend limits, budgets, four-eyes procurement approvals, quotations/negotiation, risk-approved invoice terms, purchase orders, recurring procurement requests and CSV statements.
- Seller growth/pricing: vouchers, bundles, quantity breaks, free shipping, sponsored disclosure, minimum/scheduled prices, consent-only follower broadcasts, business quote/PO handling and server-authoritative seller-funded checkout discounts.

These workflows are also exercised by the cumulative MongoDB audit before the AI assertions.
