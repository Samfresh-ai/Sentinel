import { z } from "zod";
import { qdrantMemoryGet, qdrantMemoryPut, qdrantMemorySend } from "@sentinel/splunk-mcp";
import { generatePostmortemFields } from "../gemini.js";
import { writePostmortemSchema, type AgentToolDefinition } from "../tool-json-schemas.js";
import { asString, asStringArray, invocationFailed, invocationFinished, invocationStarted } from "./common.js";

export type WritePostmortemResult = {
  postmortemId: string;
  summary: string;
  preventionActions: string[];
};

export const sentinelWritePostmortemInputSchema = z.object({
  incidentId: z.string().regex(/^[a-f\d]{24}$/i),
  orgId: z.string().min(1),
  timeline: z.array(
    z.object({
      timestamp: z.string().datetime(),
      event: z.string().min(1),
      actor: z.enum(["operaiq", "sentinel", "human"])
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

export async function sentinelWritePostmortem(input: unknown): Promise<WritePostmortemResult> {
  const parsed = sentinelWritePostmortemInputSchema.parse(input);
  invocationStarted("write_postmortem", parsed);
  try {
    const incident = await qdrantMemoryGet("incidents", parsed.incidentId, parsed.orgId);
    if (!incident) {
      throw new Error(`OperaIQ incident ${parsed.incidentId} does not exist`);
    }
    const generated = await generatePostmortemFields({
      title: asString(incident.title),
      timeline: parsed.timeline,
      rootCause: parsed.rootCause,
      remediationTaken: parsed.remediationTaken,
      lessonLearned: parsed.lessonLearned
    });
    const createdAt = new Date();
    const duration = durationMinutes(incident, createdAt);
    const inserted = await qdrantMemoryPut("postmortems", null, {
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
      generatedBy: "operaiq",
      createdAt: createdAt.toISOString()
    }, parsed.orgId);

    const resolution = parsed.remediationTaken.join(" -> ");
    await qdrantMemoryPut("incidents", parsed.incidentId, {
      ...incident,
      status: "resolved",
      resolvedAt: createdAt.toISOString(),
      postMortemId: inserted.key,
      rootCause: parsed.rootCause,
      resolution,
      remediationSteps: parsed.remediationTaken,
      durationMinutes: duration,
      updatedAt: createdAt.toISOString()
    }, parsed.orgId);

    await qdrantMemorySend({
      sourcetype: "operaiq:postmortem",
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
        generatedBy: "operaiq",
        createdAt: createdAt.toISOString()
      }
    });

    const result = {
      postmortemId: inserted.key,
      summary: generated.summary,
      preventionActions: generated.preventionActions
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
  description: "Generate a structured OperaIQ post-mortem and write it to Qdrant memory.",
  inputSchema: writePostmortemSchema
};
