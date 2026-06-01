import { queryAllDocuments } from "./kvstore.js";
import type { QdrantEvent, QdrantSearchResult } from "./types.js";

function includesPostmortemQuery(query: string): boolean {
  const normalized = query.toLowerCase();
  return normalized.includes("postmortem") || normalized.includes("post-mortem");
}

function maxResultsFromQuery(defaultValue: number, options?: { maxResults?: number }): number {
  return Math.max(1, Math.min(options?.maxResults ?? defaultValue, 10_000));
}

export async function runSearch(
  query: string,
  options: { earliestTime?: string; latestTime?: string; maxResults?: number } = {}
): Promise<QdrantSearchResult[]> {
  const maxResults = maxResultsFromQuery(100, options);
  if (includesPostmortemQuery(query)) {
    return queryAllDocuments<QdrantSearchResult>("postmortems", {}, maxResults);
  }
  return queryAllDocuments<QdrantSearchResult>("events", {}, maxResults).catch(() => []);
}

export async function searchEvents(
  query: string,
  _timeRange: { earliest: string; latest: string }
): Promise<QdrantEvent[]> {
  return runSearch(query, { maxResults: 1000 }) as Promise<QdrantEvent[]>;
}
