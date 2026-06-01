import {
  datadogMonitorPayloadSchema,
  genericSentinelAlertPayloadSchema,
  normalizedAlertSchema,
  pagerDutyWebhookPayloadSchema,
  prometheusAlertSchema,
  type NormalizedAlert,
  type Severity
} from "./schemas.js";

function severityFromText(value: string | undefined): Severity {
  const normalized = value?.toUpperCase() ?? "";
  if (normalized.includes("P1") || normalized.includes("CRITICAL")) return "P1";
  if (normalized.includes("P2") || normalized.includes("HIGH") || normalized.includes("ERROR")) return "P2";
  if (normalized.includes("P3") || normalized.includes("WARN")) return "P3";
  return "P4";
}

function splitSignals(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,;\n]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 12);
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function serviceFromTags(tags: string[] | string | undefined): string | undefined {
  const tagList = Array.isArray(tags) ? tags : typeof tags === "string" ? tags.split(",") : [];
  const serviceTag = tagList.find((tag) => tag.startsWith("service:"));
  return serviceTag?.replace("service:", "").trim();
}

export function normalizeAlertPayload(payload: unknown): NormalizedAlert {
  const generic = genericSentinelAlertPayloadSchema.safeParse(payload);
  if (generic.success) {
    return normalizedAlertSchema.parse({
      source: "operaiq",
      title: generic.data.title,
      severity: generic.data.severity,
      affectedServices: [generic.data.service],
      symptoms: generic.data.symptoms,
      incidentType: generic.data.incidentType,
      detectedAt: generic.data.detectedAt ?? new Date().toISOString(),
      rawPayload: recordFromUnknown(payload)
    });
  }

  const pagerDuty = pagerDutyWebhookPayloadSchema.safeParse(payload);
  if (pagerDuty.success && pagerDuty.data.event?.data) {
    const data = pagerDuty.data.event.data;
    const details = data.body?.details ?? {};
    const symptoms = [
      ...splitSignals(typeof details.symptoms === "string" ? details.symptoms : undefined),
      ...splitSignals(typeof data.summary === "string" ? data.summary : undefined),
      ...splitSignals(typeof data.title === "string" ? data.title : undefined)
    ];
    return normalizedAlertSchema.parse({
      source: "pagerduty",
      title: data.title ?? data.summary ?? "PagerDuty incident",
      severity: severityFromText(data.priority?.summary ?? data.urgency),
      affectedServices: [data.service?.summary ?? "unknown-service"],
      symptoms: symptoms.length > 0 ? symptoms : ["pagerduty incident triggered"],
      detectedAt: pagerDuty.data.event.occurred_at ?? new Date().toISOString(),
      rawPayload: recordFromUnknown(payload)
    });
  }

  const prometheus = prometheusAlertSchema.safeParse(payload);
  if (prometheus.success && prometheus.data.alerts && prometheus.data.alerts.length > 0) {
    const first = prometheus.data.alerts[0];
    const labels = first?.labels ?? {};
    const annotations = first?.annotations ?? {};
    const service = labels.service ?? labels.job ?? labels.app ?? "unknown-service";
    const title = annotations.summary ?? labels.alertname ?? "Prometheus alert";
    const symptoms = [
      annotations.description,
      annotations.summary,
      labels.alertname,
      prometheus.data.status
    ].filter((item): item is string => typeof item === "string" && item.length > 0);
    return normalizedAlertSchema.parse({
      source: "prometheus",
      title,
      severity: severityFromText(labels.severity ?? prometheus.data.status),
      affectedServices: [service],
      symptoms: symptoms.length > 0 ? symptoms : ["prometheus alert firing"],
      detectedAt: first?.startsAt ?? new Date().toISOString(),
      rawPayload: recordFromUnknown(payload)
    });
  }

  const datadog = datadogMonitorPayloadSchema.safeParse(payload);
  if (datadog.success) {
    const service = datadog.data.service ?? serviceFromTags(datadog.data.tags) ?? datadog.data.host ?? "unknown-service";
    const symptoms = [
      ...splitSignals(datadog.data.message),
      ...splitSignals(datadog.data.alert_type),
      ...splitSignals(datadog.data.title ?? datadog.data.alert_title)
    ];
    return normalizedAlertSchema.parse({
      source: "datadog",
      title: datadog.data.title ?? datadog.data.alert_title ?? "Datadog monitor alert",
      severity: severityFromText(datadog.data.priority ?? datadog.data.alert_type),
      affectedServices: [service],
      symptoms: symptoms.length > 0 ? symptoms : ["datadog monitor alert"],
      detectedAt:
        typeof datadog.data.date === "string"
          ? new Date(datadog.data.date).toISOString()
          : typeof datadog.data.date === "number"
            ? new Date(datadog.data.date * 1000).toISOString()
            : new Date().toISOString(),
      rawPayload: recordFromUnknown(payload)
    });
  }

  throw new Error("Unsupported alert payload");
}
