# Classic Mart Responsive Ecommerce Homepage

A polished ecommerce marketplace homepage built with plain HTML, CSS and JavaScript.

## Included

- Online sample product catalogue loaded from DummyJSON
- Three to five product images in every product preview
- Remote product, category, collection, testimonial and blog photography
- Remote Font Awesome SVG icons served through jsDelivr
- Six-column Trending Products and Recommended for You layouts on large screens
- Circular Shop by Category cards
- Larger, standard typography and generously rounded controls
- Rich product preview with gallery thumbnails, quantity controls, variants, seller information, specifications, buyer protection and customer reviews
- Responsive desktop, tablet and mobile layouts
- Product search suggestions, category filtering and sorting
- Wishlist and cart saved in browser `localStorage`
- Cart quantities, totals and free-shipping logic
- Demo checkout, sign-in, seller registration, support and order tracking flows
- Daily-deal countdown, newsletter validation and accessible keyboard interactions

## Run

For the best result, serve the project locally so the browser can load the online catalogue and remote images:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`.

## Online content sources

- Product catalogue and product gallery images: DummyJSON
- Curated fallback and editorial photography: Unsplash
- Interface and brand icons: Font Awesome packages delivered by jsDelivr

An internet connection is required for remote images, icons and live catalogue enhancement.

## Important

This remains a front-end implementation. Cart and wishlist data are stored in the browser. Sign-in, tracking, seller registration and checkout demonstrate the interface flow but are not connected to a production database, authentication service or payment gateway.

## New customer pages

- `login.html` — two-card customer sign-in page
- `signup.html` — two-card account creation page
- `cart.html` — full responsive shopping cart and demo checkout
- `storefront-pages.css` — shared styling for the new pages and product sharing controls
- `auth.js` — local demo authentication behaviour
- `cart-page.js` — persistent cart-page behaviour

The project remains a front-end demonstration. Authentication and checkout data are stored in the browser with localStorage; production deployment requires a secure backend, database and payment provider.

## Latest pages and flows

- `cart.html` — connected Cart, Checkout and Confirm screens with next/previous navigation
- `forgot-password.html` — email or phone account-recovery request
- `reset-password.html` — verification-code and new-password flow (`123456` is the demo code)
- `onboarding.html` — four responsive introduction screens with swipe, skip and step controls

The demo sign-in supports `demo@classicmart.test` or `+256700000000` with password `demo123`.
