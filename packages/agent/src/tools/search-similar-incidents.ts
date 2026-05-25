import { z } from "zod";
import { embedText } from "@operaiq/brain";
import { mongoAggregate, mongoFind } from "../mcp.js";
import { databaseName, asNullableString, asNumber, asString, asStringArray, idToString, invocationFailed, invocationFinished, invocationStarted } from "./common.js";
import { searchSimilarIncidentsSchema, type AgentToolDefinition } from "../tool-json-schemas.js";

export const searchSimilarIncidentsInputSchema = z.object({
  symptoms: z.array(z.string().min(1)).min(1),
  limit: z.number().int().positive().max(20).default(5)
});

export interface SimilarIncident {
  id: string;
  title: string;
  rootCause: string | null;
  resolution: string | null;
  remediationSteps: string[];
  durationMinutes: number | null;
  severity: string;
  similarity: number;
}

function mapIncident(doc: Record<string, unknown>): SimilarIncident {
  const duration = doc.durationMinutes === null ? null : asNumber(doc.durationMinutes, 0);
  return {
    id: idToString(doc._id),
    title: asString(doc.title),
    rootCause: asNullableString(doc.rootCause),
    resolution: asNullableString(doc.resolution),
    remediationSteps: asStringArray(doc.remediationSteps),
    durationMinutes: duration,
    severity: asString(doc.severity),
    similarity: asNumber(doc.score, 0)
  };
}

export async function searchSimilarIncidents(input: unknown): Promise<SimilarIncident[]> {
  const parsed = searchSimilarIncidentsInputSchema.parse(input);
  invocationStarted("search_similar_incidents", parsed);
  try {
    const queryText = parsed.symptoms.join("\n");
    const queryVector = await embedText(queryText);
    const docs = await mongoAggregate({
      database: databaseName(),
      collection: "incidents",
      pipeline: [
        {
          $vectorSearch: {
            index: "incident_vector_index",
            path: "embedding",
            queryVector,
            numCandidates: Math.max(parsed.limit * 20, 50),
            limit: parsed.limit,
            filter: { status: "resolved" }
          }
        },
        {
          $project: {
            title: 1,
            rootCause: 1,
            resolution: 1,
            remediationSteps: 1,
            durationMinutes: 1,
            severity: 1,
            score: { $meta: "vectorSearchScore" }
          }
        }
      ],
      limit: parsed.limit
    });
    const mapped = docs.map(mapIncident);
    if (mapped.length > 0) {
      invocationFinished("search_similar_incidents", mapped);
      return mapped;
    }

    const fallbackDocs = await mongoFind({
      database: databaseName(),
      collection: "incidents",
      filter: { status: "resolved" },
      projection: {
        title: 1,
        rootCause: 1,
        resolution: 1,
        remediationSteps: 1,
        durationMinutes: 1,
        severity: 1
      },
      sort: { detectedAt: -1 },
      limit: parsed.limit
    });
    const fallback = fallbackDocs.map((doc) => mapIncident({ ...doc, score: 0 }));
    invocationFinished("search_similar_incidents", fallback);
    return fallback;
  } catch (error: unknown) {
    invocationFailed("search_similar_incidents", error);
    throw error;
  }
}

export const searchSimilarIncidentsDefinition: AgentToolDefinition = {
  name: "search_similar_incidents",
  description: "Find resolved past incidents that semantically resemble current alert symptoms.",
  inputSchema: searchSimilarIncidentsSchema
};
