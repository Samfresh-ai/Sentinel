import crypto from "node:crypto";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { z } from "zod";
import {
  executeRemediation,
  queryQdrantMemory,
  runSentinelAgent,
  sentinelAgentToolDefinitions,
  sentinelGetRunbook,
  sentinelGetServiceDependencyGraph,
  sentinelSearchSimilarIncidents,
  sentinelWritePostmortem
} from "@sentinel/agent";
import {
  countDocuments,
  createCollection,
  createKvKey,
  getDocument,
  insertDocument,
  insertSentinelIncident,
  queryAllDocuments,
  queryDocuments,
  updateDocument,
  updateSentinelIncident,
  writeAuditEntry
} from "@sentinel/splunk-brain";
import {
  createLogger,
  isProductionRuntime,
  normalizeAlertPayload,
  runtimeReadiness,
  paginationQuerySchema,
  type AgentEvent,
  loadRootEnv,
  type NormalizedAlert
} from "@sentinel/shared";
import {
  addAgentEventHandler,
  dispatchAgentEvent
} from "./agent-events.js";
import { SplunkAlertPayload } from "./schemas/splunk-alert.js";
import { verifySlackSignature } from "./slack.js";
import { authRouter, requireAuth, verifyAuth, verifyWebhookOrg, type AuthenticatedRequest } from "./routes/auth.js";

loadRootEnv();

const logger = createLogger("operaiq-api");
const rawBodies = new WeakMap<Request, Buffer>();
const adminRemediationBodySchema = z.object({
  action: z.enum(["scale_service", "restart_pod", "purge_cache", "rotate_connection_pool", "notify_team"]),
  targetService: z.string().min(1),
  parameters: z.record(z.union([z.string(), z.number()])).default({})
});
const createProjectBodySchema = z.object({
  name: z.string().min(2).max(80),
  service: z.string().min(1).max(80).default("payment-service"),
  environment: z.string().min(1).max(40).default("local")
});
const appLogSchema = z.object({
  level: z.enum(["debug", "info", "warn", "error", "fatal"]).default("error"),
  service: z.string().min(1).max(80).default("payment-service"),
  message: z.string().min(1).max(4_000),
  stack: z.string().max(12_000).optional(),
  errorName: z.string().max(160).optional(),
  traceId: z.string().max(160).optional(),
  requestId: z.string().max(160).optional(),
  route: z.string().max(240).optional(),
  statusCode: z.number().int().min(100).max(599).optional(),
  latencyMs: z.number().min(0).max(120_000).optional(),
  timestamp: z.string().datetime().optional(),
  metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({})
});
const ingestProjectLogsBodySchema = z.object({
  logs: z.array(appLogSchema).min(1).max(80)
});
const qdrantPatternWebhookBodySchema = z.object({
  patternAlertId: z.string().min(1),
  orgId: z.string().min(1),
  projectId: z.string().min(1),
  projectName: z.string().min(1),
  service: z.string().min(1),
  severity: z.enum(["P1", "P2", "P3", "P4"]),
  fingerprint: z.string().min(1),
  logCount: z.number().int().positive(),
  symptoms: z.array(z.string().min(1)).min(1),
  sampleMessages: z.array(z.string()).default([]),
  rawPayload: z.record(z.unknown()).default({})
});

type AppLog = z.infer<typeof appLogSchema>;
type QdrantPatternWebhookBody = z.infer<typeof qdrantPatternWebhookBodySchema>;

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

function healthErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function configuredCorsOrigins(): Set<string> {
  const values = [
    process.env.PUBLIC_APP_URL,
    process.env.NEXT_PUBLIC_API_URL,
    process.env.API_PUBLIC_URL,
    process.env.AGENT_TOOL_EXECUTION_BASE_URL,
    ...(process.env.CORS_ALLOWED_ORIGINS ?? "").split(",")
  ];
  return new Set(
    values
      .map((value) => value?.trim().replace(/\/+$/, ""))
      .filter((value): value is string => Boolean(value))
  );
}

type CorsOriginCallback = (error: Error | null, allow?: boolean) => void;

function corsOptions(): Parameters<typeof cors>[0] {
  if (!isProductionRuntime()) return {};
  const allowedOrigins = configuredCorsOrigins();
  return {
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "x-sentinel-secret", "x-sentinel-tool-secret"],
    origin(origin: string | undefined, callback: CorsOriginCallback) {
      if (!origin || allowedOrigins.has(origin.replace(/\/+$/, ""))) {
        callback(null, true);
        return;
      }
      callback(new Error("CORS origin is not allowed by OperaIQ"));
    }
  };
}

function verifyToolSecret(req: Request): void {
  const expected = process.env.AGENT_TOOL_SECRET ?? process.env.WEBHOOK_SECRET;
  if (!expected) {
    throw new Error("AGENT_TOOL_SECRET or WEBHOOK_SECRET is required for agent tool execution");
  }
  const bearer = req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const explicit = req.header("x-sentinel-tool-secret") ?? "";
  const actual = bearer.length > 0 ? bearer : explicit;
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  if (expectedBuffer.length !== actualBuffer.length || !crypto.timingSafeEqual(expectedBuffer, actualBuffer)) {
    const error = new Error("Invalid agent tool secret");
    error.name = "Unauthorized";
    throw error;
  }
}

