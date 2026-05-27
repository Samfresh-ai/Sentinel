import { loadRootEnv } from "@operaiq/shared";
import { z } from "zod";

loadRootEnv();

const brainEnvSchema = z.object({
  MONGODB_ATLAS_URI: z.string().min(1),
  MONGODB_DATABASE_NAME: z.string().min(1).default("operaiq"),
  GOOGLE_CLOUD_PROJECT_ID: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional()
  ),
  VERTEX_AI_LOCATION: z.string().min(1).default("us-central1"),
  OPERAIQ_AI_PROVIDER: z.enum(["vertex", "offline"]).default("vertex")
});

export type BrainEnv = z.infer<typeof brainEnvSchema>;

export function getBrainEnv(): BrainEnv {
  return brainEnvSchema.parse(process.env);
}
