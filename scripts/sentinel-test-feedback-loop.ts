import "dotenv/config";
import { execFileSync } from "node:child_process";
import { DEMO_ADMIN_EMAIL, DEMO_ADMIN_PASSWORD, ensureDemoOrg } from "./demo/org.js";

type Incident = {
  id: string;
  status: string;
  remediationAttempts: number;
  verifyResults: Array<{ timestamp: string; errorCount: number; passed: boolean }>;
  agentEvents?: Array<{ stepType: string; message: string }>;
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
      "x-sentinel-verify-fails-before-pass": "1"
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

  let finalIncident: Incident | null = null;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await delay(1_000);
    const incident = await incidentDetail(created.incidentId, token);
    if (incident.status === "resolved") {
      finalIncident = incident;
      break;
    }
    if (incident.status === "escalated" || incident.status === "failed") {
      throw new Error(`Expected feedback loop resolution, got ${incident.status}`);
    }
  }

  if (!finalIncident) throw new Error(`Incident ${created.incidentId} did not resolve`);
  const actEvents = (finalIncident.agentEvents ?? []).filter((event) => event.stepType === "ACT" && event.message.startsWith("Executing "));
  if (actEvents.length < 2) throw new Error(`Expected at least 2 ACT attempts, saw ${actEvents.length}`);
  if (finalIncident.remediationAttempts !== 2) throw new Error(`Expected remediationAttempts=2, got ${finalIncident.remediationAttempts}`);
  if (!finalIncident.verifyResults.some((result) => result.passed)) throw new Error("Expected a passing VERIFY result");

  writeLine(`PASSED feedback-loop - incident ${created.incidentId} resolved after second remediation step`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  writeLine(`FAILED sentinel:test-feedback-loop - ${message}`);
  process.exitCode = 1;
});
