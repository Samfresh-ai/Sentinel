import { z } from "zod";
import { createLogger } from "@sentinel/shared";

export const toolLogger = createLogger("sentinel-tools");

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export const isoDateStringSchema = z.string().datetime();

export function invocationStarted(tool: string, input: unknown): void {
  toolLogger.info({ tool, input, timestamp: new Date().toISOString() }, "Tool invocation started");
}

export function invocationFinished(tool: string, result: unknown): void {
  toolLogger.info({ tool, result, timestamp: new Date().toISOString() }, "Tool invocation finished");
}

export function invocationFailed(tool: string, error: unknown): void {
  toolLogger.error({ tool, error, timestamp: new Date().toISOString() }, "Tool invocation failed");
}
