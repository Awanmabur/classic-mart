# Platform guide, motion and market selection

This source update adds the requested floating voice/shopping guide, shared scroll
entrances, centered loading feedback, first-visit feedback and storefront layout
repairs. It is new implementation of the supplied requirements; it does not claim
to recover or reproduce an unavailable cloud working tree byte for byte.

## Classic guide

The shared interactive-page assets load `platform-guide.js` and its stylesheet.
Opening **Ask Classic** creates a private session and retrieves a CSRF token;
closed helpers perform no background requests. Navigation answers use maintained
application links. Product answers read the selected country's published, eligible
catalogue and show its current prices, currency and stock. Budget filtering never
silently converts another currency. Cart, account and payment actions remain on
their existing authorized pages.

Microphone use requires a click and browser permission. Transcribed questions are
reviewed before sending. Speech recognition availability depends on the browser;
typed questions remain available. Spoken replies are opt-in and stop when the
helper closes. Browser speech services may process audio externally. The helper
does not store audio or conversation history in browser storage.

**Detailed AI answer** appears when the existing provider configuration is present.
It uses the existing Ask Classic service, moderation, quota, active prompt,
country/publication rules and optional-processing policy. Configure `AI_PROVIDER`,
`AI_API_KEY`, `AI_CHAT_MODEL` and the existing active `ask_classic.v1` prompt in the
intended environment. The basic catalogue/navigation guide works without an AI
provider. Provider delivery and microphone accuracy require real-environment checks.

## Motion and feedback

Shared motion is progressive enhancement: published content is visible without
JavaScript or before it enters the viewport. Short transform/opacity entrances
cover storefront cards and dashboard panels, with bounded stagger and dynamic
content support. Reduced-motion preferences, keyboard interaction and page
visibility take priority over decoration. Native scrolling is retained.
The public service-worker cache advances to v37 so existing clients retire the
previous asset namespace. Production HTML also uses content-fingerprinted assets.

Loading feedback represents actual navigation, forms and pending requests; it
does not manufacture a completion percentage or delay fast requests. Existing
attachment/download exclusions and cancellation behavior remain applicable.

## Country and request limits

Manual shopping-country selection takes precedence over a saved shopping
preference and a verified edge estimate. The account's home country and staff
authority are retained. Product queries continue to require the selected market,
an eligible verified seller, published products and valid local-currency prices.

Set `TRUST_PROXY_CIDRS` to the actual reverse proxies allowed to supply forwarding
information. Set `GEOLOCATION_TRUSTED_PROXY_CIDRS` only to peers that overwrite
`CF-IPCountry` with their own trusted estimate. In a proxy chain, configure the
actual peer and enforce header replacement there. A country header sent directly
by an arbitrary client is ignored. Empty geolocation trust falls back to the
saved preference or launched default market. IP location is an estimate; the
visitor can always select an available country manually.

Retain the production origin shield so clients cannot bypass the trusted edge.
The numeric `TRUST_PROXY` compatibility setting must match the actual hop count;
an explicit proxy address allowlist is preferable to a public origin that trusts
arbitrary forwarding headers.

Rate limits retain their independent IP cap and add HMAC-keyed authenticated
account and verified device/server-session buckets. Changing a User-Agent or an
invented device header does not reset these counters. User-Agent remains a
supporting security signal rather than a proof of device identity. Production
counters remain shared through Redis and fail closed on storage errors.

## Canonical domain and product discovery

The production template uses `BASE_URL=https://classic-mart.com`. Configure both
`classic-mart.com` and `www.classic-mart.com` with valid HTTPS certificates and the
same application origin. The application redirects safe requests from the www
alias to the configured canonical origin. It preserves product paths and country
parameters, and never derives a redirect destination from a forwarded host.

The existing product pages render readable listing content, canonical URLs and
Product/Offer JSON-LD on the server. Published eligible listings across launched
markets appear in paginated product sitemaps, with matching prices/currencies and
country URLs. Unpublished, unauthorized and private records stay excluded.
`robots.txt` and `llms.txt` expose public discovery sources while excluding private
accounts, APIs and dashboards.

After deployment:

1. Verify the HTTPS apex and www redirect, `/robots.txt`, `/llms.txt` and
   `/sitemap.xml` on the actual deployed build.
2. Verify ownership of the domain in Google Search Console and submit
   `https://classic-mart.com/sitemap.xml`.
3. Inspect real product URLs in Search Console and Google's Rich Results Test.
   Check that listing photos and canonical country URLs are publicly reachable.
4. Check Cloudflare's bot and WAF settings: public search/AI discovery crawlers
   must be able to fetch public HTML and photographs without a browser challenge.
   Retain the origin protections and private-route authorization.

A sitemap and structured data improve discoverability and rich-result
eligibility; Google decides which URLs it indexes and displays. `llms.txt` is a
discovery aid rather than a guarantee of AI inclusion. Live production crawling,
Core Web Vitals, external provider delivery and security require deployment
evidence; local checks do not certify those outcomes.

The supplied domain has not been deployed yet. Configure hosting, certificates,
the provider credentials and the actual trusted proxy addresses before treating
these source changes as a production release.

References: [Google product structured data](https://developers.google.com/search/docs/appearance/structured-data/product),
[Google sitemaps](https://developers.google.com/search/docs/crawling-indexing/sitemaps/overview),
[browser speech recognition](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition).
