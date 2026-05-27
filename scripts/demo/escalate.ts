import "dotenv/config";
import { createCollection, getDocument, insertDocument, queryDocuments, runSearch, sendEvent, updateDocument } from "@operaiq/splunk-brain";
import { DEMO_ADMIN_EMAIL, DEMO_ADMIN_PASSWORD, ensureDemoOrg } from "./org.js";

type Incident = {
  id: string;
  status: string;
  postMortemId: string | null;
  remediationAttempts: number;
  agentEvents?: Array<{ stepType: string; message: string; payload?: Record<string, unknown> }>;
};

function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

function apiBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001").replace(/\/+$/, "");
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

async function waitForEscalationPostmortem(incidentId: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const postmortems = await runSearch(`search index=sentinel sourcetype=sentinel:postmortem type=escalation incidentId=${incidentId} | head 5`, { maxResults: 5 });
    if (postmortems.length > 0) return;
    await delay(1_000);
  }
  throw new Error("Escalation post-mortem was not indexed");
}

async function upsert(collection: string, key: string, orgId: string, document: Record<string, unknown>): Promise<void> {
  const existing = await getDocument<Record<string, unknown>>(collection, key, { orgId }).catch(() => null);
  if (existing) {
    await updateDocument(collection, key, { ...document, orgId, _key: key }, { orgId });
    return;
  }
  await insertDocument(collection, { ...document, orgId, _key: key }, { orgId });
}

async function seedUnknownScenario(orgId: string): Promise<void> {
  for (const collection of ["incidents", "services", "service_runtime_configs", "runbooks", "postmortems", "audit_log", "rate_limit_windows", "dead_letter", "remediation_executions"]) {
    await createCollection(collection, {});
  }
  const now = new Date().toISOString();
  await upsert("services", `${orgId}-mystery-service`, orgId, {
    name: "mystery-service",
    team: "platform-squad",
    language: "Go",
    dependencies: [],
    dependents: [],
    knownFragilePoints: ["unknown spike pattern"],
    slaMs: 250,
    owners: ["U02SRE"],
    runbookIds: ["mystery-service-escalation"],
    createdAt: now,
    updatedAt: now
  });
  await upsert("service_runtime_configs", `${orgId}-mystery-service`, orgId, {
    serviceName: "mystery-service",
    incidentChannel: process.env.SLACK_DEFAULT_INCIDENT_CHANNEL ?? null,
    adminBaseUrl: "http://localhost:4199",
    cloudRunServiceName: "mystery-service",
    createdAt: now,
    updatedAt: now
  });
  await upsert("runbooks", `${orgId}-mystery-service-escalation`, orgId, {
    title: "Unknown service anomaly containment",
    incidentType: "unknown-service-anomaly",
    steps: [
      { order: 1, action: "Notify service owner with unknown signal context", command: "notify_team", isExecutable: true, riskLevel: "low" },
      { order: 2, action: "Restart mystery-service if notification does not clear the signal", command: "restart_pod", isExecutable: true, riskLevel: "low" }
    ],
    fallbackAction: "notify_team",
    applicableServices: ["mystery-service"],
    successCriteria: "Unknown service error count drops below 30 percent of the original signal.",
    createdAt: now,
    updatedAt: now
  });
}

async function generateUnknownLogs(): Promise<void> {
  await runSearch("search index=prod demoScenario=sentinel_unknown_escalation | delete", { maxResults: 1001 });
  const baseTime = Date.now() / 1000;
  await sendEvent(Array.from({ length: 36 }, (_, index) => ({
    time: baseTime - index,
    index: "prod",
    sourcetype: "app",
    source: "mystery-service",
    host: "mystery-pod-1",
    event: {
      service: "mystery-service",
      environment: "prod",
      demoScenario: "sentinel_unknown_escalation",
      level: "error",
      message: "opaque worker fault",
      error_type: "OPAQUE_WORKER_FAULT"
    }
  })));
}

async function demoToken(): Promise<string> {
  const response = await requestJson<{ token: string }>(`${apiBaseUrl()}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: DEMO_ADMIN_EMAIL, password: DEMO_ADMIN_PASSWORD })
  });
  return response.token;
}

async function incidentDetail(incidentId: string, token: string): Promise<Incident> {
  const response = await requestJson<{ incident: Incident }>(`${apiBaseUrl()}/incidents/${incidentId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return response.incident;
}

async function main(): Promise<void> {
  process.env.OPERAIQ_REMEDIATION_WAIT_MS = "0";
  process.env.SENTINEL_VERIFY_WAIT_MS = "0";
  process.env.OPERAIQ_AI_PROVIDER = process.env.OPERAIQ_AI_PROVIDER ?? "offline";

  const org = await ensureDemoOrg();
  await seedUnknownScenario(org.orgId);
  await generateUnknownLogs();
  const token = await demoToken();
  const webhookUrl = `${apiBaseUrl()}/webhooks/splunk-alert?orgId=${encodeURIComponent(org.orgId)}&secret=${encodeURIComponent(org.webhookSecret)}`;
  const created = await requestJson<{ incidentId: string }>(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-sentinel-demo-remediation-wait-ms": "0",
      "x-sentinel-verify-fails-before-pass": "3"
    },
    body: JSON.stringify({
      search_name: "sentinel_demo_unknown_service_fault",
      app: "sentinel",
      owner: "admin",
      results_link: "http://localhost:8000/app/sentinel/search",
      result: {
        sourcetype: "app",
        host: "mystery-pod-1",
        source: "mystery-service",
        service: "mystery-service",
        severity: "P2",
        _raw: "opaque worker fault unknown service type"
      }
    })
  });

  let finalIncident: Incident | null = null;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await delay(1_000);
    const incident = await incidentDetail(created.incidentId, token);
    if (incident.status === "escalated") {
      finalIncident = incident;
      break;
    }
    if (incident.status === "resolved" || incident.status === "failed") {
      throw new Error(`Expected escalation, got ${incident.status}`);
    }
  }

  if (!finalIncident) throw new Error(`Incident ${created.incidentId} did not escalate`);
  const audit = await requestJson<{ items: Array<{ phase: string; output: Record<string, unknown> }> }>(`${apiBaseUrl()}/audit/${created.incidentId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!audit.items.some((entry) => entry.phase === "ESCALATE")) throw new Error("ESCALATE phase missing from audit log");

  await waitForEscalationPostmortem(created.incidentId);
  const slackMessage = audit.items.find((entry) => entry.phase === "ESCALATE" && typeof entry.output.slackMessage === "string")?.output.slackMessage;
  if (typeof slackMessage === "string") writeLine(slackMessage);
  writeLine(`PASSED escalation - incident ${created.incidentId} escalated correctly`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  writeLine(`FAILED sentinel:demo:escalate - ${message}`);
  process.exitCode = 1;
});
