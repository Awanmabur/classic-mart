(() => {
  'use strict';

  const qs = (selector, root = document) => root.querySelector(selector);
  const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];


  const ICON_SOURCE_PATTERN = /(?:api\.iconify\.design\/(?:fa6-solid|fa6-regular|fa6-brands)|free-(?:solid|regular|brands)-svg-icons)/i;

  function fallbackIconPath(source) {
    const cleanSource = String(source || '').split('?')[0];
    const fileName = cleanSource.slice(cleanSource.lastIndexOf('/') + 1) || 'circle.svg';
    if (/fa6-regular\/heart\.svg/i.test(cleanSource)) return 'assets/icons/heart-regular.svg';
    return `assets/icons/${fileName}`;
  }

  function repairImage(image) {
    if (!(image instanceof HTMLImageElement) || image.dataset.fallbackComplete === 'true') return;
    const source = image.currentSrc || image.src || '';

    if (ICON_SOURCE_PATTERN.test(source)) {
      image.dataset.fallbackComplete = 'true';
      image.src = fallbackIconPath(source);
      return;
    }

    if (!image.hasAttribute('onerror') && !source.includes('/assets/')) {
      image.dataset.fallbackComplete = 'true';
      image.src = 'assets/image-placeholder.svg';
    }
  }

  function installImageFallbacks() {
    document.addEventListener('error', event => {
      if (event.target instanceof HTMLImageElement) repairImage(event.target);
    }, true);

    qsa('img').forEach(image => {
      if (image.complete && image.naturalWidth === 0) repairImage(image);
    });
  }

  const categories = [
    { id: 'electronics', name: 'Electronics', image: 'https://images.unsplash.com/photo-1498049794561-7780e7231661?auto=format&fit=crop&w=1000&q=86' },
    { id: 'fashion', name: 'Fashion', image: 'https://images.unsplash.com/photo-1445205170230-053b83016050?auto=format&fit=crop&w=1000&q=86' },
    { id: 'home', name: 'Home & Kitchen', image: 'https://images.unsplash.com/photo-1556911220-bff31c812dba?auto=format&fit=crop&w=1000&q=86' },
    { id: 'beauty', name: 'Beauty & Health', image: 'https://images.unsplash.com/photo-1596462502278-27bfdc403348?auto=format&fit=crop&w=1000&q=86' },
    { id: 'sports', name: 'Sports & Outdoors', image: 'https://images.unsplash.com/photo-1517836357463-d25dfeac3438?auto=format&fit=crop&w=1000&q=86' },
    { id: 'toys', name: 'Toys & Games', image: 'https://images.unsplash.com/photo-1594787318286-3d835c1d207f?auto=format&fit=crop&w=1000&q=86' },
    { id: 'automotive', name: 'Automotive', image: 'https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=1000&q=86' },
    { id: 'grocery', name: 'Groceries', image: 'https://images.unsplash.com/photo-1542838132-92c53300491e?auto=format&fit=crop&w=1000&q=86' },
    { id: 'books', name: 'Books & Stationery', image: 'https://images.unsplash.com/photo-1495446815901-a7297e633e8d?auto=format&fit=crop&w=1000&q=86' },
    { id: 'pets', name: 'Pet Supplies', image: 'https://images.unsplash.com/photo-1552053831-71594a27632d?auto=format&fit=crop&w=1000&q=86' }
  ];

  let products = [
    { id: 1, name: 'Wireless Earbuds', subtitle: 'Premium Sound', category: 'electronics', brand: 'Apple', image: 'https://images.unsplash.com/photo-1606220945770-b5b6c2c55bf1?auto=format&fit=crop&w=1000&q=86', price: 29.99, oldPrice: 64.99, rating: 4.8, reviews: 4820, badge: 'Best Seller', badgeTone: 'orange', stock: 54, sold: 684, description: 'Compact true-wireless earbuds with clear calls, rich sound and a pocket charging case.' },
    { id: 2, name: 'Travel Backpack', subtitle: 'Water Resistant', category: 'fashion', brand: 'Nike', image: 'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=1000&q=86', price: 39.99, oldPrice: 49.99, rating: 4.7, reviews: 2140, badge: '20% Off', badgeTone: 'red', stock: 31, sold: 341, description: 'A durable travel backpack with organized storage, padded straps and water-resistant fabric.' },
    { id: 3, name: 'Smart Watch', subtitle: 'Fitness Tracker', category: 'electronics', brand: 'Samsung', image: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=1000&q=86', price: 89.99, oldPrice: 129.99, rating: 4.9, reviews: 3410, badge: 'New Arrival', badgeTone: 'teal', stock: 67, sold: 497, description: 'Track workouts, heart rate, sleep and notifications on a bright, responsive display.' },
    { id: 4, name: 'Portable Blender', subtitle: 'USB Rechargeable', category: 'home', brand: 'Philips', image: 'https://images.unsplash.com/photo-1556911220-bff31c812dba?auto=format&fit=crop&w=1000&q=86', price: 25.49, oldPrice: 29.99, rating: 4.5, reviews: 1230, badge: '15% Off', badgeTone: 'red', stock: 44, sold: 312, description: 'Blend smoothies and shakes anywhere with a rechargeable motor and easy-clean cup.' },
    { id: 5, name: "Men's Sneakers", subtitle: 'Comfort & Style', category: 'fashion', brand: 'Nike', image: 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=1000&q=86', price: 49.99, oldPrice: 79.99, rating: 4.8, reviews: 2740, badge: 'Best Seller', badgeTone: 'orange', stock: 38, sold: 512, description: 'Lightweight everyday sneakers with cushioned support and a flexible non-slip sole.' },
    { id: 6, name: 'Luxury Perfume', subtitle: 'Long Lasting', category: 'beauty', brand: 'Levi\'s', image: 'https://images.unsplash.com/photo-1541643600914-78b084683601?auto=format&fit=crop&w=1000&q=86', price: 36.99, oldPrice: 64.99, rating: 4.6, reviews: 2410, badge: 'New', badgeTone: 'green', stock: 22, sold: 288, description: 'A refined fragrance with bright top notes, a warm floral heart and a smooth finish.' },
    { id: 7, name: 'Non-Stick Cookware', subtitle: '10-Piece Set', category: 'home', brand: 'Philips', image: 'https://images.unsplash.com/photo-1584990347449-a4ecad58a21d?auto=format&fit=crop&w=1000&q=86', price: 79.99, oldPrice: 99.99, rating: 4.7, reviews: 3720, badge: '20% Off', badgeTone: 'red', stock: 18, sold: 193, description: 'A versatile cookware set with even heat distribution and durable non-stick coating.' },
    { id: 8, name: 'Hydration Bottle', subtitle: 'Smart Temperature Display', category: 'sports', brand: 'Adidas', image: 'https://images.unsplash.com/photo-1602143407151-7111542de6e8?auto=format&fit=crop&w=1000&q=86', price: 22.99, oldPrice: 31.99, rating: 4.5, reviews: 760, badge: 'Popular', badgeTone: 'teal', stock: 82, sold: 156, description: 'Double-wall insulated bottle with a digital temperature display and leak-proof lid.' },
    { id: 9, name: 'Coffee Maker', subtitle: 'Programmable Brew', category: 'home', brand: 'Philips', image: 'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&w=1000&q=86', price: 59.99, oldPrice: 79.99, rating: 4.8, reviews: 980, badge: '25% Off', badgeTone: 'red', stock: 26, sold: 169, description: 'Programmable coffee maker with reusable filter, keep-warm plate and simple controls.' },
    { id: 10, name: 'Noise Cancelling Headphones', subtitle: 'Studio Wireless', category: 'electronics', brand: 'Sony', image: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=1000&q=86', price: 89.99, oldPrice: 149.99, rating: 4.9, reviews: 4130, badge: '40% Off', badgeTone: 'red', stock: 43, sold: 312, description: 'Immersive over-ear headphones with active noise cancellation and soft ear cushions.' },
    { id: 11, name: 'Bluetooth Speaker', subtitle: 'Portable Bass', category: 'electronics', brand: 'Sony', image: 'https://images.unsplash.com/photo-1608043152269-423dbba4e7e1?auto=format&fit=crop&w=1000&q=86', price: 25.99, oldPrice: 39.99, rating: 4.6, reviews: 1720, badge: '35% Off', badgeTone: 'red', stock: 71, sold: 205, description: 'Compact wireless speaker with punchy bass, clear calls and splash resistance.' },
    { id: 12, name: 'LED Desk Lamp', subtitle: 'Touch Control', category: 'home', brand: 'Philips', image: 'https://images.unsplash.com/photo-1507473885765-e6ed057f782c?auto=format&fit=crop&w=1000&q=86', price: 19.99, oldPrice: 24.99, rating: 4.5, reviews: 540, badge: '20% Off', badgeTone: 'red', stock: 61, sold: 168, description: 'Adjustable LED desk lamp with touch dimming, a flexible neck and low-energy lighting.' },
    { id: 13, name: 'Robot Vacuum Cleaner', subtitle: 'Smart Navigation', category: 'home', brand: 'Samsung', image: 'https://images.unsplash.com/photo-1558317374-067fb5f30001?auto=format&fit=crop&w=1000&q=86', price: 139.99, oldPrice: 199.99, rating: 4.8, reviews: 960, badge: '30% Off', badgeTone: 'red', stock: 14, sold: 256, description: 'Automatic vacuum with smart route planning, edge cleaning and scheduled operation.' },
    { id: 14, name: 'Smartphone 128GB', subtitle: 'All-Day Battery', category: 'electronics', brand: 'Apple', image: 'https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?auto=format&fit=crop&w=1000&q=86', price: 299.99, oldPrice: 349.99, rating: 4.7, reviews: 2440, badge: 'New Arrival', badgeTone: 'teal', stock: 35, sold: 418, description: 'A bright full-screen smartphone with dependable performance, strong cameras and all-day battery.' },
    { id: 15, name: 'Daily Skincare Cream', subtitle: 'Hydrating Formula', category: 'beauty', brand: 'Canon', image: 'https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=1000&q=86', price: 18.99, oldPrice: 24.99, rating: 4.6, reviews: 840, badge: '25% Off', badgeTone: 'red', stock: 89, sold: 233, description: 'Lightweight daily moisturiser formulated to hydrate and support a soft, comfortable skin feel.' },
    { id: 16, name: 'Classic Wrist Watch', subtitle: 'Stainless Steel', category: 'fashion', brand: 'Samsung', image: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=1000&q=86', price: 74.99, oldPrice: 99.99, rating: 4.8, reviews: 1310, badge: 'Best Seller', badgeTone: 'orange', stock: 29, sold: 287, description: 'A polished stainless-steel watch with chronograph detailing and a timeless black dial.' },
    { id: 17, name: 'Leather Journal', subtitle: 'Premium Notebook', category: 'books', brand: 'Levi\'s', image: 'https://images.unsplash.com/photo-1517842645767-c639042777db?auto=format&fit=crop&w=1000&q=86', price: 14.99, oldPrice: 19.99, rating: 4.7, reviews: 630, badge: 'New', badgeTone: 'green', stock: 74, sold: 148, description: 'A handsome hardcover journal with smooth pages for notes, planning and creative ideas.' },
    { id: 18, name: 'Designer Sunglasses', subtitle: 'UV400 Protection', category: 'fashion', brand: 'Nike', image: 'https://images.unsplash.com/photo-1511499767150-a48a237f0083?auto=format&fit=crop&w=1000&q=86', price: 16.99, oldPrice: 29.99, rating: 4.5, reviews: 1100, badge: '43% Off', badgeTone: 'red', stock: 55, sold: 227, description: 'Lightweight sunglasses with UV400 lenses, comfortable arms and a modern silhouette.' },
    { id: 19, name: 'City Backpack', subtitle: 'Laptop Compartment', category: 'fashion', brand: 'Adidas', image: 'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=1000&q=86', price: 34.99, oldPrice: 46.99, rating: 4.6, reviews: 890, badge: 'Popular', badgeTone: 'teal', stock: 48, sold: 194, description: 'Minimal everyday backpack with a padded laptop sleeve and easy-access front pocket.' },
    { id: 20, name: 'Modern Floor Lamp', subtitle: 'Warm Ambient Light', category: 'home', brand: 'Philips', image: 'https://images.unsplash.com/photo-1507473885765-e6ed057f782c?auto=format&fit=crop&w=1000&q=86', price: 64.99, oldPrice: 89.99, rating: 4.6, reviews: 410, badge: '28% Off', badgeTone: 'red', stock: 21, sold: 96, description: 'A slim modern floor lamp that adds soft ambient lighting to bedrooms and living spaces.' },
    { id: 21, name: 'Smart Thermostat', subtitle: 'Energy Saving', category: 'electronics', brand: 'Samsung', image: 'https://images.unsplash.com/photo-1558002038-1055907df827?auto=format&fit=crop&w=1000&q=86', price: 79.99, oldPrice: 109.99, rating: 4.7, reviews: 570, badge: '27% Off', badgeTone: 'red', stock: 19, sold: 121, description: 'Control room temperature with a clear display, schedules and energy-saving settings.' },
    { id: 22, name: "Men's Casual Shirt", subtitle: 'Soft Cotton Blend', category: 'fashion', brand: 'Levi\'s', image: 'https://images.unsplash.com/photo-1602810318383-e386cc2a3ccf?auto=format&fit=crop&w=1000&q=86', price: 24.99, oldPrice: 32.99, rating: 4.5, reviews: 1200, badge: 'Recommended', badgeTone: 'teal', stock: 64, sold: 284, description: 'A versatile casual shirt with a soft feel, clean lines and easy everyday styling.' },
    { id: 23, name: 'Throw Pillow Set', subtitle: 'Two-Piece Decor', category: 'home', brand: 'Philips', image: 'https://images.unsplash.com/photo-1584100936595-c0654b55a2e2?auto=format&fit=crop&w=1000&q=86', price: 19.99, oldPrice: 27.99, rating: 4.4, reviews: 850, badge: 'Home Pick', badgeTone: 'green', stock: 77, sold: 189, description: 'Decorative throw pillows that add texture and comfort to sofas, beds and reading corners.' },
    { id: 24, name: 'Professional Hair Dryer', subtitle: 'Fast Drying', category: 'beauty', brand: 'Philips', image: 'https://images.unsplash.com/photo-1522338140262-f46f5913618a?auto=format&fit=crop&w=1000&q=86', price: 39.99, oldPrice: 54.99, rating: 4.7, reviews: 980, badge: 'Popular', badgeTone: 'orange', stock: 33, sold: 216, description: 'Fast-drying hair dryer with multiple heat settings and a focused styling nozzle.' },
    { id: 25, name: 'Yoga Mat', subtitle: 'Non-Slip Surface', category: 'sports', brand: 'Adidas', image: 'https://images.unsplash.com/photo-1601925260368-ae2f83cf8b7f?auto=format&fit=crop&w=1000&q=86', price: 22.99, oldPrice: 29.99, rating: 4.6, reviews: 630, badge: 'Fitness Pick', badgeTone: 'green', stock: 92, sold: 175, description: 'A cushioned non-slip mat for yoga, stretching and home workouts.' },
    { id: 26, name: "Women's Handbag", subtitle: 'Classic Everyday Style', category: 'fashion', brand: 'Levi\'s', image: 'https://images.unsplash.com/photo-1584917865442-de89df76afd3?auto=format&fit=crop&w=1000&q=86', price: 34.99, oldPrice: 48.99, rating: 4.7, reviews: 760, badge: 'New', badgeTone: 'teal', stock: 39, sold: 166, description: 'A structured everyday handbag with roomy compartments and comfortable handles.' },
    { id: 27, name: 'Spiral Notebook', subtitle: 'Hard Cover', category: 'books', brand: 'Canon', image: 'https://images.unsplash.com/photo-1531346680769-a1d79b57de5c?auto=format&fit=crop&w=1000&q=86', price: 8.99, oldPrice: 12.99, rating: 4.4, reviews: 380, badge: 'School Pick', badgeTone: 'green', stock: 120, sold: 304, description: 'A durable spiral notebook with clean ruled pages for study, work and daily planning.' },
    { id: 28, name: 'Premium Keychain', subtitle: 'Decorative Metal', category: 'automotive', brand: 'Sony', image: 'https://images.unsplash.com/photo-1528698827591-e19ccd7bc23d?auto=format&fit=crop&w=1000&q=86', price: 9.99, oldPrice: 14.99, rating: 4.3, reviews: 240, badge: '33% Off', badgeTone: 'red', stock: 102, sold: 131, description: 'A detailed metal keychain with a sturdy ring for keys, bags and accessories.' },
    { id: 29, name: 'Executive Pen', subtitle: 'Smooth Ink', category: 'books', brand: 'Canon', image: 'https://images.unsplash.com/photo-1455390582262-044cdead277a?auto=format&fit=crop&w=1000&q=86', price: 11.99, oldPrice: 16.99, rating: 4.6, reviews: 340, badge: 'Office Pick', badgeTone: 'teal', stock: 93, sold: 153, description: 'A balanced executive pen with smooth-flowing ink and a polished metal finish.' },
    { id: 30, name: 'Studio Headphones', subtitle: 'Balanced Audio', category: 'electronics', brand: 'Sony', image: 'https://images.unsplash.com/photo-1484704849700-f032a568e944?auto=format&fit=crop&w=1000&q=86', price: 69.99, oldPrice: 89.99, rating: 4.8, reviews: 1520, badge: '22% Off', badgeTone: 'red', stock: 46, sold: 279, description: 'Comfortable studio-style headphones with balanced sound and an adjustable headband.' }
  ];


  const ONLINE_IMAGE_POOLS = {
    electronics: [
      'https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?auto=format&fit=crop&w=1000&q=86',
      'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=1000&q=86',
      'https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=1000&q=86',
      'https://images.unsplash.com/photo-1498049794561-7780e7231661?auto=format&fit=crop&w=1000&q=86'
    ],
    fashion: [
      'https://images.unsplash.com/photo-1445205170230-053b83016050?auto=format&fit=crop&w=1000&q=86',
      'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?auto=format&fit=crop&w=1000&q=86',
      'https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=1000&q=86',
      'https://images.unsplash.com/photo-1483985988355-763728e1935b?auto=format&fit=crop&w=1000&q=86'
    ],
    home: [
      'https://images.unsplash.com/photo-1556911220-bff31c812dba?auto=format&fit=crop&w=1000&q=86',
      'https://images.unsplash.com/photo-1600566753190-17f0baa2a6c3?auto=format&fit=crop&w=1000&q=86',
      'https://images.unsplash.com/photo-1616486338812-3dadae4b4ace?auto=format&fit=crop&w=1000&q=86',
      'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?auto=format&fit=crop&w=1000&q=86'
    ],
    beauty: [
      'https://images.unsplash.com/photo-1596462502278-27bfdc403348?auto=format&fit=crop&w=1000&q=86',
      'https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=1000&q=86',
      'https://images.unsplash.com/photo-1522335789203-aabd1fc54bc9?auto=format&fit=crop&w=1000&q=86',
      'https://images.unsplash.com/photo-1512496015851-a90fb38ba796?auto=format&fit=crop&w=1000&q=86'
    ],
    sports: [
      'https://images.unsplash.com/photo-1517836357463-d25dfeac3438?auto=format&fit=crop&w=1000&q=86',
      'https://images.unsplash.com/photo-1538805060514-97d9cc17730c?auto=format&fit=crop&w=1000&q=86',
      'https://images.unsplash.com/photo-1546483875-ad9014c88eba?auto=format&fit=crop&w=1000&q=86',
      'https://images.unsplash.com/photo-1571019613454-1cb2f99b2d8b?auto=format&fit=crop&w=1000&q=86'
    ],
    toys: [
      'https://images.unsplash.com/photo-1594787318286-3d835c1d207f?auto=format&fit=crop&w=1000&q=86',
      'https://images.unsplash.com/photo-1618842676088-c4d48a6a7c9c?auto=format&fit=crop&w=1000&q=86',
      'https://images.unsplash.com/photo-1560961911-ba7ef651a56c?auto=format&fit=crop&w=1000&q=86',
      'https://images.unsplash.com/photo-1599443015574-be5fe8a05783?auto=format&fit=crop&w=1000&q=86'
    ],
    automotive: [
      'https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=1000&q=86',
      'https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?auto=format&fit=crop&w=1000&q=86',
      'https://images.unsplash.com/photo-1494905998402-395d579af36f?auto=format&fit=crop&w=1000&q=86',
      'https://images.unsplash.com/photo-1542362567-b07e54358753?auto=format&fit=crop&w=1000&q=86'
    ],
    grocery: [
      'https://images.unsplash.com/photo-1542838132-92c53300491e?auto=format&fit=crop&w=1000&q=86',
      'https://images.unsplash.com/photo-1543168256-418811576931?auto=format&fit=crop&w=1000&q=86',
      'https://images.unsplash.com/photo-1488459716781-31db52582fe9?auto=format&fit=crop&w=1000&q=86',
      'https://images.unsplash.com/photo-1506617420156-8e4536971650?auto=format&fit=crop&w=1000&q=86'
    ],
    books: [
      'https://images.unsplash.com/photo-1495446815901-a7297e633e8d?auto=format&fit=crop&w=1000&q=86',
      'https://images.unsplash.com/photo-1512820790803-83ca734da794?auto=format&fit=crop&w=1000&q=86',
      'https://images.unsplash.com/photo-1526243741027-444d633d7365?auto=format&fit=crop&w=1000&q=86',
      'https://images.unsplash.com/photo-1516979187457-637abb4f9353?auto=format&fit=crop&w=1000&q=86'
    ],
    pets: [
      'https://images.unsplash.com/photo-1552053831-71594a27632d?auto=format&fit=crop&w=1000&q=86',
      'https://images.unsplash.com/photo-1517849845537-4d257902454a?auto=format&fit=crop&w=1000&q=86',
      'https://images.unsplash.com/photo-1450778869180-41d0601e046e?auto=format&fit=crop&w=1000&q=86',
      'https://images.unsplash.com/photo-1543852786-1cf6624b9987?auto=format&fit=crop&w=1000&q=86'
    ]
  };

  function rotatedPool(category, index = 0) {
    const pool = ONLINE_IMAGE_POOLS[category] || ONLINE_IMAGE_POOLS.electronics;
    return [...pool.slice(index % pool.length), ...pool.slice(0, index % pool.length)].slice(0, 4);
  }

  function ensureProductImages(product, index = 0) {
    const pool = rotatedPool(product.category, index);
    const images = [...new Set([...(product.images || []), product.image, ...pool].filter(Boolean))].slice(0, 5);
    product.images = images.length >= 3 ? images : [...images, ...pool].slice(0, 3);
    product.image = product.images[0];
    product.sku ||= `SH-${String(product.id).padStart(4, '0')}`;
    product.warrantyInformation ||= '12-month seller warranty';
    product.shippingInformation ||= 'Dispatches within 1–2 business days';
    product.returnPolicy ||= '30-day return protection';
    product.availabilityStatus ||= product.stock > 12 ? 'In stock' : 'Limited stock';
    product.weight ||= `${1 + (index % 4)}.${index % 9} kg`;
    product.minimumOrderQuantity ||= 1;
    product.reviewItems ||= [
      { rating: 5, reviewerName: 'Verified buyer', comment: 'Excellent quality, carefully packed and exactly as shown.' },
      { rating: 4, reviewerName: 'Classic Mart customer', comment: 'Good value and delivery updates were clear from checkout to arrival.' }
    ];
    return product;
  }

  products.forEach(ensureProductImages);

  function mapRemoteCategory(category = '') {
    if (['beauty', 'fragrances', 'skin-care'].includes(category)) return 'beauty';
    if (['smartphones', 'laptops', 'tablets', 'mobile-accessories'].includes(category)) return 'electronics';
    if (['mens-shirts', 'mens-shoes', 'mens-watches', 'womens-bags', 'womens-dresses', 'womens-jewellery', 'womens-shoes', 'womens-watches', 'tops', 'sunglasses'].includes(category)) return 'fashion';
    if (['furniture', 'home-decoration', 'kitchen-accessories'].includes(category)) return 'home';
    if (category === 'groceries') return 'grocery';
    if (category === 'sports-accessories') return 'sports';
    if (['vehicle', 'motorcycle'].includes(category)) return 'automotive';
    return 'home';
  }

  function remoteBadge(item) {
    const discount = Number(item.discountPercentage) || 0;
    if (discount >= 18) return { text: `${Math.round(discount)}% Off`, tone: 'red' };
    if ((Number(item.rating) || 0) >= 4.7) return { text: 'Top Rated', tone: 'orange' };
    return { text: 'New Arrival', tone: 'teal' };
  }

  function normalizeRemoteProduct(item, index) {
    const category = mapRemoteCategory(item.category);
    const badge = remoteBadge(item);
    const price = Number(item.price) || 19.99;
    const discount = Math.min(70, Math.max(5, Number(item.discountPercentage) || 12));
    const remoteImages = [...new Set([item.thumbnail, ...(item.images || [])].filter(Boolean))];
    return ensureProductImages({
      id: index + 1,
      remoteId: item.id,
      name: item.title || `Classic Mart Product ${index + 1}`,
      subtitle: String(item.category || category).replaceAll('-', ' ').replace(/\b\w/g, value => value.toUpperCase()),
      category,
      brand: item.brand || 'Classic Mart Select',
      image: remoteImages[0],
      images: remoteImages,
      price,
      oldPrice: Number((price / (1 - discount / 100)).toFixed(2)),
      rating: Math.min(5, Math.max(3.8, Number(item.rating) || 4.5)),
      reviews: Math.max(86, (item.reviews?.length || 2) * 417 + (item.id || index) * 9),
      badge: badge.text,
      badgeTone: badge.tone,
      stock: Number(item.stock) || 24,
      sold: Math.max(54, ((item.id || index) * 37) % 690),
      description: item.description || 'A carefully selected product with verified details and buyer-friendly protection.',
      sku: item.sku,
      warrantyInformation: item.warrantyInformation,
      shippingInformation: item.shippingInformation,
      returnPolicy: item.returnPolicy,
      availabilityStatus: item.availabilityStatus,
      dimensions: item.dimensions,
      weight: item.weight ? `${item.weight} kg` : undefined,
      minimumOrderQuantity: item.minimumOrderQuantity,
      reviewItems: item.reviews || [],
      tags: item.tags || []
    }, index);
  }

  async function hydrateOnlineCatalog() {
    try {
      const response = await fetch('https://dummyjson.com/products?limit=100', { cache: 'force-cache' });
      if (!response.ok) throw new Error(`Catalogue request failed with ${response.status}`);
      const payload = await response.json();
      if (!Array.isArray(payload.products) || payload.products.length < 12) throw new Error('Catalogue did not return enough products');
      products = payload.products.slice(0, 30).map(normalizeRemoteProduct);
      state.filteredProducts = products.slice(0, 12);
      renderTrending(state.filteredProducts);
      renderDeals();
      renderRecommended();
      renderBestSellers();
      renderBudgetPicks();
      renderFreshFinds();
      updateCartUI();
    } catch (error) {
      console.warn('Using the curated online fallback catalogue:', error);
    }
  }

  const bridgePrefix = 'classic-mart-state:';

  const state = {
    cart: window.ClassicMartCart ? window.ClassicMartCart.asLegacyCart() : safeRead('shophub-cart', {}),
    wishlist: safeRead('shophub-wishlist', []),
    heroIndex: 0,
    heroTimer: null,
    filteredProducts: products.slice(),
    lastFocused: null,
    deepLinkOpened: false
  };

  function bridgeState() {
    try {
      if (!window.name || !window.name.startsWith(bridgePrefix)) return {};
      return JSON.parse(window.name.slice(bridgePrefix.length)) || {};
    } catch { return {}; }
  }

  function safeRead(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      if (value) return JSON.parse(value);
    } catch { /* use the same-tab bridge below */ }
    const bridge = bridgeState();
    return Object.prototype.hasOwnProperty.call(bridge, key) ? bridge[key] : fallback;
  }

  function safeWrite(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage may be blocked for local files */ }
    try {
      const bridge = bridgeState();
      bridge[key] = value;
      window.name = bridgePrefix + JSON.stringify(bridge);
    } catch { /* the in-memory state still keeps the current page functional */ }
  }

  function rememberCartProduct(product) {
    if (!product) return;
    const saved = safeRead('classic-mart-cart-products', {});
    saved[product.id] = {
      id: product.id,
      name: product.name,
      subtitle: product.subtitle,
      category: product.category,
      brand: product.brand,
      image: product.image,
      images: product.images,
      price: product.price,
      oldPrice: product.oldPrice,
      rating: product.rating,
      reviews: product.reviews,
      stock: product.stock,
      shippingInformation: product.shippingInformation
    };
    safeWrite('classic-mart-cart-products', saved);
  }

  function cartTransferUrl() {
    if (window.ClassicMartCart) return window.ClassicMartCart.cartUrl();
    const snapshots = safeRead('classic-mart-cart-products', {});
    const items = Object.entries(state.cart).map(([id, quantity]) => {
      const source = snapshots[id] || snapshots[Number(id)] || productById(id) || null;
      const product = source ? {
        id: Number(source.id || id), name: source.name, subtitle: source.subtitle, category: source.category,
        brand: source.brand, image: source.image, price: source.price, oldPrice: source.oldPrice,
        rating: source.rating, reviews: source.reviews, stock: source.stock,
        shippingInformation: source.shippingInformation
      } : null;
      return { id: Number(id), quantity: Number(quantity) || 0, product };
    }).filter(item => item.quantity > 0);
    if (!items.length) return 'cart.html';
    const params = new URLSearchParams();
    params.set('cartData', JSON.stringify({ items }));
    return `cart.html?${params.toString()}`;
  }

  function money(value) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
  }

  function reviewCount(value) {
    if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}K`;
    return String(value);
  }

  function starMarkup(rating) {
    const rounded = Math.round(rating);
    return `${'★'.repeat(rounded)}${'☆'.repeat(5 - rounded)}`;
  }

  function compactRatingMarkup(product) {
    return `<span class="rating-star" aria-hidden="true">★</span><strong>${Number(product.rating).toFixed(1)}</strong><span>(${reviewCount(product.reviews)})</span>`;
  }

  function productById(id) {
    return products.find(product => product.id === Number(id));
  }

  function imageWithFallback(image, alt, className = '') {
    return `<img class="${className}" src="${image}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="if(!this.dataset.remoteFallback){this.dataset.remoteFallback='true';this.src='https://dummyjson.com/image/900x900/f3f4f6/172033?text=Image+Unavailable';}else{this.onerror=null;this.src='assets/product-placeholder.svg';}">`;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function badgeClass(product) {
    return `badge-${product.badgeTone || 'orange'}`;
  }

  function promoAmount(price) {
    return money(Number(price || 0) * 0.03);
  }

  document.querySelectorAll('[data-wishlist-count]').forEach(badge => { badge.textContent = String(state.wishlist.length); });

  function wishlistIcon(wished) {
    return wished
      ? 'https://api.iconify.design/fa6-solid/heart.svg'
      : 'https://api.iconify.design/fa6-regular/heart.svg';
  }

  function categoryLabel(category = '') {
    const labels = {
      electronics: 'Electronics',
      fashion: 'Fashion',
      home: 'Home & Kitchen',
      beauty: 'Beauty & Health',
      sports: 'Sports',
      toys: 'Toys & Games',
      automotive: 'Automotive',
      books: 'Books',
      pets: 'Pet Supplies',
      grocery: 'Groceries'
    };
    return labels[category] || String(category).replaceAll('-', ' ').replace(/\b\w/g, character => character.toUpperCase());
  }

  function productCard(product) {
    const wished = state.wishlist.includes(product.id);
    return `
      <article class="product-card" data-product-preview="${product.id}" data-product-id="${product.id}" data-category="${product.category}" data-brand="${escapeHtml(product.brand)}" data-price="${product.price}" data-rating="${product.rating}" tabindex="0" role="button" aria-label="Open ${escapeHtml(product.name)} preview">
        <div class="product-image">
          <span class="product-badge ${badgeClass(product)}">${escapeHtml(product.badge)}</span>
          ${imageWithFallback(product.image, product.name)}
          <span class="category-badge">${escapeHtml(categoryLabel(product.category))}</span>
          <span class="promoter-badge" title="Promo amount is 3% of the final price">Promo ${promoAmount(product.price)}</span>
          <button class="wishlist-button ${wished ? 'active' : ''}" data-wishlist="${product.id}" type="button" aria-pressed="${wished}" aria-label="${wished ? 'Remove from' : 'Add to'} wishlist">
            <img src="${wishlistIcon(wished)}" alt="">
          </button>
        </div>
        <div class="product-info">
          <h3>${escapeHtml(product.name)}</h3>
          <div class="product-meta-row">
            <div class="price"><strong>${money(product.price)}</strong><del>${money(product.oldPrice)}</del></div>
            <div class="rating" aria-label="${product.rating} out of 5 stars">${compactRatingMarkup(product)}</div>
          </div>
          <button class="add-cart" data-add-cart="${product.id}" type="button">Add to cart</button>
        </div>
      </article>`;
  }

  function compactProductCard(product) {
    const discount = Math.round((1 - product.price / product.oldPrice) * 100);
    return `
      <article class="compact-product" data-product-preview="${product.id}" data-product-id="${product.id}" tabindex="0" role="button" aria-label="Open ${escapeHtml(product.name)} preview">
        <div class="compact-image">
          <span class="deal-badge">${discount}% Off</span>
          ${imageWithFallback(product.image, product.name)}
          <span class="category-badge">${escapeHtml(categoryLabel(product.category))}</span>
          <span class="promoter-badge" title="Promo amount is 3% of the final price">Promo ${promoAmount(product.price)}</span>
        </div>
        <h3>${escapeHtml(product.name)}</h3>
        <div class="product-meta-row">
          <div class="price"><strong>${money(product.price)}</strong><del>${money(product.oldPrice)}</del></div>
          <div class="rating" aria-label="${product.rating} out of 5 stars">${compactRatingMarkup(product)}</div>
        </div>
        <div class="sold">Sold: ${product.sold}</div>
        <button class="compact-add" data-add-cart="${product.id}" type="button">Add to cart</button>
      </article>`;
  }

  function recommendCard(product) {
    return `
      <article class="recommend-card" data-product-preview="${product.id}" tabindex="0" role="button" aria-label="Open ${escapeHtml(product.name)} preview">
        <div class="recommend-image">${imageWithFallback(product.image, product.name)}<span class="category-badge">${escapeHtml(categoryLabel(product.category))}</span><span class="promoter-badge" title="Promo amount is 3% of the final price">Promo ${promoAmount(product.price)}</span></div>
        <div><h3>${escapeHtml(product.name)}</h3><div class="product-meta-row"><div class="price"><strong>${money(product.price)}</strong></div><div class="rating" aria-label="${product.rating} out of 5 stars">${compactRatingMarkup(product)}</div></div></div>
      </article>`;
  }

  function miniProductCard(product, index) {
    return `
      <article class="mini-product-card ${index >= 3 ? 'mobile-extra-card' : ''}" data-product-preview="${product.id}" tabindex="0" role="button" aria-label="Open ${escapeHtml(product.name)} preview">
        <div class="mini-product-image">
          ${imageWithFallback(product.image, product.name)}
          <span class="category-badge">${escapeHtml(categoryLabel(product.category))}</span>
          <span class="promoter-badge" title="Promo amount is 3% of the final price">Promo ${promoAmount(product.price)}</span>
        </div>
        <h3>${escapeHtml(product.name)}</h3>
        <div class="mini-card-footer"><strong>${money(product.price)}</strong><span>${product.rating.toFixed(1)} ★</span></div>
      </article>`;
  }

  function renderCategories() {
    const target = qs('#categoryRow');
    if (!target) return;
    target.innerHTML = categories.map(category => `
      <button class="category-card" data-category-jump="${category.id}" type="button">
        <span class="category-image">${imageWithFallback(category.image, category.name)}</span>
        <span>${escapeHtml(category.name)}</span>
      </button>`).join('');
  }

  function renderTrending(list = products.slice(0, 12)) {
    const target = qs('#trendingGrid');
    if (!target) return;
    target.innerHTML = list.length
      ? list.map(productCard).join('')
      : '<div class="product-search-empty"><strong>No matching products</strong><span>Try another product name, brand, or category.</span></div>';
  }

  function renderDeals() {
    const target = qs('#dealGrid');
    if (!target) return;
    const dealProducts = products.slice().sort((a, b) => ((b.oldPrice - b.price) / b.oldPrice) - ((a.oldPrice - a.price) / a.oldPrice)).slice(0, 12);
    target.innerHTML = dealProducts.map(compactProductCard).join('');
  }

  function renderRecommended() {
    const target = qs('#recommendGrid');
    if (!target) return;
    const recommended = products.slice().sort((a, b) => b.rating - a.rating || b.reviews - a.reviews).slice(0, 12);
    target.innerHTML = recommended.map(recommendCard).join('');
    qsa('.recommend-card', target).forEach(card => card.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openProductModal(card.dataset.productPreview);
      }
    }));
  }


  function renderBestSellers() {
    const target = qs('#bestSellerGrid');
    if (!target) return;
    const bestSellers = products.slice().sort((a, b) => b.sold - a.sold || b.reviews - a.reviews).slice(0, 12);
    target.innerHTML = bestSellers.map(productCard).join('');
  }

  function renderBudgetPicks() {
    const target = qs('#budgetGrid');
    if (!target) return;
    let budgetProducts = products.filter(product => product.price <= 50).sort((a, b) => b.rating - a.rating || a.price - b.price);
    if (budgetProducts.length < 6) budgetProducts = products.slice().sort((a, b) => a.price - b.price);
    target.innerHTML = budgetProducts.slice(0, 12).map(productCard).join('');
  }

  function renderFreshFinds() {
    const target = qs('#freshFindsGrid');
    if (!target) return;
    const freshProducts = products.slice().sort((a, b) => (b.remoteId || b.id) - (a.remoteId || a.id)).slice(0, 6);
    target.innerHTML = freshProducts.map(miniProductCard).join('');
    qsa('.mini-product-card', target).forEach(card => card.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openProductModal(card.dataset.productPreview);
      }
    }));
  }

  function showToast(message) {
    const toast = qs('#toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), 2200);
  }

  async function copyShareLink(value) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch { /* use the compatible fallback below */ }

    const helper = document.createElement('textarea');
    helper.value = value;
    helper.setAttribute('readonly', '');
    helper.style.position = 'fixed';
    helper.style.left = '-9999px';
    helper.style.opacity = '0';
    document.body.appendChild(helper);
    helper.select();
    helper.setSelectionRange(0, helper.value.length);
    let copied = false;
    try { copied = document.execCommand('copy'); } catch { copied = false; }
    helper.remove();
    return copied;
  }

  function addToCart(id, quantity = 1) {
    const product = productById(id);
    if (!product) return [];
    let savedItems = [];
    if (window.ClassicMartCart) {
      savedItems = window.ClassicMartCart.add(product, quantity);
      state.cart = window.ClassicMartCart.asLegacyCart();
      window.ClassicMartCart.decorateLinks();
    } else {
      const current = Number(state.cart[product.id]) || 0;
      state.cart[product.id] = Math.min(current + quantity, 99);
      safeWrite('shophub-cart', state.cart);
      rememberCartProduct(product);
    }
    updateCartUI();
    showToast(`${product.name} added to your cart`);
    return savedItems;
  }

  function updateCartQuantity(id, nextQuantity) {
    if (window.ClassicMartCart) {
      window.ClassicMartCart.setQuantity(id, nextQuantity);
      state.cart = window.ClassicMartCart.asLegacyCart();
    } else {
      if (nextQuantity <= 0) delete state.cart[id];
      else state.cart[id] = Math.min(nextQuantity, 99);
      safeWrite('shophub-cart', state.cart);
    }
    updateCartUI();
  }

  function removeFromCart(id) {
    const product = productById(id);
    if (window.ClassicMartCart) {
      window.ClassicMartCart.remove(id);
      state.cart = window.ClassicMartCart.asLegacyCart();
    } else {
      delete state.cart[id];
      safeWrite('shophub-cart', state.cart);
    }
    updateCartUI();
    showToast(product ? `${product.name} removed` : 'Item removed');
  }

  function cartEntries() {
    return Object.entries(state.cart)
      .map(([id, quantity]) => ({ product: productById(id), quantity: Number(quantity) }))
      .filter(entry => entry.product && entry.quantity > 0);
  }

  function updateCartUI() {
    const totalItems = window.ClassicMartCart
      ? window.ClassicMartCart.count()
      : cartEntries().reduce((sum, entry) => sum + entry.quantity, 0);
    const cartCount = qs('#cartCount');
    if (cartCount) cartCount.textContent = totalItems;
    window.ClassicMartCart?.decorateLinks();
  }

  function openCart() {
    closeAllModals();
    if (window.ClassicMartCart) window.ClassicMartCart.navigate();
    else window.location.href = cartTransferUrl();
  }

  function closeCart() {
    const drawer = qs('#cartDrawer');
    const backdrop = qs('#drawerBackdrop');
    if (!drawer) return;
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    backdrop?.classList.remove('show');
    if (backdrop) setTimeout(() => { backdrop.hidden = true; }, 250);
    document.body.classList.remove('no-scroll');
  }

  function toggleWishlist(id) {
    const numericId = Number(id);
    const index = state.wishlist.indexOf(numericId);
    const product = productById(numericId);
    if (index >= 0) {
      state.wishlist.splice(index, 1);
      showToast(`${product?.name || 'Product'} removed from wishlist`);
    } else {
      state.wishlist.push(numericId);
      showToast(`${product?.name || 'Product'} saved to wishlist`);
    }
    safeWrite('shophub-wishlist', state.wishlist);
    document.querySelectorAll('[data-wishlist-count]').forEach(badge => { badge.textContent = String(state.wishlist.length); });
    renderTrending(state.filteredProducts);
    renderBestSellers();
    renderBudgetPicks();
  }

  function openProductModal(id) {
    const product = productById(id);
    if (!product) return;
    const wished = state.wishlist.includes(product.id);
    const images = (product.images || [product.image]).slice(0, 5);
    const discount = Math.max(0, Math.round((1 - product.price / product.oldPrice) * 100));
    const reviewItems = (product.reviewItems || []).slice(0, 4);
    const dimensions = product.dimensions
      ? `${product.dimensions.width || '—'} × ${product.dimensions.height || '—'} × ${product.dimensions.depth || '—'} cm`
      : 'See packaging details';
    const shareUrlObject = new URL(window.location.href);
    shareUrlObject.searchParams.set('product', product.id);
    shareUrlObject.hash = 'trending';
    const shareUrl = shareUrlObject.toString();
    const whatsappText = `Hello Classic Mart, I am interested in ${product.name} (${money(product.price)}). ${shareUrl}`;
    const whatsappUrl = `https://wa.me/256781977217?text=${encodeURIComponent(whatsappText)}`;
    const topShare = qs('#productModalShare');
    const topWishlist = qs('#productModalWishlist');
    if (topShare) {
      topShare.dataset.shareProduct = product.id;
      topShare.dataset.shareUrl = shareUrl;
    }
    const shareMenu = qs('#productShareMenu');
    const shareCopy = qs('#productShareCopy');
    const shareWhatsApp = qs('#productShareWhatsApp');
    if (shareMenu) shareMenu.hidden = true;
    if (topShare) topShare.setAttribute('aria-expanded', 'false');
    if (shareCopy) shareCopy.dataset.shareUrl = shareUrl;
    if (shareWhatsApp) shareWhatsApp.href = `https://wa.me/?text=${encodeURIComponent(`Take a look at ${product.name} on Classic Mart. ${shareUrl}`)}`;
    if (topWishlist) {
      topWishlist.dataset.wishlist = product.id;
      topWishlist.classList.toggle('active', wished);
      topWishlist.setAttribute('aria-pressed', String(wished));
      const icon = topWishlist.querySelector('img');
      if (icon) icon.src = wishlistIcon(wished);
    }

    const reviewMarkup = reviewItems.length ? reviewItems.map((review, index) => `
      <article class="preview-review">
        <div class="review-avatar">${escapeHtml((review.reviewerName || 'V').charAt(0).toUpperCase())}</div>
        <div class="review-content">
          <div class="review-head"><div><strong>${escapeHtml(review.reviewerName || 'Verified buyer')}</strong><small>Verified purchase</small></div><span aria-label="${Number(review.rating) || 5} out of 5 stars">${starMarkup(Number(review.rating) || 5)}</span></div>
          <p>${escapeHtml(review.comment || 'A reliable product and a smooth buying experience.')}</p>
          <div class="review-meta"><span>${index % 2 ? '2 weeks ago' : 'Recently reviewed'}</span><button type="button" data-helpful-review>Helpful <b>${8 + index * 7}</b></button></div>
        </div>
      </article>`).join('') : '<p class="empty-preview-copy">Customer feedback will appear here after verified purchases.</p>';

    const ratingRows = [
      { stars: 5, value: Math.min(92, Math.max(62, Math.round(product.rating * 16))) },
      { stars: 4, value: 16 },
      { stars: 3, value: 8 },
      { stars: 2, value: 4 },
      { stars: 1, value: 2 }
    ].map(row => `<div class="rating-breakdown-row"><span>${row.stars} ★</span><i><b style="width:${row.value}%"></b></i><small>${row.value}%</small></div>`).join('');

    const tagMarkup = (product.tags || [product.category, 'quality checked', 'buyer protected']).slice(0, 4)
      .map(tag => `<span>${escapeHtml(String(tag).replaceAll('-', ' '))}</span>`).join('');

    const relatedProducts = products
      .filter(item => item.id !== product.id)
      .sort((a, b) => {
        const categoryDifference = Number(b.category === product.category) - Number(a.category === product.category);
        if (categoryDifference) return categoryDifference;
        const brandDifference = Number(b.brand === product.brand) - Number(a.brand === product.brand);
        if (brandDifference) return brandDifference;
        return b.rating - a.rating || b.sold - a.sold;
      })
      .slice(0, 5);

    const relatedMarkup = relatedProducts.map(item => `
      <article class="preview-related-card" data-product-preview="${item.id}" tabindex="0" role="button" aria-label="Open ${escapeHtml(item.name)} preview">
        <div class="preview-related-image">${imageWithFallback(item.image, item.name)}</div>
        <div class="preview-related-copy">
          <h4>${escapeHtml(item.name)}</h4>
          <div><strong>${money(item.price)}</strong><span>${item.rating.toFixed(1)} ★</span></div>
          <button type="button" data-add-cart="${item.id}">Add to cart</button>
        </div>
      </article>`).join('');

    qs('#productModalContent').innerHTML = `
      <div class="product-preview">
        <nav class="preview-breadcrumb" aria-label="Breadcrumb"><a href="index.html">Home</a><b>›</b><a href="products.html?category=${encodeURIComponent(product.category)}">${escapeHtml(categoryLabel(product.category))}</a><b>›</b><strong>${escapeHtml(product.name)}</strong></nav>

        <div class="product-preview-main">
          <div class="product-gallery">
            <div class="gallery-main"><img id="previewMainImage" src="${images[0]}" alt="${escapeHtml(product.name)}" referrerpolicy="no-referrer"></div>
            <div class="gallery-thumbnails" aria-label="Product images">
              ${images.map((image, imageIndex) => `<button class="gallery-thumb ${imageIndex === 0 ? 'active' : ''}" data-gallery-thumb="${image}" type="button" aria-label="View image ${imageIndex + 1}"><img src="${image}" alt="${escapeHtml(product.name)} view ${imageIndex + 1}" loading="lazy" referrerpolicy="no-referrer"></button>`).join('')}
            </div>
          </div>

          <div class="product-modal-copy">
            <div class="preview-badges"><span class="product-badge ${badgeClass(product)}">${escapeHtml(product.badge)}</span><span class="verified-badge"><img src="assets/icons/circle-check.svg" alt=""> Verified listing</span></div>
            <h2 id="productModalTitle">${escapeHtml(product.name)}</h2>

            <div class="preview-price-row"><strong>${money(product.price)}</strong><del>${money(product.oldPrice)}</del>${discount ? `<span>Save ${discount}%</span>` : ''}</div>
            <div class="preview-payment-note"><img src="assets/icons/credit-card.svg" alt=""><span>Pay securely at checkout. Taxes and delivery are calculated before confirmation.</span></div>
            <p class="preview-description" id="productModalDescription">${escapeHtml(product.description)}</p>

            <div class="preview-stock-line"><span class="stock-dot"></span><strong>${escapeHtml(product.availabilityStatus)}</strong><span>${product.stock} units ready to order</span><span class="preview-sku">SKU: ${escapeHtml(product.sku)}</span></div>

            <div class="preview-choice-grid">
              <div class="preview-option-block">
                <div class="preview-option-heading"><span>Choose option</span></div>
                <div class="preview-option-row">
                  <div class="option-chips"><button class="active" type="button" data-preview-option>Standard</button><button type="button" data-preview-option>Premium</button><button type="button" data-preview-option>Gift-ready</button></div>
                  <div class="modal-quantity" aria-label="Quantity"><button data-modal-qty-minus type="button" aria-label="Decrease quantity">−</button><strong id="modalQuantity">1</strong><button data-modal-qty-plus type="button" aria-label="Increase quantity">+</button></div>
                </div>
              </div>
            </div>

            <div class="preview-purchase-actions" aria-label="Purchase actions">
              <button class="button button-primary preview-cart-button" data-modal-add-cart="${product.id}" type="button"><img src="assets/icons/cart-plus.svg" alt=""> Add to Cart</button>
              <button class="buy-now-button" data-buy-now="${product.id}" type="button">Buy Now</button>
              <a class="preview-whatsapp-button" href="${whatsappUrl}" target="_blank" rel="noopener noreferrer" aria-label="Chat about this product on WhatsApp"><img class="whatsapp-logo" src="assets/icons/whatsapp.svg" alt=""><strong>WhatsApp</strong></a>
            </div>
          </div>
        </div>

        <section class="preview-information-grid" aria-label="Shopping information">
          <article><img src="assets/icons/rotate-left.svg" alt=""><div><strong>Returns</strong><small>Eligible items can be returned within 7 days</small></div></article>
          <article><img src="assets/icons/circle-check.svg" alt=""><div><strong>Warranty</strong><small>${escapeHtml(product.warrantyInformation)}</small></div></article>
          <article><img src="assets/icons/headset.svg" alt=""><div><strong>Support</strong><small>Help before and after your purchase</small></div></article>
        </section>

        <div class="product-preview-extra">
          <section class="preview-panel preview-overview-panel">
            <div class="preview-panel-heading"><span>Overview</span><h3>Why shoppers choose it</h3></div>
            <ul>
              <li><img src="assets/icons/check.svg" alt=""> Carefully selected for quality, usability and everyday value</li>
              <li><img src="assets/icons/check.svg" alt=""> Clear inventory, delivery and return information before payment</li>
              <li><img src="assets/icons/check.svg" alt=""> Buyer protection from checkout through delivery</li>
              <li><img src="assets/icons/check.svg" alt=""> Responsive seller support and tracked fulfilment</li>
            </ul>
            <div class="preview-tag-list">${tagMarkup}</div>
          </section>
          <section class="preview-panel">
            <div class="preview-panel-heading"><span>Details</span><h3>Specifications</h3></div>
            <dl class="spec-list"><div><dt>Brand</dt><dd>${escapeHtml(product.brand)}</dd></div><div><dt>SKU</dt><dd>${escapeHtml(product.sku)}</dd></div><div><dt>Category</dt><dd>${escapeHtml(categoryLabel(product.category))}</dd></div><div><dt>Dimensions</dt><dd>${escapeHtml(dimensions)}</dd></div><div><dt>Weight</dt><dd>${escapeHtml(product.weight)}</dd></div><div><dt>Minimum order</dt><dd>${product.minimumOrderQuantity} unit</dd></div></dl>
          </section>
          <section class="preview-panel seller-panel">
            <div class="seller-logo">${escapeHtml(product.brand.charAt(0).toUpperCase())}</div><div><span>Sold by</span><h3>${escapeHtml(product.brand)}</h3><p>Verified marketplace seller with responsive support, clear policies and tracked fulfilment.</p><div><b>96% positive</b><b>Fast dispatch</b><b>Verified seller</b></div><div class="seller-panel-links"><a href="sellers.html?q=${encodeURIComponent(product.brand)}">Seller profile</a><a href="products.html?brand=${encodeURIComponent(product.brand)}">Seller products</a></div></div>
          </section>
        </div>

        <section class="preview-reviews" id="previewReviews">
          <div class="preview-section-title"><div><span>Ratings &amp; reviews</span><h3>Feedback from verified buyers</h3></div><button class="review-write-button" type="button" data-focus-review-form>Write a review</button></div>
          <div class="preview-ratings-layout">
            <aside class="rating-overview-card">
              <div class="rating-score"><strong>${product.rating.toFixed(1)}</strong><span>${starMarkup(product.rating)}</span><small>Based on ${reviewCount(product.reviews)} ratings</small></div>
              <div class="rating-breakdown">${ratingRows}</div>
              <div class="rating-highlights"><span><b>94%</b> recommend</span><span><b>4.8</b> quality</span><span><b>4.7</b> value</span></div>
            </aside>
            <div class="preview-review-list">${reviewMarkup}</div>
          </div>

          <form class="preview-review-form" id="previewReviewForm" data-product-name="${escapeHtml(product.name)}">
            <div class="review-form-heading"><div><span>Share your experience</span><h3>Write a product review</h3></div><small>Only verified purchases are published publicly.</small></div>
            <div class="review-star-input" role="radiogroup" aria-label="Your rating">
              ${[1,2,3,4,5].map(star => `<button type="button" data-review-star="${star}" aria-label="${star} star${star > 1 ? 's' : ''}">★</button>`).join('')}
              <input type="hidden" id="previewReviewRating" name="rating" value="0">
            </div>
            <div class="review-form-grid"><label>Review title<input name="title" type="text" required placeholder="Summarise your experience"></label><label>Your name<input name="name" type="text" required placeholder="Name shown with review"></label></div>
            <label>Your review<textarea name="review" rows="4" required placeholder="What did you like? How was the quality, value and delivery?"></textarea></label>
            <div class="review-form-actions"><label class="review-recommend"><input type="checkbox" name="recommend" checked><span>I recommend this product</span></label><button class="button button-primary" type="submit">Submit review</button></div>
          </form>
        </section>

        <section class="preview-related-products" aria-labelledby="previewRelatedTitle">
          <div class="preview-related-heading">
            <div><span>Recommended for you</span><h3 id="previewRelatedTitle">Other products you may like</h3></div>
            <a href="products.html?category=${encodeURIComponent(product.category)}">View all</a>
          </div>
          <div class="preview-related-grid">${relatedMarkup}</div>
        </section>
      </div>`;
    qs('#previewReviewForm')?.addEventListener('submit', event => {
      event.preventDefault();
      const rating = Number(qs('#previewReviewRating')?.value || 0);
      if (!rating) {
        showToast('Please choose a star rating');
        qs('[data-review-star]')?.focus();
        return;
      }
      const productName = event.currentTarget.dataset.productName || 'this product';
      event.currentTarget.reset();
      qsa('[data-review-star]').forEach(button => button.classList.remove('selected'));
      showToast(`Thank you. Your review for ${productName} was submitted for verification.`);
    });
    openModal('productModal');
  }

  function openModal(id) {
    closeCart();
    closeFilter();
    const modal = qs(`#${id}`);
    const backdrop = qs('#modalBackdrop');
    if (!modal || !backdrop) return;
    state.lastFocused = document.activeElement;
    qsa('.modal.open').forEach(item => {
      item.classList.remove('open');
      item.hidden = true;
    });
    modal.hidden = false;
    backdrop.hidden = false;
    document.body.classList.add('no-scroll');
    requestAnimationFrame(() => {
      backdrop.classList.add('show');
      modal.classList.add('open');
    });
    setTimeout(() => modal.querySelector('input, select, textarea, button')?.focus(), 100);
  }

  function closeAllModals() {
    const backdrop = qs('#modalBackdrop');
    const openModal = qs('.modal.open');
    if (!openModal) return;
    openModal.classList.remove('open');
    backdrop.classList.remove('show');
    setTimeout(() => {
      openModal.hidden = true;
      backdrop.hidden = true;
    }, 220);
    document.body.classList.remove('no-scroll');
    const shareMenu = qs('#productShareMenu');
    if (shareMenu) shareMenu.hidden = true;
    qs('#productModalShare')?.setAttribute('aria-expanded', 'false');
    state.lastFocused?.focus?.();
  }

  function openFilter() {
    closeCart();
    closeAllModals();
    const drawer = qs('#filterDrawer');
    const backdrop = qs('#drawerBackdrop');
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    backdrop.hidden = false;
    requestAnimationFrame(() => backdrop.classList.add('show'));
    document.body.classList.add('no-scroll');
  }

  function closeFilter() {
    const drawer = qs('#filterDrawer');
    if (!drawer?.classList.contains('open')) return;
    const backdrop = qs('#drawerBackdrop');
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    backdrop.classList.remove('show');
    setTimeout(() => { backdrop.hidden = true; }, 250);
    document.body.classList.remove('no-scroll');
  }

  function scrollToSelector(selector) {
    qs(selector)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function filterByCategory(category) {
    state.filteredProducts = category === 'all' ? products.slice() : products.filter(product => product.category === category);
    renderTrending(state.filteredProducts);
    scrollToSelector('#trending');
    const name = categories.find(item => item.id === category)?.name || 'All products';
    showToast(`${state.filteredProducts.length} ${name.toLowerCase()} item${state.filteredProducts.length === 1 ? '' : 's'}`);
    qs('#categoryPanel')?.classList.remove('open');
    qs('#menuToggle')?.setAttribute('aria-expanded', 'false');
  }

  function searchProducts(query, category = 'all') {
    const normalized = query.trim().toLowerCase();
    let result = products.filter(product => category === 'all' || product.category === category);
    if (normalized) {
      result = result.filter(product => [product.name, product.subtitle, product.category, product.brand, product.description].join(' ').toLowerCase().includes(normalized));
    }
    state.filteredProducts = result;
    renderTrending(result);
    scrollToSelector('#trending');
    showToast(result.length ? `${result.length} matching product${result.length === 1 ? '' : 's'} found` : 'No matching products found');
  }

  function matchingProducts(query, category = 'all') {
    const normalized = query.trim().toLowerCase();
    return products.filter(product => {
      const categoryMatches = category === 'all' || product.category === category;
      if (!categoryMatches) return false;
      if (!normalized) return true;
      const searchableText = [
        product.name,
        product.subtitle,
        product.category,
        categoryLabel(product.category),
        product.brand,
        product.description,
        ...(product.tags || [])
      ].join(' ').toLowerCase();
      return searchableText.includes(normalized);
    });
  }

  function applyLiveSearch() {
    const input = qs('#searchInput');
    const category = qs('#searchCategory')?.value || 'all';
    if (!input) return [];
    const value = input.value.trim();
    const matches = matchingProducts(value, category);
    const visibleProducts = value || category !== 'all' ? matches : products.slice(0, 12);
    state.filteredProducts = visibleProducts;
    renderTrending(visibleProducts);
    return matches;
  }

  function updateSearchSuggestions() {
    const input = qs('#searchInput');
    const panel = qs('#searchSuggestions');
    const category = qs('#searchCategory')?.value || 'all';
    if (!input || !panel) return;

    const value = input.value.trim();
    const matches = matchingProducts(value, category);
    const visibleProducts = value || category !== 'all' ? matches : products.slice(0, 12);
    state.filteredProducts = visibleProducts;
    renderTrending(visibleProducts);

    if (!value) {
      panel.classList.remove('show');
      panel.innerHTML = '';
      return;
    }

    const visibleMatches = matches.slice(0, 6);
    panel.innerHTML = `
      <div class="search-results-summary">
        <span><strong>${matches.length}</strong> result${matches.length === 1 ? '' : 's'} for “${escapeHtml(value)}”</span>
        <button data-search-all type="button">View filtered products</button>
      </div>
      ${visibleMatches.length ? visibleMatches.map(product => `
        <button class="search-result-option" data-suggestion="${product.id}" type="button" role="option">
          ${imageWithFallback(product.image, product.name)}
          <span><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.subtitle)} · ${escapeHtml(product.brand)}</small></span>
          <b>${money(product.price)}</b>
        </button>`).join('') : '<div class="no-suggestions">No products match your search and selected category.</div>'}`;
    panel.classList.add('show');
  }

  function goToHero(index) {
    const slides = qsa('.hero-slide');
    if (!slides.length) return;
    state.heroIndex = (index + slides.length) % slides.length;
    qs('#heroTrack').style.transform = `translateX(-${state.heroIndex * 100}%)`;
    qsa('#heroDots button').forEach((button, buttonIndex) => button.classList.toggle('active', buttonIndex === state.heroIndex));
  }

  function startHero() {
    clearInterval(state.heroTimer);
    state.heroTimer = setInterval(() => goToHero(state.heroIndex + 1), 5600);
  }

  function resetDealCountdown() {
    const now = Date.now();
    let stored = 0;
    try { stored = Number(localStorage.getItem('shophub-deal-end')) || 0; } catch { /* no-op */ }
    const end = stored > now ? stored : now + (12 * 60 * 60 + 45 * 60 + 28) * 1000;
    try { localStorage.setItem('shophub-deal-end', String(end)); } catch { /* no-op */ }
    return end;
  }

  function startCountdown() {
    let end = resetDealCountdown();
    const tick = () => {
      let remaining = Math.max(0, end - Date.now());
      if (remaining <= 0) {
        try { localStorage.removeItem('shophub-deal-end'); } catch { /* no-op */ }
        end = resetDealCountdown();
        remaining = end - Date.now();
      }
      const totalSeconds = Math.floor(remaining / 1000);
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      qs('#hours').textContent = String(hours).padStart(2, '0');
      qs('#minutes').textContent = String(minutes).padStart(2, '0');
      qs('#seconds').textContent = String(seconds).padStart(2, '0');
    };
    tick();
    setInterval(tick, 1000);
  }

  function openContent(title, html) {
    qs('#contentModalBody').innerHTML = `<h2 id="contentModalTitle">${escapeHtml(title)}</h2>${html}`;
    openModal('contentModal');
  }

  function articleContent(type) {
    const content = {
      shopping: {
        title: '10 Smart Shopping Tips to Save More Money',
        body: '<p>Build a list before you shop, compare total prices rather than headline discounts, and check return terms before paying.</p><h3>Simple habits that work</h3><ul><li>Use category filters to narrow the options.</li><li>Compare the final price after shipping.</li><li>Save products to your wishlist and review them later.</li><li>Use verified payment methods and keep your order confirmation.</li></ul>'
      },
      summer: {
        title: 'Summer Essentials You Can’t Live Without',
        body: '<p>Start with lightweight clothing, reliable hydration, sun protection and compact travel gear.</p><h3>Our practical summer checklist</h3><ul><li>Insulated water bottle</li><li>UV-protection sunglasses</li><li>Comfortable backpack</li><li>Portable speaker or headphones</li></ul>'
      },
      tech: {
        title: 'Top Tech Gadgets Coming in 2026',
        body: '<p>Shoppers are looking for devices that last longer, connect more easily and simplify everyday routines.</p><h3>What to watch</h3><ul><li>Smarter wearable health tracking</li><li>Longer battery life</li><li>Energy-saving home controls</li><li>Better wireless audio</li></ul>'
      }
    };
    return content[type] || content.shopping;
  }

  const blogArticles = {
    shopping: { category: 'Shopping Tips', date: 'May 20, 2026', time: '5 min read', image: 'https://images.unsplash.com/photo-1483985988355-763728e1935b?auto=format&fit=crop&w=1400&q=88' },
    summer: { category: 'Lifestyle', date: 'May 18, 2026', time: '4 min read', image: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=1400&q=88' },
    tech: { category: 'New Arrivals', date: 'May 15, 2026', time: '6 min read', image: 'https://images.unsplash.com/photo-1498049794561-7780e7231661?auto=format&fit=crop&w=1400&q=88' }
  };

  function blogCardMarkup(key) {
    const item = articleContent(key);
    const meta = blogArticles[key];
    return `<article class="blog-modal-card">
      ${imageWithFallback(meta.image, item.title)}
      <div><span>${escapeHtml(meta.category)}</span><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(meta.date)} · ${escapeHtml(meta.time)}</p><button data-blog-article="${key}" type="button">Read article</button></div>
    </article>`;
  }

  function openBlogHome() {
    const content = qs('#blogModalContent');
    if (!content) return;
    const featured = articleContent('shopping');
    content.innerHTML = `<section class="blog-modal-feature">
      ${imageWithFallback(blogArticles.shopping.image, featured.title)}
      <div><span>Featured buying guide</span><h2>${escapeHtml(featured.title)}</h2><p>Practical advice for comparing prices, checking seller information and getting more value from every order.</p><button data-blog-article="shopping" type="button">Read featured article</button></div>
    </section><div class="blog-modal-grid">${['shopping','summer','tech'].map(blogCardMarkup).join('')}</div>`;
    openModal('blogModal');
  }

  function openBlogArticle(key) {
    const item = articleContent(key);
    const meta = blogArticles[key] || blogArticles.shopping;
    const content = qs('#blogModalContent');
    if (!content) return;
    content.innerHTML = `<button class="blog-back-button" data-blog-home type="button"><img src="assets/icons/chevron-left.svg" alt="">All articles</button>
      <div class="blog-article-layout"><article class="blog-article-main">
        ${imageWithFallback(meta.image, item.title)}
        <div class="article-meta"><span>${escapeHtml(meta.category)}</span><span>${escapeHtml(meta.date)}</span><span>${escapeHtml(meta.time)}</span></div>
        <h2>${escapeHtml(item.title)}</h2>${item.body}
      </article><aside class="blog-article-side"><h3>Continue reading</h3>${Object.keys(blogArticles).filter(name => name !== key).map(name => `<button data-blog-article="${name}" type="button">${escapeHtml(articleContent(name).title)}</button>`).join('')}<button data-directory-page="promoters.html" type="button">Meet featured promoters</button></aside></div>`;
    if (!qs('#blogModal.open')) openModal('blogModal');
    content.scrollTop = 0;
  }

  function installMobileSectionControls() {
    qsa('.section-next-button[data-scroll-next]').forEach(button => {
      const target = qs(`#${button.dataset.scrollNext}`);
      if (!target || target.nextElementSibling?.classList.contains('mobile-more-wrap')) return;
      const wrap = document.createElement('div');
      wrap.className = 'mobile-more-wrap';
      wrap.innerHTML = `<button class="mobile-section-more" data-scroll-next="${escapeHtml(button.dataset.scrollNext)}" type="button">More <img src="assets/icons/chevron-right.svg" alt=""></button>`;
      target.insertAdjacentElement('afterend', wrap);
    });
  }

  async function shareProductLink(button) {
    const product = productById(button?.dataset.shareProduct);
    const url = button?.dataset.shareUrl || window.location.href;
    const shareText = product
      ? `Take a look at ${product.name} on Classic Mart.`
      : 'Take a look at this product on Classic Mart.';
    const menu = qs('#productShareMenu');
    const copyButton = qs('#productShareCopy');
    const whatsappLink = qs('#productShareWhatsApp');

    if (copyButton) copyButton.dataset.shareUrl = url;
    if (whatsappLink) {
      whatsappLink.href = `https://wa.me/?text=${encodeURIComponent(`${shareText} ${url}`)}`;
    }

    // Some Android WebViews expose navigator.share but terminate it with
    // RESULT_CODE_KILLED_BAD_MESSAGE. The in-page menu is reliable in browsers,
    // installed PWAs and local-file previews, so it is now the primary flow.
    if (menu) {
      menu.hidden = !menu.hidden;
      button?.setAttribute('aria-expanded', String(!menu.hidden));
      if (!menu.hidden) setTimeout(() => whatsappLink?.focus(), 0);
      return true;
    }

    const copied = await copyShareLink(url);
    showToast(copied ? 'Product link copied — ready to share' : `Share this link: ${url}`);
    return copied;
  }

  async function handleDocumentClick(event) {
    const activeShareMenu = qs('#productShareMenu');
    if (activeShareMenu && !activeShareMenu.hidden && !event.target.closest('#productShareMenu, [data-share-product]')) {
      activeShareMenu.hidden = true;
      qs('#productModalShare')?.setAttribute('aria-expanded', 'false');
    }

    const cartLink = event.target.closest('a[href^="cart.html"]');
    if (cartLink) {
      event.preventDefault();
      window.location.href = cartTransferUrl();
      return;
    }

    const directoryPage = event.target.closest('[data-directory-page]');
    if (directoryPage) {
      window.location.href = directoryPage.dataset.directoryPage;
      return;
    }

    const promoter = event.target.closest('[data-promoter]');
    if (promoter) {
      window.location.href = `promoters.html?q=${encodeURIComponent(promoter.dataset.promoter)}`;
      return;
    }

    if (event.target.closest('[data-blog-home]')) {
      openBlogHome();
      return;
    }

    const blogArticle = event.target.closest('[data-blog-article]');
    if (blogArticle) {
      openBlogArticle(blogArticle.dataset.blogArticle);
      return;
    }

    const sectionNext = event.target.closest('[data-scroll-next]');
    if (sectionNext) {
      const target = qs(`#${sectionNext.dataset.scrollNext}`);
      if (!target) return;
      const firstItem = target.firstElementChild;
      const styles = getComputedStyle(target);
      const gap = parseFloat(styles.columnGap || styles.gap || 0) || 0;
      const step = firstItem ? firstItem.getBoundingClientRect().width + gap : Math.max(260, target.clientWidth * .8);
      const maxScroll = Math.max(0, target.scrollWidth - target.clientWidth);
      if (maxScroll > 4) {
        const nextLeft = target.scrollLeft + Math.max(step, target.clientWidth * .72);
        target.scrollTo({ left: nextLeft >= maxScroll - 4 ? 0 : nextLeft, behavior: 'smooth' });
      } else if (firstItem && target.children.length > 1) {
        target.appendChild(firstItem);
        target.animate([{ opacity: .76, transform: 'translateX(8px)' }, { opacity: 1, transform: 'translateX(0)' }], { duration: 220, easing: 'ease-out' });
      }
      return;
    }

    const galleryThumb = event.target.closest('[data-gallery-thumb]');
    if (galleryThumb) {
      const mainImage = qs('#previewMainImage');
      if (mainImage) mainImage.src = galleryThumb.dataset.galleryThumb;
      qsa('.gallery-thumb').forEach(button => button.classList.toggle('active', button === galleryThumb));
      return;
    }

    if (event.target.closest('[data-modal-qty-minus]')) {
      const quantity = qs('#modalQuantity');
      if (quantity) quantity.textContent = Math.max(1, Number(quantity.textContent) - 1);
      return;
    }

    if (event.target.closest('[data-modal-qty-plus]')) {
      const quantity = qs('#modalQuantity');
      if (quantity) quantity.textContent = Math.min(20, Number(quantity.textContent) + 1);
      return;
    }

    const previewReviewLink = event.target.closest('[data-scroll-preview-reviews]');
    if (previewReviewLink) {
      qs('#previewReviews')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    const previewOption = event.target.closest('[data-preview-option]');
    if (previewOption) {
      qsa('[data-preview-option]', previewOption.closest('.option-chips')).forEach(button => button.classList.toggle('active', button === previewOption));
      return;
    }

    const reviewStar = event.target.closest('[data-review-star]');
    if (reviewStar) {
      const value = Number(reviewStar.dataset.reviewStar);
      const input = qs('#previewReviewRating');
      if (input) input.value = String(value);
      qsa('[data-review-star]').forEach(button => {
        const selected = Number(button.dataset.reviewStar) <= value;
        button.classList.toggle('selected', selected);
        button.setAttribute('aria-checked', String(Number(button.dataset.reviewStar) === value));
      });
      return;
    }

    if (event.target.closest('[data-focus-review-form]')) {
      qs('#previewReviewForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setTimeout(() => qs('#previewReviewForm input')?.focus(), 450);
      return;
    }

    const helpful = event.target.closest('[data-helpful-review]');
    if (helpful) {
      const count = helpful.querySelector('b');
      if (!helpful.classList.contains('selected') && count) count.textContent = String(Number(count.textContent) + 1);
      helpful.classList.add('selected');
      helpful.firstChild.textContent = 'Helpful · ';
      return;
    }

    const shareButton = event.target.closest('[data-share-product]');
    if (shareButton) {
      event.preventDefault();
      event.stopPropagation();
      await shareProductLink(shareButton);
      return;
    }

    const copyButton = event.target.closest('[data-copy-product]');
    if (copyButton) {
      event.preventDefault();
      const url = copyButton.dataset.shareUrl || window.location.href;
      const copied = await copyShareLink(url);
      const menu = qs('#productShareMenu');
      if (menu) menu.hidden = true;
      qs('#productModalShare')?.setAttribute('aria-expanded', 'false');
      showToast(copied ? 'Product link copied' : `Copy this link: ${url}`);
      return;
    }

    const buyNow = event.target.closest('[data-buy-now]');
    if (buyNow) {
      const quantity = Number(qs('#modalQuantity')?.textContent || 1);
      addToCart(buyNow.dataset.buyNow, quantity);
      window.location.assign(cartTransferUrl());
      return;
    }

    const addButton = event.target.closest('[data-add-cart]');
    if (addButton) {
      addToCart(addButton.dataset.addCart);
      addButton.textContent = 'Added ✓';
      setTimeout(() => { if (document.body.contains(addButton)) addButton.textContent = 'Add to cart'; }, 1000);
      return;
    }

    const modalAdd = event.target.closest('[data-modal-add-cart]');
    if (modalAdd) {
      addToCart(modalAdd.dataset.modalAddCart, Number(qs('#modalQuantity')?.textContent || 1));
      window.location.assign(cartTransferUrl());
      return;
    }

    const wishlist = event.target.closest('[data-wishlist]');
    if (wishlist) {
      toggleWishlist(wishlist.dataset.wishlist);
      if (qs('#productModal.open')) openProductModal(wishlist.dataset.wishlist);
      return;
    }

    const productPreview = event.target.closest('[data-product-preview]');
    if (productPreview) {
      openProductModal(productPreview.dataset.productPreview);
      return;
    }

    const quickView = event.target.closest('[data-quick-view]');
    if (quickView) {
      openProductModal(quickView.dataset.quickView);
      return;
    }

    const heroViewAllCategories = event.target.closest('.hero-category-menu .view-all');
    if (heroViewAllCategories) {
      event.preventDefault();
      window.location.href = 'categories.html';
      return;
    }

    const categoryJump = event.target.closest('[data-category-jump]');
    if (categoryJump) {
      window.location.href = `products.html?category=${encodeURIComponent(categoryJump.dataset.categoryJump)}`;
      return;
    }

    const categoryButton = event.target.closest('[data-category]');
    if (categoryButton) {
      window.location.href = `products.html?category=${encodeURIComponent(categoryButton.dataset.category)}`;
      return;
    }

    const scrollButton = event.target.closest('[data-scroll]');
    if (scrollButton) {
      scrollToSelector(scrollButton.dataset.scroll);
      return;
    }

    const modalTrigger = event.target.closest('[data-open]');
    if (modalTrigger) {
      const target = modalTrigger.dataset.open;
      if (target === 'brandModal') {
        window.location.href = 'products.html?view=brands';
      } else if (target === 'blogModal') {
        openBlogHome();
      } else if (target === 'aboutModal') {
        openContent('About Classic Mart', '<p>Classic Mart is a front-end ecommerce demonstration built with responsive HTML, CSS and JavaScript. It uses an online product catalogue, remote product photography, working search, filters, wishlist, cart storage and demo checkout interactions.</p><h3>Buyer-first experience</h3><p>The design focuses on clear product discovery, mobile responsiveness and accessible controls.</p>');
      } else if (target === 'policyModal') {
        openContent('Classic Mart Policies', '<h3>Privacy</h3><p>This demonstration stores cart, wishlist and delivery-location preferences in your browser only.</p><h3>Payments</h3><p>The checkout is a demonstration and does not transmit or process real card payments.</p><h3>Returns</h3><p>Sample return messaging is included for interface demonstration.</p>');
      } else {
        openModal(target);
      }
      return;
    }

    const article = event.target.closest('[data-article]');
    if (article) {
      openBlogArticle(article.dataset.article);
      return;
    }

    const brand = event.target.closest('[data-brand]');
    if (brand) {
      window.location.href = `products.html?brand=${encodeURIComponent(brand.dataset.brand)}`;
      return;
    }

    const viewProducts = event.target.closest('[data-view-products]');
    if (viewProducts) {
      const type = viewProducts.dataset.viewProducts || 'all';
      window.location.href = `products.html?view=${encodeURIComponent(type)}`;
      return;
    }

    const freshFindsToggle = event.target.closest('[data-toggle-fresh-finds]');
    if (freshFindsToggle) {
      window.location.href = 'products.html?view=fresh';
      return;
    }

    if (event.target.closest('[data-show-all-categories]')) {
      window.location.href = 'categories.html';
      return;
    }

    if (event.target.closest('[data-search-all]')) {
      const query = qs('#searchInput')?.value.trim() || '';
      const category = qs('#searchCategory')?.value || 'all';
      const params = new URLSearchParams();
      if (query) params.set('q', query);
      if (category !== 'all') params.set('category', category);
      window.location.href = `search.html${params.toString() ? `?${params}` : ''}`;
      return;
    }

    const suggestion = event.target.closest('[data-suggestion]');
    if (suggestion) {
      qs('#searchSuggestions').classList.remove('show');
      openProductModal(suggestion.dataset.suggestion);
      return;
    }

    const minus = event.target.closest('[data-cart-minus]');
    if (minus) {
      const id = minus.dataset.cartMinus;
      updateCartQuantity(id, Number(state.cart[id]) - 1);
      return;
    }

    const plus = event.target.closest('[data-cart-plus]');
    if (plus) {
      const id = plus.dataset.cartPlus;
      updateCartQuantity(id, Number(state.cart[id]) + 1);
      return;
    }

    const remove = event.target.closest('[data-cart-remove]');
    if (remove) {
      removeFromCart(remove.dataset.cartRemove);
      return;
    }

    if (event.target.closest('[data-close-modal]')) closeAllModals();
  }

  function startPromoAnimations() {
    const cards = qsa('.promo-card');
    if (!cards.length || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const motions = ['slide-left', 'slide-right', 'slide-up', 'slide-down', 'zoom-in', 'zoom-out', 'fade'];
    const motionClasses = motions.map(motion => `promo-motion-${motion}`);

    cards.forEach((card, index) => {
      const run = () => {
        card.classList.remove(...motionClasses);
        void card.offsetWidth;
        const motion = motions[Math.floor(Math.random() * motions.length)];
        card.classList.add(`promo-motion-${motion}`);
        card.addEventListener('animationend', () => card.classList.remove(`promo-motion-${motion}`), { once: true });
        window.setTimeout(run, 3000 + Math.random() * 3200 + index * 320);
      };
      window.setTimeout(run, 1200 + index * 850 + Math.random() * 900);
    });
  }

  function bindEvents() {
    document.addEventListener('click', handleDocumentClick);

    qs('#menuToggle')?.addEventListener('click', event => {
      event.stopPropagation();
      const panel = qs('#categoryPanel');
      const open = panel.classList.toggle('open');
      event.currentTarget.setAttribute('aria-expanded', String(open));
    });

    document.addEventListener('click', event => {
      const panel = qs('#categoryPanel');
      const toggle = qs('#menuToggle');
      if (panel?.classList.contains('open') && !panel.contains(event.target) && !toggle.contains(event.target)) {
        panel.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      }
      if (!event.target.closest('.search-bar')) {
        qs('#searchSuggestions')?.classList.remove('show');
        qs('#searchInput')?.setAttribute('aria-expanded', 'false');
      }
    });

    qs('#mobileSearchButton')?.addEventListener('click', () => {
      const search = qs('#searchForm');
      search.classList.toggle('mobile-open');
      if (search.classList.contains('mobile-open')) setTimeout(() => qs('#searchInput')?.focus(), 120);
    });

    const searchInput = qs('#searchInput');
    const searchPanel = qs('#searchSuggestions');

    const refreshSearch = () => {
      updateSearchSuggestions();
      searchInput?.setAttribute('aria-expanded', String(searchPanel?.classList.contains('show')));
    };

    searchInput?.setAttribute('aria-controls', 'searchSuggestions');
    searchInput?.setAttribute('aria-expanded', 'false');
    searchInput?.addEventListener('input', refreshSearch);
    searchInput?.addEventListener('search', refreshSearch);
    searchInput?.addEventListener('focus', () => {
      if (searchInput.value.trim()) refreshSearch();
    });
    searchInput?.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        searchPanel?.classList.remove('show');
        searchInput.setAttribute('aria-expanded', 'false');
      }
    });
    qs('#searchCategory')?.addEventListener('change', () => {
      applyLiveSearch();
      if (qs('#searchInput')?.value.trim()) updateSearchSuggestions();
    });
    qs('#searchForm')?.addEventListener('submit', event => {
      event.preventDefault();
      const query = qs('#searchInput')?.value.trim() || '';
      const category = qs('#searchCategory')?.value || 'all';
      const params = new URLSearchParams();
      if (query) params.set('q', query);
      if (category !== 'all') params.set('category', category);
      window.location.href = `search.html${params.toString() ? `?${params}` : ''}`;
    });

    qsa('.slider-arrow').forEach(button => {
      button.addEventListener('click', () => {
        const target = qs(`#${button.dataset.target}`);
        if (!target) return;
        target.scrollBy({ left: (button.classList.contains('next') ? 1 : -1) * Math.max(320, target.clientWidth * .75), behavior: 'smooth' });
      });
    });

    qs('#heroPrev')?.addEventListener('click', () => { goToHero(state.heroIndex - 1); startHero(); });
    qs('#heroNext')?.addEventListener('click', () => { goToHero(state.heroIndex + 1); startHero(); });
    qsa('#heroDots button').forEach(button => button.addEventListener('click', () => { goToHero(Number(button.dataset.slide)); startHero(); }));

    let touchStart = 0;
    qs('#heroSlider')?.addEventListener('touchstart', event => { touchStart = event.touches[0].clientX; }, { passive: true });
    qs('#heroSlider')?.addEventListener('touchend', event => {
      const delta = event.changedTouches[0].clientX - touchStart;
      if (Math.abs(delta) > 45) {
        goToHero(state.heroIndex + (delta < 0 ? 1 : -1));
        startHero();
      }
    }, { passive: true });

    qs('#drawerBackdrop')?.addEventListener('click', () => { closeCart(); closeFilter(); });

    qs('#filterButton')?.addEventListener('click', openFilter);
    qs('#closeFilter')?.addEventListener('click', closeFilter);
    qs('#priceRange')?.addEventListener('input', event => { qs('#priceOutput').textContent = money(Number(event.target.value)); });
    qs('#filterForm')?.addEventListener('submit', event => {
      event.preventDefault();
      const category = new FormData(event.currentTarget).get('filterCategory');
      const maxPrice = Number(qs('#priceRange').value);
      const sort = qs('#sortSelect').value;
      let list = products.filter(product => (category === 'all' || product.category === category) && product.price <= maxPrice);
      if (sort === 'price-asc') list.sort((a, b) => a.price - b.price);
      if (sort === 'price-desc') list.sort((a, b) => b.price - a.price);
      if (sort === 'rating') list.sort((a, b) => b.rating - a.rating);
      state.filteredProducts = list;
      renderTrending(list);
      closeFilter();
      showToast(`${list.length} products match your filters`);
    });
    qs('#resetFilters')?.addEventListener('click', () => {
      qs('#filterForm').reset();
      qs('#priceRange').value = 2000;
      qs('#priceOutput').textContent = '$2,000.00';
      state.filteredProducts = products.slice();
      renderTrending(state.filteredProducts);
    });

    qs('#modalBackdrop')?.addEventListener('click', closeAllModals);

    qs('#subscribeForm')?.addEventListener('submit', event => {
      event.preventDefault();
      const email = qs('#emailInput').value.trim();
      showToast(`Thanks! Offers will be sent to ${email}`);
      event.currentTarget.reset();
    });

    qs('#loginForm')?.addEventListener('submit', event => {
      event.preventDefault();
      const email = qs('#loginEmail').value.trim();
      closeAllModals();
      showToast(`Signed in as ${email}`);
      event.currentTarget.reset();
    });
    qs('[data-demo-login]')?.addEventListener('click', () => {
      qs('#loginEmail').value = 'demo@shophub.test';
      qs('#loginPassword').value = 'demo123';
      showToast('Demo account details filled in');
    });

    qs('#locationForm')?.addEventListener('submit', event => {
      event.preventDefault();
      const location = qs('#locationInput').value.trim();
      qs('#deliveryLocation').textContent = location;
      try { localStorage.setItem('shophub-location', location); } catch { /* no-op */ }
      closeAllModals();
      showToast(`Delivery location updated to ${location}`);
    });

    qs('#trackForm')?.addEventListener('submit', event => {
      event.preventDefault();
      const order = qs('#trackInput').value.trim().toUpperCase();
      const result = qs('#trackResult');
      result.hidden = false;
      result.innerHTML = `<h3>Order ${escapeHtml(order)} is in transit</h3><p>Your demo parcel passed the regional sorting centre and is scheduled for delivery within 2–3 business days.</p>`;
    });

    ['#helpForm', '#sellerForm'].forEach(selector => qs(selector)?.addEventListener('submit', event => {
      event.preventDefault();
      const message = selector === '#helpForm' ? 'Support request received' : 'Seller application created';
      event.currentTarget.reset();
      closeAllModals();
      showToast(message);
    }));

    qs('#checkoutForm')?.addEventListener('submit', event => {
      event.preventDefault();
      const orderNumber = `SH-${Math.floor(10000 + Math.random() * 89999)}`;
      state.cart = {};
      if (window.ClassicMartCart) window.ClassicMartCart.clear();
      else safeWrite('shophub-cart', state.cart);
      updateCartUI();
      event.currentTarget.reset();
      closeAllModals();
      openContent('Order placed successfully', `<p>Your demonstration order number is <strong>${orderNumber}</strong>.</p><p>No real payment was processed. Use the Track Order form with this number to preview the tracking experience.</p>`);
    });

    qs('#languageButton')?.addEventListener('click', () => showToast('English and USD are currently selected'));

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        closeAllModals();
        closeCart();
        closeFilter();
        qs('#categoryPanel')?.classList.remove('open');
        return;
      }

      if (event.key === 'Enter' || event.key === ' ') {
        const card = event.target.closest?.('[data-product-preview]');
        const isNestedControl = event.target.closest?.('button, a, input, select, textarea') && event.target !== card;
        if (card && !isNestedControl) {
          event.preventDefault();
          openProductModal(card.dataset.productPreview);
        }
      }
    });

    const backToTop = qs('#backToTop');
    window.addEventListener('scroll', () => backToTop.classList.toggle('show', window.scrollY > 650), { passive: true });
    backToTop?.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

    qsa('a[href^="#"]').forEach(link => link.addEventListener('click', () => qs('#searchForm')?.classList.remove('mobile-open')));
  }

  function restorePreferences() {
    try {
      const location = localStorage.getItem('shophub-location');
      if (location) qs('#deliveryLocation').textContent = location;
      const session = safeRead('classic-mart-session', null);
      const accountLink = qs('.header-action-link');
      if (session?.name && accountLink) {
        const firstName = String(session.name).trim().split(/\s+/)[0];
        const greeting = accountLink.querySelector('small');
        const label = accountLink.querySelector('strong');
        if (greeting) greeting.textContent = 'Welcome back';
        if (label) label.textContent = firstName || 'Account';
      }
    } catch {
      // Storage can be unavailable in strict/private browsing contexts.
    }
  }

  function observeSections() {
    if (!('IntersectionObserver' in window)) return;
    const navLinks = qsa('.primary-nav a[href^="#"]');
    const sections = navLinks.map(link => qs(link.getAttribute('href'))).filter(Boolean);
    const observer = new IntersectionObserver(entries => {
      const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;
      navLinks.forEach(link => link.classList.toggle('active', link.getAttribute('href') === `#${visible.target.id}`));
    }, { rootMargin: '-20% 0px -65% 0px', threshold: [0, .2, .6] });
    sections.forEach(section => observer.observe(section));
  }

  function openProductFromUrl() {
    if (state.deepLinkOpened) return;
    const id = Number(new URLSearchParams(window.location.search).get('product'));
    if (!id || !productById(id)) return;
    state.deepLinkOpened = true;
    openProductModal(id);
  }

  function openRequestedContent() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('open') === 'blog') openBlogHome();
  }

  async function init() {
    installImageFallbacks();
    renderCategories();
    renderTrending(products.slice(0, 12));
    renderDeals();
    renderRecommended();
    renderBestSellers();
    renderBudgetPicks();
    renderFreshFinds();
    state.filteredProducts = products.slice(0, 12);
    updateCartUI();
    restorePreferences();
    installMobileSectionControls();
    bindEvents();
    observeSections();
    startHero();
    startPromoAnimations();
    startCountdown();
    await hydrateOnlineCatalog();
    openProductFromUrl();
    openRequestedContent();
  }

  init();
})();

