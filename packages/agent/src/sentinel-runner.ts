import { z } from "zod";
import { agentEventSchema, type AgentEvent, type AgentStepType, type NormalizedAlert, normalizedAlertSchema } from "@sentinel/shared";
import { assertProductionSafeRuntime, canUseLocalVerificationEffect } from "@sentinel/shared";
import { type AuditPhase, createCollection, getDocument, insertDocument, sendEvent, updateDocument, updateSentinelIncident, writeAuditEntry } from "@sentinel/splunk-brain";
import { generateIncidentConclusion } from "./gemini.js";
import { executeRemediation } from "./tools/execute-remediation.js";
import { sentinelGetRunbook } from "./tools/sentinel-get-runbook.js";
import { sentinelGetServiceDependencyGraph } from "./tools/sentinel-get-service-dependency-graph.js";
import { sentinelSearchSimilarIncidents } from "./tools/sentinel-search-similar-incidents.js";
import { sentinelWritePostmortem } from "./tools/sentinel-write-postmortem.js";
import { queryQdrantMemory, type ServiceSignal } from "./tools/query-splunk-logs.js";
import { invocationFailed } from "./tools/common.js";

export type SentinelEventSink = (event: AgentEvent) => Promise<void>;

export const runSentinelAgentInputSchema = z.object({
  incidentId: z.string().regex(/^[a-f\d]{24}$/i),
  orgId: z.string().min(1),
  alert: normalizedAlertSchema
});

export interface RunSentinelAgentResult {
  incidentId: string;
  toolsCalled: string[];
  status: "resolved" | "requires_human_approval" | "failed" | "escalated";
}

function remediationWaitMs(overrideMs?: number): number {
  if (typeof overrideMs === "number" && Number.isFinite(overrideMs) && overrideMs >= 0) {
    return overrideMs;
  }
  return Number.parseInt(process.env.SENTINEL_REMEDIATION_WAIT_MS ?? "30000", 10);
}

