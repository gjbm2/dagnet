import type { AnalysisResult } from '../lib/graphComputeClient';

function escapeCsvCell(value: any): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function formatDate_d_MMM_yy(dateStr: string): string {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  const day = d.getDate();
  const month = d.toLocaleDateString('en-GB', { month: 'short' });
  const yy = d.toLocaleDateString('en-GB', { year: '2-digit' });
  return `${day}-${month}-${yy}`;
}

/**
 * Convert AnalysisResult to a "reasonable default" CSV:
 * - Prefer declared dimensions + metrics when semantics exist.
 * - Always include common context fields if present (scenario_name, probability_label, visibility_mode).
 */
export function analysisResultToCsv(result: AnalysisResult): { filename: string; csv: string } {
  // Cohort maturity export: prefer the fully-detailed per-cohort table when available.
  // This is intended for debugging + custom chart design (one row per as_at_date × anchor_day).
  const exportTables: any = (result?.metadata as any)?.export_tables;
  const detailedPoints: any[] | undefined = Array.isArray(exportTables?.cohort_maturity_points)
    ? exportTables.cohort_maturity_points
    : undefined;
  if (result.analysis_type === 'cohort_maturity' && detailedPoints && detailedPoints.length > 0) {
    const scenarioMeta: any = (result.dimension_values as any)?.scenario_id || {};
    const subjectMeta: any = (result.dimension_values as any)?.subject_id || {};

    const columns = [
      'scenario_id',
      'scenario_name',
      'subject_id',
      'subject_label',
      'window_from_iso',
      'window_from_uk',
      'window_to_iso',
      'window_to_uk',
      'as_at_date_iso',
      'as_at_date_uk',
      'anchor_day_iso',
      'anchor_day_uk',
      'cohort_age_days',
      'cohort_age_at_window_end_days',
      'x',
      'y',
      'a',
      'rate',
      'median_lag_days',
      'mean_lag_days',
      'onset_delta_days',
      'epoch_subject_id',
      'epoch_sweep_from',
      'epoch_sweep_to',
      'epoch_slice_keys',
      'param_id',
      'core_hash',
    ];

    const lines: string[] = [];
    lines.push(columns.join(','));

    for (const row of detailedPoints) {
      const scenarioId = String((row as any)?.scenario_id ?? '');
      const subjectId = String((row as any)?.subject_id ?? '');
      const asAtISO = String((row as any)?.as_at_date ?? '');
      const anchorISO = String((row as any)?.anchor_day ?? '');
      const windowFromISO = String((row as any)?.window_from ?? '');
      const windowToISO = String((row as any)?.window_to ?? '');

      const out: Record<string, any> = {
        scenario_id: scenarioId,
        scenario_name: scenarioMeta?.[scenarioId]?.name ?? '',
        subject_id: subjectId,
        subject_label: subjectMeta?.[subjectId]?.name ?? '',
        window_from_iso: windowFromISO,
        window_from_uk: windowFromISO ? formatDate_d_MMM_yy(windowFromISO) : '',
        window_to_iso: windowToISO,
        window_to_uk: windowToISO ? formatDate_d_MMM_yy(windowToISO) : '',
        as_at_date_iso: asAtISO,
        as_at_date_uk: asAtISO ? formatDate_d_MMM_yy(asAtISO) : '',
        anchor_day_iso: anchorISO,
        anchor_day_uk: anchorISO ? formatDate_d_MMM_yy(anchorISO) : '',
        cohort_age_days: (row as any)?.cohort_age_days,
        cohort_age_at_window_end_days: (row as any)?.cohort_age_at_window_end_days,
        x: (row as any)?.x,
        y: (row as any)?.y,
        a: (row as any)?.a,
        rate: (row as any)?.rate,
        median_lag_days: (row as any)?.median_lag_days,
        mean_lag_days: (row as any)?.mean_lag_days,
        onset_delta_days: (row as any)?.onset_delta_days,
        epoch_subject_id: (row as any)?.epoch_subject_id,
        epoch_sweep_from: (row as any)?.epoch_sweep_from,
        epoch_sweep_to: (row as any)?.epoch_sweep_to,
        epoch_slice_keys: (row as any)?.epoch_slice_keys,
        param_id: (row as any)?.param_id,
        core_hash: (row as any)?.core_hash,
      };

      lines.push(columns.map((c) => escapeCsvCell(out[c])).join(','));
    }

    const safeName = (result.analysis_name || result.analysis_type || 'analysis')
      .replace(/[^\w\s-]+/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .toLowerCase();

    return { filename: `${safeName}-cohorts.csv`, csv: lines.join('\n') + '\n' };
  }

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


