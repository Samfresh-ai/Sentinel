"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { fetchBrainStats, fetchRuntimeReadiness, isUnauthorizedError, type BrainStats, type RuntimeReadiness } from "@/lib/api";

function timeAgo(value: string | null | undefined): string {
  if (!value) return "none";
  const diffMs = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.floor(diffMs / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function severityDotClass(severity: string): string {
  if (severity === "P1") return "bg-critical";
  if (severity === "P2") return "bg-warning";
  if (severity === "P3") return "bg-caution";
  return "bg-muted";
}

function formatSeconds(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  return `${value % 1 === 0 ? value.toFixed(0) : value.toFixed(1)}s`;
}

function runtimeModeLabel(mode: RuntimeReadiness["mode"] | undefined): string {
  if (mode === "production-blocked") return "Production blocked";
  if (mode === "autonomous-ready") return "Autonomous ready";
  if (mode === "local-verification") return "Local verification";
  if (mode === "test-timing") return "Test timing";
  return "Checking runtime";
}

export default function BrainPage() {
  const [stats, setStats] = useState<BrainStats | null>(null);
  const [runtime, setRuntime] = useState<RuntimeReadiness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    fetchRuntimeReadiness()
      .then((runtimeReadiness) => {
        if (!cancelled) setRuntime(runtimeReadiness);
      })
      .catch(() => undefined);

    fetchBrainStats()
      .then((brainStats) => {
        if (cancelled) return;
        setStats(brainStats);
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (cancelled || isUnauthorizedError(loadError)) return;
        setError(loadError instanceof Error ? loadError.message : "Unable to load brain data");
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const lastWrite = stats?.recentPostmortems[0]?.createdAt;

  return (
    <div className="min-w-0 space-y-4">
      {error ? <div className="border border-critical bg-panel px-3 py-2 text-[13px] text-critical">{error}</div> : null}
      {loading ? <div className="border border-border bg-panel px-3 py-2 font-mono text-[12px] uppercase tracking-[0.06em] text-muted">Loading OperaIQ brain</div> : null}

      <section className={`border bg-panel ${runtime?.mode === "production-blocked" ? "border-critical" : runtime?.mode === "autonomous-ready" ? "border-active" : "border-warning"}`}>
        <div className="flex flex-col gap-2 px-3 py-2 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="font-mono text-[12px] uppercase tracking-[0.06em] text-muted">Runtime gate</div>
            <div className="mt-1 text-[13px] text-foreground">{runtimeModeLabel(runtime?.mode)}</div>
          </div>
          <div className="font-mono text-[11px] uppercase tracking-[0.06em] text-muted">
            {runtime?.production ? "Production" : "Non-production"} · {runtime?.localVerification ? "Local action recording" : "Real action path"} · {runtime?.testTiming ? "Test timing" : "Live timing"}
          </div>
        </div>
        {runtime?.violations?.length ? (
          <div className="border-t border-border px-3 py-2 font-mono text-[12px] text-critical">
            {runtime.violations[0]}
          </div>
        ) : null}
      </section>

      <section className="border border-border bg-panel">
        <div className="border-b border-border px-3 py-2 font-mono text-[12px] uppercase tracking-[0.06em] text-foreground">Qdrant vector brain</div>
        <div className="space-y-3 p-3">
          <div className="font-mono text-[13px] text-muted">
            <span className="text-accent">{stats?.incidentCount ?? "--"}</span> incidents ·{" "}
            <span className="text-foreground">{stats?.runbookCount ?? "--"}</span> runbooks ·{" "}
            <span className="text-foreground">{stats?.patternCount ?? "--"}</span> patterns · Last write:{" "}
            <span className="text-foreground">{timeAgo(lastWrite)}</span>
          </div>
          <div className="flex h-3 w-full max-w-[420px] border border-border bg-background">
            {Array.from({ length: 20 }).map((_, index) => (
              <span key={index} className={`h-full flex-1 border-r border-background last:border-r-0 ${index < 16 ? "bg-accent" : "bg-elevated"}`} />
            ))}
          </div>
        </div>
      </section>

      <section className="border border-border bg-panel">
        <div className="border-b border-border px-3 py-2 font-mono text-[12px] uppercase tracking-[0.06em] text-muted">Brain growth</div>
        <div className="overflow-x-auto p-3">
          <div className="flex min-w-[540px] items-start">
            {(stats?.brainGrowth ?? []).map((item, index, items) => (
              <Link key={item.incidentId} href={`/incidents/${item.incidentId}`} className="group flex flex-1 items-start">
                <div className="flex min-w-0 flex-1 flex-col items-center gap-2">
                  <span
                    title={`${item.title} · ${formatSeconds(item.resolutionSeconds)} · best match ${item.bestSimilarityScore !== null ? Math.round(item.bestSimilarityScore * 100) : "--"}%`}
                    className={`h-4 w-4 rounded-full border border-background ${severityDotClass(item.severity)}`}
                  />
                  <span className="font-mono text-[11px] text-muted">{item.severity}</span>
                  <span className="font-mono text-[11px] text-muted-deep">{formatSeconds(item.resolutionSeconds)}</span>
                </div>
                {index < items.length - 1 ? <div className="mt-2 h-px flex-1 bg-border" /> : null}
              </Link>
            ))}
            {(stats?.brainGrowth ?? []).length === 0 ? (
              <div className="font-mono text-[12px] text-muted">No resolved OperaIQ incidents yet.</div>
            ) : null}
          </div>
        </div>
      </section>

      <section className="overflow-hidden border border-border bg-panel">
        <div className="border-b border-border px-3 py-2 font-mono text-[12px] uppercase tracking-[0.06em] text-muted">Recent post-mortems</div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] table-fixed border-collapse">
            <thead>
              <tr className="border-b border-border bg-background font-mono text-[11px] uppercase tracking-[0.06em] text-muted-deep">
                <th className="px-3 py-2 text-left">Title</th>
                <th className="w-[160px] px-3 py-2 text-left">Incident</th>
                <th className="w-[120px] px-3 py-2 text-right">Written</th>
              </tr>
            </thead>
            <tbody>
              {(stats?.recentPostmortems ?? []).map((postmortem) => (
                <tr key={postmortem.id} className="border-b border-border last:border-b-0 hover:bg-elevated">
                  <td className="px-3 py-2">
                    <div className="truncate text-[13px] text-foreground">{postmortem.title}</div>
                    <div className="mt-1 truncate text-[12px] text-muted">{postmortem.summary}</div>
                  </td>
                  <td className="px-3 py-2 font-mono text-[12px] text-mono">
                    <Link href={`/incidents/${postmortem.incidentId}`} className="hover:text-active">
                      {postmortem.incidentId.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-[12px] text-muted-deep">{timeAgo(postmortem.createdAt)}</td>
                </tr>
              ))}
              {(stats?.recentPostmortems ?? []).length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-3 py-6 text-center font-mono text-[12px] text-muted">
                    No post-mortems indexed yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