const SENTINEL_AUTONOMOUS_PAYMENT_SEARCH = "operaiq_auto_detect_payment_errors";

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

function isSentinelId(value: string): boolean {
  return /^[a-f\d]{24}$/i.test(value);
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
  if (payload.search_name === SENTINEL_AUTONOMOUS_PAYMENT_SEARCH || payload.search_name === "sentinel_test_payment_redis_spike") {
    const errorCount = splunkResultString(payload, "error_count") ?? splunkResultString(payload, "count");
    return {
      source: "operaiq",
      title: `Legacy alert: ${payload.search_name}`,
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
    title: `Legacy alert: ${payload.search_name}`,
    severity: severityFromSplunk(splunkResultString(payload, "severity") ?? payload.configuration?.severity),
    affectedServices: [service],
    symptoms: symptoms.length > 0 ? symptoms.slice(0, 12) : ["legacy saved search alert fired"],
    incidentType: payload.search_name,
    detectedAt: new Date().toISOString(),
    rawPayload: payload as unknown as Record<string, unknown>
  };
}

function testControlsAllowed(): boolean {
  return process.env.SENTINEL_TEST_CONTROLS?.toLowerCase() === "true" && !isProductionRuntime();
}

function testControlRemediationWaitMs(req: Request, payload: SplunkAlertPayload): number | undefined {
  if (!testControlsAllowed()) return undefined;
  const value = req.header("x-sentinel-test-remediation-wait-ms");
  if (!value) return undefined;
  const isSeedAlert =
    payload.search_name.startsWith("sentinel_test_") || payload.search_name === SENTINEL_AUTONOMOUS_PAYMENT_SEARCH;
  if (!isSeedAlert) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 60_000) return undefined;
  return parsed;
}

function testControlVerifyFailsBeforePass(req: Request, payload: SplunkAlertPayload): number | undefined {
  if (!testControlsAllowed()) return undefined;
  const value = req.header("x-sentinel-verify-fails-before-pass");
  if (!value) return undefined;
  const isSeedAlert =
    payload.search_name.startsWith("sentinel_test_") || payload.search_name === SENTINEL_AUTONOMOUS_PAYMENT_SEARCH;
  if (!isSeedAlert) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 3) return undefined;
  return parsed;
}

function testControlForceCrashPhase(req: Request, payload: SplunkAlertPayload): string | undefined {
  if (!testControlsAllowed()) return undefined;
  const value = req.header("x-sentinel-force-crash-phase");
  if (!value) return undefined;
  if (!payload.search_name.startsWith("sentinel_test_")) return undefined;
  const normalized = value.toUpperCase();
  return ["ASSESS", "REMEMBER", "INVESTIGATE", "MAP", "RETRIEVE", "ACT", "VERIFY", "CLOSE"].includes(normalized) ? normalized : undefined;
}

async function checkOperaIqWebhookRateLimit(orgId: string): Promise<{ allowed: boolean; retryAfter: number }> {
  await createCollection("rate_limit_windows", {});
  const key = `operaiq-alert-${orgId}`;
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
      input: { endpoint: "/webhooks/alert", orgId },
      output: { count: nextCount },
      confidenceScore: null,
      durationMs: 0,
      success: false,
      errorMessage: "OperaIQ alert webhook rate limit exceeded"
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
    incidentType: alert.incidentType ?? null,
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
    source: "operaiq",
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
    source: "operaiq"
  };
}

function severityForAlert(value: unknown): NormalizedAlert["severity"] {
  return value === "P1" || value === "P2" || value === "P3" || value === "P4" ? value : "P2";
}

async function listSentinelIncidents(limit: number, orgId: string): Promise<Record<string, unknown>[]> {
  try {
    const docs = await queryDocuments<Record<string, unknown>>("incidents", {}, limit, { orgId });
    return docs.map(serializeSentinelIncident);
  } catch (error: unknown) {
    logger.warn({ error }, "OperaIQ incidents unavailable for merged feed");
    return [];
  }
}

async function querySentinelCollection(collection: string, limit: number, orgId: string): Promise<Record<string, unknown>[]> {
  try {
    return await queryDocuments<Record<string, unknown>>(collection, {}, limit, { orgId });
  } catch (error: unknown) {
    logger.warn({ collection, error }, "OperaIQ memory collection unavailable");
    return [];
  }
}

async function countSentinelCollection(collection: string, orgId: string): Promise<number> {
  try {
    return await countDocuments(collection, {}, { orgId });
  } catch (error: unknown) {
    logger.warn({ collection, error }, "OperaIQ memory collection count unavailable");
    return 0;
  }
}

function qdrantDashboardUrl(): string {
  return process.env.QDRANT_DASHBOARD_URL ?? process.env.QDRANT_URL ?? "http://localhost:6333/dashboard";
}

