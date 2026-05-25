"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fetchBrainStats, fetchIncidents, type BrainStats, type Incident } from "@/lib/api";

function severityClass(severity: Incident["severity"]): string {
  if (severity === "P1") return "border-red-500 bg-red-500 text-white";
  if (severity === "P2") return "border-orange-500 bg-orange-500 text-background";
  if (severity === "P3") return "border-yellow-400 bg-yellow-400 text-background";
  return "border-border bg-panel text-muted";
}

function statusClass(status: Incident["status"]): string {
  if (status === "open") return "border-red-500 text-red-400";
  if (status === "in_progress") return "border-accent text-accent";
  return "border-border text-muted";
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

export default function IncidentFeedPage() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [stats, setStats] = useState<BrainStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load(): Promise<void> {
    try {
      const [incidentResponse, statResponse] = await Promise.all([fetchIncidents(), fetchBrainStats()]);
      setIncidents(incidentResponse.items);
      setStats(statResponse);
      setError(null);
    } catch (loadError: unknown) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load incidents");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => {
      void load();
    }, 10_000);
    return () => window.clearInterval(interval);
  }, []);

  const counts = useMemo(() => {
    return stats?.statusCounts ?? { open: 0, inProgress: 0, resolvedToday: 0 };
  }, [stats]);

  return (
    <div className="space-y-5">
      <section className="flex flex-col justify-between gap-3 border-b border-border pb-5 md:flex-row md:items-end">
        <div>
          <h1 className="font-mono text-2xl font-semibold tracking-normal">Incident Feed</h1>
          <p className="mt-1 text-sm text-muted">Brain: {stats?.incidentCount ?? 0} incidents</p>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted">
          <RefreshCw className="h-4 w-4 text-accent" aria-hidden="true" />
          Auto-refreshes every 10 seconds
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-3">
        <Card>
          <CardContent>
            <div className="text-xs uppercase text-muted">Open</div>
            <div className="mt-2 font-mono text-3xl text-red-400">{counts.open}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <div className="text-xs uppercase text-muted">In Progress</div>
            <div className="mt-2 font-mono text-3xl text-accent">{counts.inProgress}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <div className="text-xs uppercase text-muted">Resolved Today</div>
            <div className="mt-2 font-mono text-3xl text-foreground">{counts.resolvedToday}</div>
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Newest First</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          {error ? <div className="p-4 text-sm text-red-400">{error}</div> : null}
          {loading ? <div className="p-4 text-sm text-muted">Loading incidents</div> : null}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-20">Sev</TableHead>
                <TableHead>Title</TableHead>
                <TableHead className="hidden md:table-cell">Services</TableHead>
                <TableHead className="w-32">Status</TableHead>
                <TableHead className="w-24">Detected</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {incidents.map((incident) => (
                <TableRow key={incident.id} className="hover:bg-background">
                  <TableCell>
                    <Badge className={severityClass(incident.severity)}>{incident.severity}</Badge>
                  </TableCell>
                  <TableCell>
                    <Link href={`/incidents/${incident.id}`} className="block truncate text-foreground hover:text-accent">
                      {incident.title}
                    </Link>
                  </TableCell>
                  <TableCell className="hidden text-muted md:table-cell">{incident.affectedServices.join(", ")}</TableCell>
                  <TableCell>
                    <Badge className={statusClass(incident.status)}>{incident.status}</Badge>
                  </TableCell>
                  <TableCell className="text-muted">{timeAgo(incident.detectedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
