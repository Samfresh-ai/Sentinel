import { z } from "zod";
import { qdrantMemoryQuery, qdrantMemorySearch, type SplunkSearchResult } from "@sentinel/splunk-mcp";
import { queryQdrantMemorySchema, type AgentToolDefinition } from "../tool-json-schemas.js";
import { asString, asStringArray, invocationFailed, invocationFinished, invocationStarted } from "./common.js";

export const queryQdrantMemoryInputSchema = z.object({
  query: z.string().min(1).optional(),
  spl: z.string().min(1).optional(),
  services: z.array(z.string().min(1)).optional(),
  symptoms: z.array(z.string().min(1)).optional(),
  timeRange: z
    .object({
      earliest: z.string().min(1),
      latest: z.string().min(1)
    })
    .optional(),
  description: z.string().min(1).default("Investigating current OperaIQ memory signals.")
});

export interface ServiceSignal {
  service: string;
  errorCount: number;
  dominantErrorType: string | null;
  status: "anomalous" | "elevated" | "clean";
  query: string;
  spl: string;
}

export interface QueryQdrantMemoryResult {
  results: SplunkSearchResult[];
  eventCount: number;
  query: string;
  spl: string;
  serviceSignals?: ServiceSignal[];
}

function tokens(values: string[]): Set<string> {
  return new Set(
    values
      .flatMap((value) => value.toLowerCase().match(/[a-z0-9_]+/g) ?? [])
      .filter((token) => token.length > 3)
  );
}

function overlapScore(doc: Record<string, unknown>, symptoms: string[]): number {
  const symptomTokens = tokens(symptoms);
  if (symptomTokens.size === 0) return 0;
  const docTokens = tokens([
    asString(doc.title),
    asString(doc.summary),
    asString(doc.message),
    asString(doc.errorName),
    asString(doc.stack),
    asString(doc.fingerprint),
    asString(doc.rootCause),
    asString(doc.resolution),
    ...asStringArray(doc.symptoms),
    ...asStringArray(doc.knownFragilePoints),
    ...asStringArray(doc.remediationSteps)
  ]);
  const matched = [...symptomTokens].filter((token) => docTokens.has(token)).length;
  return matched / Math.max(1, symptomTokens.size);
}

function numberField(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function signalFromDocs(service: string, query: string, docs: Record<string, unknown>[], symptoms: string[]): ServiceSignal {
  const serviceDocs = docs.filter((doc) => {
    const names = [asString(doc.service), asString(doc.name), ...asStringArray(doc.affectedServices), ...asStringArray(doc.applicableServices)];
    return names.includes(service);
  });
  const explicitCounts = serviceDocs
    .map((doc) => {
      const explicit = numberField(doc.errorCount ?? doc.originalErrorCount);
      if (explicit > 0) return explicit;
      const type = asString(doc.type);
      const level = asString(doc.level).toLowerCase();
      if (type === "app_log" && (level === "error" || level === "fatal")) return 1;
      return 0;
    })
    .filter((count) => count > 0);
  const inferred = serviceDocs.reduce((sum, doc) => sum + overlapScore(doc, symptoms), 0);
  const errorCount = explicitCounts.reduce((sum, count) => sum + count, 0) || Math.round(inferred * 30);
  const dominant =
    serviceDocs
      .map((doc) => asString(doc.rootCause) || asString(doc.dominantErrorType) || asString(doc.errorName) || asString(doc.message) || asString(doc.incidentType))
      .find((value) => value.length > 0) ||
    symptoms[0] ||
    null;
  const status = errorCount > 20 ? "anomalous" : errorCount >= 5 ? "elevated" : "clean";
  return { service, errorCount, dominantErrorType: dominant, status, query, spl: query };
}

async function docsForServices(services: string[], symptoms: string[], orgId?: string): Promise<Record<string, unknown>[]> {
  const filters = services.length > 0
    ? [
        { collection: "incidents", filter: { affectedServices: { $in: services } } },
        { collection: "events", filter: { service: { $in: services } } },
        { collection: "services", filter: { name: { $in: services } } },
        { collection: "runbooks", filter: { applicableServices: { $in: services } } },
        { collection: "postmortems", filter: {} }
      ]
    : [
        { collection: "incidents", filter: {} },
        { collection: "events", filter: {} },
        { collection: "runbooks", filter: {} },
        { collection: "postmortems", filter: {} }
      ];
  const results: Record<string, unknown>[] = [];
  for (const item of filters) {
    const docs = await qdrantMemoryQuery(item.collection, item.filter, 100, orgId).catch(() => []);
    results.push(...docs);
  }
  if (results.length > 0) return results;
  return qdrantMemorySearch(symptoms.join(" "), undefined, undefined);
}

export async function queryQdrantMemory(input: unknown): Promise<QueryQdrantMemoryResult> {
  const parsed = queryQdrantMemoryInputSchema.parse(input);
  invocationStarted("query_qdrant_memory", parsed);
  try {
    const services = parsed.services ?? [];
    const symptoms = parsed.symptoms ?? [];
    const orgId = typeof (input as { orgId?: unknown })?.orgId === "string" ? (input as { orgId: string }).orgId : undefined;
    const query = parsed.query ?? parsed.spl ?? parsed.description;
    const docs = await docsForServices(services, symptoms, orgId);
    if (services.length > 0) {
      const signals = services.slice(0, 5).map((service) => signalFromDocs(service, query, docs, symptoms));
      const result = {
        results: docs,
        eventCount: signals.reduce((sum, signal) => sum + signal.errorCount, 0),
        query,
        spl: query,
        serviceSignals: signals
      };
      invocationFinished("query_qdrant_memory", result);
      return result;
    }
    const result = { results: docs, eventCount: docs.length, query, spl: query };
    invocationFinished("query_qdrant_memory", result);
    return result;
  } catch (error: unknown) {
    invocationFailed("query_qdrant_memory", error);
    throw error;
  }
}

export const queryQdrantMemoryDefinition: AgentToolDefinition = {
  name: "query_qdrant_memory",
  description: "Retrieve current service context, runbooks, and incident memory from Qdrant for the investigation step.",
  inputSchema: queryQdrantMemorySchema
};

export const querySplunkLogs = queryQdrantMemory;
export const querySplunkLogsDefinition = queryQdrantMemoryDefinition;
export type QuerySplunkLogsResult = QueryQdrantMemoryResult;
