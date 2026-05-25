import { getSplunkConfig } from "./client.js";
import { runSearch } from "./search.js";
import type { SimilarIncident } from "./types.js";

function tokenize(values: string[]): string[] {
  return [
    ...new Set(
      values
        .flatMap((value) => value.toLowerCase().match(/[a-z0-9]+/g) ?? [])
        .filter((token) => token.length > 2)
    )
  ].slice(0, 16);
}

function quoteTerm(term: string): string {
  return `"${term.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
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

export async function findSimilarIncidents(symptoms: string[], limit = 5): Promise<SimilarIncident[]> {
  const terms = tokenize(symptoms);
  if (terms.length === 0) return [];
  const config = getSplunkConfig();
  const searchExpression = terms.map(quoteTerm).join(" OR ");
  const evalMatches = terms
    .map((term) => `if(match(lower(_raw), "${term.replaceAll("\"", "\\\"")}"), 1, 0)`)
    .join(" + ");
  const spl = [
    `search index=${config.SPLUNK_INDEX} sourcetype=sentinel:postmortem (${searchExpression})`,
    `| eval matched_terms=${evalMatches}`,
    `| eval relevance_score=round(matched_terms/${terms.length}, 4)`,
    "| sort - relevance_score",
    `| head ${limit}`,
    "| table _key incidentId title rootCause resolution remediationSteps durationMinutes severity relevance_score"
  ].join(" ");
  const results = await runSearch(spl, { maxResults: limit });
  return results.map((doc) => ({
    id: stringField(doc, "incidentId") || stringField(doc, "_key"),
    title: stringField(doc, "title") || "Splunk post-mortem match",
    rootCause: stringField(doc, "rootCause") || null,
    resolution: stringField(doc, "resolution") || null,
    remediationSteps: arrayField(doc, "remediationSteps"),
    durationMinutes: numberField(doc, "durationMinutes"),
    severity: stringField(doc, "severity") || "P3",
    similarity: numberField(doc, "relevance_score") ?? 0
  }));
}
