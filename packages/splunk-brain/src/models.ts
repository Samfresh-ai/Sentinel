export async function probeHostedModels(): Promise<boolean> {
  return false;
}

export const HOSTED_MODELS_AVAILABLE = false;

export async function generateWithHostedModels(_prompt: string): Promise<string> {
  throw new Error("OperaIQ uses Qdrant for memory and the configured generation provider for text generation");
}
