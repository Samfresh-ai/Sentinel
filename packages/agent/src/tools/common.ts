import { z } from "zod";
import { createLogger } from "@operaiq/shared";
import { getAgentEnv } from "../env.js";

export const toolLogger = createLogger("operaiq-tools");

export function databaseName(): string {
  return getAgentEnv().MONGODB_DATABASE_NAME;
}

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

export function idToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "toString" in value && typeof value.toString === "function") {
    return value.toString();
  }
  return "";
}

export const isoDateStringSchema = z.string().datetime();

export function objectIdMatchExpression(id: string): Record<string, unknown> {
  return { $expr: { $eq: [{ $toString: "$_id" }, id] } };
}

export function dateFromStringExpression(field: string): Record<string, unknown> {
  return { $dateFromString: { dateString: field } };
}

export function invocationStarted(tool: string, input: unknown): void {
  toolLogger.info({ tool, input, timestamp: new Date().toISOString() }, "Tool invocation started");
}

export function invocationFinished(tool: string, result: unknown): void {
  toolLogger.info({ tool, result, timestamp: new Date().toISOString() }, "Tool invocation finished");
}

export function invocationFailed(tool: string, error: unknown): void {
  toolLogger.error({ tool, error, timestamp: new Date().toISOString() }, "Tool invocation failed");
}
