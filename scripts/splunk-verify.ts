import "dotenv/config";
import { countDocuments, runSearch } from "@operaiq/splunk-brain";
import { incidents, patterns, runbooks } from "./seed.js";
import { ensureDemoOrg } from "./demo/org.js";

function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

function scopedKey(orgId: string, key: string): string {
  return `${orgId}-${key}`;
}

async function main(): Promise<void> {
  const org = await ensureDemoOrg();
  const serviceNames = ["payment-service", "auth-service", "notification-service", "redis-cache", "postgres-main"];
  const expected = [
    {
      collection: "incidents",
      label: "incidents",
      count: 20,
      filter: { _key: { $in: incidents.map((_, index) => scopedKey(org.orgId, `seed-incident-${String(index + 1).padStart(2, "0")}`)) } }
    },
    { collection: "services", label: "services", count: 5, filter: { _key: { $in: serviceNames.map((name) => scopedKey(org.orgId, name)) } } },
    { collection: "service_runtime_configs", label: "service_runtime_configs", count: 5, filter: { _key: { $in: serviceNames.map((name) => scopedKey(org.orgId, name)) } } },
    { collection: "runbooks", label: "runbooks", count: 8, filter: { _key: { $in: runbooks.map((runbook) => scopedKey(org.orgId, runbook.incidentType)) } } },
    { collection: "patterns", label: "patterns", count: 5, filter: { _key: { $in: patterns.map((pattern) => scopedKey(org.orgId, pattern.name)) } } }
  ];
  const failures: string[] = [];
  for (const { collection, label, count, filter } of expected) {
    const seeded = await countDocuments(collection, filter, { orgId: org.orgId });
    const total = await countDocuments(collection, {}, { orgId: org.orgId });
    if (seeded !== count) failures.push(`${collection}: expected ${count} seeded documents, found ${seeded}`);
    writeLine(`${seeded === count ? "PASSED" : "FAILED"} splunk-kv-${label} - seeded=${seeded}/${count} total=${total}`);
  }

  const results = await runSearch(`search index=sentinel sourcetype=sentinel:postmortem orgId=${org.orgId} | head 5`, { maxResults: 5 });
  writeLine(`CHECK splunk-postmortem-search - resultCount=${results.length}`);
  if (results.length === 0) failures.push("expected at least one sentinel:postmortem event in the sentinel index");

  if (failures.length > 0) {
    throw new Error(failures.join("; "));
  }
  writeLine("PASSED splunk:verify - seeded KV Store documents and SPL post-mortem search passed");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  writeLine(`FAILED splunk:verify - ${message}`);
  process.exitCode = 1;
});
