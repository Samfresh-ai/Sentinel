"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { fetchIncidents, fetchMe, isUnauthorizedError, rotateWebhookSecret, storedToken, type Incident, type OrgSummary } from "@/lib/api";

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

function timeAgo(value: string): string {
  const diffMs = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.floor(diffMs / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function truncateTitle(value: string): string {
  return value.length > 60 ? `${value.slice(0, 57)}...` : value;
}

function shortServiceName(value: string): string {
  return value.replace(/-service$/, "").replace(/-cache$/, "").replace(/-main$/, "");
}

function deriveServices(incident: Incident): string[] {
  const values = new Set(incident.affectedServices);
  const searchable = [incident.title, incident.rootCause, incident.resolution, ...incident.symptoms].join(" ").toLowerCase();
  if (searchable.includes("redis")) values.add("redis-cache");
  if (searchable.includes("payment")) values.add("payment-service");
  return Array.from(values).slice(0, 4);
}

export default function IncidentFeedPage() {
  const router = useRouter();
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [orgSummary, setOrgSummary] = useState<OrgSummary | null>(null);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookBusy, setWebhookBusy] = useState(false);
  const [webhookCopied, setWebhookCopied] = useState(false);
  const [webhookError, setWebhookError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load(): Promise<void> {
    try {
      const response = await fetchIncidents();
      setIncidents(response.items);
      setError(null);
    } catch (loadError: unknown) {
      if (isUnauthorizedError(loadError)) return;
      setError(loadError instanceof Error ? loadError.message : "Unable to load incidents");
    } finally {
      setLoading(false);
    }
  }

  async function loadOrgSummary(): Promise<void> {
    try {
      const summary = await fetchMe();
      setOrgSummary(summary);
    } catch (loadError: unknown) {
      if (isUnauthorizedError(loadError)) return;
      setWebhookError(loadError instanceof Error ? loadError.message : "Unable to load webhook endpoint");
    }
  }

  async function generateWebhookUrl(): Promise<void> {
    setWebhookBusy(true);
    setWebhookCopied(false);
    setWebhookError(null);
    try {
      const result = await rotateWebhookSecret();
      setWebhookUrl(result.webhookUrl);
    } catch (generateError: unknown) {
      if (isUnauthorizedError(generateError)) return;
      setWebhookError(generateError instanceof Error ? generateError.message : "Unable to generate webhook URL");
    } finally {
      setWebhookBusy(false);
    }
  }

  async function copyWebhookUrl(): Promise<void> {
    if (!webhookUrl) return;
    await navigator.clipboard.writeText(webhookUrl);
    setWebhookCopied(true);
  }

  useEffect(() => {
    if (!storedToken()) {
      router.replace("/setup");
      return;
    }
    void load();
    void loadOrgSummary();
    const interval = window.setInterval(() => {
      void load();
    }, 2_000);
    return () => window.clearInterval(interval);
  }, []);

  return (
    <div className="min-w-0 space-y-4">
      <section className="flex flex-col justify-between gap-2 border-b border-border pb-4 md:flex-row md:items-end">
        <div>
          <h1 className="font-mono text-[16px] uppercase tracking-[0.08em] text-foreground">Incidents</h1>
          <p className="mt-1 text-[13px] text-muted">Newest alerts, agent status, and resolution state.</p>
        </div>
        <div className="font-mono text-[12px] uppercase tracking-[0.06em] text-muted-deep">poll: 2s</div>
      </section>

      <section className="grid gap-3 border border-border bg-panel p-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
        <div className="min-w-0">
          <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-deep">OperaIQ webhook</div>
          <h2 className="mt-1 font-mono text-[14px] uppercase tracking-[0.06em] text-foreground">Alert Action URL for {orgSummary?.orgName ?? "this org"}</h2>
          <p className="mt-1 max-w-[760px] text-[13px] text-muted">
            Generate a fresh URL here and send incident alerts to OperaIQ. The secret is shown only when generated, and the previous webhook secret stops working.
          </p>
          <div className="mt-3 break-all border border-border bg-background p-3 font-mono text-[12px] text-active">
            {webhookUrl || orgSummary?.webhookUrl || "Loading webhook endpoint"}
          </div>
          {webhookError ? <div className="mt-2 text-[13px] text-critical">{webhookError}</div> : null}
          {webhookCopied ? <div className="mt-2 font-mono text-[11px] uppercase tracking-[0.08em] text-accent">Webhook URL copied</div> : null}
        </div>
        <div className="flex flex-wrap gap-2 md:justify-end">
          <button
            type="button"
            onClick={generateWebhookUrl}
            disabled={webhookBusy}
            className="border border-active bg-active px-3 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-background disabled:cursor-not-allowed disabled:border-border disabled:bg-elevated disabled:text-muted"
          >
            {webhookBusy ? "Generating" : "Generate fresh URL"}
          </button>
          <button
            type="button"
            onClick={copyWebhookUrl}
            disabled={!webhookUrl}
            className="border border-border px-3 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-foreground disabled:cursor-not-allowed disabled:text-muted"
          >
            Copy URL
          </button>
        </div>
      </section>

      <section className="overflow-hidden border border-border bg-panel">
        {error ? <div className="border-b border-border px-3 py-2 text-[13px] text-critical">{error}</div> : null}
        {loading ? <div className="border-b border-border px-3 py-2 font-mono text-[12px] text-muted">Loading incident rows</div> : null}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] table-fixed border-collapse">
            <thead>
              <tr className="border-b border-border bg-background font-mono text-[11px] uppercase tracking-[0.06em] text-muted-deep">
                <th className="w-[52px] px-3 py-2 text-left">Sev</th>
                <th className="px-3 py-2 text-left">Title</th>
                <th className="w-[220px] px-3 py-2 text-left">Services</th>
                <th className="w-[132px] px-3 py-2 text-left">Status</th>
                <th className="w-[104px] px-3 py-2 text-right">Time</th>
              </tr>
            </thead>
            <tbody>
              {incidents.map((incident) => (
                <tr key={incident.id} className="border-b border-border bg-panel last:border-b-0 hover:bg-elevated">
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex h-6 w-7 items-center justify-center whitespace-nowrap border font-mono text-[11px] uppercase leading-none ${severityClass(
                        incident.severity
                      )}`}
                    >
                      {incident.severity}
                    </span>
                  </td>
                  <td className="min-w-0 px-3 py-2">
                    <Link href={`/incidents/${incident.id}`} className="block truncate text-[14px] text-foreground hover:text-active">
                      {truncateTitle(incident.title)}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex min-w-0 flex-wrap gap-1">
                      {deriveServices(incident).map((service) => (
                        <span key={service} className="bg-elevated px-2 py-1 font-mono text-[11px] text-muted">
                          {shortServiceName(service)}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex border px-2 py-1 font-mono text-[11px] uppercase tracking-[0.06em] ${statusClass(incident.status)}`}>
                      {incident.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-[12px] text-muted-deep">{timeAgo(incident.detectedAt)}</td>
                </tr>
              ))}
              {!loading && incidents.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center font-mono text-[12px] text-muted">
                    No incidents indexed yet.
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
