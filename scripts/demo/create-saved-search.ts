import "dotenv/config";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { splunkRestRequest } from "@operaiq/splunk-brain";
import { z } from "zod";
import { ensureDemoOrg } from "./org.js";

const execFileAsync = promisify(execFile);

const SEARCH_NAME = "sentinel_auto_detect_payment_errors";
const SEARCH_QUERY = "index=prod sourcetype=app service=payment error_type=ECONNRESET | stats count as error_count | where error_count > 15";
const CRON_SCHEDULE = "*/1 * * * *";
const DOCKER_CONTAINER = process.env.SPLUNK_DOCKER_CONTAINER ?? "sentinel-splunk";
const DEFAULT_WEBHOOK_BASE_URL = "http://host.docker.internal:3001";
const DOCKER_BRIDGE_WEBHOOK_BASE_URL = "http://172.17.0.1:3001";

const savedSearchSchema = z
  .object({
    entry: z
      .array(
        z
          .object({
            content: z.record(z.unknown()).default({})
          })
          .passthrough()
      )
      .default([])
  })
  .passthrough();

function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function dockerExec(command: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync("docker", ["exec", DOCKER_CONTAINER, "sh", "-lc", command], { timeout: 5_000 });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error: unknown) {
    const maybeError = error as { stdout?: string; stderr?: string };
    return { ok: false, stdout: maybeError.stdout ?? "", stderr: maybeError.stderr ?? "" };
  }
}

async function hostDockerInternalResolves(): Promise<boolean | null> {
  const result = await dockerExec("getent hosts host.docker.internal");
  if (result.ok && result.stdout.trim().length > 0) return true;

  const containerExists = await dockerExec("true");
  if (!containerExists.ok) return null;
  return false;
}

async function chooseWebhookBaseUrl(): Promise<{ baseUrl: string; note: string }> {
  const override = process.env.SENTINEL_WEBHOOK_BASE_URL?.replace(/\/+$/, "");
  if (override) {
    return {
      baseUrl: override,
      note: "using SENTINEL_WEBHOOK_BASE_URL override"
    };
  }

  const resolves = await hostDockerInternalResolves();
  if (resolves === true) {
    return {
      baseUrl: DEFAULT_WEBHOOK_BASE_URL,
      note: "host.docker.internal resolves inside the Splunk container"
    };
  }
  if (resolves === false) {
    return {
      baseUrl: DOCKER_BRIDGE_WEBHOOK_BASE_URL,
      note: "host.docker.internal does not resolve inside the Splunk container; using Docker bridge fallback"
    };
  }

  return {
    baseUrl: DEFAULT_WEBHOOK_BASE_URL,
    note: `could not inspect Docker container ${DOCKER_CONTAINER}; defaulting to host.docker.internal`
  };
}

async function savedSearchExists(): Promise<boolean> {
  const response = await splunkRestRequest(savedSearchSchema, {
    path: `/servicesNS/admin/sentinel/saved/searches/${encodeURIComponent(SEARCH_NAME)}`,
    query: { output_mode: "json" }
  }).catch(() => null);
  return (response?.entry?.length ?? 0) > 0;
}

function savedSearchForm(webhookUrl: string, includeName: boolean): Record<string, string | number | boolean | undefined> {
  return {
    ...(includeName ? { name: SEARCH_NAME } : {}),
    search: SEARCH_QUERY,
    cron_schedule: CRON_SCHEDULE,
    is_scheduled: "1",
    disabled: "0",
    alert_type: "always",
    "alert.severity": "2",
    "alert.track": "1",
    "alert.suppress": "0",
    "alert.digest_mode": "0",
    actions: "webhook",
    "action.webhook": "1",
    "action.webhook.param.url": webhookUrl,
    "dispatch.earliest_time": "-5m@m",
    "dispatch.latest_time": "now",
    description: "Sentinel autonomous demo detector for payment-service Redis ECONNRESET spikes."
  };
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function isEnabledValue(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

async function readSavedSearch(): Promise<Record<string, unknown>> {
  const response = await splunkRestRequest(savedSearchSchema, {
    path: `/servicesNS/admin/sentinel/saved/searches/${encodeURIComponent(SEARCH_NAME)}`,
    query: { output_mode: "json" }
  });
  return response.entry?.[0]?.content ?? {};
}

async function main(): Promise<void> {
  const org = await ensureDemoOrg();
  const { baseUrl, note } = await chooseWebhookBaseUrl();
  const webhookUrl = `${baseUrl}/webhooks/splunk-alert?orgId=${encodeURIComponent(org.orgId)}&secret=${encodeURIComponent(org.webhookSecret)}`;
  const exists = await savedSearchExists();
  await splunkRestRequest(z.record(z.unknown()).default({}), {
    method: "POST",
    path: exists ? `/servicesNS/admin/sentinel/saved/searches/${encodeURIComponent(SEARCH_NAME)}` : "/servicesNS/admin/sentinel/saved/searches",
    query: { output_mode: "json" },
    form: savedSearchForm(webhookUrl, !exists)
  });

  const saved = await readSavedSearch();
  const enabled = isEnabledValue(saved.is_scheduled);
  const cron = stringValue(saved.cron_schedule);
  const actionUrl = stringValue(saved["action.webhook.param.url"]);

  if (!enabled || cron !== CRON_SCHEDULE || actionUrl !== webhookUrl) {
    throw new Error(`Saved search verification failed: is_scheduled=${stringValue(saved.is_scheduled) || "missing"} cron=${cron || "missing"} webhook=${actionUrl || "missing"}`);
  }

  writeLine("✓ Sentinel autonomous saved search configured");
  writeLine(` name: ${SEARCH_NAME}`);
  writeLine(` schedule: ${CRON_SCHEDULE}`);
  writeLine(` search: ${SEARCH_QUERY}`);
  writeLine(` webhook: ${webhookUrl}`);
  writeLine(` note: ${note}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  writeLine(`FAILED sentinel:demo:setup - ${message}`);
  process.exitCode = 1;
});
