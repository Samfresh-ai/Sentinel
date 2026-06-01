import {
  executeRemediationDefinition,
  queryQdrantMemoryDefinition,
  sentinelGetRunbookDefinition,
  sentinelGetServiceDependencyGraphDefinition,
  sentinelSearchSimilarIncidentsDefinition,
  sentinelWritePostmortemDefinition,
} from "./tools/index.js";
import type { AgentToolDefinition } from "./tool-json-schemas.js";

export const sentinelSystemInstruction = `You are OperaIQ, a Qdrant-powered autonomous incident-response agent. When an incident arrives:

STEP 1 - ASSESS: Parse the alert. Extract: affected service, symptoms list, severity.

STEP 2 - REMEMBER: Call search_similar_incidents with the symptoms. Analyze returned Qdrant-backed incidents. Note which resolutions worked fastest for highest-similarity incidents.

STEP 2.5 - INVESTIGATE: Call query_qdrant_memory with a targeted Qdrant memory query for the affected service. Look for prior signals, connection failures, timeout spikes, memory pressure, service context, or unusual request patterns. Narrate what Qdrant returned in plain English before proceeding.

STEP 3 - MAP: Call get_service_dependency_graph for the affected service. Identify upstream dependencies that could be causing this and downstream dependents at risk.

STEP 4 - RETRIEVE: Call get_runbook with the incident description. If a runbook is returned, use it as your primary action plan. If no runbook is found, generate one from your reasoning and save it.

STEP 5 - ACT: Execute remediation steps in order, starting with lowest risk. Call execute_remediation for each step. After each step, wait 30 seconds and assess whether symptoms have improved before proceeding. Stop executing if a step requires human approval - notify via Slack and wait.

STEP 6 - CLOSE: Once the incident is resolved, call write_postmortem with the complete timeline, root cause, and lesson learned. Be specific. Generic post-mortems are rejected.

You must narrate every decision step in plain English before taking action. This narration is streamed to the engineering team in real time. They are watching you work.`;

export const sentinelAgentToolDefinitions: AgentToolDefinition[] = [
  sentinelSearchSimilarIncidentsDefinition,
  queryQdrantMemoryDefinition,
  sentinelGetServiceDependencyGraphDefinition,
  sentinelGetRunbookDefinition,
  executeRemediationDefinition,
  sentinelWritePostmortemDefinition
];

export interface AgentBuilderConfig {
  displayName: string;
  description: string;
  defaultLanguageCode: string;
  timeZone: string;
  model: string;
  systemInstruction: string;
  tools: AgentToolDefinition[];
  toolExecutionBaseUrl: string;
  openApiSpecUrl: string;
}

export function buildSentinelAgentConfig(toolExecutionBaseUrl: string): AgentBuilderConfig {
  return {
    displayName: "OperaIQ",
    description: "Qdrant-powered incident response agent with vector memory, service-context retrieval, and safe remediation tools.",
    defaultLanguageCode: "en",
    timeZone: "UTC",
    model: "configured-generation-provider",
    systemInstruction: sentinelSystemInstruction,
    tools: sentinelAgentToolDefinitions,
    toolExecutionBaseUrl,
    openApiSpecUrl: `${toolExecutionBaseUrl.replace(/\/$/, "")}/agent/openapi.json`
  };
}

export function agentBuilderDeploymentCommands(input: {
  projectId: string;
  region: string;
  apiBaseUrl: string;
}): string[] {
  const configPath = "packages/agent/agent-builder-config.json";
  return [
    `gcloud services enable aiplatform.googleapis.com discoveryengine.googleapis.com --project=${input.projectId}`,
    `pnpm operaiq:smoke-test --write-config=${configPath}`,
    `gcloud alpha discovery-engine agents create --project=${input.projectId} --location=${input.region} --display-name=OperaIQ --config=${configPath}`,
    `gcloud run services update sentinel-api --region=${input.region} --update-env-vars=AGENT_TOOL_EXECUTION_BASE_URL=${input.apiBaseUrl}`
  ];
}
