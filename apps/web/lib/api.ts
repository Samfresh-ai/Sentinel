const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
export const SPLUNK_DASHBOARD_URL = process.env.NEXT_PUBLIC_SPLUNK_DASHBOARD_URL ?? "http://localhost:8000/en-US/app/sentinel/sentinel_overview";
export const TOKEN_STORAGE_KEY = "sentinel_token";
export const AUTH_CHANGED_EVENT = "sentinel-auth-changed";
const REQUEST_TIMEOUT_MS = 10_000;

export class ApiRequestError extends Error {
  status: number;
  body: string;

  constructor(status: number, body: string) {
    super(body || (status === 0 ? "Sentinel API request timed out" : `Request failed with ${status}`));
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
  correlationReport: Array<{ service: string; errorCount: number; dominantErrorType: string | null; status: "anomalous" | "elevated" | "clean"; spl: string }>;
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
  timeline: Array<{ timestamp: string; event: string; actor: "operaiq" | "human" }>;
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
  mode: "local-verification" | "demo" | "autonomous-ready" | "production-blocked";
  production: boolean;
  localVerification: boolean;
  demoTiming: boolean;
  violations: string[];
}

export interface SplunkOverview {
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
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {})
      },
      cache: "no-store",
      signal: controller.signal
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ApiRequestError(0, `Sentinel API did not answer within ${REQUEST_TIMEOUT_MS / 1000}s`);
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
  return (await response.json()) as T;
}

export async function signup(input: { orgName: string; adminEmail: string; adminPassword: string }): Promise<{ token: string; orgId: string; webhookUrl: string; webhookSecret: string }> {
  return requestJson("/auth/signup", { method: "POST", body: JSON.stringify(input) });
}

export async function login(input: { email: string; password: string }): Promise<{ token: string; orgId: string; orgName: string }> {
  return requestJson("/auth/login", { method: "POST", body: JSON.stringify(input) });
}

export async function fetchMe(): Promise<{ orgId: string; orgName: string; adminEmail: string; brainSize: number; webhookUrl: string }> {
  return requestJson("/auth/me");
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

export async function fetchSplunkOverview(): Promise<SplunkOverview> {
  return requestJson<SplunkOverview>("/splunk/overview");
}

export async function simulateIncident(input: { service: string; symptoms: string[]; severity: "P1" | "P2" | "P3" | "P4" }): Promise<{ incidentId: string }> {
  return requestJson<{ incidentId: string }>("/simulate", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function apiUrl(path: string): string {
  return `${API_URL}${path}`;
}
