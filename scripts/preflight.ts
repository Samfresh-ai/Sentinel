import "dotenv/config";
import { spawnSync } from "node:child_process";
import { MongoClient } from "mongodb";
import { PubSub } from "@google-cloud/pubsub";
import { isProductionRuntime, productionReadinessViolations } from "@operaiq/shared";

function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

function hasEnv(name: string): boolean {
  return typeof process.env[name] === "string" && process.env[name]!.trim().length > 0;
}

function booleanEnv(name: string): boolean {
  return process.env[name]?.toLowerCase() === "true";
}

function envValue(name: string): string {
  return (process.env[name] ?? "").trim();
}

function generationProvider(): string {
  return envValue("OPERAIQ_GENERATION_PROVIDER").toLowerCase() || envValue("OPERAIQ_AI_PROVIDER").toLowerCase() || "vertex";
}

function remediationBackend(): string {
  return envValue("OPERAIQ_REMEDIATION_BACKEND").toLowerCase() || "cloud-run";
}

function checkCommand(command: string, args: string[]): { ok: boolean; detail: string } {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) {
    return { ok: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    return { ok: false, detail: (result.stderr || result.stdout || `exit ${result.status}`).trim() };
  }
  return { ok: true, detail: (result.stdout || "ok").trim().split("\n")[0] ?? "ok" };
}

async function checkMongo(): Promise<{ ok: boolean; detail: string }> {
  if (!hasEnv("MONGODB_ATLAS_URI")) {
    return { ok: false, detail: "MONGODB_ATLAS_URI is missing" };
  }
  const client = new MongoClient(process.env.MONGODB_ATLAS_URI!, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.db(process.env.MONGODB_DATABASE_NAME ?? "operaiq").command({ ping: 1 });
    return { ok: true, detail: "Atlas ping succeeded" };
  } catch (error: unknown) {
    return { ok: false, detail: error instanceof Error ? error.message : "MongoDB ping failed" };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function checkPubSubTopic(name: string): Promise<{ ok: boolean; detail: string }> {
  if (!hasEnv("GOOGLE_CLOUD_PROJECT_ID")) {
    return { ok: false, detail: "GOOGLE_CLOUD_PROJECT_ID is missing" };
  }
  const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
  if (!projectId) {
    return { ok: false, detail: "GOOGLE_CLOUD_PROJECT_ID is missing" };
  }
  const pubsub = new PubSub({ projectId });
  try {
    const [exists] = await pubsub.topic(name).exists();
    return exists ? { ok: true, detail: `${name} exists` } : { ok: false, detail: `${name} does not exist` };
  } catch (error: unknown) {
    return { ok: false, detail: error instanceof Error ? error.message : "Pub/Sub check failed" };
  }
}

async function callSlackApi<T extends { ok: boolean; error?: string }>(
  method: string,
  token: string,
  body: Record<string, string> = {}
): Promise<T> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(body)
  });
  const parsed = (await response.json()) as T;
  if (!response.ok || !parsed.ok) {
    throw new Error(parsed.error ?? `${method} returned HTTP ${response.status}`);
  }
  return parsed;
}

async function checkSlack(): Promise<{ ok: boolean; detail: string }> {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_DEFAULT_INCIDENT_CHANNEL;
  if (!token || !channel) {
    return { ok: false, detail: "SLACK_BOT_TOKEN and SLACK_DEFAULT_INCIDENT_CHANNEL are required" };
  }
  try {
    const auth = await callSlackApi<{ ok: boolean; error?: string; team?: string; user?: string; bot_id?: string }>("auth.test", token);
    const channelInfo = await callSlackApi<{
      ok: boolean;
      error?: string;
      channel?: { name?: string; is_channel?: boolean; is_private?: boolean };
    }>("conversations.info", token, { channel });
    const channelName = channelInfo.channel?.name ? `#${channelInfo.channel.name}` : channel;
    const workspace = auth.team ?? "workspace";
    const bot = auth.user ?? auth.bot_id ?? "bot";
    return { ok: true, detail: `${bot} authenticated in ${workspace}; ${channelName} is reachable` };
  } catch (error: unknown) {
    return { ok: false, detail: error instanceof Error ? error.message : "Slack API check failed" };
  }
}

