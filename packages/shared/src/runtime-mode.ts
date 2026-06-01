export type RuntimeMode = "local-verification" | "test-timing" | "autonomous-ready" | "production-blocked";

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
  return envValue(env, "SENTINEL_GENERATION_PROVIDER").toLowerCase() || envValue(env, "SENTINEL_AI_PROVIDER").toLowerCase() || "vertex";
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
  return booleanEnv(env, "SENTINEL_LOCAL_VERIFY");
}

export function isTestTimingMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return hasEnv(env, "SENTINEL_TEST_REMEDIATION_WAIT_MS");
}

export function isProductionRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  if (envValue(env, "SENTINEL_RUNTIME_ENV").toLowerCase() === "production") return true;
  if (booleanEnv(env, "SENTINEL_PRODUCTION_MODE")) return true;
  if (envValue(env, "NODE_ENV").toLowerCase() !== "production") return false;
  const publicAppUrl = envValue(env, "PUBLIC_APP_URL");
  const apiUrl = envValue(env, "API_PUBLIC_URL") || envValue(env, "NEXT_PUBLIC_API_URL");
  return !(publicAppUrl.length > 0 && apiUrl.length > 0 && isLocalUrl(publicAppUrl) && isLocalUrl(apiUrl));
}

export function canUseLocalVerificationEffect(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isProductionRuntime(env) && (isLocalVerificationMode(env) || isTestTimingMode(env));
}

export function productionReadinessViolations(env: NodeJS.ProcessEnv = process.env): string[] {
  if (!isProductionRuntime(env)) return [];

  const violations: string[] = [];
  if (isLocalVerificationMode(env)) {
    violations.push("SENTINEL_LOCAL_VERIFY=true records remediation instead of dispatching real action");
  }
  if (isTestTimingMode(env)) {
    violations.push("SENTINEL_TEST_REMEDIATION_WAIT_MS is set and can alter OperaIQ verification timing");
  }
  if (envValue(env, "SENTINEL_AI_PROVIDER").toLowerCase() === "offline") {
    violations.push("SENTINEL_AI_PROVIDER=offline is deterministic test reasoning, not production reasoning");
  }
  if (envValue(env, "SENTINEL_GENERATION_PROVIDER").toLowerCase() === "offline") {
    violations.push("SENTINEL_GENERATION_PROVIDER=offline is deterministic test generation, not production generation");
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
  const remediationBackend = envValue(env, "SENTINEL_REMEDIATION_BACKEND").toLowerCase() || "cloud-run";
  if (remediationBackend !== "cloud-run" && remediationBackend !== "admin-endpoint") {
    violations.push("SENTINEL_REMEDIATION_BACKEND must be cloud-run or admin-endpoint");
  }
  if (remediationBackend === "cloud-run" && !hasEnv(env, "GOOGLE_CLOUD_PROJECT_ID")) {
    violations.push("GOOGLE_CLOUD_PROJECT_ID is required when remediation backend is cloud-run");
  }
  if (remediationBackend === "admin-endpoint" && !hasEnv(env, "AGENT_TOOL_SECRET") && !hasEnv(env, "WEBHOOK_SECRET")) {
    violations.push("AGENT_TOOL_SECRET or WEBHOOK_SECRET is required when remediation backend is admin-endpoint");
  }
  const publicAppUrl = envValue(env, "PUBLIC_APP_URL");
  if (!publicAppUrl || isLocalUrl(publicAppUrl)) {
    violations.push("PUBLIC_APP_URL must be the public OperaIQ web URL");
  }
  const apiUrl = envValue(env, "API_PUBLIC_URL") || envValue(env, "NEXT_PUBLIC_API_URL");
  if (!apiUrl || isLocalUrl(apiUrl)) {
    violations.push("API_PUBLIC_URL or NEXT_PUBLIC_API_URL must be the public OperaIQ API URL");
  }
  const qdrantUrl = envValue(env, "QDRANT_URL");
  if (!qdrantUrl || isLocalUrl(qdrantUrl)) {
    violations.push("QDRANT_URL must point to a reachable non-local Qdrant endpoint in production");
  }
  const embeddingProvider = envValue(env, "EMBEDDING_PROVIDER").toLowerCase() || "nvidia";
  if (embeddingProvider === "nvidia" && !hasEnv(env, "NVIDIA_API_KEY")) {
    violations.push("NVIDIA_API_KEY is required when production embeddings use NVIDIA");
  }
  if (embeddingProvider === "openai" && !hasEnv(env, "OPENAI_API_KEY")) {
    violations.push("OPENAI_API_KEY is required when production embeddings use OpenAI");
  }
  return violations;
}

export function runtimeReadiness(env: NodeJS.ProcessEnv = process.env): {
  mode: RuntimeMode;
  production: boolean;
  localVerification: boolean;
  testTiming: boolean;
  violations: string[];
} {
  const production = isProductionRuntime(env);
  const localVerification = isLocalVerificationMode(env);
  const testTiming = isTestTimingMode(env);
  const violations = productionReadinessViolations(env);
  const mode: RuntimeMode = production
    ? violations.length > 0
      ? "production-blocked"
      : "autonomous-ready"
    : localVerification
      ? "local-verification"
      : testTiming
        ? "test-timing"
        : "autonomous-ready";
  return { mode, production, localVerification, testTiming, violations };
}

export function assertProductionSafeRuntime(component: string, env: NodeJS.ProcessEnv = process.env): void {
  const violations = productionReadinessViolations(env);
  if (violations.length === 0) return;
  throw new Error(`${component} cannot start in production mode: ${violations.join("; ")}`);
}
