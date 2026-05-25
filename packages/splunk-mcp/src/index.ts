import {
  getDocument,
  insertDocument,
  queryDocuments,
  runSearch,
  sendEvent,
  updateDocument,
  type SplunkHECEvent,
  type SplunkSearchResult
} from "@operaiq/splunk-brain";

export async function splunkSearch(query: string, earliest?: string, latest?: string): Promise<SplunkSearchResult[]> {
  return runSearch(query, {
    ...(earliest ? { earliestTime: earliest } : {}),
    ...(latest ? { latestTime: latest } : {}),
    maxResults: 1000
  });
}

export async function splunkKvGet(collection: string, key: string): Promise<Record<string, unknown> | null> {
  return getDocument<Record<string, unknown>>(collection, key);
}

export async function splunkKvQuery(
  collection: string,
  filter: Record<string, unknown>,
  limit = 100
): Promise<Record<string, unknown>[]> {
  return queryDocuments<Record<string, unknown>>(collection, filter, limit);
}

export async function splunkKvPut(
  collection: string,
  key: string | null,
  document: Record<string, unknown>
): Promise<{ key: string }> {
  if (key) {
    const existing = await splunkKvGet(collection, key);
    if (existing) {
      await updateDocument(collection, key, document);
      return { key };
    }
    const inserted = await insertDocument(collection, { ...document, _key: key });
    return { key: inserted._key };
  }
  const inserted = await insertDocument(collection, document);
  return { key: inserted._key };
}

export async function splunkHecSend(event: SplunkHECEvent): Promise<void> {
  await sendEvent(event);
}

export type { SplunkHECEvent, SplunkSearchResult };
