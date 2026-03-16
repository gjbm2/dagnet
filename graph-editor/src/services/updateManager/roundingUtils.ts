/**
 * Rounding utilities for UpdateManager.
 *
 * Extracted from UpdateManager.ts (Cluster B) as part of the src-slimdown
 * modularisation.  These functions are platform-agnostic — no browser imports.
 */

import { roundToDecimalPlaces } from '../../utils/rounding';
import { PRECISION_DECIMAL_PLACES, LATENCY_HORIZON_DECIMAL_PLACES } from '../../constants/latency';

/**
 * Round a number to standard precision (PRECISION_DECIMAL_PLACES) to avoid
 * floating-point noise and ensure consistent values across the application.
 */
export function roundToDP(value: number): number {
  return roundToDecimalPlaces(value, PRECISION_DECIMAL_PLACES);
}

/**
 * Round latency horizons (days) to standard persisted precision.
 *
 * These are not probabilities; we intentionally use a separate precision constant
 * from `PRECISION_DECIMAL_PLACES`.
 */
export function roundHorizonDays(value: number): number {
  return roundToDecimalPlaces(value, LATENCY_HORIZON_DECIMAL_PLACES);
}
