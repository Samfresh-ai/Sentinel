import { getSplunkConfig } from "./client.js";
import { queryDocuments } from "./kvstore.js";
import { runSearch } from "./search.js";
import type { SimilarIncident } from "./types.js";

function tokenize(values: string[]): string[] {
  const stopwords = new Set(["sentinel", "test-timing", "service", "app", "prod", "alert"]);
  return [
    ...new Set(
      values
        .flatMap((value) => value.toLowerCase().match(/[a-z0-9]+/g) ?? [])
        .filter((token) => token.length > 2 && !stopwords.has(token))
    )
  ].slice(0, 16);
}

function quoteTerm(term: string): string {
  return `"${term.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function likeTerm(term: string): string {
  return `"%${term.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}%"`;
}

function stringField(doc: Record<string, unknown>, key: string): string {
  const value = doc[key];
  return typeof value === "string" ? value : "";
}

function numberField(doc: Record<string, unknown>, key: string): number | null {
  const value = doc[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function arrayField(doc: Record<string, unknown>, key: string): string[] {
  const value = doc[key];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return value.split(/\s*[,;]\s*/).filter((item) => item.length > 0);
    }
  }
  return [];
}

function symptomSimilarity(queryTerms: string[], candidateSymptoms: string[]): number {
  if (queryTerms.length === 0) return 0;
  const candidateTerms = tokenize(candidateSymptoms);
  if (candidateTerms.length === 0) return 0;
  const matched = candidateTerms.filter((term) => queryTerms.includes(term)).length;
  return Number(Math.min(0.95, matched / Math.max(1, candidateTerms.length - 1)).toFixed(4));
}

function mapSimilarIncident(doc: Record<string, unknown>, similarity: number): SimilarIncident {
  return {
    id: stringField(doc, "incidentId") || stringField(doc, "_key"),
    title: stringField(doc, "title") || "Splunk post-mortem match",
    rootCause: stringField(doc, "rootCause") || null,
    resolution: stringField(doc, "resolution") || null,
    remediationSteps: arrayField(doc, "remediationSteps"),
    durationMinutes: numberField(doc, "durationMinutes"),
    severity: stringField(doc, "severity") || "P3",
    similarity
  };
}

export interface FindSimilarIncidentOptions {
  currentIncidentId?: string;
  orgId: string;
}

export async function findSimilarIncidents(symptoms: string[], limit = 5, options: FindSimilarIncidentOptions): Promise<SimilarIncident[]> {
  const terms = tokenize(symptoms);
  if (terms.length === 0) return [];
  const config = getSplunkConfig();
  const symptomWhere = terms.map((term) => `like(symptom_text, ${likeTerm(term)})`).join(" OR ");
  const currentFilter = [
    options.currentIncidentId ? `| where incidentId != ${quoteTerm(options.currentIncidentId)}` : ""
  ]
    .filter(Boolean)
    .join(" ");
  const spl = [
    `search index=${config.SPLUNK_INDEX} sourcetype=sentinel:postmortem`,
    "| spath path=event.symptoms{} output=event_symptoms",
    "| spath path=symptoms{} output=root_symptoms",
    "| spath path=event.incidentId output=event_incidentId",
    "| spath path=event.title output=event_title",
    "| spath path=event.rootCause output=event_rootCause",
    "| spath path=event.resolution output=event_resolution",
    "| spath path=event.remediationSteps{} output=event_remediationSteps",
    "| spath path=event.durationMinutes output=event_durationMinutes",
    "| spath path=event.severity output=event_severity",
    "| spath path=event.createdAt output=event_createdAt",
    "| spath path=event.orgId output=event_orgId",
    "| eval symptoms=mvappend(event_symptoms, root_symptoms)",
    "| eval symptom_text=lower(mvjoin(symptoms, \" \"))",
    `| where ${symptomWhere}`,
    "| eval incidentId=coalesce(event_incidentId, incidentId)",
    "| eval title=coalesce(event_title, title)",
    "| eval rootCause=coalesce(event_rootCause, rootCause)",
    "| eval resolution=coalesce(event_resolution, resolution)",
    "| eval remediationSteps=mvappend(event_remediationSteps, remediationSteps)",
    "| eval durationMinutes=coalesce(event_durationMinutes, durationMinutes)",
    "| eval severity=coalesce(event_severity, severity)",
    "| eval createdAt=coalesce(event_createdAt, createdAt)",
    "| eval orgId=coalesce(event_orgId, orgId)",
    `| where orgId = ${quoteTerm(options.orgId)}`,
    currentFilter,
    "| table _key incidentId title rootCause resolution remediationSteps durationMinutes severity symptoms createdAt"
  ].join(" ");
  const indexedResults = await runSearch(spl, { maxResults: 100 });
  const kvResults = await queryDocuments<Record<string, unknown>>("incidents", { status: "resolved" }, 500, { orgId: options.orgId }).catch(() => []);
  const byId = new Map<string, SimilarIncident>();

  for (const doc of [...indexedResults, ...kvResults]) {
    const id = stringField(doc, "incidentId") || stringField(doc, "_key");
    if (!id) continue;
    if (options.currentIncidentId && id === options.currentIncidentId) continue;
    const similarity = symptomSimilarity(terms, arrayField(doc, "symptoms"));
    if (similarity <= 0) continue;
    const incident = mapSimilarIncident(doc, similarity);
    const existing = byId.get(id);
    if (!existing || incident.similarity > existing.similarity) {
      byId.set(id, incident);
    }
  }

  return [...byId.values()].sort((left, right) => right.similarity - left.similarity).slice(0, limit);
}
