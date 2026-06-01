import { z } from "zod";
import { findSimilarIncidents } from "@sentinel/splunk-brain";
import { qdrantMemoryQuery } from "@sentinel/splunk-mcp";
import { searchSimilarIncidentsSchema, type AgentToolDefinition } from "../tool-json-schemas.js";
import { asNullableString, asNumber, asString, asStringArray, invocationFailed, invocationFinished, invocationStarted } from "./common.js";

export type SimilarIncident = {
  id: string;
  title: string;
  rootCause: string | null;
  resolution: string | null;
  remediationSteps: string[];
  durationMinutes: number | null;
  severity: string;
  similarity: number;
};

export const sentinelSearchSimilarIncidentsInputSchema = z.object({
  symptoms: z.array(z.string().min(1)).min(1),
  limit: z.number().int().positive().max(20).default(5),
  orgId: z.string().min(1),
  currentIncidentId: z.string().regex(/^[a-f\d]{24}$/i).optional()
});

function tokens(values: string[]): string[] {
  const stopwords = new Set(["sentinel", "test-timing", "service", "app", "prod", "alert"]);
  return [
    ...new Set(
      values
        .flatMap((value) => value.toLowerCase().match(/[a-z0-9]+/g) ?? [])
        .filter((token) => token.length > 2 && !stopwords.has(token))
    )
  ];
}

function localKeywordSimilarity(doc: Record<string, unknown>, symptomTerms: string[]): number {
  if (symptomTerms.length === 0) return 0;
  const candidateTerms = tokens(asStringArray(doc.symptoms));
  if (candidateTerms.length === 0) return 0;
  const matched = candidateTerms.filter((term) => symptomTerms.includes(term)).length;
  return Number(Math.min(0.95, matched / Math.max(1, candidateTerms.length - 1)).toFixed(4));
}

function mapIncident(doc: Record<string, unknown>, similarity: number): SimilarIncident {
  return {
    id: asString(doc._key) || asString(doc.incidentId),
    title: asString(doc.title),
    rootCause: asNullableString(doc.rootCause),
    resolution: asNullableString(doc.resolution),
    remediationSteps: asStringArray(doc.remediationSteps),
    durationMinutes: doc.durationMinutes === null ? null : asNumber(doc.durationMinutes, 0),
    severity: asString(doc.severity),
    similarity
  };
}

export async function sentinelSearchSimilarIncidents(input: unknown): Promise<SimilarIncident[]> {
  const parsed = sentinelSearchSimilarIncidentsInputSchema.parse(input);
  invocationStarted("search_similar_incidents", parsed);
  try {
    const qdrantMatches = await findSimilarIncidents(parsed.symptoms, parsed.limit, {
      orgId: parsed.orgId,
      ...(parsed.currentIncidentId ? { currentIncidentId: parsed.currentIncidentId } : {})
    });
    if (qdrantMatches.length > 0) {
      invocationFinished("search_similar_incidents", qdrantMatches);
      return qdrantMatches;
    }

    const docs = await qdrantMemoryQuery("incidents", { status: "resolved" }, 100, parsed.orgId);
    const symptomTerms = tokens(parsed.symptoms);
    const fallback = docs
      .filter((doc) => asString(doc._key) !== parsed.currentIncidentId)
      .map((doc) => mapIncident(doc, localKeywordSimilarity(doc, symptomTerms)))
      .filter((incident) => incident.similarity > 0)
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, parsed.limit);
    invocationFinished("search_similar_incidents", fallback);
    return fallback;
  } catch (error: unknown) {
    invocationFailed("search_similar_incidents", error);
    throw error;
  }
}

export const sentinelSearchSimilarIncidentsDefinition: AgentToolDefinition = {
  name: "search_similar_incidents",
  description: "Find resolved past OperaIQ incidents using Qdrant vector memory.",
  inputSchema: searchSimilarIncidentsSchema
};
