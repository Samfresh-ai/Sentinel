import { MongoClient, type Db } from "mongodb";
import { createLogger } from "@operaiq/shared";
import { getBrainEnv } from "./env.js";

const logger = createLogger("operaiq-brain");

let clientPromise: Promise<MongoClient> | undefined;

export function getMongoClient(): Promise<MongoClient> {
  if (!clientPromise) {
    const env = getBrainEnv();
    const client = new MongoClient(env.MONGODB_ATLAS_URI, {
      appName: "operaiq",
      maxPoolSize: 20,
      minPoolSize: 1,
      retryReads: true,
      retryWrites: true
    });
    clientPromise = client.connect().then((connected) => {
      logger.info({ database: env.MONGODB_DATABASE_NAME }, "MongoDB Atlas connection established");
      return connected;
    });
  }
  return clientPromise;
}

export async function getDb(): Promise<Db> {
  const env = getBrainEnv();
  const client = await getMongoClient();
  return client.db(env.MONGODB_DATABASE_NAME);
}

export async function closeMongoClient(): Promise<void> {
  if (clientPromise) {
    const client = await clientPromise;
    await client.close();
    clientPromise = undefined;
  }
}
