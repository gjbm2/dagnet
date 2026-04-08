/**
 * Analysis type registry for CLI — thin lookup layer that isolates
 * CLI commands from the component-layer analysisTypes module.
 *
 * The full ANALYSIS_TYPES lives in components/panels/analysisTypes.ts
 * and imports React, Lucide icons, and custom renderers. The CLI only
 * needs `id` → `snapshotContract`. This module provides that lookup
 * without leaking component-layer concerns into command logic.
 */

import { ANALYSIS_TYPES, type SnapshotContract } from '../components/panels/analysisTypes';

/**
 * Look up whether an analysis type requires snapshot DB data.
 * Returns the contract if it does, undefined if not.
 */
export function getSnapshotContract(analysisType: string): SnapshotContract | undefined {
  const meta = ANALYSIS_TYPES.find(t => t.id === analysisType);
  return meta?.snapshotContract;
}

/**
 * Check if an analysis type ID is valid (known to the system).
 */
export function isValidAnalysisType(analysisType: string): boolean {
  return ANALYSIS_TYPES.some(t => t.id === analysisType);
}
