import crypto from "node:crypto";
import { z } from "zod";
import { getSplunkConfig, splunkRestRequest } from "./client.js";
import { splunkRecordSchema, type SplunkRecord } from "./types.js";

const collectionListSchema = z.object({ entry: z.array(z.object({ name: z.string() }).passthrough()).default([]) }).passthrough();
const recordArraySchema = z.array(splunkRecordSchema);
const singleRecordSchema = splunkRecordSchema;
const insertResponseSchema = z.object({ _key: z.string() }).passthrough();

function appPath(suffix: string): string {
  const app = encodeURIComponent(getSplunkConfig().SPLUNK_APP);
  return `/servicesNS/nobody/${app}/storage/collections/${suffix}`;
}

function collectionPath(collection: string): string {
  return appPath(`data/${encodeURIComponent(collection)}`);
}

function configPath(): string {
  return appPath("config");
}

function normalizeDocument<T>(doc: T): Record<string, unknown> {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new Error("Splunk KV Store documents must be JSON objects");
  }
  return doc as Record<string, unknown>;
}

export function createKvKey(): string {
  return crypto.randomBytes(12).toString("hex");
}

export async function createCollection(name: string, fields: Record<string, string> = {}): Promise<void> {
  const current = await splunkRestRequest(collectionListSchema, {
    path: configPath(),
    query: { output_mode: "json" }
  }).catch(() => ({ entry: [] }));
  if ((current.entry ?? []).some((entry) => entry.name === name)) return;

  await splunkRestRequest(z.record(z.unknown()).default({}), {
    method: "POST",
    path: configPath(),
    form: {
      name,
      output_mode: "json",
      ...Object.fromEntries(Object.entries(fields).map(([field, type]) => [`field.${field}`, type]))
    }
  });
}

export async function insertDocument<T>(collection: string, doc: T): Promise<{ _key: string }> {
  const document = normalizeDocument(doc);
  const withKey = { _key: typeof document._key === "string" ? document._key : createKvKey(), ...document };
  const result = await splunkRestRequest(insertResponseSchema, {
    method: "POST",
    path: collectionPath(collection),
    query: { output_mode: "json" },
    json: withKey
  });
  return { _key: result._key };
}

export async function getDocument<T>(collection: string, key: string): Promise<T | null> {
  const result = await splunkRestRequest(singleRecordSchema, {
    path: `${collectionPath(collection)}/${encodeURIComponent(key)}`,
    query: { output_mode: "json" }
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("404")) return null;
    throw error;
  });
  return result as T | null;
}

export async function queryDocuments<T>(
  collection: string,
  filter: Record<string, unknown>,
  limit = 100
): Promise<T[]> {
  const docs = await splunkRestRequest(recordArraySchema, {
    path: collectionPath(collection),
    query: {
      output_mode: "json",
      query: JSON.stringify(filter),
      count: limit
    }
  });
  return docs as T[];
}

export async function updateDocument<T>(collection: string, key: string, updates: Partial<T>): Promise<void> {
  const current = await getDocument<Record<string, unknown>>(collection, key);
  if (!current) {
    throw new Error(`Splunk KV document ${collection}/${key} does not exist`);
  }
  await splunkRestRequest(z.record(z.unknown()).default({}), {
    method: "POST",
    path: `${collectionPath(collection)}/${encodeURIComponent(key)}`,
    query: { output_mode: "json" },
    json: { ...current, ...normalizeDocument(updates), _key: key }
  });
}

export async function deleteDocument(collection: string, key: string): Promise<void> {
  await splunkRestRequest(z.record(z.unknown()).default({}), {
    method: "DELETE",
    path: `${collectionPath(collection)}/${encodeURIComponent(key)}`,
    query: { output_mode: "json" }
  });
}

export async function clearCollection(collection: string): Promise<void> {
  await splunkRestRequest(z.record(z.unknown()).default({}), {
    method: "DELETE",
    path: collectionPath(collection),
    query: { output_mode: "json" }
  });
}

export async function batchInsert<T>(collection: string, docs: T[]): Promise<{ inserted: number }> {
  let inserted = 0;
  for (const doc of docs) {
    await insertDocument(collection, doc);
    inserted += 1;
  }
  return { inserted };
}

export async function countDocuments(collection: string, filter: Record<string, unknown> = {}): Promise<number> {
  const docs = await queryDocuments<SplunkRecord>(collection, filter, 10_000);
  return docs.length;
}
