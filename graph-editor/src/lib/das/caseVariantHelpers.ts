/**
 * Shared helpers for mapping case variants to provider-specific representations.
 */

/**
 * Resolve a case variant name to a boolean gate value (for gate-style experiments).
 *
 * Strategy:
 *   1) If variant name is obviously truthy/falsey (true/false, on/off, yes/no, etc.) use that
 *   2) Otherwise, treat "control" as false and "treatment" as true (our default convention)
 *   3) If we have the full variant set:
 *      - For 2 variants: if one is clearly true/false, infer the other as the opposite
 *      - For 3+ variants: if exactly one is clearly true OR exactly one is clearly false,
 *        infer the rest as the opposite
 *   4) Fallback: if still unknown, default to true (assume "in experiment")
 *
 * NOTE: This is intentionally permissive and bias-towards-true so that
 * non-obvious variant labels still behave as "gate active" by default.
 */
export function resolveVariantToBool(variant: unknown, allVariants?: unknown[]): boolean {
  const falsey = ['false', 'off', 'no', '0', 'inactive', 'disabled'];
  const truthy = ['true', 'on', 'yes', '1', 'active', 'enabled'];

  const normalize = (val: unknown): string =>
    typeof val === 'string' ? val.trim().toLowerCase() : '';

  const localResolve = (val: unknown): boolean | undefined => {
    const v = normalize(val);
    if (!v) return undefined;

    if (falsey.includes(v)) return false;
    if (truthy.includes(v)) return true;

    // Conventional names
    if (v === 'control') return false;
    if (v === 'treatment') return true;

    return undefined;
  };

  // First try local resolution for the requested variant
  const direct = localResolve(variant);
  if (!allVariants || !Array.isArray(allVariants) || allVariants.length === 0) {
    // No global context – fall back to direct result or default-true
    return direct !== undefined ? direct : true;
  }

  // Build classification for all variants
  const classified = allVariants.map(v => ({
    raw: v,
    norm: normalize(v),
    bool: localResolve(v),
  }));

  const truthyVariants = classified.filter(c => c.bool === true);
  const falseyVariants = classified.filter(c => c.bool === false);

  const targetNorm = normalize(variant);

  // If we already have a direct mapping for this variant, prefer it
  if (direct !== undefined) {
    return direct;
  }

  // Exactly 2 variants – infer complement when one side is known
  if (allVariants.length === 2) {
    if (truthyVariants.length === 1 && falseyVariants.length === 0) {
      // One clearly "true" variant → the other is "false"
      return targetNorm === truthyVariants[0].norm ? true : false;
    }
    if (falseyVariants.length === 1 && truthyVariants.length === 0) {
      // One clearly "false" variant → the other is "true"
      return targetNorm === falseyVariants[0].norm ? false : true;
    }

    // Ambiguous → default-true
    return true;
  }

  // 3+ variants:
  // - If exactly one truthy and no falsey → that one is true, others false
  if (truthyVariants.length === 1 && falseyVariants.length === 0) {
    return targetNorm === truthyVariants[0].norm ? true : false;
  }

  // - If exactly one falsey and no truthy → that one is false, others true
  if (falseyVariants.length === 1 && truthyVariants.length === 0) {
    return targetNorm === falseyVariants[0].norm ? false : true;
  }

  // Otherwise ambiguous → fall back to default-true
  return true;
}


