import type {
  IncidentDocument,
  PatternDocument,
  PostmortemDocument,
  RunbookDocument,
  ServiceDocument
} from "@operaiq/brain";

export function serializeIncident(incident: IncidentDocument): Record<string, unknown> {
  return {
    id: incident._id.toHexString(),
    title: incident.title,
    severity: incident.severity,
    status: incident.status,
    symptoms: incident.symptoms,
    affectedServices: incident.affectedServices,
    rootCause: incident.rootCause,
    resolution: incident.resolution,
    remediationSteps: incident.remediationSteps,
    detectedAt: incident.detectedAt.toISOString(),
    resolvedAt: incident.resolvedAt?.toISOString() ?? null,
    durationMinutes: incident.durationMinutes,
    postMortemId: incident.postMortemId?.toHexString() ?? null,
    createdAt: incident.createdAt.toISOString(),
    updatedAt: incident.updatedAt.toISOString(),
    embeddingDimensions: incident.embedding.length
  };
}

export function serializeService(service: ServiceDocument): Record<string, unknown> {
  return {
    id: service._id.toHexString(),
    name: service.name,
    team: service.team,
    language: service.language,
    dependencies: service.dependencies,
    dependents: service.dependents,
    knownFragilePoints: service.knownFragilePoints,
    slaMs: service.slaMs,
    owners: service.owners,
    runbookIds: service.runbookIds.map((id) => id.toHexString()),
    createdAt: service.createdAt.toISOString(),
    updatedAt: service.updatedAt.toISOString()
  };
}

export function serializeRunbook(runbook: RunbookDocument): Record<string, unknown> {
  return {
    id: runbook._id.toHexString(),
    title: runbook.title,
    incidentType: runbook.incidentType,
    steps: runbook.steps,
    applicableServices: runbook.applicableServices,
    successCriteria: runbook.successCriteria,
    createdAt: runbook.createdAt.toISOString(),
    updatedAt: runbook.updatedAt.toISOString()
  };
}

export function serializePostmortem(postmortem: PostmortemDocument): Record<string, unknown> {
  return {
    id: postmortem._id.toHexString(),
    incidentId: postmortem.incidentId.toHexString(),
    title: postmortem.title,
    summary: postmortem.summary,
    timeline: postmortem.timeline.map((item) => ({
      timestamp: item.timestamp.toISOString(),
      event: item.event,
      actor: item.actor
    })),
    rootCause: postmortem.rootCause,
    contributingFactors: postmortem.contributingFactors,
    remediationTaken: postmortem.remediationTaken,
    preventionActions: postmortem.preventionActions,
    lessonLearned: postmortem.lessonLearned,
    generatedBy: postmortem.generatedBy,
    createdAt: postmortem.createdAt.toISOString()
  };
}

export function serializePattern(pattern: PatternDocument): Record<string, unknown> {
  return {
    id: pattern._id.toHexString(),
    name: pattern.name,
    symptomSignals: pattern.symptomSignals,
    likelyCauses: pattern.likelyCauses,
    confirmedCount: pattern.confirmedCount,
    createdAt: pattern.createdAt.toISOString(),
    updatedAt: pattern.updatedAt.toISOString()
  };
}
