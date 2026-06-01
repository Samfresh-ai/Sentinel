import "dotenv/config";
import { insertSentinelIncident } from "@sentinel/splunk-brain";
import {
  queryQdrantMemory,
  sentinelGetRunbook,
  sentinelGetServiceDependencyGraph,
  sentinelSearchSimilarIncidents,
  sentinelWritePostmortem
} from "@sentinel/agent";
import { ensureSeedOrg } from "./test-org.js";

function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
  process.env.SENTINEL_MODE = "true";
  process.env.AGENT_NAME = "OperaIQ";
  process.env.SENTINEL_LOCAL_VERIFY = process.env.SENTINEL_LOCAL_VERIFY || "true";
  process.env.SENTINEL_GENERATION_PROVIDER = process.env.SENTINEL_GENERATION_PROVIDER || "offline";
  const org = await ensureSeedOrg();
  const detectedAt = new Date();
  const incidentId = await insertSentinelIncident({
    orgId: org.orgId,
    title: `OperaIQ tool test incident ${detectedAt.toISOString()}`,
    severity: "P3",
    status: "open",
    symptoms: ["Redis ECONNRESET", "connection pool exhausted", "payment checkout failures"],
    affectedServices: ["payment-service"],
    rootCause: null,
    resolution: null,
    remediationSteps: [],
    detectedAt: detectedAt.toISOString(),
    resolvedAt: null,
    durationMinutes: null,
    postMortemId: null
  });

  const similar = await sentinelSearchSimilarIncidents({ symptoms: ["Redis ECONNRESET", "payment checkout failures"], limit: 3, orgId: org.orgId, currentIncidentId: incidentId });
  if (similar.length === 0) throw new Error("search_similar_incidents returned no Qdrant matches");

  const memory = await queryQdrantMemory({ services: ["payment-service", "redis-cache"], symptoms: ["Redis ECONNRESET"], orgId: org.orgId, description: "Tool test Qdrant retrieval" });
  if (memory.eventCount <= 0) throw new Error("query_qdrant_memory returned no service signals");

  const graph = await sentinelGetServiceDependencyGraph({ serviceName: "payment-service", orgId: org.orgId });
  if (!graph) throw new Error("get_service_dependency_graph returned no service graph");

  const runbook = await sentinelGetRunbook({ incidentDescription: "Redis ECONNRESET payment checkout failures", affectedServices: ["payment-service", "redis-cache"], rootCauseCandidate: "redis-cache", orgId: org.orgId });
  if (!runbook || runbook.steps.length === 0) throw new Error("get_runbook returned no runbook");

  const now = new Date().toISOString();
  const postmortem = await sentinelWritePostmortem({
    incidentId,
    orgId: org.orgId,
    timeline: [{ timestamp: now, event: "OperaIQ tool test opened", actor: "operaiq" }],
    rootCause: "redis-cache connection pool exhaustion",
    remediationTaken: ["rotate_connection_pool on redis-cache"],
    lessonLearned: "Qdrant memory should retain the resolved incident for future retrieval."
  });
  if (!postmortem.postmortemId) throw new Error("write_postmortem returned no postmortem ID");

  writeLine(`PASSED operaiq:test-tools - Qdrant tools returned valid results incident=${incidentId} postmortem=${postmortem.postmortemId}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  writeLine(`FAILED operaiq:test-tools - ${message}`);
  process.exitCode = 1;
});
