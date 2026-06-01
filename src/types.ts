export type Decision = 'Migrate' | 'Consolidate' | 'Rationalize';
export type Status = 'Pending' | 'Approved' | 'Overridden';

export interface OverrideRecord {
  changedBy: string;
  changedAt: string;
  previousDecision: Decision;
  newDecision: Decision;
  previousTargetId: string | null;
  newTargetId: string;
  newTargetName: string;
  reason: string;
}

export interface TargetCandidate {
  id: string;
  name: string;
  overlapPercent: number;
}

export interface SourceReport {
  id: string;
  name: string;
  domain: string;
  owner: string;
  usageFrequency: number;
  numQueries: number;
  bestMatchTargetId: string | null;
  bestMatchTargetName: string | null;
  overlapPercent: number;
  decision: Decision;
  status: Status;
  confidenceScore: number;
  analysisExplanation: string;
  topCandidates: TargetCandidate[];
  overrideHistory?: OverrideRecord[];
}

export interface TargetReport {
  id: string;
  name: string;
  domain: string;
}

export interface QueryItem {
  id: string;
  kpiName: string;
  description?: string;
  preview?: string;
  fullSql: string;
  tables: string[];
  aggregations: string[];
  filters: string[];
  joins: string[];
  groupBy: string[];
  matchedTargetQueryId?: string;
  matchedTargetFullSql?: string;
  kpiMatchPercent?: number;
}

export interface KpiRow {
  name: string;
  formula: string;
  filters: string;
  missingInTarget: boolean;
  suggestedAction?: string;
  codeSnippet?: string;
}

export interface DimRow {
  name: string;
  missingInTarget: boolean;
}

export interface ExtractedKpi {
  alias: string;
  agg: string;
  column: string;
  formula: string;
  queryFile: string;
}

export interface FullReport extends SourceReport {
  description: string;
  allKpis: ExtractedKpi[];
  allTables: string[];
  allDimensions: string[];
  queries: { source: QueryItem[]; target: QueryItem[] };
  kpiDelta: KpiRow[];
  dimensionDelta: DimRow[];
}

export interface TargetDetailReport {
  id: string;
  name: string;
  domain: string;
  owner: string;
  description: string;
  numQueries: number;
  queries: QueryItem[];
  kpis: ExtractedKpi[];
  allTables: string[];
  allDimensions: string[];
}

export interface Filters {
  domain: string;
  status: string;
  overlapMin: number;
  overlapMax: number;
  search: string;
}
