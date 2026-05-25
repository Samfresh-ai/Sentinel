import { z } from "zod";
import { getSplunkConfig, splunkHecRequest } from "./client.js";
import type { SplunkHECEvent } from "./types.js";

const hecResponseSchema = z.object({
  text: z.string().optional(),
  code: z.number().optional()
}).passthrough();

function normalizeEvent(event: SplunkHECEvent): SplunkHECEvent {
  const config = getSplunkConfig();
  return {
    time: event.time ?? Date.now() / 1000,
    host: event.host ?? config.SPLUNK_HOST,
    source: event.source ?? "sentinel",
    sourcetype: event.sourcetype ?? "_json",
    index: event.index ?? config.SPLUNK_INDEX,
    event: event.event
  };
}

export async function sendEvent(event: SplunkHECEvent | SplunkHECEvent[]): Promise<void> {
  const events = Array.isArray(event) ? event : [event];
  for (const item of events) {
    const response = await splunkHecRequest(hecResponseSchema, normalizeEvent(item));
    if (response.code !== undefined && response.code !== 0) {
      throw new Error(`Splunk HEC rejected event: ${response.text ?? response.code}`);
    }
  }
}
