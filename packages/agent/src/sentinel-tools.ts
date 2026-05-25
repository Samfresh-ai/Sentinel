import {
  executeRemediationDefinition,
  querySplunkLogsDefinition,
  sentinelGetRunbookDefinition,
  sentinelGetServiceDependencyGraphDefinition,
  sentinelSearchSimilarIncidentsDefinition,
  sentinelWritePostmortemDefinition
} from "./tools/index.js";
import type { AgentToolDefinition } from "./tool-json-schemas.js";

export const sentinelToolDefinitions: AgentToolDefinition[] = [
  sentinelSearchSimilarIncidentsDefinition,
  querySplunkLogsDefinition,
  sentinelGetServiceDependencyGraphDefinition,
  sentinelGetRunbookDefinition,
  executeRemediationDefinition,
  sentinelWritePostmortemDefinition
];
