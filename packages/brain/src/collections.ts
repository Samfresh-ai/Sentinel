import type { Collection } from "mongodb";
import { getDb } from "./client.js";
import type {
  IncidentDocument,
  PatternDocument,
  PostmortemDocument,
  RemediationExecutionDocument,
  RunbookDocument,
  ServiceDocument,
  ServiceRuntimeConfigDocument
} from "./types.js";

export async function incidentsCollection(): Promise<Collection<IncidentDocument>> {
  return (await getDb()).collection<IncidentDocument>("incidents");
}

export async function servicesCollection(): Promise<Collection<ServiceDocument>> {
  return (await getDb()).collection<ServiceDocument>("services");
}

export async function serviceRuntimeConfigsCollection(): Promise<Collection<ServiceRuntimeConfigDocument>> {
  return (await getDb()).collection<ServiceRuntimeConfigDocument>("service_runtime_configs");
}

export async function runbooksCollection(): Promise<Collection<RunbookDocument>> {
  return (await getDb()).collection<RunbookDocument>("runbooks");
}

export async function postmortemsCollection(): Promise<Collection<PostmortemDocument>> {
  return (await getDb()).collection<PostmortemDocument>("postmortems");
}

export async function patternsCollection(): Promise<Collection<PatternDocument>> {
  return (await getDb()).collection<PatternDocument>("patterns");
}

export async function remediationExecutionsCollection(): Promise<Collection<RemediationExecutionDocument>> {
  return (await getDb()).collection<RemediationExecutionDocument>("remediation_executions");
}
