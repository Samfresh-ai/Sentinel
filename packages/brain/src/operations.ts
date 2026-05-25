import { ObjectId, type Document, type Filter } from "mongodb";
import {
  incidentsCollection,
  patternsCollection,
  runbooksCollection,
  serviceRuntimeConfigsCollection,
  servicesCollection
} from "./collections.js";
import {
  embedText,
  embeddingTextForIncident,
  embeddingTextForRunbook
} from "./embedding.js";
import type {
  IncidentDocument,
  IncidentVectorSearchResult,
  NewIncidentDocument,
  NewPatternDocument,
  NewRunbookDocument,
  NewServiceRuntimeConfigDocument,
  PatternDocument,
  RunbookDocument,
  RunbookVectorSearchResult,
  ServiceDocument
} from "./types.js";

export async function insertIncidentWithEmbedding(data: NewIncidentDocument): Promise<ObjectId> {
  const now = new Date();
  const embedding = await embedText(embeddingTextForIncident(data));
  const _id = new ObjectId();
  const result = await (await incidentsCollection()).insertOne({
    _id,
    ...data,
    embedding,
    createdAt: now,
    updatedAt: now
  });
  return result.insertedId;
}

export async function insertRunbookWithEmbedding(data: NewRunbookDocument): Promise<ObjectId> {
  const now = new Date();
  const embedding = await embedText(embeddingTextForRunbook(data));
  const _id = new ObjectId();
  const result = await (await runbooksCollection()).insertOne({
    _id,
    ...data,
    embedding,
    createdAt: now,
    updatedAt: now
  });
  return result.insertedId;
}

export async function insertPatternWithEmbedding(data: NewPatternDocument): Promise<ObjectId> {
  const now = new Date();
  const embedding = await embedText(`${data.name}\n${data.symptomSignals.join(", ")}\n${data.likelyCauses.join(", ")}`);
  const _id = new ObjectId();
  const result = await (await patternsCollection()).insertOne({
    _id,
    ...data,
    embedding,
    createdAt: now,
    updatedAt: now
  });
  return result.insertedId;
}

export async function upsertService(data: Omit<ServiceDocument, "_id" | "createdAt" | "updatedAt">): Promise<ObjectId> {
  const now = new Date();
  const result = await (await servicesCollection()).findOneAndUpdate(
    { name: data.name },
    {
      $set: { ...data, updatedAt: now },
      $setOnInsert: { createdAt: now }
    },
    { upsert: true, returnDocument: "after", projection: { _id: 1 } }
  );
  if (!result?._id) {
    throw new Error(`Unable to upsert service ${data.name}`);
  }
  return result._id;
}

export async function upsertServiceRuntimeConfig(data: NewServiceRuntimeConfigDocument): Promise<ObjectId> {
  const now = new Date();
  const result = await (await serviceRuntimeConfigsCollection()).findOneAndUpdate(
    { serviceName: data.serviceName },
    {
      $set: { ...data, updatedAt: now },
      $setOnInsert: { createdAt: now }
    },
    { upsert: true, returnDocument: "after", projection: { _id: 1 } }
  );
  if (!result?._id) {
    throw new Error(`Unable to upsert runtime config for service ${data.serviceName}`);
  }
  return result._id;
}

export async function searchIncidentVectors(
  queryText: string,
  limit: number,
  filter: Filter<IncidentDocument> = { status: "resolved" }
): Promise<IncidentVectorSearchResult[]> {
  const collection = await incidentsCollection();
  const queryVector = await embedText(queryText);
  const pipeline: Document[] = [
    {
      $vectorSearch: {
        index: "incident_vector_index",
        path: "embedding",
        queryVector,
        numCandidates: Math.max(limit * 20, 50),
        limit,
        filter
      }
    },
    {
      $project: {
        title: 1,
        severity: 1,
        rootCause: 1,
        resolution: 1,
        remediationSteps: 1,
        durationMinutes: 1,
        score: { $meta: "vectorSearchScore" }
      }
    }
  ];
  const results = await collection.aggregate<IncidentVectorSearchResult>(pipeline).toArray();
  if (results.length > 0) {
    return results;
  }

  const fallback = await collection
    .find(filter, {
      projection: {
        title: 1,
        severity: 1,
        rootCause: 1,
        resolution: 1,
        remediationSteps: 1,
        durationMinutes: 1
      },
      sort: { detectedAt: -1 },
      limit
    })
    .toArray();
  return fallback.map((incident) => ({
    _id: incident._id,
    title: incident.title,
    severity: incident.severity,
    rootCause: incident.rootCause,
    resolution: incident.resolution,
    remediationSteps: incident.remediationSteps,
    durationMinutes: incident.durationMinutes,
    score: 0
  }));
}

export async function searchRunbookVectors(
  queryText: string,
  affectedServices: string[],
  limit = 3
): Promise<RunbookVectorSearchResult[]> {
  const queryVector = await embedText(queryText);
  const overlapFilter =
    affectedServices.length > 0
      ? { applicableServices: { $in: affectedServices } }
      : {};
  const pipeline: Document[] = [
    {
      $vectorSearch: {
        index: "runbook_vector_index",
        path: "embedding",
        queryVector,
        numCandidates: Math.max(limit * 20, 50),
        limit,
        filter: overlapFilter
      }
    },
    { $addFields: { score: { $meta: "vectorSearchScore" } } }
  ];
  return (await runbooksCollection()).aggregate<RunbookVectorSearchResult>(pipeline).toArray();
}

export async function searchPatternVectors(queryText: string, limit = 5): Promise<Array<PatternDocument & { score: number }>> {
  const queryVector = await embedText(queryText);
  const pipeline: Document[] = [
    {
      $vectorSearch: {
        index: "pattern_vector_index",
        path: "embedding",
        queryVector,
        numCandidates: Math.max(limit * 20, 50),
        limit
      }
    },
    { $addFields: { score: { $meta: "vectorSearchScore" } } }
  ];
  return (await patternsCollection()).aggregate<Array<PatternDocument & { score: number }>[number]>(pipeline).toArray();
}

export async function refreshIncidentEmbedding(incident: IncidentDocument): Promise<void> {
  const embedding = await embedText(embeddingTextForIncident(incident));
  await (await incidentsCollection()).updateOne(
    { _id: incident._id },
    {
      $set: {
        embedding,
        updatedAt: new Date()
      }
    }
  );
}

export type { RunbookDocument };