async function main(): Promise<void> {
  const localVerifyMode = booleanEnv("OPERAIQ_LOCAL_VERIFY");
  const offlineAi = process.env.OPERAIQ_AI_PROVIDER === "offline";
  const sentinelMode = booleanEnv("SENTINEL_MODE");
  const provider = generationProvider();
  const backend = remediationBackend();
  const usesVertex = provider === "vertex";
  const usesCloudRun = backend === "cloud-run";
  const usesPubSub = !sentinelMode;
  const productionMode = isProductionRuntime();
  const requiredVariables = [
    "MONGODB_ATLAS_URI",
    "WEBHOOK_SECRET",
    "NEXT_PUBLIC_API_URL"
  ];
  if (usesVertex || usesCloudRun || usesPubSub) {
    requiredVariables.push("GOOGLE_CLOUD_PROJECT_ID");
  }
  if (provider === "nvidia") {
    requiredVariables.push("NVIDIA_API_KEY");
  }
  if (provider === "openai-compatible") {
    requiredVariables.push("OPENAI_COMPATIBLE_API_KEY", "OPENAI_COMPATIBLE_BASE_URL", "OPENAI_COMPATIBLE_MODEL");
  }
  if (usesVertex) {
    requiredVariables.push("VERTEX_AI_LOCATION");
  }
  if (!localVerifyMode) {
    requiredVariables.push("SLACK_BOT_TOKEN", "SLACK_DEFAULT_INCIDENT_CHANNEL", "SLACK_SIGNING_SECRET");
  }
  if (productionMode) {
    requiredVariables.push("PUBLIC_APP_URL", "AGENT_TOOL_EXECUTION_BASE_URL");
    if (usesCloudRun) {
      requiredVariables.push("CLOUD_RUN_REMEDIATION_JOB_PREFIX");
    }
  }
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  for (const variable of requiredVariables) {
    checks.push({
      name: `env:${variable}`,
      ok: hasEnv(variable),
      detail: hasEnv(variable) ? "present" : "missing"
    });
  }

  if (usesCloudRun || usesPubSub || usesVertex) {
    const gcloud = checkCommand("gcloud", ["--version"]);
    checks.push({ name: "gcloud", ...gcloud });
  } else {
    checks.push({ name: "gcloud", ok: true, detail: "skipped for Sentinel admin-endpoint deployment" });
  }
  if (!productionMode) {
    const docker = checkCommand("docker", ["info"]);
    checks.push({ name: "docker-daemon", ...docker });
  }
  checks.push({ name: "mongodb-atlas", ...(await checkMongo()) });
  if (usesPubSub) {
    checks.push({ name: "pubsub-alert-topic", ...(await checkPubSubTopic(process.env.PUBSUB_ALERT_TOPIC ?? "operaiq-alerts")) });
    checks.push({ name: "pubsub-events-topic", ...(await checkPubSubTopic(process.env.PUBSUB_EVENTS_TOPIC ?? "operaiq-agent-events")) });
  } else {
    checks.push({ name: "pubsub", ok: true, detail: "skipped because Sentinel uses Splunk Alert Action webhooks" });
  }
  if (offlineAi) {
    checks.push({ name: "vertex-ai", ok: true, detail: "skipped because OPERAIQ_AI_PROVIDER=offline" });
  }
  if (localVerifyMode) {
    checks.push({ name: "slack", ok: true, detail: "skipped because OPERAIQ_LOCAL_VERIFY=true" });
  } else if (hasEnv("SLACK_BOT_TOKEN") && hasEnv("SLACK_DEFAULT_INCIDENT_CHANNEL")) {
    checks.push({ name: "slack", ...(await checkSlack()) });
  }
  for (const violation of productionReadinessViolations()) {
    checks.push({ name: "production-readiness", ok: false, detail: violation });
  }

  let failed = 0;
  for (const check of checks) {
    const status = check.ok ? "PASS" : "FAIL";
    if (!check.ok) failed += 1;
    writeLine(`${status} ${check.name} - ${check.detail}`);
  }
  if (failed > 0) {
    throw new Error(`${failed} preflight checks failed`);
  }
  writeLine(
    localVerifyMode || offlineAi
      ? "PASSED preflight - local verification prerequisites are reachable"
      : productionMode
        ? "PASSED preflight - production Sentinel prerequisites are reachable"
      : "PASSED preflight - all required local and cloud prerequisites are reachable"
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  writeLine(`FAILED preflight - ${message}`);
  process.exitCode = 1;
});
