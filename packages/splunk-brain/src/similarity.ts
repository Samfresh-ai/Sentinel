import { z } from "zod";
import { getQdrantConfig, qdrantRequest } from "./client.js";
import { ensureMemoryCollection } from "./collections.js";
import { embedQuery } from "./embedding.js";
import { qdrantPayloadFilter } from "./kvstore.js";
import type { SimilarIncident } from "./types.js";

const searchResponseSchema = z.object({
  result: z.array(
    z.object({
      score: z.number(),
      payload: z.record(z.unknown()).default({})
    }).passthrough()
  ).default([])
}).passthrough();

function stringField(doc: Record<string, unknown>, key: string): string {
  const value = doc[key];
  return typeof value === "string" ? value : "";
}

function numberField(doc: Record<string, unknown>, key: string): number | null {
  const value = doc[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function arrayField(doc: Record<string, unknown>, key: string): string[] {
  const value = doc[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function mapSimilarIncident(doc: Record<string, unknown>, similarity: number): SimilarIncident {
  return {
    id: stringField(doc, "incidentId") || stringField(doc, "_key"),
    title: stringField(doc, "title") || "Qdrant memory match",
    rootCause: stringField(doc, "rootCause") || null,
    resolution: stringField(doc, "resolution") || null,
    remediationSteps: arrayField(doc, "remediationSteps").length > 0 ? arrayField(doc, "remediationSteps") : arrayField(doc, "remediationTaken"),
    durationMinutes: numberField(doc, "durationMinutes"),
    severity: stringField(doc, "severity") || "P3",
    similarity: Number(Math.max(0, Math.min(1, similarity)).toFixed(4))
  };
}

export interface FindSimilarIncidentOptions {
  currentIncidentId?: string;
  orgId: string;
}

export async function findSimilarIncidents(symptoms: string[], limit = 5, options: FindSimilarIncidentOptions): Promise<SimilarIncident[]> {
  const queryText = symptoms.join("\n").trim();
  if (queryText.length === 0) return [];
  const vector = await embedQuery(queryText);
  await ensureMemoryCollection(vector.length);
  const config = getQdrantConfig();
  const response = await qdrantRequest(searchResponseSchema, {
    method: "POST",
    path: `/collections/${encodeURIComponent(config.QDRANT_COLLECTION)}/points/search`,
    json: {
      vector,
      limit: Math.max(limit * 4, 12),
      with_payload: true,
      with_vectors: false,
      filter: qdrantPayloadFilter({
        orgId: options.orgId,
        kind: { $in: ["incident_memory", "postmortem"] }
      })
    }
  });

  const byId = new Map<string, SimilarIncident>();
  for (const match of response.result ?? []) {
    const doc = match.payload ?? {};
    const id = stringField(doc, "incidentId") || stringField(doc, "_key");
    if (!id || id === options.currentIncidentId) continue;
    const incident = mapSimilarIncident(doc, match.score);
    const existing = byId.get(id);
    if (!existing || incident.similarity > existing.similarity) byId.set(id, incident);
  }
  return [...byId.values()].sort((left, right) => right.similarity - left.similarity).slice(0, limit);
}
