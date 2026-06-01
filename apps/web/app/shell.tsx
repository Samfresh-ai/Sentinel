"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { AUTH_CHANGED_EVENT, clearStoredToken, fetchBrainStats, fetchMe, isUnauthorizedError, storedToken, type BrainStats } from "@/lib/api";

function navClass(active: boolean): string {
  return [
    "block border-l px-4 py-2 font-mono text-[13px] uppercase tracking-[0.06em]",
    active ? "border-active bg-elevated text-foreground" : "border-transparent text-muted hover:border-border hover:bg-panel hover:text-foreground"
  ].join(" ");
}

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

function StatusDot({ label, live = true }: { label: string; live?: boolean }) {
  return (
    <div className="flex items-center gap-2 font-mono text-[12px] uppercase tracking-[0.06em] text-muted">
      <span className={`h-2 w-2 rounded-full ${live ? "status-dot-live bg-accent" : "bg-critical"}`} />
      {label}
    </div>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [stats, setStats] = useState<BrainStats | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [authVersion, setAuthVersion] = useState(0);
  const [sessionStatus, setSessionStatus] = useState<"checking" | "authenticated" | "unauthenticated" | "failed">("checking");
  const isAuthRoute = pathname === "/setup";

  useEffect(() => {
    function onAuthChanged(): void {
      setAuthVersion((version) => version + 1);
    }
    window.addEventListener(AUTH_CHANGED_EVENT, onAuthChanged);
    return () => window.removeEventListener(AUTH_CHANGED_EVENT, onAuthChanged);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const nextToken = storedToken();
    setAuthToken(nextToken);
    if (isAuthRoute) {
      setSessionStatus(nextToken ? "authenticated" : "unauthenticated");
      return;
    }
    if (!nextToken) {
      setSessionStatus("unauthenticated");
      router.replace("/setup");
      return;
    }

    setSessionStatus((current) => (current === "authenticated" ? current : "checking"));
    fetchMe()
      .then(() => {
        if (!cancelled) setSessionStatus("authenticated");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (isUnauthorizedError(error)) {
          clearStoredToken();
          setAuthToken(null);
          setSessionStatus("unauthenticated");
          router.replace("/setup");
          return;
        }
        setSessionStatus("failed");
      });

    return () => {
      cancelled = true;
    };
  }, [authVersion, isAuthRoute, pathname, router]);

  const showChrome = Boolean(authToken) && sessionStatus === "authenticated" && !isAuthRoute;

  useEffect(() => {
    if (!showChrome) {
      setStats(null);
      return;
    }
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const next = await fetchBrainStats();
        if (!cancelled) setStats(next);
      } catch (error: unknown) {
        if (cancelled) return;
        if (isUnauthorizedError(error)) {
          clearStoredToken();
          setAuthToken(null);
          setSessionStatus("unauthenticated");
          router.replace("/setup");
        }
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
  }, [router, showChrome]);

  const lastResolved = useMemo(() => {
    return stats?.recentPostmortems[0]?.createdAt;
  }, [stats]);

  if (isAuthRoute) {
    return <div className="min-h-screen bg-background text-foreground">{children}</div>;
  }

  if (!showChrome) {
    const copy =
      sessionStatus === "failed"
        ? "OperaIQ API is not responding. Refreshing will retry the session check."
        : sessionStatus === "unauthenticated"
          ? "Redirecting to setup"
          : "Checking OperaIQ session";
    return (
      <div className="min-h-screen bg-background text-foreground">
        <main className="flex min-h-screen items-center justify-center px-4">
          <div className="space-y-3 text-center">
            <div className="font-mono text-[12px] uppercase tracking-[0.08em] text-muted">{copy}</div>
            {sessionStatus === "failed" ? (
              <button
                type="button"
                onClick={() => setAuthVersion((version) => version + 1)}
                className="border border-border px-3 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-foreground hover:border-active"
              >
                Retry
              </button>
            ) : null}
            {sessionStatus === "unauthenticated" ? (
              <Link href="/setup" className="block font-mono text-[11px] uppercase tracking-[0.08em] text-active">
                Open setup
              </Link>
            ) : null}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="h-14 border-b border-border bg-background">
        <div className="flex h-full items-center justify-between gap-4 px-5">
          <Link href="/" className="font-mono text-[15px] font-semibold uppercase tracking-[0.18em] text-foreground">
            OPERAIQ
          </Link>
          <div className="hidden min-w-0 truncate font-mono text-[12px] text-muted sm:block">
            Brain: <span className="text-accent">{stats?.incidentCount ?? "--"}</span> incidents · Last resolved:{" "}
            <span className="text-foreground">{timeAgo(lastResolved)}</span>
          </div>
        </div>
      </header>
      <div className="grid min-h-[calc(100vh-56px)] grid-cols-1 md:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="border-b border-border bg-background md:border-b-0 md:border-r">
          <div className="flex gap-2 overflow-x-auto p-3 md:block md:space-y-1 md:p-4">
            <Link href="/" className={navClass(pathname === "/" || pathname.startsWith("/incidents"))}>
              Incidents
            </Link>
            <Link href="/brain" className={navClass(pathname === "/brain")}>
              Brain
            </Link>
            <Link href="/qdrant" className={navClass(pathname === "/qdrant")}>
              Qdrant
            </Link>
            <Link href="/test-app" className={navClass(pathname === "/test-app")}>
              Test App
            </Link>
            <Link href="/services" className={navClass(pathname === "/services")}>
              Services
            </Link>
          </div>
          <div className="hidden border-t border-border p-4 md:block">
            <div className="mb-3 font-mono text-[11px] uppercase tracking-[0.08em] text-muted-deep">Status</div>
            <div className="space-y-3">
              <StatusDot label="Qdrant" />
              <StatusDot label="Agent" />
              <StatusDot label="Memory" />
            </div>
          </div>
        </aside>
        <main className="min-w-0 p-4 md:p-5">{children}</main>
      </div>
    </div>
  );
}
