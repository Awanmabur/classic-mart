import mongoose from 'mongoose';

// Model compilation queues collection creation and index builds. Fixture
// teardown must finish that work before deleting the database it targets.
export async function settleModelInitialization(connection) {
  const settled = new Set();
  while (true) {
    const models = Object.values(connection.models).filter(model => !settled.has(model));
    if (!models.length) return;
    await Promise.all(models.map(model => model.init()));
    for (const model of models) settled.add(model);
  }
}

if (process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI) {
  const originalConnectionDrop = mongoose.Connection.prototype.dropDatabase;
  const originalNativeDrop = mongoose.mongo.Db.prototype.dropDatabase;
  const settledDrops = new WeakSet();

  mongoose.Connection.prototype.dropDatabase = async function (...args) {
    // Let Mongoose retain its own argument validation.
    if (typeof args[0] === 'function') return originalConnectionDrop.apply(this, args);
    await this._waitForConnect();
    await settleModelInitialization(this);
    const database = this.db;
    settledDrops.add(database);
    try {
      // Mongoose clears model.$init inside this method. Avoid starting a new
      // index build when it then delegates to the native database method.
      return await originalConnectionDrop.apply(this, args);
    } finally {
      settledDrops.delete(database);
    }
  };

  mongoose.mongo.Db.prototype.dropDatabase = async function (...args) {
    if (!settledDrops.has(this)) {
      const connections = mongoose.connections.filter(connection => connection.db === this);
      await Promise.all(connections.map(settleModelInitialization));
    }
    return originalNativeDrop.apply(this, args);
  };
}
