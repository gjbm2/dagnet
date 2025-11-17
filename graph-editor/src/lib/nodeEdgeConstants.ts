/**
 * Shared constants for node and edge rendering
 * 
 * Centralized to avoid duplication and ensure consistency across:
 * - GraphCanvas.tsx
 * - ConversionNode.tsx
 * - ConversionEdge.tsx
 * - buildScenarioRenderEdges.ts
 * - EdgeBeads.tsx
 */

// ===== NODE GEOMETRY =====

/** Depth of convex bulge on outbound node faces (pixels) */
export const CONVEX_DEPTH = 12;

/** Depth of concave indentation on inbound node faces (pixels) */
export const CONCAVE_DEPTH = 12;

/** Width of halo stroke around nodes for edge masking (pixels) */
export const HALO_WIDTH = 20;

/** Default nominal node width (pixels, before any padding) */
export const DEFAULT_NODE_WIDTH = 100;

/** Default nominal node height (pixels, before any padding) */
export const DEFAULT_NODE_HEIGHT = 100;

/** Node content padding (pixels) */
export const NODE_PADDING = 8;

// ===== EDGE GEOMETRY =====

/** 
 * Maximum edge bundle width (pixels)
 * Based on visible content area inside node padding:
 * DEFAULT_NODE_HEIGHT (100px) - 2 * NODE_PADDING (16px) = 84px
 */
export const MAX_EDGE_WIDTH = 84;

/** Minimum edge width (pixels) */
export const MIN_EDGE_WIDTH = 2;

/** 
 * How far edges are tucked under the node boundary (pixels)
 * Should equal HALO_WIDTH to ensure edges are fully masked by halo
 */
export const EDGE_INSET = 20; // HALO_WIDTH

/** 
 * Additional offset to add space between edges and nodes (pixels)
 * Set to 0 for edges to start right at the visual boundary
 */
export const EDGE_INITIAL_OFFSET = 0;

/** 
 * Additional spacing between visible edge start and first bead (pixels)
 * This is added ON TOP of visibleStartOffset
 */
export const BEAD_MARKER_DISTANCE = 0;

/** Spacing between beads along the edge path (pixels) */
export const BEAD_SPACING = 20;

// ===== SANKEY MODE =====

/** Maximum edge width in Sankey view (pixels) */
export const SANKEY_MAX_EDGE_WIDTH = 384;

/** Edge curvature for normal view (0-1, higher = more curve) */
export const EDGE_CURVATURE = 0.5;

/** Edge curvature for Sankey view (0-1, lower = more horizontal) */
export const SANKEY_EDGE_CURVATURE = 0.3;

