import "dotenv/config";
import { createCollection, deleteDocument, getDocument, insertDocument, queryDocuments, runSearch, sendEvent, updateDocument } from "@operaiq/splunk-brain";
import { ensureDemoOrg } from "./org.js";

function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function upsert(collection: string, key: string, orgId: string, document: Record<string, unknown>): Promise<void> {
  const scopedKey = `${orgId}-${key}`;
  const withOrg = { ...document, orgId };
  const existing = await getDocument<Record<string, unknown>>(collection, scopedKey, { orgId }).catch(() => null);
  if (existing) {
    await updateDocument(collection, scopedKey, { ...withOrg, _key: scopedKey }, { orgId });
    return;
  }
  await insertDocument(collection, { ...withOrg, _key: scopedKey }, { orgId });
}

function scopedKey(orgId: string, key: string): string {
  return `${orgId}-${key}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

const historicalIncidents = [
  {
    _key: "demo-redis-01",
    title: "Redis connection pool exhaustion - payment-service",
    symptoms: ["ECONNRESET", "connection pool exhausted", "p99 spike"],
    affectedServices: ["payment-service", "redis-cache"],
    rootCause: "Redis max_connections limit reached due to connection leak in payment worker",
    resolution: "Rotated connection pool via /admin/connections/reset - resolved in 38s",
    remediationSteps: ["rotate_connection_pool on redis-cache"],
    severity: "P2",
    status: "resolved",
    durationMinutes: 1,
    detectedAt: minutesAgo(12_000),
    resolvedAt: minutesAgo(11_999)
  },
  {
    _key: "demo-redis-02",
    title: "payment-service latency spike - Redis timeout",
    symptoms: ["high latency", "Redis timeout", "checkout failures", "connection pool pressure"],
    affectedServices: ["payment-service", "redis-cache"],
    rootCause: "Redis connection pool starved under Black Friday load",
    resolution: "Scaled Redis pool size + rotated connections",
    remediationSteps: ["scale_service redis-cache", "rotate_connection_pool on redis-cache"],
    severity: "P1",
    status: "resolved",
    durationMinutes: 2,
    detectedAt: minutesAgo(10_400),
    resolvedAt: minutesAgo(10_398)
  },
  {
    _key: "demo-redis-03",
    title: "Redis ECONNRESET cascade - 3 services affected",
    symptoms: ["ECONNRESET", "connection pool refused", "high latency cascade", "checkout failures"],
    affectedServices: ["payment-service", "redis-cache", "auth-service"],
    rootCause: "Redis out of file descriptors after bad deploy",
    resolution: "Restarted Redis pod, rotated connection pools on all dependents",
    remediationSteps: ["restart_pod redis-cache", "rotate_connection_pool on payment-service"],
    severity: "P1",
    status: "resolved",
    durationMinutes: 4,
    detectedAt: minutesAgo(9_100),
    resolvedAt: minutesAgo(9_096)
  }
];

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isDemoRuntimeIncident(document: Record<string, unknown>): boolean {
  return ["Splunk alert: sentinel_demo_payment_redis_spike", "Splunk alert: sentinel_auto_detect_payment_errors"].includes(asString(document.title));
}

async function clearPreviousDemoRuntime(orgId: string): Promise<void> {
  await runSearch('search index=sentinel sourcetype=sentinel:postmortem (source=seed-demo OR "sentinel_demo_payment_redis_spike" OR "sentinel_auto_detect_payment_errors") | delete', { maxResults: 1001 });

  const incidents = await queryDocuments<Record<string, unknown>>("incidents", {}, 10_000, { orgId });
  const runtimeIncidentIds = incidents.filter(isDemoRuntimeIncident).map((incident) => asString(incident._key)).filter(Boolean);
  for (const incidentId of runtimeIncidentIds) {
    await deleteDocument("incidents", incidentId, { orgId });
  }

  if (runtimeIncidentIds.length === 0) return;
  const postmortems = await queryDocuments<Record<string, unknown>>("postmortems", {}, 10_000, { orgId });
  for (const postmortem of postmortems) {
    if (runtimeIncidentIds.includes(asString(postmortem.incidentId))) {
      await deleteDocument("postmortems", asString(postmortem._key), { orgId });
    }
  }
}

async function seedCollections(): Promise<void> {
  for (const collection of ["incidents", "services", "service_runtime_configs", "runbooks", "postmortems", "patterns", "audit_log", "rate_limit_windows", "dead_letter", "remediation_executions"]) {
    await createCollection(collection, {});
  }
}

async function seedServices(orgId: string): Promise<void> {
  const timestamp = nowIso();
  await upsert("services", "payment-service", orgId, {
    name: "payment-service",
    team: "payments-squad",
    language: "Node.js",
    dependencies: ["redis-cache", "postgres-main"],
    dependents: [],
    knownFragilePoints: ["Redis connection pool", "checkout latency", "Stripe timeout handling"],
    slaMs: 200,
    owners: ["U01PAYMENTS", "U02SRE"],
    runbookIds: ["demo-redis-connection-pool"],
    createdAt: timestamp,
    updatedAt: timestamp
  });
  await upsert("services", "redis-cache", orgId, {
    name: "redis-cache",
    team: "platform-squad",
    language: "Redis",
    dependencies: [],
    dependents: ["payment-service"],
    knownFragilePoints: ["max_connections", "connection pool exhaustion", "file descriptor limits"],
    slaMs: 25,
    owners: ["U05PLATFORM", "U02SRE"],
    runbookIds: ["demo-redis-connection-pool"],
    createdAt: timestamp,
    updatedAt: timestamp
  });
  await upsert("services", "postgres-main", orgId, {
    name: "postgres-main",
    team: "data-platform",
    language: "PostgreSQL",
    dependencies: [],
    dependents: ["payment-service"],
    knownFragilePoints: ["max connections", "long-running settlement queries"],
    slaMs: 80,
    owners: ["U06DATA", "U02SRE"],
    runbookIds: [],
    createdAt: timestamp,
    updatedAt: timestamp
  });
  await upsert("service_runtime_configs", "redis-cache", orgId, {
    serviceName: "redis-cache",
    incidentChannel: process.env.SLACK_DEFAULT_INCIDENT_CHANNEL ?? null,
    adminBaseUrl: "http://localhost:4105",
    cloudRunServiceName: "redis-cache",
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

async function seedRunbook(orgId: string): Promise<void> {
  const timestamp = nowIso();
  await upsert("runbooks", "demo-redis-connection-pool", orgId, {
    title: "Redis connection pool reset for payment checkout",
    incidentType: "redis-connection-pool-exhaustion",
    steps: [
      {
        order: 1,
        action: "Rotate connection pool on redis-cache",
        command: "rotate_connection_pool",
        isExecutable: true,
        riskLevel: "low"
      },
      {
        order: 2,
        action: "Scale redis-cache if ECONNRESET remains above threshold",
        command: "scale_service",
        isExecutable: true,
        riskLevel: "low"
      },
      {
        order: 3,
        action: "Review payment worker connection leak before the next deploy",
        command: null,
        isExecutable: false,
        riskLevel: "medium"
      }
    ],
    applicableServices: ["payment-service", "redis-cache"],
    successCriteria: "ECONNRESET drops below 5 events in 15 minutes and checkout latency returns under 500ms.",
    fallbackAction: "restart_pod",
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

async function seedHistoricalIncidents(orgId: string): Promise<void> {
  const timestamp = nowIso();
  for (const incident of historicalIncidents) {
    await upsert("incidents", incident._key, orgId, {
      ...incident,
      postMortemId: null,
      agentEvents: [],
      rawPayload: { demo: true, source: "seed-demo" },
      createdAt: incident.detectedAt,
      updatedAt: timestamp
    });
  }

  await sendEvent(
    historicalIncidents.map((incident) => ({
      index: "sentinel",
      sourcetype: "sentinel:postmortem",
      source: "seed-demo",
      event: {
        type: "postmortem",
        orgId,
        incidentId: scopedKey(orgId, incident._key),
        title: incident.title,
        severity: incident.severity,
        symptoms: incident.symptoms,
        rootCause: incident.rootCause,
        resolution: incident.resolution,
        remediationSteps: incident.remediationSteps,
        durationMinutes: incident.durationMinutes,
        preventionActions: ["Watch Redis connection pressure before checkout latency breaches the P1 threshold."],
        generatedBy: "sentinel",
        createdAt: incident.resolvedAt
      }
    }))
  );
}

async function main(): Promise<void> {
  const org = await ensureDemoOrg();
  await seedCollections();
  await clearPreviousDemoRuntime(org.orgId);
  await seedServices(org.orgId);
  await seedRunbook(org.orgId);
  await seedHistoricalIncidents(org.orgId);
  writeLine("✓ Demo Sentinel KV Store seeded");
  writeLine(` org: ${org.orgId}`);
  writeLine(" incidents: 3 Redis/payment historical matches");
  writeLine(" runbook: demo-redis-connection-pool");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  writeLine(`FAILED sentinel:demo:seed - ${message}`);
  process.exitCode = 1;
});
