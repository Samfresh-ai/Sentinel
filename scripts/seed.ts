import "dotenv/config";
import { ObjectId } from "mongodb";
import {
  closeMongoClient,
  createCollectionsAndIndexes,
  incidentsCollection,
  insertIncidentWithEmbedding,
  insertPatternWithEmbedding,
  insertRunbookWithEmbedding,
  patternsCollection,
  runbooksCollection,
  searchIncidentVectors,
  serviceRuntimeConfigsCollection,
  servicesCollection,
  upsertService,
  upsertServiceRuntimeConfig,
  type NewIncidentDocument,
  type NewPatternDocument,
  type NewRunbookDocument,
  type NewServiceRuntimeConfigDocument,
  type ServiceDocument
} from "@operaiq/brain";

function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

const now = new Date("2026-05-20T08:00:00.000Z");

function minutesAgo(minutes: number): Date {
  return new Date(now.getTime() - minutes * 60_000);
}

const runbooks: NewRunbookDocument[] = [
  {
    title: "Redis connection exhaustion recovery",
    incidentType: "redis-connection-exhaustion",
    steps: [
      {
        order: 1,
        action: "Rotate stale Redis client connection pools on affected services",
        command: "rotate_connection_pool",
        isExecutable: true,
        riskLevel: "low"
      },
      {
        order: 2,
        action: "Scale redis-cache minimum instances by one tier",
        command: "scale_service",
        isExecutable: true,
        riskLevel: "low"
      },
      {
        order: 3,
        action: "Review connection pool ceiling and deploy a config increase",
        command: null,
        isExecutable: false,
        riskLevel: "medium"
      }
    ],
    applicableServices: ["payment-service", "auth-service", "redis-cache"],
    successCriteria: "Redis connection errors fall below 1 percent and p99 latency returns under service SLA for 10 minutes."
  },
  {
    title: "PostgreSQL connection pool recovery",
    incidentType: "postgres-connection-pool-failure",
    steps: [
      {
        order: 1,
        action: "Reset stale application database connections",
        command: "rotate_connection_pool",
        isExecutable: true,
        riskLevel: "low"
      },
      {
        order: 2,
        action: "Scale the affected service to spread database demand",
        command: "scale_service",
        isExecutable: true,
        riskLevel: "low"
      },
      {
        order: 3,
        action: "Increase max pool size after owner approval",
        command: null,
        isExecutable: false,
        riskLevel: "medium"
      }
    ],
    applicableServices: ["payment-service", "auth-service", "postgres-main"],
    successCriteria: "Database wait time drops below 50 ms and application connection acquisition errors stop."
  },
  {
    title: "Node.js memory leak and OOM recovery",
    incidentType: "node-memory-leak-oomkill",
    steps: [
      {
        order: 1,
        action: "Restart only pods or revisions with high heap growth",
        command: "restart_pod",
        isExecutable: true,
        riskLevel: "low"
      },
      {
        order: 2,
        action: "Scale service horizontally to reduce memory pressure",
        command: "scale_service",
        isExecutable: true,
        riskLevel: "low"
      },
      {
        order: 3,
        action: "Capture heap snapshot for owner review",
        command: null,
        isExecutable: false,
        riskLevel: "medium"
      }
    ],
    applicableServices: ["payment-service", "auth-service", "notification-service"],
    successCriteria: "No new OOMKill events for 15 minutes and heap growth slope normalizes."
  },
  {
    title: "Stripe rate limiting mitigation",
    incidentType: "stripe-api-rate-limiting",
    steps: [
      {
        order: 1,
        action: "Enable conservative retry backoff configuration",
        command: "purge_cache",
        isExecutable: true,
        riskLevel: "low"
      },
      {
        order: 2,
        action: "Notify payments owners with rate-limit context",
        command: "notify_team",
        isExecutable: true,
        riskLevel: "low"
      },
      {
        order: 3,
        action: "Temporarily disable non-critical payment enrichment calls",
        command: null,
        isExecutable: false,
        riskLevel: "high"
      }
    ],
    applicableServices: ["payment-service"],
    successCriteria: "Stripe 429 responses stay under 0.5 percent and payment authorization succeeds above 99 percent."
  },
  {
    title: "S3 permission regression recovery",
    incidentType: "s3-bucket-permission-error",
    steps: [
      {
        order: 1,
        action: "Notify service owners with the failing bucket and IAM principal",
        command: "notify_team",
        isExecutable: true,
        riskLevel: "low"
      },
      {
        order: 2,
        action: "Restart service to reload credentials after policy correction",
        command: "restart_pod",
        isExecutable: true,
        riskLevel: "low"
      },
      {
        order: 3,
        action: "Restore the last known-good IAM policy after approval",
        command: null,
        isExecutable: false,
        riskLevel: "high"
      }
    ],
    applicableServices: ["notification-service"],
    successCriteria: "Object read and write calls return 2xx for the affected bucket from the service role."
  },
  {
    title: "DNS resolution failure recovery",
    incidentType: "dns-resolution-failure",
    steps: [
      {
        order: 1,
        action: "Purge application DNS cache",
        command: "purge_cache",
        isExecutable: true,
        riskLevel: "low"
      },
      {
        order: 2,
        action: "Restart affected service instances with stale resolver state",
        command: "restart_pod",
        isExecutable: true,
        riskLevel: "low"
      },
      {
        order: 3,
        action: "Escalate provider DNS outage to platform owners",
        command: "notify_team",
        isExecutable: true,
        riskLevel: "low"
      }
    ],
    applicableServices: ["payment-service", "auth-service", "notification-service"],
    successCriteria: "Name resolution succeeds from all service instances and upstream error rate returns to baseline."
  },
  {
    title: "CPU saturation mitigation",
    incidentType: "payment-service-cpu-spike",
    steps: [
      {
        order: 1,
        action: "Scale the saturated Cloud Run service horizontally",
        command: "scale_service",
        isExecutable: true,
        riskLevel: "low"
      },
      {
        order: 2,
        action: "Purge hot-cache entries causing repeated recomputation",
        command: "purge_cache",
        isExecutable: true,
        riskLevel: "low"
      },
      {
        order: 3,
        action: "Disable the expensive feature flag after owner approval",
        command: null,
        isExecutable: false,
        riskLevel: "medium"
      }
    ],
    applicableServices: ["payment-service"],
    successCriteria: "CPU utilization remains below 70 percent and p99 latency stays under SLA for 10 minutes."
  },
  {
    title: "Logging disk pressure and upstream timeout recovery",
    incidentType: "disk-full-upstream-timeout",
    steps: [
      {
        order: 1,
        action: "Notify platform owners with disk pressure or timeout evidence",
        command: "notify_team",
        isExecutable: true,
        riskLevel: "low"
      },
      {
        order: 2,
        action: "Restart affected workers after log rotation or upstream recovery",
        command: "restart_pod",
        isExecutable: true,
        riskLevel: "low"
      },
      {
        order: 3,
        action: "Increase disk allocation or timeout budgets after approval",
        command: null,
        isExecutable: false,
        riskLevel: "medium"
      }
    ],
    applicableServices: ["payment-service", "notification-service"],
    successCriteria: "Write errors stop and queue depth drains to normal operating range."
  }
];

