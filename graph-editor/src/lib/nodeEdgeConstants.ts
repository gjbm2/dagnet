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

/** Base opacity for all edges (0-1) */
export const EDGE_OPACITY = 0.7;

/** Blend mode for edges ('normal', 'multiply', 'screen', 'difference') */
export const EDGE_BLEND_MODE = 'multiply';

/** 
 * Additional spacing between visible edge start and first bead (pixels)
 * This is added ON TOP of visibleStartOffset (which accounts for source node concavity)
 */
export const BEAD_MARKER_DISTANCE = 10;

/**
 * Additional spacing between arrival (target) node face and right-aligned beads (pixels)
 * This is added ON TOP OF visibleEndOffset (which accounts for target node concavity)
 * and controls how far latency beads sit away from the inbound node face.
 */
export const BEAD_ARRIVAL_FACE_OFFSET = 15;

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
export const NODE_LABEL_FONT_SIZE = 8;

/** Font size for node secondary text (pixels) */
export const NODE_SECONDARY_FONT_SIZE = 7;

/** Font size for node small text/badges (pixels) */
export const NODE_SMALL_FONT_SIZE = 8;

/** Font size for case node text (pixels) */
export const CASE_NODE_FONT_SIZE = 10;

/** Font size for edge tooltips and context menus (pixels) - note: edge labels are not rendered, only tooltips */
export const EDGE_LABEL_FONT_SIZE = 12;

/** Font size for edge bead text (pixels) */
export const BEAD_FONT_SIZE = 9;

/** Height for edge beads/lozenges (pixels) - typically ~1.4× font size for comfortable padding */
export const BEAD_HEIGHT = 1.4 * BEAD_FONT_SIZE;

// ===== CHEVRONS (all types) =====

// --- Animated flow chevrons (directional indicators on edges) ---

/** Spacing between chevrons along edge (pixels) - more = fewer chevrons */
export const CHEVRON_SPACING = 120;

/** Chevron travel speed along edge (pixels per second) */
export const CHEVRON_SPEED = 20;

/** Chevron angle ratio - controls how pointy the chevron is (0.3 = shallow, 1.0 = steep) */
export const CHEVRON_ANGLE_RATIO = 0.75;

/** Chevron length as multiple of edge width (1.0 = same as edge width, 2.0 = twice as long) */
export const CHEVRON_LENGTH_RATIO = .4;

/** Chevron opacity (0-1) */
export const CHEVRON_OPACITY = 0.12;

/** Fade-in duration as fraction of total animation (0-1) - how quickly chevrons appear at start */
export const CHEVRON_FADE_IN_FRACTION = 0.1;

/** Blur amount for chevron edges (pixels) - 0 = sharp, 1-3 = soft glow */
export const CHEVRON_BLUR = 5;

/**
 * Lag-based chevron speed scaling parameters.
 * Speed decays as a power law: speed(d) = CHEVRON_SPEED * (1 + d/D0)^(-k)
 * 
 * Anchor points:
 *   d=0  → speed = CHEVRON_SPEED (baseline)
 *   d=7  → speed ≈ CHEVRON_SPEED / 2
 *   d=30 → speed ≈ CHEVRON_SPEED / 4
 */

/** D0 parameter: characteristic lag scale in days (lower = faster decay) */
export const CHEVRON_LAG_D0 = 3;

/** k parameter: decay exponent (higher = faster decay) */
export const CHEVRON_LAG_K = 0.6;

// --- Spline-following chevrons (LAG completeness indicator) ---

/** Use chevrons that follow the spline path (better for curves) */
export const LAG_ANCHOR_USE_SPLINE_CHEVRONS = true;

/** Length of each chevron in pixels (from back to front point) */
export const LAG_ANCHOR_SPLINE_CHEVRON_LENGTH = 6;

/** Visible gap between chevrons in pixels */
export const LAG_ANCHOR_SPLINE_CHEVRON_GAP = 4;

/** Angle of chevron V-points from perpendicular (degrees). 0 = flat, 45 = diagonal, 90 = parallel to spline */
export const LAG_ANCHOR_SPLINE_CHEVRON_ANGLE = 30;

// --- Single completeness chevron (non-Sankey mode) ---

/**
 * Minimum half-width of completeness chevron (pixels).
 * Should be larger than BEAD_HEIGHT / 2 (~6.3) so chevron is visible above beads.
 */
export const COMPLETENESS_CHEVRON_MIN_HALF_WIDTH = 14;

