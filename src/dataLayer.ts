import { Decision, DimRow, FullReport, SourceReport, TargetDetailReport, TargetReport } from './types';

export interface FieldMapping {
  sourceAlias: string;
  sourceColumn: string;
  targetAlias: string | null;
  targetColumn: string | null;
}

export interface RationalizationDecision {
  sourceId: string;
  sourceName: string;
  domain: string;
  targetId: string | null;
  targetName: string | null;
  overlapPercent: number;
  decision: Decision;
  confidenceScore: number;
  rationale: string;
  kpiGaps: string[];
  status: 'Pending' | 'Approved' | 'Overridden';
  source: 'analysis' | 'manual';
  fieldMappings?: FieldMapping[];
}

export interface RationalizationResponse {
  status: 'ok' | 'not_configured' | 'error';
  model?: string;
  generatedAt?: string;
  message?: string;
  decisions: RationalizationDecision[];
}

export interface ReportInventory {
  sources: FullReport[];
  sourceIndex: SourceReport[];
  targetIndex: TargetReport[];
  targets: TargetDetailReport[];
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function postLoadReports(body: Record<string, string>): Promise<ReportInventory> {
  const response = await fetch('/api/load-reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await response.json() as
    | ({ status: 'ok' } & ReportInventory)
    | { status: 'error'; error: { code: string; message: string; details?: unknown } };

  if (!response.ok || data.status === 'error') {
    const msg = data.status === 'error' ? data.error.message : `Server error ${response.status}`;
    throw new Error(msg);
  }

  return {
    sources:     (data as { status: 'ok' } & ReportInventory).sources,
    sourceIndex: (data as { status: 'ok' } & ReportInventory).sourceIndex,
    targetIndex: (data as { status: 'ok' } & ReportInventory).targetIndex,
    targets:     (data as { status: 'ok' } & ReportInventory).targets,
  };
}

export async function loadReportInventoryFromZips(
  sourceZip: File,
  targetZip: File,
): Promise<ReportInventory> {
  const [sourceBase64, targetBase64] = await Promise.all([
    fileToBase64(sourceZip),
    fileToBase64(targetZip),
  ]);
  return postLoadReports({ sourceZip: sourceBase64, targetZip: targetBase64 });
}

export async function loadReportInventoryFromPaths(
  sourcePath: string,
  targetPath: string,
): Promise<ReportInventory> {
  return postLoadReports({ sourcePath, targetPath });
}

export function compactSourceReport(report: FullReport) {
  return {
    id: report.id,
    name: report.name,
    domain: report.domain,
    owner: report.owner,
    description: report.description,
    usageFrequency: report.usageFrequency,
    numQueries: report.numQueries,
    tables: report.allTables,
    // Deterministic ground truth from the backend overlap matrix; enrichment must not change these.
    deterministic: {
      overlapPercent:      report.overlapPercent,
      decision:            report.decision,
      bestMatchTargetId:   report.bestMatchTargetId,
      bestMatchTargetName: report.bestMatchTargetName,
      confidenceSeed:      report.confidenceScore,
      kpiGapsHeuristic:    report.kpiDelta.filter(k => k.missingInTarget).map(k => k.name),
      dimGapsHeuristic:    report.dimensionDelta.filter((d: DimRow) => d.missingInTarget).map((d: DimRow) => d.name),
    },
    dimensions: report.allDimensions,
    kpis: report.allKpis.map(k => ({
      alias: k.alias,
      formula: k.formula,
      column: k.column,
      queryFile: k.queryFile,
    })),
    queries: report.queries.source.map(q => ({
      id: q.id,
      kpiName: q.kpiName,
      tables: q.tables,
      aggregations: q.aggregations,
      filters: q.filters,
      joins: q.joins,
      groupBy: q.groupBy,
      sqlExcerpt: q.fullSql.slice(0, 1200),
    })),
  };
}

export function compactTargetReport(report: TargetDetailReport) {
  return {
    id: report.id,
    name: report.name,
    domain: report.domain,
    owner: report.owner,
    description: report.description,
    numQueries: report.numQueries,
    tables: report.allTables,
    dimensions: report.allDimensions,
    kpis: report.kpis.map(k => ({
      alias: k.alias,
      formula: k.formula,
      column: k.column,
      queryFile: k.queryFile,
    })),
    queries: report.queries.map(q => ({
      id: q.id,
      kpiName: q.kpiName,
      tables: q.tables,
      aggregations: q.aggregations,
      filters: q.filters,
      joins: q.joins,
      groupBy: q.groupBy,
      sqlExcerpt: q.fullSql.slice(0, 1200),
    })),
  };
}

export async function requestRationalizationAnalysis(
  sources: FullReport[],
  targets: TargetDetailReport[],
): Promise<RationalizationResponse> {
  const response = await fetch('/api/rationalize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sources: sources.map(compactSourceReport),
      targets: targets.map(compactTargetReport),
    }),
  });

  if (!response.ok) {
    return {
      status: 'error',
      message: `Analysis request failed with HTTP ${response.status}.`,
      decisions: [],
    };
  }

  return response.json() as Promise<RationalizationResponse>;
}
