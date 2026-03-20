/**
 * Data Depth Tier — v2 re-exports.
 *
 * The v1 bucket-based scale is replaced by the composite scoring in
 * dataDepthService.ts.  This file re-exports the colour/formatting
 * utilities so existing imports don't break.
 */

export {
  depthToColour,
  noDataColour,
  formatN,
  formatPct,
  depthBeadLabel,
  type DataDepthScore,
} from '../services/dataDepthService';
