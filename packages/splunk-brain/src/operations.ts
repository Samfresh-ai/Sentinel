import { createKvKey, getDocument, insertDocument, updateDocument } from "./kvstore.js";
import type { SplunkRecord } from "./types.js";

export interface NewSentinelIncident {
  orgId: string;
  title: string;
  severity: string;
  status: "open" | "in_progress" | "resolved" | "escalated" | "failed";
  symptoms: string[];
  affectedServices: string[];
  incidentType?: string | null;
  rootCause: string | null;
  resolution: string | null;
  remediationSteps: string[];
  detectedAt: string;
  resolvedAt: string | null;
  durationMinutes: number | null;
  postMortemId: string | null;
  agentEvents?: unknown[];
  rawPayload?: Record<string, unknown>;
  remediationAttempts?: number;
  originalErrorCount?: number | null;
  verifyResults?: unknown[];
  severityUpgradedFrom?: string | null;
  severityUpgradeReason?: string | null;
  correlationReport?: unknown[];
  rootCauseCandidate?: string | null;
  bestSimilarityScore?: number | null;
}

export async function insertSentinelIncident(data: NewSentinelIncident): Promise<string> {
  const now = new Date().toISOString();
  const _key = createKvKey();
  const result = await insertDocument("incidents", {
    _key,
    ...data,
    createdAt: now,
    updatedAt: now
  }, { orgId: data.orgId });
  return result._key;
}

export async function getSentinelIncident(incidentId: string, orgId: string): Promise<SplunkRecord | null> {
  return getDocument<SplunkRecord>("incidents", incidentId, { orgId });
}

export async function updateSentinelIncident(incidentId: string, orgId: string, updates: Record<string, unknown>): Promise<void> {
  await updateDocument("incidents", incidentId, {
    ...updates,
    updatedAt: new Date().toISOString()
  }, { orgId });
}
