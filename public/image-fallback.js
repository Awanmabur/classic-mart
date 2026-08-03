(() => {
  'use strict';

  function fallbackFor(image) {
    if (!(image instanceof HTMLImageElement)) return;
    if (image.dataset.classicMartImageFallback === 'true') return;
    image.dataset.classicMartImageFallback = 'true';
    image.removeAttribute('srcset');
    image.src = image.closest(
      '.product-card, .catalog-product-card, .wishlist-card, .profile-product, .person-card',
    )
      ? '/assets/product-placeholder.svg'
      : '/assets/image-placeholder.svg';
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
