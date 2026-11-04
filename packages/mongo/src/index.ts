import mongoose from 'mongoose';

// The shared Mongo connection. Models (scan events, copilot conversations) are added as those features land.

export async function connectMongo(uri: string): Promise<void> {
  // Fail after 5 s instead of Mongoose's default 30 s, so a bad URI is reported quickly at startup.
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5_000 });
}

/** Throws if Mongo is not connected or does not answer a ping. */
export async function pingMongo(): Promise<void> {
  const db = mongoose.connection.db;
  if (mongoose.connection.readyState !== mongoose.ConnectionStates.connected || !db) {
    throw new Error('mongo is not connected');
  }
  await db.admin().ping();
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect();
}
