import { z } from "zod";
import { splunkHecSend, splunkKvGet, splunkKvPut } from "@sentinel/splunk-mcp";
import { generatePostmortemFields } from "../gemini.js";
import { writePostmortemSchema, type AgentToolDefinition } from "../tool-json-schemas.js";
import { asString, asStringArray, invocationFailed, invocationFinished, invocationStarted } from "./common.js";

export type WritePostmortemResult = {
  postmortemId: string;
  summary: string;
  preventionActions: string[];
  postmortemGeneratorStatus: "generated" | "fallback_after_error";
  postmortemGeneratorError: string | null;
};

export const sentinelWritePostmortemInputSchema = z.object({
  incidentId: z.string().regex(/^[a-f\d]{24}$/i),
  orgId: z.string().min(1),
  timeline: z.array(
    z.object({
      timestamp: z.string().datetime(),
      event: z.string().min(1),
      actor: z.enum(["sentinel", "human"])
    })
  ).min(1),
  rootCause: z.string().min(5),
  remediationTaken: z.array(z.string().min(1)).min(1),
  lessonLearned: z.string().min(5)
});

function durationMinutes(incident: Record<string, unknown>, closedAt: Date): number {
  const detected = new Date(asString(incident.detectedAt));
  if (Number.isFinite(detected.getTime())) {
    return Math.max(0, Math.round((closedAt.getTime() - detected.getTime()) / 60_000));
  }
  const existing = incident.durationMinutes;
  return typeof existing === "number" && Number.isFinite(existing) ? existing : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncateError(error: unknown): string {
  return errorMessage(error).replace(/\s+/g, " ").slice(0, 1_000);
}

export async function sentinelWritePostmortem(input: unknown): Promise<WritePostmortemResult> {
  const parsed = sentinelWritePostmortemInputSchema.parse(input);
  invocationStarted("write_postmortem", parsed);
  try {
    const incident = await splunkKvGet("incidents", parsed.incidentId, parsed.orgId);
    if (!incident) {
      throw new Error(`Sentinel incident ${parsed.incidentId} does not exist`);
    }
    let postmortemGeneratorStatus: WritePostmortemResult["postmortemGeneratorStatus"] = "generated";
    let postmortemGeneratorError: string | null = null;
    let generated: {
      summary: string;
      contributingFactors: string[];
      preventionActions: string[];
    };
    try {
      generated = await generatePostmortemFields({
        title: asString(incident.title),
        timeline: parsed.timeline,
        rootCause: parsed.rootCause,
        remediationTaken: parsed.remediationTaken,
        lessonLearned: parsed.lessonLearned
      });
    } catch (error: unknown) {
      postmortemGeneratorStatus = "fallback_after_error";
      postmortemGeneratorError = truncateError(error);
      generated = {
        summary: `Sentinel resolved ${asString(incident.title) || parsed.incidentId}, but the postmortem generator failed after retries. This postmortem preserves the verified remediation evidence without pretending an LLM summary was generated.`,
        contributingFactors: [
          parsed.rootCause,
          `Postmortem generator error: ${postmortemGeneratorError}`
        ],
        preventionActions: [
          parsed.lessonLearned,
          "Review generator availability separately; do not reopen or fail an incident that already acted and verified successfully."
        ]
      };
    }
    const createdAt = new Date();
    const duration = durationMinutes(incident, createdAt);
    const inserted = await splunkKvPut("postmortems", null, {
      orgId: parsed.orgId,
      incidentId: parsed.incidentId,
      title: `Post-mortem: ${asString(incident.title)}`,
      summary: generated.summary,
      timeline: parsed.timeline,
      rootCause: parsed.rootCause,
      contributingFactors: generated.contributingFactors,
      remediationTaken: parsed.remediationTaken,
      preventionActions: generated.preventionActions,
      lessonLearned: parsed.lessonLearned,
      generatedBy: "sentinel",
      postmortemGeneratorStatus,
      postmortemGeneratorError,
      createdAt: createdAt.toISOString()
    }, parsed.orgId);

    const resolution = parsed.remediationTaken.join(" -> ");
    await splunkKvPut("incidents", parsed.incidentId, {
      ...incident,
      status: "resolved",
      resolvedAt: createdAt.toISOString(),
      postMortemId: inserted.key,
      rootCause: parsed.rootCause,
      resolution,
      remediationSteps: parsed.remediationTaken,
      postmortemGeneratorStatus,
      postmortemGeneratorError,
      durationMinutes: duration,
      updatedAt: createdAt.toISOString()
    }, parsed.orgId);

    await splunkHecSend({
      sourcetype: "sentinel:postmortem",
      event: {
        type: "postmortem",
        orgId: parsed.orgId,
        incidentId: parsed.incidentId,
        title: asString(incident.title),
        severity: asString(incident.severity),
        symptoms: asStringArray(incident.symptoms),
        rootCause: parsed.rootCause,
        resolution,
        remediationSteps: parsed.remediationTaken,
        durationMinutes: duration,
        preventionActions: generated.preventionActions,
        generatedBy: "sentinel",
        postmortemGeneratorStatus,
        postmortemGeneratorError,
        createdAt: createdAt.toISOString()
      }
    });

    const result = {
      postmortemId: inserted.key,
      summary: generated.summary,
      preventionActions: generated.preventionActions,
      postmortemGeneratorStatus,
      postmortemGeneratorError
    };
    invocationFinished("write_postmortem", result);
    return result;
  } catch (error: unknown) {
    invocationFailed("write_postmortem", error);
    throw error;
  }
}

export const sentinelWritePostmortemDefinition: AgentToolDefinition = {
  name: "write_postmortem",
  description: "Generate a structured Sentinel post-mortem, update Splunk KV Store, and index it through HEC.",
  inputSchema: writePostmortemSchema
};