const incidents: NewIncidentDocument[] = [
  {
    title: "INC-2026-0101 Redis connection pool exhausted during checkout",
    severity: "P1",
    status: "resolved",
    symptoms: ["high checkout latency", "Redis connection timeouts", "payment-service connection pool exhausted"],
    affectedServices: ["payment-service", "redis-cache"],
    rootCause: "A release reduced Redis client idle timeout while traffic increased, leaving stale sockets in the pool.",
    resolution: "Rotated the payment-service connection pool and scaled redis-cache min instances.",
    remediationSteps: ["rotate_connection_pool payment-service", "scale_service redis-cache"],
    detectedAt: minutesAgo(18_000),
    resolvedAt: minutesAgo(17_957),
    durationMinutes: 43,
    postMortemId: null
  },
  {
    title: "INC-2026-0102 Auth login failures from Redis maxclients",
    severity: "P2",
    status: "resolved",
    symptoms: ["login timeout", "Redis maxclients reached", "auth-service cache writes failing"],
    affectedServices: ["auth-service", "redis-cache"],
    rootCause: "A token refresh job opened Redis clients without closing them after errors.",
    resolution: "Restarted leaking auth-service revisions and raised Redis connection pool headroom.",
    remediationSteps: ["restart_pod auth-service", "rotate_connection_pool auth-service"],
    detectedAt: minutesAgo(17_600),
    resolvedAt: minutesAgo(17_578),
    durationMinutes: 22,
    postMortemId: null
  },
  {
    title: "INC-2026-0110 PostgreSQL pool saturation blocked payment capture",
    severity: "P1",
    status: "resolved",
    symptoms: ["database connection timeout", "postgres pool exhausted", "payment capture failing"],
    affectedServices: ["payment-service", "postgres-main"],
    rootCause: "Long-running settlement queries held application pool connections during peak checkout.",
    resolution: "Killed stale settlement sessions, rotated app pools, and scaled payment-service.",
    remediationSteps: ["rotate_connection_pool postgres-main", "scale_service payment-service"],
    detectedAt: minutesAgo(16_500),
    resolvedAt: minutesAgo(16_461),
    durationMinutes: 39,
    postMortemId: null
  },
  {
    title: "INC-2026-0111 Auth service exhausted PostgreSQL connections",
    severity: "P2",
    status: "resolved",
    symptoms: ["database connection timeout", "auth token lookup slow", "PostgreSQL too many clients"],
    affectedServices: ["auth-service", "postgres-main"],
    rootCause: "A migration worker and auth-service shared the same small connection ceiling.",
    resolution: "Paused migration worker and rotated auth-service pools after increasing pool limits.",
    remediationSteps: ["notify_team auth-service", "rotate_connection_pool auth-service"],
    detectedAt: minutesAgo(15_900),
    resolvedAt: minutesAgo(15_874),
    durationMinutes: 26,
    postMortemId: null
  },
  {
    title: "INC-2026-0120 Node.js heap growth in payment webhooks",
    severity: "P2",
    status: "resolved",
    symptoms: ["Node.js heap growth", "GC pause spikes", "webhook handler latency"],
    affectedServices: ["payment-service"],
    rootCause: "Webhook validation cached full request bodies in memory instead of bounded hashes.",
    resolution: "Restarted hot revisions and deployed the bounded cache patch.",
    remediationSteps: ["restart_pod payment-service", "scale_service payment-service"],
    detectedAt: minutesAgo(15_000),
    resolvedAt: minutesAgo(14_952),
    durationMinutes: 48,
    postMortemId: null
  },
  {
    title: "INC-2026-0121 Notification worker memory leak delayed sends",
    severity: "P3",
    status: "resolved",
    symptoms: ["RSS memory climbing", "notification queue lag", "Node.js memory leak"],
    affectedServices: ["notification-service"],
    rootCause: "Template rendering retained per-recipient personalization objects past send completion.",
    resolution: "Restarted leaking workers and disabled the new personalization cache.",
    remediationSteps: ["restart_pod notification-service", "notify_team notification-service"],
    detectedAt: minutesAgo(14_400),
    resolvedAt: minutesAgo(14_371),
    durationMinutes: 29,
    postMortemId: null
  },
  {
    title: "INC-2026-0130 Kubernetes OOMKill loop in auth-service",
    severity: "P2",
    status: "resolved",
    symptoms: ["Kubernetes OOMKill", "pod restart loop", "auth-service 503 responses"],
    affectedServices: ["auth-service"],
    rootCause: "JWT key refresh loaded duplicate keysets on every refresh cycle.",
    resolution: "Restarted affected pods and rolled forward a keyset de-duplication patch.",
    remediationSteps: ["restart_pod auth-service", "notify_team auth-service"],
    detectedAt: minutesAgo(13_500),
    resolvedAt: minutesAgo(13_464),
    durationMinutes: 36,
    postMortemId: null
  },
  {
    title: "INC-2026-0131 Payment worker OOMKilled during reconciliation",
    severity: "P3",
    status: "resolved",
    symptoms: ["pod OOMKilled", "batch reconciliation stalled", "memory limit exceeded"],
    affectedServices: ["payment-service"],
    rootCause: "A reconciliation batch loaded all unsettled invoices into a single in-memory array.",
    resolution: "Restarted the worker and reduced batch size to stream invoices in pages.",
    remediationSteps: ["restart_pod payment-service", "notify_team payment-service"],
    detectedAt: minutesAgo(12_900),
    resolvedAt: minutesAgo(12_881),
    durationMinutes: 19,
    postMortemId: null
  },
  {
    title: "INC-2026-0140 Stripe 429 rate limiting degraded payments",
    severity: "P1",
    status: "resolved",
    symptoms: ["Stripe 429", "payment authorization retries", "rate limit exceeded"],
    affectedServices: ["payment-service"],
    rootCause: "A retry policy retried Stripe authorization immediately after transient failures.",
    resolution: "Enabled conservative backoff and disabled non-critical Stripe enrichment calls.",
    remediationSteps: ["purge_cache payment-service", "notify_team payment-service"],
    detectedAt: minutesAgo(12_100),
    resolvedAt: minutesAgo(12_058),
    durationMinutes: 42,
    postMortemId: null
  },
  {
    title: "INC-2026-0141 Stripe customer sync hit write rate limits",
    severity: "P2",
    status: "resolved",
    symptoms: ["Stripe API rate limiting", "customer sync backlog", "HTTP 429 responses"],
    affectedServices: ["payment-service"],
    rootCause: "A backfill job ignored rate-limit headers while syncing customer metadata.",
    resolution: "Paused the backfill and notified payments owners to resume with lower concurrency.",
    remediationSteps: ["notify_team payment-service"],
    detectedAt: minutesAgo(11_700),
    resolvedAt: minutesAgo(11_681),
    durationMinutes: 19,
    postMortemId: null
  },
  {
    title: "INC-2026-0150 S3 bucket permission regression blocked notifications",
    severity: "P2",
    status: "resolved",
    symptoms: ["S3 AccessDenied", "template asset reads failing", "notification send errors"],
    affectedServices: ["notification-service"],
    rootCause: "An IAM policy update removed read access to the transactional-template bucket.",
    resolution: "Restored the last known-good bucket policy and restarted notification workers.",
    remediationSteps: ["notify_team notification-service", "restart_pod notification-service"],
    detectedAt: minutesAgo(10_900),
    resolvedAt: minutesAgo(10_875),
    durationMinutes: 25,
    postMortemId: null
  },
  {
    title: "INC-2026-0151 S3 write denied for email attachments",
    severity: "P3",
    status: "resolved",
    symptoms: ["S3 PutObject denied", "attachment upload failed", "permission boundary mismatch"],
    affectedServices: ["notification-service"],
    rootCause: "A new deployment used a service account missing the attachment bucket write role.",
    resolution: "Corrected the service account binding and restarted the affected revision.",
    remediationSteps: ["notify_team notification-service", "restart_pod notification-service"],
    detectedAt: minutesAgo(10_300),
    resolvedAt: minutesAgo(10_287),
    durationMinutes: 13,
    postMortemId: null
  },
  {
    title: "INC-2026-0160 DNS resolution failure for Redis endpoint",
    severity: "P1",
    status: "resolved",
    symptoms: ["DNS SERVFAIL", "redis-cache hostname unresolved", "payment-service upstream errors"],
    affectedServices: ["payment-service", "redis-cache"],
    rootCause: "A resolver cache held a bad internal DNS response after a zone update.",
    resolution: "Purged application DNS caches and restarted payment-service instances.",
    remediationSteps: ["purge_cache payment-service", "restart_pod payment-service"],
    detectedAt: minutesAgo(9_400),
    resolvedAt: minutesAgo(9_367),
    durationMinutes: 33,
    postMortemId: null
  },
  {
    title: "INC-2026-0161 Auth service DNS lookup failures to postgres-main",
    severity: "P2",
    status: "resolved",
    symptoms: ["DNS lookup timeout", "postgres-main hostname unresolved", "auth-service login errors"],
    affectedServices: ["auth-service", "postgres-main"],
    rootCause: "Node resolver state became stale after the private DNS zone was recreated.",
    resolution: "Restarted auth-service pods and confirmed resolver cache recovery.",
    remediationSteps: ["restart_pod auth-service", "notify_team auth-service"],
    detectedAt: minutesAgo(8_900),
    resolvedAt: minutesAgo(8_879),
    durationMinutes: 21,
    postMortemId: null
  },
  {
    title: "INC-2026-0170 CPU spike in payment-service price calculation",
    severity: "P1",
    status: "resolved",
    symptoms: ["CPU above 95 percent", "payment-service p99 latency", "price calculation hot path"],
    affectedServices: ["payment-service"],
    rootCause: "A feature flag enabled per-request recomputation of tax and discount rules.",
    resolution: "Scaled payment-service and disabled the expensive calculation flag after approval.",
    remediationSteps: ["scale_service payment-service", "notify_team payment-service"],
    detectedAt: minutesAgo(8_200),
    resolvedAt: minutesAgo(8_166),
    durationMinutes: 34,
    postMortemId: null
  },
  {
    title: "INC-2026-0171 CPU saturation from auth token introspection",
    severity: "P2",
    status: "resolved",
    symptoms: ["CPU spike", "token introspection slow", "auth-service p99 latency"],
    affectedServices: ["auth-service"],
    rootCause: "A cache key bug caused token introspection to bypass Redis on every request.",
    resolution: "Purged bad cache entries and restarted auth-service revisions with a fixed key format.",
    remediationSteps: ["purge_cache auth-service", "restart_pod auth-service"],
    detectedAt: minutesAgo(7_700),
    resolvedAt: minutesAgo(7_681),
    durationMinutes: 19,
    postMortemId: null
  },
  {
    title: "INC-2026-0180 Disk full on logging sidecar blocked notifications",
    severity: "P2",
    status: "resolved",
    symptoms: ["disk full", "logging service write errors", "notification queue stalled"],
    affectedServices: ["notification-service"],
    rootCause: "A debug log level generated large payload logs and filled ephemeral disk.",
    resolution: "Rotated logs, lowered log level, and restarted notification workers.",
    remediationSteps: ["notify_team notification-service", "restart_pod notification-service"],
    detectedAt: minutesAgo(7_100),
    resolvedAt: minutesAgo(7_077),
    durationMinutes: 23,
    postMortemId: null
  },
  {
    title: "INC-2026-0181 Payment logs exhausted disk during reconciliation",
    severity: "P3",
    status: "resolved",
    symptoms: ["disk pressure", "write ENOSPC", "reconciliation worker stopped"],
    affectedServices: ["payment-service"],
    rootCause: "Verbose reconciliation logs were written to local disk during a large backfill.",
    resolution: "Restarted the worker after log rotation and reduced reconciliation log verbosity.",
    remediationSteps: ["restart_pod payment-service", "notify_team payment-service"],
    detectedAt: minutesAgo(6_600),
    resolvedAt: minutesAgo(6_584),
    durationMinutes: 16,
    postMortemId: null
  },
  {
    title: "INC-2026-0190 Cascading failure from Stripe timeout",
    severity: "P1",
    status: "resolved",
    symptoms: ["upstream dependency timeout", "payment retries amplified", "checkout unavailable"],
    affectedServices: ["payment-service"],
    rootCause: "Stripe API latency exceeded the payment-service timeout and retry budget, amplifying queue pressure.",
    resolution: "Enabled backoff, notified payments owners, and temporarily reduced non-critical upstream calls.",
    remediationSteps: ["notify_team payment-service", "purge_cache payment-service"],
    detectedAt: minutesAgo(6_100),
    resolvedAt: minutesAgo(6_061),
    durationMinutes: 39,
    postMortemId: null
  },
  {
    title: "INC-2026-0191 Auth dependency timeout cascaded into payment checkout",
    severity: "P2",
    status: "resolved",
    symptoms: ["upstream auth timeout", "payment-service dependency errors", "checkout session creation failed"],
    affectedServices: ["payment-service", "auth-service"],
    rootCause: "Auth-service latency breached the payment-service timeout after auth cache misses surged.",
    resolution: "Purged auth cache, scaled auth-service, and payment checkout recovered.",
    remediationSteps: ["purge_cache auth-service", "scale_service auth-service"],
    detectedAt: minutesAgo(5_500),
    resolvedAt: minutesAgo(5_474),
    durationMinutes: 26,
    postMortemId: null
  }
];

