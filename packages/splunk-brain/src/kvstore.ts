import crypto from "node:crypto";
import { z } from "zod";
import { getSplunkConfig, splunkRestRequest } from "./client.js";
import { splunkRecordSchema, type SplunkRecord } from "./types.js";

const collectionListSchema = z.object({ entry: z.array(z.object({ name: z.string() }).passthrough()).default([]) }).passthrough();
const recordArraySchema = z.array(splunkRecordSchema);
const singleRecordSchema = splunkRecordSchema;
const insertResponseSchema = z.object({ _key: z.string() }).passthrough();
const ORG_SCOPED_COLLECTIONS = new Set([
  "incidents",
  "services",
  "service_runtime_configs",
  "runbooks",
  "patterns",
  "postmortems",
  "audit_log",
  "remediation_executions"
]);

export interface KvStoreOptions {
  orgId: string;
}

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

function scoped(collection: string): boolean {
  return ORG_SCOPED_COLLECTIONS.has(collection);
}

function requireOrgId(collection: string, orgId?: string): string {
  if (!scoped(collection)) return orgId ?? "";
  if (!orgId || orgId.trim().length === 0) {
    throw new Error(`orgId is required for Splunk KV Store collection ${collection}`);
  }
  return orgId;
}

function documentOrgId(collection: string, document: Record<string, unknown>, options?: KvStoreOptions): string {
  const explicit = typeof document.orgId === "string" ? document.orgId : undefined;
  const orgId = explicit ?? options?.orgId;
  const required = requireOrgId(collection, orgId);
  if (explicit && options?.orgId && explicit !== options.orgId) {
    throw new Error(`orgId mismatch for Splunk KV Store collection ${collection}`);
  }
  return required;
}

function scopedFilter(collection: string, filter: Record<string, unknown>, options?: KvStoreOptions): Record<string, unknown> {
  if (!scoped(collection)) return filter;
  return { ...filter, orgId: requireOrgId(collection, options?.orgId) };
}

export function createKvKey(): string {
  return crypto.randomBytes(12).toString("hex");
}

export async function createCollection(name: string, fields: Record<string, string> = {}): Promise<void> {
  const current = await splunkRestRequest(collectionListSchema, {
    path: configPath(),
    query: { output_mode: "json", count: 0 }
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
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("409") && message.includes("already exists")) return {};
    throw error;
  });
}

export async function insertDocument<T>(collection: string, doc: T, options?: KvStoreOptions): Promise<{ _key: string }> {
  const document = normalizeDocument(doc);
  const orgId = documentOrgId(collection, document, options);
  const withKey = {
    _key: typeof document._key === "string" ? document._key : createKvKey(),
    ...document,
    ...(scoped(collection) ? { orgId } : {})
  };
  const result = await splunkRestRequest(insertResponseSchema, {
    method: "POST",
    path: collectionPath(collection),
    query: { output_mode: "json" },
    json: withKey
  });
  return { _key: result._key };
}

export async function getDocument<T>(collection: string, key: string, options?: KvStoreOptions): Promise<T | null> {
  requireOrgId(collection, options?.orgId);
  const result = await splunkRestRequest(singleRecordSchema, {
    path: `${collectionPath(collection)}/${encodeURIComponent(key)}`,
    query: { output_mode: "json" }
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("404")) return null;
    throw error;
  });
  if (result && scoped(collection) && result.orgId !== options?.orgId) return null;
  return result as T | null;
}

export async function queryDocuments<T>(
  collection: string,
  filter: Record<string, unknown>,
  limit = 100,
  options?: KvStoreOptions
): Promise<T[]> {
  const query = scopedFilter(collection, filter, options);
  const docs = await splunkRestRequest(recordArraySchema, {
    path: collectionPath(collection),
    query: {
      output_mode: "json",
      query: JSON.stringify(query),
      count: limit
    }
  });
  return docs as T[];
}

export async function queryAllDocuments<T>(
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

export async function updateDocument<T>(collection: string, key: string, updates: Partial<T>, options?: KvStoreOptions): Promise<void> {
  const current = await getDocument<Record<string, unknown>>(collection, key, options);
  if (!current) {
    throw new Error(`Splunk KV document ${collection}/${key} does not exist`);
  }
  if (scoped(collection)) requireOrgId(collection, options?.orgId);
  const next: Record<string, unknown> = { ...current, ...normalizeDocument(updates), _key: key };
  if (scoped(collection)) {
    next.orgId = current.orgId;
  }
  await splunkRestRequest(z.record(z.unknown()).default({}), {
    method: "POST",
    path: `${collectionPath(collection)}/${encodeURIComponent(key)}`,
    query: { output_mode: "json" },
    json: next
  });
}

export async function deleteDocument(collection: string, key: string, options?: KvStoreOptions): Promise<void> {
  if (scoped(collection)) {
    const current = await getDocument<Record<string, unknown>>(collection, key, options);
    if (!current) return;
  }
  await splunkRestRequest(z.record(z.unknown()).default({}), {
    method: "DELETE",
    path: `${collectionPath(collection)}/${encodeURIComponent(key)}`,
    query: { output_mode: "json" }
  });
}

export async function clearCollection(collection: string, options?: KvStoreOptions): Promise<void> {
  if (scoped(collection)) {
    const docs = await queryDocuments<SplunkRecord>(collection, {}, 10_000, options);
    for (const doc of docs) {
      if (doc._key) await deleteDocument(collection, doc._key, options);
    }
    return;
  }
  await splunkRestRequest(z.record(z.unknown()).default({}), {
    method: "DELETE",
    path: collectionPath(collection),
    query: { output_mode: "json" }
  });
}

export async function batchInsert<T>(collection: string, docs: T[], options?: KvStoreOptions): Promise<{ inserted: number }> {
  let inserted = 0;
  for (const doc of docs) {
    await insertDocument(collection, doc, options);
    inserted += 1;
  }
  return { inserted };
}

export async function countDocuments(collection: string, filter: Record<string, unknown> = {}, options?: KvStoreOptions): Promise<number> {
  const docs = await queryDocuments<SplunkRecord>(collection, filter, 10_000, options);
  return docs.length;
}
