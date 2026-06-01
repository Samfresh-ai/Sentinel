import { z } from "zod";
import { getQdrantConfig, qdrantRequest } from "./client.js";

const collectionResponseSchema = z.object({
  result: z.object({
    config: z.object({
      params: z.object({
        vectors: z.union([
          z.object({ size: z.number().optional() }).passthrough(),
          z.record(z.object({ size: z.number().optional() }).passthrough())
        ]).optional()
      }).passthrough()
    }).passthrough()
  }).passthrough()
}).passthrough();

let ensured: Promise<void> | null = null;
let ensuredDimension: number | null = null;

function vectorSizeFromResponse(value: unknown): number | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value) && "size" in value) {
    const size = (value as { size?: unknown }).size;
    return typeof size === "number" ? size : null;
  }
  return null;
}

async function createPayloadIndex(fieldName: string, fieldSchema: "keyword" | "integer" | "float" | "datetime"): Promise<void> {
  const config = getQdrantConfig();
  await qdrantRequest(z.record(z.unknown()), {
    method: "PUT",
    path: `/collections/${encodeURIComponent(config.QDRANT_COLLECTION)}/index`,
    json: { field_name: fieldName, field_schema: fieldSchema }
  }).catch(() => undefined);
}

async function ensurePayloadIndexes(): Promise<void> {
  await Promise.all([
    createPayloadIndex("kind", "keyword"),
    createPayloadIndex("collection", "keyword"),
    createPayloadIndex("orgId", "keyword"),
    createPayloadIndex("incidentId", "keyword"),
    createPayloadIndex("projectId", "keyword"),
    createPayloadIndex("runbookId", "keyword"),
    createPayloadIndex("service", "keyword"),
    createPayloadIndex("fingerprint", "keyword"),
    createPayloadIndex("patternChecked", "keyword"),
    createPayloadIndex("environment", "keyword"),
    createPayloadIndex("severity", "keyword"),
    createPayloadIndex("outcome", "keyword"),
    createPayloadIndex("createdAt", "datetime"),
    createPayloadIndex("updatedAt", "datetime")
  ]);
}

async function ensureQdrantMemoryCollection(vectorSize: number): Promise<void> {
  const config = getQdrantConfig();
  const collectionName = encodeURIComponent(config.QDRANT_COLLECTION);
  const existing = await qdrantRequest(collectionResponseSchema, {
    path: `/collections/${collectionName}`
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("404")) return null;
    throw error;
  });

  if (existing) {
    const vectors = existing.result.config.params.vectors;
    const existingSize = vectorSizeFromResponse(vectors);
    if (existingSize !== null && existingSize !== vectorSize) {
      throw new Error(`Qdrant collection ${config.QDRANT_COLLECTION} has vector size ${existingSize}, but embedding provider returned ${vectorSize}`);
    }
    await ensurePayloadIndexes();
    return;
  }

  await qdrantRequest(z.record(z.unknown()), {
    method: "PUT",
    path: `/collections/${collectionName}`,
    json: {
      vectors: {
        size: vectorSize,
        distance: "Cosine"
      }
    }
  });
  await ensurePayloadIndexes();
}

export async function ensureMemoryCollection(vectorSize: number): Promise<void> {
  if (ensured && ensuredDimension === vectorSize) return ensured;
  ensuredDimension = vectorSize;
  ensured = ensureQdrantMemoryCollection(vectorSize);
  return ensured;
}

export function resetCollectionCacheForTests(): void {
  ensured = null;
  ensuredDimension = null;
}
