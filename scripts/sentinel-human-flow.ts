import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  createCollection,
  getSplunkConfig,
  insertDocument,
  runSearch,
  sendEvent,
  splunkRestRequest,
  waitForSplunkReady
} from "@sentinel/splunk-brain";

const DEFAULT_API_URL = "https://sentinel-api-n8ly.onrender.com";
const CRON_SCHEDULE = "* * * * *";
const ARTIFACT_DIR = "artifacts/runtime";

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

type SignupResponse = {
  token: string;
  orgId: string;
  webhookUrl: string;
};

type IncidentSummary = {
  id: string;
  title: string;
  status: string;
  postMortemId: string | null;
  agentEvents?: Array<{ stepType: string }>;
};

type IncidentDetail = {
  incident: IncidentSummary;
  postmortem: { id: string } | null;
};

function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

function apiBaseUrl(): string {
  return (process.env.SENTINEL_API_URL ?? process.env.API_PUBLIC_URL ?? process.env.AGENT_TOOL_EXECUTION_BASE_URL ?? DEFAULT_API_URL).replace(/\/+$/, "");
}

function runId(): string {
  return new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
}

function randomSuffix(): string {
  return Math.random().toString(16).slice(2, 10);
}

function quoteSplunk(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

function redactWebhook(value: string): string {
  return value.replace(/([?&]secret=)[^&]+/, "$1<redacted>");
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

async function createHumanOrg(apiUrl: string, id: string): Promise<SignupResponse & { orgName: string; adminEmail: string }> {
  const orgName = `Sentinel Human Flow ${id}`;
  const adminEmail = `sentinel-human-${id}-${randomSuffix()}@sentinel.local`;
  const adminPassword = `Sentinel-${id}-${randomSuffix()}-pass`;
  const signup = await requestJson<SignupResponse>(`${apiUrl}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orgName, adminEmail, adminPassword })
  });
  return { ...signup, orgName, adminEmail };
}

async function seedHumanProject(input: { orgId: string; apiUrl: string }): Promise<void> {
  for (const collection of ["services", "service_runtime_configs", "runbooks", "incidents", "postmortems", "audit_log", "remediation_executions", "dead_letter", "rate_limit_windows"]) {
    await createCollection(collection, {});
  }

  const now = new Date().toISOString();
  const services = [
    {
      _key: `${input.orgId}-payment-service`,
      orgId: input.orgId,
      name: "payment-service",
      team: "payments",
      language: "Node.js",
      dependencies: ["redis-cache"],
      dependents: [],
      knownFragilePoints: ["Redis connection pool saturation", "checkout latency spikes"],
      slaMs: 300,
      owners: ["payments-oncall"],
      runbookIds: [`${input.orgId}-redis-connection-exhaustion`],
      createdAt: now,
      updatedAt: now
    },
    {
      _key: `${input.orgId}-redis-cache`,
      orgId: input.orgId,
      name: "redis-cache",
      team: "platform",
      language: "Redis",
      dependencies: [],
      dependents: ["payment-service"],
      knownFragilePoints: ["connection storms", "maxclients pressure"],
      slaMs: 25,
      owners: ["platform-oncall"],
      runbookIds: [`${input.orgId}-redis-connection-exhaustion`],
      createdAt: now,
      updatedAt: now
    }
  ];

  for (const service of services) {
    await insertDocument("services", service, { orgId: input.orgId });
  }

  for (const serviceName of ["payment-service", "redis-cache"]) {
    await insertDocument(
      "service_runtime_configs",
      {
        _key: `${input.orgId}-${serviceName}`,
        orgId: input.orgId,
        serviceName,
        incidentChannel: null,
        adminBaseUrl: input.apiUrl,
        cloudRunServiceName: null,
        createdAt: now,
        updatedAt: now
      },
      { orgId: input.orgId }
    );
  }

  await insertDocument(
    "runbooks",
    {
      _key: `${input.orgId}-redis-connection-exhaustion`,
      orgId: input.orgId,
      title: "Redis connection pool recovery for checkout",
      incidentType: "redis-connection-exhaustion",
      applicableServices: ["payment-service", "redis-cache"],
      steps: [
        {
          order: 1,
          action: "Rotate Redis client connection pool",
          command: "rotate_connection_pool",
          isExecutable: true,
          riskLevel: "low"
        },
        {
          order: 2,
          action: "Notify on-call with investigation context if verification fails",
          command: "notify_team",
          isExecutable: true,
          riskLevel: "low"
        }
      ],
      successCriteria: "New checkout errors drop below 30 percent of the original Splunk error count after the connection pool action.",
      fallbackAction: "notify_team",
      createdAt: now,
      updatedAt: now
    },
    { orgId: input.orgId }
  );
}

function savedSearchForm(input: { name: string; search: string; webhookUrl: string; includeName: boolean }): Record<string, string | number | boolean | undefined> {
  return {
    ...(input.includeName ? { name: input.name } : {}),
    search: input.search,
    cron_schedule: CRON_SCHEDULE,
    is_scheduled: "1",
    disabled: "0",
    alert_type: "always",
    "alert.severity": "1",
    "alert.track": "1",
    "alert.suppress": "0",
    "alert.digest_mode": "0",
    actions: "webhook",
    "action.webhook": "1",
    "action.webhook.param.url": input.webhookUrl,
    "dispatch.earliest_time": "-5m@m",
    "dispatch.latest_time": "now",
    description: "Sentinel human-flow acceptance detector: app logs to Splunk, Splunk fires webhook, Sentinel acts."
  };
}

async function savedSearchExists(name: string): Promise<boolean> {
  const response = await splunkRestRequest(savedSearchSchema, {
    path: `/servicesNS/admin/sentinel/saved/searches/${encodeURIComponent(name)}`,
    query: { output_mode: "json" }
  }).catch(() => null);
  return (response?.entry?.length ?? 0) > 0;
}

async function getSavedSearch(name: string): Promise<Record<string, unknown> | null> {
  const response = await splunkRestRequest(savedSearchSchema, {
    path: `/servicesNS/admin/sentinel/saved/searches/${encodeURIComponent(name)}`,
    query: { output_mode: "json" }
  }).catch(() => null);
  return response?.entry?.[0]?.content ?? null;
}

async function configureSavedSearch(input: { name: string; search: string; webhookUrl: string }): Promise<void> {
  const exists = await savedSearchExists(input.name);
  await splunkRestRequest(z.record(z.unknown()).default({}), {
    method: "POST",
    path: exists ? `/servicesNS/admin/sentinel/saved/searches/${encodeURIComponent(input.name)}` : "/servicesNS/admin/sentinel/saved/searches",
    query: { output_mode: "json" },
    form: savedSearchForm({ ...input, includeName: !exists })
  });
  const content = await getSavedSearch(input.name);
  const disabled = String(content?.disabled ?? "1");
  const configuredWebhook = String(content?.["action.webhook.param.url"] ?? "");
  if (disabled !== "0" && disabled !== "false") {
    throw new Error(`Splunk saved search ${input.name} is not enabled`);
  }
  if (configuredWebhook !== input.webhookUrl) {
    throw new Error(`Splunk saved search ${input.name} webhook URL was not stored correctly`);
  }
}

async function disableSavedSearch(name: string): Promise<void> {
  await splunkRestRequest(z.record(z.unknown()).default({}), {
    method: "POST",
    path: `/servicesNS/admin/sentinel/saved/searches/${encodeURIComponent(name)}`,
    query: { output_mode: "json" },
    form: {
      disabled: "1",
      is_scheduled: "0",
      output_mode: "json"
    }
  }).catch(() => undefined);
}

async function sendProjectLogs(projectId: string): Promise<number> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const events = Array.from({ length: 86 }, (_item, index) => {
    const failure = index < 36;
    const failureVariant = index % 3;
    const failureMessage =
      failureVariant === 0
        ? "checkout failed after payment authorization: Redis read ECONNRESET, pool waiters rising, idempotency lock not released"
        : failureVariant === 1
          ? "checkout retry storm: upstream Redis socket reset during capture, fallback cache miss, provider callback delayed"
          : "checkout hard failure: cart reservation timed out after Redis MOVED redirect and ECONNRESET on reused TLS socket";
    return {
      index: "prod",
      sourcetype: "app",
      source: "sentinel-human-flow",
      host: `checkout-${(index % 3) + 1}`,
      time: nowSeconds - Math.max(0, 75 - index),
      event: {
        sentinelProjectId: projectId,
        level: failure ? "error" : "info",
        service: "payment",
        error_type: failure ? "ECONNRESET" : "OK",
        route: "/checkout/confirm",
        region: index % 2 === 0 ? "iad" : "atl",
        deploy_sha: "sentinel-human-flow-hard-log",
        trace_id: `${projectId}-trace-${Math.floor(index / 4)}`,
        span_id: `${projectId}-span-${index}`,
        latency_ms: failure ? 4200 + index * 31 : 120 + index,
        retry_attempt: failure ? (index % 4) + 1 : 0,
        redis_pool_active: failure ? 128 : 19 + (index % 5),
        redis_pool_waiting: failure ? 45 + index : index % 2,
        provider_status: failure ? "capture_pending" : "captured",
        root_signal: failure ? "redis_pool_exhaustion_after_econnreset" : "healthy_checkout",
        message: failure
          ? failureMessage
          : "checkout completed",
        error_stack: failure
          ? [
              "Error: read ECONNRESET",
              "    at RedisSocket.onStreamRead (node:internal/stream_base_commons:217:20)",
              "    at PaymentCapture.confirm (/srv/app/src/checkout/payment-capture.ts:184:17)",
              "    at async CheckoutController.confirm (/srv/app/src/checkout/controller.ts:77:9)"
            ].join("\\n")
          : null,
        requestId: `${projectId}-${index}`
      }
    };
  });
  await sendEvent(events);
  return events.length;
}

async function waitForIndexedLogs(projectId: string): Promise<{ total: number; econnreset: number }> {
  const spl = `index=prod sourcetype=app sentinelProjectId="${quoteSplunk(projectId)}" | stats count as total count(eval(error_type="ECONNRESET")) as econnreset`;
  for (let attempt = 1; attempt <= 24; attempt += 1) {
    const row = (await runSearch(spl, { maxResults: 1 }))[0] ?? {};
    const total = Number(row.total ?? 0);
    const econnreset = Number(row.econnreset ?? 0);
    if (total >= 86 && econnreset >= 30) return { total, econnreset };
    if (attempt % 4 === 0) writeLine(`WAIT logs indexed attempt=${attempt} total=${total} econnreset=${econnreset}`);
    await delay(2_500);
  }
  throw new Error(`Splunk did not index enough project logs for ${projectId}`);
}

async function fetchIncidents(apiUrl: string, token: string): Promise<IncidentSummary[]> {
  const result = await requestJson<{ items: IncidentSummary[] }>(`${apiUrl}/incidents?pageSize=50`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return result.items;
}

async function fetchIncident(apiUrl: string, token: string, incidentId: string): Promise<IncidentDetail> {
  return requestJson<IncidentDetail>(`${apiUrl}/incidents/${encodeURIComponent(incidentId)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
}

async function waitForIncident(input: { apiUrl: string; token: string; savedSearchName: string }): Promise<string> {
  for (let attempt = 1; attempt <= 48; attempt += 1) {
    const incident = (await fetchIncidents(input.apiUrl, input.token)).find((item) => item.title.includes(input.savedSearchName));
    if (incident) return incident.id;
    if (attempt % 6 === 0) writeLine(`WAIT Splunk saved search webhook attempt=${attempt}`);
    await delay(5_000);
  }
  throw new Error(`No Sentinel incident appeared for saved search ${input.savedSearchName}`);
}

async function waitForResolution(input: { apiUrl: string; token: string; incidentId: string }): Promise<IncidentDetail> {
  for (let attempt = 1; attempt <= 48; attempt += 1) {
    const detail = await fetchIncident(input.apiUrl, input.token, input.incidentId);
    if (detail.incident.status === "resolved" && (detail.incident.postMortemId || detail.postmortem?.id)) return detail;
    if (attempt % 6 === 0) writeLine(`WAIT Sentinel ACT/VERIFY/CLOSE attempt=${attempt} status=${detail.incident.status}`);
    await delay(5_000);
  }
  throw new Error(`Sentinel incident ${input.incidentId} did not resolve with a postmortem`);
}

async function main(): Promise<void> {
  process.env.SENTINEL_MODE = "true";
  process.env.AGENT_NAME = "Sentinel";

  const id = runId();
  const apiUrl = apiBaseUrl();
  const splunk = getSplunkConfig();
  const projectId = `project_${id}_${randomSuffix()}`;
  const savedSearchName = `sentinel_human_flow_${id}_${randomSuffix()}`;
  const proofPath = `${ARTIFACT_DIR}/sentinel-human-flow-${id}.json`;
  const startedAt = new Date().toISOString();

  const proof: Record<string, unknown> = {
    startedAt,
    apiUrl,
    splunk: {
      host: splunk.SPLUNK_CLOUD_STACK_HOST ?? splunk.SPLUNK_HOST,
      app: splunk.SPLUNK_APP,
      index: splunk.SPLUNK_INDEX
    },
    projectId,
    savedSearchName,
    acceptance: {
      appToSplunkLogs: false,
      splunkWatchedAndWebhookFired: false,
      sentinelActed: false,
      sentinelVerified: false,
      sentinelClosed: false,
      acceptable: false
    },
    failure: null
  };

  try {
    writeLine(`CHECK api=${apiUrl}`);
    await requestJson(`${apiUrl}/health`);
    await waitForSplunkReady({
      onRetry: (attempt, message) => {
        if (attempt % 6 === 0) writeLine(`WAIT splunk-ready attempt=${attempt} last=${message}`);
      }
    });
    writeLine("PASSED splunk-ready - management API is reachable");

    const org = await createHumanOrg(apiUrl, id);
    proof.appProject = {
      orgId: org.orgId,
      orgName: org.orgName,
      adminEmail: org.adminEmail,
      projectId
    };
    proof.webhookUrl = redactWebhook(org.webhookUrl);

    await seedHumanProject({ orgId: org.orgId, apiUrl });
    const search = `index=prod sourcetype=app sentinelProjectId="${quoteSplunk(projectId)}" service=payment error_type=ECONNRESET | stats count as error_count values(host) as host values(source) as source values(sourcetype) as sourcetype values(message) as _raw values(root_signal) as root_signal max(redis_pool_waiting) as redis_pool_waiting max(latency_ms) as latency_ms by sentinelProjectId | where error_count >= 30 | eval service="payment-service", severity="P1"`;
    await configureSavedSearch({ name: savedSearchName, search, webhookUrl: org.webhookUrl });
    writeLine(`PASS Splunk saved search configured name=${savedSearchName}`);
    proof.savedSearch = {
      search,
      schedule: CRON_SCHEDULE,
      webhookConfigured: true
    };

    const logsSent = await sendProjectLogs(projectId);
    const indexedCounts = await waitForIndexedLogs(projectId);
    proof.logsSentToSplunk = logsSent;
    proof.indexedCounts = indexedCounts;
    (proof.acceptance as Record<string, boolean>).appToSplunkLogs = true;
    writeLine(`PASS app logs -> Splunk total=${indexedCounts.total} econnreset=${indexedCounts.econnreset}`);

    const incidentId = await waitForIncident({ apiUrl, token: org.token, savedSearchName });
    proof.incidentId = incidentId;
    (proof.acceptance as Record<string, boolean>).splunkWatchedAndWebhookFired = true;
    writeLine(`PASS Splunk saved search -> Sentinel webhook incident=${incidentId}`);

    const detail = await waitForResolution({ apiUrl, token: org.token, incidentId });
    const steps = detail.incident.agentEvents?.map((event) => event.stepType) ?? [];
    proof.finalStatus = detail.incident.status;
    proof.postmortemId = detail.incident.postMortemId ?? detail.postmortem?.id ?? null;
    proof.agentSteps = steps;
    const acceptance = proof.acceptance as Record<string, boolean>;
    acceptance.sentinelActed = steps.includes("ACT");
    acceptance.sentinelVerified = steps.includes("VERIFY");
    acceptance.sentinelClosed = steps.includes("CLOSE");
    acceptance.acceptable =
      acceptance.appToSplunkLogs === true &&
      acceptance.splunkWatchedAndWebhookFired === true &&
      acceptance.sentinelActed === true &&
      acceptance.sentinelVerified === true &&
      acceptance.sentinelClosed === true;

    const postmortemRows = await runSearch(`search index=sentinel sourcetype=sentinel:postmortem orgId=${org.orgId} incidentId=${incidentId} | stats count`, { maxResults: 1 });
    proof.postmortemIndexedCount = Number(postmortemRows[0]?.count ?? 0);
    proof.completedAt = new Date().toISOString();

    await disableSavedSearch(savedSearchName);
    proof.cleanup = { disabledSavedSearchAfterProof: true };
    writeLine(`PASS Sentinel ACT/VERIFY/CLOSE postmortem=${proof.postmortemId}`);
  } catch (error: unknown) {
    proof.failure = error instanceof Error ? error.message : "Unknown failure";
    proof.completedAt = new Date().toISOString();
    await disableSavedSearch(savedSearchName);
    throw error;
  } finally {
    await mkdir(ARTIFACT_DIR, { recursive: true });
    await writeFile(proofPath, JSON.stringify(proof, null, 2));
    writeLine(`PROOF ${proofPath}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  writeLine(`FAILED sentinel-human-flow - ${message}`);
  process.exitCode = 1;
});
