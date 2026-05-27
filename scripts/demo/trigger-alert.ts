import "dotenv/config";
import { DEMO_ADMIN_EMAIL, DEMO_ADMIN_PASSWORD, ensureDemoOrg } from "./org.js";

type AgentEvent = {
  stepType: string;
  message: string;
  payload?: Record<string, unknown>;
  createdAt: string;
};

type Incident = {
  id: string;
  status: string;
  detectedAt?: string;
  resolvedAt?: string | null;
  postMortemId?: string | null;
  agentEvents?: AgentEvent[];
};

function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

function apiBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001").replace(/\/+$/, "");
}

function demoRemediationWaitMs(): string | null {
  const raw = process.env.DEMO_REMEDIATION_WAIT_MS;
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 60_000) {
    throw new Error(`DEMO_REMEDIATION_WAIT_MS must be between 0 and 60000, received ${raw}`);
  }
  process.env.OPERAIQ_REMEDIATION_WAIT_MS = String(parsed);
  return String(parsed);
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${body}`);
  return JSON.parse(body) as T;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function durationLabel(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

function resolvedDurationMs(incident: Incident, fallbackStartedAt: number): number {
  const detectedAt = incident.detectedAt ? new Date(incident.detectedAt).getTime() : Number.NaN;
  const resolvedAt = incident.resolvedAt ? new Date(incident.resolvedAt).getTime() : Number.NaN;
  if (Number.isFinite(detectedAt) && Number.isFinite(resolvedAt) && resolvedAt >= detectedAt) {
    return resolvedAt - detectedAt;
  }
  return Date.now() - fallbackStartedAt;
}

function toolForEvent(event: AgentEvent): string | null {
  if (event.stepType === "REMEMBER") return "search_similar_incidents";
  if (event.stepType === "INVESTIGATE") return "query_splunk_logs";
  if (event.stepType === "MAP") return "get_service_dependency_graph";
  if (event.stepType === "ACT" && event.message.startsWith("Executing ")) return "execute_remediation";
  if (event.stepType === "CLOSE") return "write_postmortem";
  return null;
}

async function demoToken(): Promise<string> {
  const response = await requestJson<{ token: string }>(`${apiBaseUrl()}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: DEMO_ADMIN_EMAIL, password: DEMO_ADMIN_PASSWORD })
  });
  return response.token;
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function incidentFromList(incidentId: string, token: string): Promise<Incident | null> {
  const response = await requestJson<{ items: Incident[] }>(`${apiBaseUrl()}/incidents?pageSize=100`, { headers: authHeaders(token) });
  return response.items.find((item) => item.id === incidentId) ?? null;
}

async function incidentDetail(incidentId: string, token: string): Promise<Incident> {
  const response = await requestJson<{ incident: Incident }>(`${apiBaseUrl()}/incidents/${incidentId}`, { headers: authHeaders(token) });
  return response.incident;
}

async function main(): Promise<void> {
  const payload = {
    search_name: "sentinel_demo_payment_redis_spike",
    app: "sentinel",
    owner: "admin",
    results_link: "http://localhost:8000/app/sentinel/search",
    result: {
      sourcetype: "app",
      host: "payment-pod-1",
      source: "payment-service",
      service: "payment-service",
      severity: "P1",
      _raw: JSON.stringify({
        service: "payment-service",
        level: "error",
        message: "Redis ECONNRESET",
        error_type: "ECONNRESET",
        duration_ms: 4200
      })
    }
  };

  const org = await ensureDemoOrg();
  const token = await demoToken();
  const waitMs = demoRemediationWaitMs();
  const webhookUrl = `${apiBaseUrl()}/webhooks/splunk-alert?orgId=${encodeURIComponent(org.orgId)}&secret=${encodeURIComponent(org.webhookSecret)}`;
  const created = await requestJson<{ incidentId: string; status: string }>(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(waitMs ? { "x-sentinel-demo-remediation-wait-ms": waitMs } : {})
    },
    body: JSON.stringify(payload)
  });
  const startedAt = Date.now();
  writeLine(`→ Incident created: ${created.incidentId} [${created.status}]`);

  const printedTools = new Set<string>();
  let printedStarted = false;
  let lastStatus = created.status;

  for (let attempt = 0; attempt < 180; attempt += 1) {
    await delay(1_000);
    const listed = await incidentFromList(created.incidentId, token);
    const detail = await incidentDetail(created.incidentId, token);
    const incident = { ...detail, ...listed };

    if (!printedStarted && (incident.status === "in_progress" || incident.status === "resolved")) {
      writeLine("→ Agent started [in_progress]");
      printedStarted = true;
    }
    if (incident.status !== lastStatus && incident.status !== "resolved") {
      writeLine(`→ Incident status: ${created.incidentId} [${incident.status}]`);
      lastStatus = incident.status;
    }

    for (const event of detail.agentEvents ?? []) {
      const tool = toolForEvent(event);
      if (tool && !printedTools.has(tool)) {
        writeLine(`→ Tool called: ${tool}`);
        printedTools.add(tool);
      }
    }

    if (incident.status === "resolved") {
      writeLine(`→ Incident resolved: ${created.incidentId} [resolved] in ${durationLabel(resolvedDurationMs(incident, startedAt))}`);
      writeLine(`→ Postmortem written: ${incident.postMortemId ?? detail.postMortemId ?? "unknown"}`);
      return;
    }
  }

  throw new Error(`Incident ${created.incidentId} did not resolve within 180 seconds`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  writeLine(`FAILED sentinel:demo:trigger - ${message}`);
  process.exitCode = 1;
});
