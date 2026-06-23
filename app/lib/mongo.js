// Shared MongoDB connection for the Next route handlers (upload + media serving).
// Returns null when MONGODB_URI is not set, so the app falls back to local files.
import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI || '';
const dbName = process.env.MONGODB_DB || 'chatroom';

export function mongoEnabled() {
  return !!uri;
}

export async function getMongoDb() {
  if (!uri) return null;
  // Cache the client promise on the global so it survives module reloads in dev
  if (!global._mongoClientPromise) {
    const client = new MongoClient(uri);
    global._mongoClientPromise = client.connect();
  }
  const client = await global._mongoClientPromise;
  return client.db(dbName);
}
