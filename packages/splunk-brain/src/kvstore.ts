import crypto from "node:crypto";
import { z } from "zod";
import { getQdrantConfig, qdrantRequest } from "./client.js";
import { ensureMemoryCollection } from "./collections.js";
import { embedPassage } from "./embedding.js";
import { qdrantRecordSchema, type QdrantRecord } from "./types.js";

const pointSchema = z.object({
  id: z.union([z.string(), z.number()]),
  payload: qdrantRecordSchema.default({})
}).passthrough();

const scrollResponseSchema = z.object({
  result: z.object({
    points: z.array(pointSchema).default([])
  }).passthrough()
}).passthrough();

const ORG_SCOPED_COLLECTIONS = new Set([
  "incidents",
  "services",
  "projects",
  "service_runtime_configs",
  "runbooks",
  "patterns",
  "pattern_alerts",
  "postmortems",
  "audit_log",
  "events",
  "log_batches",
  "remediation_executions",
  "dead_letter"
]);

let storageReady: Promise<void> | null = null;

export interface KvStoreOptions {
  orgId: string;
}

function normalizeDocument<T>(doc: T): Record<string, unknown> {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new Error("OperaIQ memory documents must be JSON objects");
  }
  return doc as Record<string, unknown>;
}

function scoped(collection: string): boolean {
  return ORG_SCOPED_COLLECTIONS.has(collection);
}

function requireOrgId(collection: string, orgId?: string): string {
  if (!scoped(collection)) return orgId ?? "";
  if (!orgId || orgId.trim().length === 0) {
    throw new Error(`orgId is required for OperaIQ memory collection ${collection}`);
  }
  return orgId;
}

function documentOrgId(collection: string, document: Record<string, unknown>, options?: KvStoreOptions): string {
  const explicit = typeof document.orgId === "string" ? document.orgId : undefined;
  const orgId = explicit ?? options?.orgId;
  const required = requireOrgId(collection, orgId);
  if (explicit && options?.orgId && explicit !== options.orgId) {
    throw new Error(`orgId mismatch for OperaIQ memory collection ${collection}`);
  }
  return required;
}

function scopedFilter(collection: string, filter: Record<string, unknown>, options?: KvStoreOptions): Record<string, unknown> {
  if (!scoped(collection)) return filter;
  return { ...filter, orgId: requireOrgId(collection, options?.orgId) };
}

function kindForCollection(collection: string): string {
  if (collection === "incidents") return "incident_memory";
  if (collection === "runbooks") return "runbook";
  if (collection === "postmortems") return "postmortem";
  if (collection === "events") return "event";
  if (collection === "log_batches") return "event";
  if (collection === "services" || collection === "service_runtime_configs" || collection === "patterns") return "service_context";
  if (collection === "projects" || collection === "pattern_alerts") return "service_context";
  return "service_context";
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") return [value];
  return [];
}

function memoryText(collection: string, doc: Record<string, unknown>): string {
  const fields = [
    collection,
    doc.kind,
    doc.title,
    doc.summary,
    doc.message,
    doc.errorName,
    doc.stack,
    doc.fingerprint,
    doc.traceId,
    doc.projectName,
    doc.incidentType,
    doc.service,
    doc.name,
    doc.severity,
    doc.rootCause,
    doc.resolution,
    doc.lessonLearned,
    doc.successCriteria,
    ...stringList(doc.symptoms),
    ...stringList(doc.affectedServices),
    ...stringList(doc.applicableServices),
    ...stringList(doc.remediationSteps),
    ...stringList(doc.remediationTaken),
    ...stringList(doc.preventionActions),
    ...(Array.isArray(doc.steps)
      ? doc.steps.flatMap((step) => {
          if (typeof step !== "object" || step === null || Array.isArray(step)) return [];
          const record = step as Record<string, unknown>;
          return [record.action, record.command];
        })
      : [])
  ];
  return fields.filter((value): value is string => typeof value === "string" && value.trim().length > 0).join("\n");
}

