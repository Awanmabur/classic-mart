export const supportedCountries = Object.freeze([
  { code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256', taxBps: 0, platformFeeBps: 500, freeStandardShippingThresholdMinor: 200000, returnWindowDays: 30, payments: { card: true, mobile: true, cod: true }, policyVersion: '2026-07' },
  { code: 'KE', name: 'Kenya', currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi', phonePrefix: '+254', taxBps: 0, platformFeeBps: 500, freeStandardShippingThresholdMinor: 7000, returnWindowDays: 30, payments: { card: true, mobile: true, cod: true }, policyVersion: '2026-07' },
  { code: 'TZ', name: 'Tanzania', currency: 'TZS', locale: 'en-TZ', timeZone: 'Africa/Dar_es_Salaam', phonePrefix: '+255', taxBps: 0, platformFeeBps: 500, freeStandardShippingThresholdMinor: 120000, returnWindowDays: 30, payments: { card: true, mobile: true, cod: true }, policyVersion: '2026-07' },
  { code: 'RW', name: 'Rwanda', currency: 'RWF', locale: 'en-RW', timeZone: 'Africa/Kigali', phonePrefix: '+250', taxBps: 0, platformFeeBps: 500, freeStandardShippingThresholdMinor: 60000, returnWindowDays: 30, payments: { card: true, mobile: true, cod: true }, policyVersion: '2026-07' },
  { code: 'SS', name: 'South Sudan', currency: 'SSP', locale: 'en-SS', timeZone: 'Africa/Juba', phonePrefix: '+211', taxBps: 0, platformFeeBps: 500, freeStandardShippingThresholdMinor: 150000, returnWindowDays: 30, payments: { card: true, mobile: true, cod: true }, policyVersion: '2026-07' },
]);

export const marketplaceCategories = Object.freeze([
  {
    key: 'electronics',
    name: 'Electronics',
    description: 'Phones, computers, audio, accessories and smart devices.',
    attributes: [
      { key: 'model', label: 'Model', type: 'text', required: true },
      { key: 'warranty', label: 'Warranty', type: 'text', required: false },
    ],
  },
  {
    key: 'fashion',
    name: 'Fashion',
    description: 'Clothing, footwear, bags, watches and accessories.',
    attributes: [
      { key: 'size', label: 'Size', type: 'text', required: false },
      { key: 'color', label: 'Color', type: 'text', required: false },
    ],
  },
  {
    key: 'home-living',
    name: 'Home & Living',
    description: 'Furniture, lighting, decor, kitchen and household products.',
    attributes: [
      { key: 'material', label: 'Material', type: 'text', required: false },
    ],
  },
  {
    key: 'beauty',
    name: 'Beauty',
    description: 'Beauty, grooming and personal care products.',
    attributes: [],
  },
  {
    key: 'sports-fitness',
    name: 'Sports & Fitness',
    description: 'Sports, outdoor, training and fitness equipment.',
    attributes: [],
  },
  {
    key: 'automotive',
    name: 'Automotive',
    description: 'Vehicle accessories, tools and maintenance products.',
    attributes: [],
  },
  {
    key: 'books',
    name: 'Books',
    description: 'Books, learning materials and stationery.',
    attributes: [],
  },
  {
    key: 'groceries',
    name: 'Groceries',
    description: 'Packaged pantry, food and household essentials.',
    attributes: [],
  },
  {
    key: 'baby',
    name: 'Baby',
    description: 'Baby care, clothing, feeding and nursery products.',
    attributes: [],
  },
  {
    key: 'office',
    name: 'Office',
    description: 'Office equipment, supplies and work accessories.',
    attributes: [],
  },
  {
    key: 'phones-tablets',
    name: 'Phones & Tablets',
    description: 'Smartphones, tablets, mobile accessories and connected devices.',
    attributes: [],
  },
  {
    key: 'computers',
    name: 'Computers & Laptops',
    description: 'Laptops, desktops, monitors, storage and computer accessories.',
    attributes: [],
  },
  {
    key: 'tv-audio',
    name: 'TV, Audio & Video',
    description: 'Televisions, speakers, home audio, streaming and video equipment.',
    attributes: [],
  },
  {
    key: 'gaming',
    name: 'Gaming',
    description: 'Consoles, games, controllers, gaming PCs and accessories.',
    attributes: [],
  },
  {
    key: 'shoes',
    name: 'Shoes',
    description: 'Everyday, formal, sports and children footwear.',
    attributes: [],
  },
  {
    key: 'bags-accessories',
    name: 'Bags & Accessories',
    description: 'Backpacks, handbags, wallets, belts and fashion accessories.',
    attributes: [],
  },
  {
    key: 'jewelry-watches',
    name: 'Jewelry & Watches',
    description: 'Watches, jewelry and personal accessories.',
    attributes: [],
  },
  {
    key: 'personal-care',
    name: 'Personal Care',
    description: 'Grooming, hygiene, hair care and everyday personal care.',
    attributes: [],
  },
  {
    key: 'health-wellness',
    name: 'Health & Wellness',
    description: 'Everyday wellness, first-aid and permitted health essentials.',
    attributes: [],
  },
  {
    key: 'kitchen-appliances',
    name: 'Kitchen & Appliances',
    description: 'Cookware, kitchen tools and household appliances.',
    attributes: [],
  },
  {
    key: 'furniture-decor',
    name: 'Furniture & Decor',
    description: 'Furniture, storage, decor and home organization.',
    attributes: [],
  },
  {
    key: 'toys',
    name: 'Toys & Games',
    description: 'Toys, puzzles, learning games and family entertainment.',
    attributes: [],
  },
  {
    key: 'kids-fashion',
    name: 'Kids Fashion',
    description: 'Clothing, shoes and accessories for children.',
    attributes: [],
  },
  {
    key: 'school-supplies',
    name: 'School Supplies',
    description: 'School stationery, learning tools, bags and classroom essentials.',
    attributes: [],
  },
  {
    key: 'tools-home-improvement',
    name: 'Tools & Home Improvement',
    description: 'Hand tools, hardware, electrical and home improvement essentials.',
    attributes: [],
  },
  {
    key: 'garden-outdoor',
    name: 'Garden & Outdoor',
    description: 'Garden tools, outdoor living and yard essentials.',
    attributes: [],
  },
  {
    key: 'pets',
    name: 'Pet Supplies',
    description: 'Food accessories, grooming and everyday pet-care essentials.',
    attributes: [],
  },
  {
    key: 'travel-luggage',
    name: 'Travel & Luggage',
    description: 'Suitcases, travel bags, organizers and travel accessories.',
    attributes: [],
  },
  {
    key: 'gifts-crafts',
    name: 'Gifts & Crafts',
    description: 'Gift items, crafts, party supplies and creative materials.',
    attributes: [],
  },
  {
    key: 'business-industrial',
    name: 'Business & Industrial',
    description: 'Business equipment, packaging, workplace and industrial supplies.',
    attributes: [],
  },
]);

export const PRIMARY_CATEGORY_IDS = Object.freeze([
  'electronics', 'fashion', 'home-living', 'beauty', 'sports-fitness',
  'automotive', 'books', 'groceries', 'baby', 'office',
]);
