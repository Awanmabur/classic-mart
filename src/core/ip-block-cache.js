/** Coalesce simultaneous security reads without sharing data across IP hashes. */
export function createIpBlockCache({ load, now = Date.now, limit = 10_000, ttlMs = 15_000 }) {
  const blocked = new Map();
  const clear = new Map();
  const pending = new Map();
  let generation = 0;

  function remember(map, key, value) {
    map.delete(key);
    map.set(key, value);
    while (map.size > limit) map.delete(map.keys().next().value);
  }

  function invalidate(key) {
    generation++;
    blocked.delete(key);
    clear.delete(key);
    // An older read may settle, but must then recheck the new cache/read.
    pending.delete(key);
  }

  function store(key, row, readAt = now()) {
    if (row) {
      clear.delete(key);
      remember(blocked, key, { expiresAt: Math.min(new Date(row.expiresAt).getTime(), readAt + ttlMs), row });
    } else {
      blocked.delete(key);
      remember(clear, key, readAt + ttlMs);
    }
    return row;
  }

  async function get(key) {
    const readAt = now();
    const cached = blocked.get(key);
    if (cached?.expiresAt > readAt) return cached.row;
    blocked.delete(key);
    if (clear.get(key) > readAt) return null;
    clear.delete(key);
    if (pending.has(key)) return pending.get(key).promise;

    const entry = {};
    const version = generation;
    // Never evict an in-flight read or grow a second unbounded request map.
    const tracked = pending.size < limit;
    if (tracked) pending.set(key, entry);
    const invalidated = () => tracked ? pending.get(key) !== entry : generation !== version;
    entry.promise = (async () => {
      try {
        const row = await load(key, new Date(readAt));
        if (invalidated()) return get(key);
        return store(key, row, readAt);
      } catch (error) {
        if (invalidated()) return get(key);
        throw error;
      } finally {
        if (tracked && pending.get(key) === entry) pending.delete(key);
      }
    })();
    return entry.promise;
  }

  return {
    get,
    invalidate,
    set(key, row) {
      invalidate(key);
      return store(key, row);
    },
  };
}
