"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchBrainStats, fetchServices, simulateIncident, type BrainStats, type Service } from "@/lib/api";

export default function BrainPage() {
  const router = useRouter();
  const [stats, setStats] = useState<BrainStats | null>(null);
  const [services, setServices] = useState<Service[]>([]);
  const [service, setService] = useState("payment-service");
  const [severity, setSeverity] = useState<"P1" | "P2" | "P3" | "P4">("P2");
  const [symptoms, setSymptoms] = useState("database connection timeout\npostgres pool exhausted\ncheckout latency");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([fetchBrainStats(), fetchServices()])
      .then(([brainStats, serviceResponse]) => {
        setStats(brainStats);
        setServices(serviceResponse.items);
        if (serviceResponse.items[0]) setService(serviceResponse.items[0].name);
      })
      .catch((loadError: unknown) => {
        setError(loadError instanceof Error ? loadError.message : "Unable to load brain data");
      });
  }, []);

  const maxTypeCount = useMemo(() => {
    return Math.max(...(stats?.topIncidentTypes.map((item) => item.count) ?? [1]));
  }, [stats]);

  async function submit(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      const result = await simulateIncident({
        service,
        severity,
        symptoms: symptoms.split("\n").map((item) => item.trim()).filter(Boolean)
      });
      router.push(`/incidents/${result.incidentId}`);
    } catch (submitError: unknown) {
      setError(submitError instanceof Error ? submitError.message : "Unable to simulate incident");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-5">
      <section className="border-b border-border pb-5">
        <h1 className="font-mono text-2xl font-semibold tracking-normal">Brain Explorer</h1>
        <p className="mt-1 text-sm text-muted">MongoDB Atlas memory, runbooks, patterns, and post-mortems</p>
      </section>

      {error ? <div className="border border-red-500 p-3 text-sm text-red-300">{error}</div> : null}

      <section className="grid gap-3 md:grid-cols-3">
        <Card>
          <CardContent>
            <div className="text-xs uppercase text-muted">Incidents</div>
            <div className="mt-2 font-mono text-3xl">{stats?.incidentCount ?? 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <div className="text-xs uppercase text-muted">Runbooks</div>
            <div className="mt-2 font-mono text-3xl">{stats?.runbookCount ?? 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <div className="text-xs uppercase text-muted">Patterns</div>
            <div className="mt-2 font-mono text-3xl">{stats?.patternCount ?? 0}</div>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Common Incident Types</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {(stats?.topIncidentTypes ?? []).map((item) => (
              <div key={item.name}>
                <div className="mb-1 flex justify-between gap-3 text-sm">
                  <span className="truncate">{item.name}</span>
                  <span className="font-mono text-muted">{item.count}</span>
                </div>
                <div className="h-2 border border-border bg-background">
                  <div className="h-full bg-accent" style={{ width: `${Math.max(8, (item.count / maxTypeCount) * 100)}%` }} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent Post-mortems</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {(stats?.recentPostmortems ?? []).length === 0 ? <div className="text-sm text-muted">No post-mortems yet</div> : null}
            {(stats?.recentPostmortems ?? []).map((postmortem) => (
              <div key={postmortem.id} className="border-l border-accent pl-3 text-sm">
                <div className="truncate font-medium">{postmortem.title}</div>
                <div className="mt-1 text-muted">{postmortem.summary}</div>
              </div>
            ))}
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Simulate Incident</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-4">
          <label className="text-sm md:col-span-1">
            <span className="mb-1 block text-xs uppercase text-muted">Service</span>
            <select
              value={service}
              onChange={(event) => setService(event.target.value)}
              className="h-10 w-full rounded-sm border border-border bg-background px-2 text-sm"
            >
              {services.map((item) => (
                <option key={item.id} value={item.name}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm md:col-span-1">
            <span className="mb-1 block text-xs uppercase text-muted">Severity</span>
            <select
              value={severity}
              onChange={(event) => setSeverity(event.target.value as "P1" | "P2" | "P3" | "P4")}
              className="h-10 w-full rounded-sm border border-border bg-background px-2 text-sm"
            >
              <option value="P1">P1</option>
              <option value="P2">P2</option>
              <option value="P3">P3</option>
              <option value="P4">P4</option>
            </select>
          </label>
          <label className="text-sm md:col-span-2">
            <span className="mb-1 block text-xs uppercase text-muted">Symptoms</span>
            <textarea
              value={symptoms}
              onChange={(event) => setSymptoms(event.target.value)}
              rows={4}
              className="w-full resize-none rounded-sm border border-border bg-background p-2 font-mono text-sm"
            />
          </label>
          <div className="md:col-span-4">
            <Button onClick={submit} disabled={submitting}>
              <Send className="h-4 w-4" aria-hidden="true" />
              {submitting ? "Firing" : "Fire Test Alert"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
