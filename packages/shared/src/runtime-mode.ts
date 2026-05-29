export type RuntimeMode = "local-verification" | "demo" | "autonomous-ready" | "production-blocked";

function envValue(env: NodeJS.ProcessEnv, key: string): string {
  return (env[key] ?? "").trim();
}

function booleanEnv(env: NodeJS.ProcessEnv, key: string): boolean {
  return envValue(env, key).toLowerCase() === "true";
}

function hasEnv(env: NodeJS.ProcessEnv, key: string): boolean {
  return envValue(env, key).length > 0;
}

function generationProvider(env: NodeJS.ProcessEnv): string {
  return envValue(env, "OPERAIQ_GENERATION_PROVIDER").toLowerCase() || envValue(env, "OPERAIQ_AI_PROVIDER").toLowerCase() || "vertex";
}

function isLocalUrl(value: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return isLocalHostname(url.hostname);
  } catch {
    return false;
  }
}

function endpointHostname(value: string): string {
  if (!value) return "";
  try {
    return new URL(value).hostname;
  } catch {
    return value;
  }
}

function isLocalEndpoint(value: string): boolean {
  const hostname = endpointHostname(value);
  return !hostname || isLocalHostname(hostname);
}

function isLocalHostname(value: string): boolean {
  const hostname = value.trim().toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

export function isLocalVerificationMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return booleanEnv(env, "OPERAIQ_LOCAL_VERIFY");
}

export function isDemoTimingMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return hasEnv(env, "DEMO_REMEDIATION_WAIT_MS");
}

export function isProductionRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  if (envValue(env, "OPERAIQ_RUNTIME_ENV").toLowerCase() === "production") return true;
  if (booleanEnv(env, "SENTINEL_PRODUCTION_MODE")) return true;
  if (envValue(env, "NODE_ENV").toLowerCase() !== "production") return false;
  const publicAppUrl = envValue(env, "PUBLIC_APP_URL");
  const apiUrl = envValue(env, "NEXT_PUBLIC_API_URL");
  return !(publicAppUrl.length > 0 && apiUrl.length > 0 && isLocalUrl(publicAppUrl) && isLocalUrl(apiUrl));
}

export function canUseLocalVerificationEffect(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isProductionRuntime(env) && (isLocalVerificationMode(env) || isDemoTimingMode(env));
}

