import { z } from "zod";
import { splunkSearch, type SplunkSearchResult } from "@sentinel/splunk-mcp";
import { querySplunkLogsSchema, type AgentToolDefinition } from "../tool-json-schemas.js";
import { invocationFailed, invocationFinished, invocationStarted } from "./common.js";

export const querySplunkLogsInputSchema = z.object({
  spl: z.string().min(1).optional(),
  services: z.array(z.string().min(1)).optional(),
  symptoms: z.array(z.string().min(1)).optional(),
  timeRange: z
    .object({
      earliest: z.string().min(1),
      latest: z.string().min(1)
    })
    .optional(),
  description: z.string().min(1).default("Investigating current Splunk signals.")
});

export interface ServiceSignal {
  service: string;
  errorCount: number;
  dominantErrorType: string | null;
  status: "anomalous" | "elevated" | "clean";
  spl: string;
}

export interface QuerySplunkLogsResult {
  results: SplunkSearchResult[];
  eventCount: number;
  spl: string;
  serviceSignals?: ServiceSignal[];
}

function quoteSplunk(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

function serviceAliases(service: string): string[] {
  const aliases = new Set([service]);
  if (service === "payment-service") aliases.add("payment");
  return [...aliases];
}

function serviceSignalSpl(service: string, symptoms: string[]): string {
  const aliases = serviceAliases(service)
    .map((alias) => `service="${quoteSplunk(alias)}" OR source="${quoteSplunk(alias)}"`)
    .join(" OR ");
  const symptomTerms = symptoms
    .flatMap((symptom) => symptom.toLowerCase().match(/[a-z0-9_]+/g) ?? [])
    .filter((term) => term.length > 3)
    .slice(0, 6)
    .map((term) => `message="*${quoteSplunk(term)}*"`);
  const symptomClause = symptomTerms.length > 0 ? ` OR ${symptomTerms.join(" OR ")}` : "";
  return `index=prod sourcetype=app (${aliases}) (level=error OR error_type=* OR message="*failed*" OR message="*timeout*" OR message="*exhausted*"${symptomClause}) | eval signal=coalesce(error_type,message) | stats count as error_count by signal | sort - error_count`;
}

function numberField(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function signalFromResults(service: string, spl: string, results: SplunkSearchResult[]): ServiceSignal {
  const errorCount = results.reduce((sum, row) => sum + numberField(row.error_count ?? row.count), 0);
  const first = results[0];
  const dominant = typeof first?.signal === "string"
    ? first.signal
    : typeof first?.error_type === "string"
      ? first.error_type
      : typeof first?.message === "string"
        ? first.message
        : null;
  const status = errorCount > 20 ? "anomalous" : errorCount >= 5 ? "elevated" : "clean";
  return { service, errorCount, dominantErrorType: dominant, status, spl };
}

export async function querySplunkLogs(input: unknown): Promise<QuerySplunkLogsResult> {
  const parsed = querySplunkLogsInputSchema.parse(input);
  invocationStarted("query_splunk_logs", parsed);
  try {
    if (parsed.services && parsed.services.length > 0) {
      const signals: ServiceSignal[] = [];
      const allResults: SplunkSearchResult[] = [];
      for (const service of parsed.services.slice(0, 5)) {
        const spl = serviceSignalSpl(service, parsed.symptoms ?? []);
        const results = await splunkSearch(spl, parsed.timeRange?.earliest, parsed.timeRange?.latest);
        signals.push(signalFromResults(service, spl, results));
        allResults.push(...results.map((row) => ({ ...row, service })));
      }
      const result = {
        results: allResults,
        eventCount: signals.reduce((sum, signal) => sum + signal.errorCount, 0),
        spl: "multi-signal",
        serviceSignals: signals
      };
      invocationFinished("query_splunk_logs", result);
      return result;
    }
    if (!parsed.spl) {
      throw new Error("query_splunk_logs requires either spl or services");
    }
    const results = await splunkSearch(parsed.spl, parsed.timeRange?.earliest, parsed.timeRange?.latest);
    const result = { results, eventCount: results.length, spl: parsed.spl };
    invocationFinished("query_splunk_logs", result);
    return result;
  } catch (error: unknown) {
    invocationFailed("query_splunk_logs", error);
    throw error;
  }
}

export const querySplunkLogsDefinition: AgentToolDefinition = {
  name: "query_splunk_logs",
  description: "Run a targeted SPL search against live Splunk events and return typed results.",
  inputSchema: querySplunkLogsSchema
};
