import { fnv1a32, stableStringify } from './stableSignature';

export type ScenarioObservedInputKindV1 = 'graph' | 'settings' | 'parameter' | 'context' | 'index';

export type ScenarioObservedInputV1 = {
  kind: ScenarioObservedInputKindV1;
  /**
   * A stable logical identifier, e.g. parameter id, context id, or index name.
   */
  id?: string;
  /**
   * Optional fileId (when we can resolve it deterministically).
   */
  file_id?: string;
  /**
   * Revision token: sha when available, else lastModified, else 'missing'.
   */
  rev: string;
};

export type ScenarioDepsStampV1 = {
  v: 1;
  graph_file_id?: string;
  base_dsl?: string;
  effective_dsl?: string;
  inputs: ScenarioObservedInputV1[];
  /**
   * Included only when the effective DSL depends on the UK reference day.
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

export function canonicaliseScenarioDepsStampV1(stamp: ScenarioDepsStampV1): ScenarioDepsStampV1 {
  const inputs0 = Array.isArray(stamp.inputs) ? stamp.inputs : [];
  const inputs = inputs0
    .map((i) => {
      return omitUndefinedObject({
        kind: i.kind,
        id: normaliseText(i.id),
        file_id: normaliseText(i.file_id),
        rev: normaliseText(i.rev) || 'missing',
      }) as ScenarioObservedInputV1;
    })
    .sort((a, b) => {
      const ak = `${a.kind}:${a.id || ''}:${a.file_id || ''}`;
      const bk = `${b.kind}:${b.id || ''}:${b.file_id || ''}`;
      return ak.localeCompare(bk);
    });

  return omitUndefinedObject({
    v: 1,
    graph_file_id: normaliseText(stamp.graph_file_id),
    base_dsl: normaliseText(stamp.base_dsl),
    effective_dsl: normaliseText(stamp.effective_dsl),
    inputs,
    reference_day_uk: normaliseText(stamp.reference_day_uk),
  }) as ScenarioDepsStampV1;
}

export function scenarioDepsSignatureV1(stamp: ScenarioDepsStampV1): string {
  const canonical = canonicaliseScenarioDepsStampV1(stamp);
  return `v1:${fnv1a32(stableStringify(canonical))}`;
}






