import { z } from "zod";
import { splunkRestRequest } from "./client.js";
import { splunkSearchResultSchema, type SplunkEvent, type SplunkSearchResult } from "./types.js";

const oneshotSearchSchema = z.object({
  results: z.array(splunkSearchResultSchema).default([])
}).passthrough();

const createJobSchema = z.object({ sid: z.string() }).passthrough();
const jobStatusSchema = z.object({
  entry: z.array(
    z.object({
      content: z.object({ dispatchState: z.string().optional(), isDone: z.union([z.boolean(), z.number(), z.string()]).optional() }).passthrough()
    }).passthrough()
  ).default([])
}).passthrough();

const jobResultsSchema = z.object({ results: z.array(splunkSearchResultSchema).default([]) }).passthrough();

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeSearch(spl: string): string {
  const trimmed = spl.trim();
  if (trimmed.startsWith("|") || trimmed.startsWith("search ")) return trimmed;
  return `search ${trimmed}`;
}

export async function runSearch(
  spl: string,
  options: { earliestTime?: string; latestTime?: string; maxResults?: number } = {}
): Promise<SplunkSearchResult[]> {
  const maxResults = options.maxResults ?? 100;
  const search = normalizeSearch(spl);
  if (maxResults <= 1000) {
    const result = await splunkRestRequest(oneshotSearchSchema, {
      method: "POST",
      path: "/services/search/jobs",
      form: {
        output_mode: "json",
        exec_mode: "oneshot",
        search,
        earliest_time: options.earliestTime,
        latest_time: options.latestTime,
        count: maxResults
      }
    });
    return result.results ?? [];
  }

  const created = await splunkRestRequest(createJobSchema, {
    method: "POST",
    path: "/services/search/jobs",
    form: {
      output_mode: "json",
      search,
      earliest_time: options.earliestTime,
      latest_time: options.latestTime
    }
  });

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const status = await splunkRestRequest(jobStatusSchema, {
      path: `/services/search/jobs/${encodeURIComponent(created.sid)}`,
      query: { output_mode: "json" }
    });
    const content = (status.entry ?? [])[0]?.content;
    if (content?.dispatchState === "DONE" || content?.isDone === true || content?.isDone === 1 || content?.isDone === "1") break;
    await delay(1000);
  }

  const results = await splunkRestRequest(jobResultsSchema, {
    path: `/services/search/jobs/${encodeURIComponent(created.sid)}/results`,
    query: { output_mode: "json", count: maxResults }
  });
  return results.results ?? [];
}

export async function searchEvents(
  spl: string,
  timeRange: { earliest: string; latest: string }
): Promise<SplunkEvent[]> {
  return runSearch(spl, {
    earliestTime: timeRange.earliest,
    latestTime: timeRange.latest,
    maxResults: 1000
  });
}