const patterns: NewPatternDocument[] = [
  {
    name: "redis-connection-pool-exhaustion",
    symptomSignals: ["Redis connection timeouts", "maxclients reached", "connection pool exhausted"],
    likelyCauses: ["Stale sockets", "client leak", "undersized Redis pool"],
    confirmedCount: 7
  },
  {
    name: "database-connection-pool-timeout",
    symptomSignals: ["database connection timeout", "too many clients", "pool wait timeout"],
    likelyCauses: ["Long-running queries", "shared migration pool", "pool ceiling too low"],
    confirmedCount: 6
  },
  {
    name: "node-memory-leak-oomkill",
    symptomSignals: ["Node.js heap growth", "RSS memory climbing", "Kubernetes OOMKill"],
    likelyCauses: ["Unbounded in-memory cache", "large batch load", "duplicated keyset retention"],
    confirmedCount: 5
  },
  {
    name: "external-api-rate-limit",
    symptomSignals: ["HTTP 429", "rate limit exceeded", "retry storm"],
    likelyCauses: ["Aggressive retry policy", "backfill concurrency", "missing rate-limit header handling"],
    confirmedCount: 4
  },
  {
    name: "dependency-resolution-or-timeout",
    symptomSignals: ["DNS SERVFAIL", "upstream dependency timeout", "hostname unresolved"],
    likelyCauses: ["Stale DNS cache", "provider outage", "timeout budget mismatch"],
    confirmedCount: 5
  }
];

