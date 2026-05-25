const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export interface Incident {
  id: string;
  title: string;
  severity: "P1" | "P2" | "P3" | "P4";
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
  embeddingDimensions: number;
}

export interface AgentEvent {
  incidentId: string;
  stepType: "ASSESS" | "REMEMBER" | "MAP" | "RETRIEVE" | "ACT" | "CLOSE" | "ERROR";
  message: string;
  payload?: Record<string, unknown>;
  createdAt: string;
}

export interface Postmortem {
  id: string;
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
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    },
    cache: "no-store"
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Request failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function fetchIncidents(): Promise<{ items: Incident[]; total: number }> {
  return requestJson<{ items: Incident[]; total: number }>("/incidents?pageSize=50");
}

export async function fetchIncident(id: string): Promise<{ incident: Incident; postmortem: Postmortem | null; alertPayload: Record<string, unknown> }> {
  return requestJson<{ incident: Incident; postmortem: Postmortem | null; alertPayload: Record<string, unknown> }>(`/incidents/${id}`);
}

export async function fetchServices(): Promise<{ items: Service[] }> {
  return requestJson<{ items: Service[] }>("/services");
}

export async function fetchBrainStats(): Promise<BrainStats> {
  return requestJson<BrainStats>("/brain/stats");
}

export async function simulateIncident(input: { service: string; symptoms: string[]; severity: "P1" | "P2" | "P3" | "P4" }): Promise<{ incidentId: string }> {
  return requestJson<{ incidentId: string }>("/simulate", {
    method: "POST",
    body: JSON.stringify({
      source: "operaiq",
      title: `${input.service} simulated incident`,
      service: input.service,
      symptoms: input.symptoms,
      severity: input.severity
    })
  });
}

export function apiUrl(path: string): string {
  return `${API_URL}${path}`;
}
