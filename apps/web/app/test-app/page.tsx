"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  createProject,
  fetchProjectFlow,
  ingestProjectLogs,
  isUnauthorizedError,
  storedToken,
  type Project,
  type ProjectFlow,
  type ProjectLogInput
} from "@/lib/api";

const TEST_PROJECT_STORAGE_KEY = "operaiq_test_project_id";

function stamp(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

function hardFailureLogs(project: Project): ProjectLogInput[] {
  const now = Date.now();
  const traceId = `checkout-${stamp()}`;
  const base = {
    service: project.service || "payment-service",
    route: "/api/checkout/confirm",
    traceId,
    requestId: `${traceId}-req`,
    errorName: "RedisConnectionPoolExhausted",
    metadata: {
      projectId: project._key,
      projectName: project.name,
      queueDepth: 918,
      poolWaiters: 143,
      tenant: "human-browser-test"
    }
  };
  return [
    {
      ...base,
      level: "error",
      statusCode: 503,
      latencyMs: 4812,
      timestamp: new Date(now - 6200).toISOString(),
      message: "ECONNRESET while reserving checkout inventory; Redis connection pool exhausted before payment authorization.",
      stack: "RedisConnectionPoolExhausted: ECONNRESET payment-service checkout reservation\n    at reserveInventory (/srv/app/checkout/reserve.ts:118:21)\n    at confirmCheckout (/srv/app/routes/checkout.ts:77:13)"
    },
    {
      ...base,
      level: "error",
      statusCode: 503,
      latencyMs: 5294,
      timestamp: new Date(now - 5100).toISOString(),
      message: "UnhandledPromiseRejection: ECONNRESET from redis-cache after 143 pool waiters; checkout confirmation failed.",
      stack: "UnhandledPromiseRejection: Redis socket closed during MULTI EXEC\n    at RedisPipeline.exec (/srv/app/lib/redis.ts:44:17)\n    at confirmCheckout (/srv/app/routes/checkout.ts:91:9)"
    },
    {
      ...base,
      level: "fatal",
      statusCode: 500,
      latencyMs: 6077,
      timestamp: new Date(now - 4100).toISOString(),
      message: "FATAL checkout write collapse: ECONNRESET, pool waiters 143, circuit breaker open, payment-service cannot finalize orders.",
      stack: "FatalCheckoutWriteCollapse: payment-service Redis ECONNRESET storm\n    at writeOrderLedger (/srv/app/orders/ledger.ts:203:11)\n    at confirmCheckout (/srv/app/routes/checkout.ts:109:15)"
    },
    {
      ...base,
      level: "error",
      statusCode: 502,
      latencyMs: 4419,
      timestamp: new Date(now - 3200).toISOString(),
      message: "ECONNRESET repeated on redis-cache pipeline; retry budget exhausted for checkout ledger write.",
      stack: "RetryBudgetExhausted: redis-cache ECONNRESET after 5 attempts\n    at retryPipeline (/srv/app/lib/retry.ts:58:9)"
    },
    {
      ...base,
      level: "error",
      statusCode: 503,
      latencyMs: 5733,
      timestamp: new Date(now - 2300).toISOString(),
      message: "payment-service p99 latency breached 5s while ECONNRESET errors saturate Redis checkout sessions.",
      stack: "LatencyBudgetExceeded: checkout p99=5733ms redis ECONNRESET\n    at recordLatency (/srv/app/metrics.ts:32:5)"
    },
    {
      ...base,
      level: "error",
      statusCode: 500,
      latencyMs: 6488,
      timestamp: new Date(now - 1400).toISOString(),
      message: "ECONNRESET and connection pool exhausted during order finalization; customer checkout failed after payment token created.",
      stack: "OrderFinalizationFailed: token created but ledger write failed\n    at finalizeOrder (/srv/app/orders/finalize.ts:149:19)"
    },
    {
      ...base,
      level: "error",
      statusCode: 503,
      latencyMs: 7021,
      timestamp: new Date(now - 500).toISOString(),
      message: "Redis connection pool exhausted: checkout-api now returning 503 for payment-service confirm route.",
      stack: "ServiceUnavailable: checkout confirm route hot after redis ECONNRESET\n    at routeHandler (/srv/app/routes/checkout.ts:131:7)"
    }
  ];
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
    }, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [project?._key, router]);

  const done = useMemo(() => flow?.stages ?? {
    appLogsStored: false,
    qdrantPatternMatched: false,
    webhookFired: false,
    operaiqActed: false,
    operaiqVerified: false,
    qdrantPostmortemStored: false
  }, [flow]);

  async function createFreshProject(): Promise<void> {
    setBusy("project");
    setError(null);
    setLastAccepted(null);
    try {
      const result = await createProject({
        name: `Browser checkout failure ${stamp()}`,
        service: "payment-service",
        environment: "local-browser"
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
          <p className="mt-1 max-w-[760px] text-[13px] text-muted">Browser-driven app failure proving logs to Qdrant, Qdrant pattern match, webhook, and OperaIQ action.</p>
        </div>
        <div className="font-mono text-[12px] uppercase tracking-[0.06em] text-muted-deep">poll: 2s</div>
      </section>

      <section className="grid gap-3 border border-border bg-panel p-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
        <div className="min-w-0">
          <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-deep">External app project</div>
          <h2 className="mt-1 break-words font-mono text-[14px] uppercase tracking-[0.06em] text-foreground">{project?.name ?? "No project created yet"}</h2>
          <div className="mt-3 grid gap-2 font-mono text-[12px] text-muted sm:grid-cols-2">
            <div className="border border-border bg-background p-2">Project: <span className="text-foreground">{project?._key ?? "--"}</span></div>
            <div className="border border-border bg-background p-2">Service: <span className="text-foreground">{project?.service ?? "payment-service"}</span></div>
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
      {lastAccepted !== null ? <div className="border border-border bg-panel px-3 py-2 font-mono text-[12px] uppercase tracking-[0.08em] text-accent">Qdrant accepted {lastAccepted} log events</div> : null}

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="overflow-hidden border border-border bg-panel">
          <StageRow label="Your app" done={done.appLogsStored} detail={`${flow?.counts.logsStored ?? 0} log events stored in Qdrant`} />
          <StageRow label="Qdrant watcher" done={done.qdrantPatternMatched} detail={flow?.latestPatternAlert ? `Matched ${String(flow.latestPatternAlert.fingerprint ?? "pattern")}` : "Waiting for pattern document"} />
          <StageRow label="Webhook" done={done.webhookFired} detail={flow?.incident ? `Created incident ${flow.incident.id}` : "Waiting for /webhooks/qdrant-pattern"} />
          <StageRow label="OperaIQ act" done={done.operaiqActed} detail={done.operaiqActed ? "ACT phase recorded in Qdrant audit log" : "Waiting for agent ACT phase"} />
          <StageRow label="OperaIQ verify" done={done.operaiqVerified} detail={done.operaiqVerified ? "VERIFY phase recorded after remediation" : "Waiting for Qdrant verification"} />
          <StageRow label="Qdrant close" done={done.qdrantPostmortemStored} detail={flow?.postmortem ? `Postmortem ${flow.postmortem.id}` : "Waiting for postmortem memory"} />
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
