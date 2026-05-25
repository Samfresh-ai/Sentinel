import { ObjectId } from "mongodb";
import { closeMongoClient } from "./client.js";
import { incidentsCollection } from "./collections.js";
import { createCollectionsAndIndexes } from "./indexes.js";
import { insertIncidentWithEmbedding, searchIncidentVectors } from "./operations.js";

function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
  const marker = `brain-test-${new ObjectId().toHexString()}`;
  const detectedAt = new Date(Date.now() - 60_000);
  const resolvedAt = new Date();
  let matchScore = 0;
  try {
    await createCollectionsAndIndexes();
    await insertIncidentWithEmbedding({
      title: marker,
      severity: "P3",
      status: "resolved",
      symptoms: ["database connection timeout", "postgres pool exhausted", "checkout latency", marker],
      affectedServices: ["payment-service", "postgres-main"],
      rootCause: "PostgreSQL connection pool reached max clients during checkout traffic spike.",
      resolution: "Rotated stale connections and scaled the connection pool from 20 to 40.",
      remediationSteps: ["rotate_connection_pool postgres-main", "scale_service payment-service"],
      detectedAt,
      resolvedAt,
      durationMinutes: Math.round((resolvedAt.getTime() - detectedAt.getTime()) / 60_000),
      postMortemId: null
    });

    let match: { score: number } | undefined;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const results = await searchIncidentVectors(`${marker} database connection timeout postgres pool exhausted checkout latency`, 5);
      match = results.find((result) => result.title === marker);
      if (match) {
        break;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 2000);
      });
    }
    if (!match) {
      throw new Error("Vector search did not return the inserted incident");
    }
    const minimumScore = process.env.OPERAIQ_AI_PROVIDER === "offline" ? 0.75 : 0.9;
    if (match.score <= minimumScore) {
      throw new Error(`Expected cosine similarity above ${minimumScore}, received ${match.score}`);
    }
    matchScore = match.score;
  } finally {
    await (await incidentsCollection()).deleteMany({ title: /^brain-test-/ });
  }
  writeLine(`PASSED brain:test - MongoDB connection and Atlas Vector Search round-trip succeeded with score=${matchScore.toFixed(3)}`);
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    writeLine(`FAILED brain:test - ${message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeMongoClient();
  });
