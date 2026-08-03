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
    }
  }

  return { status: 'reconciled' };
}

export async function reconcileExpiryIndexes(entries, log = null) {
  for (const entry of entries) {
    await reconcileTtlIndex(entry.model, entry.field, entry.expireAfterSeconds ?? 0, log);
  }
}
