const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
export const QDRANT_DASHBOARD_URL = process.env.NEXT_PUBLIC_QDRANT_DASHBOARD_URL ?? "http://localhost:6333/dashboard";
export const TOKEN_STORAGE_KEY = "operaiq_token";
export const AUTH_CHANGED_EVENT = "operaiq-auth-changed";
const REQUEST_TIMEOUT_MS = 60_000;

export class ApiRequestError extends Error {
  status: number;
  body: string;

  constructor(status: number, body: string) {
    super(body || (status === 0 ? "OperaIQ API request timed out" : `Request failed with ${status}`));
    this.name = "ApiRequestError";
    this.status = status;
    this.body = body;
  }
}

export interface Incident {
  id: string;
  title: string;
  severity: "P1" | "P2" | "P3" | "P4";
  status: "open" | "in_progress" | "resolved" | "escalated" | "failed";
  symptoms: string[];
  affectedServices: string[];
  rootCause: string | null;
  resolution: string | null;
  remediationSteps: string[];
  detectedAt: string;
  resolvedAt: string | null;
  durationMinutes: number | null;
  postMortemId: string | null;
  embeddingDimensions: number;
  agentEvents?: AgentEvent[];
  remediationAttempts: number;
  originalErrorCount: number | null;
  verifyResults: Array<{ timestamp: string; errorCount: number; passed: boolean }>;
  severityUpgradedFrom: string | null;
  severityUpgradeReason: string | null;
  correlationReport: Array<{ service: string; errorCount: number; dominantErrorType: string | null; status: "anomalous" | "elevated" | "clean"; query: string }>;
  rootCauseCandidate: string | null;
  bestSimilarityScore: number | null;
}

export interface AgentEvent {
  incidentId: string;
  stepType: "ASSESS" | "REMEMBER" | "INVESTIGATE" | "MAP" | "RETRIEVE" | "ACT" | "VERIFY" | "CLOSE" | "ESCALATE" | "ERROR";
  message: string;
  payload?: Record<string, unknown>;
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  orgId: string;
  incidentId: string;
  timestamp: string;
  phase: "ASSESS" | "REMEMBER" | "INVESTIGATE" | "MAP" | "RETRIEVE" | "ACT" | "VERIFY" | "CLOSE" | "ESCALATE" | "RATE_LIMITED" | "DLQ_RETRY" | "FAILED";
  toolCalled: string | null;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  confidenceScore: number | null;
  durationMs: number;
  success: boolean;
  errorMessage: string | null;
}

export interface Postmortem {
  id: string;
  incidentId: string;
  title: string;
  summary: string;
  timeline: Array<{ timestamp: string; event: string; actor: "operaiq" | "sentinel" | "human" }>;
  rootCause: string;
  contributingFactors: string[];
  remediationTaken: string[];
  preventionActions: string[];
  lessonLearned: string;
  createdAt: string;
}

export interface Service {
  id: string;
  name: string;
  team: string;
  language: string;
  dependencies: string[];
  dependents: string[];
  knownFragilePoints: string[];
  slaMs: number;
  owners: string[];
}

export interface BrainStats {
  incidentCount: number;
  runbookCount: number;
  patternCount: number;
  statusCounts: { open: number; inProgress: number; resolvedToday: number };
  topIncidentTypes: Array<{ name: string; count: number }>;
  recentPostmortems: Postmortem[];
  brainGrowth: Array<{ incidentId: string; title: string; severity: Incident["severity"]; resolutionSeconds: number | null; bestSimilarityScore: number | null; resolvedAt: string }>;
}

export interface RuntimeReadiness {
  mode: "local-verification" | "test-timing" | "autonomous-ready" | "production-blocked";
  production: boolean;
  localVerification: boolean;
  testTiming: boolean;
  violations: string[];
}

export interface OrgSummary {
  orgId: string;
  orgName: string;
  adminEmail: string;
  brainSize: number;
  webhookUrl: string;
}

export interface WebhookSecretRotation {
  orgId: string;
  webhookUrl: string;
  rotatedAt: string;
}

export interface QdrantOverview {
  nativeDashboardUrl: string;
  activeIncidents: number;
  brainSize: number;
  resolutionTimeline: Array<{ label: string; count: number }>;
  severityDistribution: Array<{ severity: Incident["severity"]; count: number }>;
  recentAgentDecisions: Array<{
    timestamp: string;
    phase: AuditEntry["phase"];
    toolCalled: string | null;
    durationMs: number;
    success: boolean;
    incidentId: string;
  }>;
  serviceHealth: Array<{ service: string; eventCount: number; errorCount: number; errorRate: number }>;
}

