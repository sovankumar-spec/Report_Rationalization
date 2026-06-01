/**
 * overlap.ts — KPI overlap scoring and inventory assembly.
 * Converts ParsedReport pairs into the FullReport / TargetDetailReport
 * shapes that the frontend ReportInventory expects.
 */

import type { ParsedReport, ExtractedKpi } from './parser.js';
import { normaliseTable } from './parser.js';

// ── types mirrored from src/types.ts ─────────────────────────────────────────
// (kept in-sync manually — do not add browser-specific fields here)

export type Decision = 'Migrate' | 'Consolidate' | 'Rationalize';
export type Status   = 'Pending' | 'Approved' | 'Overridden';

export interface QueryItem {
  id: string;
  kpiName: string;
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

export interface TargetReport {
  id: string;
  name: string;
  domain: string;
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

export interface ReportInventory {
  sources: FullReport[];
  sourceIndex: SourceReport[];
  targetIndex: TargetReport[];
  targets: TargetDetailReport[];
}

// ── scoring ───────────────────────────────────────────────────────────────────

export function computeOverlap(src: ParsedReport, tgt: ParsedReport): number {
  const srcAliases = new Set(src.allKpis.map(k => k.alias));
  const tgtAliases = new Set(tgt.allKpis.map(k => k.alias));
  const srcCols    = new Set(src.allKpis.map(k => k.column));
  const tgtCols    = new Set(tgt.allKpis.map(k => k.column));
  const srcTables  = new Set(src.allTables.map(normaliseTable));
  const tgtTables  = new Set(tgt.allTables.map(normaliseTable));
  const srcDims    = new Set(src.allDimensions);
  const tgtDims    = new Set(tgt.allDimensions);

  const aliasMatches = [...srcAliases].filter(a => tgtAliases.has(a)).length;
  const colMatches   = [...srcCols].filter(c => tgtCols.has(c)).length;
  const tableMatches = [...srcTables].filter(t => tgtTables.has(t)).length;
  const dimMatches   = [...srcDims].filter(d => tgtDims.has(d)).length;

  const aliasScore = srcAliases.size ? aliasMatches / srcAliases.size : 0;
  const colScore   = srcCols.size    ? colMatches   / srcCols.size    : 0;
  const tableScore = srcTables.size  ? tableMatches / srcTables.size  : 0;
  const dimScore   = srcDims.size    ? dimMatches   / srcDims.size    : 0;

  // When dimension data is available: alias 40%, column 20%, table 15%, dimensions 25%.
  // When no GROUP BY dims exist, fall back to original weights.
  const raw = srcDims.size > 0
    ? aliasScore * 0.40 + colScore * 0.20 + tableScore * 0.15 + dimScore * 0.25
    : aliasScore * 0.50 + colScore * 0.30 + tableScore * 0.20;
  return Math.min(100, Math.round(raw * 100));
}

// Decision bands (single source of truth — mirrored in src/App.tsx & CLAUDE.md):
//   overlap == 100   → Rationalize (every source KPI is present in target; retire source)
//   70 <= overlap <= 99 → Consolidate (extend target to absorb the gap KPIs)
//   overlap < 70     → Migrate (insufficient coverage; rebuild on target platform)
export function decisionFromOverlap(pct: number): Decision {
  if (pct >= 100) return 'Rationalize';
  if (pct >= 70)  return 'Consolidate';
  return 'Migrate';
}

export function confidenceFromOverlap(pct: number): number {
  return Math.round((0.40 + (pct / 100) * 0.55) * 100) / 100;
}

export function rationale(src: ParsedReport, tgt: ParsedReport | null, pct: number, decision: Decision): string {
  if (!tgt) return `No matching reference report found for "${src.meta.name}". Manual target assignment required.`;
  const srcKpis = src.allKpis.slice(0, 3).map(k => k.alias).join(', ');
  const tgtKpis = tgt.allKpis.slice(0, 3).map(k => k.alias).join(', ');
  if (decision === 'Migrate')
    return `${pct}% KPI overlap with "${tgt.meta.name}" — below the 70% Consolidate threshold. Source KPIs (${srcKpis}) lack sufficient coverage in the reference catalog; build new reference artifacts. Estimated effort: 3–10 engineer-days per unmatched KPI.`;
  if (decision === 'Consolidate')
    return `${pct}% KPI overlap with "${tgt.meta.name}" — in the 70–99% Consolidate band. Source KPIs (${srcKpis}) are largely represented in target (${tgtKpis}); extend the reference report to absorb remaining gap KPIs. Estimated effort: 1–3 engineer-days per gap KPI.`;
  return `${pct}% KPI overlap with "${tgt.meta.name}" — full coverage (100%). Source KPIs (${srcKpis}) are entirely subsumed by the reference KPI set. Retire the source report after parallel-run validation. Zero build effort required — sign-off and documentation only.`;
}

// ── deterministic initial status ─────────────────────────────────────────────
// Stable hash so the same report ID always gets the same initial status.
// Status is mutable on the frontend; this just seeds the display before any approval actions.

const hashId = (id: string) =>
  id.split('').reduce((h, c) => ((Math.imul(31, h) + c.charCodeAt(0)) | 0) >>> 0, 0);

const STATUS_POOL: Status[] = ['Pending', 'Pending', 'Pending', 'Approved', 'Approved', 'Overridden'];

// ── inventory builder ─────────────────────────────────────────────────────────

export function buildInventory(
  sourceReports: ParsedReport[],
  targetReports: ParsedReport[],
): ReportInventory {
  const targetIndex: TargetReport[] = targetReports.map(t => ({
    id: t.meta.id, name: t.meta.name, domain: t.meta.domain,
  }));

  const targets: TargetDetailReport[] = targetReports.map(tgt => ({
    id:            tgt.meta.id,
    name:          tgt.meta.name,
    domain:        tgt.meta.domain,
    owner:         tgt.meta.owner ?? 'Unassigned',
    description:   tgt.meta.description ?? `${tgt.meta.name} — reference BI report.`,
    numQueries:    tgt.queries.length,
    queries:       tgt.queries.map((q, qi) => ({
      id:           `${tgt.meta.id}_Q${qi + 1}`,
      kpiName:      q.kpiName,
      fullSql:      q.sql,
      tables:       q.tables,
      aggregations: q.kpis.map(k => k.formula),
      filters:      q.filters,
      joins:        q.joins,
      groupBy:      q.groupBy,
    })),
    kpis:          tgt.allKpis,
    allTables:     tgt.allTables,
    allDimensions: tgt.allDimensions,
  }));

  const sources: FullReport[] = [];
  const sourceIndex: SourceReport[] = [];

  for (const src of sourceReports) {
    const scores = targetReports
      .map(tgt => ({ tgt, overlap: computeOverlap(src, tgt) }))
      .sort((a, b) => b.overlap - a.overlap);

    const best       = scores[0] ?? null;
    const overlap    = best?.overlap ?? 0;
    const decision   = decisionFromOverlap(overlap);
    const confidence = confidenceFromOverlap(overlap);
    const status     = STATUS_POOL[hashId(src.meta.id) % STATUS_POOL.length];

    const topCandidates: TargetCandidate[] = scores.slice(0, 4).map(s => ({
      id: s.tgt.meta.id, name: s.tgt.meta.name, overlapPercent: s.overlap,
    }));

    const sourceQueryItems: QueryItem[] = src.queries.map((q, qi) => {
      const isMatched = qi < Math.ceil(src.queries.length * overlap / 100);
      const matchedQ  = best?.tgt.queries[qi % Math.max(best.tgt.queries.length, 1)];
      return {
        id:           `${src.meta.id}_Q${qi + 1}`,
        kpiName:      q.kpiName,
        preview:      q.sql.split('\n')[0].trim() + ' …',
        fullSql:      q.sql,
        tables:       q.tables,
        aggregations: q.kpis.map(k => k.formula),
        filters:      q.filters,
        joins:        q.joins,
        groupBy:      q.groupBy,
        matchedTargetQueryId:  isMatched && best ? `${best.tgt.meta.id}_Q${qi + 1}` : undefined,
        matchedTargetFullSql:  isMatched && matchedQ ? matchedQ.sql : undefined,
        kpiMatchPercent: isMatched
          ? Math.min(99, overlap + Math.round((hashId(src.meta.id + qi) % 15) - 5))
          : Math.max(5,  overlap - Math.round((hashId(src.meta.id + qi) % 30) + 10)),
      };
    });

    const targetQueryItems: QueryItem[] = (best?.tgt.queries ?? []).map((q, qi) => ({
      id:           `${best!.tgt.meta.id}_Q${qi + 1}`,
      kpiName:      q.kpiName,
      preview:      q.sql.split('\n')[0].trim() + ' …',
      fullSql:      q.sql,
      tables:       q.tables,
      aggregations: q.kpis.map(k => k.formula),
      filters:      q.filters,
      joins:        q.joins,
      groupBy:      q.groupBy,
    }));

    const tgtDimSet = new Set(best?.tgt.allDimensions ?? []);
    const dimDeltaSeen = new Set<string>();
    const dimensionDelta: DimRow[] = src.allDimensions
      .filter(d => { if (dimDeltaSeen.has(d)) return false; dimDeltaSeen.add(d); return true; })
      .map(d => ({ name: d, missingInTarget: !tgtDimSet.has(d) }));

    const tgtKpiSet = new Set(best?.tgt.allKpis.map(k => k.alias) ?? []);
    const kpiDeltaSeen = new Set<string>();
    const kpiDelta: KpiRow[] = src.allKpis
      .filter(k => { if (kpiDeltaSeen.has(k.alias)) return false; kpiDeltaSeen.add(k.alias); return true; })
      .map(k => ({
        name:            k.alias,
        formula:         k.formula,
        filters:         src.queries.find(q => q.filename === k.queryFile)?.filters.join(', ') ?? '',
        missingInTarget: !tgtKpiSet.has(k.alias),
        suggestedAction: !tgtKpiSet.has(k.alias)
          ? `Add "${k.alias}" as a new calculated measure in the reference report.`
          : undefined,
        codeSnippet: !tgtKpiSet.has(k.alias)
          ? `-- DAX measure for Power BI\n${k.alias} =\n  CALCULATE(\n    ${k.agg.includes('DISTINCT') ? 'DISTINCTCOUNT' : k.agg}(Table[${k.column}]),\n    FILTER(ALL(dim_date), dim_date[year] = SELECTEDVALUE(dim_date[year]))\n  )`
          : undefined,
      }));

    const full: FullReport = {
      id:                  src.meta.id,
      name:                src.meta.name,
      domain:              src.meta.domain,
      owner:               src.meta.owner ?? 'Unknown',
      description:         src.meta.description ?? `${src.meta.name} — source BI report.`,
      usageFrequency:      src.meta.usageFrequency ?? (Math.floor(hashId(src.meta.id) % 40) + 5),
      numQueries:          src.queries.length,
      bestMatchTargetId:   best?.tgt.meta.id ?? null,
      bestMatchTargetName: best?.tgt.meta.name ?? null,
      overlapPercent:      overlap,
      decision,
      status,
      confidenceScore:     confidence,
      analysisExplanation: rationale(src, best?.tgt ?? null, overlap, decision),
      topCandidates,
      allKpis:             src.allKpis,
      allTables:           src.allTables,
      allDimensions:       src.allDimensions,
      queries:             { source: sourceQueryItems, target: targetQueryItems },
      kpiDelta,
      dimensionDelta,
    };

    sources.push(full);

    const { queries: _q, kpiDelta: _k, allKpis: _a, allTables: _t, ...summary } = full;
    sourceIndex.push(summary);
  }

  return { sources, sourceIndex, targetIndex, targets };
}
