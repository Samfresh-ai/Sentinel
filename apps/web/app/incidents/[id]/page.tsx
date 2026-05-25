"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiUrl, fetchIncident, type AgentEvent, type Incident, type Postmortem } from "@/lib/api";

function stepClass(step: AgentEvent["stepType"]): string {
  if (step === "ERROR") return "border-red-500 text-red-300";
  if (step === "ACT") return "border-accent text-accent";
  if (step === "CLOSE") return "border-white text-white";
  return "border-border text-muted";
}

export default function IncidentDetailPage() {
  const params = useParams<{ id: string }>();
  const [incident, setIncident] = useState<Incident | null>(null);
  const [postmortem, setPostmortem] = useState<Postmortem | null>(null);
  const [alertPayload, setAlertPayload] = useState<Record<string, unknown> | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!params.id) return;
    fetchIncident(params.id)
      .then((data) => {
        setIncident(data.incident);
        setPostmortem(data.postmortem);
        setAlertPayload(data.alertPayload);
      })
      .catch((loadError: unknown) => {
        setError(loadError instanceof Error ? loadError.message : "Unable to load incident");
      });
  }, [params.id]);

  useEffect(() => {
    if (!params.id) return;
    const source = new EventSource(apiUrl(`/incidents/${params.id}/stream`));
    source.addEventListener("step", (message) => {
      const event = JSON.parse(message.data as string) as AgentEvent;
      setEvents((current) => [...current, event]);
      if (event.stepType === "CLOSE") {
        fetchIncident(params.id)
          .then((data) => {
            setIncident(data.incident);
            setPostmortem(data.postmortem);
          })
          .catch(() => undefined);
      }
    });
    source.onerror = () => {
      source.close();
    };
    return () => source.close();
  }, [params.id]);

  return (
    <div className="space-y-5">
      <section className="border-b border-border pb-5">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-2xl font-semibold tracking-normal">{incident?.title ?? "Incident"}</h1>
          {incident ? <Badge className="border-border text-muted">{incident.status}</Badge> : null}
        </div>
        {incident ? <p className="mt-2 text-sm text-muted">{incident.affectedServices.join(", ")}</p> : null}
      </section>

      {error ? <div className="border border-red-500 p-3 text-sm text-red-300">{error}</div> : null}

      <details className="rounded-md border border-border bg-panel">
        <summary className="cursor-pointer px-4 py-3 text-sm uppercase text-muted">Alert Payload</summary>
        <pre className="overflow-x-auto border-t border-border p-4 font-mono text-xs text-foreground">
          {JSON.stringify(alertPayload, null, 2)}
        </pre>
      </details>

      <section>
        <h2 className="mb-3 font-mono text-lg font-semibold tracking-normal">Agent Reasoning</h2>
        <div className="space-y-3">
          {events.length === 0 ? (
            <Card>
              <CardContent className="font-mono text-sm text-muted">Waiting for live reasoning events</CardContent>
            </Card>
          ) : null}
          {events.map((event, index) => (
            <Card key={`${event.createdAt}-${index}`} className={`border ${stepClass(event.stepType)}`}>
              <CardContent className="font-mono text-sm">
                <div className="mb-2 text-xs text-muted">[{event.stepType}] {new Date(event.createdAt).toLocaleTimeString()}</div>
                <div>{event.message}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Remediation Timeline</CardTitle>
          </CardHeader>
          <CardContent>
            {incident?.remediationSteps.length ? (
              <ol className="space-y-2 text-sm">
                {incident.remediationSteps.map((step, index) => (
                  <li key={step} className="border-l border-accent pl-3">
                    <span className="font-mono text-muted">{index + 1}</span> {step}
                  </li>
                ))}
              </ol>
            ) : (
              <div className="text-sm text-muted">No remediation steps recorded yet</div>
            )}
          </CardContent>
        </Card>

        <details className="rounded-md border border-border bg-panel" open={Boolean(postmortem)}>
          <summary className="cursor-pointer px-4 py-3 text-sm uppercase text-muted">Post-mortem</summary>
          <div className="space-y-3 border-t border-border p-4 text-sm">
            {postmortem ? (
              <>
                <p>{postmortem.summary}</p>
                <div>
                  <div className="mb-1 text-xs uppercase text-muted">Root Cause</div>
                  <p>{postmortem.rootCause}</p>
                </div>
                <div>
                  <div className="mb-1 text-xs uppercase text-muted">Prevention</div>
                  <ul className="list-inside list-disc text-muted">
                    {postmortem.preventionActions.map((action) => (
                      <li key={action}>{action}</li>
                    ))}
                  </ul>
                </div>
              </>
            ) : (
              <div className="text-muted">Post-mortem appears after resolution</div>
            )}
          </div>
        </details>
      </section>
    </div>
  );
}
