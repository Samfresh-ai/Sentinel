import { z } from "zod";
import { splunkSearch, type SplunkSearchResult } from "@operaiq/splunk-mcp";
import { querySplunkLogsSchema, type AgentToolDefinition } from "../tool-json-schemas.js";
import { invocationFailed, invocationFinished, invocationStarted } from "./common.js";

export const querySplunkLogsInputSchema = z.object({
  spl: z.string().min(1),
  timeRange: z
    .object({
      earliest: z.string().min(1),
      latest: z.string().min(1)
    })
    .optional(),
  description: z.string().min(1)
});

export interface QuerySplunkLogsResult {
  results: SplunkSearchResult[];
  eventCount: number;
  spl: string;
}

export async function querySplunkLogs(input: unknown): Promise<QuerySplunkLogsResult> {
  const parsed = querySplunkLogsInputSchema.parse(input);
  invocationStarted("query_splunk_logs", parsed);
  try {
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
