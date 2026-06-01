import { loadRootEnv } from "@sentinel/shared";
import { z } from "zod";

loadRootEnv();

const optionalNonEmptyString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional()
);

const embeddingProviderSchema = z.enum(["nvidia", "openai"]);

export const qdrantEnvSchema = z.object({
  QDRANT_URL: z.string().url().default("http://localhost:6333"),
  QDRANT_API_KEY: optionalNonEmptyString,
  QDRANT_COLLECTION: z.string().min(1).default("operaiq_memory"),
  OPERAIQ_ORG_ID: z.string().min(1).default("operaiq-local-org"),
  OPERAIQ_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.82),
  OPERAIQ_AUTO_ACT_LOW_RISK: z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes"].includes(normalized)) return true;
    if (["false", "0", "no"].includes(normalized)) return false;
    return value;
  }, z.boolean().default(true)),
  EMBEDDING_PROVIDER: embeddingProviderSchema.default("nvidia"),
  NVIDIA_API_KEY: optionalNonEmptyString,
  NVIDIA_BASE_URL: z.string().url().default("https://integrate.api.nvidia.com/v1"),
  NVIDIA_EMBEDDING_MODEL: z.string().min(1).default("nvidia/nv-embedqa-e5-v5"),
  OPENAI_API_KEY: optionalNonEmptyString,
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  OPENAI_EMBEDDING_MODEL: z.string().min(1).default("text-embedding-3-small")
});

export type QdrantEnv = z.infer<typeof qdrantEnvSchema>;
export type EmbeddingProvider = z.infer<typeof embeddingProviderSchema>;

export function getQdrantEnv(): QdrantEnv {
  const parsed = qdrantEnvSchema.parse(process.env);
  if (parsed.EMBEDDING_PROVIDER === "nvidia" && !parsed.NVIDIA_API_KEY) {
    throw new Error("NVIDIA_API_KEY is required when EMBEDDING_PROVIDER=nvidia");
  }
  if (parsed.EMBEDDING_PROVIDER === "openai" && !parsed.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai");
  }
  return parsed;
}
