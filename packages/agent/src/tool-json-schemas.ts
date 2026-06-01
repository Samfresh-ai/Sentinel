export type JsonSchema = {
  type: "object" | "array" | "string" | "number" | "boolean" | "null";
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  enum?: string[];
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  description?: string;
  default?: unknown;
};

export interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export const searchSimilarIncidentsSchema: JsonSchema = {
  type: "object",
  required: ["symptoms"],
  properties: {
    symptoms: { type: "array", items: { type: "string" }, description: "Raw symptom strings from the alert" },
    limit: { type: "number", default: 5, description: "Maximum number of similar resolved incidents to return" }
  }
};

export const getServiceDependencyGraphSchema: JsonSchema = {
  type: "object",
  required: ["serviceName"],
  properties: {
    serviceName: { type: "string", description: "Name of the affected service" }
  }
};

export const queryQdrantMemorySchema: JsonSchema = {
  type: "object",
  required: ["description"],
  properties: {
    query: { type: "string", description: "Plain-English memory/signal query for Qdrant vector retrieval" },
    services: { type: "array", items: { type: "string" }, description: "Services to investigate against Qdrant service context and incident memory" },
    symptoms: { type: "array", items: { type: "string" }, description: "Symptoms used to focus multi-service signal searches" },
    timeRange: {
      type: "object",
      properties: {
        earliest: { type: "string", description: "Relative lower bound label, for example -15m" },
        latest: { type: "string", description: "Relative upper bound label, for example now" }
      },
      additionalProperties: false
    },
    description: { type: "string", description: "Plain-English reason this Qdrant retrieval is being run" }
  }
};

export const querySplunkLogsSchema = queryQdrantMemorySchema;

export const executeRemediationSchema: JsonSchema = {
  type: "object",
  required: ["action", "targetService", "parameters"],
  properties: {
    action: {
      type: "string",
      enum: ["scale_service", "restart_pod", "purge_cache", "rotate_connection_pool", "notify_team"]
    },
    targetService: { type: "string" },
    parameters: {
      type: "object",
      additionalProperties: true
    }
  }
};

export const writePostmortemSchema: JsonSchema = {
  type: "object",
  required: ["incidentId", "timeline", "rootCause", "remediationTaken", "lessonLearned"],
  properties: {
    incidentId: { type: "string" },
    timeline: {
      type: "array",
      items: {
        type: "object",
        required: ["timestamp", "event", "actor"],
        properties: {
          timestamp: { type: "string" },
          event: { type: "string" },
          actor: { type: "string", enum: ["operaiq", "sentinel", "human"] }
        }
      }
    },
    rootCause: { type: "string" },
    remediationTaken: { type: "array", items: { type: "string" } },
    lessonLearned: { type: "string" }
  }
};

export const getRunbookSchema: JsonSchema = {
  type: "object",
  required: ["incidentDescription", "affectedServices"],
  properties: {
    incidentDescription: { type: "string" },
    affectedServices: { type: "array", items: { type: "string" } }
  }
};