function pointIdFor(collection: string, key: string): string {
  const hex = crypto.createHash("sha256").update(`${collection}:${key}`).digest("hex");
  const variant = ((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

function qdrantFilter(filter: Record<string, unknown>): Record<string, unknown> {
  const must: Array<{ key: string; match: Record<string, unknown> }> = [];
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined) continue;
    if (typeof value === "object" && value !== null && !Array.isArray(value) && "$in" in value) {
      const values = (value as { $in?: unknown }).$in;
      if (Array.isArray(values)) must.push({ key, match: { any: values } });
      continue;
    }
    must.push({ key, match: { value } });
  }
  return must.length > 0 ? { must } : {};
}

async function upsertMemoryDocument(collection: string, document: Record<string, unknown>): Promise<void> {
  const vector = await embedPassage(memoryText(collection, document));
  await ensureMemoryCollection(vector.length);
  const config = getQdrantConfig();
  await qdrantRequest(z.record(z.unknown()), {
    method: "PUT",
    path: `/collections/${encodeURIComponent(config.QDRANT_COLLECTION)}/points`,
    query: { wait: true },
    json: {
      points: [
        {
          id: pointIdFor(collection, String(document._key)),
          vector,
          payload: document
        }
      ]
    }
  });
}

async function ensureStorageReady(): Promise<void> {
  storageReady ??= embedPassage("OperaIQ Qdrant memory collection bootstrap").then((vector) => ensureMemoryCollection(vector.length));
  return storageReady;
}

export function createKvKey(): string {
  return crypto.randomBytes(12).toString("hex");
}

export async function createCollection(_name: string, _fields: Record<string, string> = {}): Promise<void> {
  await ensureStorageReady();
}

export async function insertDocument<T>(collection: string, doc: T, options?: KvStoreOptions): Promise<{ _key: string }> {
  const document = normalizeDocument(doc);
  const orgId = documentOrgId(collection, document, options);
  const now = new Date().toISOString();
  const key = typeof document._key === "string" ? document._key : createKvKey();
  const withKey = {
    _key: key,
    kind: kindForCollection(collection),
    collection,
    createdAt: typeof document.createdAt === "string" ? document.createdAt : now,
    updatedAt: typeof document.updatedAt === "string" ? document.updatedAt : now,
    ...document,
    ...(scoped(collection) ? { orgId } : {})
  };
  await upsertMemoryDocument(collection, withKey);
  return { _key: key };
}

export async function getDocument<T>(collection: string, key: string, options?: KvStoreOptions): Promise<T | null> {
  requireOrgId(collection, options?.orgId);
  const docs = await queryDocuments<QdrantRecord>(collection, { _key: key }, 1, options);
  return (docs[0] ?? null) as T | null;
}

export async function queryDocuments<T>(
  collection: string,
  filter: Record<string, unknown>,
  limit = 100,
  options?: KvStoreOptions
): Promise<T[]> {
  await ensureStorageReady();
  const config = getQdrantConfig();
  const payloadFilter = qdrantFilter({ collection, ...scopedFilter(collection, filter, options) });
  const response = await qdrantRequest(scrollResponseSchema, {
    method: "POST",
    path: `/collections/${encodeURIComponent(config.QDRANT_COLLECTION)}/points/scroll`,
    json: {
      filter: payloadFilter,
      limit,
      with_payload: true,
      with_vectors: false
    }
  });
  return (response.result.points ?? []).map((point) => point.payload as T);
}

export async function queryAllDocuments<T>(
  collection: string,
  filter: Record<string, unknown>,
  limit = 100
): Promise<T[]> {
  await ensureStorageReady();
  const config = getQdrantConfig();
  const response = await qdrantRequest(scrollResponseSchema, {
    method: "POST",
    path: `/collections/${encodeURIComponent(config.QDRANT_COLLECTION)}/points/scroll`,
    json: {
      filter: qdrantFilter({ collection, ...filter }),
      limit,
      with_payload: true,
      with_vectors: false
    }
  });
  return (response.result.points ?? []).map((point) => point.payload as T);
}

export async function updateDocument<T>(collection: string, key: string, updates: Partial<T>, options?: KvStoreOptions): Promise<void> {
  const current = await getDocument<Record<string, unknown>>(collection, key, options);
  if (!current) {
    throw new Error(`OperaIQ memory document ${collection}/${key} does not exist`);
  }
  if (scoped(collection)) requireOrgId(collection, options?.orgId);
  const next: Record<string, unknown> = {
    ...current,
    ...normalizeDocument(updates),
    _key: key,
    collection,
    kind: typeof current.kind === "string" ? current.kind : kindForCollection(collection),
    updatedAt: new Date().toISOString()
  };
  if (scoped(collection)) next.orgId = current.orgId;
  await upsertMemoryDocument(collection, next);
}

export async function deleteDocument(collection: string, key: string, options?: KvStoreOptions): Promise<void> {
  if (scoped(collection)) {
    const current = await getDocument<Record<string, unknown>>(collection, key, options);
    if (!current) return;
  }
  await ensureStorageReady();
  const config = getQdrantConfig();
  await qdrantRequest(z.record(z.unknown()), {
    method: "POST",
    path: `/collections/${encodeURIComponent(config.QDRANT_COLLECTION)}/points/delete`,
    query: { wait: true },
    json: { points: [pointIdFor(collection, key)] }
  });
}

export async function clearCollection(collection: string, options?: KvStoreOptions): Promise<void> {
  await ensureStorageReady();
  const config = getQdrantConfig();
  await qdrantRequest(z.record(z.unknown()), {
    method: "POST",
    path: `/collections/${encodeURIComponent(config.QDRANT_COLLECTION)}/points/delete`,
    query: { wait: true },
    json: { filter: qdrantFilter({ collection, ...scopedFilter(collection, {}, options) }) }
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
  const docs = await queryDocuments<QdrantRecord>(collection, filter, 10_000, options);
  return docs.length;
}

export { memoryText as qdrantMemoryText, qdrantFilter as qdrantPayloadFilter };
