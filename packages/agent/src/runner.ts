import { z } from "zod";
import { agentEventSchema, type AgentEvent, type AgentStepType, type NormalizedAlert, normalizedAlertSchema } from "@operaiq/shared";
import { generateIncidentConclusion } from "./gemini.js";
import { mongoAggregate } from "./mcp.js";
import { executeRemediation, getRunbook, getServiceDependencyGraph, searchSimilarIncidents, writePostmortem } from "./tools/index.js";
import { databaseName, invocationFailed } from "./tools/common.js";

export type AgentEventSink = (event: AgentEvent) => Promise<void>;

export const runIncidentAgentInputSchema = z.object({
  incidentId: z.string().regex(/^[a-f\d]{24}$/i),
  alert: normalizedAlertSchema
});

export interface RunIncidentAgentResult {
  incidentId: string;
  toolsCalled: string[];
  status: "resolved" | "requires_human_approval" | "failed";
}

async function waitAfterRemediation(): Promise<void> {
  const waitMs = Number.parseInt(process.env.OPERAIQ_REMEDIATION_WAIT_MS ?? "30000", 10);
  if (waitMs > 0) {
    await new Promise((resolve) => {
      setTimeout(resolve, waitMs);
    });
  }
}

async function emit(sink: AgentEventSink | undefined, incidentId: string, stepType: AgentStepType, message: string, payload?: Record<string, unknown>): Promise<void> {
  if (!sink) return;
  const event = agentEventSchema.parse({
    incidentId,
    stepType,
    message,
    payload,
    createdAt: new Date().toISOString()
  });
  await sink(event);
}

async function updateIncidentStatus(incidentId: string, status: "open" | "in_progress" | "resolved"): Promise<void> {
  const updatedAtIso = new Date().toISOString();
  await mongoAggregate({
    database: databaseName(),
    collection: "incidents",
    pipeline: [
      { $match: { $expr: { $eq: [{ $toString: "$_id" }, incidentId] } } },
      {
        $set: {
          status,
          updatedAt: { $dateFromString: { dateString: updatedAtIso } }
        }
      },
      { $merge: { into: "incidents", on: "_id", whenMatched: "replace", whenNotMatched: "discard" } }
    ]
  });
}

function actionFromCommand(command: string | null): "scale_service" | "restart_pod" | "purge_cache" | "rotate_connection_pool" | "notify_team" | null {
  if (
    command === "scale_service" ||
    command === "restart_pod" ||
    command === "purge_cache" ||
    command === "rotate_connection_pool" ||
    command === "notify_team"
  ) {
    return command;
  }
  return null;
}

