import { z } from "zod";
import { createLogger } from "@sentinel/shared";
import { createCollection, insertDocument } from "./kvstore.js";
import { sendEvent } from "./hec.js";

const logger = createLogger("operaiq-audit");

export const auditPhaseSchema = z.enum([
  "ASSESS",
  "REMEMBER",
  "INVESTIGATE",
  "MAP",
  "RETRIEVE",
  "ACT",
  "VERIFY",
  "CLOSE",
  "ESCALATE",
  "RATE_LIMITED",
  "DLQ_RETRY",
  "FAILED"
]);

export type AuditPhase = z.infer<typeof auditPhaseSchema>;

const auditEntrySchema = z.object({
  orgId: z.string().min(1),
  incidentId: z.string().min(1),
  timestamp: z.string().datetime(),
  phase: auditPhaseSchema,
  toolCalled: z.string().nullable(),
  input: z.record(z.unknown()),
  output: z.record(z.unknown()),
  confidenceScore: z.number().min(0).max(1).nullable(),
  durationMs: z.number().nonnegative(),
  success: z.boolean(),
  errorMessage: z.string().nullable()
});

export type AuditEntry = z.infer<typeof auditEntrySchema> & { _key?: string };

let auditCollectionReady: Promise<void> | null = null;

function ensureAuditCollection(): Promise<void> {
  auditCollectionReady ??= createCollection("audit_log", {});
  return auditCollectionReady;
}

function truncateValue(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (!serialized || serialized.length <= 2000) return value;
  return {
    truncated: true,
    charCount: serialized.length,
    preview: serialized.slice(0, 2000)
  };
}

function truncateRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, truncateValue(entry)]));
}

async function persistAuditEntry(entry: Omit<AuditEntry, "_key">): Promise<void> {
  await ensureAuditCollection();
  await Promise.all([
    insertDocument("audit_log", entry, { orgId: entry.orgId }),
    sendEvent({
      sourcetype: "operaiq:audit",
      event: {
        type: "audit_entry",
        ...entry
      }
    })
  ]);
}

export async function writeAuditEntry(entry: Omit<AuditEntry, "_key">): Promise<void> {
  try {
    const parsed = auditEntrySchema.parse({
      ...entry,
      input: truncateRecord(entry.input),
      output: truncateRecord(entry.output)
    });
    await persistAuditEntry(parsed);
  } catch (error: unknown) {
    logger.warn({ error }, "OperaIQ audit entry rejected");
  }
}