function internalApiBaseUrl(): string {
  return (process.env.OPERAIQ_INTERNAL_API_URL ?? `http://127.0.0.1:${process.env.PORT ?? "3001"}`).replace(/\/+$/, "");
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function logFingerprint(log: AppLog): string {
  const body = [log.service, log.errorName, log.route, log.message, log.stack]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("|")
    .toLowerCase();
  if (body.includes("econnreset")) return `${log.service}:redis-econnreset`;
  if (body.includes("connection pool")) return `${log.service}:connection-pool`;
  if (body.includes("out of memory") || body.includes("heap")) return `${log.service}:memory-pressure`;
  return `${log.service}:${normalizeToken(body) || "unknown-error"}`;
}

function severityFromLogs(logs: Array<Record<string, unknown>>): NormalizedAlert["severity"] {
  if (logs.some((log) => log.level === "fatal")) return "P1";
  const maxStatus = Math.max(...logs.map((log) => finiteNumber(log.statusCode)));
  if (logs.length >= 8 || maxStatus >= 500) return "P2";
  return "P3";
}

function logSymptomLines(logs: Array<Record<string, unknown>>): string[] {
  const values = new Set<string>();
  for (const log of logs) {
    const level = asString(log.level).toUpperCase() || "ERROR";
    const service = asString(log.service) || "unknown-service";
    const message = asString(log.message);
    const errorName = asString(log.errorName);
    const route = asString(log.route);
    const statusCode = finiteNumber(log.statusCode);
    const latencyMs = finiteNumber(log.latencyMs);
    values.add(`${level} ${service}: ${message}`.slice(0, 360));
    if (errorName) values.add(`errorName=${errorName}`);
    if (route) values.add(`route=${route}`);
    if (statusCode > 0) values.add(`statusCode=${statusCode}`);
    if (latencyMs > 0) values.add(`latencyMs=${latencyMs}`);
  }
  return Array.from(values).slice(0, 14);
}

function shouldTriggerPattern(logs: Array<Record<string, unknown>>): boolean {
  const combined = logs.map((log) => `${asString(log.level)} ${asString(log.message)} ${asString(log.stack)} ${asString(log.errorName)}`).join("\n").toLowerCase();
  if (logs.some((log) => log.level === "fatal")) return true;
  if (logs.length >= 3 && combined.includes("econnreset")) return true;
  if (logs.length >= 3 && combined.includes("connection pool")) return true;
  if (logs.length >= 3 && combined.includes("unhandledpromiserejection")) return true;
  if (logs.length >= 3 && (combined.includes("heap out of memory") || combined.includes("out of memory"))) return true;
  return logs.length >= 5 && logs.some((log) => finiteNumber(log.statusCode) >= 500);
}

async function ensureProjectRuntimeMemory(input: {
  orgId: string;
  projectId: string;
  projectName: string;
  service: string;
  environment: string;
}): Promise<void> {
  await Promise.all([
    createCollection("projects", {}),
    createCollection("events", {}),
    createCollection("log_batches", {}),
    createCollection("patterns", {}),
    createCollection("pattern_alerts", {}),
    createCollection("services", {}),
    createCollection("service_runtime_configs", {}),
    createCollection("runbooks", {}),
    createCollection("incidents", {}),
    createCollection("postmortems", {})
  ]);
  const now = new Date().toISOString();
  const serviceDocs = await queryDocuments<Record<string, unknown>>("services", { name: input.service }, 1, { orgId: input.orgId });
  if (serviceDocs.length === 0) {
    await insertDocument("services", {
      _key: `${input.projectId}-${input.service}`,
      orgId: input.orgId,
      name: input.service,
      team: "payments-platform",
      language: "nodejs",
      dependencies: ["redis-cache", "checkout-api"],
      dependents: ["checkout-web"],
      knownFragilePoints: ["Redis ECONNRESET", "connection pool exhaustion", "checkout timeout bursts"],
      slaMs: 800,
      owners: ["local-oncall"],
      runbookIds: [`${input.projectId}-redis-pool-runbook`],
      projectId: input.projectId,
      projectName: input.projectName,
      environment: input.environment,
      eventCount: 100,
      errorCount: 0,
      createdAt: now,
      updatedAt: now
    }, { orgId: input.orgId });
  }

  const redisDocs = await queryDocuments<Record<string, unknown>>("services", { name: "redis-cache" }, 1, { orgId: input.orgId });
  if (redisDocs.length === 0) {
    await insertDocument("services", {
      _key: `${input.projectId}-redis-cache`,
      orgId: input.orgId,
      name: "redis-cache",
      team: "payments-platform",
      language: "redis",
      dependencies: [],
      dependents: [input.service],
      knownFragilePoints: ["connection pool saturation", "ECONNRESET under checkout write load"],
      slaMs: 200,
      owners: ["local-oncall"],
      runbookIds: [`${input.projectId}-redis-pool-runbook`],
      projectId: input.projectId,
      projectName: input.projectName,
      environment: input.environment,
      eventCount: 100,
      errorCount: 0,
      createdAt: now,
      updatedAt: now
    }, { orgId: input.orgId });
  }

  const runtimeConfigs = await queryDocuments<Record<string, unknown>>("service_runtime_configs", { serviceName: input.service }, 1, { orgId: input.orgId });
  if (runtimeConfigs.length === 0) {
    await insertDocument("service_runtime_configs", {
      _key: `${input.projectId}-${input.service}-runtime`,
      orgId: input.orgId,
      serviceName: input.service,
      adminBaseUrl: internalApiBaseUrl(),
      incidentChannel: "local-verify",
      cloudRunServiceName: input.service,
      projectId: input.projectId,
      environment: input.environment,
      createdAt: now,
      updatedAt: now
    }, { orgId: input.orgId });
  }

  const redisRuntimeConfigs = await queryDocuments<Record<string, unknown>>("service_runtime_configs", { serviceName: "redis-cache" }, 1, { orgId: input.orgId });
  if (redisRuntimeConfigs.length === 0) {
    await insertDocument("service_runtime_configs", {
      _key: `${input.projectId}-redis-cache-runtime`,
      orgId: input.orgId,
      serviceName: "redis-cache",
      adminBaseUrl: internalApiBaseUrl(),
      incidentChannel: "local-verify",
      cloudRunServiceName: "redis-cache",
      projectId: input.projectId,
      environment: input.environment,
      createdAt: now,
      updatedAt: now
    }, { orgId: input.orgId });
  }

  const runbooks = await queryDocuments<Record<string, unknown>>("runbooks", { _key: `${input.projectId}-redis-pool-runbook` }, 1, { orgId: input.orgId });
  if (runbooks.length === 0) {
    await insertDocument("runbooks", {
      _key: `${input.projectId}-redis-pool-runbook`,
      orgId: input.orgId,
      title: "Recover payment checkout Redis connection pool failure",
      incidentType: "qdrant_log_pattern",
      applicableServices: [input.service, "redis-cache"],
      steps: [
        {
          order: 1,
          action: "Rotate the saturated Redis connection pool",
          command: "rotate_connection_pool",
          isExecutable: true,
          riskLevel: "low"
        },
        {
          order: 2,
          action: "Notify payments on-call if verification stays hot",
          command: "notify_team",
          isExecutable: true,
          riskLevel: "low"
        }
      ],
      successCriteria: "Qdrant verification shows the correlated checkout error count drops below thirty percent of the original burst.",
      fallbackAction: "notify_team",
      projectId: input.projectId,
      environment: input.environment,
      createdAt: now,
      updatedAt: now
    }, { orgId: input.orgId });
  }

  const similarIncidents = await queryDocuments<Record<string, unknown>>("incidents", { _key: `${input.projectId}-prior-redis-econnreset` }, 1, { orgId: input.orgId });
  if (similarIncidents.length === 0) {
    await insertDocument("incidents", {
      _key: `${input.projectId}-prior-redis-econnreset`,
      orgId: input.orgId,
      title: "Resolved checkout Redis ECONNRESET burst",
      severity: "P2",
      status: "resolved",
      symptoms: ["Redis ECONNRESET", "payment-service checkout failures", "connection pool exhausted", "p99 latency elevated"],
      affectedServices: [input.service, "redis-cache"],
      rootCause: "redis-cache connection pool saturation caused checkout writes to fail",
      resolution: "Rotated the Redis connection pool and verified checkout errors dropped.",
      remediationSteps: ["rotate_connection_pool on redis-cache"],
      detectedAt: now,
      resolvedAt: now,
      durationMinutes: 4,
      postMortemId: null,
      agentEvents: [],
      rawPayload: { source: "project-runtime-memory" },
      remediationAttempts: 1,
      originalErrorCount: 42,
      verifyResults: [{ timestamp: now, errorCount: 2, passed: true }],
      severityUpgradedFrom: null,
      severityUpgradeReason: null,
      correlationReport: [],
      rootCauseCandidate: "redis-cache",
      bestSimilarityScore: 0.92,
      projectId: input.projectId,
      createdAt: now,
      updatedAt: now
    }, { orgId: input.orgId });
  }

  const patterns = await queryDocuments<Record<string, unknown>>("patterns", { _key: `${input.projectId}-redis-econnreset-pattern` }, 1, { orgId: input.orgId });
  if (patterns.length === 0) {
    await insertDocument("patterns", {
      _key: `${input.projectId}-redis-econnreset-pattern`,
      orgId: input.orgId,
      projectId: input.projectId,
      projectName: input.projectName,
      name: "Qdrant checkout error burst watcher",
      service: input.service,
      type: "log_error_burst",
      threshold: 3,
      matchTerms: ["ECONNRESET", "connection pool exhausted", "UnhandledPromiseRejection"],
      webhookPath: "/webhooks/qdrant-pattern",
      createdAt: now,
      updatedAt: now
    }, { orgId: input.orgId });
  }
}

async function fireQdrantPatternWebhook(payload: QdrantPatternWebhookBody): Promise<{ incidentId: string; status: string }> {
  const secret = process.env.AGENT_TOOL_SECRET ?? process.env.WEBHOOK_SECRET;
  if (!secret) throw new Error("AGENT_TOOL_SECRET or WEBHOOK_SECRET is required for Qdrant pattern webhooks");
  const response = await fetch(`${internalApiBaseUrl()}/webhooks/qdrant-pattern`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
      "x-sentinel-tool-secret": secret
    },
    body: JSON.stringify(payload)
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Qdrant pattern webhook failed with ${response.status}: ${body}`);
  }
  return JSON.parse(body) as { incidentId: string; status: string };
}

function groupKeyForLog(log: Record<string, unknown>): string {
  return [asString(log.orgId), asString(log.projectId), asString(log.service), asString(log.fingerprint)].join("|");
}

let qdrantPatternEvaluationRunning = false;

async function logBatchComplete(log: Record<string, unknown>, cache: Map<string, boolean>): Promise<boolean> {
  const batchId = asString(log.batchId);
  if (!batchId) return true;
  const orgId = asString(log.orgId);
  if (!orgId) return false;
  const cacheKey = `${orgId}:${batchId}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey) === true;
  const batch = await getDocument<Record<string, unknown>>("log_batches", batchId, { orgId }).catch(() => null);
  const complete = batch?.status === "complete";
  cache.set(cacheKey, complete);
  return complete;
}

