import { loadRootEnv } from "@operaiq/shared";
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
  MONGODB_ATLAS_URI: z.string().min(1),
  MONGODB_DATABASE_NAME: z.string().min(1).default("operaiq"),
  GOOGLE_CLOUD_PROJECT_ID: z.string().min(1),
  GOOGLE_CLOUD_REGION: z.string().min(1).default("us-central1"),
  VERTEX_AI_LOCATION: z.string().min(1).default("us-central1"),
  OPERAIQ_AI_PROVIDER: z.enum(["vertex", "offline"]).default("vertex"),
  OPERAIQ_GENERATION_PROVIDER: z.preprocess(
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
  CLOUD_RUN_REMEDIATION_JOB_PREFIX: z.string().min(1).default("operaiq-remediate"),
  MONGODB_MCP_SERVER_COMMAND: z.string().optional(),
  AGENT_NAME: z.string().min(1).default("OperaIQ")
});

export type AgentEnv = z.infer<typeof agentEnvSchema>;

export function getAgentEnv(): AgentEnv {
  return agentEnvSchema.parse(process.env);
}
