export function hasOrderGrant(request, orderId) {
  const grant = request.session?.orderGrants?.[String(orderId || '')];
  return Number(grant || 0) > Date.now();
}

export function grantTrackedOrder(request, orderId, ttlMs = 30 * 60_000) {
  if (!request.session) throw new TypeError('A server session is required to grant tracked-order access.');
  const now = Date.now();
  const current = request.session.orderGrants && typeof request.session.orderGrants === 'object'
    ? request.session.orderGrants
    : {};
  request.session.orderGrants = Object.fromEntries(
    Object.entries(current)
      .filter(([, expiresAt]) => Number(expiresAt) > now)
      .slice(-10),
  );
  request.session.orderGrants[String(orderId)] = now + Math.max(60_000, Number(ttlMs) || 0);
}

export function orderAccessQuery(request, orderId) {
  const publicId = String(orderId || '').trim();
  const query = { publicId };
  if (hasOrderGrant(request, publicId)) return query;
  const cartKey = request.session?.cartKey || '__none__';
  if (request.user?._id) query.$or = [{ userId: request.user._id }, { sessionKey: cartKey }];
  else query.sessionKey = cartKey;
  return query;
}
