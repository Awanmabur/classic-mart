# Public keyword research

Observed on 14 October 2026 UTC. This research supplies reviewable wording for
Classic Mart's existing products. It does not establish search volumes,
frequently searched keywords, ranking positions, sales demand, or a trending
keyword list. Public autocomplete can reflect location, language, freshness,
provider filtering and other factors; its order is not a popularity ranking.

## Actual observations

The bounded CLI completed 10 requests between **2026-10-14T14:08:30.156Z** and
**2026-10-14T14:08:43.770Z**, including both robots checks. All returned HTTP 200.
It retained 73 suggestions matching starter-product nouns for editorial review.
Duplicates across providers are separate observations. This count is not a
count of customers or searches. The requested country was Uganda (`gl=ug` or
`market=en-UG`); providers are not guaranteed to honor those parameters.

| Source and observed time (UTC) | Exact observed wording worth reviewing | Catalogue connection |
| --- | --- | --- |
| [Google headphones](https://www.google.com/complete/search?client=firefox&hl=en&gl=ug&q=wireless+headphones), 14:08:31.740 | wireless headphones; wireless headphones price in uganda | Classic Wireless Headphones; show its actual current price, stock and documented specifications |
| [Google smart watch](https://www.google.com/complete/search?client=firefox&hl=en&gl=ug&q=smart+watch), 14:08:33.243 | smart watches uganda; smart watches in kampala | Classic Active Smart Watch; a Kampala suggestion does not prove Kampala delivery or availability |
| [Google backpack](https://www.google.com/complete/search?client=firefox&hl=en&gl=ug&q=city+backpack), 14:08:34.746 | city backpack | Classic City Travel Backpack; its description also documents a laptop compartment |
| [Google lamp](https://www.google.com/complete/search?client=firefox&hl=en&gl=ug&q=table+lamp), 14:08:36.255 | table lamp price in uganda; table lamps in uganda; table lamp for study | Classic Adjustable Table Lamp; its documented desk-lighting use supports a study-use description |
| [Bing headphones](https://www.bing.com/osjson.aspx?market=en-UG&query=wireless+headphones), 14:08:39.258 | wireless headphones; wireless headphones over ear | Existing over-ear headphone description; suitability for a particular device needs product evidence |
| [Bing smart watch](https://www.bing.com/osjson.aspx?market=en-UG&query=smart+watch), 14:08:40.766 | smart watch; smart watch prices | Existing smart watch; price wording must use actual published offers |
| [Bing backpack](https://www.bing.com/osjson.aspx?market=en-UG&query=city+backpack), 14:08:42.269 | city backpack | Existing backpack; suggested colors need actual variant data |
| [Bing lamp](https://www.bing.com/osjson.aspx?market=en-UG&query=table+lamp), 14:08:43.770 | table lamps; table lamp for study | Existing table lamp; do not imply a pair or a repair service |

The run also returned competitor names, other brands, foreign locations, repair
queries and feature claims such as microphones or Bluetooth. Those are
observations, not suitable additions to Classic Mart's product metadata without
independent catalogue evidence. The CLI's noun filter is deliberately only a
review aid: it can retain unsuitable suggestions, so none are auto-published.

[Google robots](https://www.google.com/robots.txt) was observed at
14:08:30.156Z and [Bing robots](https://www.bing.com/robots.txt) at
14:08:37.756Z. Their wildcard rules disallowed `/search`, so no search-results
pages were scraped. No matching disallow applied to the fixed suggestion paths
used above. Robots permission is a crawl-policy observation, not an endorsement
or a grant of rights; source terms and availability can change.

Full JSON and Markdown observations are local, ignored research artifacts:
`artifacts/seo/2026-10-14T14-08-44-003Z-UG-877443.{json,md}`. The JSON preserves
each source URL, UTC observation time, requested country, seed term, evidence
type and matched catalogue product. Generated reports are intentionally outside
application runtime data and are not included in public pages.

## Unavailable trend evidence

At **2026-10-14T13:37:47Z**, ordinary HTTPS requests for
`https://trends.google.com/robots.txt` and
`https://suggestqueries.google.com/robots.txt` failed with the environment proxy's
`tunnel connection failed: 403 Forbidden`. No payloads were obtained. The CLI
rechecked the Trends robots URL at **2026-10-14T14:11:09.059Z** and again recorded
an HTTP 403 proxy failure. It stopped before requesting
[the planned Kenya RSS feed](https://trends.google.com/trending/rss?geo=KE).
The diagnostic report is
`artifacts/seo/2026-10-14T14-11-09-109Z-KE-878311.{json,md}` (exit status 2).

Consequently this work makes **no verified trending or frequency claim**. A
future successful official Trends RSS observation can supply a dated provider
feed item, with its unmodified approximate-traffic label. That label must remain
attributed to its provider; it is not a monthly keyword-volume measurement and
does not prove relevance to this marketplace. Unrelated news must be rejected.
No environment network configuration was changed for this research.

## Reproduce a bounded review

Use the repository's Node 24 runtime; no new dependencies or credentials are
required. Run manually from the checkout:

```sh
node scripts/seo-keyword-research.js --country=UG --sources=google,bing --limit=4
node scripts/seo-keyword-research.js --country=UG --sources=google --offset=4 --limit=4
node scripts/seo-keyword-research.js --country=UG --sources=google --offset=8 --limit=4
node scripts/seo-keyword-research.js --country=KE --sources=trends --limit=1
```

`--country` accepts only configured markets UG, KE, TZ, RW and SS. A provider
may not support every market. The default is Uganda and Google autocomplete.
`--offset` selects from the 12 starter-product definitions and `--limit` allows
one to four seed queries per suggestion source. Seeds come from
`src/config/initial-catalogue.js`; the 30 category names and supported countries
come from `src/config/marketplace-reference.js`. These definitions do not prove
that a product or category is currently published, available or deliverable.
Check the approved live catalogue before adopting any wording.

The CLI writes a new timestamped JSON/Markdown pair under ignored
`artifacts/seo/`. It never updates a database, product, title, page, sitemap or
network allowlist. Exit 0 means collection completed (possibly with no relevant
matches); 2 means no relevant evidence was collected and at least one source
check was unavailable; 1 means invalid arguments or a local execution failure.
Partial failures remain visible in every report even when other sources work.

The safety bounds are fixed in code:

- Only HTTPS to the exact official hosts and research paths shown above; no
  arbitrary URL, free-form query, callback, credentials, port or output-path input.
- At most 12 requests per run, 512 KiB per response including streamed bodies,
  10 seconds per request and 90 seconds overall; at least 1.5 seconds between
  requests, with applicable crawl delays honored up to the bounded budget.
- Fetch robots first. A denial, network failure or unparseable robots document
  prevents that source's endpoint requests. A missing robots file (404/410)
  follows the standard allow policy. A delay above 10 seconds skips the source.
- Reject redirects before following them, including redirects to another allowed
  host. Stop a source after an endpoint error; do not retry a denial, change
  identity, use authenticated sessions or solve CAPTCHAs.
- Respect the environment's existing HTTPS proxy route and TLS verification.
  Do not log proxy addresses, cookies, credentials or remote error bodies.
- Reject XML entity/DTD declarations; retain only bounded, plain text fields.
  Do not follow RSS news links or suggestion links. No individual search history
  or personal account data is requested.

Refresh evidence through another intentional manual run when editorial work
needs it. The application has no crawler job, feedback loop or keyword-stuffing
mechanism. Titles and descriptions should remain readable, factual descriptions
of the public page; measured search performance requires separately authorized
first-party Search Console or equivalent reporting.
