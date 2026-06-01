import { insertDocument } from "./kvstore.js";
import type { QdrantMemoryEvent } from "./types.js";

function normalizeEvent(event: QdrantMemoryEvent): Record<string, unknown> {
  const createdAt = new Date((event.time ?? Date.now() / 1000) * 1000).toISOString();
  const body = event.event;
  return {
    kind: typeof body.kind === "string" ? body.kind : "service_context",
    sourcetype: event.sourcetype ?? "operaiq:event",
    source: event.source ?? "operaiq",
    host: event.host ?? "operaiq-api",
    createdAt,
    updatedAt: createdAt,
    ...body
  };
}

export async function sendEvent(event: QdrantMemoryEvent | QdrantMemoryEvent[]): Promise<void> {
  const events = Array.isArray(event) ? event : [event];
  for (const item of events) {
    const document = normalizeEvent(item);
    const orgId = typeof document.orgId === "string" ? document.orgId : undefined;
    await insertDocument("events", document, orgId ? { orgId } : undefined);
  }
}
