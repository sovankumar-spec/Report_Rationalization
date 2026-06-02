import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Database,
  Download,
  FileCode2,
  FileText,
  FolderOpen,
  GitBranch,
  HelpCircle,
  Layers,
  LayoutDashboard,
  Loader2,
  MessageSquare,
  Network,
  Search,
  ShieldCheck,
  Sliders,
  Sparkles,
  TrendingUp,
  X,
} from 'lucide-react';
import { Decision, DimRow, FullReport, MetadataMapping, QueryItem, TargetDetailReport, TargetReport } from './types';
import {
  FieldMapping,
  loadReportInventoryFromPaths,
  RationalizationDecision,
  ReportInventory,
  requestRationalizationAnalysis,
} from './dataLayer';

type TabKey = 'dashboard' | 'source' | 'target' | 'decision';
type WorkbenchPhase = 'intake' | 'loading' | 'analysing' | 'ready';

type IntakePayload = { mode: 'path'; sourcePath: string; targetPath: string };

interface ThresholdConfig {
  rationalizeAt: number; // overlap % at or above which disposition → Rationalize (default 100)
  consolidateAt:  number; // overlap % at or above which disposition → Consolidate (default 70)
}

const DEFAULT_THRESHOLDS: ThresholdConfig = { rationalizeAt: 100, consolidateAt: 70 };

const SOURCE_ORG = 'Source';
const TARGET_ORG = 'Target';

const TABS: Array<{ key: TabKey; label: string; icon: typeof LayoutDashboard }> = [
  { key: 'dashboard', label: 'Dashboard',  icon: LayoutDashboard },
  { key: 'source',    label: 'Source',     icon: GitBranch },
  { key: 'target',    label: 'Target',     icon: Network },
  { key: 'decision',  label: 'Disposition', icon: ShieldCheck },
];

// Rationalize = best outcome (source retired, already covered) → green
// Migrate     = highest effort (build new, no equivalent)       → orange
// Consolidate = medium effort (extend target to absorb source)  → blue
const DECISION_STYLE: Record<Decision, { bg: string; text: string; border: string; accent: string }> = {
  Rationalize: { bg: '#f0fdf4', text: '#166534', border: '#86efac', accent: '#22c55e' },
  Migrate:     { bg: '#fff4e5', text: '#92400e', border: '#fdba74', accent: '#f97316' },
  Consolidate: { bg: '#eaf5ff', text: '#075985', border: '#7dd3fc', accent: '#0284c7' },
};

function formatPercent(value: number) {
  return `${Math.round(value)}%`;
}