/**
 * Padding added to the max layer width for completeness chevron (pixels).
 * Ensures chevron extends beyond all visible layers.
 */
export const COMPLETENESS_CHEVRON_WIDTH_PADDING = 3;

/**
 * Pixel offset from edge path origin where completeness chevron range starts (pixels).
 * At 0% completeness, chevron front tip appears at this distance from path origin.
 * Should be >= EDGE_INSET (20px) so chevron is visible outside the source node.
 */
export const COMPLETENESS_CHEVRON_START_OFFSET = 28;

/**
 * Pixel offset from target node where completeness chevron can end (pixels).
 * At 100% completeness, chevron appears this far from the edge end.
 * Should account for node overlap / visual edge boundary.
 */
export const COMPLETENESS_CHEVRON_END_OFFSET = 6;

/** Base opacity for completeness chevron (0-1) */
export const COMPLETENESS_CHEVRON_OPACITY = 0.3;

/** Opacity for completeness chevron when SELECTED (0-1) */
export const COMPLETENESS_CHEVRON_SELECTED_OPACITY = 0.8;

/** Opacity for completeness chevron when HIGHLIGHTED (0-1) */
export const COMPLETENESS_CHEVRON_HIGHLIGHTED_OPACITY = 0.6;

// --- Pattern-based chevrons (legacy, when LAG_ANCHOR_USE_SPLINE_CHEVRONS = false) ---

/** Use chevrons instead of stripes for anchor pattern (directional feel) */
export const LAG_ANCHOR_USE_CHEVRONS = false;

/** Chevron size for anchor pattern (pixels) - height of the chevron */
export const LAG_ANCHOR_CHEVRON_SIZE = 8;

/** Gap between chevrons in anchor pattern (pixels) */
export const LAG_ANCHOR_CHEVRON_GAP = 24;

/** Stroke width of chevron lines (pixels) */
export const LAG_ANCHOR_CHEVRON_STROKE = 5;

// ===== LAG (LATENCY) TWO-LAYER RENDERING =====

// --- Forecast (outer) layer stripes ---
/** Width of each stripe in FORECAST layer (pixels) */
export const LAG_FORECAST_STRIPE_WIDTH = 3;

/** Gap between stripes in FORECAST layer (pixels) */
export const LAG_FORECAST_STRIPE_GAP = 1;

/** Angle of FORECAST stripes (degrees) */
export const LAG_FORECAST_STRIPE_ANGLE = 45;

/** Opacity of FORECAST stripe fill */
export const LAG_FORECAST_STRIPE_OPACITY =1;

/** Offset for FORECAST stripe pattern (pixels) - shifts stripes along pattern */
export const LAG_FORECAST_STRIPE_OFFSET = 0;

// --- Evidence (inner) layer stripes ---
/** Width of each stripe in EVIDENCE layer (pixels) */
export const LAG_EVIDENCE_STRIPE_WIDTH = 1;

/** Gap between stripes in EVIDENCE layer (pixels) */
export const LAG_EVIDENCE_STRIPE_GAP = 3;

/** Angle of EVIDENCE stripes (degrees) */
export const LAG_EVIDENCE_STRIPE_ANGLE = 45;

/** Opacity of EVIDENCE stripe fill */
export const LAG_EVIDENCE_STRIPE_OPACITY = 1;

/** Offset for EVIDENCE stripe pattern (pixels) - shifts stripes along pattern */
export const LAG_EVIDENCE_STRIPE_OFFSET = 3;

/**
 * Opacity (0-1) for edges in E-mode that have NO evidence data at all
 * (p.evidence is missing) but still have flow (p.mean / forecast).
 * These edges should appear faint rather than invisible or dashed, to indicate
 * that they are modelled but not yet supported by direct evidence.
 */
export const NO_EVIDENCE_E_MODE_OPACITY = 0.2;

/**
 * Opacity multiplier (0-1) applied to the **p.mean anchor lane** when rendering in **E mode**
 * for edges that have **no p.evidence block at all** (i.e. "rebalanced" edges).
 *
 * This exists because the anchor lane is a separate visual element from the E-mode lane.
 * Without this, rebalanced edges can remain visible in E mode even when the evidence lane
 * is fully hidden via NO_EVIDENCE_E_MODE_OPACITY.
 *
 * Default: 0 (hide anchor for rebalanced edges in E mode). Raise this if you want the anchor
 * to remain faintly visible while still signalling "no evidence".
 */
