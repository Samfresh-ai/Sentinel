import { z } from "zod";
import { qdrantMemoryQuery } from "@sentinel/splunk-mcp";
import { getServiceDependencyGraphSchema, type AgentToolDefinition } from "../tool-json-schemas.js";
import { asNumber, asString, asStringArray, invocationFailed, invocationFinished, invocationStarted } from "./common.js";

export type ServiceGraphNode = {
  name: string;
  team: string;
  language: string;
  dependencies: string[];
  dependents: string[];
  knownFragilePoints: string[];
  slaMs: number;
  owners: string[];
};

export type ServiceDependencyGraph = {
  service: ServiceGraphNode;
  dependencies: ServiceGraphNode[];
  dependents: ServiceGraphNode[];
};

export const sentinelGetServiceDependencyGraphInputSchema = z.object({
  serviceName: z.string().min(1),
  orgId: z.string().min(1)
});

function mapService(doc: Record<string, unknown>): ServiceGraphNode {
  return {
    name: asString(doc.name),
    team: asString(doc.team),
    language: asString(doc.language),
    dependencies: asStringArray(doc.dependencies),
    dependents: asStringArray(doc.dependents),
    knownFragilePoints: asStringArray(doc.knownFragilePoints),
    slaMs: asNumber(doc.slaMs),
    owners: asStringArray(doc.owners)
  };
}

export async function sentinelGetServiceDependencyGraph(input: unknown): Promise<ServiceDependencyGraph | null> {
  const parsed = sentinelGetServiceDependencyGraphInputSchema.parse(input);
  invocationStarted("get_service_dependency_graph", parsed);
  try {
    const rootDoc = (await qdrantMemoryQuery("services", { name: parsed.serviceName }, 1, parsed.orgId))[0];
    if (!rootDoc) {
      invocationFinished("get_service_dependency_graph", null);
      return null;
    }
    const root = mapService(rootDoc);
    const dependencyDocs = root.dependencies.length
      ? await qdrantMemoryQuery("services", { name: { $in: root.dependencies } }, root.dependencies.length, parsed.orgId)
      : [];
    const dependentNames = new Set(root.dependents);
    const discoveredDependentDocs = await qdrantMemoryQuery("services", { dependencies: parsed.serviceName }, 25, parsed.orgId);
    for (const doc of discoveredDependentDocs) {
      const name = asString(doc.name);
      if (name.length > 0) dependentNames.add(name);
    }
    const dependentDocs = dependentNames.size
      ? await qdrantMemoryQuery("services", { name: { $in: [...dependentNames] } }, dependentNames.size, parsed.orgId)
      : [];
    const graph = {
      service: root,
      dependencies: dependencyDocs.map(mapService),
      dependents: dependentDocs.map(mapService)
    };
    invocationFinished("get_service_dependency_graph", graph);
    return graph;
  } catch (error: unknown) {
    invocationFailed("get_service_dependency_graph", error);
    throw error;
  }
}

export const sentinelGetServiceDependencyGraphDefinition: AgentToolDefinition = {
  name: "get_service_dependency_graph",
  description: "Return one-level dependency and dependent graph for an affected service from Qdrant service context.",
  inputSchema: getServiceDependencyGraphSchema
};