async function evaluateQdrantLogPatterns(): Promise<{ scanned: number; fired: number }> {
  if (qdrantPatternEvaluationRunning) return { scanned: 0, fired: 0 };
  qdrantPatternEvaluationRunning = true;
  try {
    await Promise.all([createCollection("events", {}), createCollection("log_batches", {}), createCollection("pattern_alerts", {})]);
    const pending = await queryAllDocuments<Record<string, unknown>>("events", { type: "app_log", patternChecked: false }, 1_000);
    const groups = new Map<string, Array<Record<string, unknown>>>();
    const batchCache = new Map<string, boolean>();
    for (const log of pending) {
      const orgId = asString(log.orgId);
      const projectId = asString(log.projectId);
      const service = asString(log.service);
      const fingerprint = asString(log.fingerprint);
      if (!orgId || !projectId || !service || !fingerprint) continue;
      if (!(await logBatchComplete(log, batchCache))) continue;
      const key = groupKeyForLog(log);
      groups.set(key, [...(groups.get(key) ?? []), log]);
    }

    let fired = 0;
    for (const logs of groups.values()) {
      if (!shouldTriggerPattern(logs)) continue;
      const first = logs[0]!;
      const orgId = asString(first.orgId);
      const projectId = asString(first.projectId);
      const projectName = asString(first.projectName) || projectId;
      const service = asString(first.service);
      const fingerprint = asString(first.fingerprint);
      const duplicate = await queryDocuments<Record<string, unknown>>("pattern_alerts", { projectId, fingerprint, status: "webhook_accepted" }, 1, { orgId });
      if (duplicate.length > 0) {
        await Promise.all(logs.map((log) => updateDocument("events", asString(log._key), { patternChecked: true, duplicatePatternAlertId: duplicate[0]!._key }, { orgId })));
        continue;
      }

      const now = new Date().toISOString();
      const symptoms = logSymptomLines(logs);
      const sampleMessages = logs.map((log) => asString(log.message)).filter(Boolean).slice(0, 6);
      const severity = severityFromLogs(logs);
      const patternAlertId = createKvKey();
      await insertDocument("pattern_alerts", {
        _key: patternAlertId,
        orgId,
        projectId,
        projectName,
        service,
        type: "qdrant_pattern_match",
        fingerprint,
        severity,
        status: "matched",
        logCount: logs.length,
        symptoms,
        sampleMessages,
        source: "qdrant-pattern-watcher",
        webhookPath: "/webhooks/qdrant-pattern",
        createdAt: now,
        updatedAt: now
      }, { orgId });

      await Promise.all(logs.map((log) => updateDocument("events", asString(log._key), { patternChecked: true, patternAlertId }, { orgId })));

      try {
        const result = await fireQdrantPatternWebhook({
          patternAlertId,
          orgId,
          projectId,
          projectName,
          service,
          severity,
          fingerprint,
          logCount: logs.length,
          symptoms,
          sampleMessages,
          rawPayload: { logKeys: logs.map((log) => asString(log._key)), source: "qdrant-pattern-watcher" }
        });
        await updateDocument("pattern_alerts", patternAlertId, {
          status: "webhook_accepted",
          webhookFiredAt: new Date().toISOString(),
          incidentId: result.incidentId,
          webhookResult: result
        }, { orgId });
        fired += 1;
      } catch (error: unknown) {
        await updateDocument("pattern_alerts", patternAlertId, {
          status: "webhook_failed",
          webhookFailedAt: new Date().toISOString(),
          errorMessage: error instanceof Error ? error.message : String(error)
        }, { orgId });
        logger.error({ error, patternAlertId }, "Qdrant pattern webhook dispatch failed");
      }
    }
    return { scanned: pending.length, fired };
  } finally {
    qdrantPatternEvaluationRunning = false;
  }
}