// --- Legacy aliases (for existing code) ---
/** @deprecated Use LAG_FORECAST_STRIPE_WIDTH or LAG_EVIDENCE_STRIPE_WIDTH */
export const LAG_STRIPE_WIDTH = LAG_FORECAST_STRIPE_WIDTH;
/** @deprecated Use LAG_FORECAST_STRIPE_ANGLE or LAG_EVIDENCE_STRIPE_ANGLE */
export const LAG_STRIPE_ANGLE = LAG_FORECAST_STRIPE_ANGLE;
/** @deprecated Use LAG_FORECAST_STRIPE_OPACITY or LAG_EVIDENCE_STRIPE_OPACITY */
export const LAG_STRIPE_OPACITY = LAG_FORECAST_STRIPE_OPACITY;
/** @deprecated Use LAG_FORECAST_STRIPE_GAP or LAG_EVIDENCE_STRIPE_GAP */
export const LAG_STRIPE_GAP = LAG_FORECAST_STRIPE_GAP;

/** Base opacity for p.mean anchor edge (0-1) */
export const LAG_ANCHOR_OPACITY = 0.05;

/** Opacity for p.mean anchor edge when SELECTED (0-1) - much more visible */
export const LAG_ANCHOR_SELECTED_OPACITY = 0.7;

/** Opacity for p.mean anchor edge when HIGHLIGHTED (0-1) - intermediate visibility */
export const LAG_ANCHOR_HIGHLIGHTED_OPACITY = 0.5;

/** 
 * Width of fade band for anchor gradient as fraction of path (0-1)
 * Anchor fades from full to minimum AROUND the completeness point
 * E.g., 0.1 = ±5% around completeness, so at 50% completeness fades from 45% to 55%
 * Could be replaced with latency.stdev when available
 */
export const LAG_ANCHOR_FADE_BAND = 0.01;

/** 
 * Minimum opacity at end of anchor fade (0-1, relative to LAG_ANCHOR_OPACITY)
 * E.g., 0.25 means the anchor fades to 25% of its base opacity, not fully transparent
 * This keeps the anchor subtly visible even past the completeness point
 */
export const LAG_ANCHOR_FADE_MIN = 0.15;

/** Use stripes on anchor edge to show completeness (more visible on busy graphs) */
export const LAG_ANCHOR_USE_STRIPES = false;

/** Stripe width for anchor completeness pattern (pixels) */
export const LAG_ANCHOR_STRIPE_WIDTH = 7.5;

/** Gap between stripes in anchor pattern (pixels) */
export const LAG_ANCHOR_STRIPE_GAP = 1.5;

/** Angle of anchor stripes (degrees) - different from LAG stripes for distinction */
export const LAG_ANCHOR_STRIPE_ANGLE = -30;

/** Stipple dot spacing (pixels) for hidden current anchor - smaller = denser dots */
export const LAG_ANCHOR_STIPPLE_SPACING = 5;

/** Stipple dot radius (pixels) for hidden current anchor */
export const LAG_ANCHOR_STIPPLE_RADIUS = 1.5;

/** Rotation angle for stipple pattern (degrees) - 45 gives diagonal dot grid */
export const HIDDEN_CURRENT_STIPPLE_ANGLE = -30;

/** Opacity for hidden current layer stipple dots (0-1) */
export const HIDDEN_CURRENT_OPACITY = 0.2;

// =============================================================================
// Sankey F+E (Forecast + Evidence) Constants
// =============================================================================

/** 
 * Pixels hidden inside each node where Sankey ribbons are clipped.
 * Controls where 0% and 100% completeness lines appear.
 * Increase if lines appear inside nodes, decrease if too far from edges.
 */
export const SANKEY_NODE_INSET = 12.5;

/** 
 * Minimum height of completeness marker line (pixels).
 * Should be larger than BEAD_HEIGHT (~12.6) so line is visible above beads.
 */
export const SANKEY_COMPLETENESS_LINE_MIN_HEIGHT = 24;

/**
 * Overhang of completeness line above/below the ribbon (pixels).
 * Line extends this far beyond the ribbon edge at top and bottom for visibility.
 */
export const SANKEY_COMPLETENESS_LINE_OVERHANG = 7;

/**
 * Stroke width of completeness marker line (pixels).
 */
export const SANKEY_COMPLETENESS_LINE_STROKE = 1.5;
