/**
 * Signature Policy Service
 *
 * TEMPORARY RELEASE SAFETY MEASURE (20-Jan-26):
 * - Signature checking is currently disabled because it can block business-critical fetch workflows
 *   when cached files contain legacy / mismatched signatures.
 *
 * When re-enabling:
 * - Ensure planner + executor compute signatures identically (including workspace scoping)
 * - Ensure MECE implicit-uncontexted fulfilment can match signed contexted generations
 * - Ensure signature mismatch NEVER prevents fetching (at worst, it should trigger a refetch)
 */
export const SIGNATURE_CHECKING_ENABLED = false;
export const SIGNATURE_WRITING_ENABLED = false;

export function isSignatureCheckingEnabled(): boolean {
  return SIGNATURE_CHECKING_ENABLED;
}

export function isSignatureWritingEnabled(): boolean {
  return SIGNATURE_WRITING_ENABLED;
}


