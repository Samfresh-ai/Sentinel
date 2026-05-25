import { GoogleGenAI } from "@google/genai";
import { createLogger } from "@operaiq/shared";
import { getBrainEnv } from "./env.js";

const logger = createLogger("operaiq-embedding");
const EMBEDDING_DIMENSIONS = 768;
const EMBEDDING_MODEL = "text-embedding-004";
const OFFLINE_EMBEDDING_MODEL = "operaiq-offline-hash-embedding";

const domainTokens = new Set([
  "accessdenied",
  "asset",
  "auth",
  "bucket",
  "cache",
  "checkout",
  "connection",
  "database",
  "denied",
  "dns",
  "error",
  "exhausted",
  "failure",
  "failing",
  "latency",
  "notification",
  "payment",
  "permission",
  "pool",
  "postgres",
  "read",
  "redis",
  "s3",
  "send",
  "template",
  "timeout"
]);

const tokenAliases = new Map([
  ["access", "accessdenied"],
  ["connections", "connection"],
  ["errors", "error"],
  ["notifications", "notification"],
  ["postgresql", "postgres"],
  ["reads", "read"],
  ["services", "service"],
  ["timeouts", "timeout"]
]);

let aiClient: GoogleGenAI | undefined;

function getAiClient(): GoogleGenAI {
  if (!aiClient) {
    const env = getBrainEnv();
    aiClient = new GoogleGenAI({
      vertexai: true,
      project: env.GOOGLE_CLOUD_PROJECT_ID,
      location: env.VERTEX_AI_LOCATION
    });
  }
  return aiClient;
}

function offlineToken(value: string): string {
  const normalized = tokenAliases.get(value) ?? value;
  if (normalized.length > 4 && normalized.endsWith("s")) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).map(offlineToken).filter((token) => token.length > 1);
}

function hashToken(token: string): number {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % EMBEDDING_DIMENSIONS;
}

function offlineEmbedding(text: string): number[] {
  const allTokens = tokenize(text);
  const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);
  for (const token of new Set(allTokens)) {
    const index = hashToken(token);
    vector[index] = (vector[index] ?? 0) + 1;
  }
  for (const token of new Set(allTokens.filter((item) => domainTokens.has(item)))) {
    const index = hashToken(token);
    vector[index] = (vector[index] ?? 0) + 1;
  }
  const magnitude = Math.hypot(...vector);
  return magnitude > 0 ? vector.map((value) => value / magnitude) : vector;
}

export function embeddingTextForIncident(input: {
  title: string;
  symptoms: string[];
  affectedServices: string[];
  rootCause: string | null;
  resolution: string | null;
  remediationSteps: string[];
}): string {
  return [
    `Title: ${input.title}`,
    `Symptoms: ${input.symptoms.join(", ")}`,
    `Affected services: ${input.affectedServices.join(", ")}`,
    input.rootCause ? `Root cause: ${input.rootCause}` : "",
    input.resolution ? `Resolution: ${input.resolution}` : "",
    input.remediationSteps.length > 0 ? `Remediation: ${input.remediationSteps.join(" -> ")}` : ""
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

export function embeddingTextForRunbook(input: {
  title: string;
  incidentType: string;
  applicableServices: string[];
  successCriteria: string;
  steps: Array<{ action: string; riskLevel: string }>;
}): string {
  return [
    `Runbook: ${input.title}`,
    `Incident type: ${input.incidentType}`,
    `Services: ${input.applicableServices.join(", ")}`,
    `Steps: ${input.steps.map((step) => `${step.action} (${step.riskLevel})`).join(" -> ")}`,
    `Success criteria: ${input.successCriteria}`
  ].join("\n");
}

export async function embedText(text: string): Promise<number[]> {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error("Cannot embed empty text");
  }

  const env = getBrainEnv();
  if (env.OPERAIQ_AI_PROVIDER === "offline") {
    return offlineEmbedding(trimmed);
  }

  const response = await getAiClient().models.embedContent({
    model: EMBEDDING_MODEL,
    contents: [trimmed],
    config: {
      outputDimensionality: EMBEDDING_DIMENSIONS
    }
  });
  const values = response.embeddings?.[0]?.values;
  if (!values || values.length !== EMBEDDING_DIMENSIONS) {
    logger.error({ receivedDimensions: values?.length ?? 0 }, "Vertex AI returned invalid embedding dimensions");
    throw new Error(`Expected ${EMBEDDING_DIMENSIONS} embedding dimensions from ${EMBEDDING_MODEL}`);
  }
  return values;
}

export { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, OFFLINE_EMBEDDING_MODEL };