export async function runIncidentAgent(input: unknown, sink?: AgentEventSink): Promise<RunIncidentAgentResult> {
  const parsed = runIncidentAgentInputSchema.parse(input);
  const toolsCalled: string[] = [];
  const timeline: Array<{ timestamp: string; event: string; actor: "operaiq" | "human" }> = [];
  const addTimeline = (event: string): void => {
    timeline.push({ timestamp: new Date().toISOString(), event, actor: "operaiq" });
  };

  try {
    await updateIncidentStatus(parsed.incidentId, "in_progress");
    await emit(
      sink,
      parsed.incidentId,
      "ASSESS",
      `Parsed ${parsed.alert.severity} alert for ${parsed.alert.affectedServices.join(", ")} with ${parsed.alert.symptoms.length} symptoms.`,
      { alert: parsed.alert }
    );
    addTimeline(`Assessed alert: ${parsed.alert.title}`);

    toolsCalled.push("search_similar_incidents");
    const similarIncidents = await searchSimilarIncidents({ symptoms: parsed.alert.symptoms, limit: 5 });
    await emit(
      sink,
      parsed.incidentId,
      "REMEMBER",
      `Searched past incidents and found ${similarIncidents.length} similar matches${similarIncidents[0] ? `; top score ${Math.round(similarIncidents[0].similarity * 100)}%.` : "."}`,
      { similarIncidents }
    );
    addTimeline(`Found ${similarIncidents.length} similar historical incidents`);

    const serviceName = parsed.alert.affectedServices[0];
    toolsCalled.push("get_service_dependency_graph");
    const graph = await getServiceDependencyGraph({ serviceName });
    await emit(
      sink,
      parsed.incidentId,
      "MAP",
      graph
        ? `${serviceName} has ${graph.dependencies.length} direct dependencies and ${graph.dependents.length} direct dependents.`
        : `${serviceName} was not found in the service graph.`,
      graph ? { graph } : undefined
    );
    addTimeline(`Mapped dependency graph for ${serviceName}`);

    toolsCalled.push("get_runbook");
    const runbook = await getRunbook({
      incidentDescription: `${parsed.alert.title}\n${parsed.alert.symptoms.join("\n")}`,
      affectedServices: parsed.alert.affectedServices
    });
    await emit(
      sink,
      parsed.incidentId,
      "RETRIEVE",
      runbook
        ? `Selected runbook "${runbook.title}" with ${runbook.steps.length} steps${runbook.generated ? " and saved it for future incidents." : "."}`
        : "No runbook was available.",
      runbook ? { runbook } : undefined
    );
    addTimeline(runbook ? `Selected runbook ${runbook.title}` : "No runbook selected");

    const remediationResults: unknown[] = [];
    if (runbook) {
      const executableSteps = runbook.steps
        .filter((step) => step.isExecutable)
        .sort((left, right) => left.order - right.order);
      for (const step of executableSteps) {
        const action = actionFromCommand(step.command);
        if (!action) continue;
        toolsCalled.push("execute_remediation");
        await emit(sink, parsed.incidentId, "ACT", `Executing ${action} on ${serviceName} with ${step.riskLevel} risk.`, { step });
        const result = await executeRemediation({
          action,
          targetService: serviceName,
          parameters: {
            riskLevel: step.riskLevel,
            severity: parsed.alert.severity,
            symptoms: parsed.alert.symptoms.join(", "),
            reasoning: similarIncidents[0]
              ? `Likely related to ${similarIncidents[0].title} at ${Math.round(similarIncidents[0].similarity * 100)} percent similarity.`
              : "No high-confidence prior incident was available.",
            incidentId: parsed.incidentId
          }
        });
        remediationResults.push(result);
        addTimeline(`Executed ${action}: ${result.output}`);
        await emit(
          sink,
          parsed.incidentId,
          "ACT",
          result.requiresHumanApproval
            ? `${action} requires human approval; OperaIQ notified the service owners and stopped automatic action.`
            : `${action} completed with success=${result.success}.`,
          { result }
        );
        if (result.requiresHumanApproval) {
          return { incidentId: parsed.incidentId, toolsCalled, status: "requires_human_approval" };
        }
        await waitAfterRemediation();
        await emit(sink, parsed.incidentId, "ACT", `Assessment after ${action}: proceeding based on successful tool result.`, { result });
        if (result.success) break;
      }
    }

    const conclusion = await generateIncidentConclusion({
      alertTitle: parsed.alert.title,
      symptoms: parsed.alert.symptoms,
      similarIncidents,
      dependencyGraph: graph,
      remediationResults
    });
    toolsCalled.push("write_postmortem");
    const postmortem = await writePostmortem({
      incidentId: parsed.incidentId,
      timeline,
      rootCause: conclusion.rootCause,
      remediationTaken: remediationResults.map((result) => JSON.stringify(result)),
      lessonLearned: conclusion.lessonLearned
    });
    await emit(sink, parsed.incidentId, "CLOSE", `Wrote post-mortem ${postmortem.postmortemId} and refreshed incident memory embedding.`, {
      postmortem
    });
    return { incidentId: parsed.incidentId, toolsCalled, status: "resolved" };
  } catch (error: unknown) {
    invocationFailed("run_incident_agent", error);
    await emit(
      sink,
      parsed.incidentId,
      "ERROR",
      error instanceof Error ? error.message : "Unknown agent failure",
      {}
    );
    return { incidentId: parsed.incidentId, toolsCalled, status: "failed" };
  }
}
