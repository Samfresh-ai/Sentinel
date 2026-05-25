import { z } from "zod";
import { splunkKvPut, splunkKvQuery } from "@operaiq/splunk-mcp";
import { generateRunbook } from "../gemini.js";
import { getRunbookSchema, type AgentToolDefinition } from "../tool-json-schemas.js";
import { asNumber, asString, asStringArray, invocationFailed, invocationFinished, invocationStarted } from "./common.js";
import type { RunbookResult, RunbookStepResult } from "./get-runbook.js";

export const sentinelGetRunbookInputSchema = z.object({
  incidentDescription: z.string().min(1),
  affectedServices: z.array(z.string().min(1)).default([])
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

async function saveGeneratedRunbook(input: { incidentDescription: string; affectedServices: string[] }): Promise<RunbookResult> {
  const generated = await generateRunbook(input);
  const now = new Date().toISOString();
  const inserted = await splunkKvPut("runbooks", null, {
    title: generated.title,
    incidentType: generated.incidentType,
    steps: generated.steps,
    applicableServices: input.affectedServices,
    successCriteria: generated.successCriteria,
    createdAt: now,
    updatedAt: now
  });
  return {
    id: inserted.key,
    title: generated.title,
    incidentType: generated.incidentType,
    steps: generated.steps,
    applicableServices: input.affectedServices,
    successCriteria: generated.successCriteria,
    similarity: 1,
    generated: true
  };
}

export async function sentinelGetRunbook(input: unknown): Promise<RunbookResult | null> {
  const parsed = sentinelGetRunbookInputSchema.parse(input);
  invocationStarted("get_runbook", parsed);
  try {
    const runbooks = parsed.affectedServices.length
      ? await splunkKvQuery("runbooks", { applicableServices: { $in: parsed.affectedServices } }, 25)
      : await splunkKvQuery("runbooks", {}, 25);
    const top = runbooks
      .map((doc) => ({ doc, score: overlapScore(doc, parsed.affectedServices) }))
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
  description: "Retrieve the most relevant Splunk KV Store runbook, generating one if no service match exists.",
  inputSchema: getRunbookSchema
};
