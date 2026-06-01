import { loadRootEnv } from "@sentinel/shared";
import { z } from "zod";

loadRootEnv();

const optionalNonEmptyString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional()
);

const optionalUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().url().optional()
);

const agentEnvSchema = z.object({
  GOOGLE_CLOUD_PROJECT_ID: optionalNonEmptyString,
  GOOGLE_CLOUD_REGION: z.string().min(1).default("us-central1"),
  VERTEX_AI_LOCATION: z.string().min(1).default("us-central1"),
  SENTINEL_AI_PROVIDER: z.enum(["vertex", "offline"]).default("vertex"),
  SENTINEL_GENERATION_PROVIDER: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(["vertex", "offline", "nvidia", "openai-compatible"]).optional()
  ),
  NVIDIA_API_KEY: z.string().optional(),
  NVIDIA_BASE_URL: z.string().url().default("https://integrate.api.nvidia.com/v1"),
  NVIDIA_MODEL: z.string().min(1).default("nvidia/llama-3.1-nemotron-nano-8b-v1"),
  OPENAI_COMPATIBLE_API_KEY: z.string().optional(),
  OPENAI_COMPATIBLE_BASE_URL: optionalUrl,
  OPENAI_COMPATIBLE_MODEL: optionalNonEmptyString,
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_DEFAULT_INCIDENT_CHANNEL: z.string().optional(),
  PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  WEBHOOK_SECRET: optionalNonEmptyString,
  AGENT_TOOL_SECRET: optionalNonEmptyString,
  SENTINEL_REMEDIATION_BACKEND: z.enum(["cloud-run", "admin-endpoint"]).default("cloud-run"),
  CLOUD_RUN_REMEDIATION_JOB_PREFIX: z.string().min(1).default("operaiq-remediate"),
  AGENT_NAME: z.string().min(1).default("OperaIQ")
});

export type AgentEnv = z.infer<typeof agentEnvSchema>;

export function getAgentEnv(): AgentEnv {
  return agentEnvSchema.parse(process.env);
}