export interface Project {
  _key: string;
  orgId: string;
  name: string;
  service: string;
  environment: string;
  ingestUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectLogInput {
  level: "debug" | "info" | "warn" | "error" | "fatal";
  service: string;
  message: string;
  stack?: string;
  errorName?: string;
  traceId?: string;
  requestId?: string;
  route?: string;
  statusCode?: number;
  latencyMs?: number;
  timestamp?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface ProjectFlow {
  project: Project;
  counts: {
    logsStored: number;
    patternAlerts: number;
    auditEntries: number;
    postmortems: number;
  };
  latestPatternAlert: Record<string, unknown> | null;
  incident: Incident | null;
  postmortem: Postmortem | null;
  audit: AuditEntry[];
  stages: {
    appLogsStored: boolean;
    qdrantPatternMatched: boolean;
    webhookFired: boolean;
    operaiqActed: boolean;
    operaiqVerified: boolean;
    qdrantPostmortemStored: boolean;
  };
}

function emitAuthChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(AUTH_CHANGED_EVENT));
}

function responseMessage(status: number, body: string): string {
  if (status === 401) return "Session expired. Redirecting to setup.";
  if (!body) return `Request failed with ${status}`;
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim().length > 0) return parsed.error;
    if (typeof parsed.message === "string" && parsed.message.trim().length > 0) return parsed.message;
  } catch {
    return body;
  }
  return body;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const token = typeof window !== "undefined" ? window.localStorage.getItem(TOKEN_STORAGE_KEY) : null;
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  if (init?.signal) {
    if (init.signal.aborted) {
      controller.abort();
    } else {
      init.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {})
      },
      cache: "no-store",
      signal: controller.signal
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ApiRequestError(0, `OperaIQ API did not answer within ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
  }
  if (!response.ok) {
    const body = await response.text();
    if (response.status === 401 && typeof window !== "undefined") {
      clearStoredToken();
    }
    throw new ApiRequestError(response.status, responseMessage(response.status, body));
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    const body = await response.text();
    const bodyPreview = body.trim().replace(/\s+/g, " ").slice(0, 120);
    const detail = contentType.toLowerCase().includes("text/html")
      ? "HTML instead of JSON"
      : `${contentType || "a non-JSON response"}${bodyPreview ? `: ${bodyPreview}` : ""}`;
    throw new ApiRequestError(
      response.status,
      `OperaIQ API returned ${detail} for ${path}`
    );
  }
  return (await response.json()) as T;
}

export async function signup(input: { orgName: string; adminEmail: string; adminPassword: string }): Promise<{ token: string; orgId: string; webhookUrl: string }> {
  return requestJson("/auth/signup", { method: "POST", body: JSON.stringify(input) });
}

export async function login(input: { email: string; password: string }): Promise<{ token: string; orgId: string; orgName: string }> {
  return requestJson("/auth/login", { method: "POST", body: JSON.stringify(input) });
}

export async function fetchMe(): Promise<OrgSummary> {
  return requestJson("/auth/me");
}

export async function rotateWebhookSecret(): Promise<WebhookSecretRotation> {
  return requestJson("/auth/webhook-secret/rotate", { method: "POST" });
}

export function storedToken(): string | null {
  return typeof window === "undefined" ? null : window.localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function storeToken(token: string): void {
  window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
  emitAuthChanged();
}

export function clearStoredToken(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  emitAuthChanged();
}

export function isUnauthorizedError(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 401;
}

export async function fetchIncidents(): Promise<{ items: Incident[]; total: number }> {
  return requestJson<{ items: Incident[]; total: number }>("/incidents?pageSize=50");
}

export async function fetchIncident(id: string): Promise<{ incident: Incident; postmortem: Postmortem | null; alertPayload: Record<string, unknown> }> {
  return requestJson<{ incident: Incident; postmortem: Postmortem | null; alertPayload: Record<string, unknown> }>(`/incidents/${id}`);
}

export async function fetchAuditLog(incidentId: string): Promise<{ items: AuditEntry[]; total: number }> {
  return requestJson<{ items: AuditEntry[]; total: number }>(`/audit/${incidentId}`);
}

export async function fetchServices(): Promise<{ items: Service[] }> {
  return requestJson<{ items: Service[] }>("/services");
}

export async function fetchBrainStats(): Promise<BrainStats> {
  return requestJson<BrainStats>("/brain/stats");
}

export async function fetchRuntimeReadiness(): Promise<RuntimeReadiness> {
  return requestJson<RuntimeReadiness>("/runtime/readiness");
}

export async function fetchQdrantOverview(): Promise<QdrantOverview> {
  return requestJson<QdrantOverview>("/qdrant/overview");
}

export async function createProject(input: { name: string; service?: string; environment?: string }): Promise<{ project: Project }> {
  return requestJson<{ project: Project }>("/projects", { method: "POST", body: JSON.stringify(input) });
}

export async function ingestProjectLogs(projectId: string, logs: ProjectLogInput[]): Promise<{ accepted: number; eventIds: string[]; projectId: string; batchId: string; qdrant: string }> {
  return requestJson<{ accepted: number; eventIds: string[]; projectId: string; batchId: string; qdrant: string }>(`/projects/${projectId}/logs`, {
    method: "POST",
    body: JSON.stringify({ logs })
  });
}

export async function fetchProjectFlow(projectId: string): Promise<ProjectFlow> {
  return requestJson<ProjectFlow>(`/projects/${projectId}/flow`);
}

export function apiUrl(path: string): string {
  return `${API_URL}${path}`;
}
