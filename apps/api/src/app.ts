import crypto from "node:crypto";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { ObjectId } from "mongodb";
import { z } from "zod";
import {
  closeMongoClient,
  createCollectionsAndIndexes,
  incidentsCollection,
  insertIncidentWithEmbedding,
  postmortemsCollection,
  runbooksCollection,
  servicesCollection,
  patternsCollection
} from "@operaiq/brain";
import {
  agentToolDefinitions,
  executeRemediation,
  getRunbook,
  getServiceDependencyGraph,
  runIncidentAgent,
  searchSimilarIncidents,
  writePostmortem
} from "@operaiq/agent";
import { runSentinelAgent } from "@operaiq/agent";
import {
  countDocuments,
  createCollection,
  getDocument,
  insertDocument,
  insertSentinelIncident,
  queryAllDocuments,
  queryDocuments,
  runSearch,
  updateDocument,
  updateSentinelIncident,
  writeAuditEntry
} from "@operaiq/splunk-brain";
import {
  createLogger,
  runtimeReadiness,
  normalizeAlertPayload,
  paginationQuerySchema,
  type AgentEvent,
  loadRootEnv,
  type NormalizedAlert
} from "@operaiq/shared";
import {
  addAgentEventHandler,
  decodePubSubJsonMessage,
  dispatchAgentEvent,
  publishAgentEvent,
  publishAlertEvent,
  startAgentEventsSubscription
} from "./pubsub.js";
import { verifyPubSubPushAuth } from "./pubsub-auth.js";
import { SplunkAlertPayload } from "./schemas/splunk-alert.js";
import { serializeIncident, serializePattern, serializePostmortem, serializeRunbook, serializeService } from "./serialize.js";
import { verifySlackSignature } from "./slack.js";
import { authRouter, requireAuth, verifyAuth, verifyWebhookOrg, type AuthenticatedRequest } from "./routes/auth.js";

loadRootEnv();

const logger = createLogger("operaiq-api");
const rawBodies = new WeakMap<Request, Buffer>();

function rawBodySaver(req: Request, _res: Response, buf: Buffer): void {
  rawBodies.set(req, Buffer.from(buf));
}

function asyncHandler(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next);
  };
}

function dependencyUnavailable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ECONNREFUSED";
}

function verifyWebhookSecret(req: Request): void {
  const expected = process.env.WEBHOOK_SECRET;
  if (!expected) {
    throw new Error("WEBHOOK_SECRET is not configured");
  }
  const actual = req.header("x-operaiq-secret") ?? "";
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  if (expectedBuffer.length !== actualBuffer.length || !crypto.timingSafeEqual(expectedBuffer, actualBuffer)) {
    const error = new Error("Invalid webhook secret");
    error.name = "Unauthorized";
    throw error;
  }
}

function verifyToolSecret(req: Request): void {
  const expected = process.env.AGENT_TOOL_SECRET ?? process.env.WEBHOOK_SECRET;
  if (!expected) {
    throw new Error("AGENT_TOOL_SECRET or WEBHOOK_SECRET is required for agent tool execution");
  }
  const bearer = req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const explicit = req.header("x-operaiq-tool-secret") ?? "";
  const actual = bearer.length > 0 ? bearer : explicit;
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  if (expectedBuffer.length !== actualBuffer.length || !crypto.timingSafeEqual(expectedBuffer, actualBuffer)) {
    const error = new Error("Invalid agent tool secret");
    error.name = "Unauthorized";
    throw error;
  }
}

async function createIncidentFromAlert(alert: NormalizedAlert): Promise<string> {
  const incidentId = await insertIncidentWithEmbedding({
    title: alert.title,
    severity: alert.severity,
    status: "open",
    symptoms: alert.symptoms,
    affectedServices: alert.affectedServices,
    rootCause: null,
    resolution: null,
    remediationSteps: [],
    detectedAt: new Date(alert.detectedAt),
    resolvedAt: null,
    durationMinutes: null,
    postMortemId: null
  });
  return incidentId.toHexString();
}

const SENTINEL_AUTONOMOUS_PAYMENT_SEARCH = "sentinel_auto_detect_payment_errors";

function severityFromSplunk(value: string | undefined): "P1" | "P2" | "P3" | "P4" {
  const normalized = value?.toUpperCase() ?? "";
  if (normalized === "5" || normalized === "6" || normalized.includes("P1") || normalized.includes("CRITICAL") || normalized.includes("FATAL")) return "P1";
  if (normalized === "4" || normalized.includes("P2") || normalized.includes("HIGH") || normalized.includes("ERROR")) return "P2";
  if (normalized === "3" || normalized.includes("P3") || normalized.includes("WARN")) return "P3";
  return "P4";
}

