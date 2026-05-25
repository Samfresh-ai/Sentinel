import { z } from "zod";
import { agentEventSchema, type AgentEvent, type AgentStepType, type NormalizedAlert, normalizedAlertSchema } from "@operaiq/shared";
import { updateSentinelIncident } from "@operaiq/splunk-brain";
import { generateIncidentConclusion } from "./gemini.js";
import { executeRemediation } from "./tools/execute-remediation.js";
import { sentinelGetRunbook } from "./tools/sentinel-get-runbook.js";
import { sentinelGetServiceDependencyGraph } from "./tools/sentinel-get-service-dependency-graph.js";
import { sentinelSearchSimilarIncidents } from "./tools/sentinel-search-similar-incidents.js";
import { sentinelWritePostmortem } from "./tools/sentinel-write-postmortem.js";
import { querySplunkLogs } from "./tools/query-splunk-logs.js";
import { invocationFailed } from "./tools/common.js";

export type SentinelEventSink = (event: AgentEvent) => Promise<void>;

export const runSentinelAgentInputSchema = z.object({
  incidentId: z.string().regex(/^[a-f\d]{24}$/i),
  alert: normalizedAlertSchema
});

export interface RunSentinelAgentResult {
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

async function emit(sink: SentinelEventSink | undefined, incidentId: string, stepType: AgentStepType, message: string, payload?: Record<string, unknown>): Promise<void> {
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

function splunkSearchForAlert(alert: NormalizedAlert): string {
  const service = alert.affectedServices[0] ?? "*";
  const terms = alert.symptoms
    .flatMap((symptom) => symptom.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((term) => term.length > 3)
    .slice(0, 8)
    .map((term) => `"${term.replaceAll("\"", "\\\"")}"`);
  const expression = terms.length > 0 ? terms.join(" OR ") : `"${service}"`;
  return `search index=sentinel (${expression} OR service=${service}) | head 25`;
}

export async function runSentinelAgent(input: unknown, sink?: SentinelEventSink): Promise<RunSentinelAgentResult> {
  const parsed = runSentinelAgentInputSchema.parse(input);
  const toolsCalled: string[] = [];
  const timeline: Array<{ timestamp: string; event: string; actor: "operaiq" | "human" }> = [];
  const addTimeline = (event: string): void => {
    timeline.push({ timestamp: new Date().toISOString(), event, actor: "operaiq" });
  };

  process.env.SENTINEL_MODE = "true";
  process.env.AGENT_NAME = "Sentinel";

  try {
    await updateSentinelIncident(parsed.incidentId, { status: "in_progress" });
    await emit(
      sink,
      parsed.incidentId,
      "ASSESS",
      `Sentinel parsed ${parsed.alert.severity} alert for ${parsed.alert.affectedServices.join(", ")} with ${parsed.alert.symptoms.length} symptoms.`,
      { alert: parsed.alert }
    );
    addTimeline(`Sentinel assessed alert: ${parsed.alert.title}`);

    toolsCalled.push("search_similar_incidents");
    const similarIncidents = await sentinelSearchSimilarIncidents({ symptoms: parsed.alert.symptoms, limit: 5 });
    await emit(
      sink,
      parsed.incidentId,
      "REMEMBER",
      `Searched Splunk incident memory and found ${similarIncidents.length} similar matches${similarIncidents[0] ? `; top score ${Math.round(similarIncidents[0].similarity * 100)}%.` : "."}`,
      { similarIncidents }
    );
    addTimeline(`Found ${similarIncidents.length} similar Splunk-backed incidents`);

    toolsCalled.push("query_splunk_logs");
    const spl = splunkSearchForAlert(parsed.alert);
    const liveLogs = await querySplunkLogs({
      spl,
      timeRange: { earliest: "-30m", latest: "now" },
      description: `Investigating current ${parsed.alert.affectedServices[0]} symptoms in the last 30 minutes.`
    });
    await emit(
      sink,
      parsed.incidentId,
      "INVESTIGATE",
      `[INVESTIGATE] Ran live SPL search for ${parsed.alert.affectedServices[0]} and found ${liveLogs.eventCount} events.`,
      { spl: liveLogs.spl, eventCount: liveLogs.eventCount, sample: liveLogs.results.slice(0, 3) }
    );
    addTimeline(`Ran live SPL investigation and found ${liveLogs.eventCount} events`);

    const serviceName = parsed.alert.affectedServices[0];
    toolsCalled.push("get_service_dependency_graph");
    const graph = await sentinelGetServiceDependencyGraph({ serviceName });
    await emit(
      sink,
      parsed.incidentId,
      "MAP",
      graph
        ? `${serviceName} has ${graph.dependencies.length} direct dependencies and ${graph.dependents.length} direct dependents in Splunk KV Store.`
        : `${serviceName} was not found in the Sentinel service graph.`,
      graph ? { graph } : undefined
    );
    addTimeline(`Mapped Sentinel dependency graph for ${serviceName}`);

    toolsCalled.push("get_runbook");
    const runbook = await sentinelGetRunbook({
      incidentDescription: `${parsed.alert.title}\n${parsed.alert.symptoms.join("\n")}`,
      affectedServices: parsed.alert.affectedServices
    });
    await emit(
      sink,
      parsed.incidentId,
      "RETRIEVE",
      runbook
        ? `Selected runbook "${runbook.title}" with ${runbook.steps.length} steps${runbook.generated ? " and saved it in Splunk KV Store." : "."}`
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
              ? `Sentinel connected this to ${similarIncidents[0].title} at ${Math.round(similarIncidents[0].similarity * 100)} percent similarity and saw ${liveLogs.eventCount} live Splunk events.`
              : `Sentinel saw ${liveLogs.eventCount} live Splunk events and no high-confidence prior incident.`,
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
            ? `${action} requires human approval; Sentinel notified the service owners and stopped automatic action.`
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
    const postmortem = await sentinelWritePostmortem({
      incidentId: parsed.incidentId,
      timeline,
      rootCause: conclusion.rootCause,
      remediationTaken: remediationResults.map((result) => JSON.stringify(result)),
      lessonLearned: conclusion.lessonLearned
    });
    await emit(sink, parsed.incidentId, "CLOSE", `Wrote Sentinel post-mortem ${postmortem.postmortemId} to Splunk KV Store and HEC.`, {
      postmortem
    });
    return { incidentId: parsed.incidentId, toolsCalled, status: "resolved" };
  } catch (error: unknown) {
    invocationFailed("run_sentinel_agent", error);
    await emit(
      sink,
      parsed.incidentId,
      "ERROR",
      error instanceof Error ? error.message : "Unknown Sentinel agent failure",
      {}
    );
    return { incidentId: parsed.incidentId, toolsCalled, status: "failed" };
  }
}
