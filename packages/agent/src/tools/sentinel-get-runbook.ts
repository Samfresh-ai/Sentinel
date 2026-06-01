import { z } from "zod";
import { qdrantMemoryPut, qdrantMemoryQuery } from "@sentinel/splunk-mcp";
import { generateRunbook } from "../gemini.js";
import { getRunbookSchema, type AgentToolDefinition } from "../tool-json-schemas.js";
import { asNumber, asString, asStringArray, invocationFailed, invocationFinished, invocationStarted } from "./common.js";

export type RunbookStepResult = {
  order: number;
  action: string;
  command: string | null;
  isExecutable: boolean;
  riskLevel: "low" | "medium" | "high";
};

export type RunbookResult = {
  id: string;
  title: string;
  incidentType: string;
  steps: RunbookStepResult[];
  applicableServices: string[];
  successCriteria: string;
  fallbackAction: string | null;
  similarity: number;
  generated: boolean;
};

export const sentinelGetRunbookInputSchema = z.object({
  incidentDescription: z.string().min(1),
  affectedServices: z.array(z.string().min(1)).default([]),
  rootCauseCandidate: z.string().min(1).nullable().optional(),
  orgId: z.string().min(1)
});

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

function mapRunbook(doc: Record<string, unknown>, generated: boolean, similarity = 0): RunbookResult {
  const steps = Array.isArray(doc.steps) ? doc.steps.map(mapStep).filter((step): step is RunbookStepResult => step !== null) : [];
  return {
    id: asString(doc._key),
    title: asString(doc.title),
    incidentType: asString(doc.incidentType),
    steps,
    applicableServices: asStringArray(doc.applicableServices),
    successCriteria: asString(doc.successCriteria),
    fallbackAction: typeof doc.fallbackAction === "string" ? doc.fallbackAction : null,
    similarity,
    generated
  };
}

function overlapScore(runbook: Record<string, unknown>, affectedServices: string[]): number {
  const applicable = asStringArray(runbook.applicableServices);
  if (affectedServices.length === 0 || applicable.length === 0) return 0;
  const matched = affectedServices.filter((service) => applicable.includes(service)).length;
  return Number((matched / affectedServices.length).toFixed(4));
}

function textTokens(value: string): Set<string> {
  return new Set((value.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((token) => token.length > 2));
}

function descriptionScore(runbook: Record<string, unknown>, incidentDescription: string): number {
  const incidentTokens = textTokens(incidentDescription);
  if (incidentTokens.size === 0) return 0;
  const runbookTokens = textTokens(
    [
      asString(runbook.title),
      asString(runbook.incidentType),
      asString(runbook.successCriteria),
      ...asStringArray(runbook.applicableServices),
      ...(Array.isArray(runbook.steps)
        ? runbook.steps.flatMap((step) => {
            if (typeof step !== "object" || step === null || Array.isArray(step)) return [];
            const doc = step as Record<string, unknown>;
            return [asString(doc.action), asString(doc.command)];
          })
        : [])
    ].join(" ")
  );
  const matched = [...incidentTokens].filter((token) => runbookTokens.has(token)).length;
  return Number((matched / incidentTokens.size).toFixed(4));
}

function combinedSimilarity(runbook: Record<string, unknown>, services: string[], description: string): number {
  return Number(Math.min(1, overlapScore(runbook, services) + descriptionScore(runbook, description)).toFixed(4));
}

async function saveGeneratedRunbook(input: { incidentDescription: string; affectedServices: string[]; orgId: string }): Promise<RunbookResult> {
  const generated = await generateRunbook(input);
  const now = new Date().toISOString();
  const inserted = await qdrantMemoryPut("runbooks", null, {
    title: generated.title,
    incidentType: generated.incidentType,
    steps: generated.steps,
    applicableServices: input.affectedServices,
    successCriteria: generated.successCriteria,
    fallbackAction: "notify_team",
    createdAt: now,
    updatedAt: now
  }, input.orgId);
  return {
    id: inserted.key,
    title: generated.title,
    incidentType: generated.incidentType,
    steps: generated.steps,
    applicableServices: input.affectedServices,
    successCriteria: generated.successCriteria,
    fallbackAction: "notify_team",
    similarity: 1,
    generated: true
  };
}

export async function sentinelGetRunbook(input: unknown): Promise<RunbookResult | null> {
  const parsed = sentinelGetRunbookInputSchema.parse(input);
  invocationStarted("get_runbook", parsed);
  try {
    const prioritizedServices = parsed.rootCauseCandidate
      ? [parsed.rootCauseCandidate, ...parsed.affectedServices.filter((service) => service !== parsed.rootCauseCandidate)]
      : parsed.affectedServices;
    const runbooks = prioritizedServices.length
      ? await qdrantMemoryQuery("runbooks", { applicableServices: { $in: prioritizedServices } }, 25, parsed.orgId)
      : await qdrantMemoryQuery("runbooks", {}, 25, parsed.orgId);
    const top = runbooks
      .map((doc) => ({
        doc,
        score: combinedSimilarity(doc, prioritizedServices, `${parsed.rootCauseCandidate ?? ""}\n${parsed.incidentDescription}`)
      }))
      .sort((left, right) => right.score - left.score)[0];
    if (top && top.score > 0) {
      const result = mapRunbook(top.doc, false, top.score);
      invocationFinished("get_runbook", result);
      return result;
    }
    const generated = await saveGeneratedRunbook(parsed);
    invocationFinished("get_runbook", generated);
    return generated;
  } catch (error: unknown) {
    invocationFailed("get_runbook", error);
    throw error;
  }
}

export const sentinelGetRunbookDefinition: AgentToolDefinition = {
  name: "get_runbook",
  description: "Retrieve the most relevant Qdrant memory runbook, generating one if no service match exists.",
  inputSchema: getRunbookSchema
};
