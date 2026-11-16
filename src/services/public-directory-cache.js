// In-process, bounded cache for *public* directory DTOs only.
// Authentication, follow state and CSRF tokens are added by routes after lookup.
export function createBoundedPublicDirectoryCache({ ttlMs = 10_000, maxEntries = 48, now = Date.now } = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError('Public directory cache requires a positive TTL and entry limit.');
  }
  const entries = new Map();
  let generation = 0;

  return {
    clear() {
      generation += 1;
      entries.clear();
    },

    async get(key, loader) {
      const existing = entries.get(key);
      // Touch hot entries to implement true LRU eviction, not FIFO eviction.
      // Keep the promise object unchanged so concurrent requests still share it.
      if ((existing?.value && existing.expiresAt > now()) || existing?.promise) {
        entries.delete(key);
        entries.set(key, existing);
        return existing.promise || existing.value;
      }

      const requestGeneration = generation;
      const promise = Promise.resolve().then(loader);
      entries.delete(key);
      entries.set(key, { promise });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);

      try {
        const value = await promise;
        // A product/status change may invalidate the directory while the
        // original DB query is still running. Never resurrect that old entry.
        if (requestGeneration === generation && entries.get(key)?.promise === promise) {
          entries.delete(key);
          entries.set(key, { value, expiresAt: now() + ttlMs });
        }
        return value;
      } catch (error) {
        if (entries.get(key)?.promise === promise) entries.delete(key);
        throw error;
      }
    },
  };
}
