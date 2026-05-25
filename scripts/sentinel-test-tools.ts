import "dotenv/config";
import { insertSentinelIncident } from "@operaiq/splunk-brain";
import {
  executeRemediation,
  querySplunkLogs,
  sentinelGetRunbook,
  sentinelGetServiceDependencyGraph,
  sentinelSearchSimilarIncidents,
  sentinelWritePostmortem
} from "@operaiq/agent";

function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
  process.env.SENTINEL_MODE = "true";
  process.env.AGENT_NAME = "Sentinel";
  process.env.OPERAIQ_LOCAL_VERIFY = process.env.OPERAIQ_LOCAL_VERIFY ?? "true";
  process.env.OPERAIQ_REMEDIATION_WAIT_MS = process.env.OPERAIQ_REMEDIATION_WAIT_MS ?? "0";
  process.env.OPERAIQ_AI_PROVIDER = process.env.OPERAIQ_AI_PROVIDER ?? "offline";

  const detectedAt = new Date(Date.now() - 5 * 60_000);
  const incidentId = await insertSentinelIncident({
    title: `Sentinel tool test incident ${detectedAt.toISOString()}`,
    severity: "P3",
    status: "open",
    symptoms: ["S3 AccessDenied", "notification template read failure"],
    affectedServices: ["notification-service"],
    rootCause: null,
    resolution: null,
    remediationSteps: [],
    detectedAt: detectedAt.toISOString(),
    resolvedAt: null,
    durationMinutes: null,
    postMortemId: null
  });

  const similar = await sentinelSearchSimilarIncidents({
    symptoms: ["database connection timeout", "postgres pool exhausted"],
    limit: 5
  });
  if (similar.length === 0) throw new Error("search_similar_incidents returned no results");

  const logs = await querySplunkLogs({
    spl: "search index=sentinel sourcetype=sentinel:postmortem | head 5",
    timeRange: { earliest: "-7d", latest: "now" },
    description: "Verify Sentinel can inspect indexed post-mortem events."
  });
  if (logs.eventCount === 0) throw new Error("query_splunk_logs returned no events");

  const graph = await sentinelGetServiceDependencyGraph({ serviceName: "payment-service" });
  if (!graph || graph.service.name !== "payment-service") throw new Error("get_service_dependency_graph returned invalid graph");

  const runbook = await sentinelGetRunbook({
    incidentDescription: "S3 AccessDenied template asset reads failing notification send errors",
    affectedServices: ["notification-service"]
  });
  if (!runbook || runbook.steps.length === 0) throw new Error("get_runbook returned no runbook");

  const remediation = await executeRemediation({
    action: "notify_team",
    targetService: "notification-service",
    parameters: {
      riskLevel: "low",
      severity: "P3",
      symptoms: "S3 AccessDenied, notification send errors",
      reasoning: "Sentinel tool isolation test for low-risk notification.",
      incidentId
    }
  });
  if (!remediation.output) throw new Error("execute_remediation returned empty output");

  const postmortem = await sentinelWritePostmortem({
    incidentId,
    timeline: [
      {
        timestamp: detectedAt.toISOString(),
        event: "Test incident opened for Sentinel tool verification",
        actor: "operaiq"
      },
      {
        timestamp: new Date().toISOString(),
        event: "Sentinel notification remediation executed",
        actor: "operaiq"
      }
    ],
    rootCause: "Notification service could not read S3 templates because bucket access was denied.",
    remediationTaken: ["notify_team notification-service"],
    lessonLearned: "Permission regressions should include bucket and service-account context in the first notification."
  });
  if (!postmortem.postmortemId) throw new Error("write_postmortem returned no postmortem ID");

  writeLine("PASSED sentinel:test-tools - all 6 Sentinel tools returned valid non-empty results");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  writeLine(`FAILED sentinel:test-tools - ${message}`);
  process.exitCode = 1;
});
