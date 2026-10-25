# Homepage hero content

The hero uses database records. It does not require running the development seed
or installing example marketing slides.

Published homepage content takes priority. Country Admin opens `/admin/content`,
creates a `hero` item with a key such as `home.hero.welcome`, saves its draft and
requests publication. A different authorized administrator approves the exact
revision. The current country copy overrides a global copy with the same key.
Drafts, archived content and a future first publication do not appear. A scheduled
replacement keeps the already-active revision visible until the worker publishes
the approved replacement. Super Admin can manage global content through the
Content tab of `/super/settings?tab=cms`.

Each hero revision supplies its title, plain-text body, optional image, eyebrow,
category slug and action label. Image paths use marketplace assets or media.
The category must exist in the current public catalogue to create a category
destination; otherwise the link opens the current market's product directory.
Links are rendered by the server and work before JavaScript finishes loading.

When there are no active published hero revisions, the homepage derives up to
six distinct slides from the public catalogue. Products must be available in the
current country and currency, with a positive published price and available
stock. The catalogue also enforces an active category, verified same-market
store, approved brand where applicable and required product approval. Stock must
be held in an active warehouse in that market. Images come from approved public
product media; a missing image uses the clearly generic image placeholder.
Titles and descriptions are the actual product's saved data. The action opens
that product. Long catalogue copy is visually limited to three lines so the
product link stays visible; the product page retains the complete text.
No discount, delivery promise, seller approval or inventory is
invented by the hero selector.

One eligible product or one published editorial slide is one static banner.
At least two slides enable previous/next, dots and swipe navigation, with an
automatic advance every 5.6 seconds. Automatic motion pauses during hover or
keyboard focus, when the page is hidden, and when the user requests reduced
motion. Manual controls remain available with reduced motion. An empty catalogue
shows one honest browse message without fake rotating products.

The slider's `data-hero-source` attribute identifies `cms`, `catalogue` or `empty`
for troubleshooting. The public catalogue is cached briefly; updates become
visible when its cache refreshes, while checkout always rechecks current facts.
Database/network failures are handled as service failures rather than seeded
successes. Provider configuration and database connectivity must be valid on the
machine serving the page.
