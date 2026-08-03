export async function mongoTopologyInfo(db) {
  const hello = await db.admin().command({ hello: 1 });
  const isMongos = hello?.msg === 'isdbgrid';
  const setName = typeof hello?.setName === 'string' ? hello.setName : '';
  const isPrimary = Boolean(hello?.isWritablePrimary || isMongos);
  return {
    isMongos,
    setName,
    isPrimary,
    supportsTransactions: Boolean(isMongos || setName),
  };
}

export async function assertMongoTransactions(db, expectedReplicaSet = '') {
  const info = await mongoTopologyInfo(db);
  if (!info.supportsTransactions) {
    const error = new Error('MongoDB transactions require a replica set member or mongos. Configure MONGO_URI with MongoDB Atlas or another transaction-capable MongoDB deployment.');
    error.code = 'MONGO_TRANSACTIONS_REQUIRED';
    throw error;
  }
  if (expectedReplicaSet && info.setName && info.setName !== expectedReplicaSet) {
    const error = new Error(`MongoDB replica set mismatch: expected ${expectedReplicaSet}, connected to ${info.setName}.`);
    error.code = 'MONGO_REPLICA_SET_MISMATCH';
    throw error;
  }
  if (!info.isPrimary) {
    const error = new Error('MongoDB replica set is configured but no writable primary is ready yet.');
    error.code = 'MONGO_PRIMARY_NOT_READY';
    throw error;
  }
  return info;
}
