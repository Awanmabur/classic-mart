/** Scope a server request without losing its current session or Express context. */
export function requestWithQuery(request, changes) {
  const scoped = Object.create(request);
  // Express 5's inherited query getter has no setter. A new own property also
  // leaves the caller's parsed query intact for its later authorization checks.
  Object.defineProperty(scoped, 'query', {
    value: { ...request.query, ...changes },
    enumerable: true,
  });
  return scoped;
}
