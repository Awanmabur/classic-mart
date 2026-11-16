// Country, currency and availability are selected via cookie, account or
// trusted edge instead of being encoded into the API URL. Never let shared
// HTTP caches mix these dynamic representations across different markets.
export function noStoreMarketJson(response) {
  response.vary('Cookie');
  response.vary('CF-IPCountry');
  response.set('Cache-Control', 'private, no-store');
  return response;
}
