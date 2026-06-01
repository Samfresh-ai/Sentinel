"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { fetchQdrantOverview, isUnauthorizedError, storedToken, type QdrantOverview } from "@/lib/api";

function timeAgo(value: string): string {
  const diffMs = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.floor(diffMs / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function severityClass(severity: string): string {
  if (severity === "P1") return "bg-critical";
  if (severity === "P2") return "bg-warning";
  if (severity === "P3") return "bg-caution";
  return "bg-muted";
}

function phaseClass(success: boolean): string {
  return success ? "border-accent text-accent" : "border-critical text-critical";
}

function MiniBar({ value, max, tone = "bg-active" }: { value: number; max: number; tone?: string }) {
  const width = max > 0 ? Math.max(4, Math.round((value / max) * 100)) : 0;
  return (
    <div className="h-2 w-full border border-border bg-background">
      <div className={`h-full ${tone}`} style={{ width: `${width}%` }} />
    </div>
  );
}

export default function QdrantOverviewPage() {
  const router = useRouter();
  const [overview, setOverview] = useState<QdrantOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!storedToken()) {
      router.replace("/setup");
      return;
    }
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const next = await fetchQdrantOverview();
        if (!cancelled) {
          setOverview(next);
          setError(null);
        }
      } catch (loadError: unknown) {
        if (isUnauthorizedError(loadError)) return;
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Unable to load Qdrant overview");
      }
    }
    void load();
    const interval = window.setInterval(() => {
      void load();
    }, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [router]);

  const maxTimeline = useMemo(() => Math.max(1, ...(overview?.resolutionTimeline ?? []).map((item) => item.count)), [overview]);
  const maxSeverity = useMemo(() => Math.max(1, ...(overview?.severityDistribution ?? []).map((item) => item.count)), [overview]);
  const maxErrorRate = useMemo(() => Math.max(1, ...(overview?.serviceHealth ?? []).map((item) => item.errorRate)), [overview]);

  return (
    <div className="min-w-0 space-y-4">
      <section className="flex flex-col justify-between gap-3 border-b border-border pb-4 lg:flex-row lg:items-end">
        <div>
          <h1 className="font-mono text-[16px] uppercase tracking-[0.08em] text-foreground">Qdrant Operations</h1>
          <p className="mt-1 text-[13px] text-muted">Vector memory, audit trail, service context, and OperaIQ agent decisions inside the product shell.</p>
        </div>
        <div className="grid gap-2 font-mono text-[11px] uppercase tracking-[0.06em] text-muted sm:grid-cols-3 lg:min-w-[520px]">
          <div className="border border-border bg-panel px-3 py-2">
            Surface <span className="block pt-1 text-foreground">/qdrant</span>
          </div>
          <div className="border border-border bg-panel px-3 py-2">
            Source <span className="block pt-1 text-accent">operaiq_memory</span>
          </div>
          <div className="border border-border bg-panel px-3 py-2">
            Native view <span className="block truncate pt-1 text-muted-deep">{overview?.nativeDashboardUrl ? "available" : "loading"}</span>
          </div>
        </div>
      </section>

      {error ? <div className="border border-critical bg-panel px-3 py-2 text-[13px] text-critical">{error}</div> : null}

      <section className="grid gap-3 lg:grid-cols-2">
        <div className="border border-border bg-panel">
          <div className="border-b border-border px-3 py-2 font-mono text-[12px] uppercase tracking-[0.06em] text-muted">Active incidents</div>
          <div className="p-3">
            <div className="font-mono text-[42px] leading-none text-foreground">{overview?.activeIncidents ?? "--"}</div>
            <div className="mt-2 text-[13px] text-muted">Open or in-progress OperaIQ incidents.</div>
          </div>
        </div>

        <div className="border border-border bg-panel">
          <div className="border-b border-border px-3 py-2 font-mono text-[12px] uppercase tracking-[0.06em] text-muted">Brain size</div>
          <div className="p-3">
            <div className="font-mono text-[42px] leading-none text-accent">{overview?.brainSize ?? "--"}</div>
            <div className="mt-2 text-[13px] text-muted">Resolved incidents available as Qdrant memory.</div>
          </div>
        </div>
      </section>

      <section className="grid gap-3 xl:grid-cols-2">
        <div className="border border-border bg-panel">
          <div className="border-b border-border px-3 py-2 font-mono text-[12px] uppercase tracking-[0.06em] text-muted">Resolution timeline - 24h</div>
          <div className="grid grid-cols-12 gap-2 p-3 md:grid-cols-24">
            {(overview?.resolutionTimeline ?? []).map((item) => (
              <div key={item.label} className="flex h-28 min-w-0 flex-col justify-end gap-2">
                <div className="flex min-h-0 flex-1 items-end border border-border bg-background">
                  <div className="w-full bg-accent" style={{ height: `${Math.round((item.count / maxTimeline) * 100)}%` }} />
                </div>
                <div className="truncate text-center font-mono text-[10px] text-muted-deep">{item.label.slice(0, 2)}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="border border-border bg-panel">
          <div className="border-b border-border px-3 py-2 font-mono text-[12px] uppercase tracking-[0.06em] text-muted">Severity distribution</div>
          <div className="space-y-3 p-3">
            {(overview?.severityDistribution ?? []).map((item) => (
              <div key={item.severity} className="grid grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-3">
                <span className="font-mono text-[12px] text-muted">{item.severity}</span>
                <MiniBar value={item.count} max={maxSeverity} tone={severityClass(item.severity)} />
                <span className="text-right font-mono text-[12px] text-foreground">{item.count}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="grid gap-3 xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
        <div className="overflow-hidden border border-border bg-panel">
          <div className="border-b border-border px-3 py-2 font-mono text-[12px] uppercase tracking-[0.06em] text-muted">Recent agent decisions</div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[740px] table-fixed border-collapse">
              <thead>
                <tr className="border-b border-border bg-background font-mono text-[11px] uppercase tracking-[0.06em] text-muted-deep">
                  <th className="w-[92px] px-3 py-2 text-left">Time</th>
                  <th className="w-[96px] px-3 py-2 text-left">Phase</th>
                  <th className="px-3 py-2 text-left">Tool</th>
                  <th className="w-[96px] px-3 py-2 text-right">Duration</th>
                  <th className="w-[112px] px-3 py-2 text-left">Incident</th>
                </tr>
              </thead>
              <tbody>
                {(overview?.recentAgentDecisions ?? []).map((item, index) => (
                  <tr key={`${item.timestamp}-${item.phase}-${index}`} className="border-b border-border last:border-b-0 hover:bg-elevated">
                    <td className="px-3 py-2 font-mono text-[12px] text-muted-deep">{timeAgo(item.timestamp)}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex border px-2 py-1 font-mono text-[11px] uppercase tracking-[0.06em] ${phaseClass(item.success)}`}>{item.phase}</span>
                    </td>
                    <td className="truncate px-3 py-2 font-mono text-[12px] text-muted">{item.toolCalled ?? "phase"}</td>
                    <td className="px-3 py-2 text-right font-mono text-[12px] text-muted">{item.durationMs}ms</td>
                    <td className="px-3 py-2 font-mono text-[12px] text-mono">
                      <Link href={`/incidents/${item.incidentId}`} className="hover:text-active">
                        {item.incidentId.slice(0, 8)}
                      </Link>
                    </td>
                  </tr>
                ))}
                {(overview?.recentAgentDecisions ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center font-mono text-[12px] text-muted">
                      No audit entries yet.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        <div className="border border-border bg-panel">
          <div className="border-b border-border px-3 py-2 font-mono text-[12px] uppercase tracking-[0.06em] text-muted">Service context</div>
          <div className="space-y-3 p-3">
            {(overview?.serviceHealth ?? []).map((item) => (
              <div key={item.service} className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate font-mono text-[12px] text-foreground">{item.service}</span>
                  <span className="shrink-0 font-mono text-[12px] text-muted">{item.errorRate}% err</span>
                </div>
                <MiniBar value={item.errorRate} max={maxErrorRate} tone={item.errorRate > 20 ? "bg-critical" : item.errorRate > 5 ? "bg-warning" : "bg-accent"} />
                <div className="font-mono text-[11px] text-muted-deep">
                  {item.errorCount} errors / {item.eventCount} events
                </div>
              </div>
            ))}
            {(overview?.serviceHealth ?? []).length === 0 ? <div className="font-mono text-[12px] text-muted">No service context indexed yet.</div> : null}
          </div>
        </div>
      </section>
    </div>
  );
}
