import "dotenv/config";
import {
  batchInsert,
  clearCollection,
  createCollection,
  sendEvent,
  waitForQdrantReady
} from "@sentinel/splunk-brain";
import { incidents, patterns, runbooks } from "./seed-data.js";
import { ensureSeedOrg } from "./test-org.js";

function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

function scopedKey(orgId: string, key: string): string {
  return `${orgId}-${key}`;
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

const now = () => new Date().toISOString();

const services = [
  {
    _key: "payment-service",
    name: "payment-service",
    team: "payments-squad",
    language: "Node.js",
    dependencies: ["redis-cache", "postgres-main", "auth-service"],
    dependents: [],
    knownFragilePoints: ["Redis connection pool", "payment checkout failures", "p99 latency spikes"],
    slaMs: 300,
    owners: ["payments", "sre"],
    eventCount: 100,
    errorCount: 36,
    runbookIds: ["redis-connection-exhaustion"]
  },
  {
    _key: "redis-cache",
    name: "redis-cache",
    team: "platform-squad",
    language: "Redis",
    dependencies: [],
    dependents: ["payment-service", "auth-service"],
    knownFragilePoints: ["maxclients", "eviction pressure", "connection storms", "ECONNRESET"],
    slaMs: 25,
    owners: ["platform", "sre"],
    eventCount: 100,
    errorCount: 31,
    runbookIds: ["redis-connection-exhaustion"]
  },
  {
    _key: "postgres-main",
    name: "postgres-main",
    team: "data-platform",
    language: "PostgreSQL",
    dependencies: [],
    dependents: ["payment-service"],
    knownFragilePoints: ["max connections", "long-running settlement queries"],
    slaMs: 80,
    owners: ["data", "sre"],
    eventCount: 100,
    errorCount: 1,
    runbookIds: ["postgres-connection-pool-failure"]
  }
];

const runtimeConfigs = services.map((service) => ({
  _key: service.name,
  serviceName: service.name,
  incidentChannel: process.env.SLACK_DEFAULT_INCIDENT_CHANNEL || "local-verify",
  adminBaseUrl: process.env.AGENT_TOOL_EXECUTION_BASE_URL || process.env.API_PUBLIC_URL || "http://localhost:3001",
  cloudRunServiceName: null,
  createdAt: now(),
  updatedAt: now()
}));

async function recreateCollections(orgId: string): Promise<void> {
  for (const name of ["incidents", "services", "service_runtime_configs", "runbooks", "postmortems", "patterns", "audit_log", "events", "rate_limit_windows", "dead_letter", "remediation_executions"]) {
    await createCollection(name, {});
    await clearCollection(name, { orgId }).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  await waitForQdrantReady({
    onRetry: (attempt, message) => {
      if (attempt % 6 === 0) writeLine(`WAIT qdrant-ready attempt=${attempt} last=${message}`);
    }
  });
  writeLine("PASSED qdrant-ready - REST API is reachable");

  const org = await ensureSeedOrg();
  await recreateCollections(org.orgId);
  const runbookKey = (incidentType: string) => scopedKey(org.orgId, incidentType);

  await batchInsert(
    "runbooks",
    runbooks.map((runbook) => ({
      _key: runbookKey(runbook.incidentType),
      ...runbook,
      fallbackAction: runbook.incidentType.includes("redis") ? "rotate_connection_pool" : "notify_team",
      createdAt: now(),
      updatedAt: now()
    })),
    { orgId: org.orgId }
  );

  await batchInsert(
    "services",
    services.map((service) => ({
      ...service,
      _key: scopedKey(org.orgId, service.name),
      runbookIds: service.runbookIds.map(runbookKey),
      createdAt: now(),
      updatedAt: now()
    })),
    { orgId: org.orgId }
  );

  await batchInsert(
    "service_runtime_configs",
    runtimeConfigs.map((config) => ({ ...config, _key: scopedKey(org.orgId, config.serviceName) })),
    { orgId: org.orgId }
  );

  await batchInsert(
    "incidents",
    incidents.map((incident, index) => ({
      _key: scopedKey(org.orgId, `seed-incident-${String(index + 1).padStart(2, "0")}`),
      ...incident,
      kind: "incident_memory",
      status: "resolved",
      outcome: "resolved",
      detectedAt: incident.detectedAt.toISOString(),
      resolvedAt: toIso(incident.resolvedAt),
      postMortemId: null,
      createdAt: now(),
      updatedAt: now()
    })),
    { orgId: org.orgId }
  );

  await batchInsert(
    "patterns",
    patterns.map((pattern) => ({ _key: scopedKey(org.orgId, pattern.name), ...pattern, createdAt: now(), updatedAt: now() })),
    { orgId: org.orgId }
  );

  await sendEvent(
    incidents.slice(0, 5).map((incident, index) => ({
      sourcetype: "operaiq:postmortem",
      event: {
        kind: "postmortem",
        type: "postmortem",
        orgId: org.orgId,
        incidentId: scopedKey(org.orgId, `seed-incident-${String(index + 1).padStart(2, "0")}`),
        title: incident.title,
        severity: incident.severity,
        symptoms: incident.symptoms,
        rootCause: incident.rootCause,
        resolution: incident.resolution,
        remediationSteps: incident.remediationSteps,
        durationMinutes: incident.durationMinutes,
        preventionActions: ["Review alert thresholds and service ownership routing."],
        outcome: "resolved",
        generatedBy: "operaiq",
        createdAt: now()
      }
    }))
  );

  writeLine(`PASSED qdrant:seed - inserted ${incidents.length} incidents, ${services.length} services, ${runtimeConfigs.length} runtime configs, ${runbooks.length} runbooks, and ${patterns.length} patterns`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  writeLine(`FAILED qdrant:seed - ${message}`);
  process.exitCode = 1;
});
