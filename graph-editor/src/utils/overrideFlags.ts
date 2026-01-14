/**
 * Override flag detection helpers.
 *
 * Override flags are indicated by boolean fields ending in `_overridden`.
 * These are used widely across graph edges, conditional probabilities, and
 * parameter configs (including latency fields).
 */
export function hasAnyOverriddenFlag(value: unknown, maxDepth = 6): boolean {
  if (maxDepth <= 0) return false;
  if (!value || typeof value !== 'object') return false;

  if (Array.isArray(value)) {
    for (const item of value) {
      if (hasAnyOverriddenFlag(item, maxDepth - 1)) return true;
    }
    return false;
  }

  const obj = value as Record<string, unknown>;
  for (const [key, v] of Object.entries(obj)) {
    if (key.endsWith('_overridden') && v === true) return true;
    if (v && typeof v === 'object') {
      if (hasAnyOverriddenFlag(v, maxDepth - 1)) return true;
    }
  }
  return false;
}

/**
 * Collect overridden flag paths (keys ending in `_overridden` with value `true`).
 *
 * Used for tooltips / debugging so users can see *which* fields are overridden.
 */
export function listOverriddenFlagPaths(value: unknown, maxDepth = 6, prefix = ''): string[] {
  if (maxDepth <= 0) return [];
  if (!value || typeof value !== 'object') return [];

  if (Array.isArray(value)) {
    const out: string[] = [];
    for (let i = 0; i < value.length; i++) {
      out.push(...listOverriddenFlagPaths(value[i], maxDepth - 1, `${prefix}[${i}]`));
    }
    return out;
  }

  const obj = value as Record<string, unknown>;
  const out: string[] = [];
  for (const [key, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (key.endsWith('_overridden') && v === true) {
      out.push(path);
    } else if (v && typeof v === 'object') {
      out.push(...listOverriddenFlagPaths(v, maxDepth - 1, path));
    }
  }
  return out;
}

/**
 * Edge-level query overrides are represented by explicit override flags:
 * - `query_overridden: true`
 * - `n_query_overridden: true`
 * - `conditional_p[*].query_overridden: true`
 */
export function hasAnyEdgeQueryOverride(edge: unknown): boolean {
  if (!edge || typeof edge !== 'object') return false;
  const e = edge as any;
  if (e.query_overridden === true) return true;
  if (e.n_query_overridden === true) return true;
  if (Array.isArray(e.conditional_p) && e.conditional_p.some((cp: any) => cp?.query_overridden === true)) return true;
  return false;
}


