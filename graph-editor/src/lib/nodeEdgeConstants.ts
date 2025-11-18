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
export const CONVEX_DEPTH = 15;

/** Depth of concave indentation on inbound node faces (pixels) */
export const CONCAVE_DEPTH = 15;

/** Multiplier for handle offset on convex faces (0 = no offset, 1 = full depth) */
export const CONVEX_HANDLE_OFFSET_MULTIPLIER = 0.25;

/** Multiplier for handle offset on concave faces (0 = no offset, 1 = full depth) */
export const CONCAVE_HANDLE_OFFSET_MULTIPLIER = 0.5;

/** Multiplier for handle offset on flat faces (relative to convex depth) */
export const FLAT_HANDLE_OFFSET_MULTIPLIER = 0.25;

/** Width of halo stroke around nodes for edge masking (pixels) */
export const HALO_WIDTH = 20;

/** Default nominal node width (pixels, before any padding) */
export const DEFAULT_NODE_WIDTH = 110;

/** Default nominal node height (pixels, before any padding) */
export const DEFAULT_NODE_HEIGHT = 110;

/** Minimum node height in Sankey view (pixels) */
export const MIN_NODE_HEIGHT = 60;

/** Maximum node height in Sankey view (pixels) */
export const MAX_NODE_HEIGHT = 400;

/** Node content padding (pixels) */
export const NODE_PADDING = 8;

// ===== EDGE GEOMETRY =====

/** 
 * Maximum edge bundle width (pixels)
 * Based on visible content area inside node padding:
 * DEFAULT_NODE_HEIGHT (100px) - 2 * NODE_PADDING (16px) = 84px
 */
export const MAX_EDGE_WIDTH = 88;

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
export const BEAD_MARKER_DISTANCE = 5;

/** Spacing between beads along the edge path (pixels) */
export const BEAD_SPACING = 20;

// ===== SANKEY MODE =====

/** Maximum edge width in Sankey view (pixels) */
export const SANKEY_MAX_EDGE_WIDTH = 400;

/** Edge curvature for normal view (0-1, higher = more curve) */
export const EDGE_CURVATURE = 0.5;

/** Edge curvature for Sankey view (0-1, lower = more horizontal) */
export const SANKEY_EDGE_CURVATURE = 0.3;

// ===== TYPOGRAPHY =====

/** Font size for node labels (pixels) */
export const NODE_LABEL_FONT_SIZE = 10;

/** Font size for node secondary text (pixels) */
export const NODE_SECONDARY_FONT_SIZE = 8;

/** Font size for node small text/badges (pixels) */
export const NODE_SMALL_FONT_SIZE = 8;

/** Font size for case node text (pixels) */
export const CASE_NODE_FONT_SIZE = 10;

/** Font size for edge tooltips and context menus (pixels) - note: edge labels are not rendered, only tooltips */
export const EDGE_LABEL_FONT_SIZE = 12;

/** Font size for edge bead text (pixels) */
export const BEAD_FONT_SIZE = 10;

