function sameSingleAscendingKey(index, field) {
  const key = index?.key || {};
  const entries = Object.entries(key);
  return entries.length === 1 && entries[0][0] === field && Number(entries[0][1]) === 1;
}

function namespaceMissing(error) {
  return error?.code === 26 || error?.codeName === 'NamespaceNotFound';
}

function unsafeToReplace(index) {
  return Boolean(index?.unique || index?.sparse || index?.partialFilterExpression);
}

function collModFallbackAllowed(error) {
  return [20, 59, 72, 85].includes(Number(error?.code))
    || ['IllegalOperation', 'CommandNotFound', 'InvalidOptions', 'IndexOptionsConflict'].includes(error?.codeName);
}

function ttlSecondsFromOptions(options = {}) {
  const value = options.expireAfterSeconds ?? options.expires;
  if (value === undefined || value === null || value === '') return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/**
 * Discover every single-field TTL index declared by the registered Mongoose
 * models. Keeping this dynamic prevents upgrades from missing a newly-added TTL
 * collection and then failing later during global index creation.
 */
export function ttlIndexEntriesForModels(models) {
  const entries = [];
  const seen = new Set();
  for (const model of models || []) {
    const declared = model?.schema?.indexes?.() || [];
    for (const [key, options = {}] of declared) {
      const keyEntries = Object.entries(key || {});
      const expireAfterSeconds = ttlSecondsFromOptions(options);
      if (keyEntries.length !== 1 || Number(keyEntries[0][1]) !== 1 || expireAfterSeconds === null) continue;
      const field = keyEntries[0][0];
      const identity = `${model.modelName || model.collection?.collectionName || 'model'}:${field}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      entries.push({ model, field, expireAfterSeconds });
    }
  }
  return entries;
}

/**
 * Build indexes one model at a time so an upgrade failure names the exact model
 * instead of being swallowed inside Promise.all.
 */
export async function ensureModelIndexes(models, log = null) {
  for (const model of models || []) {
    try {
      await model.createIndexes();
    } catch (error) {
      const modelName = model?.modelName || model?.collection?.collectionName || 'unknown-model';
      log?.error?.({ err: error, modelName }, 'Model index creation failed');
      const wrapped = new Error(`Index creation failed for ${modelName}: ${error?.message || 'unknown error'}`, { cause: error });
      if (error?.code !== undefined) wrapped.code = error.code;
      if (error?.codeName) wrapped.codeName = error.codeName;
      throw wrapped;
    }
  }
}

/**
 * Upgrade a legacy normal single-field expiry index to the TTL index required by
 * the current schema. This preserves the collection and its documents.
 *
 * MongoDB 5.1+ supports converting a single-field index to TTL with collMod.
 * A guarded drop/recreate fallback is retained for compatible installations
 * where collMod conversion is unavailable. The fallback refuses to replace
 * unique/sparse/partial indexes because those may encode business semantics.
 */
export async function reconcileTtlIndex(model, field, expireAfterSeconds = 0, log = null) {
  let indexes;
  try {
    indexes = await model.collection.indexes();
  } catch (error) {
    if (namespaceMissing(error)) return { status: 'collection_missing' };
    throw error;
  }

  const matches = indexes.filter((index) => sameSingleAscendingKey(index, field));
  if (!matches.length) return { status: 'index_missing' };

  for (const index of matches) {
    if (Number(index.expireAfterSeconds) === Number(expireAfterSeconds)) continue;
    if (unsafeToReplace(index)) {
      throw new Error(
        `Refusing to replace protected index ${model.collection.collectionName}.${index.name} while reconciling TTL ${field}`,
      );
    }

    try {
      await model.db.db.command({
        collMod: model.collection.collectionName,
        index: { name: index.name, expireAfterSeconds },
      });
      log?.info?.(
        { model: model.modelName, index: index.name, field, expireAfterSeconds },
        'Upgraded legacy expiry index to TTL',
      );
    } catch (error) {
      if (!collModFallbackAllowed(error)) throw error;
      // If this MongoDB version cannot convert the index with collMod, replace
      // only the legacy non-protected single-field index. Transient, network
      // and authorization failures are never converted into a destructive
      // fallback. No documents or collections are dropped.
      await model.collection.dropIndex(index.name);
      log?.warn?.(
        { model: model.modelName, index: index.name, field, reason: error?.codeName || error?.message },
        'Recreating legacy expiry index as TTL',
      );
      await model.collection.createIndex(
        { [field]: 1 },
        { name: index.name, expireAfterSeconds },
      );
      log?.info?.(
        { model: model.modelName, index: index.name, field, expireAfterSeconds },
        'Recreated legacy expiry index as TTL',
      );
    }
  }

  return { status: 'reconciled' };
}

export async function reconcileExpiryIndexes(entries, log = null) {
  for (const entry of entries) {
    await reconcileTtlIndex(entry.model, entry.field, entry.expireAfterSeconds ?? 0, log);
  }
}
