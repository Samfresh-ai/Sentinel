import "dotenv/config";
import { countDocuments, runSearch } from "@operaiq/splunk-brain";

function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
  const expected = new Map([
    ["incidents", 20],
    ["services", 5],
    ["service_runtime_configs", 5],
    ["runbooks", 8],
    ["patterns", 5]
  ]);
  const failures: string[] = [];
  for (const [collection, count] of expected) {
    const actual = await countDocuments(collection);
    if (actual !== count) failures.push(`${collection}: expected ${count}, found ${actual}`);
    writeLine(`${actual === count ? "PASSED" : "FAILED"} splunk-kv-${collection} - count=${actual}`);
  }

  const results = await runSearch("search index=sentinel sourcetype=sentinel:postmortem | head 5", { maxResults: 5 });
  writeLine(`CHECK splunk-postmortem-search - resultCount=${results.length}`);
  if (results.length === 0) failures.push("expected at least one sentinel:postmortem event in the sentinel index");

  if (failures.length > 0) {
    throw new Error(failures.join("; "));
  }
  writeLine("PASSED splunk:verify - KV Store counts and SPL post-mortem search passed");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  writeLine(`FAILED splunk:verify - ${message}`);
  process.exitCode = 1;
});
