import type { AnalysisResult } from '../lib/graphComputeClient';

function escapeCsvCell(value: any): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Convert AnalysisResult to a "reasonable default" CSV:
 * - Prefer declared dimensions + metrics when semantics exist.
 * - Always include common context fields if present (scenario_name, probability_label, visibility_mode).
 */
export function analysisResultToCsv(result: AnalysisResult): { filename: string; csv: string } {
  const dims = result.semantics?.dimensions || [];
  const metrics = result.semantics?.metrics || [];

  const baseColumns: string[] = [];
  for (const d of dims) {
    baseColumns.push(d.id);
    // Add label column when we have dimension_values metadata.
    if (result.dimension_values?.[d.id]) baseColumns.push(`${d.id}_label`);
  }

  const metricColumns = metrics.map(m => m.id);

  const commonContextCols = ['scenario_name', 'probability_label', 'visibility_mode'];
  const columns = [...baseColumns, ...commonContextCols, ...metricColumns].filter((v, i, a) => a.indexOf(v) === i);

  const rows = result.data || [];
  const lines: string[] = [];
  lines.push(columns.join(','));

  for (const row of rows) {
    const out: Record<string, any> = {};

    for (const d of dims) {
      const v = (row as any)[d.id];
      out[d.id] = v;
      if (result.dimension_values?.[d.id]) {
        out[`${d.id}_label`] = (result.dimension_values as any)?.[d.id]?.[String(v)]?.name ?? '';
      }
    }

    for (const k of commonContextCols) {
      out[k] = (row as any)[k] ?? '';
    }

    for (const m of metrics) {
      out[m.id] = (row as any)[m.id];
    }

    lines.push(columns.map(c => escapeCsvCell(out[c])).join(','));
  }

  const safeName = (result.analysis_name || result.analysis_type || 'analysis')
    .replace(/[^\w\s-]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase();

  return { filename: `${safeName}.csv`, csv: lines.join('\n') + '\n' };
}