export function productionReadinessViolations(env: NodeJS.ProcessEnv = process.env): string[] {
  if (!isProductionRuntime(env)) return [];

  const violations: string[] = [];
  if (isLocalVerificationMode(env)) {
    violations.push("OPERAIQ_LOCAL_VERIFY=true records remediation instead of dispatching real action");
  }
  if (isDemoTimingMode(env)) {
    violations.push("DEMO_REMEDIATION_WAIT_MS is set and can alter demo verification timing");
  }
  if (envValue(env, "OPERAIQ_AI_PROVIDER").toLowerCase() === "offline") {
    violations.push("OPERAIQ_AI_PROVIDER=offline is deterministic test reasoning, not production reasoning");
  }
  if (envValue(env, "OPERAIQ_GENERATION_PROVIDER").toLowerCase() === "offline") {
    violations.push("OPERAIQ_GENERATION_PROVIDER=offline is deterministic test generation, not production generation");
  }
  const provider = generationProvider(env);
  if (provider === "vertex" && !hasEnv(env, "GOOGLE_CLOUD_PROJECT_ID")) {
    violations.push("GOOGLE_CLOUD_PROJECT_ID is required when production generation uses Vertex AI");
  }
  if (provider === "nvidia" && !hasEnv(env, "NVIDIA_API_KEY")) {
    violations.push("NVIDIA_API_KEY is required when production generation uses NVIDIA");
  }
  if (provider === "openai-compatible") {
    for (const key of ["OPENAI_COMPATIBLE_API_KEY", "OPENAI_COMPATIBLE_BASE_URL", "OPENAI_COMPATIBLE_MODEL"]) {
      if (!hasEnv(env, key)) violations.push(`${key} is required when production generation uses an OpenAI-compatible provider`);
    }
  }
  const remediationBackend = envValue(env, "OPERAIQ_REMEDIATION_BACKEND").toLowerCase() || "cloud-run";
  if (remediationBackend !== "cloud-run" && remediationBackend !== "admin-endpoint") {
    violations.push("OPERAIQ_REMEDIATION_BACKEND must be cloud-run or admin-endpoint");
  }
  if (remediationBackend === "cloud-run" && !hasEnv(env, "GOOGLE_CLOUD_PROJECT_ID")) {
    violations.push("GOOGLE_CLOUD_PROJECT_ID is required when remediation backend is cloud-run");
  }
  if (remediationBackend === "admin-endpoint" && !hasEnv(env, "AGENT_TOOL_SECRET") && !hasEnv(env, "WEBHOOK_SECRET")) {
    violations.push("AGENT_TOOL_SECRET or WEBHOOK_SECRET is required when remediation backend is admin-endpoint");
  }
  const publicAppUrl = envValue(env, "PUBLIC_APP_URL");
  if (!publicAppUrl || isLocalUrl(publicAppUrl)) {
    violations.push("PUBLIC_APP_URL must be the public Sentinel web URL");
  }
  const apiUrl = envValue(env, "NEXT_PUBLIC_API_URL");
  if (!apiUrl || isLocalUrl(apiUrl)) {
    violations.push("NEXT_PUBLIC_API_URL must be the public Sentinel API URL");
  }
  const splunkHost = envValue(env, "SPLUNK_HOST");
  const splunkCloudStackHost = envValue(env, "SPLUNK_CLOUD_STACK_HOST");
  const splunkMgmtEndpoint = envValue(env, "SPLUNK_MGMT_URL") || splunkCloudStackHost || splunkHost;
  const splunkHecEndpoint = envValue(env, "SPLUNK_HEC_URL") || splunkCloudStackHost || splunkHost;
  if (isLocalEndpoint(splunkMgmtEndpoint)) {
    violations.push("SPLUNK_MGMT_URL or SPLUNK_HOST must point to a reachable non-local Splunk management endpoint in production");
  }
  if (isLocalEndpoint(splunkHecEndpoint)) {
    violations.push("SPLUNK_HEC_URL or SPLUNK_HOST must point to a reachable non-local Splunk HEC endpoint in production");
  }
  for (const key of ["SPLUNK_USERNAME", "SPLUNK_PASSWORD", "SPLUNK_HEC_TOKEN"]) {
    if (!hasEnv(env, key)) violations.push(`${key} is required for production Splunk access`);
  }
  if (splunkCloudStackHost && (hasEnv(env, "SPLUNK_GATEWAY_TOKEN") || hasEnv(env, "SPLUNK_CF_ACCESS_CLIENT_ID") || hasEnv(env, "SPLUNK_CF_ACCESS_CLIENT_SECRET"))) {
    violations.push("SPLUNK_CLOUD_STACK_HOST should not be combined with local tunnel gateway or Cloudflare Access Splunk variables");
  }
  return violations;
}

export function runtimeReadiness(env: NodeJS.ProcessEnv = process.env): {
  mode: RuntimeMode;
  production: boolean;
  localVerification: boolean;
  demoTiming: boolean;
  violations: string[];
} {
  const production = isProductionRuntime(env);
  const localVerification = isLocalVerificationMode(env);
  const demoTiming = isDemoTimingMode(env);
  const violations = productionReadinessViolations(env);
  const mode: RuntimeMode = production
    ? violations.length > 0
      ? "production-blocked"
      : "autonomous-ready"
    : localVerification
      ? "local-verification"
      : demoTiming
        ? "demo"
        : "autonomous-ready";
  return { mode, production, localVerification, demoTiming, violations };
}

export function assertProductionSafeRuntime(component: string, env: NodeJS.ProcessEnv = process.env): void {
  const violations = productionReadinessViolations(env);
  if (violations.length === 0) return;
  throw new Error(`${component} cannot start in production mode: ${violations.join("; ")}`);
}