function runbookIdsFor(types: string[], ids: Map<string, ObjectId>): ObjectId[] {
  return types.map((type) => {
    const id = ids.get(type);
    if (!id) {
      throw new Error(`Missing runbook ID for ${type}`);
    }
    return id;
  });
}

function configuredIncidentChannel(): string | null {
  const channel = process.env.SLACK_DEFAULT_INCIDENT_CHANNEL;
  return channel && channel.trim().length > 0 ? channel : null;
}

function optionalEnv(name: string): string | null {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : null;
}

function serviceRuntimeConfig(
  adminBaseUrlEnv: string,
  cloudRunServiceNameEnv: string
): Omit<NewServiceRuntimeConfigDocument, "serviceName"> {
  return {
    incidentChannel: configuredIncidentChannel(),
    adminBaseUrl: optionalEnv(adminBaseUrlEnv),
    cloudRunServiceName: optionalEnv(cloudRunServiceNameEnv)
  };
}

async function seedService(
  service: Omit<ServiceDocument, "_id" | "createdAt" | "updatedAt">,
  runtimeConfig: Omit<NewServiceRuntimeConfigDocument, "serviceName">
): Promise<void> {
  await upsertService(service);
  await upsertServiceRuntimeConfig({
    serviceName: service.name,
    ...runtimeConfig
  });
}