/* Keep every section navigation arrow vertically aligned with the centre
   of the row it controls. This also corrects the shorter Top Brands row. */
(() => {
  const alignSectionArrows = () => {
    document.querySelectorAll('.section-next-button[data-scroll-next]').forEach((button) => {
      const targetId = button.getAttribute('data-scroll-next');
      const target = targetId ? document.getElementById(targetId) : null;
      const section = button.closest('.store-section, .daily-deals');
      if (!target || !section) return;

      const sectionRect = section.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const targetCenter = targetRect.top - sectionRect.top + (targetRect.height / 2);

      if (Number.isFinite(targetCenter) && targetCenter > 0) {
        button.style.setProperty('top', `${targetCenter}px`, 'important');
      }
    });
  };

  let resizeFrame = 0;
  const queueAlignment = () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(alignSectionArrows);
  };

  window.addEventListener('load', () => {
    queueAlignment();
    setTimeout(queueAlignment, 150);
    setTimeout(queueAlignment, 600);
  });
  window.addEventListener('resize', queueAlignment, { passive: true });

  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(queueAlignment);
    document.querySelectorAll('.horizontal-scroll, .mini-product-grid').forEach((row) => observer.observe(row));
  }

  if ('MutationObserver' in window) {
    const observer = new MutationObserver(queueAlignment);
    document.querySelectorAll('.horizontal-scroll, .mini-product-grid').forEach((row) => {
      observer.observe(row, { childList: true, subtree: false });
    });
  }

  queueAlignment();
})();
