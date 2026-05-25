import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { closeMongoClient, createCollectionsAndIndexes, insertIncidentWithEmbedding } from "@operaiq/brain";
import { buildAgentBuilderConfig } from "./agent-config.js";
import { closeMcpClient } from "./mcp.js";
import { runIncidentAgent } from "./runner.js";

function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

function configPathArg(): string | undefined {
  const arg = process.argv.find((item) => item.startsWith("--write-config="));
  return arg?.replace("--write-config=", "");
}

async function main(): Promise<void> {
  const configPath = configPathArg();
  if (configPath) {
    const apiBaseUrl = process.env.AGENT_TOOL_EXECUTION_BASE_URL ?? process.env.PUBLIC_APP_URL ?? "http://localhost:3001";
    await writeFile(configPath, JSON.stringify(buildAgentBuilderConfig(apiBaseUrl), null, 2));
  }

  process.env.OPERAIQ_REMEDIATION_WAIT_MS = process.env.OPERAIQ_REMEDIATION_WAIT_MS ?? "0";
  await createCollectionsAndIndexes();
  const detectedAt = new Date();
  const incidentId = await insertIncidentWithEmbedding({
    title: `Agent smoke test S3 notification incident ${detectedAt.toISOString()}`,
    severity: "P3",
    status: "open",
    symptoms: ["S3 AccessDenied", "template asset reads failing", "notification send errors"],
    affectedServices: ["notification-service"],
    rootCause: null,
    resolution: null,
    remediationSteps: [],
    detectedAt,
    resolvedAt: null,
    durationMinutes: null,
    postMortemId: null
  });

  const result = await runIncidentAgent(
    {
      incidentId: incidentId.toHexString(),
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
  if (distinctTools.size < 3) {
    throw new Error(`Expected at least 3 tools, called ${[...distinctTools].join(", ")}`);
  }
  if (result.status !== "resolved" && result.status !== "requires_human_approval") {
    throw new Error(`Agent returned status ${result.status}`);
  }
  writeLine(`PASSED agent:smoke-test - status=${result.status}, tools=${[...distinctTools].join(", ")}`);
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    writeLine(`FAILED agent:smoke-test - ${message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeMcpClient();
    await closeMongoClient();
  });
