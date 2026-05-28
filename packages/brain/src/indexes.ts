import type { Collection, Db, Document, SearchIndexDescription } from "mongodb";
import { createLogger } from "@operaiq/shared";
import { getDb } from "./client.js";
import {
  incidentsCollection,
  patternsCollection,
  postmortemsCollection,
  remediationExecutionsCollection,
  runbooksCollection,
  serviceRuntimeConfigsCollection,
  servicesCollection
} from "./collections.js";
import { EMBEDDING_DIMENSIONS } from "./embedding.js";

const logger = createLogger("operaiq-indexes");

type SearchIndexState = {
  name?: string;
  status?: string;
  queryable?: boolean;
  definition?: Document;
  latestDefinition?: Document;
};

async function ensureCollection(db: Db, name: string, validator: Document): Promise<void> {
  const exists = await db.listCollections({ name }).hasNext();
  if (!exists) {
    await db.createCollection(name, { validator });
    logger.info({ collection: name }, "Created MongoDB collection");
    return;
  }
  await db.command({ collMod: name, validator });
  logger.info({ collection: name }, "Updated MongoDB collection validator");
}

async function removeLegacyServiceOperationalFields(db: Db): Promise<void> {
  const exists = await db.listCollections({ name: "services" }).hasNext();
  if (!exists) {
    return;
  }
  const result = await db.collection("services").updateMany(
    {
      $or: [
        { incidentChannel: { $exists: true } },
        { adminBaseUrl: { $exists: true } },
        { cloudRunServiceName: { $exists: true } },
        { kubernetesNamespace: { $exists: true } }
      ]
    },
    {
      $unset: {
        incidentChannel: "",
        adminBaseUrl: "",
        cloudRunServiceName: "",
        kubernetesNamespace: ""
      }
    }
  );
  if (result.modifiedCount > 0) {
    logger.info({ modifiedCount: result.modifiedCount }, "Removed legacy operational fields from services collection");
  }
}

function vectorSearchDescription(name: string, path: string, filterPaths: string[] = []): SearchIndexDescription {
  return {
    name,
    type: "vectorSearch",
    definition: {
      fields: [
        {
          type: "vector",
          path,
          numDimensions: EMBEDDING_DIMENSIONS,
          similarity: "cosine"
        },
        ...filterPaths.map((filterPath) => ({
          type: "filter",
          path: filterPath
        }))
      ]
    }
  };
}

function vectorSearchIndexMatches(definition: Document | undefined, path: string, filterPaths: string[]): boolean {
  const fields = Array.isArray(definition?.fields) ? definition.fields : [];
  const hasVectorField = fields.some(
    (field) =>
      field?.type === "vector" &&
      field?.path === path &&
      field?.numDimensions === EMBEDDING_DIMENSIONS &&
      field?.similarity === "cosine"
  );
  const hasFilterFields = filterPaths.every((filterPath) =>
    fields.some((field) => field?.type === "filter" && field?.path === filterPath)
  );
  return hasVectorField && hasFilterFields;
}

async function waitForVectorSearchIndex<TSchema extends Document>(
  collection: Collection<TSchema>,
  name: string
): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const [index] = (await collection.listSearchIndexes(name).toArray()) as SearchIndexState[];
    if (index?.status === "READY" && index?.queryable === true) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 2000);
    });
  }
  throw new Error(`Atlas Vector Search index ${collection.collectionName}.${name} did not become queryable`);
}

async function ensureVectorSearchIndex<TSchema extends Document>(
  collection: Collection<TSchema>,
  name: string,
  path: string,
  filterPaths: string[] = []
): Promise<void> {
  try {
    const description = vectorSearchDescription(name, path, filterPaths);
    const existing = (await collection.listSearchIndexes(name).toArray()) as SearchIndexState[];
    if (existing.length > 0) {
      const definition = existing[0]?.latestDefinition ?? existing[0]?.definition;
      if (!vectorSearchIndexMatches(definition, path, filterPaths)) {
        await collection.updateSearchIndex(name, description.definition);
        logger.info({ index: name, collection: collection.collectionName }, "Updated Atlas Vector Search index");
        await waitForVectorSearchIndex(collection, name);
        return;
      }
      logger.info({ index: name, collection: collection.collectionName }, "Atlas Vector Search index exists");
      return;
    }
    await collection.createSearchIndex(description);
    logger.info({ index: name, collection: collection.collectionName }, "Created Atlas Vector Search index");
    await waitForVectorSearchIndex(collection, name);
  } catch (error: unknown) {
    if (isAtlasSearchIndexLimit(error)) {
      logger.warn({ error, index: name }, "Atlas Vector Search index quota reached; continuing with non-vector fallback search");
      return;
    }
    logger.error({ error, index: name }, "Unable to ensure Atlas Vector Search index");
    throw error;
  }
}

