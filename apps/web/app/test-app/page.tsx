"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  createProject,
  fetchProjectFlow,
  ingestProjectLogs,
  isUnauthorizedError,
  rotateWebhookSecret,
  storedToken,
  type Project,
  type ProjectFlow,
  type ProjectLogInput
} from "@/lib/api";

const TEST_PROJECT_STORAGE_KEY = "sentinel_test_project_id";

function stamp(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

function hardFailureLogs(project: Project): ProjectLogInput[] {
  const now = Date.now();
  const traceId = `splunk-checkout-${stamp()}`;
  return Array.from({ length: 48 }, (_item, index) => {
    const failure = index < 34;
    const latency = failure ? 4680 + index * 73 : 130 + index * 4;
    const redisPoolWaiting = failure ? 84 + index : index % 3;
    const base = {
      service: "payment",
      route: "/checkout/confirm",
      traceId,
      requestId: `${traceId}-req-${index}`,
      latencyMs: latency,
      timestamp: new Date(now - Math.max(0, 80 - index) * 1_000).toISOString(),
      metadata: {
        projectId: project._key,
        projectName: project.name,
        tenant: "human-browser-test",
        redisPoolWaiting,
        rootSignal: failure ? "redis_pool_exhaustion_after_econnreset" : "healthy_checkout",
        deploySha: "sentinel-browser-hard-log"
      }
    };
    if (!failure) {
      return {
        ...base,
        level: "info",
        statusCode: 200,
        message: "checkout completed with healthy Redis pool and payment capture confirmed.",
        errorName: "OK"
      };
    }
    const variant = index % 4;
    const message =
      variant === 0
        ? "checkout failed after payment authorization: Redis read ECONNRESET, pool waiters rising, idempotency lock not released."
        : variant === 1
          ? "checkout retry storm: upstream Redis socket reset during capture, fallback cache miss, provider callback delayed."
          : variant === 2
            ? "hard checkout failure: Redis MOVED redirect followed by ECONNRESET on reused TLS socket, payment-service cannot finalize order."
            : "UnhandledPromiseRejection: redis-cache connection pool exhausted, ECONNRESET after retry budget, checkout confirm returned 503.";
    return {
      ...base,
      level: index % 7 === 0 ? "fatal" : "error",
      statusCode: index % 7 === 0 ? 500 : 503,
      message,
      errorName: "ECONNRESET",
      stack: [
        "Error: read ECONNRESET",
        "    at RedisSocket.onStreamRead (node:internal/stream_base_commons:217:20)",
        "    at PaymentCapture.confirm (/srv/app/src/checkout/payment-capture.ts:184:17)",
        "    at async CheckoutController.confirm (/srv/app/src/checkout/controller.ts:77:9)",
        `    at async BrowserAcceptanceRun.project(${project._key})`
      ].join("\n")
    };
  });
}

function StageRow({ label, done, detail }: { label: string; done: boolean; detail: string }) {
  return (
    <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-3 border-b border-border px-3 py-2 last:border-b-0">
      <div className={`font-mono text-[11px] uppercase tracking-[0.08em] ${done ? "text-accent" : "text-muted-deep"}`}>
        {done ? "done" : "waiting"}
      </div>
      <div>
        <div className="font-mono text-[12px] uppercase tracking-[0.06em] text-foreground">{label}</div>
        <div className="mt-1 text-[12px] text-muted">{detail}</div>
      </div>
    </div>
  );
}

export default function TestAppPage() {
  const router = useRouter();
  const [project, setProject] = useState<Project | null>(null);
  const [flow, setFlow] = useState<ProjectFlow | null>(null);
  const [busy, setBusy] = useState<"project" | "logs" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastAccepted, setLastAccepted] = useState<number | null>(null);

  useEffect(() => {
    if (!storedToken()) {
      router.replace("/setup");
      return;
    }
    const storedProjectId = window.localStorage.getItem(TEST_PROJECT_STORAGE_KEY);
    if (!storedProjectId) return;
    let cancelled = false;
    fetchProjectFlow(storedProjectId)
      .then((next) => {
        if (cancelled) return;
        setProject(next.project);
        setFlow(next);
      })
      .catch(() => {
        window.localStorage.removeItem(TEST_PROJECT_STORAGE_KEY);
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  useEffect(() => {
    if (!project) return;
    const projectId = project._key;
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const next = await fetchProjectFlow(projectId);
        if (!cancelled) {
          setFlow(next);
          setProject(next.project);
        }
      } catch (loadError: unknown) {
        if (cancelled) return;
        if (isUnauthorizedError(loadError)) {
          router.replace("/setup");
          return;
        }
        setError(loadError instanceof Error ? loadError.message : "Unable to read project flow");
      }
    }
    void load();
    const interval = window.setInterval(() => {
      void load();
    }, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [project?._key, router]);

  const done = useMemo(() => flow?.stages ?? {
    appLogsStored: false,
    splunkWatchedAndWebhookFired: false,
    sentinelActed: false,
    sentinelVerified: false,
    sentinelClosed: false,
    splunkPostmortemStored: false
  }, [flow]);

  async function createFreshProject(): Promise<void> {
    setBusy("project");
    setError(null);
    setLastAccepted(null);
    try {
      const webhook = await rotateWebhookSecret();
      const result = await createProject({
        name: `Browser Splunk checkout failure ${stamp()}`,
        service: "payment-service",
        environment: "local-browser",
        webhookUrl: webhook.webhookUrl
      });
      setProject(result.project);
      setFlow(null);
      window.localStorage.setItem(TEST_PROJECT_STORAGE_KEY, result.project._key);
    } catch (submitError: unknown) {
      setError(submitError instanceof Error ? submitError.message : "Unable to create project");
    } finally {
      setBusy(null);
    }
  }

  async function sendHardFailure(): Promise<void> {
    if (!project) return;
    setBusy("logs");
    setError(null);
    try {
      const result = await ingestProjectLogs(project._key, hardFailureLogs(project));
      setLastAccepted(result.accepted);
      const next = await fetchProjectFlow(project._key);
      setFlow(next);
    } catch (submitError: unknown) {
      setError(submitError instanceof Error ? submitError.message : "Unable to send failure logs");
    } finally {
      setBusy(null);
    }
  }

  function resetLocal(): void {
    window.localStorage.removeItem(TEST_PROJECT_STORAGE_KEY);
    setProject(null);
    setFlow(null);
    setLastAccepted(null);
    setError(null);
  }

  return (
    <div className="min-w-0 space-y-4">
      <section className="flex flex-col justify-between gap-2 border-b border-border pb-4 md:flex-row md:items-end">
        <div>
          <h1 className="font-mono text-[16px] uppercase tracking-[0.08em] text-foreground">Test App</h1>
          <p className="mt-1 max-w-[760px] text-[13px] text-muted">Browser-driven app failure proving logs to Splunk, saved-search detection, webhook, and Sentinel action.</p>
        </div>
        <div className="font-mono text-[12px] uppercase tracking-[0.06em] text-muted-deep">poll: 5s</div>
      </section>

      <section className="grid gap-3 border border-border bg-panel p-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
        <div className="min-w-0">
          <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-deep">External app project</div>
          <h2 className="mt-1 break-words font-mono text-[14px] uppercase tracking-[0.06em] text-foreground">{project?.name ?? "No project created yet"}</h2>
          <div className="mt-3 grid gap-2 font-mono text-[12px] text-muted sm:grid-cols-2">
            <div className="border border-border bg-background p-2">Project: <span className="text-foreground">{project?._key ?? "--"}</span></div>
            <div className="border border-border bg-background p-2">Saved search: <span className="text-foreground">{project?.savedSearchName ?? "--"}</span></div>
          </div>
          {project?.ingestUrl ? <div className="mt-2 break-all border border-border bg-background p-2 font-mono text-[11px] text-active">{project.ingestUrl}</div> : null}
        </div>
        <div className="flex flex-wrap gap-2 md:justify-end">
          <button
            type="button"
            onClick={createFreshProject}
            disabled={busy !== null}
            className="border border-active bg-active px-3 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-background disabled:cursor-not-allowed disabled:border-border disabled:bg-elevated disabled:text-muted"
          >
            {busy === "project" ? "Creating" : "Create fresh project"}
          </button>
          <button
            type="button"
            onClick={sendHardFailure}
            disabled={!project || busy !== null}
            className="border border-critical bg-critical px-3 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-white disabled:cursor-not-allowed disabled:border-border disabled:bg-elevated disabled:text-muted"
          >
            {busy === "logs" ? "Sending" : "Send hard failure logs"}
          </button>
          <button
            type="button"
            onClick={resetLocal}
            className="border border-border px-3 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-foreground"
          >
            Reset
          </button>
        </div>
      </section>

      {error ? <div className="border border-critical bg-panel px-3 py-2 text-[13px] text-critical">{error}</div> : null}
      {lastAccepted !== null ? <div className="border border-border bg-panel px-3 py-2 font-mono text-[12px] uppercase tracking-[0.08em] text-accent">Splunk HEC accepted {lastAccepted} log events</div> : null}

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="overflow-hidden border border-border bg-panel">
          <StageRow label="Your app" done={done.appLogsStored} detail={`${flow?.counts.logsStored ?? 0} log events indexed in Splunk`} />
          <StageRow label="Splunk watcher" done={done.splunkWatchedAndWebhookFired} detail={flow?.incident ? `Saved search created incident ${flow.incident.id}` : `Waiting for ${flow?.latestSavedSearch.name ?? "saved search"}`} />
          <StageRow label="Webhook" done={done.splunkWatchedAndWebhookFired} detail={flow?.incident ? "Splunk alert action reached /webhooks/splunk-alert" : "Waiting for Splunk alert action"} />
          <StageRow label="Sentinel act" done={done.sentinelActed} detail={done.sentinelActed ? "ACT phase recorded in Splunk audit log" : "Waiting for agent ACT phase"} />
          <StageRow label="Sentinel verify" done={done.sentinelVerified} detail={done.sentinelVerified ? "VERIFY phase recorded after remediation" : "Waiting for Splunk verification"} />
          <StageRow label="Splunk close" done={done.splunkPostmortemStored} detail={flow?.postmortem ? `Postmortem ${flow.postmortem.id}` : "Waiting for postmortem indexed in Splunk"} />
        </div>

        <div className="space-y-3 border border-border bg-panel p-3">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-deep">Latest incident</div>
            <div className="mt-1 break-words text-[14px] text-foreground">{flow?.incident?.title ?? "None yet"}</div>
            <div className="mt-2 font-mono text-[12px] uppercase tracking-[0.06em] text-muted">{flow?.incident?.status ?? "waiting"}</div>
          </div>
          {flow?.incident ? (
            <Link href={`/incidents/${flow.incident.id}`} className="inline-flex border border-active px-3 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-active">
              Open incident
            </Link>
          ) : null}
          <div className="border-t border-border pt-3">
            <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-deep">Audit phases</div>
            <div className="mt-2 flex flex-wrap gap-1">
              {(flow?.audit ?? []).map((entry) => (
                <span key={entry.id} className="border border-border bg-background px-2 py-1 font-mono text-[10px] uppercase tracking-[0.06em] text-muted">
                  {entry.phase}
                </span>
              ))}
              {flow && flow.audit.length === 0 ? <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-muted">none</span> : null}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
