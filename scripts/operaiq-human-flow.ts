import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { insertSentinelIncident, queryDocuments, waitForQdrantReady } from "@sentinel/splunk-brain";
import { runSentinelAgent } from "@sentinel/agent";
import { ensureSeedOrg } from "./test-org.js";

const ARTIFACT_DIR = "artifacts/runtime";

function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
  await waitForQdrantReady();
  process.env.SENTINEL_MODE = "true";
  process.env.AGENT_NAME = "OperaIQ";
  process.env.SENTINEL_LOCAL_VERIFY = process.env.SENTINEL_LOCAL_VERIFY || "true";
  process.env.SENTINEL_REMEDIATION_WAIT_MS = process.env.SENTINEL_REMEDIATION_WAIT_MS || "0";
  process.env.SENTINEL_VERIFY_WAIT_MS = process.env.SENTINEL_VERIFY_WAIT_MS || "0";

  const org = await ensureSeedOrg();
  const runbooks = await queryDocuments<Record<string, unknown>>("runbooks", {}, 1, { orgId: org.orgId });
  if (runbooks.length === 0) {
    throw new Error("Qdrant seed data is missing. Run pnpm qdrant:seed before pnpm operaiq:quick-test.");
  }

  const id = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const proofPath = `${ARTIFACT_DIR}/operaiq-human-flow-${id}.json`;
  const incidentId = await insertSentinelIncident({
    orgId: org.orgId,
    title: `OperaIQ payment incident ${id}`,
    severity: "P3",
    status: "open",
    symptoms: ["Redis ECONNRESET", "connection pool exhausted", "p99 latency elevated", "payment-service checkout failures", "error_count=36"],
    affectedServices: ["payment-service"],
    rootCause: null,
    resolution: null,
    remediationSteps: [],
    detectedAt: new Date().toISOString(),
    resolvedAt: null,
    durationMinutes: null,
    postMortemId: null,
    agentEvents: [],
    rawPayload: {
      source: "operaiq-quick-test",
      service: "payment-service",
      symptoms: ["Redis ECONNRESET", "connection pool exhausted"]
    }
  });

  const events: unknown[] = [];
  const result = await runSentinelAgent(
    {
      incidentId,
      orgId: org.orgId,
      alert: {
        source: "operaiq",
        title: `OperaIQ payment incident ${id}`,
        severity: "P3",
        affectedServices: ["payment-service"],
        symptoms: ["Redis ECONNRESET", "connection pool exhausted", "payment-service checkout failures"],
        incidentType: "operaiq_test_payment_redis_spike",
        detectedAt: new Date().toISOString(),
        rawPayload: { source: "operaiq-quick-test" }
      }
    },
    async (event) => {
      events.push(event);
    }
  );

  const [incident] = await queryDocuments<Record<string, unknown>>("incidents", { _key: incidentId }, 1, { orgId: org.orgId });
  const postmortems = await queryDocuments<Record<string, unknown>>("postmortems", { incidentId }, 5, { orgId: org.orgId });
  const acceptance = {
    incidentStoredInQdrant: Boolean(incident),
    qdrantMemoryRetrieved: events.some((event) => JSON.stringify(event).includes("Qdrant")),
    agentActed: events.some((event) => JSON.stringify(event).includes('"stepType":"ACT"')),
    agentVerified: events.some((event) => JSON.stringify(event).includes('"stepType":"VERIFY"')),
    agentClosed: result.status === "resolved",
    postmortemStoredInQdrant: postmortems.length > 0
  };
  const passed = Object.values(acceptance).every(Boolean);
  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(proofPath, JSON.stringify({ incidentId, result, acceptance, events, incident, postmortems }, null, 2));

  for (const [name, ok] of Object.entries(acceptance)) {
    writeLine(`${ok ? "PASS" : "FAIL"} ${name}`);
  }
  if (!passed) {
    throw new Error(`OperaIQ quick-test acceptance failed; proof=${proofPath}`);
  }
  writeLine(`PASSED operaiq:quick-test - incident=${incidentId} postmortem=${String(postmortems[0]?._key ?? "unknown")} proof=${proofPath}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  writeLine(`FAILED operaiq:quick-test - ${message}`);
  process.exitCode = 1;
});
