import { z } from "zod";
import { findSimilarIncidents } from "@operaiq/splunk-brain";
import { splunkKvQuery } from "@operaiq/splunk-mcp";
import { searchSimilarIncidentsSchema, type AgentToolDefinition } from "../tool-json-schemas.js";
import { asNullableString, asNumber, asString, asStringArray, invocationFailed, invocationFinished, invocationStarted } from "./common.js";
import type { SimilarIncident } from "./search-similar-incidents.js";

export const sentinelSearchSimilarIncidentsInputSchema = z.object({
  symptoms: z.array(z.string().min(1)).min(1),
  limit: z.number().int().positive().max(20).default(5)
});

function tokens(values: string[]): string[] {
  return [
    ...new Set(
      values
        .flatMap((value) => value.toLowerCase().match(/[a-z0-9]+/g) ?? [])
        .filter((token) => token.length > 2)
    )
  ];
}

function localKeywordSimilarity(doc: Record<string, unknown>, symptomTerms: string[]): number {
  if (symptomTerms.length === 0) return 0;
  const haystack = [
    asString(doc.title),
    asNullableString(doc.rootCause) ?? "",
    asNullableString(doc.resolution) ?? "",
    asStringArray(doc.symptoms).join(" "),
    asStringArray(doc.remediationSteps).join(" ")
  ]
    .join(" ")
    .toLowerCase();
  const matched = symptomTerms.filter((term) => haystack.includes(term)).length;
  return Number((matched / symptomTerms.length).toFixed(4));
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
    // Sentinel's score is honest keyword overlap from SPL/KV Store, not vector similarity.
    const splMatches = await findSimilarIncidents(parsed.symptoms, parsed.limit);
    if (splMatches.length > 0) {
      invocationFinished("search_similar_incidents", splMatches);
      return splMatches;
    }

    const docs = await splunkKvQuery("incidents", { status: "resolved" }, 100);
    const symptomTerms = tokens(parsed.symptoms);
    const fallback = docs
      .map((doc) => mapIncident(doc, localKeywordSimilarity(doc, symptomTerms)))
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
  description: "Find resolved past Sentinel incidents using SPL/KV keyword overlap against Splunk history.",
  inputSchema: searchSimilarIncidentsSchema
};
