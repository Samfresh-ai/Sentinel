import { z } from "zod";
import { getQdrantEnv, type QdrantEnv } from "./env.js";

export type QdrantConfig = QdrantEnv;

export interface QdrantRequestInput {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  json?: unknown;
}

export function getQdrantConfig(): QdrantConfig {
  return getQdrantEnv();
}

function qdrantUrl(path: string, query?: QdrantRequestInput["query"]): string {
  const config = getQdrantConfig();
  const base = config.QDRANT_URL.replace(/\/+$/, "");
  const url = new URL(`${base}${path.startsWith("/") ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export async function qdrantRequest<T>(schema: z.ZodType<T>, input: QdrantRequestInput): Promise<T> {
  const config = getQdrantConfig();
  const init: RequestInit = {
    method: input.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(config.QDRANT_API_KEY ? { "api-key": config.QDRANT_API_KEY } : {})
    }
  };
  if (input.json !== undefined) {
    init.body = JSON.stringify(input.json);
  }
  const response = await fetch(qdrantUrl(input.path, input.query), init);
  const text = await response.text();
  const parsedBody = text.length > 0 ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`Qdrant ${input.method ?? "GET"} ${input.path} failed with ${response.status}: ${text}`);
  }
  return schema.parse(parsedBody);
}

export async function waitForQdrantReady(input: {
  attempts?: number;
  delayMs?: number;
  onRetry?: (attempt: number, message: string) => void;
} = {}): Promise<void> {
  const attempts = input.attempts ?? 60;
  const delayMs = input.delayMs ?? 1000;
  let last = "not checked";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await qdrantRequest(z.record(z.unknown()), { path: "/" });
      return;
    } catch (error: unknown) {
      last = error instanceof Error ? error.message : String(error);
      input.onRetry?.(attempt, last);
      await new Promise((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }
  }
  throw new Error(`Qdrant did not become ready: ${last}`);
}

export function describeQdrantEndpoints(): { url: string; collection: string } {
  const config = getQdrantConfig();
  return { url: config.QDRANT_URL, collection: config.QDRANT_COLLECTION };
}

// Legacy exports remain for old scripts. They are intentionally not used by the
// OperaIQ judge path.
export type SplunkConfig = {
  SPLUNK_HOST: string;
  SPLUNK_CLOUD_STACK_HOST?: string | undefined;
  SPLUNK_MGMT_URL?: string | undefined;
  SPLUNK_HEC_URL?: string | undefined;
  SPLUNK_USERNAME?: string | undefined;
  SPLUNK_PASSWORD?: string | undefined;
  SPLUNK_HEC_TOKEN?: string | undefined;
  SPLUNK_GATEWAY_TOKEN?: string | undefined;
  SPLUNK_APP: string;
  SPLUNK_INDEX: string;
};

export function getSplunkConfig(): SplunkConfig {
  return {
    SPLUNK_HOST: process.env.SPLUNK_HOST ?? "legacy-splunk-disabled",
    SPLUNK_CLOUD_STACK_HOST: process.env.SPLUNK_CLOUD_STACK_HOST || undefined,
    SPLUNK_MGMT_URL: process.env.SPLUNK_MGMT_URL || undefined,
    SPLUNK_HEC_URL: process.env.SPLUNK_HEC_URL || undefined,
    SPLUNK_USERNAME: process.env.SPLUNK_USERNAME || undefined,
    SPLUNK_PASSWORD: process.env.SPLUNK_PASSWORD || undefined,
    SPLUNK_HEC_TOKEN: process.env.SPLUNK_HEC_TOKEN || undefined,
    SPLUNK_GATEWAY_TOKEN: process.env.SPLUNK_GATEWAY_TOKEN || undefined,
    SPLUNK_APP: process.env.SPLUNK_APP ?? "legacy",
    SPLUNK_INDEX: process.env.SPLUNK_INDEX ?? "legacy"
  };
}

export async function splunkRestRequest<T>(_schema: z.ZodType<T>, _input?: unknown): Promise<T> {
  throw new Error("Legacy Splunk REST is not part of the OperaIQ Qdrant runtime path");
}

export async function splunkHecRequest<T>(_schema: z.ZodType<T>, _input?: unknown): Promise<T> {
  throw new Error("Legacy Splunk HEC is not part of the OperaIQ Qdrant runtime path");
}

export async function waitForSplunkReady(_input?: {
  attempts?: number;
  delayMs?: number;
  onRetry?: (attempt: number, message: string) => void;
}): Promise<void> {
  throw new Error("Legacy Splunk readiness is not part of the OperaIQ Qdrant runtime path");
}

export function describeSplunkEndpoints(): { managementUrl: string; hecUrl: string } {
  return { managementUrl: "legacy-splunk-disabled", hecUrl: "legacy-splunk-disabled" };
}
