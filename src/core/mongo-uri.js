function splitMongoUri(uri) {
  const value = String(uri || '').trim();
  if (!/^mongodb(?:\+srv)?:\/\//i.test(value)) {
    throw new Error('MongoDB URI must begin with mongodb:// or mongodb+srv://.');
  }
  const queryIndex = value.indexOf('?');
  const withoutQuery = queryIndex >= 0 ? value.slice(0, queryIndex) : value;
  const query = queryIndex >= 0 ? value.slice(queryIndex + 1) : '';
  const schemeEnd = withoutQuery.indexOf('://') + 3;
  const pathIndex = withoutQuery.indexOf('/', schemeEnd);
  const authority = pathIndex >= 0 ? withoutQuery.slice(0, pathIndex) : withoutQuery;
  const database = pathIndex >= 0 ? withoutQuery.slice(pathIndex + 1) : '';
  return { authority, database, query };
}

export function mongoDatabaseName(uri) {
  return splitMongoUri(uri).database;
}

export function mongoUriWithDatabase(uri, database) {
  const name = String(database || '').trim();
  if (!name || /[/?#\\]/.test(name)) throw new Error('MongoDB database name is invalid.');
  const { authority, query } = splitMongoUri(uri);
  return `${authority}/${name}${query ? `?${query}` : ''}`;
}

export function mongoUriOption(uri, key) {
  const { query } = splitMongoUri(uri);
  return new URLSearchParams(query).get(key) || '';
}
