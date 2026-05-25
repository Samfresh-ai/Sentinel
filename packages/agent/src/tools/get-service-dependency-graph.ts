import { z } from "zod";
import { mongoFind } from "../mcp.js";
import { databaseName, asNumber, asString, asStringArray, invocationFailed, invocationFinished, invocationStarted } from "./common.js";
import { getServiceDependencyGraphSchema, type AgentToolDefinition } from "../tool-json-schemas.js";

export const getServiceDependencyGraphInputSchema = z.object({
  serviceName: z.string().min(1)
});

export interface ServiceGraphNode {
  name: string;
  team: string;
  language: string;
  dependencies: string[];
  dependents: string[];
  knownFragilePoints: string[];
  slaMs: number;
  owners: string[];
}

export interface ServiceDependencyGraph {
  service: ServiceGraphNode;
  dependencies: ServiceGraphNode[];
  dependents: ServiceGraphNode[];
}

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

export async function getServiceDependencyGraph(input: unknown): Promise<ServiceDependencyGraph | null> {
  const parsed = getServiceDependencyGraphInputSchema.parse(input);
  invocationStarted("get_service_dependency_graph", parsed);
  try {
    const rootDocs = await mongoFind({
      database: databaseName(),
      collection: "services",
      filter: { name: parsed.serviceName },
      limit: 1
    });
    const rootDoc = rootDocs[0];
    if (!rootDoc) {
      invocationFinished("get_service_dependency_graph", null);
      return null;
    }
    const root = mapService(rootDoc);
    const dependencyDocs = root.dependencies.length
      ? await mongoFind({
          database: databaseName(),
          collection: "services",
          filter: { name: { $in: root.dependencies } },
          limit: root.dependencies.length
        })
      : [];
    const dependentNames = new Set(root.dependents);
    const discoveredDependentDocs = await mongoFind({
      database: databaseName(),
      collection: "services",
      filter: { dependencies: parsed.serviceName },
      limit: 25
    });
    for (const doc of discoveredDependentDocs) {
      const name = asString(doc.name);
      if (name.length > 0) dependentNames.add(name);
    }
    const dependentDocs = dependentNames.size
      ? await mongoFind({
          database: databaseName(),
          collection: "services",
          filter: { name: { $in: [...dependentNames] } },
          limit: dependentNames.size
        })
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

export const getServiceDependencyGraphDefinition: AgentToolDefinition = {
  name: "get_service_dependency_graph",
  description: "Return one-level dependency and dependent graph for an affected service.",
  inputSchema: getServiceDependencyGraphSchema
};
