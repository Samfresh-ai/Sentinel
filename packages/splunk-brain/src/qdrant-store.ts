import { findSimilarIncidents } from "./similarity.js";
import { getDocument, insertDocument, queryDocuments, updateDocument, type KvStoreOptions } from "./kvstore.js";

export class QdrantMemoryStore {
  async upsert(collection: string, key: string | null, document: Record<string, unknown>, options?: KvStoreOptions): Promise<{ key: string }> {
    if (key) {
      const existing = await getDocument<Record<string, unknown>>(collection, key, options);
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

  async query(collection: string, filter: Record<string, unknown>, limit = 100, options?: KvStoreOptions): Promise<Record<string, unknown>[]> {
    return queryDocuments<Record<string, unknown>>(collection, filter, limit, options);
  }
}

export class QdrantRunbookStore extends QdrantMemoryStore {
  async upsertRunbook(document: Record<string, unknown>, orgId: string, key: string | null = null): Promise<{ key: string }> {
    return this.upsert("runbooks", key, document, { orgId });
  }

  async searchRunbooks(filter: Record<string, unknown>, orgId: string, limit = 25): Promise<Record<string, unknown>[]> {
    return this.query("runbooks", filter, limit, { orgId });
  }
}

export class QdrantPostmortemStore extends QdrantMemoryStore {
  async writePostmortem(document: Record<string, unknown>, orgId: string): Promise<{ key: string }> {
    return this.upsert("postmortems", null, document, { orgId });
  }
}

export class QdrantBrainStore extends QdrantMemoryStore {
  readonly runbooks = new QdrantRunbookStore();
  readonly postmortems = new QdrantPostmortemStore();

  async searchSimilarIncidents(symptoms: string[], orgId: string, limit = 5, currentIncidentId?: string) {
    return findSimilarIncidents(symptoms, limit, { orgId, ...(currentIncidentId ? { currentIncidentId } : {}) });
  }
}

export class OperaIQBrain extends QdrantBrainStore {}