function isAtlasSearchIndexLimit(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown; errorResponse?: { errmsg?: unknown } };
  return (
    candidate.code === 20 &&
    (String(candidate.message ?? "").includes("maximum number of FTS indexes") ||
      String(candidate.errorResponse?.errmsg ?? "").includes("maximum number of FTS indexes"))
  );
}

const enumValues = {
  severity: ["P1", "P2", "P3", "P4"],
  status: ["open", "resolved", "in_progress"],
  risk: ["low", "medium", "high"]
};

export async function createCollectionsAndIndexes(): Promise<void> {
  const db = await getDb();
  await ensureCollection(db, "incidents", {
    $jsonSchema: {
      bsonType: "object",
      required: [
        "title",
        "severity",
        "status",
        "symptoms",
        "affectedServices",
        "rootCause",
        "resolution",
        "remediationSteps",
        "detectedAt",
        "resolvedAt",
        "durationMinutes",
        "embedding",
        "postMortemId",
        "createdAt",
        "updatedAt"
      ],
      properties: {
        title: { bsonType: "string" },
        severity: { enum: enumValues.severity },
        status: { enum: enumValues.status },
        symptoms: { bsonType: "array", items: { bsonType: "string" } },
        affectedServices: { bsonType: "array", items: { bsonType: "string" } },
        rootCause: { bsonType: ["string", "null"] },
        resolution: { bsonType: ["string", "null"] },
        remediationSteps: { bsonType: "array", items: { bsonType: "string" } },
        detectedAt: { bsonType: "date" },
        resolvedAt: { bsonType: ["date", "null"] },
        durationMinutes: { bsonType: ["int", "long", "double", "null"] },
        embedding: { bsonType: "array", minItems: EMBEDDING_DIMENSIONS, maxItems: EMBEDDING_DIMENSIONS },
        postMortemId: { bsonType: ["objectId", "null"] },
        createdAt: { bsonType: "date" },
        updatedAt: { bsonType: "date" }
      }
    }
  });

  await removeLegacyServiceOperationalFields(db);
  await ensureCollection(db, "services", {
    $jsonSchema: {
      bsonType: "object",
      additionalProperties: false,
      required: [
        "name",
        "team",
        "language",
        "dependencies",
        "dependents",
        "knownFragilePoints",
        "slaMs",
        "owners",
        "runbookIds",
        "createdAt",
        "updatedAt"
      ],
      properties: {
        _id: { bsonType: "objectId" },
        name: { bsonType: "string" },
        team: { bsonType: "string" },
        language: { bsonType: "string" },
        dependencies: { bsonType: "array", items: { bsonType: "string" } },
        dependents: { bsonType: "array", items: { bsonType: "string" } },
        knownFragilePoints: { bsonType: "array", items: { bsonType: "string" } },
        slaMs: { bsonType: ["int", "long", "double"] },
        owners: { bsonType: "array", items: { bsonType: "string" } },
        runbookIds: { bsonType: "array", items: { bsonType: "objectId" } },
        createdAt: { bsonType: "date" },
        updatedAt: { bsonType: "date" }
      }
    }
  });

  await ensureCollection(db, "service_runtime_configs", {
    $jsonSchema: {
      bsonType: "object",
      additionalProperties: false,
      required: ["serviceName", "incidentChannel", "adminBaseUrl", "cloudRunServiceName", "createdAt", "updatedAt"],
      properties: {
        _id: { bsonType: "objectId" },
        serviceName: { bsonType: "string" },
        incidentChannel: { bsonType: ["string", "null"] },
        adminBaseUrl: { bsonType: ["string", "null"] },
        cloudRunServiceName: { bsonType: ["string", "null"] },
        createdAt: { bsonType: "date" },
        updatedAt: { bsonType: "date" }
      }
    }
  });

  await ensureCollection(db, "runbooks", {
    $jsonSchema: {
      bsonType: "object",
      required: ["title", "incidentType", "steps", "applicableServices", "successCriteria", "embedding", "createdAt", "updatedAt"],
      properties: {
        title: { bsonType: "string" },
        incidentType: { bsonType: "string" },
        steps: {
          bsonType: "array",
          items: {
            bsonType: "object",
            required: ["order", "action", "command", "isExecutable", "riskLevel"],
            properties: {
              order: { bsonType: ["int", "long", "double"] },
              action: { bsonType: "string" },
              command: { bsonType: ["string", "null"] },
              isExecutable: { bsonType: "bool" },
              riskLevel: { enum: enumValues.risk }
            }
          }
        },
        applicableServices: { bsonType: "array", items: { bsonType: "string" } },
        successCriteria: { bsonType: "string" },
        embedding: { bsonType: "array", minItems: EMBEDDING_DIMENSIONS, maxItems: EMBEDDING_DIMENSIONS },
        createdAt: { bsonType: "date" },
        updatedAt: { bsonType: "date" }
      }
    }
  });

  await ensureCollection(db, "postmortems", {
    $jsonSchema: {
      bsonType: "object",
      required: [
        "incidentId",
        "title",
        "summary",
        "timeline",
        "rootCause",
        "contributingFactors",
        "remediationTaken",
        "preventionActions",
        "lessonLearned",
        "generatedBy",
        "createdAt"
      ],
      properties: {
        incidentId: { bsonType: "objectId" },
        title: { bsonType: "string" },
        summary: { bsonType: "string" },
        timeline: {
          bsonType: "array",
          items: {
            bsonType: "object",
            required: ["timestamp", "event", "actor"],
            properties: {
              timestamp: { bsonType: "date" },
              event: { bsonType: "string" },
              actor: { enum: ["operaiq", "human"] }
            }
          }
        },
        rootCause: { bsonType: "string" },
        contributingFactors: { bsonType: "array", items: { bsonType: "string" } },
        remediationTaken: { bsonType: "array", items: { bsonType: "string" } },
        preventionActions: { bsonType: "array", items: { bsonType: "string" } },
        lessonLearned: { bsonType: "string" },
        generatedBy: { enum: ["operaiq"] },
        createdAt: { bsonType: "date" }
      }
    }
  });

  await ensureCollection(db, "patterns", {
    $jsonSchema: {
      bsonType: "object",
      required: ["name", "symptomSignals", "likelyCauses", "confirmedCount", "embedding", "createdAt", "updatedAt"],
      properties: {
        name: { bsonType: "string" },
        symptomSignals: { bsonType: "array", items: { bsonType: "string" } },
        likelyCauses: { bsonType: "array", items: { bsonType: "string" } },
        confirmedCount: { bsonType: ["int", "long", "double"] },
        embedding: { bsonType: "array", minItems: EMBEDDING_DIMENSIONS, maxItems: EMBEDDING_DIMENSIONS },
        createdAt: { bsonType: "date" },
        updatedAt: { bsonType: "date" }
      }
    }
  });

  await ensureCollection(db, "remediation_executions", {
    $jsonSchema: {
      bsonType: "object",
      required: ["action", "targetService", "parameters", "riskLevel", "success", "output", "requiresHumanApproval", "executedAt", "createdAt"],
      properties: {
        action: { bsonType: "string" },
        targetService: { bsonType: "string" },
        parameters: { bsonType: "object" },
        riskLevel: { enum: enumValues.risk },
        success: { bsonType: "bool" },
        output: { bsonType: "string" },
        requiresHumanApproval: { bsonType: "bool" },
        executedAt: { bsonType: "date" },
        createdAt: { bsonType: "date" }
      }
    }
  });

  const incidents = await incidentsCollection();
  const services = await servicesCollection();
  const serviceRuntimeConfigs = await serviceRuntimeConfigsCollection();
  const runbooks = await runbooksCollection();
  const postmortems = await postmortemsCollection();
  const patterns = await patternsCollection();
  const remediationExecutions = await remediationExecutionsCollection();

  await incidents.createIndex({ status: 1, severity: 1, detectedAt: -1 });
  await services.createIndex({ name: 1 }, { unique: true });
  await services.createIndex({ dependencies: 1 });
  await serviceRuntimeConfigs.createIndex({ serviceName: 1 }, { unique: true });
  await runbooks.createIndex({ incidentType: 1 });
  await postmortems.createIndex({ incidentId: 1 }, { unique: true });
  await patterns.createIndex({ name: 1 }, { unique: true });
  await remediationExecutions.createIndex({ targetService: 1, executedAt: -1 });

  await ensureVectorSearchIndex(incidents, "incident_vector_index", "embedding", ["status"]);
  await ensureVectorSearchIndex(runbooks, "runbook_vector_index", "embedding", ["applicableServices"]);
  await ensureVectorSearchIndex(patterns, "pattern_vector_index", "embedding");
}