function splunkResultString(payload: SplunkAlertPayload, key: string): string | undefined {
  const value = (payload.result as Record<string, unknown>)[key];
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (typeof item === "number" && Number.isFinite(item)) return String(item);
        return "";
      })
      .filter((item) => item.length > 0);
    if (parts.length > 0) return parts.join(", ");
  }
  return undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringFromRecord(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function normalizeSplunkAlertBody(body: unknown): SplunkAlertPayload {
  if (!Array.isArray(body)) {
    const record = objectRecord(body);
    if (record && Array.isArray(record.result)) {
      const firstResult = record.result.map(objectRecord).find((item): item is Record<string, unknown> => item !== null) ?? {};
      return SplunkAlertPayload.parse({
        ...record,
        result: firstResult,
        results: record.result
      });
    }
    return SplunkAlertPayload.parse(body);
  }

  const firstResult = body.map(objectRecord).find((item): item is Record<string, unknown> => item !== null) ?? {};
  return SplunkAlertPayload.parse({
    result: firstResult,
    results: body,
    results_link: stringFromRecord(firstResult, "results_link") ?? process.env.SPLUNK_RESULTS_LINK ?? "http://localhost:8000/app/sentinel/search",
    search_name: stringFromRecord(firstResult, "search_name") ?? stringFromRecord(firstResult, "savedsearch_name") ?? "splunk_results_webhook",
    owner: stringFromRecord(firstResult, "owner") ?? "splunk",
    app: stringFromRecord(firstResult, "app") ?? "sentinel"
  });
}

function normalizeSplunkAlert(payload: SplunkAlertPayload): NormalizedAlert {
  if (payload.search_name === SENTINEL_AUTONOMOUS_PAYMENT_SEARCH || payload.search_name === "sentinel_demo_payment_redis_spike") {
    const errorCount = splunkResultString(payload, "error_count") ?? splunkResultString(payload, "count");
    return {
      source: "operaiq",
      title: `Splunk alert: ${payload.search_name}`,
      severity: "P3",
      affectedServices: ["payment-service"],
      symptoms: [
        "Redis ECONNRESET",
        "connection pool exhausted",
        "p99 latency elevated",
        "payment-service checkout failures",
        ...(errorCount ? [`error_count=${errorCount}`] : [])
      ],
      incidentType: payload.search_name,
      detectedAt: new Date().toISOString(),
      rawPayload: payload as unknown as Record<string, unknown>
    };
  }

  const service = splunkResultString(payload, "service") ?? splunkResultString(payload, "host") ?? splunkResultString(payload, "source") ?? "unknown-service";
  const symptoms = [
    payload.search_name,
    splunkResultString(payload, "sourcetype"),
    splunkResultString(payload, "source"),
    splunkResultString(payload, "_raw")
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return {
    source: "operaiq",
    title: `Splunk alert: ${payload.search_name}`,
    severity: severityFromSplunk(splunkResultString(payload, "severity") ?? payload.configuration?.severity),
    affectedServices: [service],
    symptoms: symptoms.length > 0 ? symptoms.slice(0, 12) : ["splunk saved search alert fired"],
    incidentType: payload.search_name,
    detectedAt: new Date().toISOString(),
    rawPayload: payload as unknown as Record<string, unknown>
  };
}

function demoRemediationWaitMs(req: Request, payload: SplunkAlertPayload): number | undefined {
  const value = req.header("x-sentinel-demo-remediation-wait-ms");
  if (!value) return undefined;
  const isDemoAlert =
    payload.search_name.startsWith("sentinel_demo_") || payload.search_name === SENTINEL_AUTONOMOUS_PAYMENT_SEARCH;
  if (!isDemoAlert) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 60_000) return undefined;
  return parsed;
}

function demoVerifyFailsBeforePass(req: Request, payload: SplunkAlertPayload): number | undefined {
  const value = req.header("x-sentinel-verify-fails-before-pass");
  if (!value) return undefined;
  const isDemoAlert =
    payload.search_name.startsWith("sentinel_demo_") || payload.search_name === SENTINEL_AUTONOMOUS_PAYMENT_SEARCH;
  if (!isDemoAlert) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 3) return undefined;
  return parsed;
}

function demoForceCrashPhase(req: Request, payload: SplunkAlertPayload): string | undefined {
  const value = req.header("x-sentinel-force-crash-phase");
  if (!value) return undefined;
  if (!payload.search_name.startsWith("sentinel_demo_")) return undefined;
  const normalized = value.toUpperCase();
  return ["ASSESS", "REMEMBER", "INVESTIGATE", "MAP", "RETRIEVE", "ACT", "VERIFY", "CLOSE"].includes(normalized) ? normalized : undefined;
}

async function checkSplunkWebhookRateLimit(orgId: string): Promise<{ allowed: boolean; retryAfter: number }> {
  await createCollection("rate_limit_windows", {});
  const key = `splunk-alert-${orgId}`;
  const now = Date.now();
  const current = await getDocument<Record<string, unknown>>("rate_limit_windows", key).catch(() => null);
  const windowStartMs = typeof current?.windowStart === "string" ? Date.parse(current.windowStart) : Number.NaN;
  const inWindow = Number.isFinite(windowStartMs) && now - windowStartMs < 60_000;
  const nextCount = inWindow && typeof current?.count === "number" ? current.count + 1 : 1;
  const document = {
    _key: key,
    orgId,
    windowStart: inWindow && typeof current?.windowStart === "string" ? current.windowStart : new Date(now).toISOString(),
    count: nextCount
  };
  if (current) {
    await updateDocument("rate_limit_windows", key, document);
  } else {
    await insertDocument("rate_limit_windows", document);
  }
  if (nextCount > 10) {
    void writeAuditEntry({
      orgId,
      incidentId: "webhook-rate-limit",
      timestamp: new Date().toISOString(),
      phase: "RATE_LIMITED",
      toolCalled: null,
      input: { endpoint: "/webhooks/splunk-alert", orgId },
      output: { count: nextCount },
      confidenceScore: null,
      durationMs: 0,
      success: false,
      errorMessage: "Splunk alert webhook rate limit exceeded"
    });
    return { allowed: false, retryAfter: 60 };
  }
  return { allowed: true, retryAfter: 0 };
}

