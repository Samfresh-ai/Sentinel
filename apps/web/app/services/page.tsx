"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { fetchServices, isUnauthorizedError, type Service } from "@/lib/api";

export default function ServicesPage() {
  const [services, setServices] = useState<Service[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchServices()
      .then((response) => {
        setServices(response.items);
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (isUnauthorizedError(loadError)) return;
        setError(loadError instanceof Error ? loadError.message : "Unable to load services");
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  return (
    <div className="min-w-0 space-y-4">
      <section className="border-b border-border pb-4">
        <h1 className="font-mono text-[16px] uppercase tracking-[0.08em] text-foreground">Services</h1>
        <p className="mt-1 text-[13px] text-muted">Dependency graph and fragile points used by the agent.</p>
      </section>

      {error ? <div className="border border-critical bg-panel px-3 py-2 text-[13px] text-critical">{error}</div> : null}

      <section className="overflow-hidden border border-border bg-panel">
        {loading ? <div className="border-b border-border px-3 py-2 font-mono text-[12px] text-muted">Loading service graph</div> : null}
        {services.map((service) => {
          const open = expanded === service.id;
          return (
            <div key={service.id} className="border-b border-border last:border-b-0">
              <button
                type="button"
                onClick={() => setExpanded(open ? null : service.id)}
                className="grid w-full grid-cols-[minmax(180px,1fr)_minmax(120px,0.6fr)_90px_100px_74px_26px] items-center gap-3 px-3 py-3 text-left hover:bg-elevated"
              >
                <span className="truncate text-[14px] text-foreground">{service.name}</span>
                <span className="truncate font-mono text-[12px] text-muted">{service.team}</span>
                <span className="font-mono text-[12px] text-mono">{service.language}</span>
                <span className="font-mono text-[12px] text-muted">SLA: {service.slaMs}ms</span>
                <span className="font-mono text-[12px] text-muted">deps: {service.dependencies.length}</span>
                {open ? <ChevronDown className="h-4 w-4 text-active" aria-hidden="true" /> : <ChevronRight className="h-4 w-4 text-muted" aria-hidden="true" />}
              </button>
              <div className={`service-details ${open ? "open" : ""}`}>
                <div className="grid gap-4 border-t border-border px-3 py-3 text-[13px] text-muted md:grid-cols-3">
                  <div>
                    <div className="mb-1 font-mono text-[11px] uppercase tracking-[0.06em] text-muted-deep">Depends on</div>
                    <div>{service.dependencies.length ? service.dependencies.join(", ") : "None"}</div>
                  </div>
                  <div>
                    <div className="mb-1 font-mono text-[11px] uppercase tracking-[0.06em] text-muted-deep">Dependents</div>
                    <div>{service.dependents.length ? service.dependents.join(", ") : "None"}</div>
                  </div>
                  <div>
                    <div className="mb-1 font-mono text-[11px] uppercase tracking-[0.06em] text-muted-deep">Fragile points</div>
                    <div>{service.knownFragilePoints.length ? service.knownFragilePoints.join(", ") : "None recorded"}</div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        {!loading && services.length === 0 ? <div className="px-3 py-6 text-center font-mono text-[12px] text-muted">No services indexed yet.</div> : null}
      </section>
    </div>
  );
}
