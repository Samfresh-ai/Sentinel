import { ObjectId } from "mongodb";
import { z } from "zod";
import { embedText, embeddingTextForRunbook, runbooksCollection } from "@operaiq/brain";
import { generateRunbook } from "../gemini.js";
import { mongoAggregate, mongoFind } from "../mcp.js";
import {
  asNumber,
  asString,
  asStringArray,
  databaseName,
  idToString,
  invocationFailed,
  invocationFinished,
  invocationStarted
} from "./common.js";
import { getRunbookSchema, type AgentToolDefinition } from "../tool-json-schemas.js";

export const getRunbookInputSchema = z.object({
  incidentDescription: z.string().min(1),
  affectedServices: z.array(z.string().min(1)).default([])
});

export interface RunbookStepResult {
  order: number;
  action: string;
  command: string | null;
  isExecutable: boolean;
  riskLevel: "low" | "medium" | "high";
}

export interface RunbookResult {
  id: string;
  title: string;
  incidentType: string;
  steps: RunbookStepResult[];
  applicableServices: string[];
  successCriteria: string;
  similarity: number;
  generated: boolean;
}

function riskLevel(value: unknown): "low" | "medium" | "high" {
  return value === "medium" || value === "high" ? value : "low";
}

function mapStep(value: unknown): RunbookStepResult | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const doc = value as Record<string, unknown>;
  return {
    order: asNumber(doc.order, 1),
    action: asString(doc.action),
    command: typeof doc.command === "string" ? doc.command : null,
    isExecutable: doc.isExecutable === true,
    riskLevel: riskLevel(doc.riskLevel)
  };
}

function mapRunbook(doc: Record<string, unknown>, generated: boolean): RunbookResult {
  const steps = Array.isArray(doc.steps) ? doc.steps.map(mapStep).filter((step): step is RunbookStepResult => step !== null) : [];
  return {
    id: idToString(doc._id),
    title: asString(doc.title),
    incidentType: asString(doc.incidentType),
    steps,
    applicableServices: asStringArray(doc.applicableServices),
    successCriteria: asString(doc.successCriteria),
    similarity: asNumber(doc.score, generated ? 1 : 0),
    generated
  };
}

async function saveGeneratedRunbook(input: {
  incidentDescription: string;
  affectedServices: string[];
}): Promise<RunbookResult> {
  const generated = await generateRunbook(input);
  const runbookObjectId = new ObjectId();
  const runbookId = runbookObjectId.toHexString();
  const createdAt = new Date();
  const embedding = await embedText(
    embeddingTextForRunbook({
      title: generated.title,
      incidentType: generated.incidentType,
      applicableServices: input.affectedServices,
      successCriteria: generated.successCriteria,
      steps: generated.steps
    })
  );
  await (await runbooksCollection()).insertOne({
    _id: runbookObjectId,
    title: generated.title,
    incidentType: generated.incidentType,
    steps: generated.steps,
    applicableServices: input.affectedServices,
    successCriteria: generated.successCriteria,
    embedding,
    createdAt,
    updatedAt: createdAt
  });
  return {
    id: runbookId,
    title: generated.title,
    incidentType: generated.incidentType,
    steps: generated.steps,
    applicableServices: input.affectedServices,
    successCriteria: generated.successCriteria,
    similarity: 1,
    generated: true
  };
}

export async function getRunbook(input: unknown): Promise<RunbookResult | null> {
  const parsed = getRunbookInputSchema.parse(input);
  invocationStarted("get_runbook", parsed);
  try {
    const queryVector = await embedText(parsed.incidentDescription);
    const filter =
      parsed.affectedServices.length > 0
        ? { applicableServices: { $in: parsed.affectedServices } }
        : {};
    const docs = await mongoAggregate({
      database: databaseName(),
      collection: "runbooks",
      pipeline: [
        {
          $vectorSearch: {
            index: "runbook_vector_index",
            path: "embedding",
            queryVector,
            numCandidates: 50,
            limit: 1,
            filter
          }
        },
        { $addFields: { score: { $meta: "vectorSearchScore" } } }
      ],
      limit: 1
    });
    const top = docs[0] ? mapRunbook(docs[0], false) : null;
    if (top && top.similarity >= 0.7) {
      invocationFinished("get_runbook", top);
      return top;
    }

    const fallback = await mongoFind({
      database: databaseName(),
      collection: "runbooks",
      filter,
      limit: 1
    });
    if (!top && fallback[0]) {
      const fallbackRunbook = mapRunbook({ ...fallback[0], score: 0 }, false);
      if (fallbackRunbook.steps.length > 0 && fallbackRunbook.applicableServices.some((service) => parsed.affectedServices.includes(service))) {
        invocationFinished("get_runbook", fallbackRunbook);
        return fallbackRunbook;
      }
    }

    const generated = await saveGeneratedRunbook(parsed);
    invocationFinished("get_runbook", generated);
    return generated;
  } catch (error: unknown) {
    invocationFailed("get_runbook", error);
    throw error;
  }
}

export const getRunbookDefinition: AgentToolDefinition = {
  name: "get_runbook",
  description: "Retrieve the most relevant runbook, generating and saving an ad-hoc runbook when no confident match exists.",
  inputSchema: getRunbookSchema
};
