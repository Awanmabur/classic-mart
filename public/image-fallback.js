(() => {
  'use strict';

  function fallbackFor(image) {
    if (!(image instanceof HTMLImageElement)) return;
    if (image.dataset.classicMartImageFallback === 'true') return;
    image.dataset.classicMartImageFallback = 'true';
    image.removeAttribute('srcset');
    // Rendered cards declare their fallback as inert data. Inline event handlers
    // cannot run under the current strict Content Security Policy.
    const declared = image.getAttribute('data-fallback-src');
    const fallback = declared === '/assets/product-placeholder.svg' || declared === '/assets/image-placeholder.svg'
      ? declared
      : image.closest('.product-card, .catalog-product-card, .wishlist-card, .profile-product, .person-card')
        ? '/assets/product-placeholder.svg'
        : '/assets/image-placeholder.svg';
    image.src = fallback;
  }

  document.addEventListener(
    'error',
    (event) => {
      if (event.target instanceof HTMLImageElement) fallbackFor(event.target);
    },
    true,
  );

  for (const image of document.images) {
    if (image.complete && image.naturalWidth === 0) fallbackFor(image);
  }
})();
