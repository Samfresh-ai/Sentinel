import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { getAgentEnv } from "./env.js";

let aiClient: GoogleGenAI | undefined;

function getAiClient(): GoogleGenAI {
  if (!aiClient) {
    const env = getAgentEnv();
    aiClient = new GoogleGenAI({
      vertexai: true,
      project: env.GOOGLE_CLOUD_PROJECT_ID,
      location: env.VERTEX_AI_LOCATION
    });
  }
  return aiClient;
}

function isOfflineAiProvider(): boolean {
  return getAgentEnv().OPERAIQ_AI_PROVIDER === "offline";
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return JSON.parse(trimmed);
  }
  const fenced = trimmed.match(/```json\s*([\s\S]*?)\s*```/);
  if (fenced?.[1]) {
    return JSON.parse(fenced[1]);
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  }
  throw new Error("Gemini did not return JSON");
}

export const postmortemGeneratedFieldsSchema = z.object({
  summary: z.string().min(20),
  contributingFactors: z.array(z.string().min(3)).min(1),
  preventionActions: z.array(z.string().min(3)).min(1)
});

export type PostmortemGeneratedFields = z.infer<typeof postmortemGeneratedFieldsSchema>;

export async function generatePostmortemFields(input: {
  title: string;
  timeline: Array<{ timestamp: string; event: string; actor: "operaiq" | "human" }>;
  rootCause: string;
  remediationTaken: string[];
  lessonLearned: string;
}): Promise<PostmortemGeneratedFields> {
  if (isOfflineAiProvider()) {
    return postmortemGeneratedFieldsSchema.parse({
      summary: `${input.title} was resolved after OperaIQ correlated the timeline, root cause, and remediation evidence.`,
      contributingFactors: [
        input.rootCause,
        input.timeline.length > 1 ? "Multiple automated incident steps completed before closure." : "Limited timeline evidence was available."
      ],
      preventionActions: [
        input.lessonLearned,
        "Add an alert review check that captures service, dependency, and remediation context before the next incident."
      ]
    });
  }

  const prompt = [
    "Generate a concise structured SRE post-mortem JSON object.",
    "Return only JSON with keys summary, contributingFactors, preventionActions.",
    "Do not use generic filler. Make each field specific to the incident data.",
    JSON.stringify(input)
  ].join("\n");
  const response = await getAiClient().models.generateContent({
    model: "gemini-2.0-flash",
    contents: [{ role: "user", parts: [{ text: prompt }] }]
  });
  const text = response.text ?? "";
  return postmortemGeneratedFieldsSchema.parse(extractJson(text));
}

export const generatedRunbookSchema = z.object({
  title: z.string().min(5),
  incidentType: z.string().min(3),
  steps: z.array(
    z.object({
      order: z.number().int().positive(),
      action: z.string().min(5),
      command: z.string().nullable(),
      isExecutable: z.boolean(),
      riskLevel: z.enum(["low", "medium", "high"])
    })
  ).min(2),
  successCriteria: z.string().min(10)
});

export type GeneratedRunbook = z.infer<typeof generatedRunbookSchema>;

export async function generateRunbook(input: {
  incidentDescription: string;
  affectedServices: string[];
}): Promise<GeneratedRunbook> {
  if (isOfflineAiProvider()) {
    const service = input.affectedServices[0] ?? "affected-service";
    return generatedRunbookSchema.parse({
      title: `${service} incident triage`,
      incidentType: "offline-generated-incident-response",
      steps: [
        {
          order: 1,
          action: `Notify ${service} owners with symptoms and current incident link`,
          command: "notify_team",
          isExecutable: true,
          riskLevel: "low"
        },
        {
          order: 2,
          action: `Review recent deploys, permissions, and upstream dependency health for ${service}`,
          command: null,
          isExecutable: false,
          riskLevel: "medium"
        }
      ],
      successCriteria: `The ${service} incident has a clear owner notification, likely cause, and next mitigation step.`
    });
  }

  const prompt = [
    "Create an SRE runbook JSON object for OperaIQ.",
    "Only use executable commands from this set when the step can be automated: scale_service, restart_pod, purge_cache, rotate_connection_pool, notify_team.",
    "Low-risk steps may be executable. Medium and high-risk steps should generally be non-executable unless they only notify a team.",
    "Return only JSON with title, incidentType, steps, successCriteria.",
    JSON.stringify(input)
  ].join("\n");
  const response = await getAiClient().models.generateContent({
    model: "gemini-2.0-flash",
    contents: [{ role: "user", parts: [{ text: prompt }] }]
  });
  const text = response.text ?? "";
  return generatedRunbookSchema.parse(extractJson(text));
}

export const incidentConclusionSchema = z.object({
  rootCause: z.string().min(10),
  lessonLearned: z.string().min(10)
});

export type IncidentConclusion = z.infer<typeof incidentConclusionSchema>;

export async function generateIncidentConclusion(input: {
  alertTitle: string;
  symptoms: string[];
  similarIncidents: unknown;
  dependencyGraph: unknown;
  remediationResults: unknown;
}): Promise<IncidentConclusion> {
  if (isOfflineAiProvider()) {
    const primarySymptom = input.symptoms[0] ?? input.alertTitle;
    return incidentConclusionSchema.parse({
      rootCause: `Likely service regression causing ${primarySymptom}.`,
      lessonLearned: "Capture service ownership, dependency context, and remediation evidence before closing similar incidents."
    });
  }

  const prompt = [
    "Infer the most specific likely root cause and one concrete lesson learned for this incident.",
    "Return only JSON with keys rootCause and lessonLearned.",
    "Base the answer on the alert, similar incidents, dependency graph, and remediation results.",
    JSON.stringify(input)
  ].join("\n");
  const response = await getAiClient().models.generateContent({
    model: "gemini-2.0-flash",
    contents: [{ role: "user", parts: [{ text: prompt }] }]
  });
  const text = response.text ?? "";
  return incidentConclusionSchema.parse(extractJson(text));
}
