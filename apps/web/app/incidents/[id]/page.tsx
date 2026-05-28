"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { apiUrl, fetchAuditLog, fetchIncident, isUnauthorizedError, type AgentEvent, type AuditEntry, type Incident, type Postmortem } from "@/lib/api";

function severityClass(severity: Incident["severity"]): string {
  if (severity === "P1") return "border-critical bg-critical text-white";
  if (severity === "P2") return "border-warning bg-warning text-background";
  if (severity === "P3") return "border-caution bg-caution text-background";
  return "border-border bg-elevated text-muted";
}

function statusClass(status: Incident["status"]): string {
  if (status === "in_progress") return "badge-in-progress border-active text-active";
  if (status === "resolved") return "border-accent text-accent";
  if (status === "escalated") return "border-warning text-warning";
  if (status === "failed") return "border-critical bg-critical text-white";
  return "border-critical text-critical";
}

function stepLabelClass(step: AgentEvent["stepType"]): string {
  if (step === "INVESTIGATE") return "text-mono";
  if (step === "ACT") return "text-warning";
  if (step === "VERIFY") return "text-active";
  if (step === "ESCALATE") return "text-warning";
  if (step === "CLOSE") return "text-accent";
  if (step === "ERROR") return "text-critical";
  return "text-muted";
}

function stripStepPrefix(event: AgentEvent): string {
  return event.message.replace(new RegExp(`^\\[${event.stepType}\\]\\s*`), "");
}

function eventKey(event: AgentEvent): string {
  return `${event.createdAt}:${event.stepType}:${event.message}`;
}