async function resetSeedDocuments(): Promise<void> {
  await (await incidentsCollection()).deleteMany({ title: { $in: incidents.map((incident) => incident.title) } });
  await (await servicesCollection()).deleteMany({
    name: { $in: ["payment-service", "auth-service", "notification-service", "redis-cache", "postgres-main"] }
  });
  await (await serviceRuntimeConfigsCollection()).deleteMany({
    serviceName: { $in: ["payment-service", "auth-service", "notification-service", "redis-cache", "postgres-main"] }
  });
  await (await runbooksCollection()).deleteMany({ incidentType: { $in: runbooks.map((runbook) => runbook.incidentType) } });
  await (await patternsCollection()).deleteMany({ name: { $in: patterns.map((pattern) => pattern.name) } });
}

async function seed(): Promise<void> {
  await createCollectionsAndIndexes();
  await resetSeedDocuments();

  const runbookIds = new Map<string, ObjectId>();
  for (const runbook of runbooks) {
    const id = await insertRunbookWithEmbedding(runbook);
    runbookIds.set(runbook.incidentType, id);
  }

  await seedService(
    {
      name: "payment-service",
      team: "payments-squad",
      language: "Node.js",
      dependencies: ["redis-cache", "postgres-main", "stripe-api", "auth-service"],
      dependents: [],
      knownFragilePoints: ["Redis connection pool", "Stripe rate limits", "tax calculation CPU hot path"],
      slaMs: 300,
      owners: ["U01PAYMENTS", "U02SRE"],
      runbookIds: runbookIdsFor(
        [
          "redis-connection-exhaustion",
          "postgres-connection-pool-failure",
          "stripe-api-rate-limiting",
          "payment-service-cpu-spike",
          "disk-full-upstream-timeout"
        ],
        runbookIds
      )
    },
    serviceRuntimeConfig("OPERAIQ_PAYMENT_SERVICE_ADMIN_BASE_URL", "OPERAIQ_PAYMENT_SERVICE_CLOUD_RUN_SERVICE_NAME")
  );

  await seedService(
    {
      name: "auth-service",
      team: "identity-squad",
      language: "Node.js",
      dependencies: ["redis-cache", "postgres-main"],
      dependents: ["payment-service"],
      knownFragilePoints: ["JWT key refresh", "Token introspection cache", "PostgreSQL auth pool"],
      slaMs: 180,
      owners: ["U03IDENTITY", "U02SRE"],
      runbookIds: runbookIdsFor(
        ["redis-connection-exhaustion", "postgres-connection-pool-failure", "node-memory-leak-oomkill", "dns-resolution-failure"],
        runbookIds
      )
    },
    serviceRuntimeConfig("OPERAIQ_AUTH_SERVICE_ADMIN_BASE_URL", "OPERAIQ_AUTH_SERVICE_CLOUD_RUN_SERVICE_NAME")
  );

  await seedService(
    {
      name: "notification-service",
      team: "messaging-squad",
      language: "Node.js",
      dependencies: ["postgres-main"],
      dependents: [],
      knownFragilePoints: ["S3 template permissions", "Queue lag", "Template renderer memory"],
      slaMs: 1_000,
      owners: ["U04MESSAGING", "U02SRE"],
      runbookIds: runbookIdsFor(["node-memory-leak-oomkill", "s3-bucket-permission-error", "disk-full-upstream-timeout"], runbookIds)
    },
    serviceRuntimeConfig("OPERAIQ_NOTIFICATION_SERVICE_ADMIN_BASE_URL", "OPERAIQ_NOTIFICATION_SERVICE_CLOUD_RUN_SERVICE_NAME")
  );

  await seedService(
    {
      name: "redis-cache",
      team: "platform-squad",
      language: "Redis",
      dependencies: [],
      dependents: ["payment-service", "auth-service"],
      knownFragilePoints: ["maxclients", "eviction pressure", "connection storms"],
      slaMs: 25,
      owners: ["U05PLATFORM", "U02SRE"],
      runbookIds: runbookIdsFor(["redis-connection-exhaustion"], runbookIds)
    },
    serviceRuntimeConfig("OPERAIQ_REDIS_CACHE_ADMIN_BASE_URL", "OPERAIQ_REDIS_CACHE_CLOUD_RUN_SERVICE_NAME")
  );

  await seedService(
    {
      name: "postgres-main",
      team: "data-platform",
      language: "PostgreSQL",
      dependencies: [],
      dependents: ["payment-service", "auth-service", "notification-service"],
      knownFragilePoints: ["max connections", "long-running settlement queries", "migration worker contention"],
      slaMs: 80,
      owners: ["U06DATA", "U02SRE"],
      runbookIds: runbookIdsFor(["postgres-connection-pool-failure"], runbookIds)
    },
    serviceRuntimeConfig("OPERAIQ_POSTGRES_MAIN_ADMIN_BASE_URL", "OPERAIQ_POSTGRES_MAIN_CLOUD_RUN_SERVICE_NAME")
  );

  for (const incident of incidents) {
    await insertIncidentWithEmbedding(incident);
  }

  for (const pattern of patterns) {
    await insertPatternWithEmbedding(pattern);
  }

  const embeddingProvider = process.env.OPERAIQ_AI_PROVIDER === "offline" ? "offline deterministic" : "Vertex AI";
  writeLine(
    `PASSED seed - inserted 20 incidents, 5 services, 5 service runtime configs, 8 runbooks, and 5 patterns with ${embeddingProvider} embeddings`
  );
}

