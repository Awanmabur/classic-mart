# Classic Mart v2.13.6

## Storefront corrections

- Uses the supplied official Classic Mart logo throughout the storefront and printable receipt.
- Keeps the utility bar and shopping header visible while scrolling.
- Removes the CMS banner that appeared before the home hero.
- Restores the email subscription form with validation, CSRF protection, rate limiting, encrypted-at-rest email storage, and account marketing-consent synchronization.

## Product preview

- Reuses one EJS product-preview modal partial on home, catalogue, search, category, cart, wishlist, comparison, seller, promoter, and Ask Classic product links.
- Opens the same preview in the page where the product was clicked instead of navigating back to the home page.
- Quantity changes now update the original displayed price and crossed-out price; the duplicate quantity-total price block was removed.
- Preserves variants, gallery, cart, buy-now, wishlist, sharing, reviews, questions, alerts, related products, and AI enhancements.

## Search

- Adds transparent camera and microphone controls before the existing Search button without changing the search input dimensions.
- Adds browser speech-recognition search with permission/error feedback.
- Adds secure image upload search with MIME/size validation, malware scanning, CSRF validation, in-memory image processing, and live visual-match rendering.

## Verification hotfix — 2026-08-02

- Removed the remaining browser `sessionStorage` transfer used by image search.
- Image-search results now transfer through the existing encrypted server session and are consumed once by `/api/v1/storefront/visual-search-results`.
- The uploaded image is still processed in memory only and is never persisted.
- Updated regression coverage to ensure no `localStorage` or `sessionStorage` remains in storefront JavaScript.

