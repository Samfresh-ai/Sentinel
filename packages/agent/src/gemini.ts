import { GoogleGenAI } from "@google/genai";
import { HOSTED_MODELS_AVAILABLE, generateWithHostedModels } from "@sentinel/splunk-brain/models";
import { z } from "zod";
import { getAgentEnv, type AgentEnv } from "./env.js";

let aiClient: GoogleGenAI | undefined;

function getAiClient(): GoogleGenAI {
  if (!aiClient) {
    const env = getAgentEnv();
    if (!env.GOOGLE_CLOUD_PROJECT_ID) {
      throw new Error("GOOGLE_CLOUD_PROJECT_ID is required when generation uses Vertex AI");
    }
    aiClient = new GoogleGenAI({
      vertexai: true,
      project: env.GOOGLE_CLOUD_PROJECT_ID,
      location: env.VERTEX_AI_LOCATION
    });
  }
  return aiClient;
}

type GenerationProvider = "vertex" | "offline" | "nvidia" | "openai-compatible";

function generationProvider(env: AgentEnv): GenerationProvider {
  return env.SENTINEL_GENERATION_PROVIDER ?? env.SENTINEL_AI_PROVIDER;
}

function isOfflineAiProvider(): boolean {
  return process.env.SENTINEL_LOCAL_VERIFY?.toLowerCase() === "true" || generationProvider(getAgentEnv()) === "offline";
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

function stringifyGeneratedValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";

  const record = value as Record<string, unknown>;
  for (const key of ["text", "description", "summary", "factor", "action", "recommendation", "step", "cause", "title", "name"]) {
    const field = record[key];
    if (typeof field === "string" && field.trim().length > 0) return field.trim();
  }

  return Object.entries(record)
    .map(([key, field]) => {
      if (typeof field === "string" || typeof field === "number" || typeof field === "boolean") return `${key}: ${field}`;
      if (Array.isArray(field)) {
        const values = field.map(stringifyGeneratedValue).filter(Boolean);
        return values.length > 0 ? `${key}: ${values.join(", ")}` : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("; ");
}

function normalizeGeneratedStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(stringifyGeneratedValue).filter((item) => item.length > 0);
  const single = stringifyGeneratedValue(value);
  return single.length > 0 ? [single] : [];
}

function normalizePostmortemGeneratedFields(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return {
    ...record,
    summary: stringifyGeneratedValue(record.summary),
    contributingFactors: normalizeGeneratedStringArray(record.contributingFactors),
    preventionActions: normalizeGeneratedStringArray(record.preventionActions)
  };
}

const openAiCompatibleChatResponseSchema = z.object({
  choices: z.array(
    z.object({
      message: z
        .object({
          content: z.string().nullable().optional()
        })
        .passthrough()
    }).passthrough()
  ).min(1)
}).passthrough();

function openAiCompatibleConfig(env: AgentEnv): { apiKey: string; baseUrl: string; model: string } {
  const provider = generationProvider(env);
  if (provider === "nvidia") {
    if (!env.NVIDIA_API_KEY) {
      throw new Error("NVIDIA_API_KEY is required when SENTINEL_GENERATION_PROVIDER=nvidia");
    }
    return {
      apiKey: env.NVIDIA_API_KEY,
      baseUrl: env.NVIDIA_BASE_URL,
      model: env.NVIDIA_MODEL
    };
  }

  if (!env.OPENAI_COMPATIBLE_API_KEY || !env.OPENAI_COMPATIBLE_BASE_URL || !env.OPENAI_COMPATIBLE_MODEL) {
    throw new Error(
      "OPENAI_COMPATIBLE_API_KEY, OPENAI_COMPATIBLE_BASE_URL, and OPENAI_COMPATIBLE_MODEL are required when SENTINEL_GENERATION_PROVIDER=openai-compatible"
    );
  }
  return {
    apiKey: env.OPENAI_COMPATIBLE_API_KEY,
    baseUrl: env.OPENAI_COMPATIBLE_BASE_URL,
    model: env.OPENAI_COMPATIBLE_MODEL
  };
}

async function generateOpenAiCompatibleText(prompt: string): Promise<string> {
  const config = openAiCompatibleConfig(getAgentEnv());
  const response = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 900
    })
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI-compatible generation failed with ${response.status}: ${body}`);
  }
  const parsed = openAiCompatibleChatResponseSchema.parse(JSON.parse(body));
  const text = parsed.choices[0]?.message.content;
  if (!text) {
    throw new Error("OpenAI-compatible generation returned an empty message");
  }
  return text;
}

async function generateJsonText(prompt: string): Promise<string> {
  const env = getAgentEnv();
  const provider = generationProvider(env);
  if (HOSTED_MODELS_AVAILABLE) {
    return generateWithHostedModels(prompt);
  }

  if (provider === "nvidia" || provider === "openai-compatible") {
    return generateOpenAiCompatibleText(prompt);
  }

  const response = await getAiClient().models.generateContent({
    model: "gemini-2.0-flash",
    contents: [{ role: "user", parts: [{ text: prompt }] }]
  });
  return response.text ?? "";
}

export async function generatePostmortemFields(input: {
  title: string;
  timeline: Array<{ timestamp: string; event: string; actor: "operaiq" | "sentinel" | "human" }>;
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
  const text = await generateJsonText(prompt);
  return postmortemGeneratedFieldsSchema.parse(normalizePostmortemGeneratedFields(extractJson(text)));
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
  const text = await generateJsonText(prompt);
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
  const text = await generateJsonText(prompt);
  return incidentConclusionSchema.parse(extractJson(text));
}
