const LEVEL_RANK = Object.freeze({ read: 1, mutate: 2 });

function normalizedGrant(raw) {
  if (typeof raw === 'number') return { level: 'mutate', expiresAt: raw };
  if (!raw || typeof raw !== 'object') return null;
  const level = raw.level === 'mutate' ? 'mutate' : 'read';
  return { level, expiresAt: Number(raw.expiresAt || 0) };
}

export function orderGrantLevel(request, orderId) {
  const grant = normalizedGrant(request.session?.orderGrants?.[String(orderId || '')]);
  if (!grant || grant.expiresAt <= Date.now()) return '';
  return grant.level;
}

export function hasOrderGrant(request, orderId, requiredLevel = 'read') {
  const level = orderGrantLevel(request, orderId);
  return Boolean(level && LEVEL_RANK[level] >= LEVEL_RANK[requiredLevel]);
}

export function grantTrackedOrder(request, orderId, ttlMs = 30 * 60_000, level = 'mutate') {
  if (!request.session) throw new TypeError('A server session is required to grant tracked-order access.');
  const now = Date.now();
  const cleanLevel = level === 'read' ? 'read' : 'mutate';
  const current = request.session.orderGrants && typeof request.session.orderGrants === 'object'
    ? request.session.orderGrants
    : {};
  request.session.orderGrants = Object.fromEntries(
    Object.entries(current)
      .map(([id, raw]) => [id, normalizedGrant(raw)])
      .filter(([, grant]) => grant && grant.expiresAt > now)
      .slice(-10),
  );
  const existing = normalizedGrant(request.session.orderGrants[String(orderId)]);
  const levelRank = Math.max(LEVEL_RANK[existing?.level] || 0, LEVEL_RANK[cleanLevel]);
  request.session.orderGrants[String(orderId)] = {
    level: levelRank >= LEVEL_RANK.mutate ? 'mutate' : 'read',
    expiresAt: Math.max(existing?.expiresAt || 0, now + Math.max(60_000, Number(ttlMs) || 0)),
  };
}

export function revokeTrackedOrder(request, orderId) {
  if (!request.session?.orderGrants) return;
  delete request.session.orderGrants[String(orderId || '')];
}

export function orderAccessQuery(request, orderId, { requiredLevel = 'read' } = {}) {
  const publicId = String(orderId || '').trim();
  const query = { publicId };
  if (hasOrderGrant(request, publicId, requiredLevel)) return query;
  const cartKey = request.session?.cartKey || '__none__';
  if (request.user?._id) query.$or = [{ userId: request.user._id }, { sessionKey: cartKey }];
  else query.sessionKey = cartKey;
  return query;
}
