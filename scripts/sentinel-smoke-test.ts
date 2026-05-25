import "dotenv/config";
import { insertSentinelIncident } from "@operaiq/splunk-brain";
import { runSentinelAgent } from "@operaiq/agent";

function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
  process.env.SENTINEL_MODE = "true";
  process.env.AGENT_NAME = "Sentinel";
  process.env.OPERAIQ_LOCAL_VERIFY = process.env.OPERAIQ_LOCAL_VERIFY ?? "true";
  process.env.OPERAIQ_REMEDIATION_WAIT_MS = process.env.OPERAIQ_REMEDIATION_WAIT_MS ?? "0";
  process.env.OPERAIQ_AI_PROVIDER = process.env.OPERAIQ_AI_PROVIDER ?? "offline";

  const detectedAt = new Date();
  const incidentId = await insertSentinelIncident({
    title: `Sentinel smoke test S3 notification incident ${detectedAt.toISOString()}`,
    severity: "P3",
    status: "open",
    symptoms: ["S3 AccessDenied", "template asset reads failing", "notification send errors"],
    affectedServices: ["notification-service"],
    rootCause: null,
    resolution: null,
    remediationSteps: [],
    detectedAt: detectedAt.toISOString(),
    resolvedAt: null,
    durationMinutes: null,
    postMortemId: null
  });

  const result = await runSentinelAgent(
    {
      incidentId,
      alert: {
        source: "operaiq",
        title: "S3 bucket permission regression blocked notifications",
        severity: "P3",
        affectedServices: ["notification-service"],
        symptoms: ["S3 AccessDenied", "template asset reads failing", "notification send errors"],
        incidentType: "s3-bucket-permission-error",
        detectedAt: detectedAt.toISOString(),
        rawPayload: {}
      }
    },
    async (event) => {
      writeLine(`[${event.stepType}] ${event.message}`);
    }
  );

  const distinctTools = new Set(result.toolsCalled);
  if (!distinctTools.has("query_splunk_logs")) {
    throw new Error(`Expected query_splunk_logs, called ${[...distinctTools].join(", ")}`);
  }
  if (distinctTools.size < 4) {
    throw new Error(`Expected at least 4 tools, called ${[...distinctTools].join(", ")}`);
  }
  if (result.status !== "resolved" && result.status !== "requires_human_approval") {
    throw new Error(`Sentinel returned status ${result.status}`);
  }
  writeLine(`PASSED sentinel:smoke-test - status=${result.status}, tools=${[...distinctTools].join(", ")}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  writeLine(`FAILED sentinel:smoke-test - ${message}`);
  process.exitCode = 1;
});
