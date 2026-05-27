import { z } from "zod";

const optionalNonEmptyString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional()
);

const optionalUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().url().optional()
);

export const severitySchema = z.enum(["P1", "P2", "P3", "P4"]);
export const incidentStatusSchema = z.enum(["open", "resolved", "in_progress", "escalated", "failed"]);
export const actorSchema = z.enum(["operaiq", "human"]);
export const remediationActionSchema = z.enum([
  "scale_service",
  "restart_pod",
  "purge_cache",
  "rotate_connection_pool",
  "notify_team"
]);
export const riskLevelSchema = z.enum(["low", "medium", "high"]);
export const agentStepTypeSchema = z.enum(["ASSESS", "REMEMBER", "INVESTIGATE", "MAP", "RETRIEVE", "ACT", "VERIFY", "CLOSE", "ESCALATE", "ERROR"]);

export const envSchema = z.object({
  MONGODB_ATLAS_URI: z.string().min(1),
  MONGODB_DATABASE_NAME: z.string().min(1).default("operaiq"),
  GOOGLE_CLOUD_PROJECT_ID: optionalNonEmptyString,
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
  AGENT_BUILDER_AGENT_ID: z.string().optional(),
  PUBSUB_ALERT_TOPIC: z.string().min(1).default("operaiq-alerts"),
  PUBSUB_EVENTS_TOPIC: z.string().min(1).default("operaiq-agent-events"),
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_DEFAULT_INCIDENT_CHANNEL: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(3001),
  WEBHOOK_SECRET: z.string().min(1),
  AGENT_TOOL_SECRET: optionalNonEmptyString,
  OPERAIQ_REMEDIATION_BACKEND: z.enum(["cloud-run", "admin-endpoint"]).default("cloud-run"),
  PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  NEXT_PUBLIC_API_URL: z.string().url().default("http://localhost:3001")
});

export const objectIdStringSchema = z.string().regex(/^[a-f\d]{24}$/i);

export const pagerDutyWebhookPayloadSchema = z
  .object({
    event: z
      .object({
        id: z.string().optional(),
        event_type: z.string().optional(),
        occurred_at: z.string().optional(),
        data: z
          .object({
            id: z.string().optional(),
            title: z.string().optional(),
            summary: z.string().optional(),
            urgency: z.string().optional(),
            service: z
              .object({
                id: z.string().optional(),
                summary: z.string().optional(),
                type: z.string().optional()
              })
              .passthrough()
              .optional(),
            priority: z
              .object({
                summary: z.string().optional()
              })
              .passthrough()
              .optional(),
            body: z
              .object({
                details: z.record(z.unknown()).optional()
              })
              .passthrough()
              .optional()
          })
          .passthrough()
          .optional()
      })
      .passthrough()
  })
  .passthrough();

export const datadogMonitorPayloadSchema = z
  .object({
    title: z.string().optional(),
    alert_title: z.string().optional(),
    message: z.string().optional(),
    alert_type: z.string().optional(),
    alert_id: z.union([z.string(), z.number()]).optional(),
    date: z.union([z.string(), z.number()]).optional(),
    tags: z.union([z.array(z.string()), z.string()]).optional(),
    priority: z.string().optional(),
    host: z.string().optional(),
    service: z.string().optional()
  })
  .passthrough();

export const prometheusAlertSchema = z
  .object({
    version: z.string().optional(),
    groupKey: z.string().optional(),
    status: z.string().optional(),
    receiver: z.string().optional(),
    alerts: z
      .array(
        z
          .object({
            status: z.string().optional(),
            labels: z.record(z.string()).optional(),
            annotations: z.record(z.string()).optional(),
            startsAt: z.string().optional()
          })
          .passthrough()
      )
      .optional()
  })
  .passthrough();

export const genericOperaIqAlertPayloadSchema = z
  .object({
    source: z.literal("operaiq").default("operaiq"),
    title: z.string().min(1),
    severity: severitySchema,
    service: z.string().min(1),
    symptoms: z.array(z.string().min(1)).min(1),
    incidentType: z.string().optional(),
    detectedAt: z.string().datetime().optional(),
    rawPayload: z.record(z.unknown()).optional()
  })
  .passthrough();

export const normalizedAlertSchema = z.object({
  source: z.enum(["pagerduty", "datadog", "prometheus", "operaiq"]),
  title: z.string().min(1),
  severity: severitySchema,
  affectedServices: z.array(z.string().min(1)).min(1),
  symptoms: z.array(z.string().min(1)).min(1),
  incidentType: z.string().optional(),
  detectedAt: z.string().datetime(),
  rawPayload: z.record(z.unknown())
});

export const webhookPayloadSchema = z.union([
  genericOperaIqAlertPayloadSchema,
  pagerDutyWebhookPayloadSchema,
  datadogMonitorPayloadSchema,
  prometheusAlertSchema
]);

export const runbookStepSchema = z.object({
  order: z.number().int().positive(),
  action: z.string().min(1),
  command: z.string().nullable(),
  isExecutable: z.boolean(),
  riskLevel: riskLevelSchema
});

export const agentEventSchema = z.object({
  incidentId: objectIdStringSchema,
  stepType: agentStepTypeSchema,
  message: z.string().min(1),
  payload: z.record(z.unknown()).optional(),
  createdAt: z.string().datetime()
});

export const executeRemediationInputSchema = z.object({
  action: remediationActionSchema,
  targetService: z.string().min(1),
  parameters: z.record(z.union([z.string(), z.number()]))
});

export const executeRemediationResultSchema = z.object({
  success: z.boolean(),
  action: remediationActionSchema,
  targetService: z.string(),
  executedAt: z.date(),
  output: z.string(),
  requiresHumanApproval: z.boolean()
});

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25)
});

export type Severity = z.infer<typeof severitySchema>;
export type IncidentStatus = z.infer<typeof incidentStatusSchema>;
export type RiskLevel = z.infer<typeof riskLevelSchema>;
export type RemediationAction = z.infer<typeof remediationActionSchema>;
export type AgentStepType = z.infer<typeof agentStepTypeSchema>;
export type NormalizedAlert = z.infer<typeof normalizedAlertSchema>;
export type GenericOperaIqAlertPayload = z.infer<typeof genericOperaIqAlertPayloadSchema>;
export type RunbookStep = z.infer<typeof runbookStepSchema>;
export type AgentEvent = z.infer<typeof agentEventSchema>;
export type ExecuteRemediationInput = z.infer<typeof executeRemediationInputSchema>;
export type ExecuteRemediationResult = z.infer<typeof executeRemediationResultSchema>;
