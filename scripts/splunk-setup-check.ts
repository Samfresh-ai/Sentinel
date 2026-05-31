import "dotenv/config";
import { createCollection, deleteDocument, describeSplunkEndpoints, getSplunkConfig, insertDocument, sendEvent, splunkRestRequest, waitForSplunkReady } from "@sentinel/splunk-brain";
import { z } from "zod";

function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
  const config = getSplunkConfig();
  const endpoints = describeSplunkEndpoints();
  writeLine(
    `CHECK splunk-config - host=${config.SPLUNK_HOST}, cloudStack=${config.SPLUNK_CLOUD_STACK_HOST ?? "unset"}, mgmt=${endpoints.managementUrl}, hec=${endpoints.hecUrl}, app=${config.SPLUNK_APP}, index=${config.SPLUNK_INDEX}`
  );

  await waitForSplunkReady({
    onRetry: (attempt, message) => {
      if (attempt % 6 === 0) writeLine(`WAIT splunk-ready attempt=${attempt} last=${message}`);
    }
  });
  writeLine("PASSED splunk-rest - management API is reachable");

  await splunkRestRequest(z.record(z.unknown()).default({}), {
    method: "POST",
    path: "/services/apps/local",
    form: {
      name: config.SPLUNK_APP,
      label: "Sentinel",
      visible: "1",
      output_mode: "json"
    }
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("409") || message.includes("already exists")) return {};
    throw error;
  });
  writeLine(`PASSED splunk-app - ${config.SPLUNK_APP} exists`);

  for (const indexName of [config.SPLUNK_INDEX, "prod"]) {
    await splunkRestRequest(z.record(z.unknown()).default({}), {
      method: "POST",
      path: "/services/data/indexes",
      form: {
        name: indexName,
        datatype: "event",
        output_mode: "json"
      }
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("409") || message.includes("already exists")) return {};
      throw error;
    });
    writeLine(`PASSED splunk-index - ${indexName} exists`);
  }

  await splunkRestRequest(z.record(z.unknown()).default({}), {
    method: "POST",
    path: "/services/data/inputs/http/http",
    form: {
      disabled: "0",
      output_mode: "json"
    }
  });
  writeLine("PASSED splunk-hec-global - HEC is enabled");

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
