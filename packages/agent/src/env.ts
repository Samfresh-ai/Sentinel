import { loadRootEnv } from "@operaiq/shared";
import { z } from "zod";

loadRootEnv();

const agentEnvSchema = z.object({
  MONGODB_ATLAS_URI: z.string().min(1),
  MONGODB_DATABASE_NAME: z.string().min(1).default("operaiq"),
  GOOGLE_CLOUD_PROJECT_ID: z.string().min(1),
  GOOGLE_CLOUD_REGION: z.string().min(1).default("us-central1"),
  VERTEX_AI_LOCATION: z.string().min(1).default("us-central1"),
  OPERAIQ_AI_PROVIDER: z.enum(["vertex", "offline"]).default("vertex"),
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_DEFAULT_INCIDENT_CHANNEL: z.string().optional(),
  PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  CLOUD_RUN_REMEDIATION_JOB_PREFIX: z.string().min(1).default("operaiq-remediate"),
  MONGODB_MCP_SERVER_COMMAND: z.string().optional()
});

export type AgentEnv = z.infer<typeof agentEnvSchema>;

export function getAgentEnv(): AgentEnv {
  return agentEnvSchema.parse(process.env);
}
