import "dotenv/config";
import { closeMongoClient, createCollectionsAndIndexes, insertIncidentWithEmbedding } from "@operaiq/brain";
import {
  executeRemediation,
  getRunbook,
  getServiceDependencyGraph,
  searchSimilarIncidents,
  writePostmortem
} from "./tools/index.js";
import { closeMcpClient } from "./mcp.js";

function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
  await createCollectionsAndIndexes();
  const detectedAt = new Date(Date.now() - 5 * 60_000);
  const incidentId = await insertIncidentWithEmbedding({
    title: `Agent tool test incident ${detectedAt.toISOString()}`,
    severity: "P3",
    status: "open",
    symptoms: ["S3 AccessDenied", "notification template read failure"],
    affectedServices: ["notification-service"],
    rootCause: null,
    resolution: null,
    remediationSteps: [],
    detectedAt,
    resolvedAt: null,
    durationMinutes: null,
    postMortemId: null
  });

  const similar = await searchSimilarIncidents({
    symptoms: ["database connection timeout", "postgres pool exhausted"],
    limit: 5
  });
  if (similar.length === 0) throw new Error("search_similar_incidents returned no results");

  const graph = await getServiceDependencyGraph({ serviceName: "payment-service" });
  if (!graph || graph.service.name !== "payment-service") throw new Error("get_service_dependency_graph returned invalid graph");

  const runbook = await getRunbook({
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
      reasoning: "Tool isolation test for low-risk Slack notification.",
      incidentId: incidentId.toHexString()
    }
  });
  if (!remediation.output) throw new Error("execute_remediation returned empty output");

  const postmortem = await writePostmortem({
    incidentId: incidentId.toHexString(),
    timeline: [
      {
        timestamp: detectedAt.toISOString(),
        event: "Test incident opened for agent tool verification",
        actor: "operaiq"
      },
      {
        timestamp: new Date().toISOString(),
        event: "Slack notification remediation executed",
        actor: "operaiq"
      }
    ],
    rootCause: "Notification service could not read S3 templates because bucket access was denied.",
    remediationTaken: ["notify_team notification-service"],
    lessonLearned: "Permission regressions should include bucket and service-account context in the first notification."
  });
  if (!postmortem.postmortemId) throw new Error("write_postmortem returned no postmortem ID");

  writeLine("PASSED agent:test-tools - all 5 tools returned valid non-empty results");
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    writeLine(`FAILED agent:test-tools - ${message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeMcpClient();
    await closeMongoClient();
  });
