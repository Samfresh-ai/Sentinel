import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { z } from "zod";
import { productionReadinessViolations } from "@sentinel/shared";
import { splunkHecRequest, splunkRestRequest } from "@sentinel/splunk-brain";
import { querySplunkLogsInputSchema } from "../packages/agent/src/tools/query-splunk-logs.js";
import { querySplunkLogsSchema } from "../packages/agent/src/tool-json-schemas.js";

function file(path: string): string {
  return readFileSync(path, "utf8");
}

function secureProductionEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    SENTINEL_RUNTIME_ENV: "production",
    SENTINEL_GENERATION_PROVIDER: "nvidia",
    NVIDIA_API_KEY: "test-key",
    SENTINEL_REMEDIATION_BACKEND: "admin-endpoint",
    SENTINEL_ADMIN_REMEDIATION_SECRET: "admin-remediation-secret",
    PUBLIC_APP_URL: "https://sentinel.example.com",
    API_PUBLIC_URL: "https://sentinel-api.example.com",
    NEXT_PUBLIC_API_URL: "https://sentinel-api.example.com",
    SPLUNK_HOST: "splunk.example.com",
    SPLUNK_MGMT_URL: "https://splunk.example.com",
    SPLUNK_HEC_URL: "https://splunk.example.com",
    SPLUNK_USERNAME: "admin",
    SPLUNK_PASSWORD: "password",
    SPLUNK_HEC_TOKEN: "hec-token",
    SPLUNK_TLS_REJECT_UNAUTHORIZED: "true",
    ...overrides
  };
}

function assertIncludes(value: string, needle: string): void {
  assert.ok(value.includes(needle), `Expected source to include: ${needle}`);
}

function assertNotIncludes(value: string, needle: string): void {
  assert.ok(!value.includes(needle), `Forbidden source pattern remains: ${needle}`);
}

const secureViolations = productionReadinessViolations(secureProductionEnv());
assert.deepEqual(secureViolations, [], `Secure production env should be ready: ${secureViolations.join("; ")}`);

const httpViolations = productionReadinessViolations(secureProductionEnv({
  SPLUNK_MGMT_URL: "http://splunk.example.com",
  SPLUNK_HEC_URL: "http://splunk.example.com"
}));
assert.ok(httpViolations.some((item) => item.includes("SPLUNK_MGMT_URL must use HTTPS")));
assert.ok(httpViolations.some((item) => item.includes("SPLUNK_HEC_URL must use HTTPS")));

const tlsDisabledViolations = productionReadinessViolations(secureProductionEnv({
  SPLUNK_TLS_REJECT_UNAUTHORIZED: "false"
}));
assert.ok(tlsDisabledViolations.some((item) => item.includes("SPLUNK_TLS_REJECT_UNAUTHORIZED=false is not allowed")));

Object.assign(process.env, secureProductionEnv({ SPLUNK_HEC_URL: "http://splunk.example.com" }));
await assert.rejects(
  () => splunkHecRequest(z.record(z.unknown()).default({}), { event: {} }),
  /Splunk HEC endpoint must use HTTPS/
);

Object.assign(process.env, secureProductionEnv({ SPLUNK_TLS_REJECT_UNAUTHORIZED: "false" }));
await assert.rejects(
  () => splunkRestRequest(z.record(z.unknown()).default({}), { path: "/services/server/info" }),
  /cannot disable TLS certificate validation/
);

assert.throws(() => querySplunkLogsInputSchema.parse({
  spl: "search index=* | head 5",
  description: "raw SPL must not be accepted"
}));
querySplunkLogsInputSchema.parse({
  services: ["payment-service"],
  symptoms: ["ECONNRESET"],
  timeRange: { earliest: "-15m", latest: "now" },
  description: "bounded service signal"
});
assert.equal(querySplunkLogsSchema.properties?.spl, undefined);
assert.equal(querySplunkLogsSchema.additionalProperties, false);

const splunkClient = file("packages/splunk-brain/src/client.ts");
assertNotIncludes(splunkClient, "allowCertificateHostnameMismatch");
assertNotIncludes(splunkClient, "checkServerIdentity");
assertIncludes(splunkClient, "assertSecureEndpoint(config, endpoint, \"Splunk management endpoint\")");
assertIncludes(splunkClient, "assertSecureEndpoint(config, endpoint, \"Splunk HEC endpoint\")");

const api = file("apps/api/src/app.ts");
assertIncludes(api, "PROJECT_LOG_SOURCETYPE = \"sentinel:project-app-log\"");
assertIncludes(api, "orgId: input.orgId");
assertIncludes(api, "verifyAdminRemediationSecret(req)");
assertIncludes(api, "flushDeadLetterQueue({ force: true, orgId: auth.orgId })");

const remediation = file("packages/agent/src/tools/execute-remediation.ts");
assertIncludes(remediation, "SENTINEL_ADMIN_REMEDIATION_SECRET");
assertIncludes(remediation, "\"x-sentinel-remediation-secret\": secret");
assertNotIncludes(remediation, "x-operaiq-tool-secret");
assertNotIncludes(remediation, "AGENT_TOOL_SECRET ?? env.WEBHOOK_SECRET");

const gateway = file("scripts/splunk-tunnel-gateway.ts");
assertIncludes(gateway, "if (!gatewayToken) return false");
assertIncludes(gateway, "crypto.timingSafeEqual");
assertIncludes(gateway, "PayloadTooLarge");

console.log("security-fix-checks passed");
