import type { ObjectId } from "mongodb";
import type { IncidentStatus, RiskLevel, Severity } from "@operaiq/shared";

export interface IncidentDocument {
  _id: ObjectId;
  title: string;
  severity: Severity;
  status: IncidentStatus;
  symptoms: string[];
  affectedServices: string[];
  rootCause: string | null;
  resolution: string | null;
  remediationSteps: string[];
  detectedAt: Date;
  resolvedAt: Date | null;
  durationMinutes: number | null;
  embedding: number[];
  postMortemId: ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ServiceDocument {
  _id: ObjectId;
  name: string;
  team: string;
  language: string;
  dependencies: string[];
  dependents: string[];
  knownFragilePoints: string[];
  slaMs: number;
  owners: string[];
  runbookIds: ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ServiceRuntimeConfigDocument {
  _id: ObjectId;
  serviceName: string;
  incidentChannel: string | null;
  adminBaseUrl: string | null;
  cloudRunServiceName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RunbookStepDocument {
  order: number;
  action: string;
  command: string | null;
  isExecutable: boolean;
  riskLevel: RiskLevel;
}

export interface RunbookDocument {
  _id: ObjectId;
  title: string;
  incidentType: string;
  steps: RunbookStepDocument[];
  applicableServices: string[];
  successCriteria: string;
  embedding: number[];
  createdAt: Date;
  updatedAt: Date;
}

export interface TimelineEventDocument {
  timestamp: Date;
  event: string;
  actor: "operaiq" | "human";
}

export interface PostmortemDocument {
  _id: ObjectId;
  incidentId: ObjectId;
  title: string;
  summary: string;
  timeline: TimelineEventDocument[];
  rootCause: string;
  contributingFactors: string[];
  remediationTaken: string[];
  preventionActions: string[];
  lessonLearned: string;
  generatedBy: "operaiq";
  createdAt: Date;
}

export interface PatternDocument {
  _id: ObjectId;
  name: string;
  symptomSignals: string[];
  likelyCauses: string[];
  confirmedCount: number;
  embedding: number[];
  createdAt: Date;
  updatedAt: Date;
}

export interface RemediationExecutionDocument {
  _id: ObjectId;
  action: string;
  targetService: string;
  parameters: Record<string, string | number>;
  riskLevel: RiskLevel;
  success: boolean;
  output: string;
  requiresHumanApproval: boolean;
  executedAt: Date;
  createdAt: Date;
}

export type NewIncidentDocument = Omit<IncidentDocument, "_id" | "embedding" | "createdAt" | "updatedAt">;
export type NewRunbookDocument = Omit<RunbookDocument, "_id" | "embedding" | "createdAt" | "updatedAt">;
export type NewPatternDocument = Omit<PatternDocument, "_id" | "embedding" | "createdAt" | "updatedAt">;
export type NewServiceRuntimeConfigDocument = Omit<ServiceRuntimeConfigDocument, "_id" | "createdAt" | "updatedAt">;

export interface IncidentVectorSearchResult {
  _id: ObjectId;
  title: string;
  severity: Severity;
  rootCause: string | null;
  resolution: string | null;
  remediationSteps: string[];
  durationMinutes: number | null;
  score: number;
}

export interface RunbookVectorSearchResult extends RunbookDocument {
  score: number;
}

export interface PatternVectorSearchResult extends PatternDocument {
  score: number;
}
