import {
  executeRemediationDefinition,
  queryQdrantMemoryDefinition,
  sentinelGetRunbookDefinition,
  sentinelGetServiceDependencyGraphDefinition,
  sentinelSearchSimilarIncidentsDefinition,
  sentinelWritePostmortemDefinition
} from "./tools/index.js";
import type { AgentToolDefinition } from "./tool-json-schemas.js";

export const sentinelToolDefinitions: AgentToolDefinition[] = [
  sentinelSearchSimilarIncidentsDefinition,
  queryQdrantMemoryDefinition,
  sentinelGetServiceDependencyGraphDefinition,
  sentinelGetRunbookDefinition,
  executeRemediationDefinition,
  sentinelWritePostmortemDefinition
];