async function verifySeed(): Promise<void> {
  const incidentCount = await (await incidentsCollection()).countDocuments({ title: { $in: incidents.map((incident) => incident.title) } });
  const serviceCount = await (await servicesCollection()).countDocuments({
    name: { $in: ["payment-service", "auth-service", "notification-service", "redis-cache", "postgres-main"] }
  });
  const serviceRuntimeConfigCount = await (await serviceRuntimeConfigsCollection()).countDocuments({
    serviceName: { $in: ["payment-service", "auth-service", "notification-service", "redis-cache", "postgres-main"] }
  });
  const runbookCount = await (await runbooksCollection()).countDocuments({
    incidentType: { $in: runbooks.map((runbook) => runbook.incidentType) }
  });
  const patternCount = await (await patternsCollection()).countDocuments({ name: { $in: patterns.map((pattern) => pattern.name) } });
  const vectorResults = await searchIncidentVectors("database connection timeout", 5);
  const databaseMatches = vectorResults.filter((result) =>
    [result.title, result.rootCause ?? "", result.resolution ?? "", result.remediationSteps.join(" ")]
      .join(" ")
      .toLowerCase()
      .includes("postgres")
  );

  const failures: string[] = [];
  if (incidentCount !== 20) failures.push(`expected 20 seeded incidents, found ${incidentCount}`);
  if (serviceCount !== 5) failures.push(`expected 5 seeded services, found ${serviceCount}`);
  if (serviceRuntimeConfigCount !== 5) failures.push(`expected 5 seeded service runtime configs, found ${serviceRuntimeConfigCount}`);
  if (runbookCount !== 8) failures.push(`expected 8 seeded runbooks, found ${runbookCount}`);
  if (patternCount !== 5) failures.push(`expected 5 seeded patterns, found ${patternCount}`);
  if (vectorResults.length < 3 || databaseMatches.length < 3) {
    failures.push(`expected at least 3 database vector matches, found ${databaseMatches.length}`);
  }

  if (failures.length > 0) {
    throw new Error(failures.join("; "));
  }
  writeLine("PASSED seed:verify - seed counts are correct and database connection timeout returns 3+ vector matches");
}

async function main(): Promise<void> {
  if (process.argv.includes("--verify")) {
    await verifySeed();
    return;
  }
  await seed();
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    writeLine(`FAILED seed - ${message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeMongoClient();
  });
