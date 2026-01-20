import { isUKDate, isRelativeDate } from './dateFormat';
import { parseConstraints } from './queryDSL';

/**
 * Best-effort detection of whether a DSL has dynamic (day-dependent) date resolution.
 *
 * We treat a DSL as "dynamic" when it uses:
 * - relative date specifications (e.g. -60d)
 * - open-ended ranges (missing start or end)
 *
 * This is intentionally conservative; false positives are acceptable (extra invalidation),
 * false negatives are more harmful (stale results).
 */
export function dslDependsOnReferenceDay(dsl: string | undefined | null): boolean {
  if (typeof dsl !== 'string' || !dsl.trim()) return false;
  let c: any;
  try {
    c = parseConstraints(dsl);
  } catch {
    // If we can't parse, assume dynamic rather than silently missing invalidation.
    return true;
  }

  const checkRange = (start?: string | null, end?: string | null): boolean => {
    const s = typeof start === 'string' ? start.trim() : '';
    const e = typeof end === 'string' ? end.trim() : '';
    if (!s || !e) return Boolean(s || e); // open-ended => dynamic
    if (isRelativeDate(s) || isRelativeDate(e)) return true;
    // If either side is not a UK date, treat as dynamic.
    if (!isUKDate(s) || !isUKDate(e)) return true;
    return false;
  };

  if (c?.window?.start || c?.window?.end) {
    if (checkRange(c.window.start, c.window.end)) return true;
  }
  if (c?.cohort?.start || c?.cohort?.end) {
    if (checkRange(c.cohort.start, c.cohort.end)) return true;
  }

  return false;
}






