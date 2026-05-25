import { ObjectId } from "mongodb";
import { z } from "zod";
import { embedText, embeddingTextForIncident, incidentsCollection, postmortemsCollection } from "@operaiq/brain";
import { generatePostmortemFields } from "../gemini.js";
import {
  asString,
  asStringArray,
  invocationFailed,
  invocationFinished,
  invocationStarted
} from "./common.js";
import { writePostmortemSchema, type AgentToolDefinition } from "../tool-json-schemas.js";

export const writePostmortemInputSchema = z.object({
  incidentId: z.string().regex(/^[a-f\d]{24}$/i),
  timeline: z.array(
    z.object({
      timestamp: z.string().datetime(),
      event: z.string().min(1),
      actor: z.enum(["operaiq", "human"])
    })
  ).min(1),
  rootCause: z.string().min(5),
  remediationTaken: z.array(z.string().min(1)).min(1),
  lessonLearned: z.string().min(5)
});

export interface WritePostmortemResult {
  postmortemId: string;
}

function incidentEmbeddingInput(doc: Record<string, unknown>, rootCause: string, remediationTaken: string[]): {
  title: string;
  symptoms: string[];
  affectedServices: string[];
  rootCause: string | null;
  resolution: string | null;
  remediationSteps: string[];
} {
  return {
    title: asString(doc.title),
    symptoms: asStringArray(doc.symptoms),
    affectedServices: asStringArray(doc.affectedServices),
    rootCause,
    resolution: remediationTaken.join(" -> "),
    remediationSteps: remediationTaken
  };
}

export async function writePostmortem(input: unknown): Promise<WritePostmortemResult> {
  const parsed = writePostmortemInputSchema.parse(input);
  invocationStarted("write_postmortem", parsed);
  try {
    const incidentObjectId = new ObjectId(parsed.incidentId);
    const incident = await (await incidentsCollection()).findOne({ _id: incidentObjectId });
    if (!incident) {
      throw new Error(`Incident ${parsed.incidentId} does not exist`);
    }

    const generated = await generatePostmortemFields({
      title: asString(incident.title),
      timeline: parsed.timeline,
      rootCause: parsed.rootCause,
      remediationTaken: parsed.remediationTaken,
      lessonLearned: parsed.lessonLearned
    });
    const postmortemObjectId = new ObjectId();
    const postmortemId = postmortemObjectId.toHexString();
    const createdAt = new Date();
    const title = `Post-mortem: ${asString(incident.title)}`;

    await (await postmortemsCollection()).insertOne({
      _id: postmortemObjectId,
      incidentId: incidentObjectId,
      title,
      summary: generated.summary,
      timeline: parsed.timeline.map((item) => ({
        timestamp: new Date(item.timestamp),
        event: item.event,
        actor: item.actor
      })),
      rootCause: parsed.rootCause,
      contributingFactors: generated.contributingFactors,
      remediationTaken: parsed.remediationTaken,
      preventionActions: generated.preventionActions,
      lessonLearned: parsed.lessonLearned,
      generatedBy: "operaiq",
      createdAt
    });

    const embedding = await embedText(embeddingTextForIncident(incidentEmbeddingInput(incident, parsed.rootCause, parsed.remediationTaken)));
    const detectedAt = incident.detectedAt;
    const resolvedAt = createdAt;
    const durationMinutes = Number.isFinite(detectedAt.getTime())
      ? Math.max(0, Math.round((resolvedAt.getTime() - detectedAt.getTime()) / 60_000))
      : incident.durationMinutes ?? 0;

    await (await incidentsCollection()).updateOne({ _id: incidentObjectId }, {
      $set: {
        status: "resolved",
        resolvedAt,
        postMortemId: postmortemObjectId,
        rootCause: parsed.rootCause,
        resolution: parsed.remediationTaken.join(" -> "),
        remediationSteps: parsed.remediationTaken,
        durationMinutes,
        embedding,
        updatedAt: createdAt
      }
    });

    const result = { postmortemId };
    invocationFinished("write_postmortem", result);
    return result;
  } catch (error: unknown) {
    invocationFailed("write_postmortem", error);
    throw error;
  }
}

export const writePostmortemDefinition: AgentToolDefinition = {
  name: "write_postmortem",
  description: "Generate and write a structured post-mortem, update the incident, and refresh the incident embedding.",
  inputSchema: writePostmortemSchema
};
