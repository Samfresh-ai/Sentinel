import "dotenv/config";
import {
  createCollection,
  deleteDocument,
  describeQdrantEndpoints,
  insertDocument,
  waitForQdrantReady
} from "@sentinel/splunk-brain";

function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
  const endpoints = describeQdrantEndpoints();
  writeLine(`CHECK qdrant-config - url=${endpoints.url}, collection=${endpoints.collection}`);
  await waitForQdrantReady({
    onRetry: (attempt, message) => {
      if (attempt % 6 === 0) writeLine(`WAIT qdrant-ready attempt=${attempt} last=${message}`);
    }
  });
  writeLine("PASSED qdrant-ready - REST API is reachable");
  await createCollection("_operaiq_setup_check", {});
  const inserted = await insertDocument("_operaiq_setup_check", { checkedAt: new Date().toISOString() });
  await deleteDocument("_operaiq_setup_check", inserted._key);
  writeLine(`PASSED qdrant-memory - upsert/search/delete works collection=${endpoints.collection}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  writeLine(`FAILED qdrant:setup-check - ${message}`);
  process.exitCode = 1;
});
