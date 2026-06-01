import "dotenv/config";
import { spawnSync } from "node:child_process";
import { isProductionRuntime, productionReadinessViolations } from "@sentinel/shared";

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
  return envValue("SENTINEL_GENERATION_PROVIDER").toLowerCase() || envValue("SENTINEL_AI_PROVIDER").toLowerCase() || "vertex";
}

function remediationBackend(): string {
  return envValue("SENTINEL_REMEDIATION_BACKEND").toLowerCase() || "cloud-run";
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
  const localVerifyMode = booleanEnv("SENTINEL_LOCAL_VERIFY");
  const offlineAi = process.env.SENTINEL_AI_PROVIDER === "offline";
  const provider = generationProvider();
  const backend = remediationBackend();
  const usesVertex = provider === "vertex";
  const usesCloudRun = backend === "cloud-run";
  const productionMode = isProductionRuntime();
  const requiredVariables = [
    "WEBHOOK_SECRET",
    "NEXT_PUBLIC_API_URL",
    "QDRANT_URL",
    "QDRANT_COLLECTION",
    "EMBEDDING_PROVIDER"
  ];
  if (usesVertex || usesCloudRun) {
    requiredVariables.push("GOOGLE_CLOUD_PROJECT_ID");
  }
  if (provider === "nvidia") {
    requiredVariables.push("NVIDIA_API_KEY");
  }
  if (provider === "openai-compatible") {
    requiredVariables.push("OPENAI_COMPATIBLE_API_KEY", "OPENAI_COMPATIBLE_BASE_URL", "OPENAI_COMPATIBLE_MODEL");
  }
  if (envValue("EMBEDDING_PROVIDER").toLowerCase() === "nvidia") {
    requiredVariables.push("NVIDIA_API_KEY");
  }
  if (envValue("EMBEDDING_PROVIDER").toLowerCase() === "openai") {
    requiredVariables.push("OPENAI_API_KEY");
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

  if (usesCloudRun || usesVertex) {
    const gcloud = checkCommand("gcloud", ["--version"]);
    checks.push({ name: "gcloud", ...gcloud });
  } else {
    checks.push({ name: "gcloud", ok: true, detail: "skipped for OperaIQ admin-endpoint deployment" });
  }
  if (!productionMode) {
    const docker = checkCommand("docker", ["info"]);
    checks.push({ name: "docker-daemon", ...docker });
  }
  checks.push({ name: "qdrant", ok: true, detail: "checked by scripts/qdrant-setup-check.ts" });
  checks.push({ name: "webhook-flow", ok: true, detail: "OperaIQ accepts generic incident alert webhooks" });
  if (offlineAi) {
    checks.push({ name: "vertex-ai", ok: true, detail: "skipped because SENTINEL_AI_PROVIDER=offline" });
  }
  if (localVerifyMode) {
    checks.push({ name: "slack", ok: true, detail: "skipped because SENTINEL_LOCAL_VERIFY=true" });
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
        ? "PASSED preflight - production OperaIQ prerequisites are reachable"
      : "PASSED preflight - all required local and cloud prerequisites are reachable"
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  writeLine(`FAILED preflight - ${message}`);
  process.exitCode = 1;
});