async function createSentinelIncidentFromAlert(alert: NormalizedAlert, orgId: string): Promise<string> {
  return insertSentinelIncident({
    orgId,
    title: alert.title,
    severity: alert.severity,
    status: "open",
    symptoms: alert.symptoms,
    affectedServices: alert.affectedServices,
    rootCause: null,
    resolution: null,
    remediationSteps: [],
    detectedAt: alert.detectedAt,
    resolvedAt: null,
    durationMinutes: null,
    postMortemId: null,
    agentEvents: [],
    rawPayload: alert.rawPayload,
    remediationAttempts: 0,
    originalErrorCount: null,
    verifyResults: [],
    severityUpgradedFrom: null,
    severityUpgradeReason: null,
    correlationReport: [],
    rootCauseCandidate: null,
    bestSimilarityScore: null
  });
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asAgentEvents(value: unknown): AgentEvent[] {
  return Array.isArray(value) ? value.filter((item): item is AgentEvent => typeof item === "object" && item !== null) : [];
}

function serializeSentinelIncident(incident: Record<string, unknown>): Record<string, unknown> {
  return {
    id: asString(incident._key),
    title: asString(incident.title),
    severity: asString(incident.severity),
    status: asString(incident.status),
    symptoms: asStringArray(incident.symptoms),
    affectedServices: asStringArray(incident.affectedServices),
    rootCause: typeof incident.rootCause === "string" ? incident.rootCause : null,
    resolution: typeof incident.resolution === "string" ? incident.resolution : null,
    remediationSteps: asStringArray(incident.remediationSteps),
    detectedAt: asString(incident.detectedAt),
    resolvedAt: typeof incident.resolvedAt === "string" ? incident.resolvedAt : null,
    durationMinutes: asNumber(incident.durationMinutes),
    postMortemId: typeof incident.postMortemId === "string" ? incident.postMortemId : null,
    createdAt: asString(incident.createdAt),
    updatedAt: asString(incident.updatedAt),
    embeddingDimensions: 0,
    source: "sentinel",
    agentEvents: asAgentEvents(incident.agentEvents),
    remediationAttempts: asNumber(incident.remediationAttempts) ?? 0,
    originalErrorCount: asNumber(incident.originalErrorCount),
    verifyResults: Array.isArray(incident.verifyResults) ? incident.verifyResults : [],
    severityUpgradedFrom: typeof incident.severityUpgradedFrom === "string" ? incident.severityUpgradedFrom : null,
    severityUpgradeReason: typeof incident.severityUpgradeReason === "string" ? incident.severityUpgradeReason : null,
    correlationReport: Array.isArray(incident.correlationReport) ? incident.correlationReport : [],
    rootCauseCandidate: typeof incident.rootCauseCandidate === "string" ? incident.rootCauseCandidate : null,
    bestSimilarityScore: asNumber(incident.bestSimilarityScore)
  };
}

function serializeAuditEntry(entry: Record<string, unknown>): Record<string, unknown> {
  return {
    id: asString(entry._key),
    orgId: asString(entry.orgId),
    incidentId: asString(entry.incidentId),
    timestamp: asString(entry.timestamp),
    phase: asString(entry.phase),
    toolCalled: typeof entry.toolCalled === "string" ? entry.toolCalled : null,
    input: typeof entry.input === "object" && entry.input !== null ? entry.input : {},
    output: typeof entry.output === "object" && entry.output !== null ? entry.output : {},
    confidenceScore: asNumber(entry.confidenceScore),
    durationMs: asNumber(entry.durationMs) ?? 0,
    success: entry.success === true,
    errorMessage: typeof entry.errorMessage === "string" ? entry.errorMessage : null
  };
}

function serializeSentinelPostmortem(postmortem: Record<string, unknown>): Record<string, unknown> {
  return {
    id: asString(postmortem._key),
    incidentId: asString(postmortem.incidentId),
    title: asString(postmortem.title),
    summary: asString(postmortem.summary),
    timeline: Array.isArray(postmortem.timeline) ? postmortem.timeline : [],
    rootCause: asString(postmortem.rootCause),
    contributingFactors: asStringArray(postmortem.contributingFactors),
    remediationTaken: asStringArray(postmortem.remediationTaken),
    preventionActions: asStringArray(postmortem.preventionActions),
    lessonLearned: asString(postmortem.lessonLearned),
    generatedBy: asString(postmortem.generatedBy),
    createdAt: asString(postmortem.createdAt)
  };
}

function serializeSentinelService(service: Record<string, unknown>): Record<string, unknown> {
  return {
    id: asString(service._key) || asString(service.name),
    name: asString(service.name),
    team: asString(service.team),
    language: asString(service.language),
    dependencies: asStringArray(service.dependencies),
    dependents: asStringArray(service.dependents),
    knownFragilePoints: asStringArray(service.knownFragilePoints),
    slaMs: asNumber(service.slaMs) ?? 0,
    owners: asStringArray(service.owners),
    runbookIds: asStringArray(service.runbookIds),
    createdAt: asString(service.createdAt),
    updatedAt: asString(service.updatedAt),
    source: "sentinel"
  };
}

async function listSentinelIncidents(limit: number, orgId: string): Promise<Record<string, unknown>[]> {
  try {
    const docs = await queryDocuments<Record<string, unknown>>("incidents", {}, limit, { orgId });
    return docs.map(serializeSentinelIncident);
  } catch (error: unknown) {
    logger.warn({ error }, "Sentinel incidents unavailable for merged feed");
    return [];
  }
}

async function querySentinelCollection(collection: string, limit: number, orgId: string): Promise<Record<string, unknown>[]> {
  try {
    return await queryDocuments<Record<string, unknown>>(collection, {}, limit, { orgId });
  } catch (error: unknown) {
    logger.warn({ collection, error }, "Sentinel KV collection unavailable");
    return [];
  }
}

async function countSentinelCollection(collection: string, orgId: string): Promise<number> {
  try {
    return await countDocuments(collection, {}, { orgId });
  } catch (error: unknown) {
    logger.warn({ collection, error }, "Sentinel KV collection count unavailable");
    return 0;
  }
}

function splunkDashboardUrl(): string {
  return process.env.SPLUNK_DASHBOARD_URL ?? "http://localhost:8000/en-US/app/sentinel/sentinel_overview";
}

function finiteNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function durationSeconds(detectedMs: number, resolvedMs: number): number | null {
  if (detectedMs <= 0 || resolvedMs <= 0) return null;
  return Number((Math.max(0, resolvedMs - detectedMs) / 1000).toFixed(1));
}

function hourLabel(ms: number): string {
  return new Date(ms).toISOString().slice(11, 13) + ":00";
}

function resolutionTimeline(incidents: Record<string, unknown>[]): Array<{ label: string; count: number }> {
  const now = Date.now();
  const hourMs = 60 * 60_000;
  const start = Math.floor((now - 23 * hourMs) / hourMs) * hourMs;
  const buckets = Array.from({ length: 24 }, (_item, index) => {
    const bucketStart = start + index * hourMs;
    return { start: bucketStart, label: hourLabel(bucketStart), count: 0 };
  });
  for (const incident of incidents) {
    if (incident.status !== "resolved") continue;
    const resolvedMs = timestampMs(incident.resolvedAt ?? incident.updatedAt ?? incident.createdAt);
    if (resolvedMs < start) continue;
    const bucketIndex = Math.floor((resolvedMs - start) / hourMs);
    if (bucketIndex >= 0 && bucketIndex < buckets.length) buckets[bucketIndex]!.count += 1;
  }
  return buckets.map(({ label, count }) => ({ label, count }));
}

function severityDistribution(incidents: Record<string, unknown>[]): Array<{ severity: string; count: number }> {
  const counts = new Map<string, number>([
    ["P1", 0],
    ["P2", 0],
    ["P3", 0],
    ["P4", 0]
  ]);
  for (const incident of incidents) {
    const severity = asString(incident.severity) || "P4";
    counts.set(severity, (counts.get(severity) ?? 0) + 1);
  }
  return ["P1", "P2", "P3", "P4"].map((severity) => ({ severity, count: counts.get(severity) ?? 0 }));
}

async function serviceHealthFromSplunk(): Promise<Array<{ service: string; eventCount: number; errorCount: number; errorRate: number }>> {
  const results = await runSearch(
    'index=prod sourcetype=app earliest=-15m | stats count as event_count, count(eval(level="error")) as error_count by service | eval error_rate=round(error_count/event_count*100,1) | sort -error_rate',
    { maxResults: 20 }
  ).catch((error: unknown) => {
    logger.warn({ error }, "Splunk service health search failed");
    return [];
  });
  return results.map((result) => ({
    service: asString(result.service) || "unknown",
    eventCount: finiteNumber(result.event_count),
    errorCount: finiteNumber(result.error_count),
    errorRate: finiteNumber(result.error_rate)
  }));
}

function timestampMs(value: unknown): number {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : 0;
}

async function getSentinelIncidentView(id: string, orgId: string): Promise<{
  incident: Record<string, unknown>;
  postmortem: Record<string, unknown> | null;
  alertPayload: Record<string, unknown>;
} | null> {
  const incident = await getDocument<Record<string, unknown>>("incidents", id, { orgId }).catch(() => null);
  if (!incident) return null;
  const postMortemId = typeof incident.postMortemId === "string" ? incident.postMortemId : null;
  const postmortem = postMortemId ? await getDocument<Record<string, unknown>>("postmortems", postMortemId, { orgId }).catch(() => null) : null;
  return {
    incident: serializeSentinelIncident(incident),
    postmortem: postmortem ? serializeSentinelPostmortem(postmortem) : null,
    alertPayload: {
      title: asString(incident.title),
      severity: asString(incident.severity),
      affectedServices: asStringArray(incident.affectedServices),
      symptoms: asStringArray(incident.symptoms),
      detectedAt: asString(incident.detectedAt),
      rawPayload: incident.rawPayload
    }
  };
}

function severityForAlert(value: unknown): NormalizedAlert["severity"] {
  return value === "P1" || value === "P2" || value === "P3" || value === "P4" ? value : "P2";
}

const sentinelSimulationSchema = z.object({
  service: z.string().min(1),
  severity: z.enum(["P1", "P2", "P3", "P4"]),
  symptoms: z.array(z.string().min(1)).min(1)
});

function alertFromSentinelIncident(incident: Record<string, unknown>): NormalizedAlert {
  return {
    source: "operaiq",
    title: asString(incident.title),
    severity: severityForAlert(incident.severity),
    affectedServices: asStringArray(incident.affectedServices).length > 0 ? asStringArray(incident.affectedServices) : ["unknown-service"],
    symptoms: asStringArray(incident.symptoms).length > 0 ? asStringArray(incident.symptoms) : ["stale incident retry"],
    incidentType: typeof incident.incidentType === "string" ? incident.incidentType : undefined,
    detectedAt: asString(incident.detectedAt) || new Date().toISOString(),
    rawPayload: typeof incident.rawPayload === "object" && incident.rawPayload !== null ? incident.rawPayload as Record<string, unknown> : {}
  };
}

async function runSentinelForIncident(input: {
  incidentId: string;
  orgId: string;
  alert: NormalizedAlert;
  remediationWaitMs?: number;
  verifyFailsBeforePass?: number;
  forceCrashPhase?: string;
}): Promise<void> {
  const current = await getDocument<Record<string, unknown>>("incidents", input.incidentId, { orgId: input.orgId }).catch(() => null);
  const agentEvents = asAgentEvents(current?.agentEvents).slice();
  const result = await runSentinelAgent(input, async (event) => {
    logger.info({ event }, "Sentinel agent event");
    agentEvents.push(event);
    dispatchAgentEvent(event);
    await updateSentinelIncident(input.incidentId, input.orgId, { agentEvents });
  });
  logger.info({ incidentId: input.incidentId, result }, "Sentinel agent completed");
}

async function notifyDlqFailure(incident: Record<string, unknown>, orgId: string): Promise<void> {
  const targetService = asStringArray(incident.affectedServices)[0] ?? "unknown-service";
  await executeRemediation({
    action: "notify_team",
    targetService,
    parameters: {
      riskLevel: "low",
      severity: asString(incident.severity) || "P2",
      symptoms: asStringArray(incident.symptoms).join(", ") || "stale Sentinel incident",
      orgId,
      incidentId: asString(incident._key),
      reasoning: "Sentinel DLQ retries exceeded.",
      escalationMessage: `Sentinel failed - ${targetService}\nMax DLQ retries exceeded for incident ${asString(incident._key)}.\n@oncall please investigate.`
    }
  }).catch((error: unknown) => {
    logger.warn({ error, incidentId: asString(incident._key) }, "Failed to notify DLQ failure");
  });
}

async function flushDeadLetterQueue(options: { force?: boolean } = {}): Promise<{ retried: number; failed: number; scanned: number }> {
  await createCollection("dead_letter", {});
  const staleBefore = Date.now() - 5 * 60_000;
  const incidents = await queryAllDocuments<Record<string, unknown>>("incidents", { status: "in_progress" }, 1_000).catch(() => []);
  let retried = 0;
  let failed = 0;
  for (const incident of incidents) {
    const incidentId = asString(incident._key);
    const orgId = asString(incident.orgId);
    const updatedAt = timestampMs(incident.updatedAt);
    if (!incidentId || !orgId || (!options.force && updatedAt >= staleBefore)) continue;
    const currentDlq = await getDocument<Record<string, unknown>>("dead_letter", incidentId).catch(() => null);
    const attemptCount = asNumber(currentDlq?.attemptCount) ?? 0;
    if (attemptCount >= 3) {
      await updateSentinelIncident(incidentId, orgId, { status: "failed" });
      void writeAuditEntry({
        orgId,
        incidentId,
        timestamp: new Date().toISOString(),
        phase: "FAILED",
        toolCalled: null,
        input: { attemptCount },
        output: {},
        confidenceScore: null,
        durationMs: 0,
        success: false,
        errorMessage: "Max DLQ retries exceeded"
      });
      await notifyDlqFailure(incident, orgId);
      failed += 1;
      continue;
    }
    const nextAttempt = attemptCount + 1;
    const dlqDocument = {
      ...(currentDlq ?? {}),
      _key: incidentId,
      orgId,
      incidentId,
      errorMessage: typeof currentDlq?.errorMessage === "string" ? currentDlq.errorMessage : "Stale in_progress Sentinel incident",
      stackTrace: typeof currentDlq?.stackTrace === "string" ? currentDlq.stackTrace : "",
      attemptCount: nextAttempt,
      lastAttempt: new Date().toISOString(),
      createdAt: typeof currentDlq?.createdAt === "string" ? currentDlq.createdAt : new Date().toISOString()
    };
    if (currentDlq) {
      await updateDocument("dead_letter", incidentId, dlqDocument);
    } else {
      await insertDocument("dead_letter", dlqDocument);
    }
    void writeAuditEntry({
      orgId,
      incidentId,
      timestamp: new Date().toISOString(),
      phase: "DLQ_RETRY",
      toolCalled: null,
      input: { attemptCount: nextAttempt },
      output: {},
      confidenceScore: null,
      durationMs: 0,
      success: true,
      errorMessage: null
    });
    await runSentinelForIncident({ incidentId, orgId, alert: alertFromSentinelIncident(incident) });
    retried += 1;
  }
  return { retried, failed, scanned: incidents.length };
}

let dlqMaintenanceStarted = false;

function startDlqMaintenance(): void {
  if (dlqMaintenanceStarted) return;
  dlqMaintenanceStarted = true;
  const timer = setInterval(() => {
    flushDeadLetterQueue().catch((error: unknown) => {
      logger.warn({ error }, "Sentinel DLQ maintenance failed");
    });
  }, 120_000);
  timer.unref();
}

type ToolHandler = (input: unknown) => Promise<unknown>;

const toolHandlers: Record<string, ToolHandler> = {
  search_similar_incidents: searchSimilarIncidents,
  get_service_dependency_graph: getServiceDependencyGraph,
  get_runbook: getRunbook,
  execute_remediation: executeRemediation,
  write_postmortem: writePostmortem
};

function toolOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const tool of agentToolDefinitions) {
    paths[`/agent/tools/${tool.name}`] = {
      post: {
        operationId: tool.name,
        summary: tool.description,
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: tool.inputSchema
            }
          }
        },
        responses: {
          "200": {
            description: "Tool execution result",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["result"],
                  properties: {
                    result: {
                      description: "Tool-specific structured response"
                    }
                  }
                }
              }
            }
          },
          "401": { description: "Invalid agent tool secret" },
          "500": { description: "Tool execution failed" }
        }
      }
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "OperaIQ Agent Tools",
      version: "0.1.0"
    },
    servers: [
      {
        url: process.env.AGENT_TOOL_EXECUTION_BASE_URL ?? process.env.PUBLIC_APP_URL ?? "http://localhost:3001"
      }
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer"
        }
      }
    },
    paths
  };
}

