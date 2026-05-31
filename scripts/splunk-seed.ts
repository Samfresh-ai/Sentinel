import "dotenv/config";
import {
  batchInsert,
  clearCollection,
  createCollection,
  sendEvent,
  waitForSplunkReady
} from "@sentinel/splunk-brain";
import { incidents, patterns, runbooks } from "./seed-data.js";
import { ensureSeedOrg } from "./test-org.js";

function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

const serviceNames = ["payment-service", "auth-service", "notification-service", "redis-cache", "postgres-main"];

function scopedKey(orgId: string, key: string): string {
  return `${orgId}-${key}`;
}

function optionalEnv(name: string): string | null {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : null;
}

function configuredIncidentChannel(): string | null {
  return optionalEnv("SLACK_DEFAULT_INCIDENT_CHANNEL");
}

function serviceRuntimeConfig(serviceName: string, adminBaseUrlEnv: string, cloudRunServiceNameEnv: string) {
  return {
    _key: serviceName,
    serviceName,
    incidentChannel: configuredIncidentChannel(),
    adminBaseUrl: optionalEnv(adminBaseUrlEnv),
    cloudRunServiceName: optionalEnv(cloudRunServiceNameEnv),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

const services = [
  {
    _key: "payment-service",
    name: "payment-service",
    team: "payments-squad",
    language: "Node.js",
    dependencies: ["redis-cache", "postgres-main", "stripe-api", "auth-service"],
    dependents: [],
    knownFragilePoints: ["Redis connection pool", "Stripe rate limits", "tax calculation CPU hot path"],
    slaMs: 300,
    owners: ["U01PAYMENTS", "U02SRE"],
    runbookIds: [
      "redis-connection-exhaustion",
      "postgres-connection-pool-failure",
      "stripe-api-rate-limiting",
      "payment-service-cpu-spike",
      "disk-full-upstream-timeout"
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    _key: "auth-service",
    name: "auth-service",
    team: "identity-squad",
    language: "Node.js",
    dependencies: ["redis-cache", "postgres-main"],
    dependents: ["payment-service"],
    knownFragilePoints: ["JWT key refresh", "Token introspection cache", "PostgreSQL auth pool"],
    slaMs: 180,
    owners: ["U03IDENTITY", "U02SRE"],
    runbookIds: ["redis-connection-exhaustion", "postgres-connection-pool-failure", "node-memory-leak-oomkill", "dns-resolution-failure"],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    _key: "notification-service",
    name: "notification-service",
    team: "messaging-squad",
    language: "Node.js",
    dependencies: ["postgres-main"],
    dependents: [],
    knownFragilePoints: ["S3 template permissions", "Queue lag", "Template renderer memory"],
    slaMs: 1000,
    owners: ["U04MESSAGING", "U02SRE"],
    runbookIds: ["node-memory-leak-oomkill", "s3-bucket-permission-error", "disk-full-upstream-timeout"],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    _key: "redis-cache",
    name: "redis-cache",
    team: "platform-squad",
    language: "Redis",
    dependencies: [],
    dependents: ["payment-service", "auth-service"],
    knownFragilePoints: ["maxclients", "eviction pressure", "connection storms"],
    slaMs: 25,
    owners: ["U05PLATFORM", "U02SRE"],
    runbookIds: ["redis-connection-exhaustion"],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    _key: "postgres-main",
    name: "postgres-main",
    team: "data-platform",
    language: "PostgreSQL",
    dependencies: [],
    dependents: ["payment-service", "auth-service", "notification-service"],
    knownFragilePoints: ["max connections", "long-running settlement queries", "migration worker contention"],
    slaMs: 80,
    owners: ["U06DATA", "U02SRE"],
    runbookIds: ["postgres-connection-pool-failure"],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
];

const runtimeConfigs = [
  serviceRuntimeConfig("payment-service", "SENTINEL_PAYMENT_SERVICE_ADMIN_BASE_URL", "SENTINEL_PAYMENT_SERVICE_CLOUD_RUN_SERVICE_NAME"),
  serviceRuntimeConfig("auth-service", "SENTINEL_AUTH_SERVICE_ADMIN_BASE_URL", "SENTINEL_AUTH_SERVICE_CLOUD_RUN_SERVICE_NAME"),
  serviceRuntimeConfig("notification-service", "SENTINEL_NOTIFICATION_SERVICE_ADMIN_BASE_URL", "SENTINEL_NOTIFICATION_SERVICE_CLOUD_RUN_SERVICE_NAME"),
  serviceRuntimeConfig("redis-cache", "SENTINEL_REDIS_CACHE_ADMIN_BASE_URL", "SENTINEL_REDIS_CACHE_CLOUD_RUN_SERVICE_NAME"),
  serviceRuntimeConfig("postgres-main", "SENTINEL_POSTGRES_MAIN_ADMIN_BASE_URL", "SENTINEL_POSTGRES_MAIN_CLOUD_RUN_SERVICE_NAME")
];

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

async function recreateCollections(orgId: string): Promise<void> {
  for (const name of ["incidents", "services", "service_runtime_configs", "runbooks", "postmortems", "patterns", "audit_log", "rate_limit_windows", "dead_letter", "remediation_executions"]) {
    await createCollection(name, {});
    await clearCollection(name, { orgId }).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  await waitForSplunkReady({
    onRetry: (attempt, message) => {
      if (attempt % 6 === 0) writeLine(`WAIT splunk-ready attempt=${attempt} last=${message}`);
    }
  });
  writeLine("PASSED splunk-ready - management API is reachable");

  const org = await ensureSeedOrg();
  await recreateCollections(org.orgId);
  const runbookKey = (incidentType: string) => scopedKey(org.orgId, incidentType);

  await batchInsert(
    "runbooks",
    runbooks.map((runbook) => ({
      _key: runbookKey(runbook.incidentType),
      ...runbook,
      fallbackAction: runbook.incidentType.includes("redis") ? "restart_pod" : "notify_team",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })),
    { orgId: org.orgId }
  );
  await batchInsert(
    "services",
    services.map((service) => ({
      ...service,
      _key: scopedKey(org.orgId, service.name),
      runbookIds: service.runbookIds.map(runbookKey)
    })),
    { orgId: org.orgId }
  );
  await batchInsert(
    "service_runtime_configs",
    runtimeConfigs.map((config) => ({
      ...config,
      _key: scopedKey(org.orgId, config.serviceName)
    })),
    { orgId: org.orgId }
  );
  await batchInsert(
    "incidents",
    incidents.map((incident, index) => ({
      _key: scopedKey(org.orgId, `seed-incident-${String(index + 1).padStart(2, "0")}`),
      ...incident,
      detectedAt: incident.detectedAt.toISOString(),
      resolvedAt: toIso(incident.resolvedAt),
      postMortemId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })),
    { orgId: org.orgId }
  );
  await batchInsert(
    "patterns",
    patterns.map((pattern) => ({
      _key: scopedKey(org.orgId, pattern.name),
      ...pattern,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })),
    { orgId: org.orgId }
  );

  await sendEvent(
    incidents.slice(0, 5).map((incident, index) => ({
      sourcetype: "sentinel:postmortem",
      event: {
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
        generatedBy: "sentinel"
      }
    }))
  );

  writeLine(`PASSED splunk:seed - inserted 20 incidents, ${serviceNames.length} services, 5 service runtime configs, 8 runbooks, 5 patterns, and 5 HEC post-mortem events`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  writeLine(`FAILED splunk:seed - ${message}`);
  process.exitCode = 1;
});