function timeAgo(value: string): string {
  const diffMs = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.floor(diffMs / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function resolutionSeconds(incident: Incident | null): number | null {
  if (!incident?.resolvedAt) return null;
  const detected = Date.parse(incident.detectedAt);
  const resolved = Date.parse(incident.resolvedAt);
  if (!Number.isFinite(detected) || !Number.isFinite(resolved)) return null;
  return Math.max(1, Math.round((resolved - detected) / 1000));
}

function formatRunbookStep(step: string): string {
  try {
    const parsed = JSON.parse(step) as { action?: unknown; targetService?: unknown; success?: unknown };
    if (typeof parsed.action === "string" && typeof parsed.targetService === "string") {
      return `${parsed.action} on ${parsed.targetService}${parsed.success === true ? " completed" : ""}`;
    }
  } catch {
    return step;
  }
  return step;
}

function formatConfidence(value: number | null): string {
  return typeof value === "number" ? `${Math.round(value * 100)}%` : "--";
}

function formatDuration(value: number): string {
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

function renderStepBody(event: AgentEvent) {
  const body = stripStepPrefix(event);
  if (event.stepType === "INVESTIGATE") {
    const [query, result] = body.split(/\s*->\s*/);
    return (
      <div className="space-y-1">
        <div className="break-words font-mono text-[12px] text-mono">{query}</div>
        {result ? <div className="font-mono text-[12px] text-muted">→ {result}</div> : null}
      </div>
    );
  }
  if (event.stepType === "ACT" && /completed/i.test(body)) {
    return <div className="font-mono text-[12px] text-accent">✓ {body}</div>;
  }
  return <div className="whitespace-pre-wrap font-mono text-[12px] text-foreground">{body}</div>;
}

export default function IncidentDetailPage() {
  const params = useParams<{ id: string }>();
  const [incident, setIncident] = useState<Incident | null>(null);
  const [postmortem, setPostmortem] = useState<Postmortem | null>(null);
  const [alertPayload, setAlertPayload] = useState<Record<string, unknown> | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!params.id) return;
    fetchIncident(params.id)
      .then((data) => {
        setIncident(data.incident);
        setPostmortem(data.postmortem);
        setAlertPayload(data.alertPayload);
        setEvents(data.incident.agentEvents ?? []);
      })
      .catch((loadError: unknown) => {
        if (isUnauthorizedError(loadError)) return;
        setError(loadError instanceof Error ? loadError.message : "Unable to load incident");
      });
    fetchAuditLog(params.id)
      .then((data) => setAuditEntries(data.items))
      .catch((loadError: unknown) => {
        if (!isUnauthorizedError(loadError)) setAuditEntries([]);
      });
  }, [params.id]);

  useEffect(() => {
    if (!params.id) return;
    const source = new EventSource(apiUrl(`/incidents/${params.id}/stream`));
    source.addEventListener("step", (message) => {
      const event = JSON.parse(message.data as string) as AgentEvent;
      setIncident((current) => (current && current.status !== "resolved" ? { ...current, status: "in_progress" } : current));
      setEvents((current) => {
        const nextKey = eventKey(event);
        return current.some((item) => eventKey(item) === nextKey) ? current : [...current, event];
      });
      if (event.stepType === "CLOSE") {
        fetchIncident(params.id)
          .then((data) => {
            setIncident(data.incident);
            setPostmortem(data.postmortem);
          })
          .catch(() => undefined);
        fetchAuditLog(params.id)
          .then((data) => setAuditEntries(data.items))
          .catch(() => undefined);
      }
    });
    source.onerror = () => {
      source.close();
    };
    return () => source.close();
  }, [params.id]);

  const active = incident?.status === "in_progress";
  const seconds = resolutionSeconds(incident);
  const primaryService = incident?.affectedServices[0] ?? "payment-service";
  const rootService = useMemo(() => {
    const signal = [incident?.title, incident?.rootCause, incident?.resolution, ...(incident?.symptoms ?? [])].join(" ").toLowerCase();
    return signal.includes("redis") ? "redis-cache" : "unknown-root";
  }, [incident]);

  return (
    <div className="min-w-0 space-y-5">
      {error ? <div className="border border-critical bg-panel px-3 py-2 text-[13px] text-critical">{error}</div> : null}

      <section className="grid gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(320px,2fr)]">
        <div className="min-w-0 space-y-4">
          <header className="border-b border-border pb-4">
            <div className="mb-3 flex flex-wrap items-center gap-2 font-mono text-[12px] uppercase tracking-[0.06em] text-muted">
              {incident ? (
                <span className={`inline-flex h-6 w-7 items-center justify-center border leading-none ${severityClass(incident.severity)}`}>
                  {incident.severity}
                </span>
              ) : null}
              <span>{primaryService}</span>
              <span>·</span>
              <span>{incident ? timeAgo(incident.detectedAt) : "--"}</span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h1 className="min-w-0 break-words text-[18px] text-foreground">{incident?.title ?? "Incident"}</h1>
              {incident ? (
                <span className={`inline-flex border px-2 py-1 font-mono text-[11px] uppercase tracking-[0.06em] ${statusClass(incident.status)}`}>
                  {incident.status}
                </span>
              ) : null}
            </div>
          </header>

          <details className="overflow-hidden border border-border bg-panel">
            <summary className="cursor-pointer px-3 py-2 font-mono text-[12px] uppercase tracking-[0.06em] text-muted">
              Show raw alert ›
            </summary>
            <pre className="max-h-64 max-w-full overflow-auto whitespace-pre-wrap break-words border-t border-border p-3 font-mono text-[12px] text-mono">
              {JSON.stringify(alertPayload, null, 2)}
            </pre>
          </details>

          {incident?.status === "escalated" ? (
            <section className="border border-warning bg-panel">
              <div className="border-b border-warning px-3 py-2 font-mono text-[12px] uppercase tracking-[0.06em] text-warning">
                Escalated to on-call
              </div>
              <div className="space-y-2 p-3 font-mono text-[12px] text-foreground">
                <div>
                  Confidence: {formatConfidence(incident.bestSimilarityScore)} · Attempts: {incident.remediationAttempts} · Notified: @oncall
                </div>
                <div className="text-muted">Autonomous remediation stopped because verification did not clear the incident.</div>
              </div>
            </section>
          ) : null}

          <section className="border border-border bg-panel">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <h2 className="font-mono text-[12px] uppercase tracking-[0.06em] text-foreground">Agent Reasoning Panel</h2>
              <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-muted">{active ? "agent active" : "stored trace"}</span>
            </div>
            {active ? <div className="agent-active-indicator" /> : null}
            <div className="divide-y divide-border">
              {events.length === 0 ? (
                <div className="px-3 py-5 font-mono text-[12px] text-muted">Waiting for live reasoning events.</div>
              ) : null}
              {events.map((event, index) => (
                <div key={`${eventKey(event)}:${index}`} className="reasoning-step px-3 py-3">
                  <div className={`mb-2 font-mono text-[12px] ${stepLabelClass(event.stepType)}`}>[{event.stepType}]</div>
                  {renderStepBody(event)}
                </div>
              ))}
            </div>
          </section>

          <details className="overflow-hidden border border-border bg-panel">
            <summary className="cursor-pointer px-3 py-2 font-mono text-[12px] uppercase tracking-[0.06em] text-muted">
              Raw decision log ({auditEntries.length} entries)
            </summary>
            <div className="overflow-x-auto border-t border-border">
              <table className="w-full min-w-[760px] table-fixed border-collapse font-mono text-[11px]">
                <thead>
                  <tr className="border-b border-border bg-background text-muted-deep">
                    <th className="w-[190px] px-3 py-2 text-left">timestamp</th>
                    <th className="w-[112px] px-3 py-2 text-left">phase</th>
                    <th className="px-3 py-2 text-left">tool</th>
                    <th className="w-[96px] px-3 py-2 text-right">duration</th>
                    <th className="w-[96px] px-3 py-2 text-right">confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {auditEntries.map((entry) => (
                    <tr key={entry.id || `${entry.timestamp}:${entry.phase}:${entry.toolCalled ?? "phase"}`} className="border-b border-border last:border-b-0">
                      <td className="px-3 py-2 text-muted">{entry.timestamp}</td>
                      <td className={`px-3 py-2 ${entry.success ? "text-foreground" : "text-critical"}`}>{entry.phase}</td>
                      <td className="truncate px-3 py-2 text-mono">{entry.toolCalled ?? "--"}</td>
                      <td className="px-3 py-2 text-right text-muted">{formatDuration(entry.durationMs)}</td>
                      <td className="px-3 py-2 text-right text-muted">{formatConfidence(entry.confidenceScore)}</td>
                    </tr>
                  ))}
                  {auditEntries.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-3 py-5 text-center text-muted">
                        No audit entries recorded yet.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </details>
        </div>

        <aside className="min-w-0 space-y-4">
          <section className="border border-border bg-panel">
            <div className="border-b border-border px-3 py-2 font-mono text-[12px] uppercase tracking-[0.06em] text-muted">Service graph</div>
            <div className="space-y-2 p-3 font-mono text-[12px] text-foreground">
              <div>{primaryService}</div>
              <div className="pl-4 text-mono">└─ {rootService} ← root cause</div>
              <div className="pl-4 text-muted">└─ postgres-main</div>
            </div>
          </section>

          <section className="border border-border bg-panel">
            <div className="border-b border-border px-3 py-2 font-mono text-[12px] uppercase tracking-[0.06em] text-muted">Runbook</div>
            <div className="space-y-2 p-3 text-[13px] text-muted">
              <div>Steps used in this resolution</div>
              {incident?.remediationSteps.length ? (
                <ol className="space-y-2 break-words font-mono text-[12px] text-foreground">
                  {incident.remediationSteps.map((step, index) => (
                    <li key={`${step}:${index}`} className="border-l border-warning pl-3">
                      <span className="text-muted">{index + 1}.</span> {formatRunbookStep(step)}
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="font-mono text-[12px] text-muted-deep">No remediation steps recorded yet.</div>
              )}
            </div>
          </section>

          <section className="border border-border bg-panel">
            <div className="border-b border-border px-3 py-2 font-mono text-[12px] uppercase tracking-[0.06em] text-muted">Resolution time</div>
            <div className="p-3">
              <div className="font-mono text-[28px] leading-none text-accent">{seconds ? `${seconds}s` : "--"}</div>
              <div className="mt-2 font-mono text-[12px] text-muted">P50 for this pattern: 42s</div>
            </div>
          </section>

          <section className="border border-border bg-panel">
            <div className="border-b border-border px-3 py-2 font-mono text-[12px] uppercase tracking-[0.06em] text-muted">Post-mortem</div>
            <div className="space-y-3 p-3 text-[13px] text-muted">
              {postmortem ? (
                <>
                  <p className="text-foreground">{postmortem.summary}</p>
                  <div>
                    <div className="mb-1 font-mono text-[11px] uppercase tracking-[0.06em] text-muted-deep">Root cause</div>
                    <p>{postmortem.rootCause}</p>
                  </div>
                </>
              ) : (
                <div>Post-mortem appears after resolution.</div>
              )}
            </div>
          </section>
        </aside>
      </section>
    </div>
  );
}
