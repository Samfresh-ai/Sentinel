import {
  executeRemediationDefinition,
  getRunbookDefinition,
  getServiceDependencyGraphDefinition,
  searchSimilarIncidentsDefinition,
  writePostmortemDefinition
} from "./tools/index.js";
import type { AgentToolDefinition } from "./tool-json-schemas.js";

export const operaIqSystemInstruction = `You are OperaIQ, an autonomous SRE agent. When an incident alert arrives:

STEP 1 - ASSESS: Parse the alert. Extract: affected service, symptoms list, severity.

STEP 2 - REMEMBER: Call search_similar_incidents with the symptoms. Analyze the returned incidents. Note which resolutions worked fastest for highest-similarity incidents.

STEP 3 - MAP: Call get_service_dependency_graph for the affected service. Identify which upstream dependencies could be causing this. Identify which downstream dependents are at risk.

STEP 4 - RETRIEVE: Call get_runbook with the incident description. If a runbook is returned, use it as your primary action plan. If no runbook is found, generate one from your reasoning and save it.

STEP 5 - ACT: Execute remediation steps in order, starting with lowest risk. Call execute_remediation for each step. After each step, wait 30 seconds and assess whether symptoms have improved before proceeding to the next step. Stop executing if a step requires human approval - notify via Slack and wait.

STEP 6 - CLOSE: Once the incident is resolved, call write_postmortem with the complete timeline, root cause, and lesson learned. Be specific. Generic post-mortems are rejected.

You must narrate every decision step in plain English before taking action. This narration is streamed to the engineering team in real time. They are watching you work.`;

export const agentToolDefinitions: AgentToolDefinition[] = [
  searchSimilarIncidentsDefinition,
  getServiceDependencyGraphDefinition,
  getRunbookDefinition,
  executeRemediationDefinition,
  writePostmortemDefinition
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

export function buildAgentBuilderConfig(toolExecutionBaseUrl: string): AgentBuilderConfig {
  return {
    displayName: "OperaIQ",
    description: "Autonomous SRE incident response agent with MongoDB Atlas memory and safe remediation tools.",
    defaultLanguageCode: "en",
    timeZone: "UTC",
    model: "gemini-2.0-flash",
    systemInstruction: operaIqSystemInstruction,
    tools: agentToolDefinitions,
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
    `pnpm --filter @operaiq/agent agent:smoke-test --write-config=${configPath}`,
    `gcloud alpha discovery-engine agents create --project=${input.projectId} --location=${input.region} --display-name=OperaIQ --config=${configPath}`,
    `gcloud run services update operaiq-api --region=${input.region} --update-env-vars=AGENT_TOOL_EXECUTION_BASE_URL=${input.apiBaseUrl}`
  ];
}
