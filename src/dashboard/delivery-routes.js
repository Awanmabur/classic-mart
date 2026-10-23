export const DELIVERY_ROUTES = Object.freeze({
  'delivery-overview': '/delivery',
  'delivery-profile': '/delivery/profile',
  'delivery-offers': '/delivery/offers',
  'delivery-jobs': '/delivery/jobs',
  'delivery-tracking': '/delivery/tracking',
  'delivery-earnings': '/delivery/earnings',
});

export const DELIVERY_PAGES = Object.freeze([
  ['delivery-overview', 'Overview', 'i-grid', 'Delivery', 'Delivery Overview', 'Your availability, offers and active deliveries.', 'overview'],
  ['delivery-profile', 'Delivery Profile', 'i-user', 'Account', 'Delivery Profile', 'Manage transport, service areas and private verification.', 'profile'],
  ['delivery-offers', 'Job Offers', 'i-bell', 'Delivery', 'Job Offers', 'Review explicit offers and their agreed earnings.', 'offers'],
  ['delivery-jobs', 'My Deliveries', 'i-truck', 'Delivery', 'My Deliveries', 'Confirm collection, delivery and cash handover with evidence.', 'jobs'],
  ['delivery-tracking', 'Tracking', 'i-map', 'Delivery', 'Delivery Tracking', 'Review current custody, delivery attempts and exceptions.', 'tracking'],
  ['delivery-earnings', 'Earnings', 'i-wallet', 'Finance', 'Delivery Earnings', 'Review earned balance and request an independently verified payout.', 'earnings'],
]);

export function deliveryPath(mode = 'overview') {
  return DELIVERY_ROUTES['delivery-' + String(mode).replace(/^delivery-/, '')] || '/delivery';
}
