import "dotenv/config";
import { getSentinelIncident, runSearch } from "@sentinel/splunk-brain";
import { ensureSeedOrg } from "./test-org.js";

function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${body}`);
  }
  return JSON.parse(body) as T;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function main(): Promise<void> {
  process.env.SENTINEL_MODE = "true";
  process.env.AGENT_NAME = "Sentinel";
  process.env.SENTINEL_LOCAL_VERIFY = process.env.SENTINEL_LOCAL_VERIFY ?? "true";
  process.env.SENTINEL_REMEDIATION_WAIT_MS = process.env.SENTINEL_REMEDIATION_WAIT_MS ?? "0";
  process.env.SENTINEL_AI_PROVIDER = process.env.SENTINEL_AI_PROVIDER ?? "offline";

  const org = await ensureSeedOrg();
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
  const webhook = await requestJson<{ incidentId: string; status: string }>(`${apiUrl}/webhooks/splunk-alert?orgId=${encodeURIComponent(org.orgId)}&secret=${encodeURIComponent(org.webhookSecret)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      search_name: "sentinel_e2e_notification_s3_access_denied",
      owner: "admin",
      app: "sentinel",
      results_link: "https://localhost:8000/app/sentinel/search",
      result: {
        service: "notification-service",
        severity: "P3",
        sourcetype: "sentinel:test",
        source: "sentinel-e2e",
        host: "localhost",
        _raw: "S3 AccessDenied template asset reads failing notification send errors"
      }
    })
  });
  if (!webhook.incidentId) throw new Error("Splunk alert webhook did not return incidentId");

  let finalIncident: Record<string, unknown> | null = null;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const incident = await getSentinelIncident(webhook.incidentId, org.orgId);
    if (incident?.status === "resolved") {
      finalIncident = incident;
      break;
    }
    await delay(5_000);
  }
  if (!finalIncident) throw new Error("Sentinel incident did not resolve within 120 seconds");
  if (typeof finalIncident.postMortemId !== "string" || finalIncident.postMortemId.length === 0) {
    throw new Error("Resolved Sentinel incident does not have a post-mortem ID");
  }

  const postmortems = await runSearch(`search index=sentinel sourcetype=sentinel:postmortem orgId=${org.orgId} | head 20`, { maxResults: 20 });
  if (postmortems.length === 0) throw new Error("No sentinel:postmortem events found after e2e");
  writeLine(`PASSED sentinel:e2e - incident=${webhook.incidentId}, postmortemId=${finalIncident.postMortemId}, indexedPostmortems=${postmortems.length}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  writeLine(`FAILED sentinel:e2e - ${message}`);
  process.exitCode = 1;
});
