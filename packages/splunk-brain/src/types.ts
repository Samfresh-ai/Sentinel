import { z } from "zod";

export const splunkRecordSchema = z.record(z.unknown()).and(z.object({ _key: z.string().optional() }).passthrough());
export type SplunkRecord = z.infer<typeof splunkRecordSchema>;

export const splunkSearchResultSchema = z.record(z.unknown());
export type SplunkSearchResult = z.infer<typeof splunkSearchResultSchema>;

export const splunkEventSchema = z.record(z.unknown());
export type SplunkEvent = z.infer<typeof splunkEventSchema>;

export interface SplunkHECEvent {
  time?: number;
  host?: string;
  source?: string;
  sourcetype?: string;
  index?: string;
  fields?: Record<string, string | number | boolean>;
  event: Record<string, unknown>;
}

export interface SimilarIncident {
  id: string;
  title: string;
  rootCause: string | null;
  resolution: string | null;
  remediationSteps: string[];
  durationMinutes: number | null;
  severity: string;
  similarity: number;
}
