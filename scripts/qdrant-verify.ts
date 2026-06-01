import "dotenv/config";
import { countDocuments, findSimilarIncidents, queryDocuments, waitForQdrantReady } from "@sentinel/splunk-brain";
import { runbooks } from "./seed-data.js";
import { ensureSeedOrg } from "./test-org.js";

function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
  await waitForQdrantReady();
  const org = await ensureSeedOrg();
  const checks = [
    { collection: "incidents", expected: 20 },
    { collection: "services", expected: 3 },
    { collection: "runbooks", expected: runbooks.length },
    { collection: "patterns", expected: 5 }
  ];

  const failures: string[] = [];
  for (const check of checks) {
    const count = await countDocuments(check.collection, {}, { orgId: org.orgId });
    writeLine(`CHECK qdrant-${check.collection} - count=${count}`);
    if (count < check.expected) failures.push(`${check.collection} expected >=${check.expected}, got ${count}`);
  }

  const matches = await findSimilarIncidents(["Redis ECONNRESET", "payment checkout failures", "connection pool exhausted"], 3, { orgId: org.orgId });
  writeLine(`CHECK qdrant-similar-memory - matches=${matches.length}, best=${matches[0] ? `${matches[0].title} ${Math.round(matches[0].similarity * 100)}%` : "none"}`);
  if (matches.length === 0) failures.push("expected at least one Qdrant similar incident match");

  const runbook = (await queryDocuments<Record<string, unknown>>("runbooks", { incidentType: "redis-connection-exhaustion" }, 1, { orgId: org.orgId }))[0];
  writeLine(`CHECK qdrant-runbook-search - found=${typeof runbook?.title === "string" ? runbook.title : "none"}`);
  if (!runbook) failures.push("expected Redis connection exhaustion runbook in Qdrant");

  if (failures.length > 0) {
    throw new Error(failures.join("; "));
  }
  writeLine("PASSED qdrant:verify - Qdrant memory, similar search, and runbook retrieval are usable");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  writeLine(`FAILED qdrant:verify - ${message}`);
  process.exitCode = 1;
});