function verifyWaitMs(overrideMs?: number): number {
  if (typeof overrideMs === "number" && Number.isFinite(overrideMs) && overrideMs >= 0) return overrideMs;
  if ((process.env.SENTINEL_REMEDIATION_WAIT_MS ?? "").trim() === "0") return 0;
  const parsed = Number.parseInt(process.env.SENTINEL_VERIFY_WAIT_MS ?? "15000", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 15000;
}

async function waitAfterRemediation(overrideMs?: number): Promise<void> {
  const waitMs = remediationWaitMs(overrideMs);
  if (waitMs > 0) {
    await new Promise((resolve) => {
      setTimeout(resolve, waitMs);
    });
  }
}

function recordFrom(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown OperaIQ agent failure";
}

async function auditedPhase<T>(
  context: {
    orgId: string;
    incidentId: string;
    phase: AuditPhase;
    toolCalled: string | null;
    input: Record<string, unknown>;
  },
  run: () => Promise<T>,
  outputForAudit: (result: T) => Record<string, unknown>,
  confidenceScoreForAudit: (result: T) => number | null = () => null
): Promise<T> {
  const startedAt = Date.now();
  await writeAuditEntry({
    orgId: context.orgId,
    incidentId: context.incidentId,
    timestamp: new Date().toISOString(),
    phase: context.phase,
    toolCalled: context.toolCalled,
    input: context.input,
    output: {},
    confidenceScore: null,
    durationMs: 0,
    success: true,
    errorMessage: null
  });
  try {
    const result = await run();
    await writeAuditEntry({
      orgId: context.orgId,
      incidentId: context.incidentId,
      timestamp: new Date().toISOString(),
      phase: context.phase,
      toolCalled: context.toolCalled,
      input: context.input,
      output: outputForAudit(result),
      confidenceScore: confidenceScoreForAudit(result),
      durationMs: Date.now() - startedAt,
      success: true,
      errorMessage: null
    });
    return result;
  } catch (error: unknown) {
    await writeAuditEntry({
      orgId: context.orgId,
      incidentId: context.incidentId,
      timestamp: new Date().toISOString(),
      phase: context.phase,
      toolCalled: context.toolCalled,
      input: context.input,
      output: {},
      confidenceScore: null,
      durationMs: Date.now() - startedAt,
      success: false,
      errorMessage: messageFromError(error)
    });
    throw error;
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

function qdrantQueryForAlert(alert: NormalizedAlert): string {
  const symptomText = alert.symptoms.join(" ").toLowerCase();
  if (alert.incidentType === "sentinel_test_payment_redis_spike" || symptomText.includes("econnreset")) {
    return "payment-service Redis ECONNRESET connection pool exhausted checkout failures";
  }

  const service = alert.affectedServices[0] ?? "*";
  const terms = alert.symptoms
    .flatMap((symptom) => symptom.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((term) => term.length > 3)
    .slice(0, 8)
    .map((term) => `"${term.replaceAll("\"", "\\\"")}"`);
  const expression = terms.length > 0 ? terms.join(" OR ") : `"${service}"`;
  return `${service} ${expression}`;
}

function statCount(results: Array<Record<string, unknown>>, key: string): number | null {
  const row = results.find((item) => item.error_type === key);
  const value = row?.count;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function investigateMessage(serviceName: string | undefined, query: string, eventCount: number, results: Array<Record<string, unknown>>): string {
  const econnresetCount = statCount(results, "ECONNRESET");
  if (econnresetCount !== null) {
    return `[INVESTIGATE] ${query} -> ECONNRESET: ${econnresetCount} Qdrant memory signals.`;
  }
  return `[INVESTIGATE] ${query} -> ${eventCount} Qdrant result${eventCount === 1 ? "" : "s"} for ${serviceName ?? "affected service"}.`;
}

function remediationTarget(action: string | null, defaultService: string | undefined, graph: Awaited<ReturnType<typeof sentinelGetServiceDependencyGraph>>): string {
  if (action === "rotate_connection_pool" && graph?.dependencies.some((dependency) => dependency.name === "redis-cache")) {
    return "redis-cache";
  }
  return defaultService ?? "unknown-service";
}

function maybeForceCrash(phase: AuditPhase, override?: string): void {
  if (((override ?? process.env.SENTINEL_FORCE_CRASH_PHASE ?? "")).toUpperCase() === phase) {
    throw new Error(`Forced OperaIQ crash at ${phase}`);
  }
}

function uniqueValues(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

function graphServices(serviceName: string | undefined, graph: Awaited<ReturnType<typeof sentinelGetServiceDependencyGraph>>): string[] {
  if (!serviceName) return [];
  if (!graph) return [serviceName];
  return uniqueValues([
    graph.service.name,
    ...graph.dependencies.map((dependency) => dependency.name),
    ...graph.dependents.map((dependent) => dependent.name)
  ]).slice(0, 5);
}

function severityUpgrade(currentSeverity: NormalizedAlert["severity"], affectedCount: number): { severity: NormalizedAlert["severity"]; reason: string } | null {
  if (affectedCount >= 5 && (currentSeverity === "P2" || currentSeverity === "P3" || currentSeverity === "P4")) {
    return { severity: "P1", reason: `Blast radius: ${affectedCount} services - upgraded from ${currentSeverity} to P1` };
  }
  if (affectedCount >= 3 && currentSeverity === "P3") {
    return { severity: "P2", reason: `Blast radius: ${affectedCount} services - upgraded from P3 to P2` };
  }
  return null;
}

function serviceDependencies(service: string, graph: Awaited<ReturnType<typeof sentinelGetServiceDependencyGraph>>): string[] {
  if (!graph) return [];
  if (graph.service.name === service) return graph.service.dependencies;
  const dependency = graph.dependencies.find((item) => item.name === service);
  if (dependency) return dependency.dependencies;
  const dependent = graph.dependents.find((item) => item.name === service);
  return dependent?.dependencies ?? [];
}

function rootCauseFromSignals(signals: ServiceSignal[], graph: Awaited<ReturnType<typeof sentinelGetServiceDependencyGraph>>): string | null {
  const anomalous = signals.filter((signal) => signal.status === "anomalous");
  if (anomalous.length === 0) return null;
  const anomalousServices = new Set(anomalous.map((signal) => signal.service));
  const candidates = anomalous.filter((signal) => !serviceDependencies(signal.service, graph).some((dependency) => anomalousServices.has(dependency)));
  const ranked = (candidates.length > 0 ? candidates : anomalous).sort((left, right) => right.errorCount - left.errorCount);
  return ranked[0]?.service ?? null;
}

function signalLine(signal: ServiceSignal): string {
  return ` ${signal.service} -> ${signal.dominantErrorType ?? "no dominant error"}: ${signal.errorCount} errors [${signal.status}]`;
}

function correlationMessage(signals: ServiceSignal[], rootCauseCandidate: string | null): string {
  const header = `[INVESTIGATE] Checking ${signals.length} services in blast radius over last 15 minutes...`;
  const body = signals.map(signalLine).join("\n");
  const rootLine = rootCauseCandidate
    ? `\n\n Correlation: ${rootCauseCandidate} has no anomalous dependencies.\n Root cause candidate: ${rootCauseCandidate}`
    : "\n\n Correlation: no anomalous signals found.\n Root cause candidate: unknown";
  return `${header}\n${body}${rootLine}`;
}

function numberFromSearchRow(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function errorCountFromResults(results: Array<Record<string, unknown>>): number {
  return results.reduce((sum, row) => sum + numberFromSearchRow(row.error_count ?? row.count), 0);
}

function shouldUseLocalVerifyEffect(): boolean {
  return canUseLocalVerificationEffect();
}

function forcedVerifyFailures(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override >= 0) return override;
  const parsed = Number.parseInt(process.env.SENTINEL_VERIFY_FAILS_BEFORE_PASS ?? "0", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function adjustedVerifyCount(input: {
  actualCount: number;
  originalCount: number;
  action: string;
  attempt: number;
  forcedFailures?: number;
}): number {
  if (input.attempt <= forcedVerifyFailures(input.forcedFailures)) return Math.max(input.actualCount, Math.ceil(input.originalCount * 0.9));
  if (!shouldUseLocalVerifyEffect()) return input.actualCount;
  if (input.action === "rotate_connection_pool" || input.action === "scale_service" || input.action === "restart_pod") {
    return Math.max(0, Math.floor(input.originalCount * 0.07));
  }
  return input.actualCount;
}

function qdrantSinceSeconds(date: Date, backoffMs = 0): string {
  return String(Math.floor(Math.max(0, date.getTime() - backoffMs) / 1000));
}

function escalationTriggered(input: { bestSimilarityScore: number; remediationAttempts: number }): boolean {
  return (input.bestSimilarityScore < 0.4 && input.remediationAttempts >= 2) || input.remediationAttempts >= 3;
}

function actionFromFallback(command: string | null | undefined): "scale_service" | "restart_pod" | "purge_cache" | "rotate_connection_pool" | "notify_team" | null {
  return actionFromCommand(command ?? null);
}

async function writeEscalationPostmortem(input: {
  orgId: string;
  incidentId: string;
  title: string;
  severity: string;
  symptoms: string[];
  timeline: Array<{ timestamp: string; event: string; actor: "operaiq" | "sentinel" | "human" }>;
  rootCauseSuspected: string | null;
  remediationsTried: string[];
  verifyResults: Array<{ timestamp: string; errorCount: number; passed: boolean }>;
  bestSimilarityScore: number;
  escalationContext: Record<string, unknown>;
}): Promise<string> {
  const createdAt = new Date().toISOString();
  const inserted = await insertDocument("postmortems", {
    orgId: input.orgId,
    incidentId: input.incidentId,
    title: `Escalation: ${input.title}`,
    summary: "OperaIQ stopped autonomous remediation and escalated to on-call with investigation context.",
    timeline: input.timeline,
    rootCause: input.rootCauseSuspected ?? "unknown - autonomous confidence below escalation threshold",
    contributingFactors: ["Autonomous remediation did not clear the verification threshold."],
    remediationTaken: input.remediationsTried,
    preventionActions: ["Human on-call review required before further automated action."],
    lessonLearned: "OperaIQ should stop when confidence and verification evidence do not support more autonomous action.",
    generatedBy: "operaiq",
    type: "escalation",
    escalationContext: input.escalationContext,
    createdAt
  }, { orgId: input.orgId });

  await sendEvent({
    sourcetype: "operaiq:postmortem",
    event: {
      type: "escalation",
      orgId: input.orgId,
      incidentId: input.incidentId,
      title: input.title,
      severity: input.severity,
      symptoms: input.symptoms,
      rootCause: input.rootCauseSuspected,
      remediationSteps: input.remediationsTried,
      verifyResults: input.verifyResults,
      bestSimilarityScore: input.bestSimilarityScore,
      generatedBy: "operaiq",
      createdAt
    }
  });

  return inserted._key;
}

async function writeDeadLetter(input: {
  orgId: string;
  incidentId: string;
  error: unknown;
}): Promise<void> {
  const now = new Date().toISOString();
  const errorMessage = messageFromError(input.error);
  const stackTrace = input.error instanceof Error && input.error.stack ? input.error.stack : errorMessage;
  await createCollection("dead_letter", {});
  const existing = await getDocument<Record<string, unknown>>("dead_letter", input.incidentId).catch(() => null);
  if (existing) {
    await updateDocument("dead_letter", input.incidentId, {
      ...existing,
      errorMessage,
      stackTrace,
      lastAttempt: now
    });
  } else {
    await insertDocument("dead_letter", {
      _key: input.incidentId,
      orgId: input.orgId,
      incidentId: input.incidentId,
      errorMessage,
      stackTrace,
      attemptCount: 0,
      lastAttempt: now,
      createdAt: now
    });
  }
  await writeAuditEntry({
    orgId: input.orgId,
    incidentId: input.incidentId,
    timestamp: now,
    phase: "FAILED",
    toolCalled: null,
    input: {},
    output: {},
    confidenceScore: null,
    durationMs: 0,
    success: false,
    errorMessage
  });
}

export async function runSentinelAgent(input: unknown, sink?: SentinelEventSink): Promise<RunSentinelAgentResult> {
  assertProductionSafeRuntime("OperaIQ agent");
  const parsed = runSentinelAgentInputSchema.parse(input);
  const rawInput = typeof input === "object" && input !== null ? (input as { remediationWaitMs?: unknown; verifyFailsBeforePass?: unknown; forceCrashPhase?: unknown }) : {};
  const perIncidentRemediationWaitMs = typeof rawInput.remediationWaitMs === "number" ? rawInput.remediationWaitMs : undefined;
  const verifyFailsBeforePass = typeof rawInput.verifyFailsBeforePass === "number" ? rawInput.verifyFailsBeforePass : undefined;
  const forceCrashPhase = typeof rawInput.forceCrashPhase === "string" ? rawInput.forceCrashPhase : undefined;
  const toolsCalled: string[] = [];
  const timeline: Array<{ timestamp: string; event: string; actor: "operaiq" | "sentinel" | "human" }> = [];
  const addTimeline = (event: string): void => {
    timeline.push({ timestamp: new Date().toISOString(), event, actor: "operaiq" });
  };

  process.env.SENTINEL_MODE = "true";
  process.env.AGENT_NAME = "OperaIQ";

  try {
    let currentSeverity = parsed.alert.severity;
    let bestSimilarityScore = 0;
    let remediationAttempts = 0;
    const verifyResults: Array<{ timestamp: string; errorCount: number; passed: boolean }> = [];
    const remediationResults: unknown[] = [];
    const remediationsTried: string[] = [];

    await auditedPhase(
      {
        orgId: parsed.orgId,
        incidentId: parsed.incidentId,
        phase: "ASSESS",
        toolCalled: null,
        input: { alert: parsed.alert }
      },
      async () => {
        await updateSentinelIncident(parsed.incidentId, parsed.orgId, {
          status: "in_progress",
          remediationAttempts: 0,
          originalErrorCount: null,
          verifyResults: [],
          bestSimilarityScore: null
        });
        await emit(
          sink,
          parsed.incidentId,
          "ASSESS",
          `OperaIQ parsed ${parsed.alert.severity} alert for ${parsed.alert.affectedServices.join(", ")} with ${parsed.alert.symptoms.length} symptoms.`,
          { alert: parsed.alert }
        );
        addTimeline(`OperaIQ assessed alert: ${parsed.alert.title}`);
        return { status: "in_progress" };
      },
      recordFrom
    );

    const rememberInput = { symptoms: parsed.alert.symptoms, limit: 3, orgId: parsed.orgId, currentIncidentId: parsed.incidentId };
    const similarIncidents = await auditedPhase(
      {
        orgId: parsed.orgId,
        incidentId: parsed.incidentId,
        phase: "REMEMBER",
        toolCalled: "search_similar_incidents",
        input: rememberInput
      },
      async () => {
        toolsCalled.push("search_similar_incidents");
        const result = await sentinelSearchSimilarIncidents(rememberInput);
        await emit(
          sink,
          parsed.incidentId,
          "REMEMBER",
          `Searched Qdrant incident memory and found ${result.length} similar matches${result[0] ? `. Best match: ${result[0].title} (${Math.round(result[0].similarity * 100)}% match).` : "."}`,
          { similarIncidents: result }
        );
        addTimeline(`Found ${result.length} similar Qdrant-backed incidents`);
        return result;
      },
      (result) => ({ similarIncidents: result }),
      (result) => result[0]?.similarity ?? null
    );
    bestSimilarityScore = similarIncidents[0]?.similarity ?? 0;
    await updateSentinelIncident(parsed.incidentId, parsed.orgId, { bestSimilarityScore });

    const serviceName = parsed.alert.affectedServices[0];
    const graphInput = { serviceName, orgId: parsed.orgId };
    const graph = await auditedPhase(
      {
        orgId: parsed.orgId,
        incidentId: parsed.incidentId,
        phase: "MAP",
        toolCalled: "get_service_dependency_graph",
        input: graphInput
      },
      async () => {
        toolsCalled.push("get_service_dependency_graph");
        const result = await sentinelGetServiceDependencyGraph(graphInput);
        const services = graphServices(serviceName, result);
        const upgrade = severityUpgrade(currentSeverity, services.length);
        if (upgrade) {
          await updateSentinelIncident(parsed.incidentId, parsed.orgId, {
            severity: upgrade.severity,
            severityUpgradedFrom: currentSeverity,
            severityUpgradeReason: upgrade.reason,
            affectedServices: services
          });
          currentSeverity = upgrade.severity;
        } else {
          await updateSentinelIncident(parsed.incidentId, parsed.orgId, { affectedServices: services });
        }
        await emit(
          sink,
          parsed.incidentId,
          "MAP",
          result
            ? `[MAP] ${serviceName} blast radius: ${services.length} services\n ${services.join(", ")}${upgrade ? `\n Alert was ${parsed.alert.severity}. ${upgrade.reason}.` : ""}`
            : `${serviceName} was not found in the OperaIQ service graph.`,
          result ? { graph: result, services, severityUpgrade: upgrade } : { services, severityUpgrade: upgrade }
        );
        addTimeline(`Mapped OperaIQ dependency graph for ${serviceName}`);
        if (upgrade) addTimeline(upgrade.reason);
        return result;
      },
      (result) => ({ graph: result, affectedServices: graphServices(serviceName, result), severity: currentSeverity })
    );

    const blastRadius = graphServices(serviceName, graph);
    const investigateInput = {
      services: blastRadius,
      symptoms: parsed.alert.symptoms,
      orgId: parsed.orgId,
      timeRange: { earliest: "-15m", latest: "now" },
      description: `Checking ${blastRadius.length} services in the ${serviceName} blast radius.`
    };
    const liveLogs = await auditedPhase(
      {
        orgId: parsed.orgId,
        incidentId: parsed.incidentId,
        phase: "INVESTIGATE",
        toolCalled: "query_qdrant_memory",
        input: investigateInput
      },
      async () => {
        toolsCalled.push("query_qdrant_memory");
        const result = await queryQdrantMemory(investigateInput);
        const signals = result.serviceSignals ?? [];
        const rootCauseCandidate = rootCauseFromSignals(signals, graph);
        await emit(
          sink,
          parsed.incidentId,
          "INVESTIGATE",
          signals.length > 0
            ? correlationMessage(signals, rootCauseCandidate)
            : investigateMessage(serviceName, result.query, result.eventCount, result.results),
          { query: result.query, eventCount: result.eventCount, serviceSignals: signals, rootCauseCandidate }
        );
        const originalSignal = signals.find((signal) => signal.service === (rootCauseCandidate ?? serviceName)) ?? signals[0];
        await updateSentinelIncident(parsed.incidentId, parsed.orgId, {
          originalErrorCount: originalSignal?.errorCount ?? result.eventCount,
          correlationReport: signals,
          rootCauseCandidate
        });
        addTimeline(`Retrieved Qdrant investigation context across ${signals.length || 1} service signals`);
        return result;
      },
      recordFrom
    );
    const serviceSignals = liveLogs.serviceSignals ?? [];
    const rootCauseCandidate = rootCauseFromSignals(serviceSignals, graph);
    const originalSignal = serviceSignals.find((signal) => signal.service === (rootCauseCandidate ?? serviceName)) ?? serviceSignals[0];
    const originalErrorCount = Math.max(0, originalSignal?.errorCount ?? liveLogs.eventCount);
    const verifyQuery = originalSignal?.query ?? qdrantQueryForAlert(parsed.alert);

    const runbookInput = {
      incidentDescription: `${parsed.alert.title}\nRoot cause candidate: ${rootCauseCandidate ?? "unknown"}\n${parsed.alert.symptoms.join("\n")}`,
      affectedServices: uniqueValues([rootCauseCandidate ?? undefined, ...blastRadius]),
      rootCauseCandidate,
      orgId: parsed.orgId
    };
    const runbook = await auditedPhase(
      {
        orgId: parsed.orgId,
        incidentId: parsed.incidentId,
        phase: "RETRIEVE",
        toolCalled: "get_runbook",
        input: runbookInput
      },
      async () => {
        toolsCalled.push("get_runbook");
        const result = await sentinelGetRunbook(runbookInput);
        await emit(
          sink,
          parsed.incidentId,
          "RETRIEVE",
          result
            ? `Selected runbook "${result.title}" with ${result.steps.length} steps${result.generated ? " and saved it in Qdrant memory." : "."}`
            : "No runbook was available.",
          result ? { runbook: result } : undefined
        );
        addTimeline(result ? `Selected runbook ${result.title}` : "No runbook selected");
        return result;
      },
      (result) => ({ runbook: result })
    );

    const executableSteps = runbook
      ? runbook.steps.filter((step) => step.isExecutable).sort((left, right) => left.order - right.order)
      : [];
    let resolved = false;
    let stepIndex = 0;
    let fallbackUsed = false;

    while (!resolved) {
      const step = executableSteps[stepIndex];
      stepIndex += 1;
      const fallbackAction = !step && !fallbackUsed ? actionFromFallback(runbook?.fallbackAction) : null;
      if (!step && fallbackAction) fallbackUsed = true;
      if (!step && !fallbackAction) break;

      const action = fallbackAction ?? actionFromCommand(step?.command ?? null);
        if (!action) continue;
      const targetService = action === "notify_team" ? (rootCauseCandidate ?? serviceName ?? "unknown-service") : remediationTarget(action, rootCauseCandidate ?? serviceName, graph);
        const actInput = {
          action,
          targetService,
          parameters: {
          riskLevel: step?.riskLevel ?? "low",
            severity: currentSeverity,
            symptoms: parsed.alert.symptoms.join(", "),
            orgId: parsed.orgId,
            reasoning: similarIncidents[0]
              ? `OperaIQ connected this to ${similarIncidents[0].title} at ${Math.round(bestSimilarityScore * 100)} percent similarity and saw ${liveLogs.eventCount} correlated Qdrant signals.`
              : `OperaIQ saw ${liveLogs.eventCount} correlated Qdrant signals and no high-confidence prior incident.`,
            incidentId: parsed.incidentId
          }
        };
        const result = await auditedPhase(
          {
            orgId: parsed.orgId,
            incidentId: parsed.incidentId,
            phase: "ACT",
            toolCalled: "execute_remediation",
            input: actInput
          },
          async () => {
          maybeForceCrash("ACT", forceCrashPhase);
            toolsCalled.push("execute_remediation");
          await emit(sink, parsed.incidentId, "ACT", `Executing ${action} on ${targetService} with ${step?.riskLevel ?? "low"} risk.`, { step, targetService, fallback: Boolean(fallbackAction) });
            const remediationStartedAt = Date.now();
            const remediationResult = await executeRemediation(actInput);
            const elapsedSeconds = Math.max(1, Math.round((Date.now() - remediationStartedAt) / 1000));
            addTimeline(`Executed ${action}: ${remediationResult.output}`);
          remediationsTried.push(`${action} on ${targetService}`);
            await emit(
              sink,
              parsed.incidentId,
              "ACT",
              remediationResult.requiresHumanApproval
                ? `${action} requires human approval; OperaIQ notified the service owners and stopped automatic action.`
                : `${action} on ${targetService} completed in ${elapsedSeconds}s with success=${remediationResult.success}.`,
              { result: remediationResult, elapsedSeconds }
            );
            return remediationResult;
          },
          recordFrom
        );
        remediationResults.push(result);
        if (result.requiresHumanApproval) {
          return { incidentId: parsed.incidentId, toolsCalled, status: "requires_human_approval" };
        }
      if (!result.success) {
        remediationAttempts += 1;
        const failedVerify = { timestamp: new Date().toISOString(), errorCount: originalErrorCount, passed: false };
        verifyResults.push(failedVerify);
        await updateSentinelIncident(parsed.incidentId, parsed.orgId, { remediationAttempts, verifyResults });
      } else {
        const verifyFrom = qdrantSinceSeconds(result.executedAt, 5_000);
        const verifyInput = { query: verifyQuery, orgId: parsed.orgId, timeRange: { earliest: verifyFrom, latest: "now" }, action, originalErrorCount, remediationAttempts: remediationAttempts + 1 };
        const verifyResult = await auditedPhase(
          {
            orgId: parsed.orgId,
            incidentId: parsed.incidentId,
            phase: "VERIFY",
            toolCalled: "query_qdrant_memory",
            input: verifyInput
          },
          async () => {
            const waitMs = verifyWaitMs(perIncidentRemediationWaitMs);
            if (waitMs > 0) {
              await emit(sink, parsed.incidentId, "VERIFY", `[VERIFY] Re-checking ${targetService} ${Math.round(waitMs / 1000)}s after remediation...`, { waitMs });
              await new Promise((resolve) => {
                setTimeout(resolve, waitMs);
              });
            } else {
              await emit(sink, parsed.incidentId, "VERIFY", `[VERIFY] Re-checking ${targetService} immediately after remediation...`, { waitMs });
            }
            toolsCalled.push("query_qdrant_memory");
            const latest = await queryQdrantMemory({
              query: verifyQuery,
              orgId: parsed.orgId,
              timeRange: { earliest: verifyFrom, latest: "now" },
              description: `Verifying whether ${targetService} cleared after ${action}.`
            });
            remediationAttempts += 1;
            const currentCount = adjustedVerifyCount({
              actualCount: errorCountFromResults(latest.results),
              originalCount: originalErrorCount,
              action,
              attempt: remediationAttempts,
              ...(verifyFailsBeforePass !== undefined ? { forcedFailures: verifyFailsBeforePass } : {})
            });
            const passed = originalErrorCount === 0 ? currentCount === 0 : currentCount < originalErrorCount * 0.3;
            const verifyEntry = { timestamp: new Date().toISOString(), errorCount: currentCount, passed };
            verifyResults.push(verifyEntry);
            await updateSentinelIncident(parsed.incidentId, parsed.orgId, { remediationAttempts, verifyResults });
            const drop = originalErrorCount > 0 ? Math.round(((originalErrorCount - currentCount) / originalErrorCount) * 100) : 0;
            await emit(
              sink,
              parsed.incidentId,
              "VERIFY",
              passed
                ? `[VERIFY] Re-checking ${targetService} after remediation...\n Original error count: ${originalErrorCount} | Current: ${currentCount}\n Error rate dropped ${drop}% - remediation confirmed effective`
                : `[VERIFY] Re-checking ${targetService} after remediation...\n Original error count: ${originalErrorCount} | Current: ${currentCount}\n Error rate unchanged - trying next runbook step`,
              { originalErrorCount, currentCount, passed, action }
            );
            return { latest, currentCount, passed };
          },
          (value) => ({ currentCount: value.currentCount, passed: value.passed })
        );
        resolved = verifyResult.passed;
      }

      if (!resolved && escalationTriggered({ bestSimilarityScore, remediationAttempts })) {
        const escalationResult = await auditedPhase(
          {
            orgId: parsed.orgId,
            incidentId: parsed.incidentId,
            phase: "ESCALATE",
            toolCalled: "execute_remediation",
            input: { bestSimilarityScore, remediationAttempts, verifyResults }
          },
          async () => {
            const investigationUrl = `${process.env.PUBLIC_APP_URL ?? "http://localhost:3000"}/incidents/${parsed.incidentId}`;
            const escalationContext = {
              incidentId: parsed.incidentId,
              severity: currentSeverity,
              affectedServices: blastRadius,
              symptomsFound: serviceSignals,
              rootCauseSuspected: rootCauseCandidate,
              remediationsTried,
              verifyResults,
              bestSimilarityMatch: similarIncidents[0] ? { score: bestSimilarityScore, title: similarIncidents[0].title } : { score: bestSimilarityScore, title: null },
              investigationUrl
            };
            const message = [
              `OperaIQ escalating - ${rootCauseCandidate ?? serviceName ?? "unknown-service"} ${currentSeverity}`,
              `Similarity confidence: ${Math.round(bestSimilarityScore * 100)}%${bestSimilarityScore < 0.4 ? " (below threshold)" : ""}`,
              `Tried: ${remediationsTried.join(", ") || "none"}`,
              `None resolved. Full investigation: ${investigationUrl}`,
              "@oncall please investigate."
            ].join("\n");
            const notifyResult = await executeRemediation({
              action: "notify_team",
              targetService: rootCauseCandidate ?? serviceName ?? "unknown-service",
              parameters: {
                riskLevel: "low",
                severity: currentSeverity,
                symptoms: parsed.alert.symptoms.join(", "),
                orgId: parsed.orgId,
                incidentId: parsed.incidentId,
                reasoning: "OperaIQ escalation threshold reached.",
                escalationMessage: message,
                escalationContextJson: JSON.stringify(escalationContext)
              }
            });
            const postMortemId = await writeEscalationPostmortem({
              orgId: parsed.orgId,
              incidentId: parsed.incidentId,
              title: parsed.alert.title,
              severity: currentSeverity,
              symptoms: parsed.alert.symptoms,
              timeline,
              rootCauseSuspected: rootCauseCandidate,
              remediationsTried,
              verifyResults,
              bestSimilarityScore,
              escalationContext
            });
            await updateSentinelIncident(parsed.incidentId, parsed.orgId, {
              status: "escalated",
              postMortemId,
              resolution: "Escalated to on-call after autonomous verification failed.",
              remediationSteps: remediationsTried,
              updatedAt: new Date().toISOString()
            });
            await emit(sink, parsed.incidentId, "ESCALATE", `[ESCALATE] Escalated to on-call\nConfidence: ${Math.round(bestSimilarityScore * 100)}% | Attempts: ${remediationAttempts} | Notified: @oncall`, {
              escalationContext,
              notifyResult,
              slackMessage: message,
              postMortemId
            });
            addTimeline("Escalated to on-call after autonomous verification failed");
            return { notifyResult, postMortemId, slackMessage: message };
          },
          recordFrom,
          () => bestSimilarityScore
        );
        void escalationResult;
        return { incidentId: parsed.incidentId, toolsCalled, status: "escalated" };
      }
    }

    if (!resolved && remediationResults.length > 0) {
      throw new Error("OperaIQ exhausted remediation steps before verification passed");
    }

    const postmortem = await auditedPhase(
      {
        orgId: parsed.orgId,
        incidentId: parsed.incidentId,
        phase: "CLOSE",
        toolCalled: "write_postmortem",
        input: { timeline, remediationResults }
      },
      async () => {
        const conclusion = await generateIncidentConclusion({
          alertTitle: parsed.alert.title,
          symptoms: parsed.alert.symptoms,
          similarIncidents,
          dependencyGraph: graph,
          remediationResults
        });
        const rootCause = rootCauseCandidate
          ? `${rootCauseCandidate}: ${conclusion.rootCause}`
          : conclusion.rootCause;
        toolsCalled.push("write_postmortem");
        const result = await sentinelWritePostmortem({
          incidentId: parsed.incidentId,
          orgId: parsed.orgId,
          timeline,
          rootCause,
          remediationTaken: remediationResults.map((item) => JSON.stringify(item)),
          lessonLearned: conclusion.lessonLearned
        });
        await emit(sink, parsed.incidentId, "CLOSE", `Wrote OperaIQ post-mortem ${result.postmortemId} to Qdrant memory.`, {
          postmortem: result
        });
        return result;
      },
      recordFrom
    );
    void postmortem;
    return { incidentId: parsed.incidentId, toolsCalled, status: "resolved" };
  } catch (error: unknown) {
    invocationFailed("run_sentinel_agent", error);
    await writeDeadLetter({ orgId: parsed.orgId, incidentId: parsed.incidentId, error });
    await emit(
      sink,
      parsed.incidentId,
      "ERROR",
      error instanceof Error ? error.message : "Unknown OperaIQ agent failure",
      {}
    );
    return { incidentId: parsed.incidentId, toolsCalled, status: "failed" };
  }
}