let qdrantPatternWatcherStarted = false;

function startQdrantPatternWatcher(): void {
  if (qdrantPatternWatcherStarted) return;
  qdrantPatternWatcherStarted = true;
  const timer = setInterval(() => {
    evaluateQdrantLogPatterns().catch((error: unknown) => {
      logger.warn({ error }, "Qdrant pattern watcher failed");
    });
  }, 2_000);
  timer.unref();
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

async function serviceHealthFromQdrant(orgId: string): Promise<Array<{ service: string; eventCount: number; errorCount: number; errorRate: number }>> {
  const services = await queryDocuments<Record<string, unknown>>("services", {}, 100, { orgId }).catch((error: unknown) => {
    logger.warn({ error }, "Qdrant service health lookup failed");
    return [];
  });
  return services.map((service) => {
    const eventCount = finiteNumber(service.eventCount) || 100;
    const errorCount = finiteNumber(service.errorCount) || 0;
    return {
      service: asString(service.name) || asString(service.service) || "unknown",
      eventCount,
      errorCount,
      errorRate: eventCount > 0 ? Number(((errorCount / eventCount) * 100).toFixed(1)) : 0
    };
  });
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
    logger.info({ event }, "OperaIQ agent event");
    agentEvents.push(event);
    dispatchAgentEvent(event);
    await updateSentinelIncident(input.incidentId, input.orgId, { agentEvents });
  });
  logger.info({ incidentId: input.incidentId, result }, "OperaIQ agent completed");
}

