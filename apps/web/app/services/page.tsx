"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchServices, type Service } from "@/lib/api";

export default function ServicesPage() {
  const [services, setServices] = useState<Service[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchServices()
      .then((response) => setServices(response.items))
      .catch((loadError: unknown) => {
        setError(loadError instanceof Error ? loadError.message : "Unable to load services");
      });
  }, []);

  return (
    <div className="space-y-5">
      <section className="border-b border-border pb-5">
        <h1 className="font-mono text-2xl font-semibold tracking-normal">Services</h1>
        <p className="mt-1 text-sm text-muted">Dependency graph from MongoDB service memory</p>
      </section>

      {error ? <div className="border border-red-500 p-3 text-sm text-red-300">{error}</div> : null}

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {services.map((service) => {
          const open = expanded === service.id;
          return (
            <Card key={service.id}>
              <button
                type="button"
                onClick={() => setExpanded(open ? null : service.id)}
                className="flex w-full items-center justify-between border-b border-border px-4 py-3 text-left"
              >
                <div>
                  <CardTitle className="text-foreground">{service.name}</CardTitle>
                  <div className="mt-1 text-xs text-muted">{service.team}</div>
                </div>
                {open ? <ChevronDown className="h-4 w-4 text-accent" /> : <ChevronRight className="h-4 w-4 text-muted" />}
              </button>
              <CardContent className="space-y-3 text-sm">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-xs uppercase text-muted">Dependencies</div>
                    <div className="mt-1 font-mono text-xl">{service.dependencies.length}</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase text-muted">SLA</div>
                    <div className="mt-1 font-mono text-xl">{service.slaMs}ms</div>
                  </div>
                </div>
                {open ? (
                  <div className="space-y-3 border-t border-border pt-3">
                    <div>
                      <div className="mb-1 text-xs uppercase text-muted">Depends On</div>
                      <div className="text-muted">{service.dependencies.length ? service.dependencies.join(", ") : "None"}</div>
                    </div>
                    <div>
                      <div className="mb-1 text-xs uppercase text-muted">Dependents</div>
                      <div className="text-muted">{service.dependents.length ? service.dependents.join(", ") : "None"}</div>
                    </div>
                    <div>
                      <div className="mb-1 text-xs uppercase text-muted">Fragile Points</div>
                      <ul className="list-inside list-disc text-muted">
                        {service.knownFragilePoints.map((point) => (
                          <li key={point}>{point}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </section>
    </div>
  );
}
