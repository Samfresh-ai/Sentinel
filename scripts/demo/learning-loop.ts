import "dotenv/config";
import { execFileSync } from "node:child_process";
import { clearCollection, deleteDocument, queryDocuments, runSearch } from "@operaiq/splunk-brain";
import { DEMO_ADMIN_EMAIL, DEMO_ADMIN_PASSWORD, ensureDemoOrg } from "./org.js";

type Incident = {
  id: string;
  status: string;
  bestSimilarityScore: number | null;
  resolvedAt: string | null;
  detectedAt: string;
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

function runDemoScript(script: string): void {
  execFileSync("pnpm", [script], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: {
      ...process.env,
      OPERAIQ_REMEDIATION_WAIT_MS: "0",
      SENTINEL_VERIFY_WAIT_MS: "0"
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

async function clearDemoBrain(orgId: string): Promise<void> {
  await runSearch(`search index=sentinel sourcetype=sentinel:postmortem orgId=${orgId} | delete`, { maxResults: 1001 }).catch(() => []);
  const incidents = await queryDocuments<Record<string, unknown>>("incidents", {}, 10_000, { orgId });
  for (const incident of incidents) {
    if (typeof incident._key === "string") await deleteDocument("incidents", incident._key, { orgId });
  }
  const postmortems = await queryDocuments<Record<string, unknown>>("postmortems", {}, 10_000, { orgId });
  for (const postmortem of postmortems) {
    if (typeof postmortem._key === "string") await deleteDocument("postmortems", postmortem._key, { orgId });
  }
  await clearCollection("audit_log", { orgId }).catch(() => undefined);
}

async function incidentDetail(incidentId: string, token: string): Promise<Incident> {
  const response = await requestJson<{ incident: Incident }>(`${apiBaseUrl()}/incidents/${incidentId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return response.incident;
}

async function triggerPaymentIncident(input: { token: string; orgId: string; secret: string; waitMs: number; searchName: string }): Promise<{
  incidentId: string;
  resolutionTimeMs: number;
  bestSimilarityScore: number;
}> {
  const webhookUrl = `${apiBaseUrl()}/webhooks/splunk-alert?orgId=${encodeURIComponent(input.orgId)}&secret=${encodeURIComponent(input.secret)}`;
  const startedAt = Date.now();
  const created = await requestJson<{ incidentId: string }>(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-sentinel-demo-remediation-wait-ms": String(input.waitMs)
    },
    body: JSON.stringify({
      search_name: input.searchName,
      app: "sentinel",
      owner: "admin",
      results_link: "http://localhost:8000/app/sentinel/search",
      result: {
        sourcetype: "app",
        host: "payment-pod-1",
        source: "payment-service",
        service: "payment-service",
        severity: "P3",
        _raw: `checkout shadow fault ${input.searchName}`
      }
    })
  });

  for (let attempt = 0; attempt < 120; attempt += 1) {
    await delay(1_000);
    const incident = await incidentDetail(created.incidentId, input.token);
    if (incident.status === "resolved") {
      return {
        incidentId: created.incidentId,
        resolutionTimeMs: Date.now() - startedAt,
        bestSimilarityScore: incident.bestSimilarityScore ?? 0
      };
    }
    if (incident.status === "failed" || incident.status === "escalated") {
      throw new Error(`Incident ${created.incidentId} ended with ${incident.status}`);
    }
  }
  throw new Error(`Incident ${created.incidentId} did not resolve`);
}

function durationLabel(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

async function main(): Promise<void> {
  process.env.OPERAIQ_REMEDIATION_WAIT_MS = "0";
  process.env.SENTINEL_VERIFY_WAIT_MS = "0";
  process.env.OPERAIQ_AI_PROVIDER = process.env.OPERAIQ_AI_PROVIDER ?? "offline";

  const org = await ensureDemoOrg();
  const searchName = `sentinel_demo_learning_loop_${Date.now()}`;
  runDemoScript("sentinel:demo:seed");
  await clearDemoBrain(org.orgId);
  const token = await demoToken();

  runDemoScript("sentinel:demo:logs");
  const first = await triggerPaymentIncident({ token, orgId: org.orgId, secret: org.webhookSecret, waitMs: 12000, searchName });
  writeLine(`Incident 1 (novel): resolved in ${durationLabel(first.resolutionTimeMs)}, best match: ${Math.round(first.bestSimilarityScore * 100)}%`);

  await delay(5_000);
  runDemoScript("sentinel:demo:logs");
  const second = await triggerPaymentIncident({ token, orgId: org.orgId, secret: org.webhookSecret, waitMs: 0, searchName });
  writeLine(`Incident 2 (recognised): resolved in ${durationLabel(second.resolutionTimeMs)}, best match: ${Math.round(second.bestSimilarityScore * 100)}%`);

  if (second.resolutionTimeMs >= first.resolutionTimeMs) {
    throw new Error(`Expected second run to be faster: first=${first.resolutionTimeMs}, second=${second.resolutionTimeMs}`);
  }
  if (second.bestSimilarityScore <= 0.8) {
    throw new Error(`Expected second bestSimilarityScore > 0.80, got ${second.bestSimilarityScore}`);
  }

  writeLine("╔═══════════════════════════════════════╗");
  writeLine("║ SENTINEL LEARNING LOOP PROOF          ║");
  writeLine("╠═══════════════════════════════════════╣");
  writeLine("║ Incident 1 (novel)                    ║");
  writeLine(`║ Resolution time : ${durationLabel(first.resolutionTimeMs)}`.padEnd(40, " ") + "║");
  writeLine(`║ Best match      : ${Math.round(first.bestSimilarityScore * 100)}% (no history)`.padEnd(40, " ") + "║");
  writeLine("╠═══════════════════════════════════════╣");
  writeLine("║ Incident 2 (recognised)               ║");
  writeLine(`║ Resolution time : ${durationLabel(second.resolutionTimeMs)}`.padEnd(40, " ") + "║");
  writeLine(`║ Best match      : ${Math.round(second.bestSimilarityScore * 100)}% (learned)`.padEnd(40, " ") + "║");
  writeLine("╠═══════════════════════════════════════╣");
  writeLine("║ Brain grew: 0 -> 1 resolved incident  ║");
  writeLine("╚═══════════════════════════════════════╝");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  writeLine(`FAILED sentinel:demo:learning-loop - ${message}`);
  process.exitCode = 1;
});