function exportDecisionsToCsv(
  sources: FullReport[],
  decisions: RationalizationDecision[],
): void {
  const headers = [
    'Source ID', 'Source Name', 'Domain', 'Reference Report', 'Reference ID',
    'Overlap %', 'Disposition', 'Confidence %', 'KPI Gaps', 'Status', 'Rationale',
  ];

  const rows = sources.map(source => {
    const d = decisions.find(x => x.sourceId === source.id);
    const overlap = d?.overlapPercent ?? source.overlapPercent;
    const conf = d ? Math.round(d.confidenceScore * 100) : Math.round(source.confidenceScore * 100);
    const kpiGaps = d?.kpiGaps?.length ?? source.kpiDelta.filter(k => k.missingInTarget).length;
    const targetName = d?.targetName ?? source.bestMatchTargetName ?? '';
    const targetId   = d?.targetId   ?? source.bestMatchTargetId   ?? '';
    const disposition = d?.decision ?? source.decision;
    const status = d?.status ?? source.status;
    const rationale = (d?.rationale ?? source.analysisExplanation).replace(/"/g, '""');
    return [
      source.id, source.name, source.domain,
      targetName, targetId,
      Math.round(overlap), disposition, conf, kpiGaps, status,
      `"${rationale}"`,
    ].join(',');
  });

  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `disposition-matrix-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function classNames(...items: Array<string | false | undefined>) {
  return items.filter(Boolean).join(' ');
}

// Decision bands — mirror server/lib/overlap.ts but honour user-configured thresholds.
// Defaults match the server's static bands: 100 → Rationalize, 70–99 → Consolidate, <70 → Migrate.
function decisionFromOverlap(pct: number, thresholds: ThresholdConfig = DEFAULT_THRESHOLDS): Decision {
  if (pct >= thresholds.rationalizeAt) return 'Rationalize';
  if (pct >= thresholds.consolidateAt)  return 'Consolidate';
  return 'Migrate';
}

// Client-side overlap recomputation — mirrors server/lib/overlap.ts exactly.
// Used by RemapModal so remap decisions are computed from real KPI data, not typed manually.
function normTable(t: string) {
  return t.replace(/^(fact_|dim_|tgt_|ref_|mkt_|vz_|ops_|hr_|fin_|lgl_|cs_|it_|scm_|vc_|rc_)/, '');
}

function clientComputeOverlap(src: FullReport, tgt: TargetDetailReport): number {
  const srcAliases = new Set(src.allKpis.map(k => k.alias));
  const tgtAliases = new Set(tgt.kpis.map(k => k.alias));
  const srcCols    = new Set(src.allKpis.map(k => k.column));
  const tgtCols    = new Set(tgt.kpis.map(k => k.column));
  const srcTables  = new Set(src.allTables.map(normTable));
  const tgtTables  = new Set(tgt.allTables.map(normTable));

  const aliasScore = srcAliases.size
    ? [...srcAliases].filter(a => tgtAliases.has(a)).length / srcAliases.size : 0;
  const colScore   = srcCols.size
    ? [...srcCols].filter(c => tgtCols.has(c)).length / srcCols.size : 0;
  const tableScore = srcTables.size
    ? [...srcTables].filter(t => tgtTables.has(t)).length / srcTables.size : 0;

  return Math.min(100, Math.round((aliasScore * 0.50 + colScore * 0.30 + tableScore * 0.20) * 100));
}

function clientKpiGaps(src: FullReport, tgt: TargetDetailReport): string[] {
  const tgtAliases = new Set(tgt.kpis.map(k => k.alias));
  return [...new Set(src.allKpis.filter(k => !tgtAliases.has(k.alias)).map(k => k.alias))];
}

function clientConfidence(pct: number) {
  return Math.round((0.40 + (pct / 100) * 0.55) * 100) / 100;
}

// ── Dynamic metadata remapping ────────────────────────────────────────────────

type MappingType = MetadataMapping['type'];

const MTYPE_LABELS: Record<MappingType, string> = {
  kpi: 'KPI / Measure', column: 'Column', table: 'Table', dimension: 'Dimension',
};

function resolveViaMapping(type: MappingType, value: string, mappings: MetadataMapping[]): string {
  return mappings.find(m => m.type === type && m.sourceValue === value)?.targetValue ?? value;
}

function computeOverlapWithMappings(
  src: FullReport,
  tgt: TargetDetailReport,
  mappings: MetadataMapping[],
): number {
  const res = (t: MappingType, v: string) => resolveViaMapping(t, v, mappings);
  const ratio = (s: Set<string>, tset: Set<string>) =>
    s.size ? [...s].filter(v => tset.has(v)).length / s.size : 0;

  const srcAliases = new Set(src.allKpis.map(k => res('kpi',       k.alias)));
  const tgtAliases = new Set(tgt.kpis.map(k => k.alias));
  const srcCols    = new Set(src.allKpis.map(k => res('column',    k.column)));
  const tgtCols    = new Set(tgt.kpis.map(k => k.column));
  const srcTables  = new Set(src.allTables.map(t => normTable(res('table',     t))));
  const tgtTables  = new Set(tgt.allTables.map(normTable));
  const srcDims    = new Set(src.allDimensions.map(d => res('dimension', d)));
  const tgtDims    = new Set(tgt.allDimensions);

  const aliasScore = ratio(srcAliases, tgtAliases);
  const colScore   = ratio(srcCols,    tgtCols);
  const tableScore = ratio(srcTables,  tgtTables);
  const dimScore   = ratio(srcDims,    tgtDims);

  const raw = srcDims.size > 0
    ? aliasScore * 0.40 + colScore * 0.20 + tableScore * 0.15 + dimScore * 0.25
    : aliasScore * 0.50 + colScore * 0.30 + tableScore * 0.20;

  return Math.min(100, Math.round(raw * 100));
}

function recomputeDecisionsFromMappings(
  sources:    FullReport[],
  targets:    TargetDetailReport[],
  mappings:   MetadataMapping[],
  thresholds: ThresholdConfig,
  prev:       RationalizationDecision[],
): RationalizationDecision[] {
  return sources.map(src => {
    const existing = prev.find(d => d.sourceId === src.id);
    if (existing?.source === 'manual') return existing;

    const ranked = targets
      .map(tgt => ({ tgt, overlap: computeOverlapWithMappings(src, tgt, mappings) }))
      .sort((a, b) => b.overlap - a.overlap);

    const best    = ranked[0] ?? null;
    const overlap = best?.overlap ?? 0;
    const decision = decisionFromOverlap(overlap, thresholds);
    const kpiGaps  = best
      ? [...new Set(src.allKpis.map(k => k.alias))].filter(a =>
          !best.tgt.kpis.some(k => k.alias === resolveViaMapping('kpi', a, mappings)))
      : [];

    return {
      sourceId:        src.id,
      sourceName:      src.name,
      domain:          existing?.domain ?? src.domain,
      targetId:        best?.tgt.id   ?? null,
      targetName:      best?.tgt.name ?? null,
      overlapPercent:  overlap,
      decision,
      confidenceScore: clientConfidence(overlap),
      rationale: mappings.length > 0
        ? `${overlap}% overlap with "${best?.tgt.name ?? '—'}" — recomputed applying ${mappings.length} metadata mapping(s).`
        : (existing?.rationale ?? src.analysisExplanation),
      kpiGaps,
      status:         existing?.status ?? 'Pending',
      source:         'analysis',
      fieldMappings:  existing?.fieldMappings,
    };
  });
}

// Simple Levenshtein for fuzzy auto-suggest
function lev(a: string, b: string): number {
  const m = a.length, n = b.length;
  const row = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = i;
    for (let j = 1; j <= n; j++) {
      const cur = a[i-1] === b[j-1] ? row[j-1] : 1 + Math.min(row[j-1], row[j], prev);
      row[j-1] = prev; prev = cur;
    }
    row[n] = prev;
  }
  return row[n];
}

const STRIP_PFX = /^(fact_|dim_|tgt_|ref_|total_|num_|cnt_|is_|has_|ftr_|vz_|src_)/;

function suggestBestMatch(source: string, vocab: string[]): string | null {
  if (!vocab.length) return null;
  const sl = source.toLowerCase();
  const exact = vocab.find(v => v.toLowerCase() === sl);
  if (exact) return exact;
  const stripped = sl.replace(STRIP_PFX, '');
  const stripMatch = vocab.find(v => v.toLowerCase().replace(STRIP_PFX, '') === stripped);
  if (stripMatch) return stripMatch;
  const best = vocab
    .map(v => { const vl = v.toLowerCase(); const max = Math.max(sl.length, vl.length); return { v, sim: max ? 1 - lev(sl, vl) / max : 1 }; })
    .sort((a, b) => b.sim - a.sim)[0];
  return best.sim >= 0.72 ? best.v : null;
}


function collectTargetVocab(targets: TargetDetailReport[], type: MappingType): string[] {
  const s = new Set<string>();
  for (const t of targets) {
    const vals = type === 'kpi'    ? t.kpis.map(k => k.alias)
               : type === 'column' ? t.kpis.map(k => k.column)
               : type === 'table'  ? t.allTables
               : t.allDimensions;
    for (const v of vals) s.add(v);
  }
  return [...s].sort();
}

const REMAP_TYPES: MappingType[] = ['dimension', 'kpi', 'column'];

type FieldGroup = {
  reportId:      string;
  reportName:    string;
  domain:        string;
  fields:        Array<{ value: string; mapped: string; isOk: boolean }>;
  unresolvedCnt: number;
};

function MetadataMappingPanel({
  sources, targets, mappings, changedCount, onChange,
}: {
  sources:      FullReport[];
  targets:      TargetDetailReport[];
  mappings:     MetadataMapping[];
  changedCount: number;
  onChange:     (m: MetadataMapping[]) => void;
}) {
  const [open,           setOpen]           = useState(false);
  const [activeType,     setActiveType]     = useState<MappingType>('dimension');
  const [search,         setSearch]         = useState('');
  const [domainFilter,   setDomainFilter]   = useState('');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const tgtVocab = useMemo(() => collectTargetVocab(targets, activeType), [targets, activeType]);

  const allDomains = useMemo(() => [...new Set(sources.map(s => s.domain))].sort(), [sources]);

  // Build report-grouped hierarchy: per-report unmatched fields (not in target vocab)
  const groups = useMemo<FieldGroup[]>(() => {
    return sources.map(src => {
      const rawFields =
        activeType === 'kpi'      ? [...new Set(src.allKpis.map(k => k.alias))]
        : activeType === 'column' ? [...new Set(src.allKpis.map(k => k.column))]
        : activeType === 'table'  ? [...new Set(src.allTables)]
        : [...new Set(src.allDimensions)];

      const fields = rawFields
        .filter(v => !tgtVocab.includes(v))  // only fields not in target vocab
        .map(value => {
          const mapped = mappings.find(m => m.type === activeType && m.sourceValue === value)?.targetValue ?? '';
          return { value, mapped, isOk: mapped ? tgtVocab.includes(mapped) : false };
        });

      return {
        reportId:      src.id,
        reportName:    src.name,
        domain:        src.domain,
        fields,
        unresolvedCnt: fields.filter(f => !f.isOk).length,
      };
    }).filter(g => g.fields.length > 0);
  }, [sources, tgtVocab, mappings, activeType]);

  // Auto-expand groups with unresolved fields when the type tab changes
  useEffect(() => {
    setSearch('');
    setExpandedGroups(new Set(groups.filter(g => g.unresolvedCnt > 0).map(g => g.reportId)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeType]);

  // Expand all groups that contain a search hit
  useEffect(() => {
    if (!search.trim()) return;
    const q = search.toLowerCase();
    setExpandedGroups(prev => {
      const next = new Set(prev);
      groups.forEach(g => {
        const nameHit  = g.reportName.toLowerCase().includes(q) || g.reportId.toLowerCase().includes(q);
        const fieldHit = g.fields.some(f => f.value.toLowerCase().includes(q) || f.mapped.toLowerCase().includes(q));
        if (nameHit || fieldHit) next.add(g.reportId);
      });
      return next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  // Filtered view
  const visibleGroups = useMemo<FieldGroup[]>(() => {
    const q = search.toLowerCase().trim();
    return groups
      .filter(g => !domainFilter || g.domain === domainFilter)
      .map(g => {
        if (!q) return g;
        const nameHit = g.reportName.toLowerCase().includes(q) || g.reportId.toLowerCase().includes(q);
        return {
          ...g,
          fields: nameHit ? g.fields : g.fields.filter(f => f.value.toLowerCase().includes(q) || f.mapped.toLowerCase().includes(q)),
        };
      })
      .filter(g => g.fields.length > 0);
  }, [groups, domainFilter, search]);

  // Per-type unresolved count for tab badges (deduplicated across reports)
  const unresolvedCount = useMemo(() => {
    const result: Record<MappingType, number> = { dimension: 0, kpi: 0, column: 0, table: 0 };
    for (const t of REMAP_TYPES) {
      const tv   = new Set(collectTargetVocab(targets, t));
      const seen = new Set<string>();
      for (const src of sources) {
        const fields =
          t === 'kpi'      ? src.allKpis.map(k => k.alias)
          : t === 'column' ? src.allKpis.map(k => k.column)
          : t === 'table'  ? src.allTables
          : src.allDimensions;
        for (const v of fields) {
          if (!seen.has(v) && !tv.has(v) && !mappings.find(m => m.type === t && m.sourceValue === v)) {
            seen.add(v);
            result[t]++;
          }
        }
      }
    }
    return result;
  }, [sources, targets, mappings]);

  const totalUnresolved = REMAP_TYPES.reduce((s, t) => s + unresolvedCount[t], 0);

  const setMap = (sourceValue: string, targetValue: string) =>
    onChange(targetValue.trim()
      ? [
          ...mappings.filter(m => !(m.type === activeType && m.sourceValue === sourceValue)),
          { id: `${activeType}:${sourceValue}`, type: activeType, sourceValue, targetValue: targetValue.trim() },
        ]
      : mappings.filter(m => !(m.type === activeType && m.sourceValue === sourceValue)));

  const toggleGroup  = (id: string) =>
    setExpandedGroups(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const expandAll    = () => setExpandedGroups(new Set(visibleGroups.map(g => g.reportId)));
  const collapseAll  = () => setExpandedGroups(new Set());

  if (sources.length === 0) return null;

  return (
    <section className="panel mapping-panel">
      {/* Panel header — clickable to toggle body */}
      <div className="panel-heading mapping-toggle" onClick={() => setOpen(v => !v)} style={{ cursor: 'pointer' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <ChevronDown size={14} style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform 0.2s' }} />
          <div>
            <p className="panel-kicker">Global alias resolution · re-scores all reports live</p>
            <h2>Field name remapping</h2>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {totalUnresolved > 0 && <span className="mapping-badge gap">{totalUnresolved} unresolved</span>}
          {mappings.length > 0 && <span className="mapping-badge">{mappings.length} mapping{mappings.length !== 1 ? 's' : ''} active</span>}
          {changedCount > 0 && <span className="mapping-badge reclassified">↑ {changedCount} reclassified</span>}
        </div>
      </div>

      {open && (
        <div className="mapping-body">
          {/* ── Toolbar ─────────────────────────────────────────── */}
          <div className="mapping-toolbar">
            {/* Type tabs */}
            <div className="mapping-type-bar">
              {REMAP_TYPES.map(t => {
                const unresolved = unresolvedCount[t];
                const active     = mappings.filter(m => m.type === t).length;
                return (
                  <button
                    key={t}
                    className={classNames('mapping-type-btn', activeType === t && 'active')}
                    onClick={e => { e.stopPropagation(); setActiveType(t); }}
                  >
                    {MTYPE_LABELS[t]}
                    {unresolved > 0
                      ? <span className="mapping-type-dot gap">{unresolved}</span>
                      : active > 0 ? <span className="mapping-type-dot">{active}</span> : null}
                  </button>
                );
              })}
            </div>

            {/* Search + domain filter + expand controls */}
            <div className="mapping-controls-row">
              <div className="mapping-search-box">
                <Search size={12} />
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search reports or fields…"
                  onClick={e => e.stopPropagation()}
                />
                {search && (
                  <button className="mapping-search-clear" onClick={e => { e.stopPropagation(); setSearch(''); }}>
                    <X size={11} />
                  </button>
                )}
              </div>

              {allDomains.length > 1 && (
                <select
                  className="mapping-domain-select"
                  value={domainFilter}
                  onChange={e => { e.stopPropagation(); setDomainFilter(e.target.value); }}
                  onClick={e => e.stopPropagation()}
                >
                  <option value="">All domains</option>
                  {allDomains.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              )}

              <div className="mapping-expand-btns">
                <button onClick={e => { e.stopPropagation(); expandAll(); }}>Expand all</button>
                <button onClick={e => { e.stopPropagation(); collapseAll(); }}>Collapse all</button>
              </div>
            </div>
          </div>

          {/* ── Group list ──────────────────────────────────────── */}
          {visibleGroups.length === 0 ? (
            <p className="panel-empty-note">
              {search || domainFilter
                ? 'No unresolved fields match your search or filter.'
                : `All ${MTYPE_LABELS[activeType].toLowerCase()} terms match target vocabulary — no remapping needed.`}
            </p>
          ) : (
            <div className="mapping-groups">
              {visibleGroups.map(group => {
                const isExpanded = expandedGroups.has(group.reportId);
                return (
                  <div key={group.reportId} className="mapping-group">
                    {/* Group header */}
                    <div
                      className={classNames('mapping-group-hdr', isExpanded && 'open')}
                      onClick={e => { e.stopPropagation(); toggleGroup(group.reportId); }}
                    >
                      <ChevronDown
                        size={12}
                        style={{ transform: isExpanded ? 'rotate(180deg)' : undefined, transition: 'transform 0.15s', flexShrink: 0 }}
                      />
                      <span className="mapping-group-name">{group.reportName}</span>
                      <span className="mapping-group-id">{group.reportId}</span>
                      <span className="mapping-group-domain">{group.domain}</span>
                      {group.unresolvedCnt > 0
                        ? <span className="mapping-group-pill gap">{group.unresolvedCnt} unresolved</span>
                        : <span className="mapping-group-pill ok">{group.fields.length} mapped</span>}
                      <span className="mapping-group-total">{group.fields.length} field{group.fields.length !== 1 ? 's' : ''}</span>
                    </div>

                    {/* Expanded rows */}
                    {isExpanded && (
                      <div className="mapping-group-rows">
                        <div className="mapping-row-hdr">
                          <span>Source field</span>
                          <span></span>
                          <span>Target equivalent</span>
                          <span>Status</span>
                        </div>
                        {group.fields.map(({ value, mapped, isOk }) => {
                          const cls   = mapped ? (isOk ? 'ok' : 'warn') : 'gap';
                          const label = mapped ? (isOk ? '✓ mapped' : '⚠ not found') : '✗ unresolved';
                          return (
                            <div key={value} className={`mapping-row ${cls}`}>
                              <span className="mapping-src-val">{value}</span>
                              <span className="mapping-arr">→</span>
                              <select
                                className="mapping-select"
                                value={mapped}
                                onChange={e => { e.stopPropagation(); setMap(value, e.target.value); }}
                                onClick={e => e.stopPropagation()}
                              >
                                <option value="">— select target —</option>
                                {tgtVocab.map(tv => <option key={tv} value={tv}>{tv}</option>)}
                              </select>
                              <span className={`mapping-status-chip ${cls}`}>{label}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Footer: clear active-type mappings */}
          {mappings.filter(m => m.type === activeType).length > 0 && (
            <div className="mapping-footer">
              <button
                className="mapping-clear-btn"
                onClick={e => { e.stopPropagation(); onChange(mappings.filter(m => m.type !== activeType)); }}
              >
                Clear {MTYPE_LABELS[activeType]} mappings
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// Provenance badge — surfaces "where did this data come from"
// so analysts can audit which content is deterministic SQL parsing
// vs rationale enrichment. Renders inline in panel headings.
function ProvenanceBadge({
  source,
  at,
}: {
  source: 'parser' | 'enrichment' | 'deterministic';
  at?: number;
}) {
  const labelMap = {
    parser:        { label: 'Parsed from SQL',   bg: '#ecfdf5', text: '#065f46' },
    deterministic: { label: 'Deterministic',     bg: '#e0f2fe', text: '#0369a1' },
    enrichment:    { label: 'Rationale enriched', bg: '#fef9c3', text: '#854d0e' },
  } as const;
  const s = labelMap[source];
  return (
    <span className="provenance-badge" style={{ background: s.bg, color: s.text }}>
      {s.label}
      {at && <span className="provenance-time">{formatClock(at)}</span>}
    </span>
  );
}

function overlapColor(pct: number) {
  return DECISION_STYLE[decisionFromOverlap(pct)].accent;
}

function getSourceDecision(source: FullReport, decisions: RationalizationDecision[]) {
  return decisions.find(d => d.sourceId === source.id) ?? null;
}

// Build dispositions directly from the inventory's deterministic overlap.
// These are visible immediately after load from deterministic overlap.
// Later enrichment can improve `rationale` / `kpiGaps` / `confidenceScore` only.
// Thresholds are applied client-side to allow live recomputation when the user adjusts them.
function deterministicDecisions(inventory: ReportInventory, thresholds: ThresholdConfig = DEFAULT_THRESHOLDS): RationalizationDecision[] {
  return inventory.sources.map(s => ({
    sourceId:        s.id,
    sourceName:      s.name,
    domain:          s.domain,
    targetId:        s.bestMatchTargetId,
    targetName:      s.bestMatchTargetName,
    overlapPercent:  s.overlapPercent,
    decision:        decisionFromOverlap(s.overlapPercent, thresholds),
    confidenceScore: s.confidenceScore,
    rationale:       s.analysisExplanation,
    kpiGaps:         s.kpiDelta.filter(k => k.missingInTarget).map(k => k.name),
    status:          'Pending',
    source:          'analysis',
  }));
}

// Placeholder records used so panel chrome (header, tables, SQL pane) renders
// with empty cells before the user loads any data.
function placeholderSource(): FullReport {
  return {
    id: '—', name: '—', domain: '—', owner: '—',
    usageFrequency: 0, numQueries: 0,
    bestMatchTargetId: null, bestMatchTargetName: null,
    overlapPercent: 0, decision: 'Migrate', status: 'Pending',
    confidenceScore: 0, analysisExplanation: '', topCandidates: [],
    description: 'Load report folders from the Dashboard tab to view source report details.',
    allKpis: [], allTables: [], allDimensions: [],
    queries: { source: [], target: [] },
    kpiDelta: [], dimensionDelta: [],
  };
}

function placeholderTarget(): TargetDetailReport {
  return {
    id: '—', name: '—', domain: '—', owner: '—',
    description: 'Load report folders from the Dashboard tab to view reference report details.',
    numQueries: 0, queries: [], kpis: [], allTables: [], allDimensions: [],
  };
}

// ---- Rationalization Trail event generation ----

type TrailStatus = 'pending' | 'active' | 'done';

interface TrailEvent {
  phase: string;
  label: string;
  detail: string;
  confidence?: number;
  type: 'info' | 'match' | 'decision' | 'assumption' | 'evidence';
  status: TrailStatus;
  at?: number; // epoch ms when this event transitioned to done

  // Optional architect-grade payload (Program Trail uses these)
  rationale?: string;                                          // italic "why" block under detail
  bullets?: string[];                                          // findings, risks, candidates, etc.
  metadata?: Array<{ label: string; value: string | number }>; // grain / scoring weights / counts
}

export interface PhaseTimings {
  loadStartedAt?: number;
  loadCompletedAt?: number;
  analysisStartedAt?: number;
  analysisCompletedAt?: number;
}

export interface LiveAnalysisStats {
  model: string | null;
  durationMs: number | null;   // wall-clock duration of the analysis call
}

function statusFor(
  marker: 'load-started' | 'load-completed' | 'analysis-started' | 'analysis-completed',
  phase: WorkbenchPhase,
  timings: PhaseTimings,
): { status: TrailStatus; at?: number } {
  switch (marker) {
    case 'load-started':
      if (timings.loadStartedAt) return { status: 'done', at: timings.loadStartedAt };
      if (phase === 'loading')   return { status: 'active' };
      return { status: 'pending' };
    case 'load-completed':
      if (timings.loadCompletedAt) return { status: 'done', at: timings.loadCompletedAt };
      if (phase === 'loading')     return { status: 'active' };
      return { status: 'pending' };
    case 'analysis-started':
      if (timings.analysisStartedAt) return { status: 'done', at: timings.analysisStartedAt };
      if (phase === 'analysing')     return { status: 'active' };
      return { status: 'pending' };
    case 'analysis-completed':
      if (timings.analysisCompletedAt) return { status: 'done', at: timings.analysisCompletedAt };
      if (phase === 'analysing')       return { status: 'active' };
      return { status: 'pending' };
  }
}

function formatClock(at?: number) {
  if (!at) return '';
  const d = new Date(at);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function buildSourceTrail(
  report: FullReport,
  decision: RationalizationDecision | null,
  targetCount: number,
  phase: WorkbenchPhase,
  timings: PhaseTimings,
): TrailEvent[] {
  const kpis = report.allKpis ?? [];
  const tables = report.allTables ?? [];
  const queries = report.queries?.source ?? [];
  const overlap = decision?.overlapPercent ?? null;
  const dec = decision?.decision ?? null;
  const conf = decision ? Math.round(decision.confidenceScore * 100) : null;
  const hasReport = report.id !== '—';

  const ingest = statusFor('load-started', phase, timings);
  const parsed = statusFor('load-completed', phase, timings);
  const analysisStarted = statusFor('analysis-started', phase, timings);
  const analysisDone = statusFor('analysis-completed', phase, timings);

  const events: TrailEvent[] = [
    {
      phase: 'INTAKE',
      label: hasReport ? 'Report ingested' : 'Awaiting report folders',
      detail: hasReport
        ? `"${report.name}" loaded from source estate. ${queries.length} SQL queries queued for extraction.`
        : 'No source paths submitted yet. Enter folder paths on the Dashboard tab.',
      type: 'info',
      ...ingest,
    },
    {
      phase: 'PARSE',
      label: hasReport ? 'Queries extracted' : 'SQL extraction pending',
      detail: hasReport
        ? `${queries.length} SQL queries parsed; ${tables.length} unique tables identified across ${kpis.length} KPI definitions.`
        : 'Will parse SQL files inside each report folder once paths are loaded.',
      type: 'info',
      ...parsed,
    },
    {
      phase: 'CLASSIFY',
      label: hasReport ? 'Domain assigned' : 'Domain classification pending',
      detail: hasReport
        ? `Business domain "${report.domain}" inferred from table schema patterns (fact_*, dim_* prefix clusters) and KPI naming conventions.`
        : 'Domain will be inferred from schema patterns after parsing.',
      type: 'info',
      ...parsed,
    },
    {
      phase: 'CANDIDATE',
      label: hasReport ? 'Target scan' : 'Target scan pending',
      detail: hasReport
        ? `Evaluating ${targetCount} reference reports in "${report.domain}" domain for KPI alignment. Cross-schema table normalization applied.`
        : 'Will compare against reference catalog once data is loaded.',
      type: 'match',
      ...parsed,
    },
    {
      phase: 'EVIDENCE',
      label: hasReport ? 'KPI overlap signals' : 'Overlap signals pending',
      detail: hasReport
        ? (kpis.length > 0
            ? `${kpis.length} source KPIs extracted. Alias match (50%), column name match (30%), and normalized table match (20%) scoring applied per candidate.`
            : 'No KPIs extracted — overlap scored as 0%. Manual assignment required.')
        : 'Alias / column / table weighted scoring runs after extraction.',
      type: 'evidence',
      ...parsed,
    },
    {
      phase: 'ASSUMPTION',
      label: 'Schema normalization',
      detail: `Source prefixes (fact_, dim_, ref_) and target prefixes (tgt_, mkt_, vz_) stripped before KPI matching to remove vendor-specific schema differences.`,
      type: 'assumption',
      status: 'done',
    },
    {
      phase: 'OVERLAP',
      label: overlap !== null ? 'Composite overlap score' : 'Overlap scoring',
      detail: overlap !== null
        ? `KPI overlap computed at ${Math.round(overlap)}%. Weighted alias, column, and normalized table overlap against the closest reference report.`
        : 'Composite overlap score will appear once analysis runs.',
      type: 'evidence',
      ...analysisStarted,
    },
    {
      phase: 'THRESHOLD',
      label: overlap !== null ? 'Decision threshold applied' : 'Threshold evaluation',
      detail: overlap !== null
        ? `${Math.round(overlap)}% KPI overlap scored. Thresholds: =100% → Rationalize, 70–99% → Consolidate, <70% → Migrate. This report crosses the "${dec}" band.`
        : 'Decision band (Rationalize / Consolidate / Migrate) selected after overlap is computed.',
      type: 'info',
      ...analysisStarted,
    },
    {
      phase: 'DECISION',
      label: dec ? `Recommendation: ${dec}` : 'Recommendation pending',
      detail: dec
        ? (decision?.targetName
            ? `${dec === 'Rationalize' ? 'Retire' : dec === 'Consolidate' ? 'Merge into' : 'Build new alongside'} "${decision.targetName}". ${decision?.rationale ?? ''}`
            : `No target match found. ${decision?.rationale ?? 'Manual assignment required.'}`)
        : 'Recommendation will be issued once analysis completes.',
      confidence: conf ?? undefined,
      type: 'decision',
      ...analysisDone,
    },
  ];

  if (decision?.kpiGaps?.length) {
    events.push({
      phase: 'GAPS',
      label: 'KPI gaps identified',
      detail: `${decision.kpiGaps.length} KPI(s) present in source but absent from target: ${decision.kpiGaps.slice(0, 4).join(', ')}${decision.kpiGaps.length > 4 ? ` +${decision.kpiGaps.length - 4} more` : ''}.`,
      type: 'evidence',
      ...analysisDone,
    });
  }

  return events;
}

function buildTargetTrail(
  report: TargetDetailReport,
  sourceCount: number,
  phase: WorkbenchPhase,
  timings: PhaseTimings,
): TrailEvent[] {
  const kpis = report.kpis ?? [];
  const tables = report.allTables ?? [];
  const queries = report.queries ?? [];
  const hasReport = report.id !== '—';

  const ingest = statusFor('load-started', phase, timings);
  const parsed = statusFor('load-completed', phase, timings);

  return [
    {
      phase: 'INTAKE',
      label: hasReport ? 'Reference registered' : 'Awaiting reference folders',
      detail: hasReport
        ? `"${report.name}" registered in the reference catalog. Acts as the migration target for source report rationalization.`
        : 'No reference paths submitted yet. Enter folder paths on the Dashboard tab.',
      type: 'info',
      ...ingest,
    },
    {
      phase: 'PARSE',
      label: hasReport ? 'Schema extracted' : 'Schema extraction pending',
      detail: hasReport
        ? `${queries.length} SQL queries parsed; ${tables.length} governed tables identified across ${kpis.length} KPI definitions.`
        : 'Will parse SQL files inside each reference folder once paths are loaded.',
      type: 'info',
      ...parsed,
    },
    {
      phase: 'CLASSIFY',
      label: hasReport ? 'Domain tag' : 'Domain tagging pending',
      detail: hasReport
        ? `Reference domain: "${report.domain}" — aligned to the standard reporting taxonomy. Governs KPI definitions for this domain.`
        : 'Reference domain assigned after parsing report metadata.',
      type: 'info',
      ...parsed,
    },
    {
      phase: 'COVERAGE',
      label: hasReport ? 'KPI coverage' : 'KPI coverage pending',
      detail: hasReport
        ? `${kpis.length} KPIs defined across ${tables.length} schema tables. This reference is the canonical KPI authority for "${report.domain}".`
        : 'KPI inventory builds out after SQL extraction completes.',
      type: 'evidence',
      ...parsed,
    },
    {
      phase: 'MAPPING',
      label: hasReport ? 'Source alignment' : 'Source alignment pending',
      detail: hasReport
        ? `This reference is a rationalization target for source reports in the "${report.domain}" domain. ${sourceCount} source report(s) evaluated against it.`
        : 'Source-to-reference mapping is computed once both estates are loaded.',
      type: 'match',
      ...parsed,
    },
    {
      phase: 'ASSUMPTION',
      label: 'Schema normalization',
      detail: 'Target prefixes (tgt_, mkt_, vz_) normalized for cross-schema KPI matching against source schemas.',
      type: 'assumption',
      status: 'done',
    },
    {
      phase: 'GOVERNANCE',
      label: hasReport ? 'Reference status' : 'Governance pending',
      detail: hasReport
        ? `Acts as the rationalization target for migration and consolidation candidates. Owner: ${report.owner ?? 'Unassigned'}.`
        : 'Governance status will be assigned once references are loaded.',
      type: 'info',
      ...parsed,
    },
  ];
}

function buildProgramTrail(
  sourceCount: number,
  targetCount: number,
  decisions: RationalizationDecision[],
  inventory: ReportInventory | null,
  liveStats: LiveAnalysisStats,
  phase: WorkbenchPhase,
  timings: PhaseTimings,
): TrailEvent[] {
  const hasData = sourceCount > 0 || targetCount > 0;
  const sources = inventory?.sources ?? [];
  const targets = inventory?.targets ?? [];

  const migrate     = decisions.filter(d => d.decision === 'Migrate').length;
  const consolidate = decisions.filter(d => d.decision === 'Consolidate').length;
  const rationalize = decisions.filter(d => d.decision === 'Rationalize').length;
  const totalGaps = decisions.reduce((sum, d) => sum + (d.kpiGaps?.length ?? 0), 0);
  const gapHeavy  = decisions.filter(d => (d.kpiGaps?.length ?? 0) > 0).length;
  const unmatched = decisions.filter(d => !d.targetId).length;

  const confs = decisions.map(d => d.confidenceScore);
  const avgConf = confs.length ? Math.round((confs.reduce((s, c) => s + c, 0) / confs.length) * 100) : null;
  const minConf = confs.length ? Math.round(Math.min(...confs) * 100) : null;
  const maxConf = confs.length ? Math.round(Math.max(...confs) * 100) : null;

  const overlaps = decisions.map(d => d.overlapPercent);
  const overlapMin = overlaps.length ? Math.min(...overlaps) : null;
  const overlapMax = overlaps.length ? Math.max(...overlaps) : null;
  const borderlineHi = decisions.filter(d => d.overlapPercent >= 38 && d.overlapPercent <= 42).length;
  const borderlineLo = decisions.filter(d => d.overlapPercent >= 78 && d.overlapPercent <= 82).length;

  const topDisposition = [...decisions].sort((a, b) => b.overlapPercent - a.overlapPercent)[0] ?? null;
  const weakestMatch   = [...decisions].sort((a, b) => a.overlapPercent - b.overlapPercent)[0] ?? null;

  // Evidence drawn from the inventory itself
  const srcKpis    = sources.reduce((n, s) => n + (s.allKpis?.length ?? 0), 0);
  const tgtKpis    = targets.reduce((n, t) => n + (t.kpis?.length ?? 0), 0);
  const srcQueries = sources.reduce((n, s) => n + (s.queries?.source?.length ?? 0), 0);
  const tgtQueries = targets.reduce((n, t) => n + (t.queries?.length ?? 0), 0);
  const srcTables  = new Set(sources.flatMap(s => s.allTables ?? [])).size;
  const tgtTables  = new Set(targets.flatMap(t => t.allTables ?? [])).size;
  const sourceDomains    = new Set(sources.map(s => s.domain));
  const referenceDomains = new Set(targets.map(t => t.domain));
  const sharedDomains    = [...sourceDomains].filter(d => referenceDomains.has(d)).length;

  const planReady     = statusFor('load-completed', phase, timings);
  const analysing     = statusFor('analysis-started', phase, timings);
  const analysisDone  = statusFor('analysis-completed', phase, timings);

  return [
    // ---- Logical plan (declared before any matching runs) ----
    {
      phase: 'OBJECTIVE',
      label: 'Modernization mandate',
      detail: hasData
        ? `Rationalize ${sourceCount} source BI reports against ${targetCount} reference catalog reports. Produce one disposition per source — Rationalize (retire), Consolidate (merge), or Migrate (rebuild).`
        : 'Goal will be stated once an estate is loaded. The workbench will produce one disposition per source.',
      rationale: 'Replace bespoke source reports with governed reference reports where KPIs already overlap. Reduces duplicate code, centralises measure definitions, and exposes gap-fill work that must precede retirement.',
      type: 'decision',
      ...planReady,
    },
    {
      phase: 'GRAIN',
      label: 'Unit of analysis',
      detail: 'One disposition per source report. KPI is the matching primitive — joins, filters, and tables are evidence under the KPI.',
      metadata: [
        { label: 'Disposition row',     value: '1 per source report' },
        { label: 'Match primitive',     value: 'KPI alias (lowercased)' },
        { label: 'Match axes',          value: 'alias · column · normalized table' },
        { label: 'Joining axis',        value: 'business domain (annotation, not constraint)' },
        { label: 'Reference role',      value: 'canonical KPI authority per domain' },
      ],
      type: 'info',
      status: 'done',
    },
    {
      phase: 'CANDIDATE',
      label: 'Candidate evaluation method',
      detail: hasData
        ? `For each source, all ${targetCount} references scored with a composite KPI-overlap function; the top-scoring candidate is proposed.`
        : 'For each source, every reference will be scored with a composite KPI-overlap function; the top-scoring candidate is proposed.',
      metadata: [
        { label: 'Alias match weight',           value: '50%' },
        { label: 'Column match weight',          value: '30%' },
        { label: 'Normalized table weight',      value: '20%' },
        { label: 'Schema prefixes stripped',     value: 'fact_, dim_, ref_, tgt_, vz_, mkt_' },
        { label: 'Candidates evaluated/source',  value: hasData ? targetCount : '—' },
      ],
      type: 'match',
      ...planReady,
    },
    {
      phase: 'DECISION_RULE',
      label: 'Disposition thresholds',
      detail: 'Composite overlap score is bucketed into one of three dispositions with explicit effort bands.',
      bullets: [
        '= 100 % overlap → Rationalize (every source KPI subsumed by reference; retire source). 0 days build effort, sign-off only.',
        '70 – 99 % overlap → Consolidate (extend reference to absorb gap KPIs). 1–3 days per missing KPI.',
        '<  70 % overlap → Migrate (insufficient coverage; rebuild on standard platform). 3–10 days per KPI.',
      ],
      rationale: 'Rationalize is intentionally narrow — full KPI coverage is rare. The 70 % Consolidate floor reflects a conservative migration bias: when uncertainty exists, prefer extending the reference over retiring the source.',
      type: 'decision',
      ...planReady,
    },
    {
      phase: 'ASSUMPTIONS',
      label: 'Working assumptions',
      detail: 'Held constant for this analysis. Each is auditable and overridable in the disposition matrix.',
      bullets: [
        'Reference catalog is the canonical KPI authority for its domain.',
        'Schema-prefix differences (fact_, dim_, tgt_, vz_, mkt_, ref_) are vendor artefacts, not semantic differences.',
        'Owner, weekly-usage, and query volume are NOT signals for disposition — only KPI overlap is.',
        'Cross-domain matches are permitted when KPI overlap is strong; domain mismatch is flagged, not excluded.',
        'Generated rationale is advisory. Analyst override is final and recorded in the governance ledger.',
        'A source with zero extracted KPIs scores 0 % and falls through to Migrate by default.',
      ],
      type: 'assumption',
      ...planReady,
    },
    {
      phase: 'FILTERS',
      label: 'Scope and exclusions',
      detail: 'What is in vs out of the matching set. Filters are auditable upstream of every decision.',
      bullets: [
        hasData ? `All ${sourceCount} source reports in scope (no exclusions).` : 'All loaded source reports will be in scope.',
        hasData ? `All ${targetCount} reference reports eligible as targets.` : 'All loaded references will be eligible as targets.',
        'Reports with empty SQL files are still parsed; metadata-only rows are tagged as 0-KPI cases.',
        sharedDomains > 0
          ? `${sharedDomains} domain(s) appear on both sides — high-confidence matches concentrate here.`
          : 'Cross-domain analysis only — no shared domain names between source and reference catalogs.',
      ],
      type: 'info',
      ...planReady,
    },

    // ---- Evidence collected during analysis ----
    {
      phase: 'EVIDENCE',
      label: hasData ? 'Observed signal inventory' : 'Evidence pending',
      detail: hasData
        ? 'Quantitative evidence extracted from the source and reference estates before scoring. Every number below is reproducible from the folders you loaded.'
        : 'KPI / query / table counts will appear once folders are parsed.',
      bullets: hasData ? [
        `Source folders parsed: ${sources.slice(0, 5).map(s => s.id).join(', ')}${sources.length > 5 ? ` +${sources.length - 5} more` : ''}.`,
        `Reference folders parsed: ${targets.slice(0, 5).map(t => t.id).join(', ')}${targets.length > 5 ? ` +${targets.length - 5} more` : ''}.`,
        `Total SQL files read: ${srcQueries + tgtQueries} (${srcQueries} source + ${tgtQueries} reference).`,
      ] : undefined,
      metadata: hasData ? [
        { label: 'Source KPIs extracted',      value: srcKpis },
        { label: 'Reference KPIs catalogued',  value: tgtKpis },
        { label: 'Source SQL queries parsed',  value: srcQueries },
        { label: 'Reference SQL queries',      value: tgtQueries },
        { label: 'Unique source tables',       value: srcTables },
        { label: 'Unique reference tables',    value: tgtTables },
        { label: 'Source domains in scope',    value: sourceDomains.size },
        { label: 'Reference domains',          value: referenceDomains.size },
      ] : undefined,
      type: 'evidence',
      ...planReady,
    },
    {
      phase: 'OVERLAP',
      label: hasData ? 'Overlap matrix (deterministic)' : 'Overlap matrix pending',
      detail: hasData
        ? `Composite KPI overlap computed for all ${sourceCount}×${targetCount} = ${sourceCount * targetCount} source/reference pairs. The strongest match per source is recorded below; full per-source breakdowns are on the Disposition tab.`
        : 'Once SQL is parsed, every source is scored against every reference. The score drives the decision band.',
      bullets: hasData && decisions.length ? [
        ...[...decisions]
          .sort((a, b) => b.overlapPercent - a.overlapPercent)
          .slice(0, 5)
          .map(d => `${d.sourceName} → ${d.targetName ?? 'no match'} : ${Math.round(d.overlapPercent)} % overlap → ${d.decision}`),
        decisions.length > 5 ? `+ ${decisions.length - 5} more in the Disposition matrix.` : '',
      ].filter(Boolean) : undefined,
      rationale: 'Overlap is reproducible from the SQL alone — load the same folders twice, get the same numbers. Enrichment does not change these values; it only adds qualitative rationale below.',
      type: 'evidence',
      ...planReady,
    },
    {
      phase: 'ANALYSIS',
      label: decisions.length ? 'Scoring + rationale enrichment' : 'Scoring + rationale enrichment running',
      detail: decisions.length
        ? `Composite overlap computed for all ${sourceCount}×${targetCount} = ${sourceCount * targetCount} pairs. Top-1 candidate selected per source. Rationale enrichment completed for each disposition.`
        : 'Overlap scoring runs deterministically; rationale enrichment adds narrative and confidence calibration.',
      rationale: 'Score is reproducible from source folders alone — enrichment adds qualitative rationale and confidence calibration on top, but the disposition band is fixed by the deterministic score.',
      metadata: [
        { label: 'Enrichment',     value: liveStats.model ?? (decisions.length ? 'KPI overlap only' : '…') },
        { label: 'Pairs evaluated', value: hasData ? sourceCount * targetCount : '—' },
        {
          label: 'Enrichment run',
          value: liveStats.durationMs != null
            ? `${(liveStats.durationMs / 1000).toFixed(1)} s`
            : (phase === 'analysing' ? 'in flight…' : '—'),
        },
        {
          label: 'Throughput',
          value: liveStats.durationMs && decisions.length
            ? `${((decisions.length * 1000) / liveStats.durationMs).toFixed(1)} dispositions/s`
            : '—',
        },
      ],
      type: 'info',
      ...analysing,
    },

    // ---- Findings derived from evidence ----
    {
      phase: 'FINDINGS',
      label: decisions.length ? 'Disposition findings' : 'Findings pending',
      detail: decisions.length
        ? 'What the analysis produced. Numbers are read directly from the disposition matrix.'
        : 'Migrate / Consolidate / Rationalize counts and effort bands will appear here once analysis completes.',
      metadata: decisions.length ? [
        { label: 'Rationalize (retire)', value: `${rationalize} report(s) · 0 days` },
        { label: 'Consolidate (extend)', value: `${consolidate} report(s) · est. ${consolidate}–${consolidate * 3} days` },
        { label: 'Migrate (rebuild)',    value: `${migrate} report(s) · est. ${migrate * 3}–${migrate * 10} days` },
        { label: 'Overlap range',        value: overlapMin !== null ? `${Math.round(overlapMin)} % – ${Math.round(overlapMax!)} %` : '—' },
        { label: 'Strongest match',      value: topDisposition ? `${topDisposition.sourceName} → ${topDisposition.targetName ?? '—'} (${Math.round(topDisposition.overlapPercent)} %)` : '—' },
        { label: 'Weakest match',        value: weakestMatch   ? `${weakestMatch.sourceName} → ${weakestMatch.targetName ?? '—'} (${Math.round(weakestMatch.overlapPercent)} %)` : '—' },
      ] : undefined,
      type: 'evidence',
      ...analysisDone,
    },
    {
      phase: 'SAMPLE',
      label: decisions.length ? 'Sample rationale (highest-overlap source)' : 'Sample rationale pending',
      detail: topDisposition
        ? `Auditable example. The full rationale per source is on the Disposition tab; selected here is the strongest overlap match as a fidelity check.`
        : 'A representative rationale will be surfaced here as evidence that the analysis is producing meaningful output, not boilerplate.',
      rationale: topDisposition?.rationale
        ? `${topDisposition.sourceName} → ${topDisposition.targetName ?? 'no target'} (${Math.round(topDisposition.overlapPercent)} %, conf ${Math.round(topDisposition.confidenceScore * 100)} %): "${topDisposition.rationale.length > 280 ? topDisposition.rationale.slice(0, 280) + '…' : topDisposition.rationale}"`
        : undefined,
      type: 'evidence',
      ...analysisDone,
    },
    {
      phase: 'CONFIDENCE',
      label: avgConf !== null ? 'Confidence calibration' : 'Confidence calibration pending',
      detail: avgConf !== null
        ? 'Enriched confidence per decision; informs which dispositions auto-qualify for fast-track approval.'
        : 'Per-decision confidence scores will appear here after analysis completes.',
      metadata: avgConf !== null ? [
        { label: 'Mean confidence',  value: `${avgConf} %` },
        { label: 'Confidence range', value: `${minConf} % – ${maxConf} %` },
        { label: 'Fast-track eligible (≥80 %)', value: decisions.filter(d => d.confidenceScore >= 0.8).length },
        { label: 'Review-required (<60 %)',     value: decisions.filter(d => d.confidenceScore < 0.6).length },
      ] : undefined,
      type: 'evidence',
      ...analysisDone,
    },

    // ---- Risks / open questions surfaced for the architect ----
    {
      phase: 'RISKS',
      label: decisions.length ? 'Open risks for analyst review' : 'Risk register pending',
      detail: decisions.length
        ? 'Items that require human judgment before retirement or migration is approved.'
        : 'Borderline cases, KPI gaps, and unmatched reports will be listed here after analysis.',
      bullets: decisions.length ? [
        `${gapHeavy} report(s) carry KPI gaps — gap-fill design required before retirement (${totalGaps} KPI(s) total).`,
        `${borderlineHi + borderlineLo} report(s) are at a band boundary (overlap 38–42 % or 78–82 %); disposition is sensitive to a single KPI change.`,
        `${unmatched} report(s) have no matched reference — verify schema-naming did not mask a real match before defaulting to Migrate.`,
        'When rationale enrichment is not configured, dispositions fall back to deterministic overlap — narrative will be terser; confidence is heuristic.',
      ] : undefined,
      type: 'assumption',
      ...analysisDone,
    },

  ];
}

const TRAIL_PHASE_STYLE: Record<string, { bg: string; text: string }> = {
  INTAKE:        { bg: '#e0f2fe', text: '#0369a1' },
  PARSE:         { bg: '#f0fdf4', text: '#166534' },
  CLASSIFY:      { bg: '#fef9c3', text: '#854d0e' },
  CANDIDATE:     { bg: '#ede9fe', text: '#5b21b6' },
  EVIDENCE:      { bg: '#fff7ed', text: '#9a3412' },
  OVERLAP:       { bg: '#fff7ed', text: '#9a3412' },
  ASSUMPTION:    { bg: '#f1f5f9', text: '#475569' },
  ASSUMPTIONS:   { bg: '#f1f5f9', text: '#475569' },
  THRESHOLD:     { bg: '#f1f5f9', text: '#475569' },
  DECISION:      { bg: '#ecfdf5', text: '#065f46' },
  DECISION_RULE: { bg: '#ecfdf5', text: '#065f46' },
  GAPS:          { bg: '#fef2f2', text: '#991b1b' },
  WAITING:       { bg: '#f2f3f3', text: '#64748b' },
  MAPPING:       { bg: '#ede9fe', text: '#5b21b6' },
  COVERAGE:      { bg: '#fff7ed', text: '#9a3412' },
  GOVERNANCE:    { bg: '#ecfdf5', text: '#065f46' },
  SCOPE:         { bg: '#e0f2fe', text: '#0369a1' },
  ANALYSIS:      { bg: '#f0fdf4', text: '#166534' },
  CONFIDENCE:    { bg: '#fff7ed', text: '#9a3412' },
  OBJECTIVE:     { bg: '#e0f2fe', text: '#0369a1' },
  GRAIN:         { bg: '#fef9c3', text: '#854d0e' },
  FILTERS:       { bg: '#f1f5f9', text: '#475569' },
  FINDINGS:      { bg: '#fff7ed', text: '#9a3412' },
  RISKS:         { bg: '#fef2f2', text: '#991b1b' },
  SAMPLE:        { bg: '#ecfdf5', text: '#065f46' },
};

const TRAIL_TYPE_ICON: Record<TrailEvent['type'], typeof Clock> = {
  info:       Clock,
  match:      Network,
  decision:   ShieldCheck,
  assumption: AlertCircle,
  evidence:   FileCode2,
};

function RationalizationTrail({
  events,
  title = 'Rationalization Trail',
}: {
  events: TrailEvent[];
  title?: string;
}) {
  const doneCount   = events.filter(e => e.status === 'done').length;
  const activeCount = events.filter(e => e.status === 'active').length;

  return (
    <aside className="trail-panel">
      <div className="trail-header">
        <Layers size={14} />
        <span>{title}</span>
        <span className="trail-progress">
          {doneCount}/{events.length}
          {activeCount > 0 && <Loader2 size={11} className="animate-spin" />}
        </span>
      </div>
      <div className="trail-events">
        {events.map((evt, i) => {
          const phaseStyle = TRAIL_PHASE_STYLE[evt.phase] ?? { bg: '#f2f3f3', text: '#64748b' };
          const IconComp = TRAIL_TYPE_ICON[evt.type];
          return (
            <div key={`${evt.phase}-${i}`} className={classNames('trail-event', `is-${evt.status}`)}>
              <div className="trail-event-left">
                <span
                  className="trail-phase"
                  style={{ background: phaseStyle.bg, color: phaseStyle.text }}
                >
                  {evt.phase}
                </span>
                {i < events.length - 1 && <div className="trail-connector" />}
              </div>
              <div className="trail-event-body">
                <div className="trail-event-label">
                  {evt.status === 'active'
                    ? <Loader2 size={12} className="animate-spin trail-active-icon" />
                    : evt.status === 'done'
                      ? <CheckCircle2 size={12} className="trail-done-icon" />
                      : <IconComp size={12} />}
                  <strong>{evt.label}</strong>
                  {evt.confidence !== undefined && (
                    <span className="trail-conf">{evt.confidence}%</span>
                  )}
                  {evt.status === 'active' && <span className="trail-status-tag active">live</span>}
                  {evt.status === 'pending' && <span className="trail-status-tag pending">queued</span>}
                  {evt.at && <span className="trail-timestamp">{formatClock(evt.at)}</span>}
                </div>
                <p className="trail-event-detail">{evt.detail}</p>
                {evt.rationale && (
                  <p className="trail-rationale"><em>Why:</em> {evt.rationale}</p>
                )}
                {evt.bullets && evt.bullets.length > 0 && (
                  <ul className="trail-bullets">
                    {evt.bullets.map((b, j) => <li key={j}>{b}</li>)}
                  </ul>
                )}
                {evt.metadata && evt.metadata.length > 0 && (
                  <dl className="trail-metadata">
                    {evt.metadata.map((m, j) => (
                      <div key={j} className="trail-metadata-row">
                        <dt>{m.label}</dt>
                        <dd>{m.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

// ---- Intake banner (horizontal, full-width) ----

function IntakeBanner({
  onApply,
  loading = false,
}: {
  onApply: (payload: IntakePayload) => void;
  loading?: boolean;
}) {
  const [sourcePath, setSourcePath] = useState('');
  const [targetPath, setTargetPath] = useState('');
  const [notes, setNotes]           = useState('');
  const [expanded, setExpanded]     = useState(false);

  const canSubmit = sourcePath.trim().length > 0 && targetPath.trim().length > 0 && !loading;

  const handleApply = () => {
    if (!canSubmit) return;
    onApply({ mode: 'path', sourcePath: sourcePath.trim(), targetPath: targetPath.trim() });
  };

  return (
    <div className="intake-banner">
      <div className="intake-banner-row">
        <div className="intake-brand">
          <FolderOpen size={16} />
          <div className="intake-brand-text">
            <strong>Analysis Intake</strong>
            <span>Report source paths</span>
          </div>
        </div>

        <div className="intake-source-target">
          <div className="intake-path-row">
            <span className="intake-org-label source">{SOURCE_ORG}</span>
            <input
              className="intake-path-input"
              value={sourcePath}
              onChange={e => setSourcePath(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && canSubmit && handleApply()}
              disabled={loading}
              placeholder="Source folder path — e.g. /reports/source"
            />
          </div>
          <div className="intake-path-row">
            <span className="intake-org-label target">{TARGET_ORG}</span>
            <input
              className="intake-path-input"
              value={targetPath}
              onChange={e => setTargetPath(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && canSubmit && handleApply()}
              disabled={loading}
              placeholder="Reference folder path — e.g. /reports/reference"
            />
          </div>
        </div>

        <div className="intake-banner-actions">
          <button
            className={classNames('intake-toggle-btn', expanded && 'active')}
            onClick={() => setExpanded(v => !v)}
            disabled={loading}
          >
            <ChevronDown size={13} style={{ transform: expanded ? 'rotate(180deg)' : undefined }} />
            Notes
          </button>
          <button
            className="primary-action"
            style={{ minHeight: 32, fontSize: 12 }}
            onClick={handleApply}
            disabled={!canSubmit}
          >
            {loading ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
            {loading ? 'Loading…' : 'Load reports'}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="intake-notes-body">
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            rows={2}
            placeholder="Analyst notes: migration constraints, parallel-run requirements, data quality issues, stakeholder context..."
          />
        </div>
      )}
    </div>
  );
}

// ---- Stat card ----

function StatCard({
  label,
  value,
  detail,
  icon: Icon,
  accent,
}: {
  label: string;
  value: string | number;
  detail: string;
  icon: typeof LayoutDashboard;
  accent: string;
}) {
  return (
    <section className="metric-card">
      <div className="metric-icon" style={{ background: accent }}>
        <Icon size={18} />
      </div>
      <div>
        <p className="metric-label">{label}</p>
        <p className="metric-value">{value}</p>
        <p className="metric-detail">{detail}</p>
      </div>
    </section>
  );
}

function DecisionPill({ decision }: { decision: Decision }) {
  const style = DECISION_STYLE[decision];
  return (
    <span
      className="decision-pill"
      style={{ background: style.bg, color: style.text, borderColor: style.border }}
    >
      <span className="decision-dot" style={{ background: style.accent }} />
      {decision}
    </span>
  );
}

function ConfidencePill({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const tone = pct >= 80 ? 'good' : pct >= 60 ? 'warn' : 'risk';
  return <span className={`confidence-pill ${tone}`}>{pct}%</span>;
}

// ---- App header ----

function AppHeader({
  activeTab,
  setActiveTab,
}: {
  activeTab: TabKey;
  setActiveTab: (tab: TabKey) => void;
}) {
  return (
    <header className="enterprise-header">
      <div className="hero-strip">
        <div className="brand-lockup">
          <div>
            <p className="eyebrow">BI Modernization Workbench</p>
            <h1>Report Rationalizer</h1>
          </div>
        </div>
      </div>
      <nav className="top-tabs" aria-label="Workbench sections">
        {TABS.map(tab => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.key}
              className={classNames('top-tab', activeTab === tab.key && 'active')}
              onClick={() => setActiveTab(tab.key)}
            >
              <Icon size={16} />
              {tab.label}
            </button>
          );
        })}
      </nav>
    </header>
  );
}

// ---- Dashboard ----

function DashboardView({
  inventory,
  decisions,
  thresholds,
  onReload,
  onThresholdChange,
  onRemap,
  isLoading,
  loadError,
  metadataMappings,
  onMappingsChange,
  mappingChangedCount,
}: {
  inventory: ReportInventory | null;
  decisions: RationalizationDecision[];
  thresholds: ThresholdConfig;
  onReload: (payload: IntakePayload) => void;
  onThresholdChange: (t: ThresholdConfig) => void;
  onRemap: (sourceId: string) => void;
  isLoading: boolean;
  loadError: string | null;
  metadataMappings: MetadataMapping[];
  onMappingsChange: (m: MetadataMapping[]) => void;
  mappingChangedCount: number;
}) {
  const allSources = inventory?.sources ?? [];
  const allTargets = inventory?.targets ?? [];

  // ── Multi-select domain filter ──────────────────────────────────────────
  // activeDomains = [] means "All". Each chip toggles membership in the set.
  const [activeDomains, setActiveDomains] = useState<string[]>([]);
  const allDomains = [...new Set(allSources.map(r => r.domain))].sort();

  const toggleDomain = (d: string) => {
    setActiveDomains(prev =>
      prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d]
    );
  };

  const isAllActive = activeDomains.length === 0;

  const sources  = isAllActive ? allSources : allSources.filter(r => activeDomains.includes(r.domain));
  const targets  = isAllActive ? allTargets : allTargets.filter(r => activeDomains.includes(r.domain));
  const decisions_f = isAllActive ? decisions  : decisions.filter(d => activeDomains.includes(d.domain));

  const mapped = decisions_f.length;
  const avgConfidence = mapped
    ? decisions_f.reduce((sum, d) => sum + d.confidenceScore, 0) / mapped
    : 0;
  const approved   = decisions_f.filter(d => d.status === 'Approved').length;
  const pending    = decisions_f.filter(d => d.status === 'Pending').length;
  const overridden = decisions_f.filter(d => d.status === 'Overridden').length;

  const decisionCounts = (['Migrate', 'Consolidate', 'Rationalize'] as Decision[]).map(label => ({
    label,
    count: decisions_f.filter(d => d.decision === label).length,
  }));
  const migrateCount     = decisionCounts.find(d => d.label === 'Migrate')?.count ?? 0;
  const consolidateCount = decisionCounts.find(d => d.label === 'Consolidate')?.count ?? 0;
  const rationalizeCount = decisionCounts.find(d => d.label === 'Rationalize')?.count ?? 0;

  const statusCounts = [
    { label: 'Approved',   count: approved,   color: '#037f0c', bg: '#f0fdf4', text: '#166534' },
    { label: 'Pending',    count: pending,     color: '#ff9900', bg: '#fff7ed', text: '#9a3412' },
    { label: 'Overridden', count: overridden,  color: '#5f6b7a', bg: '#f1f5f9', text: '#334155' },
  ];

  const confTiers = [
    { label: 'High  ≥80%',  count: decisions_f.filter(d => d.confidenceScore >= 0.8).length,  color: '#037f0c' },
    { label: 'Mid  60–79%', count: decisions_f.filter(d => d.confidenceScore >= 0.6 && d.confidenceScore < 0.8).length, color: '#ff9900' },
    { label: 'Low   <60%',  count: decisions_f.filter(d => d.confidenceScore < 0.6).length,   color: '#dc2626' },
  ];

  const totalKpiGaps = decisions_f.reduce((s, d) => s + (d.kpiGaps?.length ?? 0), 0);

  const domainCounts = (isAllActive ? allDomains : activeDomains).map(domain => ({
    domain,
    sources:   allSources.filter(r => r.domain === domain).length,
    targets:   allTargets.filter(r => r.domain === domain).length,
    decisions: decisions.filter(d => d.domain === domain).length,
    approved:  decisions.filter(d => d.domain === domain && d.status === 'Approved').length,
  }));
  const maxDomain = Math.max(...domainCounts.map(d => Math.max(d.sources, d.targets)), 1);

  const overlapBuckets = [
    { label: '<40%',   min: 0,   max: 39  },
    { label: '40–59%', min: 40,  max: 59  },
    { label: '60–79%', min: 60,  max: 79  },
    { label: '80–99%', min: 80,  max: 99  },
    { label: '100%',   min: 100, max: 100 },
  ].map(bucket => ({
    ...bucket,
    count: decisions_f.filter(d => d.overlapPercent >= bucket.min && d.overlapPercent <= bucket.max).length,
  }));
  const maxBucket = Math.max(...overlapBuckets.map(b => b.count), 1);

  return (
    <main className="workspace">
      <IntakeBanner onApply={onReload} loading={isLoading} />

      {!inventory && !isLoading && (
        <div className="no-data-banner">
          <AlertCircle size={14} />
          <span>
            Paste the source and reference report folder paths above and click <strong>Load reports</strong>.
            All metrics, charts, lineage, and analysis will populate once data is loaded.
          </span>
        </div>
      )}
      {isLoading && <LoadingProgressPanel />}

      {/* Threshold configuration panel */}
      <ThresholdPanel thresholds={thresholds} onChange={onThresholdChange} />

      {/* Dynamic metadata remapping */}
      <MetadataMappingPanel
        sources={allSources}
        targets={allTargets}
        mappings={metadataMappings}
        changedCount={mappingChangedCount}
        onChange={onMappingsChange}
      />

      {/* Domain filter bar — multi-select, only shown when data is loaded */}
      {allSources.length > 0 && !isLoading && (
        <div className="domain-filter-bar">
          <span className="domain-filter-label">Domain</span>
          <button
            className={classNames('domain-filter-chip', isAllActive && 'active')}
            onClick={() => setActiveDomains([])}
          >
            All
          </button>
          {allDomains.map(d => (
            <button
              key={d}
              className={classNames('domain-filter-chip', activeDomains.includes(d) && 'active')}
              onClick={() => toggleDomain(d)}
            >
              {d}
              <span className="domain-chip-count">
                {decisions.filter(dec => dec.domain === d).length}
              </span>
            </button>
          ))}
          {!isAllActive && (
            <span className="domain-filter-summary">
              Showing {sources.length} source · {targets.length} reference · {mapped} decisions
              &nbsp;—&nbsp;
              <span style={{ color: DECISION_STYLE.Rationalize.accent }}>{rationalizeCount} rationalize</span>
              &nbsp;·&nbsp;
              <span style={{ color: '#0972d3' }}>{consolidateCount} consolidate</span>
              &nbsp;·&nbsp;
              <span style={{ color: DECISION_STYLE.Migrate.accent }}>{migrateCount} migrate</span>
            </span>
          )}
        </div>
      )}
      {loadError && (
        <div className="no-data-banner error">
          <AlertCircle size={14} />
          <span>{loadError}</span>
        </div>
      )}

      <div className="metric-grid">
        <StatCard
          label="Source report estate"
          value={sources.length || '—'}
          detail={sources.length ? `${[...new Set(sources.map(r => r.domain))].length} domains in scope` : 'No data loaded'}
          icon={FileText}
          accent="#0972d3"
        />
        <StatCard
          label="Reference report catalog"
          value={targets.length || '—'}
          detail={targets.length ? `${[...new Set(targets.map(r => r.domain))].length} reference domains` : 'No data loaded'}
          icon={Database}
          accent="#037f0c"
        />
        <StatCard
          label="Source dispositions"
          value={sources.length ? `${mapped}/${sources.length}` : '—'}
          detail={
            sources.length
              ? `${migrateCount} migrate · ${consolidateCount} consolidate · ${rationalizeCount} rationalize`
              : 'No data loaded'
          }
          icon={TrendingUp}
          accent="#ff9900"
        />
        <StatCard
          label="Avg confidence"
          value={mapped ? `${Math.round(avgConfidence * 100)}%` : '—'}
          detail={mapped ? `${totalKpiGaps} KPI gaps identified` : 'No analysis yet'}
          icon={ShieldCheck}
          accent="#5f6b7a"
        />
      </div>

      <div className="dashboard-grid">
        {/* Panel 1: Modernization direction (source-centric) */}
        <section className="panel">
          <div className="panel-heading">
            <div>
              <p className="panel-kicker">Modernization direction · per source</p>
              <h2>Source disposition distribution</h2>
            </div>
            <span className="panel-badge">{mapped} source reports</span>
          </div>
          <div className="decision-bars">
            {decisionCounts.map(item => {
              const denom = mapped || 1;
              const pct = (item.count / denom) * 100;
              return (
                <div key={item.label} className="decision-bar-row">
                  <div className="flex items-center justify-between">
                    <DecisionPill decision={item.label} />
                    <span className="font-bold text-[#0f172a]">{item.count}</span>
                  </div>
                  <div className="chart-track">
                    <div
                      className="chart-fill"
                      style={{ width: `${pct}%`, background: DECISION_STYLE[item.label].accent }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          <div className="panel-divider" />
          <div className="panel-subheading">KPI overlap buckets</div>
          <div className="bucket-chart">
            {overlapBuckets.map(bucket => (
              <div key={bucket.label} className="bucket">
                <div className="bucket-column">
                  <span style={{ height: `${Math.max(6, (bucket.count / maxBucket) * 100)}%` }} />
                </div>
                <strong>{bucket.count}</strong>
                <p>{bucket.label}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Panel 2: Governance status + confidence */}
        <section className="panel">
          <div className="panel-heading">
            <div>
              <p className="panel-kicker">Governance</p>
              <h2>Approval status</h2>
            </div>
            <span className="panel-badge">{mapped} total</span>
          </div>
          <div className="decision-bars">
            {statusCounts.map(item => {
              const pct = mapped ? (item.count / mapped) * 100 : 0;
              return (
                <div key={item.label} className="decision-bar-row">
                  <div className="flex items-center justify-between">
                    <span
                      className="status-label-chip"
                      style={{ background: item.bg, color: item.text }}
                    >
                      {item.label}
                    </span>
                    <span className="font-bold text-[#0f172a]">{item.count}</span>
                  </div>
                  <div className="chart-track">
                    <div className="chart-fill" style={{ width: `${pct}%`, background: item.color }} />
                  </div>
                </div>
              );
            })}
          </div>
          <div className="panel-divider" />
          <div className="panel-subheading">Confidence tiers</div>
          <div className="conf-tier-grid">
            {confTiers.map(tier => (
              <div key={tier.label} className="conf-tier">
                <div className="conf-tier-bar">
                  <span
                    style={{
                      height: `${mapped ? Math.max(8, (tier.count / mapped) * 100) : 8}%`,
                      background: tier.color,
                    }}
                  />
                </div>
                <strong>{tier.count}</strong>
                <p>{tier.label}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Panel 3: Domain portfolio */}
        <section className="panel">
          <div className="panel-heading">
            <div>
              <p className="panel-kicker">Portfolio view</p>
              <h2>Coverage by domain</h2>
            </div>
            <div className="domain-legend">
              <span><i style={{ background: '#0972d3' }} />{SOURCE_ORG}</span>
              <span><i style={{ background: '#ff9900' }} />{TARGET_ORG}</span>
            </div>
            {!domainCounts.length && <p className="panel-empty-note">No domain data — load reports from Dashboard.</p>}
          </div>
          <div className="domain-grid">
            {domainCounts.map(item => (
              <div key={item.domain} className="domain-row">
                <span>{item.domain}</span>
                <div className="domain-track">
                  <div className="domain-fill source" style={{ width: `${(item.sources / maxDomain) * 100}%` }} />
                  <div className="domain-fill target" style={{ width: `${(item.targets / maxDomain) * 100}%` }} />
                </div>
                <strong>{item.sources}/{item.targets}</strong>
              </div>
            ))}
          </div>
        </section>
      </div>

      <HelpChatBox
        tab="dashboard"
        ctx={{
          thresholds,
          sourceCount: allSources.length,
          targetCount: allTargets.length,
          decisionCount: decisions.length,
        }}
      />
    </main>
  );
}

// ---- Shared sub-components ----

function Sidebar<T extends { id: string; name: string; domain: string }>({
  title,
  items,
  selectedId,
  onSelect,
}: {
  title: string;
  items: T[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const filtered = items.filter(item =>
    `${item.id} ${item.name} ${item.domain}`.toLowerCase().includes(query.toLowerCase())
  );
  return (
    <aside className="record-sidebar">
      <div className="sidebar-title">
        <h3>{title}</h3>
        <p>{items.length} reports</p>
      </div>
      <div className="sidebar-search">
        <Search size={14} />
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search reports" />
      </div>
      <div className="sidebar-list">
        {items.length === 0 ? (
          <div className="sidebar-empty">No reports loaded — load report folders from Dashboard.</div>
        ) : (
          filtered.map(item => (
            <button
              key={item.id}
              className={classNames('sidebar-item', selectedId === item.id && 'active')}
              onClick={() => onSelect(item.id)}
            >
              <span>{item.id}</span>
              <strong>{item.name}</strong>
              <em>{item.domain}</em>
            </button>
          ))
        )}
      </div>
    </aside>
  );
}

function TableDependencies({ queries }: { queries: QueryItem[] }) {
  const tables = [...new Set(queries.flatMap(q => q.tables))].map(table => ({
    table,
    queries: queries
      .filter(q => q.tables.includes(table))
      .map(q => (q.id.split('_Q')[1] ? `Q${q.id.split('_Q')[1]}` : q.id)),
    joins: queries.filter(q => q.tables.includes(table)).flatMap(q => q.joins).length,
  }));

  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="panel-kicker">Lineage</p>
          <h2>Table dependencies</h2>
        </div>
        <span className="panel-badge">{tables.length} tables</span>
      </div>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Table</th>
              <th>Type</th>
              <th>Used in</th>
              <th>Joins</th>
            </tr>
          </thead>
          <tbody>
            {tables.length === 0 ? (
              <tr className="placeholder-row">
                <td>—</td>
                <td>—</td>
                <td>—</td>
                <td>—</td>
              </tr>
            ) : (
              tables.map(row => (
                <tr key={row.table}>
                  <td className="font-mono">{row.table}</td>
                  <td>
                    <span className="soft-tag">
                      {row.table.startsWith('dim_') || row.table.startsWith('ref_') ? 'Dimension' : 'Fact'}
                    </span>
                  </td>
                  <td>{row.queries.join(', ')}</td>
                  <td>{row.joins}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SqlExplorer({ queries }: { queries: QueryItem[] }) {
  const [selectedQuery, setSelectedQuery] = useState(queries[0]?.id ?? '');
  const query = queries.find(q => q.id === selectedQuery) ?? queries[0];
  useEffect(() => {
    setSelectedQuery(queries[0]?.id ?? '');
  }, [queries]);

  if (!query) {
    return (
      <section className="panel sql-panel">
        <div className="panel-heading">
          <div>
            <p className="panel-kicker">SQL and logic</p>
            <h2>—</h2>
          </div>
        </div>
        <div className="query-tabs">
          <button disabled>Q1</button>
        </div>
        <div className="metadata-strip">
          <span>0 tables</span>
          <span>0 aggregations</span>
          <span>0 filters</span>
          <span>0 joins</span>
        </div>
        <pre className="sql-code">-- Load reports from Dashboard to view SQL.</pre>
      </section>
    );
  }

  return (
    <section className="panel sql-panel">
      <div className="panel-heading">
        <div>
          <p className="panel-kicker">SQL and logic</p>
          <h2>{query.kpiName}</h2>
        </div>
      </div>
      <div className="query-tabs">
        {queries.map((item, index) => (
          <button
            key={item.id}
            className={classNames(selectedQuery === item.id && 'active')}
            onClick={() => setSelectedQuery(item.id)}
          >
            Q{index + 1}
          </button>
        ))}
      </div>
      <div className="metadata-strip">
        <span>{query.tables.length} tables</span>
        <span>{query.aggregations.length} aggregations</span>
        <span>{query.filters.length} filters</span>
        <span>{query.joins.length} joins</span>
      </div>
      <pre className="sql-code">{query.fullSql}</pre>
    </section>
  );
}

function RecordHeader({
  report,
  type,
  parsedAt,
}: {
  report: FullReport | TargetDetailReport;
  type: 'Source' | 'Target';
  parsedAt?: number;
}) {
  const estate = type === 'Source' ? SOURCE_ORG : TARGET_ORG;
  const role = type === 'Source' ? 'Source estate' : 'Reference catalog';
  const hasReal = report.id !== '—';

  return (
    <section className="record-header">
      <div>
        <p className="eyebrow">{estate} {type === 'Source' ? 'source' : 'reference'} report</p>
        <h2>{report.name}</h2>
        <p>{report.description}</p>
        {hasReal && <ProvenanceBadge source="parser" at={parsedAt} />}
      </div>
      <div className="record-meta-grid">
        <span><strong>ID</strong>{report.id}</span>
        <span><strong>Domain</strong>{report.domain}</span>
        <span><strong>Estate</strong>{estate}</span>
        <span><strong>Role</strong>{role}</span>
        <span><strong>Owner</strong>{report.owner}</span>
        <span><strong>Queries</strong>{report.numQueries}</span>
      </div>
    </section>
  );
}

// ---- Tab views ----

// Normalize a table name the same way server/lib/parser.ts does — strip vendor prefixes
// so cross-schema equivalence is visible (dim_customer ≡ vz_customer).
function normalizeTableName(t: string): string {
  return t.toLowerCase().replace(/^(fact_|dim_|ref_|tgt_|vz_|mkt_)/, '');
}

function CoverageMatrix({
  source,
  target,
  overlapPercent,
  decision,
  parsedAt,
}: {
  source: FullReport;
  target: TargetDetailReport | null;
  overlapPercent: number;
  decision: Decision;
  parsedAt?: number;
}) {
  const noTarget = !target || target.id === '—';

  const tgtAliases = new Set(target?.kpis.map(k => k.alias.toLowerCase()) ?? []);
  const tgtColumns = new Set(target?.kpis.map(k => k.column.toLowerCase()) ?? []);
  const tgtTablesNorm = new Set((target?.allTables ?? []).map(normalizeTableName));

  const kpiRows = source.allKpis.map(k => ({
    alias:    k.alias,
    column:   k.column,
    aliasOk:  tgtAliases.has(k.alias.toLowerCase()),
    columnOk: tgtColumns.has(k.column.toLowerCase()),
  }));
  const tableRows = source.allTables.map(t => ({
    table:      t,
    normalized: normalizeTableName(t),
    ok:         tgtTablesNorm.has(normalizeTableName(t)),
  }));

  const aliasMatched  = kpiRows.filter(r => r.aliasOk).length;
  const columnMatched = kpiRows.filter(r => r.columnOk).length;
  const tableMatched  = tableRows.filter(r => r.ok).length;

  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="panel-kicker">Source → Reference alignment</p>
          <h2>
            Coverage against{' '}
            {noTarget ? <em>no matched reference</em> : <strong>{target!.name}</strong>}
          </h2>
        </div>
        <span className="panel-badge">
          {Math.round(overlapPercent)} % overlap · {decision}
        </span>
        <ProvenanceBadge source="deterministic" at={parsedAt} />
      </div>

      <div className="coverage-breakdown">
        <div>
          <span className="coverage-stat-label">Alias matches</span>
          <strong>{aliasMatched} / {kpiRows.length}</strong>
          <em>50 % weight</em>
        </div>
        <div>
          <span className="coverage-stat-label">Column matches</span>
          <strong>{columnMatched} / {kpiRows.length}</strong>
          <em>30 % weight</em>
        </div>
        <div>
          <span className="coverage-stat-label">Table matches (normalized)</span>
          <strong>{tableMatched} / {tableRows.length}</strong>
          <em>20 % weight</em>
        </div>
      </div>

      <div className="coverage-grid">
        <div>
          <div className="coverage-subheading">KPI coverage</div>
          <div className="table-scroll coverage-table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Source KPI alias</th>
                  <th>Column</th>
                  <th>Alias in target?</th>
                  <th>Column in target?</th>
                </tr>
              </thead>
              <tbody>
                {kpiRows.length === 0 ? (
                  <tr className="placeholder-row"><td>—</td><td>—</td><td>—</td><td>—</td></tr>
                ) : kpiRows.map((k, i) => (
                  <tr key={`${k.alias}-${i}`}>
                    <td className="font-mono">{k.alias}</td>
                    <td className="font-mono">{k.column}</td>
                    <td>
                      <span className={classNames('coverage-flag', k.aliasOk ? 'ok' : 'gap')}>
                        {k.aliasOk ? '✓ matched' : '✗ gap'}
                      </span>
                    </td>
                    <td>
                      <span className={classNames('coverage-flag', k.columnOk ? 'ok' : 'gap')}>
                        {k.columnOk ? '✓ matched' : '✗ gap'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <div className="coverage-subheading">Table normalization</div>
          <div className="table-scroll coverage-table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Source table</th>
                  <th>Normalized</th>
                  <th>Present in target?</th>
                </tr>
              </thead>
              <tbody>
                {tableRows.length === 0 ? (
                  <tr className="placeholder-row"><td>—</td><td>—</td><td>—</td></tr>
                ) : tableRows.map((t, i) => (
                  <tr key={`${t.table}-${i}`}>
                    <td className="font-mono">{t.table}</td>
                    <td className="font-mono subtext">{t.normalized}</td>
                    <td>
                      <span className={classNames('coverage-flag', t.ok ? 'ok' : 'gap')}>
                        {t.ok ? '✓ matched' : '✗ gap'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}

function SourceLineageView({
  sources,
  targets,
  selectedId,
  setSelectedId,
  decisions,
  targetCount,
  phase,
  timings,
}: {
  sources: FullReport[];
  targets: TargetDetailReport[];
  selectedId: string | null;
  setSelectedId: (id: string) => void;
  decisions: RationalizationDecision[];
  targetCount: number;
  phase: WorkbenchPhase;
  timings: PhaseTimings;
}) {
  const realSelected = sources.find(r => r.id === selectedId) ?? sources[0] ?? null;
  const selected = realSelected ?? placeholderSource();
  const decision = realSelected ? getSourceDecision(realSelected, decisions) : null;
  const matchedTarget = decision?.targetId
    ? (targets.find(t => t.id === decision.targetId) ?? null)
    : (realSelected?.bestMatchTargetId
        ? (targets.find(t => t.id === realSelected.bestMatchTargetId) ?? null)
        : null);
  const events = buildSourceTrail(selected, decision, targetCount, phase, timings);

  return (
    <main className="workspace three-column">
      <Sidebar title="Source lineage" items={sources} selectedId={selected.id} onSelect={setSelectedId} />
      <div className="record-workspace">
        <RecordHeader report={selected} type="Source" parsedAt={timings.loadCompletedAt} />
        <TableDependencies queries={selected.queries.source} />
        <CoverageMatrix
          source={selected}
          target={matchedTarget}
          overlapPercent={decision?.overlapPercent ?? selected.overlapPercent ?? 0}
          decision={decision?.decision ?? selected.decision ?? 'Migrate'}
          parsedAt={timings.loadCompletedAt}
        />
        <SqlExplorer queries={selected.queries.source} />
      </div>
      <RationalizationTrail events={events} />
    </main>
  );
}

function TargetLineageView({
  targets,
  selectedId,
  setSelectedId,
  sourceCount,
  phase,
  timings,
}: {
  targets: TargetDetailReport[];
  selectedId: string | null;
  setSelectedId: (id: string) => void;
  sourceCount: number;
  phase: WorkbenchPhase;
  timings: PhaseTimings;
}) {
  const realSelected = targets.find(r => r.id === selectedId) ?? targets[0] ?? null;
  const selected = realSelected ?? placeholderTarget();
  const queries = selected.queries.map(q => ({ ...q, preview: q.fullSql.slice(0, 80) }));
  const events = buildTargetTrail(selected, sourceCount, phase, timings);

  return (
    <main className="workspace three-column">
      <Sidebar title="Target lineage" items={targets} selectedId={selected.id} onSelect={setSelectedId} />
      <div className="record-workspace">
        <RecordHeader report={selected} type="Target" parsedAt={timings.loadCompletedAt} />
        <TableDependencies queries={queries} />
        <SqlExplorer queries={queries} />
      </div>
      <RationalizationTrail events={events} />
    </main>
  );
}

function MetadataView({
  type,
  reports,
  selectedId,
  setSelectedId,
  decisions,
  targetCount,
  sourceCount,
  phase,
  timings,
}: {
  type: 'Source' | 'Target';
  reports: Array<FullReport | TargetDetailReport>;
  selectedId: string | null;
  setSelectedId: (id: string) => void;
  decisions?: RationalizationDecision[];
  targetCount?: number;
  sourceCount?: number;
  phase: WorkbenchPhase;
  timings: PhaseTimings;
}) {
  const realSelected = reports.find(r => r.id === selectedId) ?? reports[0] ?? null;
  const selected: FullReport | TargetDetailReport =
    realSelected ?? (type === 'Source' ? placeholderSource() : placeholderTarget());

  const kpis = 'allKpis' in selected ? selected.allKpis : selected.kpis;
  const tables: string[] = selected.allTables;
  const sidebarItems = reports.map(r => ({ id: r.id, name: r.name, domain: r.domain }));
  const decision = decisions ? (decisions.find(d => d.sourceId === selected.id) ?? null) : null;

  const trailEvents =
    type === 'Source' && 'allKpis' in selected
      ? buildSourceTrail(selected as FullReport, decision, targetCount ?? 0, phase, timings)
      : buildTargetTrail(selected as TargetDetailReport, sourceCount ?? 0, phase, timings);

  return (
    <main className="workspace three-column">
      <Sidebar
        title={`${type === 'Source' ? SOURCE_ORG : TARGET_ORG} metadata`}
        items={sidebarItems}
        selectedId={selected.id}
        onSelect={setSelectedId}
      />
      <div className="record-workspace">
        <RecordHeader report={selected} type={type} parsedAt={timings.loadCompletedAt} />
        <div className="metadata-grid">
          <section className="panel">
            <div className="panel-heading">
              <div>
                <p className="panel-kicker">Business context</p>
                <h2>{type === 'Source' ? 'Source report purpose and usage' : 'Reference report context'}</h2>
              </div>
            </div>
            <p className="business-copy">{selected.description}</p>
            {'usageFrequency' in selected && (
              <div className="context-metrics">
                <span><strong>{selected.usageFrequency}</strong> weekly uses</span>
                <span><strong>{selected.kpiDelta.filter(k => k.missingInTarget).length}</strong> KPI gaps</span>
                <span>
                  <strong>{decision?.targetName ?? selected.bestMatchTargetName ?? 'Analysis pending'}</strong>
                  Mapped reference
                </span>
              </div>
            )}
            {!('usageFrequency' in selected) && (
              <div className="context-metrics">
                <span><strong>Reference</strong> estate</span>
                <span><strong>{kpis.length}</strong> reference KPIs</span>
                <span><strong>{tables.length}</strong> governed tables</span>
              </div>
            )}
            {decision && (
              <div className="engine-note">
                <ShieldCheck size={16} />
                <span>{decision.rationale}</span>
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-heading">
              <div>
                <p className="panel-kicker">Schema</p>
                <h2>Tables and semantic layer</h2>
              </div>
            </div>
            <div className="schema-cloud">
              {tables.length === 0
                ? <span className="placeholder-chip">—</span>
                : tables.map(table => <span key={table}>{table}</span>)}
            </div>
          </section>
        </div>

        <section className="panel">
          <div className="panel-heading">
            <div>
              <p className="panel-kicker">Measures</p>
              <h2>{type === 'Source' ? 'Source KPIs and formulas' : 'Reference KPIs and formulas'}</h2>
            </div>
            <span className="panel-badge">{kpis.length} KPIs</span>
          </div>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>KPI</th>
                  <th>Aggregation</th>
                  <th>Column</th>
                  <th>Formula</th>
                  <th>Query</th>
                </tr>
              </thead>
              <tbody>
                {kpis.length === 0 ? (
                  <tr className="placeholder-row">
                    <td>—</td>
                    <td>—</td>
                    <td>—</td>
                    <td>—</td>
                    <td>—</td>
                  </tr>
                ) : (
                  kpis.map(kpi => (
                    <tr key={`${kpi.alias}-${kpi.queryFile}`}>
                      <td className="font-bold">{kpi.alias}</td>
                      <td>{kpi.agg}</td>
                      <td className="font-mono">{kpi.column}</td>
                      <td className="font-mono">{kpi.formula}</td>
                      <td>{kpi.queryFile}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
      <RationalizationTrail events={trailEvents} />
    </main>
  );
}

function DecisionView({
  sources,
  targets,
  allTargets,
  decisions,
  phase,
  analysisNote,
  timings,
  inventory,
  liveStats,
  onApprove,
  onOverride,
  onRemap,
}: {
  sources: FullReport[];
  targets: TargetReport[];
  allTargets: TargetDetailReport[];
  decisions: RationalizationDecision[];
  phase: WorkbenchPhase;
  analysisNote: string | null;
  timings: PhaseTimings;
  inventory: ReportInventory | null;
  liveStats: LiveAnalysisStats;
  onApprove: (sourceId: string) => void;
  onOverride: (sourceId: string) => void;
  onRemap: (sourceId: string) => void;
}) {
  const [filterSearch,   setFilterSearch]   = useState('');
  const [filterDomain,   setFilterDomain]   = useState('');
  const [filterDecision, setFilterDecision] = useState('');
  const [filterStatus,   setFilterStatus]   = useState('');

  const trailEvents = buildProgramTrail(sources.length, targets.length, decisions, inventory, liveStats, phase, timings);

  const allDomains = [...new Set(sources.map(s => s.domain))].sort();

  const filteredSources = sources.filter(source => {
    const d = getSourceDecision(source, decisions);
    const search = filterSearch.toLowerCase();
    if (search && !source.name.toLowerCase().includes(search) && !source.id.toLowerCase().includes(search)) return false;
    if (filterDomain   && source.domain !== filterDomain) return false;
    if (filterDecision && (d?.decision ?? source.decision) !== filterDecision) return false;
    if (filterStatus   && (d?.status ?? source.status) !== filterStatus) return false;
    return true;
  });

  const sourceRows = filteredSources.map(source => ({
    source,
    decision: getSourceDecision(source, decisions),
  }));
  const decisionCounts = (['Rationalize', 'Consolidate', 'Migrate'] as Decision[]).map(label => ({
    label,
    count: decisions.filter(d => d.decision === label).length,
  }));

  return (
    <main className="workspace decision-workspace">
      <HelpChatBox tab="decision" ctx={{ thresholds: DEFAULT_THRESHOLDS, sourceCount: sources.length, targetCount: targets.length, decisionCount: decisions.length }} />
      <section className="panel decision-table-panel">
        <div className="panel-heading">
          <div>
            <p className="panel-kicker">Governance · source-centric</p>
            <h2>Source disposition matrix · {sources.length || '—'} source reports</h2>
          </div>
          <span className="panel-badge">
            {decisionCounts.find(d => d.label === 'Rationalize')?.count ?? 0} Rationalize ·{' '}
            {decisionCounts.find(d => d.label === 'Consolidate')?.count ?? 0} Consolidate ·{' '}
            {decisionCounts.find(d => d.label === 'Migrate')?.count ?? 0} Migrate
          </span>
          <ProvenanceBadge source="deterministic" at={timings.loadCompletedAt} />
          {timings.analysisCompletedAt && (
            <ProvenanceBadge source="enrichment" at={timings.analysisCompletedAt} />
          )}
          {sources.length > 0 && (
            <button
              className="intake-toggle-btn"
              onClick={() => exportDecisionsToCsv(sources, decisions)}
              title="Download disposition matrix as CSV"
            >
              <Download size={13} />
              Export CSV
            </button>
          )}
        </div>
        {sources.length > 0 && (
          <div className="disposition-filters">
            <div className="sidebar-search" style={{ flex: '1 1 180px', minWidth: 0 }}>
              <Search size={13} />
              <input
                value={filterSearch}
                onChange={e => setFilterSearch(e.target.value)}
                placeholder="Search by name or ID…"
              />
              {filterSearch && (
                <button style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }} onClick={() => setFilterSearch('')}>
                  <X size={12} />
                </button>
              )}
            </div>
            <select
              className="filter-select"
              value={filterDomain}
              onChange={e => setFilterDomain(e.target.value)}
            >
              <option value="">All domains</option>
              {allDomains.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
            <select
              className="filter-select"
              value={filterDecision}
              onChange={e => setFilterDecision(e.target.value)}
            >
              <option value="">All dispositions</option>
              <option>Migrate</option>
              <option>Consolidate</option>
              <option>Rationalize</option>
            </select>
            <select
              className="filter-select"
              value={filterStatus}
              onChange={e => setFilterStatus(e.target.value)}
            >
              <option value="">All statuses</option>
              <option>Pending</option>
              <option>Approved</option>
              <option>Overridden</option>
            </select>
            {(filterSearch || filterDomain || filterDecision || filterStatus) && (
              <span className="provenance-badge" style={{ background: '#fff7ed', color: '#9a3412' }}>
                {sourceRows.length}/{sources.length} shown
              </span>
            )}
          </div>
        )}
        {phase === 'analysing' && (
          <div className="empty-intelligence">
            <Loader2 size={16} className="animate-spin" />
            <span>Enriching rationale — dispositions and overlap are already final.</span>
          </div>
        )}
        {phase === 'ready' && analysisNote && (
          <div className="empty-intelligence info">
            <AlertCircle size={16} />
            <span>{analysisNote}</span>
          </div>
        )}
        <div className="table-scroll">
          <table className="data-table decision-table">
            <thead>
              <tr>
                <th>Source report</th>
                <th>Domain</th>
                <th>Reference report</th>
                <th>Overlap</th>
                <th>Disposition</th>
                <th>Confidence</th>
                <th>KPI gaps</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sourceRows.length === 0 ? (
                <tr className="placeholder-row">
                  <td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td>
                </tr>
              ) : (
                sourceRows.map(({ source, decision }) => {
                  const overlap = decision?.overlapPercent ?? source.overlapPercent;
                  const targetName = decision?.targetName ?? source.bestMatchTargetName;
                  const targetId = decision?.targetId ?? source.bestMatchTargetId;
                  const kpiGapCount = decision?.kpiGaps?.length
                    ?? source.kpiDelta.filter(k => k.missingInTarget).length;
                  const status = decision?.status ?? source.status;
                  return (
                    <tr key={source.id}>
                    <td>
                      <strong>{source.name}</strong>
                      <span className="subtext">{source.id}</span>
                    </td>
                    <td>{source.domain}</td>
                    <td>
                      {targetName ? (
                        <>
                          <strong>{targetName}</strong>
                          <span className="subtext">{targetId}</span>
                        </>
                      ) : (
                        <span className="subtext">—</span>
                      )}
                    </td>
                    <td>
                      <div className="mini-overlap">
                        <span>{formatPercent(overlap)}</span>
                        <div>
                          <i style={{ width: `${overlap}%`, background: overlapColor(overlap) }} />
                        </div>
                      </div>
                    </td>
                    <td>{decision ? <DecisionPill decision={decision.decision} /> : <DecisionPill decision={source.decision} />}</td>
                    <td>{decision ? <ConfidencePill score={decision.confidenceScore} /> : <ConfidencePill score={source.confidenceScore} />}</td>
                    <td><span className="font-mono">{kpiGapCount}</span></td>
                    <td><span className="soft-tag">{status}</span></td>
                    <td>
                      <div className="row-actions">
                        <button
                          disabled={!decision}
                          onClick={() => onApprove(source.id)}
                          title="Approve this source disposition"
                        >
                          Approve
                        </button>
                        <button
                          onClick={() => onOverride(source.id)}
                          title="Override disposition manually"
                        >
                          Override
                        </button>
                        <button
                          className="remap-btn"
                          onClick={() => onRemap(source.id)}
                          title="Remap to a different domain or reference report and recompute"
                        >
                          Remap
                        </button>
                      </div>
                    </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
      <RationalizationTrail events={trailEvents} title="Program Trail" />
    </main>
  );
}

// ---- Remap modal helpers ----
// Overlap and gap helpers that honour the FieldMapping[] selections made inside
// the modal. The alias component resolves source aliases through the mapping
// before checking coverage, so a manually paired KPI alias counts as matched.

function clientOverlapWithRemapMappings(
  src: FullReport,
  tgt: TargetDetailReport,
  fms: FieldMapping[],
): number {
  const aliasMap = new Map(
    fms.filter(m => m.targetAlias).map(m => [m.sourceAlias, m.targetAlias!]),
  );
  const srcAliases = new Set(src.allKpis.map(k => aliasMap.get(k.alias) ?? k.alias));
  const tgtAliases = new Set(tgt.kpis.map(k => k.alias));
  const srcCols    = new Set(src.allKpis.map(k => k.column));
  const tgtCols    = new Set(tgt.kpis.map(k => k.column));
  const srcTables  = new Set(src.allTables.map(normTable));
  const tgtTables  = new Set(tgt.allTables.map(normTable));
  const srcDims    = new Set(src.allDimensions);
  const tgtDims    = new Set(tgt.allDimensions);
  const aliasScore = srcAliases.size ? [...srcAliases].filter(a => tgtAliases.has(a)).length / srcAliases.size : 0;
  const colScore   = srcCols.size    ? [...srcCols].filter(c => tgtCols.has(c)).length    / srcCols.size    : 0;
  const tableScore = srcTables.size  ? [...srcTables].filter(t => tgtTables.has(t)).length / srcTables.size : 0;
  const dimScore   = srcDims.size    ? [...srcDims].filter(d => tgtDims.has(d)).length    / srcDims.size    : 0;
  const raw = srcDims.size > 0
    ? aliasScore * 0.40 + colScore * 0.20 + tableScore * 0.15 + dimScore * 0.25
    : aliasScore * 0.50 + colScore * 0.30 + tableScore * 0.20;
  return Math.min(100, Math.round(raw * 100));
}

function clientKpiGapsWithRemapMappings(
  src: FullReport,
  tgt: TargetDetailReport,
  fms: FieldMapping[],
): string[] {
  const aliasMap = new Map(
    fms.filter(m => m.targetAlias).map(m => [m.sourceAlias, m.targetAlias!]),
  );
  const tgtAliasSet = new Set(tgt.kpis.map(k => k.alias));
  const seen = new Set<string>();
  return src.allKpis.filter(k => {
    if (seen.has(k.alias)) return false;
    seen.add(k.alias);
    return !tgtAliasSet.has(aliasMap.get(k.alias) ?? k.alias);
  }).map(k => k.alias);
}

// ---- Remap modal ----
// Lets the user point a source report at a different target domain/report and
// immediately see the recomputed overlap %, decision band, and KPI gaps before
// confirming. The recomputation uses the same weighted alias/column/table formula
// as the server — no manual overlap input required.

function RemapModal({
  source,
  allTargets,
  allDomains,
  existing,
  thresholds,
  onClose,
  onApply,
}: {
  source: FullReport;
  allTargets: TargetDetailReport[];
  allDomains: string[];
  existing: RationalizationDecision | null;
  thresholds: ThresholdConfig;
  onClose: () => void;
  onApply: (updated: RationalizationDecision) => void;
}) {
  const [newTargetId,    setNewTargetId]    = useState(existing?.targetId ?? allTargets[0]?.id ?? '');
  const [newDomain,      setNewDomain]      = useState(existing?.domain   ?? source.domain);
  const [focusKpi,       setFocusKpi]       = useState('');
  const [reason,         setReason]         = useState('');
  const [fieldMappings,  setFieldMappings]  = useState<FieldMapping[]>([]);
  const [showFieldMap,   setShowFieldMap]   = useState(true);

  // Build field mappings whenever the resolved target changes.
  const buildFieldMappings = useCallback((tgt: TargetDetailReport | null): FieldMapping[] => {
    if (!tgt) return [];
    const srcKpis = source.allKpis.filter((k, i, arr) => arr.findIndex(x => x.alias === k.alias) === i);
    return srcKpis.map(k => {
      const exactMatch = tgt.kpis.find(t => t.alias === k.alias) ?? null;
      const colMatch   = !exactMatch ? (tgt.kpis.find(t => t.column === k.column) ?? null) : null;
      const matched    = exactMatch ?? colMatch;
      return {
        sourceAlias:  k.alias,
        sourceColumn: k.column,
        targetAlias:  matched?.alias  ?? null,
        targetColumn: matched?.column ?? null,
      };
    });
  }, [source]);

  // When domain changes, auto-select the best-matching target in that domain
  // so overlap / confidence / KPI gaps recompute against a relevant reference.
  useEffect(() => {
    const pool = allTargets.filter(t => t.domain === newDomain);
    const candidates = pool.length > 0 ? pool : allTargets;
    if (candidates.length === 0) return;
    const best = candidates.reduce((b, t) =>
      clientComputeOverlap(source, t) > clientComputeOverlap(source, b) ? t : b
    , candidates[0]);
    setNewTargetId(best.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newDomain]);

  // Reinitialise field mappings whenever the target selection changes.
  useEffect(() => {
    const tgt = allTargets.find(t => t.id === newTargetId) ?? null;
    setFieldMappings(buildFieldMappings(tgt));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newTargetId]);

  // Targets for the dropdown: domain-filtered pool first, then rest.
  // When a focus KPI is set, within each group sort targets that cover it to the top.
  const rankTarget = (t: TargetDetailReport) =>
    focusKpi ? (t.kpis.some(k => k.alias === focusKpi) ? 0 : 1) : 0;

  const domainTargets = [...allTargets.filter(t => t.domain === newDomain)]
    .sort((a, b) => rankTarget(a) - rankTarget(b));
  const otherTargets  = [...allTargets.filter(t => t.domain !== newDomain)]
    .sort((a, b) => rankTarget(a) - rankTarget(b));

  const newTarget  = allTargets.find(t => t.id === newTargetId) ?? null;
  const overlap    = newTarget ? clientOverlapWithRemapMappings(source, newTarget, fieldMappings) : 0;
  const decision   = decisionFromOverlap(overlap, thresholds);
  const kpiGaps    = newTarget ? clientKpiGapsWithRemapMappings(source, newTarget, fieldMappings) : [];
  const confidence = clientConfidence(overlap);

  const sourceKpiAliases = [...new Set(source.allKpis.map(k => k.alias))].sort();
  const focusKpiCoveredByTarget = focusKpi && newTarget
    ? newTarget.kpis.some(k => k.alias === focusKpi)
    : null;


  const handleApply = () => {
    const manualMappings = fieldMappings.filter(m => {
      const hasExactMatch = newTarget?.kpis.some(k => k.alias === m.sourceAlias) ?? false;
      const isAutoValue = hasExactMatch && m.targetAlias === m.sourceAlias;
      return !isAutoValue && m.targetAlias !== null;
    });
    onApply({
      sourceId:        source.id,
      sourceName:      source.name,
      domain:          newDomain,
      targetId:        newTarget?.id ?? null,
      targetName:      newTarget?.name ?? null,
      overlapPercent:  overlap,
      decision,
      confidenceScore: confidence,
      rationale:       reason.trim()
        || `Remapped to "${newTarget?.name ?? 'none'}" (${newDomain} domain). Recomputed overlap: ${overlap}%. ${
            kpiGaps.length
              ? `${kpiGaps.length} KPI gap(s): ${kpiGaps.slice(0, 4).join(', ')}${kpiGaps.length > 4 ? '…' : ''}.`
              : 'All source KPIs covered.'
          }${manualMappings.length ? ` ${manualMappings.length} manual field mapping(s) captured.` : ''}`,
      kpiGaps,
      status:          'Overridden',
      source:          'manual',
      fieldMappings:   fieldMappings.length > 0 ? fieldMappings : undefined,
    });
  };

  const ds = DECISION_STYLE[decision];

  return (
    <div className="modal-backdrop">
      <div className="override-modal remap-modal">
        <div className="modal-header">
          <div>
            <p className="eyebrow">Domain / target remap</p>
            <h2>Remap report</h2>
            <p>{source.id} · {source.name}</p>
          </div>
          <button onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        <div className="modal-body">
          {/* Current mapping summary */}
          <div className="remap-current-row">
            <span className="remap-current-label">Current</span>
            <span className="remap-current-value">
              {source.domain} &rarr; {existing?.targetName ?? source.bestMatchTargetName ?? '—'}
              <span style={{ marginLeft: 8 }}>
                <DecisionPill decision={existing?.decision ?? source.decision} />
              </span>
              <span style={{ marginLeft: 6, fontVariantNumeric: 'tabular-nums', fontSize: 11, color: '#5f6b7a' }}>
                {formatPercent(existing?.overlapPercent ?? source.overlapPercent)} overlap
              </span>
            </span>
          </div>

          <label>
            New domain
            <select value={newDomain} onChange={e => setNewDomain(e.target.value)}>
              {allDomains.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>

          <label>
            Focus KPI / column <span className="modal-optional-hint">(optional — highlights coverage in the reference list)</span>
            <select value={focusKpi} onChange={e => setFocusKpi(e.target.value)}>
              <option value="">— none —</option>
              {sourceKpiAliases.map(alias => (
                <option key={alias} value={alias}>{alias}</option>
              ))}
            </select>
          </label>

          <label>
            New reference report
            <select value={newTargetId} onChange={e => setNewTargetId(e.target.value)}>
              {domainTargets.length > 0 && (
                <optgroup label={`${newDomain} (${domainTargets.length})`}>
                  {domainTargets.map(t => {
                    const coversFocus = focusKpi ? t.kpis.some(k => k.alias === focusKpi) : null;
                    return (
                      <option key={t.id} value={t.id}>
                        {coversFocus === true ? '✓ ' : coversFocus === false ? '✗ ' : ''}{t.name}
                      </option>
                    );
                  })}
                </optgroup>
              )}
              {otherTargets.length > 0 && (
                <optgroup label="Other domains">
                  {otherTargets.map(t => {
                    const coversFocus = focusKpi ? t.kpis.some(k => k.alias === focusKpi) : null;
                    return (
                      <option key={t.id} value={t.id}>
                        {coversFocus === true ? '✓ ' : coversFocus === false ? '✗ ' : ''}{t.name} ({t.domain})
                      </option>
                    );
                  })}
                </optgroup>
              )}
            </select>
          </label>

          <label>
            Remap rationale (optional)
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              rows={3}
              placeholder="Explain why this report is being remapped…"
            />
          </label>

          {/* Field mapping section */}
          {newTarget && fieldMappings.length > 0 && (
            <div className="field-map-section">
              <button
                type="button"
                className="field-map-toggle"
                onClick={() => setShowFieldMap(v => !v)}
              >
                <ChevronDown size={13} style={{ transform: showFieldMap ? 'rotate(180deg)' : undefined, transition: 'transform 0.2s' }} />
                Metadata field mapping
                <span className="field-map-badge">
                  {fieldMappings.filter(m => m.targetAlias !== null).length}/{fieldMappings.length} mapped
                </span>
                {fieldMappings.some(m => {
                  const isAuto = newTarget.kpis.some(k => k.alias === m.sourceAlias);
                  return !isAuto && m.targetAlias === null;
                }) && (
                  <span className="field-map-badge gap">
                    {fieldMappings.filter(m => {
                      const isAuto = newTarget.kpis.some(k => k.alias === m.sourceAlias);
                      return !isAuto && m.targetAlias === null;
                    }).length} unmapped
                  </span>
                )}
              </button>

              {showFieldMap && (
                <div className="field-map-grid">
                  <div className="field-map-header-row">
                    <span>Source field</span>
                    <span></span>
                    <span>Target field</span>
                    <span>Status</span>
                  </div>
                  {fieldMappings.map((fm, i) => {
                    const hasExactMatch = newTarget.kpis.some(k => k.alias === fm.sourceAlias);
                    const isAuto   = hasExactMatch && fm.targetAlias === fm.sourceAlias;
                    const isManual = !isAuto && fm.targetAlias !== null;
                    const isGap    = !isAuto && fm.targetAlias === null;
                    const statusCls = isAuto ? 'auto' : isManual ? 'manual' : 'gap';
                    const statusTxt = isAuto ? '✓ auto' : isManual ? '✓ manual' : '✗ gap';
                    return (
                      <div key={fm.sourceAlias} className={`field-map-row ${statusCls}`}>
                        <div className="field-map-cell">
                          <span className="field-map-alias">{fm.sourceAlias}</span>
                          <span className="field-map-col">{fm.sourceColumn}</span>
                        </div>
                        <span className="field-map-arrow">→</span>
                        <select
                          className="field-map-select"
                          value={fm.targetAlias ?? ''}
                          onChange={e => {
                            const picked = newTarget.kpis.find(k => k.alias === e.target.value) ?? null;
                            setFieldMappings(prev => prev.map((m, j) => j !== i ? m : {
                              ...m,
                              targetAlias:  picked?.alias  ?? null,
                              targetColumn: picked?.column ?? null,
                            }));
                          }}
                        >
                          <option value="">— unmatched —</option>
                          {newTarget.kpis.map(k => (
                            <option key={k.alias} value={k.alias}>
                              {k.alias} ({k.column})
                            </option>
                          ))}
                        </select>
                        <span className={`field-map-status ${statusCls}`}>{statusTxt}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Live recomputed result */}
        {newTarget && (
          <div className="remap-result-panel">
            <p className="remap-result-title">Recomputed result</p>
            <div className="remap-result-grid">
              <div className="remap-result-item">
                <span>Overlap</span>
                <strong style={{ color: overlapColor(overlap) }}>{formatPercent(overlap)}</strong>
              </div>
              <div className="remap-result-item">
                <span>Decision</span>
                <span
                  className="decision-pill"
                  style={{ background: ds.bg, color: ds.text, border: `1px solid ${ds.border}` }}
                >
                  {decision}
                </span>
              </div>
              <div className="remap-result-item">
                <span>Confidence</span>
                <strong>{Math.round(confidence * 100)}%</strong>
              </div>
              <div className="remap-result-item">
                <span>KPI gaps</span>
                <strong style={{ color: kpiGaps.length ? '#dc2626' : '#037f0c' }}>
                  {kpiGaps.length}
                </strong>
              </div>
              {focusKpiCoveredByTarget !== null && (
                <div className="remap-result-item remap-focus-kpi-result">
                  <span>Focus KPI "{focusKpi}"</span>
                  <span className={classNames('coverage-flag', focusKpiCoveredByTarget ? 'ok' : 'gap')}>
                    {focusKpiCoveredByTarget ? '✓ covered' : '✗ gap'}
                  </span>
                </div>
              )}
            </div>
            {kpiGaps.length > 0 && (
              <div className="remap-kpi-gaps">
                {kpiGaps.slice(0, 8).map(g => (
                  <span key={g} className="remap-gap-chip">{g}</span>
                ))}
                {kpiGaps.length > 8 && (
                  <span className="remap-gap-chip muted">+{kpiGaps.length - 8} more</span>
                )}
              </div>
            )}
          </div>
        )}

        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary-action"
            disabled={!newTarget}
            onClick={handleApply}
            title={!newTarget ? 'Select a reference report first' : undefined}
          >
            Apply remap
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Override modal ----

function OverrideModal({
  source,
  targets,
  existing,
  onClose,
  onSave,
}: {
  source: FullReport;
  targets: TargetReport[];
  existing: RationalizationDecision | null;
  onClose: () => void;
  onSave: (decision: RationalizationDecision) => void;
}) {
  const [decision, setDecision] = useState<Decision>(existing?.decision ?? 'Consolidate');
  const [targetId, setTargetId] = useState(existing?.targetId ?? targets[0]?.id ?? '');
  const [overlap, setOverlap] = useState(existing?.overlapPercent ?? 50);
  const [reason, setReason] = useState(existing?.rationale ?? '');
  const target = targets.find(t => t.id === targetId) ?? null;

  const save = () => {
    onSave({
      sourceId: source.id,
      sourceName: source.name,
      domain: source.domain,
      targetId: target?.id ?? null,
      targetName: target?.name ?? null,
      overlapPercent: overlap,
      decision,
      confidenceScore: existing?.confidenceScore ?? 0.75,
      rationale: reason || 'Manual override captured by analyst.',
      kpiGaps: existing?.kpiGaps ?? [],
      status: 'Overridden',
      source: 'manual',
    });
  };

  return (
    <div className="modal-backdrop">
      <div className="override-modal">
        <div className="modal-header">
          <div>
            <p className="eyebrow">Manual governance action</p>
            <h2>Override decision</h2>
            <p>{source.id} · {source.name}</p>
          </div>
          <button onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="modal-body">
          <label>
            Decision
            <select value={decision} onChange={e => setDecision(e.target.value as Decision)}>
              <option>Migrate</option>
              <option>Consolidate</option>
              <option>Rationalize</option>
            </select>
          </label>
          <label>
            Reference report
            <select value={targetId} onChange={e => setTargetId(e.target.value)}>
              {targets.map(t => (
                <option key={t.id} value={t.id}>{t.id} · {t.name}</option>
              ))}
            </select>
          </label>
          <label>
            Overlap %
            <input
              type="number"
              min={0}
              max={100}
              value={overlap}
              onChange={e => setOverlap(Number(e.target.value))}
            />
          </label>
          <label>
            Governance rationale
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              rows={4}
              placeholder="Explain why this decision overrides the generated recommendation."
            />
          </label>
        </div>
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary-action" onClick={save}>Save override</button>
        </div>
      </div>
    </div>
  );
}

// ---- Combined Source tab (Lineage + Metadata) ----

function SourceView({
  sources,
  targets,
  selectedId,
  setSelectedId,
  decisions,
  phase,
  timings,
}: {
  sources: FullReport[];
  targets: TargetDetailReport[];
  selectedId: string | null;
  setSelectedId: (id: string) => void;
  decisions: RationalizationDecision[];
  phase: WorkbenchPhase;
  timings: PhaseTimings;
}) {
  const [subTab, setSubTab] = useState<'lineage' | 'metadata'>('lineage');

  const realSelected = sources.find(r => r.id === selectedId) ?? sources[0] ?? null;
  const selected     = realSelected ?? placeholderSource();
  const decision     = realSelected ? getSourceDecision(realSelected, decisions) : null;
  const matchedTarget = decision?.targetId
    ? (targets.find(t => t.id === decision.targetId) ?? null)
    : (realSelected?.bestMatchTargetId
        ? (targets.find(t => t.id === realSelected.bestMatchTargetId) ?? null)
        : null);
  const events = buildSourceTrail(selected, decision, targets.length, phase, timings);

  const kpis       = selected.allKpis;
  const tables     = selected.allTables;
  const dimDelta   = selected.dimensionDelta ?? [];
  const dimensions = selected.allDimensions ?? [];

  return (
    <main className="workspace three-column">
      <HelpChatBox tab="source" ctx={{ thresholds: DEFAULT_THRESHOLDS, sourceCount: sources.length, targetCount: targets.length, decisionCount: decisions.length }} />
      <Sidebar title="Source reports" items={sources} selectedId={selected.id} onSelect={setSelectedId} />

      <div className="record-workspace">
        {/* Sub-tab switcher */}
        <div className="subtab-bar">
          <button
            className={classNames('subtab-btn', subTab === 'lineage' && 'active')}
            onClick={() => setSubTab('lineage')}
          >
            <GitBranch size={13} /> Lineage
          </button>
          <button
            className={classNames('subtab-btn', subTab === 'metadata' && 'active')}
            onClick={() => setSubTab('metadata')}
          >
            <FileText size={13} /> Metadata
          </button>
        </div>

        <RecordHeader report={selected} type="Source" parsedAt={timings.loadCompletedAt} />

        {subTab === 'lineage' && (
          <>
            <TableDependencies queries={selected.queries.source} />
            <CoverageMatrix
              source={selected}
              target={matchedTarget}
              overlapPercent={decision?.overlapPercent ?? selected.overlapPercent ?? 0}
              decision={decision?.decision ?? selected.decision ?? 'Migrate'}
              parsedAt={timings.loadCompletedAt}
            />
            <SqlExplorer queries={selected.queries.source} />
          </>
        )}

        {subTab === 'metadata' && (
          <>
            <div className="metadata-grid">
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <p className="panel-kicker">Business context</p>
                    <h2>Source report purpose and usage</h2>
                  </div>
                </div>
                <p className="business-copy">{selected.description}</p>
                <div className="context-metrics">
                  <span><strong>{selected.usageFrequency}</strong> weekly uses</span>
                  <span><strong>{selected.kpiDelta.filter(k => k.missingInTarget).length}</strong> KPI gaps</span>
                  <span><strong>{dimDelta.filter((d: DimRow) => d.missingInTarget).length}</strong> Dim gaps</span>
                  <span>
                    <strong>{decision?.targetName ?? selected.bestMatchTargetName ?? 'Analysis pending'}</strong>
                    Mapped reference
                  </span>
                </div>
                {decision && (
                  <div className="engine-note">
                    <ShieldCheck size={16} />
                    <span>{decision.rationale}</span>
                  </div>
                )}
              </section>
              <section className="panel">
                <div className="panel-heading">
                  <div><p className="panel-kicker">Schema</p><h2>Tables and semantic layer</h2></div>
                </div>
                <div className="schema-cloud">
                  {tables.length === 0
                    ? <span className="placeholder-chip">—</span>
                    : tables.map(t => <span key={t}>{t}</span>)}
                </div>
              </section>
            </div>
            <section className="panel">
              <div className="panel-heading">
                <div><p className="panel-kicker">Measures</p><h2>Source KPIs and formulas</h2></div>
                <span className="panel-badge">{kpis.length} KPIs</span>
              </div>
              <div className="table-scroll">
                <table className="data-table">
                  <thead><tr><th>KPI</th><th>Aggregation</th><th>Column</th><th>Formula</th><th>Query</th></tr></thead>
                  <tbody>
                    {kpis.length === 0
                      ? <tr className="placeholder-row"><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>
                      : kpis.map(kpi => (
                          <tr key={`${kpi.alias}-${kpi.queryFile}`}>
                            <td className="font-bold">{kpi.alias}</td>
                            <td>{kpi.agg}</td>
                            <td className="font-mono">{kpi.column}</td>
                            <td className="font-mono">{kpi.formula}</td>
                            <td>{kpi.queryFile}</td>
                          </tr>
                        ))}
                  </tbody>
                </table>
              </div>
            </section>

            {/* Dimension fields comparison */}
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <p className="panel-kicker">Dimensions · vs reference</p>
                  <h2>Dimension field comparison</h2>
                </div>
                <span className="panel-badge">{dimensions.length} fields</span>
              </div>
              {dimensions.length === 0 ? (
                <p className="panel-empty-note">No GROUP BY dimensions extracted — SQL queries may use inline expressions or this report uses a non-SQL format.</p>
              ) : (
                <div className="dim-delta-grid">
                  {dimDelta.map((d: DimRow) => (
                    <div key={d.name} className={`dim-delta-chip ${d.missingInTarget ? 'missing' : 'present'}`}>
                      <span className="dim-delta-icon">{d.missingInTarget ? '✗' : '✓'}</span>
                      <span className="dim-delta-name">{d.name}</span>
                    </div>
                  ))}
                </div>
              )}
              {dimDelta.some((d: DimRow) => d.missingInTarget) && (
                <p className="dim-delta-note">
                  <strong>{dimDelta.filter((d: DimRow) => d.missingInTarget).length}</strong> dimension{dimDelta.filter((d: DimRow) => d.missingInTarget).length !== 1 ? 's' : ''} missing from the reference report — add as grouping attributes to support full analytical parity.
                </p>
              )}
            </section>
          </>
        )}
      </div>

      <RationalizationTrail events={events} />
    </main>
  );
}

// ---- Combined Target tab (Lineage + Metadata) ----

function TargetView({
  targets,
  selectedId,
  setSelectedId,
  sourceCount,
  phase,
  timings,
}: {
  targets: TargetDetailReport[];
  selectedId: string | null;
  setSelectedId: (id: string) => void;
  sourceCount: number;
  phase: WorkbenchPhase;
  timings: PhaseTimings;
}) {
  const [subTab, setSubTab] = useState<'lineage' | 'metadata'>('lineage');

  const realSelected = targets.find(r => r.id === selectedId) ?? targets[0] ?? null;
  const selected     = realSelected ?? placeholderTarget();
  const queries      = selected.queries.map(q => ({ ...q, preview: q.fullSql.slice(0, 80) }));
  const events       = buildTargetTrail(selected, sourceCount, phase, timings);
  const kpis         = selected.kpis;
  const tables       = selected.allTables;
  const dimensions   = selected.allDimensions ?? [];

  return (
    <main className="workspace three-column">
      <HelpChatBox tab="target" ctx={{ thresholds: DEFAULT_THRESHOLDS, sourceCount: sourceCount, targetCount: targets.length, decisionCount: 0 }} />
      <Sidebar title="Target reports" items={targets} selectedId={selected.id} onSelect={setSelectedId} />

      <div className="record-workspace">
        {/* Sub-tab switcher */}
        <div className="subtab-bar">
          <button
            className={classNames('subtab-btn', subTab === 'lineage' && 'active')}
            onClick={() => setSubTab('lineage')}
          >
            <Network size={13} /> Lineage
          </button>
          <button
            className={classNames('subtab-btn', subTab === 'metadata' && 'active')}
            onClick={() => setSubTab('metadata')}
          >
            <Database size={13} /> Metadata
          </button>
        </div>

        <RecordHeader report={selected} type="Target" parsedAt={timings.loadCompletedAt} />

        {subTab === 'lineage' && (
          <>
            <TableDependencies queries={queries} />
            <SqlExplorer queries={queries} />
          </>
        )}

        {subTab === 'metadata' && (
          <>
            <div className="metadata-grid">
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <p className="panel-kicker">Business context</p>
                    <h2>Reference report context</h2>
                  </div>
                </div>
                <p className="business-copy">{selected.description}</p>
                <div className="context-metrics">
                  <span><strong>Reference</strong> estate</span>
                  <span><strong>{kpis.length}</strong> reference KPIs</span>
                  <span><strong>{tables.length}</strong> governed tables</span>
                </div>
              </section>
              <section className="panel">
                <div className="panel-heading">
                  <div><p className="panel-kicker">Schema</p><h2>Tables and semantic layer</h2></div>
                </div>
                <div className="schema-cloud">
                  {tables.length === 0
                    ? <span className="placeholder-chip">—</span>
                    : tables.map(t => <span key={t}>{t}</span>)}
                </div>
              </section>
            </div>
            <section className="panel">
              <div className="panel-heading">
                <div><p className="panel-kicker">Measures</p><h2>Reference KPIs and formulas</h2></div>
                <span className="panel-badge">{kpis.length} KPIs</span>
              </div>
              <div className="table-scroll">
                <table className="data-table">
                  <thead><tr><th>KPI</th><th>Aggregation</th><th>Column</th><th>Formula</th><th>Query</th></tr></thead>
                  <tbody>
                    {kpis.length === 0
                      ? <tr className="placeholder-row"><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>
                      : kpis.map(kpi => (
                          <tr key={`${kpi.alias}-${kpi.queryFile}`}>
                            <td className="font-bold">{kpi.alias}</td>
                            <td>{kpi.agg}</td>
                            <td className="font-mono">{kpi.column}</td>
                            <td className="font-mono">{kpi.formula}</td>
                            <td>{kpi.queryFile}</td>
                          </tr>
                        ))}
                  </tbody>
                </table>
              </div>
            </section>
            {/* Dimension fields */}
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <p className="panel-kicker">Dimensions</p>
                  <h2>Reference dimension fields</h2>
                </div>
                <span className="panel-badge">{dimensions.length} fields</span>
              </div>
              {dimensions.length === 0 ? (
                <p className="panel-empty-note">No GROUP BY dimensions extracted — SQL queries may use inline expressions or this report uses a non-SQL format.</p>
              ) : (
                <div className="dim-delta-grid">
                  {dimensions.map(d => (
                    <div key={d} className="dim-delta-chip present">
                      <span className="dim-delta-icon">✓</span>
                      <span className="dim-delta-name">{d}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>

      <RationalizationTrail events={events} />
    </main>
  );
}

// ---- Loading progress panel ----

const LOADING_STAGES = [
  { label: 'Scanning source report folders',        durationMs: 2500  },
  { label: 'Parsing SQL queries & KPI expressions', durationMs: 5000  },
  { label: 'Reading reference catalog',             durationMs: 2500  },
  { label: 'Building KPI alias index',              durationMs: 4000  },
  { label: 'Running N×M overlap matrix',            durationMs: 6000  },
  { label: 'Scoring alias, column & table overlap', durationMs: 5000  },
  { label: 'Applying decision band thresholds',     durationMs: 2500  },
  { label: 'Assembling inventory payload',          durationMs: 2500  },
];

function LoadingProgressPanel() {
  const [stageIdx, setStageIdx] = useState(0);
  const [elapsed, setElapsed]   = useState(0);

  useEffect(() => {
    const start = Date.now();
    const tick = setInterval(() => setElapsed(Date.now() - start), 120);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    if (stageIdx >= LOADING_STAGES.length - 1) return;
    const t = setTimeout(() => setStageIdx(i => i + 1), LOADING_STAGES[stageIdx].durationMs);
    return () => clearTimeout(t);
  }, [stageIdx]);

  const totalDuration = LOADING_STAGES.reduce((s, st) => s + st.durationMs, 0);
  const doneMs = LOADING_STAGES.slice(0, stageIdx).reduce((s, st) => s + st.durationMs, 0);
  const pct = Math.min(99, Math.round((doneMs / totalDuration) * 100));

  return (
    <div style={{
      margin: '24px auto', maxWidth: 620, background: 'var(--surface)',
      border: '1px solid var(--border)', borderRadius: 6, padding: '24px 28px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
        <Loader2 size={16} className="animate-spin" style={{ color: 'var(--aws-blue)' }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
          Analysing report inventory…
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
          {(elapsed / 1000).toFixed(1)}s
        </span>
      </div>

      {/* Progress bar */}
      <div style={{ height: 4, background: 'var(--bg)', borderRadius: 2, marginBottom: 20, overflow: 'hidden' }}>
        <div style={{
          height: '100%', width: `${pct}%`, background: 'var(--aws-blue)',
          borderRadius: 2, transition: 'width 0.4s ease',
        }} />
      </div>

      {/* Stage list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {LOADING_STAGES.map((st, i) => {
          const done    = i < stageIdx;
          const active  = i === stageIdx;
          const pending = i > stageIdx;
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {done    && <CheckCircle2 size={13} style={{ color: '#037f0c', flexShrink: 0 }} />}
              {active  && <Loader2 size={13} className="animate-spin" style={{ color: 'var(--aws-blue)', flexShrink: 0 }} />}
              {pending && <div style={{ width: 13, height: 13, borderRadius: '50%', border: '1.5px solid var(--border)', flexShrink: 0 }} />}
              <span style={{
                fontSize: 12,
                color: done ? 'var(--text-secondary)' : active ? 'var(--text-primary)' : 'var(--text-muted,#8d99a6)',
                fontWeight: active ? 500 : 400,
              }}>
                {st.label}
              </span>
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 20, fontSize: 11, color: 'var(--text-secondary)' }}>
        {pct}% complete — cross-referencing KPI aliases, column names, and table lineage
      </div>
    </div>
  );
}

// ---- Threshold panel ----
// Lets analysts define their own % cut-offs for Rationalize / Consolidate / Migrate.
// Changing a threshold instantly recomputes all non-manual decisions via an App-level effect.

function ThresholdPanel({
  thresholds,
  onChange,
}: {
  thresholds: ThresholdConfig;
  onChange: (t: ThresholdConfig) => void;
}) {
  const isDefault =
    thresholds.rationalizeAt === DEFAULT_THRESHOLDS.rationalizeAt &&
    thresholds.consolidateAt  === DEFAULT_THRESHOLDS.consolidateAt;

  const setRat = (v: number) => {
    const rat = Math.min(100, Math.max(thresholds.consolidateAt + 1, v));
    onChange({ ...thresholds, rationalizeAt: rat });
  };

  const setCon = (v: number) => {
    const con = Math.min(thresholds.rationalizeAt - 1, Math.max(1, v));
    onChange({ ...thresholds, consolidateAt: con });
  };

  const migrateWidth    = thresholds.consolidateAt;
  const consolidateWidth = thresholds.rationalizeAt - thresholds.consolidateAt;
  const rationalizeWidth = 100 - thresholds.rationalizeAt + 1;

  return (
    <div className="threshold-panel">
      <div className="threshold-header">
        <Sliders size={14} />
        <span>Disposition thresholds</span>
        {!isDefault && (
          <button className="threshold-reset-btn" onClick={() => onChange(DEFAULT_THRESHOLDS)}>
            Reset to defaults
          </button>
        )}
      </div>
      <div className="threshold-controls">
        <label className="threshold-label">
          <span>Rationalize at ≥</span>
          <div className="threshold-input-row">
            <input
              type="range" min={thresholds.consolidateAt + 1} max={100} step={1}
              value={thresholds.rationalizeAt}
              onChange={e => setRat(Number(e.target.value))}
            />
            <input
              type="number" min={thresholds.consolidateAt + 1} max={100}
              value={thresholds.rationalizeAt}
              onChange={e => setRat(Number(e.target.value))}
              className="threshold-num-input"
            />
            <span>%</span>
          </div>
        </label>
        <label className="threshold-label">
          <span>Consolidate at ≥</span>
          <div className="threshold-input-row">
            <input
              type="range" min={1} max={thresholds.rationalizeAt - 1} step={1}
              value={thresholds.consolidateAt}
              onChange={e => setCon(Number(e.target.value))}
            />
            <input
              type="number" min={1} max={thresholds.rationalizeAt - 1}
              value={thresholds.consolidateAt}
              onChange={e => setCon(Number(e.target.value))}
              className="threshold-num-input"
            />
            <span>%</span>
          </div>
        </label>
      </div>
      <div className="threshold-scale">
        <div className="threshold-band migrate">
          Migrate &lt;{thresholds.consolidateAt}%
        </div>
        <div className="threshold-band consolidate">
          Consolidate {thresholds.consolidateAt}–{thresholds.rationalizeAt - 1}%
        </div>
        <div className="threshold-band rationalize">
          Rationalize ≥{thresholds.rationalizeAt}%
        </div>
      </div>
    </div>
  );
}

// ---- Help chat box ----
// Contextual, data-aware FAQ panel surfaced on every tab via a floating toggle button.

interface HelpItem {
  q: string;
  a: string;
}

function buildHelpItems(tab: TabKey, ctx: {
  thresholds: ThresholdConfig;
  sourceCount: number;
  targetCount: number;
  decisionCount: number;
}): HelpItem[] {
  const { thresholds, sourceCount, targetCount, decisionCount } = ctx;
  if (tab === 'dashboard') return [
    {
      q: 'What do the disposition thresholds control?',
      a: `The three bands are defined by two cut-offs. Any source with KPI overlap ≥ ${thresholds.rationalizeAt}% is recommended for Rationalize (retire). Overlap between ${thresholds.consolidateAt}% and ${thresholds.rationalizeAt - 1}% maps to Consolidate (extend the reference). Below ${thresholds.consolidateAt}% maps to Migrate (rebuild). Changing a slider instantly reclassifies all non-manual decisions.`,
    },
    {
      q: 'What is KPI overlap % and how is it calculated?',
      a: 'Overlap is a weighted score: KPI alias match (50%) + column name match (30%) + normalised table name match (20%). A source KPI alias is matched if the same name appears in the reference report\'s KPI list. Table names are normalised by stripping vendor prefixes (fact_, dim_, tgt_, vz_, etc.) before comparison.',
    },
    {
      q: 'What does Remap do on the Dashboard?',
      a: 'Remap lets you point any source report at a different reference report or domain and immediately see the recomputed overlap %, disposition band, confidence score, and KPI gaps — before confirming. Use it when the automatic best-match looks wrong or when the business domain should be reassigned.',
    },
    {
      q: 'How does the multi-select domain filter work?',
      a: 'Click one or more domain chips to narrow all stat cards, disposition bars, overlap buckets, and confidence tiers. Clicking an already-active chip deselects it. When no domain is selected, "All" is shown and all domains are included.',
    },
    {
      q: `Why do I see ${decisionCount} decisions for ${sourceCount} sources?`,
      a: sourceCount === decisionCount
        ? `Every source report has a disposition — one per source. ${targetCount} reference reports were evaluated as candidates.`
        : `Decisions populate after loading reports. ${decisionCount} of ${sourceCount} source reports have been matched so far.`,
    },
  ];

  if (tab === 'source') return [
    {
      q: 'What is the Coverage Matrix?',
      a: 'The Coverage Matrix compares the selected source report\'s KPIs one-by-one against the best-matched reference report. Green ✓ means the alias or column is present in the reference; red ✗ means it is a gap that would need to be added before the source can be retired.',
    },
    {
      q: 'How are KPIs extracted from SQL?',
      a: 'The parser scans every SQL file in the report folder for the pattern AGG(table.column) AS alias, where AGG is one of SUM, COUNT, AVG, MIN, or MAX. Each match produces one KPI row: alias, aggregation, column, and formula. Dimension columns (non-aggregated) appear in the table dependencies panel but do not affect the overlap score.',
    },
    {
      q: 'What do the alias/column match weights mean?',
      a: 'Alias match carries 50% of the total score because the KPI name is the strongest semantic signal — two reports are likely equivalent if they compute the same named measure. Column match (30%) validates the underlying data field. Table match (20%) confirms the same dimensional structure, after stripping vendor-specific prefixes.',
    },
    {
      q: 'What does the Rationalization Trail show?',
      a: 'The trail on the right logs each step of the analysis pipeline — from SQL ingestion and KPI extraction through to threshold evaluation and the final recommendation. Each event carries a phase badge, a status indicator (done / active / queued), and a timestamp where available.',
    },
  ];

  if (tab === 'target') return [
    {
      q: 'What is a reference report?',
      a: 'Reference reports form the governed target catalog — the destination that source reports should be rationalised into. Each reference report defines the canonical KPI set for its domain. A source report\'s disposition (Rationalize / Consolidate / Migrate) is determined by how much of its KPI set is already covered by the best-matching reference.',
    },
    {
      q: 'Why are some table names normalised?',
      a: 'Source schemas often use vendor-specific prefixes (fact_, dim_, ref_) while reference schemas use platform-specific ones (tgt_, vz_, mkt_). The normaliser strips these prefixes before matching so that fact_sales and tgt_sales are treated as equivalent, avoiding false negatives caused by naming conventions rather than semantic differences.',
    },
    {
      q: 'How many source reports can match one reference?',
      a: `Multiple source reports can point to the same reference. The current reference catalog has ${targetCount} report(s); ${sourceCount} source report(s) have been evaluated against them. The Disposition tab shows the full many-to-one mapping.`,
    },
  ];

  // disposition tab
  return [
    {
      q: 'What do Approve, Override, and Remap do?',
      a: 'Approve marks the AI-generated disposition as analyst-confirmed. Override lets you manually set a different decision, target, overlap %, and rationale — this is recorded as a manual governance action. Remap reassigns the source to a different domain and/or reference and instantly recomputes overlap, decision, KPI gaps, and confidence using the same formula as the server.',
    },
    {
      q: 'What does "Pending" status mean?',
      a: 'Pending means the disposition has been generated but not yet reviewed by an analyst. Approved means an analyst confirmed it as-is. Overridden means an analyst manually set a different decision. You can filter by status to find all pending items that still need governance sign-off.',
    },
    {
      q: 'How is confidence computed?',
      a: 'Confidence is a heuristic: 0.40 + (overlap / 100) × 0.55. A 100% overlap produces ~0.95 (95%); 0% overlap produces 0.40 (40%). When rationale enrichment is enabled, the enrichment model may adjust this score based on the semantic quality of the KPI evidence.',
    },
    {
      q: 'What are KPI gaps and why do they matter?',
      a: 'KPI gaps are KPI aliases present in the source report but absent from the matched reference. A Consolidate disposition requires the reference to be extended to cover these gaps before the source can be retired. For a Migrate disposition, the full source capability must be rebuilt on the governed platform.',
    },
    {
      q: 'Can I export the disposition matrix?',
      a: 'Yes — click the "Export CSV" button in the panel header to download all dispositions, overlap scores, confidence ratings, KPI gap counts, statuses, and rationale as a CSV file.',
    },
  ];
}

function HelpChatBox({ tab, ctx }: {
  tab: TabKey;
  ctx: Parameters<typeof buildHelpItems>[1];
}) {
  const [open, setOpen]               = useState(false);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const items = buildHelpItems(tab, ctx);

  return (
    <div className="help-chat-root">
      <button
        className={classNames('help-toggle-btn', open && 'active')}
        onClick={() => setOpen(v => !v)}
        title={open ? 'Close help' : 'Open contextual help'}
      >
        <HelpCircle size={18} />
      </button>
      {open && (
        <div className="help-chat-panel">
          <div className="help-chat-header">
            <MessageSquare size={13} />
            <span>Workbench help</span>
            <span className="help-chat-tab-badge">{tab}</span>
            <button onClick={() => setOpen(false)} aria-label="Close help"><X size={14} /></button>
          </div>
          <div className="help-chat-items">
            {items.map((item, i) => (
              <div key={i} className={classNames('help-item', expandedIdx === i && 'expanded')}>
                <button
                  className="help-item-q"
                  onClick={() => setExpandedIdx(expandedIdx === i ? null : i)}
                >
                  <span>{item.q}</span>
                  <ChevronRight size={12} className="help-chevron" />
                </button>
                {expandedIdx === i && (
                  <p className="help-item-a">{item.a}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Root ----

export default function App() {
  const [phase, setPhase]                         = useState<WorkbenchPhase>('intake');
  const [activeTab, setActiveTab]                 = useState<TabKey>('dashboard');
  const [inventory, setInventory]                 = useState<ReportInventory | null>(null);
  const [loadError, setLoadError]                 = useState<string | null>(null);
  const [decisions, setDecisions]                 = useState<RationalizationDecision[]>([]);
  const [analysisNote, setAnalysisNote]           = useState<string | null>(null);
  const [analysisModel, setAnalysisModel]         = useState<string | null>(null);
  const [analysisDurationMs, setAnalysisDurationMs] = useState<number | null>(null);
  const [phaseTimings, setPhaseTimings]           = useState<PhaseTimings>({});
  const [selectedSourceId, setSelectedSourceId]   = useState<string | null>(null);
  const [selectedTargetId, setSelectedTargetId]   = useState<string | null>(null);
  const [overrideSourceId, setOverrideSourceId]   = useState<string | null>(null);
  const [remapSourceId,    setRemapSourceId]       = useState<string | null>(null);
  const [thresholds, setThresholds]               = useState<ThresholdConfig>(DEFAULT_THRESHOLDS);
  const [metadataMappings, setMetadataMappings]   = useState<MetadataMapping[]>([]);
  const [baseDecisions, setBaseDecisions]         = useState<RationalizationDecision[]>([]);

  // Refs so the mapping auto-recompute effect captures current values without re-triggering.
  const inventoryRef     = useRef(inventory);
  const thresholdsRef    = useRef(thresholds);
  const baseDecisionsRef = useRef(baseDecisions);
  inventoryRef.current     = inventory;
  thresholdsRef.current    = thresholds;
  baseDecisionsRef.current = baseDecisions;

  // When thresholds change, recompute the decision band for all non-manual decisions.
  // Overlap %, target mapping, rationale, and confidence are NOT changed — only the band label.
  useEffect(() => {
    if (!inventory) return;
    setDecisions(prev => prev.map(d => {
      if (d.source === 'manual') return d;
      return { ...d, decision: decisionFromOverlap(d.overlapPercent, thresholds) };
    }));
  }, [thresholds, inventory]);

  // Auto-recompute all analysis decisions when metadata mappings change (400 ms debounce).
  // Manual overrides (source === 'manual') are always preserved.
  useEffect(() => {
    const handle = setTimeout(() => {
      const inv = inventoryRef.current;
      if (!inv) return;
      if (metadataMappings.length === 0) {
        const base = baseDecisionsRef.current;
        if (base.length > 0) setDecisions(base);
        return;
      }
      setDecisions(prev =>
        recomputeDecisionsFromMappings(inv.sources, inv.targets, metadataMappings, thresholdsRef.current, prev)
      );
    }, 400);
    return () => clearTimeout(handle);
  }, [metadataMappings]);

  // Count decisions that changed classification relative to the server-enriched baseline.
  const mappingChangedCount = useMemo(() =>
    baseDecisions.length === 0 ? 0 :
    decisions.filter(d => {
      const b = baseDecisions.find(b => b.sourceId === d.sourceId);
      return b && b.decision !== d.decision;
    }).length,
  [decisions, baseDecisions]);

  const handleIntakeApply = useCallback(async (payload: IntakePayload) => {
    setPhase('loading');
    setLoadError(null);
    setDecisions([]);
    setAnalysisNote(null);
    setAnalysisModel(null);
    setAnalysisDurationMs(null);
    setPhaseTimings({ loadStartedAt: Date.now() });
    try {
      const data = await loadReportInventoryFromPaths(payload.sourcePath, payload.targetPath);
      const loadDoneAt = Date.now();
      setInventory(data);
      setSelectedSourceId(data.sources[0]?.id ?? null);
      setSelectedTargetId(data.targets[0]?.id ?? null);
      setActiveTab('dashboard');

      // Decisions are visible IMMEDIATELY from the deterministic overlap matrix.
      // Enrichment only improves rationale/gaps/confidence below - numbers stay locked.
      const initialDecisions = deterministicDecisions(data, thresholds);
      setDecisions(initialDecisions);

      setPhaseTimings(prev => ({
        ...prev,
        loadCompletedAt:   loadDoneAt,
        analysisStartedAt: loadDoneAt,
      }));
      setPhase('analysing');

      const analysisStartedAt = Date.now();
      const response = await requestRationalizationAnalysis(data.sources, data.targets);
      const analysisFinishedAt = Date.now();
      setAnalysisDurationMs(analysisFinishedAt - analysisStartedAt);
      setAnalysisModel(response.model ?? null);

      if (response.status === 'ok') {
        // Merge rationale enrichment into deterministic decisions.
        // CRITICAL: do not overwrite overlapPercent or decision — those are mathematical.
        setDecisions(prev => prev.map(d => {
          const enriched = response.decisions.find(x => x.sourceId === d.sourceId);
          if (!enriched) return d;
          return {
            ...d,
            rationale:       enriched.rationale && enriched.rationale.length > 20 ? enriched.rationale : d.rationale,
            kpiGaps:         enriched.kpiGaps?.length ? enriched.kpiGaps : d.kpiGaps,
            confidenceScore: typeof enriched.confidenceScore === 'number' ? enriched.confidenceScore : d.confidenceScore,
          };
        }));
      } else {
        setAnalysisNote(
          'Rationale enrichment is not available — dispositions reflect KPI overlap scoring only. All decisions and overlap percentages are still computed deterministically from your SQL.',
        );
      }
      setPhaseTimings(prev => ({ ...prev, analysisCompletedAt: analysisFinishedAt }));
      setPhase('ready');
      // Capture the enriched decisions as the baseline for mapping-change comparison.
      setDecisions(final => { setBaseDecisions(final); return final; });
      setMetadataMappings([]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load reports.';
      setLoadError(msg);
      setPhase('intake');
      setPhaseTimings({});
      setDecisions([]);
      setBaseDecisions([]);
    }
  }, []);

  const approveDecision = (sourceId: string) => {
    setDecisions(prev => prev.map(d => d.sourceId === sourceId ? { ...d, status: 'Approved' } : d));
  };

  const saveOverride = (decision: RationalizationDecision) => {
    setDecisions(prev => {
      const next = prev.filter(d => d.sourceId !== decision.sourceId);
      return [...next, decision].sort((a, b) => a.sourceName.localeCompare(b.sourceName));
    });
    setOverrideSourceId(null);
  };

  const applyRemap = (decision: RationalizationDecision) => {
    setDecisions(prev => {
      const next = prev.filter(d => d.sourceId !== decision.sourceId);
      return [...next, decision].sort((a, b) => a.sourceName.localeCompare(b.sourceName));
    });
    setRemapSourceId(null);
  };

  // Full UI always renders — inventory may be null before data is loaded
  const sources     = inventory?.sources     ?? [];
  const targets     = inventory?.targets     ?? [];
  const targetIndex = inventory?.targetIndex ?? [];
  const selectedSource = sources.find(r => r.id === selectedSourceId) ?? sources[0] ?? null;
  const selectedTarget = targets.find(r => r.id === selectedTargetId) ?? targets[0] ?? null;
  const overrideSource = overrideSourceId
    ? sources.find(r => r.id === overrideSourceId) ?? null
    : null;
  const remapSource = remapSourceId
    ? sources.find(r => r.id === remapSourceId) ?? null
    : null;

  return (
    <div className="enterprise-app">
      <AppHeader activeTab={activeTab} setActiveTab={setActiveTab} />

      {activeTab === 'dashboard' && (
        <DashboardView
          inventory={inventory}
          decisions={decisions}
          thresholds={thresholds}
          onReload={handleIntakeApply}
          onThresholdChange={setThresholds}
          onRemap={setRemapSourceId}
          isLoading={phase === 'loading'}
          loadError={loadError}
          metadataMappings={metadataMappings}
          onMappingsChange={setMetadataMappings}
          mappingChangedCount={mappingChangedCount}
        />
      )}
      {activeTab === 'source' && (
        <SourceView
          sources={sources}
          targets={targets}
          selectedId={selectedSource?.id ?? null}
          setSelectedId={setSelectedSourceId}
          decisions={decisions}
          phase={phase}
          timings={phaseTimings}
        />
      )}
      {activeTab === 'target' && (
        <TargetView
          targets={targets}
          selectedId={selectedTarget?.id ?? null}
          setSelectedId={setSelectedTargetId}
          sourceCount={sources.length}
          phase={phase}
          timings={phaseTimings}
        />
      )}
      {activeTab === 'decision' && (
        <DecisionView
          sources={sources}
          targets={targetIndex}
          allTargets={targets}
          decisions={decisions}
          phase={phase}
          analysisNote={analysisNote}
          timings={phaseTimings}
          inventory={inventory}
          liveStats={{ model: analysisModel, durationMs: analysisDurationMs }}
          onApprove={approveDecision}
          onOverride={setOverrideSourceId}
          onRemap={setRemapSourceId}
        />
      )}

      {overrideSource && (
        <OverrideModal
          source={overrideSource}
          targets={targetIndex}
          existing={getSourceDecision(overrideSource, decisions)}
          onClose={() => setOverrideSourceId(null)}
          onSave={saveOverride}
        />
      )}

      {remapSource && (
        <RemapModal
          source={remapSource}
          allTargets={targets}
          allDomains={[...new Set(sources.map(r => r.domain))].sort()}
          existing={getSourceDecision(remapSource, decisions)}
          thresholds={thresholds}
          onClose={() => setRemapSourceId(null)}
          onApply={applyRemap}
        />
      )}
    </div>
  );
}
