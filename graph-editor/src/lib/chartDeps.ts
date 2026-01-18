import { fnv1a32, stableStringify } from './stableSignature';

export type ChartDepsMode = 'linked' | 'pinned';

export type ChartVisibilityMode = 'f+e' | 'f' | 'e';

export type ChartKind = 'analysis_funnel' | 'analysis_bridge';

export type ChartDepsScenarioV1 = {
  scenario_id: string;
  /**
   * Flattened/effective DSL used for compute in pinned mode.
   * For linked mode, this may be omitted if the stamp instead depends on the parent tab context.
   */
  effective_dsl?: string;
  /**
   * Forecast/evidence visibility mode when it affects analysis/compute.
   */
  visibility_mode?: ChartVisibilityMode;
  /**
   * Whether this scenario is DSL-backed live (regenerable) for pinned-mode recompute eligibility checks.
   */
  is_live?: boolean;
};

export type ChartDepsStampV1 = {
  v: 1;
  mode: ChartDepsMode;
  chart_kind: ChartKind;

  parent?: {
    parent_file_id?: string;
    parent_tab_id?: string;
  };

  analysis?: {
    analysis_type?: string;
    query_dsl?: string;
    what_if_dsl?: string;
  };

  /**
   * Ordered list of scenarios that participate in the compute.
   * Ordering is semantically relevant.
   */
  scenarios: ChartDepsScenarioV1[];

  /**
   * Compact signature representing authoritative underlying file revisions that influence scenario graphs.
   * See dynamic-update.md (“inputs observed” / file revision tokens).
   */
  inputs_signature?: string;

  /**
   * Included only when any participating DSL is dynamic; see dynamic-update.md.
   * Must be in d-MMM-yy format.
   */
  reference_day_uk?: string;
};

function normaliseText(x: unknown): string | undefined {
  if (typeof x !== 'string') return undefined;
  const s = x.replace(/\r\n/g, '\n').trim();
  return s.length ? s : undefined;
}

function omitUndefinedObject<T extends Record<string, any>>(obj: T): Partial<T> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

export function canonicaliseChartDepsStampV1(stamp: ChartDepsStampV1): ChartDepsStampV1 {
  const parent = stamp.parent
    ? (omitUndefinedObject({
        parent_file_id: normaliseText(stamp.parent.parent_file_id),
        parent_tab_id: normaliseText(stamp.parent.parent_tab_id),
      }) as ChartDepsStampV1['parent'])
    : undefined;

  const analysis = stamp.analysis
    ? (omitUndefinedObject({
        analysis_type: normaliseText(stamp.analysis.analysis_type),
        query_dsl: normaliseText(stamp.analysis.query_dsl),
        what_if_dsl: normaliseText(stamp.analysis.what_if_dsl),
      }) as ChartDepsStampV1['analysis'])
    : undefined;

  const scenarios = (Array.isArray(stamp.scenarios) ? stamp.scenarios : []).map(s => {
    return omitUndefinedObject({
      scenario_id: normaliseText(s?.scenario_id) || '',
      effective_dsl: normaliseText(s?.effective_dsl),
      visibility_mode: s?.visibility_mode,
      is_live: typeof s?.is_live === 'boolean' ? s.is_live : undefined,
    }) as ChartDepsScenarioV1;
  });

  return omitUndefinedObject({
    v: 1,
    mode: stamp.mode,
    chart_kind: stamp.chart_kind,
    parent,
    analysis,
    scenarios,
    inputs_signature: normaliseText((stamp as any).inputs_signature),
    reference_day_uk: normaliseText(stamp.reference_day_uk),
  }) as ChartDepsStampV1;
}

export function chartDepsSignatureV1(stamp: ChartDepsStampV1): string {
  const canonical = canonicaliseChartDepsStampV1(stamp);
  const json = stableStringify(canonical);
  return `v1:${fnv1a32(json)}`;
}

export function isChartStaleV1(args: {
  storedDepsSignature?: string | null;
  currentStamp: ChartDepsStampV1;
}): boolean {
  const stored = typeof args.storedDepsSignature === 'string' ? args.storedDepsSignature : '';
  if (!stored.trim()) return true;
  const current = chartDepsSignatureV1(args.currentStamp);
  return stored !== current;
}


