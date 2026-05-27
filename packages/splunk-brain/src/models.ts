import { createLogger } from "@operaiq/shared";
import { runSearch } from "./search.js";
import type { SplunkSearchResult } from "./types.js";

const logger = createLogger("sentinel-splunk-models");
const HOSTED_MODEL_TIMEOUT_MS = 5_000;
const HOSTED_MODEL_PROBE_SPL = '| makeresults | eval test="ping" | ai prompt="reply ok" provider="Splunk"';

class HostedModelProbeTimeoutError extends Error {
  constructor() {
    super(`Splunk Hosted Models probe exceeded ${HOSTED_MODEL_TIMEOUT_MS}ms`);
  }
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isHostedModelUnavailable(error: unknown): boolean {
  const message = stringifyError(error).toLowerCase();
  return (
    error instanceof HostedModelProbeTimeoutError ||
    message.includes(" 400:") ||
    message.includes(" 404:") ||
    message.includes("command not found") ||
    message.includes("unknown search command") ||
    message.includes("no configuration found") ||
    message.includes("no default llm configuration") ||
    message.includes("splunk hosted models")
  );
}

async function withTimeout<T>(operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new HostedModelProbeTimeoutError());
    }, HOSTED_MODEL_TIMEOUT_MS);
  });
  try {
    return await Promise.race([operation, timer]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function splunkString(value: string): string {
  return JSON.stringify(value);
}

function extractText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = extractText(item);
      if (text) return text;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["content", "text", "message", "answer", "response", "output"]) {
    const text = extractText(record[key]);
    if (text) return text;
  }
  return null;
}

function extractHostedModelText(result: SplunkSearchResult): string {
  for (const key of ["response", "ai_response", "answer", "completion", "content", "text", "output", "result", "_raw"]) {
    const text = extractText(result[key]);
    if (text) return text;
  }

  for (const value of Object.values(result)) {
    const text = extractText(value);
    if (text && text !== "ping") return text;
  }

  throw new Error("Splunk Hosted Models search returned a row without generated text");
}

export async function probeHostedModels(): Promise<boolean> {
  try {
    const results = await withTimeout(runSearch(HOSTED_MODEL_PROBE_SPL, { maxResults: 1 }));
    const available = results.length > 0;
    logger.info(`Splunk Hosted Models: available=${available}`);
    return available;
  } catch (error: unknown) {
    const message = stringifyError(error);
    if (!isHostedModelUnavailable(error)) {
      logger.warn({ error: message }, "Splunk Hosted Models probe failed");
    }
    logger.info("Splunk Hosted Models: available=false");
    return false;
  }
}

export const HOSTED_MODELS_AVAILABLE = await probeHostedModels();

export async function generateWithHostedModels(prompt: string): Promise<string> {
  const spl = `| makeresults | eval sentinel_prompt=${splunkString(prompt)} | ai prompt="{sentinel_prompt}" provider="Splunk"`;
  const results = await runSearch(spl, { maxResults: 1 });
  const result = results[0];
  if (!result) throw new Error("Splunk Hosted Models returned no results");
  return extractHostedModelText(result);
}