async function notifyDlqFailure(incident: Record<string, unknown>, orgId: string): Promise<void> {
  const targetService = asStringArray(incident.affectedServices)[0] ?? "unknown-service";
  await executeRemediation({
    action: "notify_team",
    targetService,
    parameters: {
      riskLevel: "low",
      severity: asString(incident.severity) || "P2",
      symptoms: asStringArray(incident.symptoms).join(", ") || "stale OperaIQ incident",
      orgId,
      incidentId: asString(incident._key),
      reasoning: "OperaIQ DLQ retries exceeded.",
      escalationMessage: `OperaIQ failed - ${targetService}\nMax DLQ retries exceeded for incident ${asString(incident._key)}.\n@oncall please investigate.`
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
      errorMessage: typeof currentDlq?.errorMessage === "string" ? currentDlq.errorMessage : "Stale in_progress OperaIQ incident",
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
      logger.warn({ error }, "OperaIQ DLQ maintenance failed");
    });
  }, 120_000);
  timer.unref();
}

type ToolHandler = (input: unknown) => Promise<unknown>;

const toolHandlers: Record<string, ToolHandler> = {
  search_similar_incidents: sentinelSearchSimilarIncidents,
  query_qdrant_memory: queryQdrantMemory,
  get_service_dependency_graph: sentinelGetServiceDependencyGraph,
  get_runbook: sentinelGetRunbook,
  execute_remediation: executeRemediation,
  write_postmortem: sentinelWritePostmortem
};

function toolOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const tool of sentinelAgentToolDefinitions) {
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
  app.use(cors(corsOptions()));
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
      const issues: string[] = [];
      const warnings: string[] = [];
      let brainSize = 0;
      let orgCount = 0;
      let userCount = 0;
      let qdrantMemory: "ok" | "unavailable" = "unavailable";

      try {
        const [incidents, orgs, users] = await Promise.all([
          queryAllDocuments<Record<string, unknown>>("incidents", {}, 10_000),
          queryDocuments<Record<string, unknown>>("orgs", {}, 10_000),
          queryDocuments<Record<string, unknown>>("users", {}, 10_000)
        ]);
        brainSize = incidents.length;
        orgCount = orgs.length;
        userCount = users.length;
        qdrantMemory = "ok";
      } catch (error: unknown) {
        logger.warn({ error }, "OperaIQ health dependency check failed");
        issues.push(`Qdrant memory unavailable: ${healthErrorMessage(error)}`);
      }

      const readiness = runtimeReadiness();
      issues.push(...readiness.violations);
      if (qdrantMemory === "ok" && (orgCount === 0 || userCount === 0)) {
        issues.push("No OperaIQ auth org/user is seeded; login cannot succeed");
      }
      if (qdrantMemory === "ok" && brainSize === 0) {
        warnings.push("No incidents are seeded yet; dashboard and brain views will be empty until Qdrant seed data or live alerts are loaded");
      }

      res.json({
        status: issues.length > 0 ? "degraded" : "ok",
        brainSize,
        authReady: orgCount > 0 && userCount > 0,
        orgCount,
        userCount,
        qdrantMemory,
        runtime: readiness,
        issues,
        warnings
      });
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
      const orgId = typeof req.query.orgId === "string" ? req.query.orgId : "";
      const secret = typeof req.query.secret === "string" ? req.query.secret : "";
      const org = await verifyWebhookOrg(orgId, secret);
      const rateLimit = await checkOperaIqWebhookRateLimit(org.orgId);
      if (!rateLimit.allowed) {
        res.setHeader("Retry-After", String(rateLimit.retryAfter));
        res.status(429).json({ error: "Rate limit exceeded" });
        return;
      }
      const alert = normalizeAlertPayload(req.body);
      const incidentId = await createSentinelIncidentFromAlert(alert, org.orgId);
      setImmediate(() => {
        runSentinelForIncident({ incidentId, orgId: org.orgId, alert })
          .catch((error: unknown) => {
            logger.error({ incidentId, error }, "OperaIQ agent failed");
          });
      });
      res.status(202).json({ incidentId, status: "open", trigger: "operaiq-alert" });
    })
  );

  app.post(
    "/webhooks/qdrant-pattern",
    asyncHandler(async (req, res) => {
      verifyToolSecret(req);
      const body = qdrantPatternWebhookBodySchema.parse(req.body);
      const alert: NormalizedAlert = {
        source: "operaiq",
        title: `Qdrant pattern: ${body.projectName} ${body.service} ${body.fingerprint}`,
        severity: body.severity,
        affectedServices: [body.service],
        symptoms: body.symptoms,
        incidentType: "qdrant_log_pattern",
        detectedAt: new Date().toISOString(),
        rawPayload: {
          ...body.rawPayload,
          patternAlertId: body.patternAlertId,
          projectId: body.projectId,
          projectName: body.projectName,
          fingerprint: body.fingerprint,
          logCount: body.logCount,
          sampleMessages: body.sampleMessages,
          webhook: "/webhooks/qdrant-pattern"
        }
      };
      const incidentId = await createSentinelIncidentFromAlert(alert, body.orgId);
      await updateDocument("pattern_alerts", body.patternAlertId, {
        incidentId,
        status: "webhook_received",
        webhookReceivedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }, { orgId: body.orgId });
      setImmediate(() => {
        runSentinelForIncident({ incidentId, orgId: body.orgId, alert })
          .catch((error: unknown) => {
            logger.error({ incidentId, error }, "OperaIQ Qdrant pattern agent failed");
          });
      });
      res.status(202).json({ incidentId, status: "open", trigger: "qdrant-pattern-webhook" });
    })
  );

  app.post(
    "/projects",
    requireAuth,
    asyncHandler(async (req, res) => {
      const auth = (req as AuthenticatedRequest).auth ?? verifyAuth(req);
      const body = createProjectBodySchema.parse(req.body);
      await createCollection("projects", {});
      const now = new Date().toISOString();
      const projectId = createKvKey();
      const project = {
        _key: projectId,
        orgId: auth.orgId,
        name: body.name.trim(),
        service: body.service,
        environment: body.environment,
        ingestUrl: `${process.env.API_PUBLIC_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"}/projects/${projectId}/logs`,
        createdAt: now,
        updatedAt: now
      };
      await insertDocument("projects", project, { orgId: auth.orgId });
      await ensureProjectRuntimeMemory({
        orgId: auth.orgId,
        projectId,
        projectName: project.name,
        service: body.service,
        environment: body.environment
      });
      res.status(201).json({ project });
    })
  );

  app.post(
    "/projects/:id/logs",
    requireAuth,
    asyncHandler(async (req, res) => {
      const auth = (req as AuthenticatedRequest).auth ?? verifyAuth(req);
      const projectId = typeof req.params.id === "string" ? req.params.id : "";
      const project = await getDocument<Record<string, unknown>>("projects", projectId, { orgId: auth.orgId });
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      const body = ingestProjectLogsBodySchema.parse(req.body);
      const now = new Date().toISOString();
      const batchId = createKvKey();
      await createCollection("log_batches", {});
      await insertDocument("log_batches", {
        _key: batchId,
        orgId: auth.orgId,
        projectId,
        projectName: asString(project.name),
        status: "open",
        expectedCount: body.logs.length,
        source: "user-test-app",
        createdAt: now,
        updatedAt: now
      }, { orgId: auth.orgId });
      const inserted: string[] = [];
      for (const log of body.logs) {
        const occurredAt = log.timestamp ?? now;
        const fingerprint = logFingerprint(log);
        const doc = {
          orgId: auth.orgId,
          projectId,
          projectName: asString(project.name),
          type: "app_log",
          source: "user-test-app",
          batchId,
          level: log.level,
          service: log.service,
          environment: asString(project.environment) || "local",
          message: log.message,
          stack: log.stack ?? null,
          errorName: log.errorName ?? null,
          traceId: log.traceId ?? null,
          requestId: log.requestId ?? null,
          route: log.route ?? null,
          statusCode: log.statusCode ?? null,
          latencyMs: log.latencyMs ?? null,
          metadata: log.metadata,
          fingerprint,
          errorCount: log.level === "error" || log.level === "fatal" ? 1 : 0,
          patternChecked: false,
          occurredAt,
          createdAt: now,
          updatedAt: now
        };
        const result = await insertDocument("events", doc, { orgId: auth.orgId });
        inserted.push(result._key);
      }
      await updateDocument("log_batches", batchId, {
        status: "complete",
        completedAt: new Date().toISOString(),
        eventIds: inserted,
        acceptedCount: inserted.length
      }, { orgId: auth.orgId });
      setImmediate(() => {
        evaluateQdrantLogPatterns().catch((error: unknown) => {
          logger.warn({ error, projectId }, "Immediate Qdrant pattern evaluation failed");
        });
      });
      res.status(202).json({ accepted: inserted.length, eventIds: inserted, projectId, batchId, qdrant: "stored" });
    })
  );

  app.get(
    "/projects/:id/flow",
    requireAuth,
    asyncHandler(async (req, res) => {
      const auth = (req as AuthenticatedRequest).auth ?? verifyAuth(req);
      const projectId = typeof req.params.id === "string" ? req.params.id : "";
      const project = await getDocument<Record<string, unknown>>("projects", projectId, { orgId: auth.orgId });
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      const [logs, patternAlerts] = await Promise.all([
        queryDocuments<Record<string, unknown>>("events", { projectId, type: "app_log" }, 1_000, { orgId: auth.orgId }),
        queryDocuments<Record<string, unknown>>("pattern_alerts", { projectId }, 50, { orgId: auth.orgId })
      ]);
      const latestAlert = patternAlerts.sort((left, right) => timestampMs(right.createdAt) - timestampMs(left.createdAt))[0] ?? null;
      const incidentId = typeof latestAlert?.incidentId === "string" ? latestAlert.incidentId : null;
      const incident = incidentId ? await getDocument<Record<string, unknown>>("incidents", incidentId, { orgId: auth.orgId }).catch(() => null) : null;
      const audit = incidentId ? await queryDocuments<Record<string, unknown>>("audit_log", { incidentId }, 100, { orgId: auth.orgId }).catch(() => []) : [];
      const postmortems = incidentId ? await queryDocuments<Record<string, unknown>>("postmortems", { incidentId }, 10, { orgId: auth.orgId }).catch(() => []) : [];
      const phases = audit.map((entry) => asString(entry.phase)).filter(Boolean);
      res.json({
        project,
        counts: {
          logsStored: logs.length,
          patternAlerts: patternAlerts.length,
          auditEntries: audit.length,
          postmortems: postmortems.length
        },
        latestPatternAlert: latestAlert,
        incident: incident ? serializeSentinelIncident(incident) : null,
        postmortem: postmortems[0] ? serializeSentinelPostmortem(postmortems[0]!) : null,
        audit: audit.map(serializeAuditEntry).sort((left, right) => timestampMs(left.timestamp) - timestampMs(right.timestamp)),
        stages: {
          appLogsStored: logs.length > 0,
          qdrantPatternMatched: patternAlerts.length > 0,
          webhookFired: Boolean(latestAlert?.webhookFiredAt || latestAlert?.webhookReceivedAt || incidentId),
          operaiqActed: phases.includes("ACT"),
          operaiqVerified: phases.includes("VERIFY"),
          qdrantPostmortemStored: postmortems.length > 0
        }
      });
    })
  );

  app.post(
    "/webhooks/splunk-alert",
    asyncHandler(async (req, res) => {
      const orgId = typeof req.query.orgId === "string" ? req.query.orgId : "";
      const secret = typeof req.query.secret === "string" ? req.query.secret : "";
      const org = await verifyWebhookOrg(orgId, secret);
      const payload = normalizeSplunkAlertBody(req.body);
      const rateLimit = await checkOperaIqWebhookRateLimit(org.orgId);
      if (!rateLimit.allowed) {
        res.setHeader("Retry-After", String(rateLimit.retryAfter));
        res.status(429).json({ error: "Rate limit exceeded" });
        return;
      }
      const alert = normalizeSplunkAlert(payload);
      const remediationWaitMs = testControlRemediationWaitMs(req, payload);
      const verifyFailsBeforePass = testControlVerifyFailsBeforePass(req, payload);
      const forceCrashPhase = testControlForceCrashPhase(req, payload);
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
            logger.error({ incidentId, error }, "OperaIQ agent failed");
          });
      });
      res.status(202).json({ incidentId, status: "open", trigger: "legacy-splunk-alert-action" });
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
      const action = payload.actions?.find((item) => item.action_id === "operaiq_approve_remediation" || item.action_id === "sentinel_approve_remediation");
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

  app.post(
    "/admin/remediation",
    asyncHandler(async (req, res) => {
      verifyToolSecret(req);
      const body = adminRemediationBodySchema.parse(req.body);
      const acceptedAt = new Date().toISOString();
      const incidentId = typeof body.parameters.incidentId === "string" ? body.parameters.incidentId : null;
      logger.info(
        {
          action: body.action,
          targetService: body.targetService,
          incidentId,
          acceptedAt
        },
        "Admin remediation action accepted"
      );
      res.json({
        ok: true,
        action: body.action,
        targetService: body.targetService,
        acceptedAt,
        output: `Accepted ${body.action} for ${body.targetService}; OperaIQ admin endpoint recorded the remediation request.`
      });
    })
  );

  app.get(
    "/agent/tools",
    asyncHandler(async (_req, res) => {
      res.json({ tools: sentinelAgentToolDefinitions });
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
      if (!isSentinelId(id)) {
        const sentinel = await getSentinelIncidentView(id, auth.orgId);
        if (sentinel) {
          res.json(sentinel);
          return;
        }
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      const sentinel = await getSentinelIncidentView(id, auth.orgId);
      if (sentinel) {
        res.json(sentinel);
        return;
      }
      res.status(403).json({ error: "Forbidden" });
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
      if (!isSentinelId(incidentId)) {
        res.status(400).end();
        return;
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
    "/qdrant/overview",
    requireAuth,
    asyncHandler(async (_req, res) => {
      const auth = (_req as AuthenticatedRequest).auth ?? verifyAuth(_req);
      const [incidents, auditEntries, serviceHealth] = await Promise.all([
        querySentinelCollection("incidents", 10_000, auth.orgId),
        querySentinelCollection("audit_log", 500, auth.orgId),
        serviceHealthFromQdrant(auth.orgId)
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
        nativeDashboardUrl: qdrantDashboardUrl(),
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
    "/admin/dlq/flush",
    requireAuth,
    asyncHandler(async (_req, res) => {
      const result = await flushDeadLetterQueue({ force: true });
      res.json(result);
    })
  );

  startDlqMaintenance();
  startQdrantPatternWatcher();

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status =
      error instanceof Error && error.name === "Unauthorized" ? 401 : error instanceof Error && error.name === "Forbidden" ? 403 : dependencyUnavailable(error) ? 503 : 500;
    const message =
      status === 401
        ? "Unauthorized"
        : status === 403
          ? "Forbidden"
          : status === 503
            ? "OperaIQ dependency unavailable"
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
