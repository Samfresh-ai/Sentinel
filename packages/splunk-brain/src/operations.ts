import { createKvKey, getDocument, insertDocument, updateDocument } from "./kvstore.js";
import type { SplunkRecord } from "./types.js";

export interface NewSentinelIncident {
  title: string;
  severity: string;
  status: "open" | "in_progress" | "resolved";
  symptoms: string[];
  affectedServices: string[];
  rootCause: string | null;
  resolution: string | null;
  remediationSteps: string[];
  detectedAt: string;
  resolvedAt: string | null;
  durationMinutes: number | null;
  postMortemId: string | null;
  rawPayload?: Record<string, unknown>;
}

export async function insertSentinelIncident(data: NewSentinelIncident): Promise<string> {
  const now = new Date().toISOString();
  const _key = createKvKey();
  const result = await insertDocument("incidents", {
    _key,
    ...data,
    createdAt: now,
    updatedAt: now
  });
  return result._key;
}

export async function getSentinelIncident(incidentId: string): Promise<SplunkRecord | null> {
  return getDocument<SplunkRecord>("incidents", incidentId);
}

export async function updateSentinelIncident(incidentId: string, updates: Record<string, unknown>): Promise<void> {
  await updateDocument("incidents", incidentId, {
    ...updates,
    updatedAt: new Date().toISOString()
  });
}
