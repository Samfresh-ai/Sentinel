import "dotenv/config";
import { runSearch, sendEvent, splunkRestRequest, type SplunkHECEvent } from "@operaiq/splunk-brain";
import { z } from "zod";

const PROD_INDEX = "prod";
const APP_SOURCETYPE = "app";

function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

function applyDemoRemediationWaitEnv(): void {
  const raw = process.env.DEMO_REMEDIATION_WAIT_MS;
  if (!raw) return;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 60_000) {
    throw new Error(`DEMO_REMEDIATION_WAIT_MS must be between 0 and 60000, received ${raw}`);
  }
  process.env.OPERAIQ_REMEDIATION_WAIT_MS = String(parsed);
}

function timestamp(secondsAgo: number): number {
  return Date.now() / 1000 - secondsAgo;
}

async function ensureIndex(name: string): Promise<void> {
  const path = `/services/data/indexes/${encodeURIComponent(name)}`;
  const exists = await splunkRestRequest(z.record(z.unknown()).default({}), {
    path,
    query: { output_mode: "json" }
  }).catch(() => null);
  if (exists) return;

  await splunkRestRequest(z.record(z.unknown()).default({}), {
    method: "POST",
    path: "/services/data/indexes",
    form: { name, output_mode: "json" }
  });
}

async function clearPreviousDemoEvents(): Promise<void> {
  await runSearch("search index=prod demoScenario=sentinel_payment_redis_spike | delete", { maxResults: 1001 });
}

function appEvent(input: {
  time: number;
  host?: string;
  source: string;
  service: string;
  event: Record<string, unknown>;
}): SplunkHECEvent {
  return {
    time: input.time,
    index: PROD_INDEX,
    sourcetype: APP_SOURCETYPE,
    source: input.source,
    host: input.host ?? "localhost",
    ...(input.service === "payment-service" ? { fields: { service: "payment" } } : {}),
    event: {
      service: input.service,
      environment: "prod",
      demoScenario: "sentinel_payment_redis_spike",
      ...input.event
    }
  };
}

function baselineEvents(): SplunkHECEvent[] {
  const templates = [
    {
      service: "payment-service",
      source: "payment-service",
      event: { level: "info", message: "request processed", duration_ms: 120, status: 200 }
    },
    {
      service: "redis-cache",
      source: "redis-cache",
      event: { level: "info", message: "cache hit", key: "session:user123" }
    },
    {
      service: "payment-service",
      source: "payment-service",
      event: { level: "info", message: "stripe charge ok", amount: 4900 }
    }
  ];

  return Array.from({ length: 30 }, (_, index) => {
    const template = templates[index % templates.length]!;
    return appEvent({
      time: timestamp(180 - index * 4),
      host: template.service === "payment-service" ? `payment-pod-${(index % 2) + 1}` : "redis-0",
      source: template.source,
      service: template.service,
      event: template.event
    });
  });
}

function degradationEvents(): SplunkHECEvent[] {
  const templates = [
    {
      service: "payment-service",
      source: "payment-service",
      host: "payment-pod-1",
      event: { level: "error", message: "Redis ECONNRESET", error_type: "ECONNRESET", duration_ms: 1840 }
    },
    {
      service: "payment-service",
      source: "payment-service",
      host: "payment-pod-2",
      event: { level: "warn", message: "p99 latency elevated", duration_ms: 1840, threshold_ms: 500 }
    },
    {
      service: "redis-cache",
      source: "redis-cache",
      host: "redis-0",
      event: { level: "error", message: "connection pool exhausted", active_connections: 500, max_connections: 500 }
    }
  ];

  return Array.from({ length: 69 }, (_, index) => {
    const template = templates[index % templates.length]!;
    return appEvent({
      time: timestamp(60 - index * 0.75),
      host: template.host,
      source: template.source,
      service: template.service,
      event: template.event
    });
  });
}

function spikeEvents(): SplunkHECEvent[] {
  return Array.from({ length: 30 }, (_, index) => {
    if (index < 24) {
      const pod = index % 2 === 0 ? "payment-pod-1" : "payment-pod-2";
      return appEvent({
        time: timestamp(15 - index * 0.25),
        host: pod,
        source: "payment-service",
        service: "payment-service",
        event: {
          level: "error",
          message: "Redis ECONNRESET",
          error_type: "ECONNRESET",
          duration_ms: index % 2 === 0 ? 4200 : 4350,
          host: pod
        }
      });
    }

    return appEvent({
      time: timestamp(15 - index * 0.25),
      host: "payment-pod-2",
      source: "payment-service",
      service: "payment-service",
      event: {
        level: "error",
        message: "checkout failed",
        error_type: "UPSTREAM_TIMEOUT",
        user_id: `u_${8821 + index}`
      }
    });
  });
}

function numberField(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function queryDemoCounts(): Promise<{ total: number; econnreset: number }> {
  const totalRows = await runSearch("index=prod demoScenario=sentinel_payment_redis_spike | stats count", { maxResults: 1 });
  const errorRows = await runSearch("index=prod sourcetype=app service=payment demoScenario=sentinel_payment_redis_spike | stats count by error_type", { maxResults: 10 });
  return {
    total: numberField(totalRows[0]?.count),
    econnreset: numberField(errorRows.find((row) => row.error_type === "ECONNRESET")?.count)
  };
}

async function waitForIndexedCounts(expectedTotal: number): Promise<{ total: number; econnreset: number }> {
  let latest = await queryDemoCounts();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (latest.total >= expectedTotal && latest.econnreset >= 40 && latest.econnreset <= 60) {
      return latest;
    }
    await delay(1_000);
    latest = await queryDemoCounts();
  }
  throw new Error(`Demo logs did not index cleanly: total=${latest.total}, ECONNRESET=${latest.econnreset}`);
}

async function main(): Promise<void> {
  applyDemoRemediationWaitEnv();
  await ensureIndex(PROD_INDEX);
  await clearPreviousDemoEvents();

  const events = [...baselineEvents(), ...degradationEvents(), ...spikeEvents()];
  await sendEvent(events);

  const { total, econnreset } = await waitForIndexedCounts(events.length);

  writeLine("✓ Demo logs sent to Splunk");
  writeLine(` index=prod | total events: ${total}`);
  writeLine(` ECONNRESET count: ${econnreset}`);
  writeLine(" Autonomous: saved search fires if pnpm sentinel:demo:setup has run");
  writeLine(" Manual fast-path: pnpm sentinel:demo");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  writeLine(`FAILED sentinel:demo:logs - ${message}`);
  process.exitCode = 1;
});
