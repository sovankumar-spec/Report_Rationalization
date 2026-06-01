/**
 * parser.ts — SQL and folder parsing primitives.
 * Pure functions: no side-effects, no logging, easily testable.
 */

import { readdir, readFile, stat } from 'fs/promises';
import { join, extname, basename, resolve, normalize } from 'path';
import { parseExcelFile, parseCsvFile, parsePbixFile, parseTwbxFile, parseQvfFile } from './formatAdapters.js';

// ── domain types ─────────────────────────────────────────────────────────────

export interface ExtractedKpi {
  alias: string;
  agg: string;
  column: string;
  formula: string;
  queryFile: string;
}

export interface ParsedQuery {
  filename: string;
  kpiName: string;
  sql: string;
  kpis: ExtractedKpi[];
  tables: string[];
  filters: string[];
  groupBy: string[];
  joins: string[];
}

export interface ReportMeta {
  id: string;
  name: string;
  domain: string;
  owner?: string;
  usageFrequency?: number;
  description?: string;
}

export interface ParsedReport {
  meta: ReportMeta;
  queries: ParsedQuery[];
  allKpis: ExtractedKpi[];
  allTables: string[];
  allDimensions: string[];
}

// ── path safety ───────────────────────────────────────────────────────────────

export async function validateReportDirectory(inputPath: string): Promise<string> {
  if (!inputPath || typeof inputPath !== 'string') {
    throw new Error('Path must be a non-empty string.');
  }
  if (inputPath.includes('\0')) {
    throw new Error('Path contains invalid characters.');
  }
  const resolved = resolve(normalize(inputPath));
  let stats;
  try {
    stats = await stat(resolved);
  } catch {
    throw new Error(`Path does not exist: ${resolved}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Path is not a directory: ${resolved}`);
  }
  return resolved;
}

// ── SQL extraction ────────────────────────────────────────────────────────────

export function extractKpis(sql: string, queryFile: string): ExtractedKpi[] {
  const kpis: ExtractedKpi[] = [];
  const pattern = /\b(SUM|COUNT|AVG|MIN|MAX)\s*\(\s*(DISTINCT\s+)?(?:[\w]+\.)?(\w+)\s*\)\s+AS\s+(\w+)/gi;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(sql)) !== null) {
    const [, aggFunc, distinct, col, alias] = m;
    kpis.push({
      alias: alias.toLowerCase(),
      agg: aggFunc.toUpperCase() + (distinct ? '(DISTINCT' : ''),
      column: col.toLowerCase(),
      formula: `${aggFunc}(${distinct ?? ''}${col}) AS ${alias}`,
      queryFile,
    });
  }
  return kpis;
}

export function extractTables(sql: string): string[] {
  const tables = new Set<string>();
  const reserved = new Set(['select', 'where', 'group', 'order', 'having', 'with']);
  const fromPat = /\bFROM\s+([\w]+)/gi;
  const joinPat = /\bJOIN\s+([\w]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = fromPat.exec(sql)) !== null) {
    const t = m[1].toLowerCase();
    if (!reserved.has(t)) tables.add(t);
  }
  while ((m = joinPat.exec(sql)) !== null) tables.add(m[1].toLowerCase());
  return [...tables];
}

export function extractFilters(sql: string): string[] {
  const m = /WHERE\s+([\s\S]+?)(?:GROUP\s+BY|ORDER\s+BY|HAVING|$)/i.exec(sql);
  if (!m) return [];
  return m[1].trim().split(/\s+AND\s+/i).map(s => s.trim()).filter(Boolean).slice(0, 5);
}

export function extractGroupBy(sql: string): string[] {
  const m = /GROUP\s+BY\s+([\s\S]+?)(?:ORDER\s+BY|HAVING|$)/i.exec(sql);
  if (!m) return [];
  return m[1].trim().split(',').map(s => s.trim()).filter(Boolean).slice(0, 6);
}

