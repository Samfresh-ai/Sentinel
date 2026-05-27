import "dotenv/config";
import { createCollection, deleteDocument, getSplunkConfig, insertDocument, sendEvent, splunkRestRequest } from "@operaiq/splunk-brain";
import { z } from "zod";

function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
  const config = getSplunkConfig();
  writeLine(`CHECK splunk-config - host=${config.SPLUNK_HOST}, mgmtPort=${config.SPLUNK_MGMT_PORT}, hecPort=${config.SPLUNK_HEC_PORT}, app=${config.SPLUNK_APP}, index=${config.SPLUNK_INDEX}`);

  await splunkRestRequest(z.record(z.unknown()), {
    path: "/services/server/info",
    query: { output_mode: "json" }
  });
  writeLine("PASSED splunk-rest - management API is reachable");

  await createCollection("_sentinel_setup_check", { checkedAt: "string" });
  await createCollection("audit_log", {});
  await createCollection("rate_limit_windows", {});
  await createCollection("dead_letter", {});
  const inserted = await insertDocument("_sentinel_setup_check", { checkedAt: new Date().toISOString() });
  await deleteDocument("_sentinel_setup_check", inserted._key);
  writeLine("PASSED splunk-kvstore - collection create/insert/delete succeeded");

  await sendEvent({
    sourcetype: "sentinel:setup-check",
    event: {
      type: "setup_check",
      checkedAt: new Date().toISOString()
    }
  });
  writeLine("PASSED splunk-hec - HEC token accepted a setup-check event");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  writeLine(`FAILED splunk:setup-check - ${message}`);
  process.exitCode = 1;
});
