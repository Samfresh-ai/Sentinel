import "dotenv/config";
import { execFileSync } from "node:child_process";
import { getDocument } from "@operaiq/splunk-brain";
import { DEMO_ADMIN_EMAIL, DEMO_ADMIN_PASSWORD, ensureDemoOrg } from "./demo/org.js";

type Incident = {
  id: string;
  status: string;
  postMortemId: string | null;
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

function runSetupScript(script: string): void {
  execFileSync("pnpm", [script], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: {
      ...process.env,
      OPERAIQ_REMEDIATION_WAIT_MS: "0",
      SENTINEL_VERIFY_WAIT_MS: "0",
      DEMO_REMEDIATION_WAIT_MS: "0"
    }
  });
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

  runSetupScript("sentinel:demo:logs");
  runSetupScript("sentinel:demo:seed");

  const org = await ensureDemoOrg();
  const token = await demoToken();
  const webhookUrl = `${apiBaseUrl()}/webhooks/splunk-alert?orgId=${encodeURIComponent(org.orgId)}&secret=${encodeURIComponent(org.webhookSecret)}`;
  const created = await requestJson<{ incidentId: string }>(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-sentinel-demo-remediation-wait-ms": "0",
      "x-sentinel-force-crash-phase": "ACT"
    },
    body: JSON.stringify({
      search_name: "sentinel_demo_payment_redis_spike",
      app: "sentinel",
      owner: "admin",
      results_link: "http://localhost:8000/app/sentinel/search",
      result: {
        sourcetype: "app",
        host: "payment-pod-1",
        source: "payment-service",
        service: "payment-service",
        severity: "P3",
        _raw: "Redis ECONNRESET connection pool exhausted"
      }
    })
  });

  let dlqFound = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await delay(1_000);
    const incident = await incidentDetail(created.incidentId, token);
    const dlq = await getDocument<Record<string, unknown>>("dead_letter", created.incidentId).catch(() => null);
    if (incident.status === "in_progress" && dlq) {
      dlqFound = true;
      break;
    }
  }
  if (!dlqFound) throw new Error(`Incident ${created.incidentId} did not land in DLQ`);

  await requestJson<{ retried: number }>(`${apiBaseUrl()}/admin/dlq/flush`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` }
  });

  for (let attempt = 0; attempt < 180; attempt += 1) {
    await delay(1_000);
    const incident = await incidentDetail(created.incidentId, token);
    if (incident.status === "resolved") {
      writeLine(`PASSED dlq - incident ${created.incidentId} recovered after forced crash`);
      return;
    }
    if (incident.status === "failed" || incident.status === "escalated") {
      throw new Error(`Expected DLQ recovery, got ${incident.status}`);
    }
  }

  throw new Error(`Incident ${created.incidentId} did not recover after DLQ flush`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  writeLine(`FAILED sentinel:test-dlq - ${message}`);
  process.exitCode = 1;
});
