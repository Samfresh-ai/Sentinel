import { z } from "zod";
import { getQdrantEnv } from "./env.js";

const embeddingResponseSchema = z.object({
  data: z.array(
    z.object({
      embedding: z.array(z.number())
    }).passthrough()
  ).min(1)
}).passthrough();

type EmbeddingInputType = "query" | "passage";

function providerUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/embeddings`;
}

async function postEmbedding(url: string, apiKey: string, body: Record<string, unknown>): Promise<number[]> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Embedding provider failed with ${response.status}: ${text}`);
  }
  const parsed = embeddingResponseSchema.parse(JSON.parse(text));
  return parsed.data[0]!.embedding;
}

function normalizeText(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? trimmed.slice(0, 12_000) : "empty incident-response memory";
}

export async function embedText(text: string, inputType: EmbeddingInputType): Promise<number[]> {
  const config = getQdrantEnv();
  const input = normalizeText(text);
  if (config.EMBEDDING_PROVIDER === "nvidia") {
    return postEmbedding(providerUrl(config.NVIDIA_BASE_URL), config.NVIDIA_API_KEY!, {
      model: config.NVIDIA_EMBEDDING_MODEL,
      input: [input],
      input_type: inputType,
      encoding_format: "float",
      truncate: "END"
    });
  }
  return postEmbedding(providerUrl(config.OPENAI_BASE_URL), config.OPENAI_API_KEY!, {
    model: config.OPENAI_EMBEDDING_MODEL,
    input
  });
}

export async function embedPassage(text: string): Promise<number[]> {
  return embedText(text, "passage");
}

export async function embedQuery(text: string): Promise<number[]> {
  return embedText(text, "query");
}