export function extractJoins(sql: string): string[] {
  const joins: string[] = [];
  const pat = /(?:LEFT|RIGHT|INNER|FULL|CROSS)?\s*JOIN\s+\w+/gi;
  let m: RegExpExecArray | null;
  while ((m = pat.exec(sql)) !== null) joins.push(m[0].replace(/\s+/g, ' ').trim());
  return joins;
}

export function normaliseTable(t: string): string {
  return t.replace(/^(fact_|dim_|tgt_|ref_|mkt_|vz_|ops_|hr_|fin_|lgl_|cs_|it_|scm_|vc_|rc_)/, '');
}

export function kpiNameFromFile(filename: string): string {
  return basename(filename, '.sql')
    .replace(/^q\d+_/i, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

// ── folder reader ─────────────────────────────────────────────────────────────

export async function readReportFolder(folderPath: string): Promise<ParsedReport | null> {
  let meta: ReportMeta;
  try {
    const raw = await readFile(join(folderPath, 'report.json'), 'utf-8');
    meta = JSON.parse(raw) as ReportMeta;
    if (!meta.id || !meta.name || !meta.domain) {
      throw new Error('report.json missing required fields: id, name, domain');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read report.json in ${folderPath}: ${msg}`);
  }

  const entries = await readdir(folderPath);

  const sqlFiles  = entries.filter(f => extname(f).toLowerCase() === '.sql').sort();
  const xlsxFiles = entries.filter(f => ['.xlsx', '.xls'].includes(extname(f).toLowerCase()));
  const csvFiles  = entries.filter(f => extname(f).toLowerCase() === '.csv');
  const pbixFiles = entries.filter(f => extname(f).toLowerCase() === '.pbix');
  const twbxFiles = entries.filter(f => ['.twbx', '.twb'].includes(extname(f).toLowerCase()));
  const qvfFiles  = entries.filter(f => extname(f).toLowerCase() === '.qvf');

  const queries: ParsedQuery[] = [];

  // SQL (original format)
  for (const sqlFile of sqlFiles) {
    const sql = await readFile(join(folderPath, sqlFile), 'utf-8');
    queries.push({
      filename: sqlFile,
      kpiName: kpiNameFromFile(sqlFile),
      sql,
      kpis: extractKpis(sql, sqlFile),
      tables: extractTables(sql),
      filters: extractFilters(sql),
      groupBy: extractGroupBy(sql),
      joins: extractJoins(sql),
    });
  }

  // Excel
  for (const f of xlsxFiles) {
    const qs = await parseExcelFile(join(folderPath, f)).catch(() => [] as ParsedQuery[]);
    queries.push(...qs);
  }

  // CSV
  for (const f of csvFiles) {
    const q = await parseCsvFile(join(folderPath, f)).catch(() => null);
    if (q) queries.push(q);
  }

  // Power BI
  for (const f of pbixFiles) {
    queries.push(...parsePbixFile(join(folderPath, f)));
  }

  // Tableau
  for (const f of twbxFiles) {
    const qs = await parseTwbxFile(join(folderPath, f)).catch(() => [] as ParsedQuery[]);
    queries.push(...qs);
  }

  // Qlik Sense
  for (const f of qvfFiles) {
    queries.push(...parseQvfFile(join(folderPath, f)));
  }

  const allKpis = queries.flatMap(q => q.kpis);
  const allTables = [...new Set(queries.flatMap(q => q.tables))];
  const allDimensions = [...new Set(
    queries.flatMap(q => q.groupBy.map(g => g.toLowerCase().replace(/^[\w]+\./g, '').trim())).filter(Boolean),
  )];

  return { meta, queries, allKpis, allTables, allDimensions };
}

export async function readAllReports(dirPath: string): Promise<ParsedReport[]> {
  const folders = (await readdir(dirPath)).sort();
  const results: ParsedReport[] = [];
  for (const folder of folders) {
    const full = join(dirPath, folder);
    const s = await stat(full).catch(() => null);
    if (!s?.isDirectory()) continue;
    const report = await readReportFolder(full);
    if (report) results.push(report);
  }
  return results;
}