export function createApp(): express.Express {
  const app = express();
  app.use(helmet());
  app.use(cors());
  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on("finish", () => {
      logger.info(
        {
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          durationMs: Date.now() - startedAt
        },
        "HTTP request completed"
      );
    });
    next();
  });
  app.use(express.json({ limit: "1mb", verify: rawBodySaver }));
  app.use(express.urlencoded({ extended: false, verify: rawBodySaver }));
  app.use("/auth", authRouter());

  app.get(
    "/health",
    asyncHandler(async (_req, res) => {
      const brainSize = await (await incidentsCollection()).countDocuments();
      res.json({ status: "ok", brainSize });
    })
  );

  app.get(
    "/runtime/readiness",
    asyncHandler(async (_req, res) => {
      res.json(runtimeReadiness());
    })
  );

  app.post(
    "/webhooks/alert",
    asyncHandler(async (req, res) => {
      verifyWebhookSecret(req);
      const alert = normalizeAlertPayload(req.body);
      const incidentId = await createIncidentFromAlert(alert);
      const messageId = await publishAlertEvent({ incidentId, alert });
      res.status(202).json({ incidentId, status: "open", pubsubMessageId: messageId });
    })
  );

  app.post(
    "/webhooks/splunk-alert",
    asyncHandler(async (req, res) => {
      const orgId = typeof req.query.orgId === "string" ? req.query.orgId : "";
      const secret = typeof req.query.secret === "string" ? req.query.secret : "";
      const org = await verifyWebhookOrg(orgId, secret);
      const payload = normalizeSplunkAlertBody(req.body);
      const rateLimit = await checkSplunkWebhookRateLimit(org.orgId);
      if (!rateLimit.allowed) {
        res.setHeader("Retry-After", String(rateLimit.retryAfter));
        res.status(429).json({ error: "Rate limit exceeded" });
        return;
      }
      const alert = normalizeSplunkAlert(payload);
      const remediationWaitMs = demoRemediationWaitMs(req, payload);
      const verifyFailsBeforePass = demoVerifyFailsBeforePass(req, payload);
      const forceCrashPhase = demoForceCrashPhase(req, payload);
      const incidentId = await createSentinelIncidentFromAlert(alert, org.orgId);
      setImmediate(() => {
        runSentinelForIncident({
          incidentId,
          orgId: org.orgId,
          alert,
          ...(remediationWaitMs !== undefined ? { remediationWaitMs } : {}),
          ...(verifyFailsBeforePass !== undefined ? { verifyFailsBeforePass } : {}),
          ...(forceCrashPhase !== undefined ? { forceCrashPhase } : {})
        })
          .catch((error: unknown) => {
            logger.error({ incidentId, error }, "Sentinel agent failed");
          });
      });
      res.status(202).json({ incidentId, status: "open", trigger: "splunk-alert-action" });
    })
  );

  app.post(
    "/pubsub/alerts",
    asyncHandler(async (req, res) => {
      await verifyPubSubPushAuth(req);
      const decoded = decodePubSubJsonMessage(req.body);
      const parsed = zodPubSubAgentPayload(decoded);
      const result = await runIncidentAgent(parsed, async (event) => {
        await publishAgentEvent(event);
      });
      res.status(result.status === "failed" ? 500 : 204).send();
    })
  );

  app.post(
    "/webhooks/slack/interactions",
    asyncHandler(async (req, res) => {
      const rawBody = rawBodies.get(req) ?? Buffer.from("");
      if (!verifySlackSignature(req, rawBody)) {
        res.status(401).json({ error: "Invalid Slack signature or missing SLACK_SIGNING_SECRET" });
        return;
      }
      const payloadField = typeof req.body.payload === "string" ? req.body.payload : "";
      const payload = JSON.parse(payloadField) as { actions?: Array<{ action_id?: string; value?: string }> };
      const action = payload.actions?.find((item) => item.action_id === "operaiq_approve_remediation");
      if (!action?.value) {
        res.status(400).json({ error: "No OperaIQ approval action found" });
        return;
      }
      const approved = JSON.parse(action.value) as {
        action: "scale_service" | "restart_pod" | "purge_cache" | "rotate_connection_pool" | "notify_team";
        targetService: string;
        parameters: Record<string, string | number>;
      };
      const result = await executeRemediation({
        action: approved.action,
        targetService: approved.targetService,
        parameters: {
          ...approved.parameters,
          riskLevel: "low",
          approvedByHuman: "true"
        }
      });
      res.json({ ok: true, result });
    })
  );

  app.get(
    "/agent/tools",
    asyncHandler(async (_req, res) => {
      res.json({ tools: agentToolDefinitions });
    })
  );

  app.get(
    "/agent/openapi.json",
    asyncHandler(async (_req, res) => {
      res.json(toolOpenApiDocument());
    })
  );

  app.post(
    "/agent/tools/:toolName",
    asyncHandler(async (req, res) => {
      verifyToolSecret(req);
      const toolName = typeof req.params.toolName === "string" ? req.params.toolName : "";
      const handler = toolHandlers[toolName];
      if (!handler) {
        res.status(404).json({ error: `Unknown agent tool ${toolName}` });
        return;
      }
      const result = await handler(req.body);
      res.json({ result });
    })
  );

  app.get(
    "/incidents",
    requireAuth,
    asyncHandler(async (req, res) => {
      const auth = (req as AuthenticatedRequest).auth ?? verifyAuth(req);
      const pagination = paginationQuerySchema.parse(req.query);
      const [sentinelItems, sentinelTotal] = await Promise.all([
        listSentinelIncidents(pagination.pageSize, auth.orgId),
        countSentinelCollection("incidents", auth.orgId)
      ]);
      const merged = [...sentinelItems]
        .sort((left, right) => {
          const leftTime = Date.parse(asString(left.detectedAt));
          const rightTime = Date.parse(asString(right.detectedAt));
          return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
        })
        .slice(0, pagination.pageSize);
      res.json({ items: merged, total: sentinelTotal, page: pagination.page, pageSize: pagination.pageSize });
    })
  );

  app.get(
    "/incidents/:id",
    requireAuth,
    asyncHandler(async (req, res) => {
      const auth = (req as AuthenticatedRequest).auth ?? verifyAuth(req);
      const id = typeof req.params.id === "string" ? req.params.id : "";
      const allowLegacyOperaIqIncident =
        process.env.OPERAIQ_LOCAL_VERIFY?.toLowerCase() === "true" && req.query.legacy === "operaiq";
      if (!ObjectId.isValid(id)) {
        const sentinel = await getSentinelIncidentView(id, auth.orgId);
        if (sentinel) {
          res.json(sentinel);
          return;
        }
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      if (!allowLegacyOperaIqIncident) {
        const sentinel = await getSentinelIncidentView(id, auth.orgId);
        if (sentinel) {
          res.json(sentinel);
          return;
        }
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      const incident = await (await incidentsCollection()).findOne({ _id: new ObjectId(id) });
      if (!incident) {
        const sentinel = await getSentinelIncidentView(id, auth.orgId);
        if (sentinel) {
          res.json(sentinel);
          return;
        }
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      const postmortem = incident.postMortemId
        ? await (await postmortemsCollection()).findOne({ _id: incident.postMortemId })
        : null;
      res.json({
        incident: serializeIncident(incident),
        postmortem: postmortem ? serializePostmortem(postmortem) : null,
        alertPayload: {
          title: incident.title,
          severity: incident.severity,
          affectedServices: incident.affectedServices,
          symptoms: incident.symptoms,
          detectedAt: incident.detectedAt.toISOString()
        }
      });
    })
  );

  app.get(
    "/audit/:incidentId",
    requireAuth,
    asyncHandler(async (req, res) => {
      const auth = (req as AuthenticatedRequest).auth ?? verifyAuth(req);
      const incidentId = typeof req.params.incidentId === "string" ? req.params.incidentId : "";
      const entries = await queryDocuments<Record<string, unknown>>("audit_log", { incidentId }, 10_000, { orgId: auth.orgId });
      const items = entries
        .map(serializeAuditEntry)
        .sort((left, right) => timestampMs(left.timestamp) - timestampMs(right.timestamp));
      res.json({ items, total: items.length });
    })
  );

  app.get(
    "/incidents/:id/stream",
    asyncHandler(async (req, res) => {
      const incidentId = typeof req.params.id === "string" ? req.params.id : "";
      if (!ObjectId.isValid(incidentId)) {
        res.status(400).end();
        return;
      }
      if (process.env.SENTINEL_MODE?.toLowerCase() !== "true" && process.env.OPERAIQ_LOCAL_VERIFY?.toLowerCase() !== "true") {
        await startAgentEventsSubscription();
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      const remove = addAgentEventHandler((event: AgentEvent) => {
        if (event.incidentId === incidentId) {
          res.write(`event: step\n`);
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      });
      req.on("close", () => {
        remove();
        res.end();
      });
    })
  );

  app.get(
    "/services",
    requireAuth,
    asyncHandler(async (_req, res) => {
      const auth = (_req as AuthenticatedRequest).auth ?? verifyAuth(_req);
      const [sentinelServices] = await Promise.all([
        querySentinelCollection("services", 1_000, auth.orgId)
      ]);
      const byName = new Map<string, Record<string, unknown>>();
      for (const service of sentinelServices.map(serializeSentinelService)) {
        byName.set(asString(service.name), service);
      }
      const items = Array.from(byName.values()).sort((left, right) => asString(left.name).localeCompare(asString(right.name)));
      res.json({ items });
    })
  );

  app.get(
    "/brain/stats",
    requireAuth,
    asyncHandler(async (_req, res) => {
      const auth = (_req as AuthenticatedRequest).auth ?? verifyAuth(_req);
      const since = new Date();
      since.setHours(0, 0, 0, 0);
      const [
        sentinelIncidentCount,
        sentinelRunbookCount,
        sentinelPatternCount,
        sentinelIncidents,
        sentinelRunbooks,
        sentinelPostmortems
      ] = await Promise.all([
        countSentinelCollection("incidents", auth.orgId),
        countSentinelCollection("runbooks", auth.orgId),
        countSentinelCollection("patterns", auth.orgId),
        querySentinelCollection("incidents", 10_000, auth.orgId),
        querySentinelCollection("runbooks", 5, auth.orgId),
        querySentinelCollection("postmortems", 10, auth.orgId)
      ]);
      const sentinelOpen = sentinelIncidents.filter((incident) => incident.status === "open").length;
      const sentinelInProgress = sentinelIncidents.filter((incident) => incident.status === "in_progress").length;
      const sentinelResolvedToday = sentinelIncidents.filter((incident) => {
        if (incident.status !== "resolved") return false;
        return timestampMs(incident.resolvedAt ?? incident.updatedAt ?? incident.createdAt) >= since.getTime();
      }).length;
      const brainGrowth = sentinelIncidents
        .filter((incident) => incident.status === "resolved")
        .sort((left, right) => timestampMs(left.resolvedAt ?? left.updatedAt ?? left.createdAt) - timestampMs(right.resolvedAt ?? right.updatedAt ?? right.createdAt))
        .slice(-10)
        .map((incident) => {
          const detectedMs = timestampMs(incident.detectedAt);
          const resolvedMs = timestampMs(incident.resolvedAt ?? incident.updatedAt);
          return {
            incidentId: asString(incident._key),
            title: asString(incident.title),
            severity: asString(incident.severity) || "P3",
            resolutionSeconds: durationSeconds(detectedMs, resolvedMs),
            bestSimilarityScore: asNumber(incident.bestSimilarityScore),
            resolvedAt: asString(incident.resolvedAt ?? incident.updatedAt)
          };
        });
      const mergedPostmortems = [
        ...sentinelPostmortems.map(serializeSentinelPostmortem)
      ]
        .sort((left, right) => timestampMs(right.createdAt) - timestampMs(left.createdAt))
        .slice(0, 5);
      res.json({
        incidentCount: sentinelIncidentCount,
        runbookCount: sentinelRunbookCount,
        patternCount: sentinelPatternCount,
        statusCounts: { open: sentinelOpen, inProgress: sentinelInProgress, resolvedToday: sentinelResolvedToday },
        topIncidentTypes: [...sentinelRunbooks].slice(0, 5).map((runbook, index) => ({
          name: "incidentType" in runbook && typeof runbook.incidentType === "string" ? runbook.incidentType : asString(runbook.title),
          count: Math.max(1, 5 - index)
        })),
        recentPostmortems: mergedPostmortems,
        brainGrowth
      });
    })
  );

  app.get(
    "/splunk/overview",
    requireAuth,
    asyncHandler(async (_req, res) => {
      const auth = (_req as AuthenticatedRequest).auth ?? verifyAuth(_req);
      const [incidents, auditEntries, serviceHealth] = await Promise.all([
        querySentinelCollection("incidents", 10_000, auth.orgId),
        querySentinelCollection("audit_log", 500, auth.orgId),
        serviceHealthFromSplunk()
      ]);
      const activeIncidents = incidents.filter((incident) => incident.status === "open" || incident.status === "in_progress").length;
      const recentAgentDecisions = auditEntries
        .map(serializeAuditEntry)
        .sort((left, right) => timestampMs(right.timestamp) - timestampMs(left.timestamp))
        .slice(0, 20)
        .map((entry) => ({
          timestamp: asString(entry.timestamp),
          phase: asString(entry.phase),
          toolCalled: typeof entry.toolCalled === "string" ? entry.toolCalled : null,
          durationMs: asNumber(entry.durationMs) ?? 0,
          success: entry.success === true,
          incidentId: asString(entry.incidentId)
        }));
      res.json({
        nativeDashboardUrl: splunkDashboardUrl(),
        activeIncidents,
        brainSize: incidents.filter((incident) => incident.status === "resolved").length,
        resolutionTimeline: resolutionTimeline(incidents),
        severityDistribution: severityDistribution(incidents),
        recentAgentDecisions,
        serviceHealth
      });
    })
  );

  app.post(
    "/simulate",
    requireAuth,
    asyncHandler(async (req, res) => {
      const auth = (req as AuthenticatedRequest).auth ?? verifyAuth(req);
      const body = sentinelSimulationSchema.parse(req.body);
      const alert: NormalizedAlert = {
        source: "operaiq",
        title: `Simulated Sentinel incident: ${body.service}`,
        severity: body.severity,
        affectedServices: [body.service],
        symptoms: body.symptoms,
        incidentType: `sentinel_sim_${body.service.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`,
        detectedAt: new Date().toISOString(),
        rawPayload: { source: "sentinel-ui-simulate", ...body }
      };
      const incidentId = await createSentinelIncidentFromAlert(alert, auth.orgId);
      setImmediate(() => {
        runSentinelForIncident({ incidentId, orgId: auth.orgId, alert }).catch((error: unknown) => {
          logger.error({ incidentId, error }, "Sentinel simulation failed");
        });
      });
      res.status(202).json({ incidentId, status: "open", trigger: "sentinel-simulate" });
    })
  );

  app.post(
    "/admin/dlq/flush",
    requireAuth,
    asyncHandler(async (_req, res) => {
      const result = await flushDeadLetterQueue({ force: true });
      res.json(result);
    })
  );

  startDlqMaintenance();

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status =
      error instanceof Error && error.name === "Unauthorized" ? 401 : error instanceof Error && error.name === "Forbidden" ? 403 : dependencyUnavailable(error) ? 503 : 500;
    const message =
      status === 401
        ? "Unauthorized"
        : status === 403
          ? "Forbidden"
          : status === 503
            ? "Sentinel dependency unavailable"
            : error instanceof Error
              ? error.message
              : "Unknown error";
    if (status >= 500) {
      logger.error({ error, method: _req.method, path: _req.path }, "API request failed");
    } else {
      logger.warn({ statusCode: status, method: _req.method, path: _req.path }, "API request rejected");
    }
    res.status(status).json({ error: message });
  });

  return app;
}

function zodPubSubAgentPayload(value: unknown): { incidentId: string; alert: NormalizedAlert } {
  const schema = runIncidentAgentInputSchemaForApi();
  return schema.parse(value);
}

function runIncidentAgentInputSchemaForApi() {
  return {
    parse(value: unknown): { incidentId: string; alert: NormalizedAlert } {
      if (typeof value !== "object" || value === null || !("incidentId" in value) || !("alert" in value)) {
        throw new Error("Invalid agent Pub/Sub payload");
      }
      const raw = value as { incidentId?: unknown; alert?: unknown };
      if (typeof raw.incidentId !== "string") {
        throw new Error("Invalid incident ID in Pub/Sub payload");
      }
      const alert = normalizeAlertPayload(raw.alert);
      return { incidentId: raw.incidentId, alert };
    }
  };
}

process.on("SIGTERM", () => {
  closeMongoClient()
    .catch((error: unknown) => {
      logger.error({ error }, "Failed to close MongoDB client on SIGTERM");
    })
    .finally(() => {
      process.exit(0);
    });
});
