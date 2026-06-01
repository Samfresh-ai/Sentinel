import {
  getDocument,
  insertDocument,
  type KvStoreOptions,
  queryDocuments,
  runSearch,
  sendEvent,
  updateDocument,
  type SplunkHECEvent,
  type SplunkSearchResult
} from "@sentinel/splunk-brain";

export async function qdrantMemorySearch(query: string, earliest?: string, latest?: string): Promise<SplunkSearchResult[]> {
  return runSearch(query, {
    ...(earliest ? { earliestTime: earliest } : {}),
    ...(latest ? { latestTime: latest } : {}),
    maxResults: 1000
  });
}

export async function qdrantMemoryGet(collection: string, key: string, orgId?: string): Promise<Record<string, unknown> | null> {
  return getDocument<Record<string, unknown>>(collection, key, orgId ? { orgId } : undefined);
}

export async function qdrantMemoryQuery(
  collection: string,
  filter: Record<string, unknown>,
  limit = 100,
  orgId?: string
): Promise<Record<string, unknown>[]> {
  return queryDocuments<Record<string, unknown>>(collection, filter, limit, orgId ? { orgId } : undefined);
}

export async function qdrantMemoryPut(
  collection: string,
  key: string | null,
  document: Record<string, unknown>,
  orgId?: string
): Promise<{ key: string }> {
  const options: KvStoreOptions | undefined = orgId ? { orgId } : undefined;
  if (key) {
    const existing = await qdrantMemoryGet(collection, key, orgId);
    if (existing) {
      await updateDocument(collection, key, document, options);
      return { key };
    }
    const inserted = await insertDocument(collection, { ...document, _key: key }, options);
    return { key: inserted._key };
  }
  const inserted = await insertDocument(collection, document, options);
  return { key: inserted._key };
}

export async function qdrantMemorySend(event: SplunkHECEvent): Promise<void> {
  await sendEvent(event);
}

export async function splunkSearch(query: string, earliest?: string, latest?: string): Promise<SplunkSearchResult[]> {
  return qdrantMemorySearch(query, earliest, latest);
}

export async function splunkKvGet(collection: string, key: string, orgId?: string): Promise<Record<string, unknown> | null> {
  return qdrantMemoryGet(collection, key, orgId);
}

export async function splunkKvQuery(
  collection: string,
  filter: Record<string, unknown>,
  limit = 100,
  orgId?: string
): Promise<Record<string, unknown>[]> {
  return qdrantMemoryQuery(collection, filter, limit, orgId);
}

export async function splunkKvPut(
  collection: string,
  key: string | null,
  document: Record<string, unknown>,
  orgId?: string
): Promise<{ key: string }> {
  return qdrantMemoryPut(collection, key, document, orgId);
}

export async function splunkHecSend(event: SplunkHECEvent): Promise<void> {
  await qdrantMemorySend(event);
}

export type { SplunkHECEvent, SplunkSearchResult };
