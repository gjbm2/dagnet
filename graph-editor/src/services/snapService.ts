/**
 * snapService.ts — Pure geometry for snap-to-guide lines.
 *
 * Adapted from the xyflow Pro helper-lines example (perpetual licence).
 * Provides spatial indexing, anchor resolution, and snap computation.
 * No React dependencies — all functions are pure.
 */

import type { Node, NodePositionChange } from 'reactflow';

// ─── Types ───────────────────────────────────────────────────────────────────

export type Orientation = 'horizontal' | 'vertical';

export interface Box {
  x: number;
  y: number;
  x2: number;
  y2: number;
}

export interface HelperLine {
  node: Node;
  nodeBox: Box;
  orientation: Orientation;
  /** Y coordinate if horizontal, X coordinate if vertical */
  position: number;
  color?: string;
  anchorName: string;
}

export type AnchorResolver = (node: Node, box: Box) => number;

export interface Anchor {
  orientation: Orientation;
  resolve: AnchorResolver;
}

export interface AnchorMatch {
  anchorName: string;
  sourcePosition: number;
  anchor: Anchor;
  line: HelperLine;
}

interface CandidateLine {
  line: HelperLine;
  lineDist: number;
  nodeDist: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const SNAP_RADIUS = 10;

/** All six anchor points. Every object exposes all six as snap *targets*. */
export const ALL_ANCHORS: Record<string, Anchor> = {
  top:     { orientation: 'horizontal', resolve: (_, box) => box.y },
  bottom:  { orientation: 'horizontal', resolve: (_, box) => box.y2 },
  left:    { orientation: 'vertical',   resolve: (_, box) => box.x },
  right:   { orientation: 'vertical',   resolve: (_, box) => box.x2 },
  centreX: { orientation: 'vertical',   resolve: (_, box) => (box.x + box.x2) / 2 },
  centreY: { orientation: 'horizontal', resolve: (_, box) => (box.y + box.y2) / 2 },
};

/** Source anchors for conversion nodes (fixed-size): centre only. */
export const NODE_DRAG_ANCHORS: string[] = ['centreX', 'centreY'];

/** Source anchors for conversion nodes in Sankey view: centres + top/bottom
 *  (nodes have varying heights, so edge alignment matters). */
export const NODE_DRAG_ANCHORS_SANKEY: string[] = ['centreX', 'centreY', 'top', 'bottom'];

/** Source anchors for resizable objects (post-its, containers, analyses): all six. */
export const RESIZABLE_DRAG_ANCHORS: string[] = Object.keys(ALL_ANCHORS);

/**
 * Determine which source anchors to use when dragging a node.
 * Conversion nodes get centre only (or centre + top/bottom in Sankey view);
 * resizable objects get all six.
 */
export function getSourceAnchorsForNode(nodeId: string, sankeyMode?: boolean): string[] {
  if (
    nodeId.startsWith('postit-') ||
    nodeId.startsWith('container-') ||
    nodeId.startsWith('analysis-')
  ) {
    return RESIZABLE_DRAG_ANCHORS;
  }
  return sankeyMode ? NODE_DRAG_ANCHORS_SANKEY : NODE_DRAG_ANCHORS;
}

// ─── Geometry helpers ────────────────────────────────────────────────────────

function isInViewport(a: Box, b: Box): boolean {
  return a.x < b.x2 && a.x2 > b.x && a.y < b.y2 && a.y2 > b.y;
}

function overlapArea(a: Box, b: Box): number {
  const xOverlap = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x, b.x));
  const yOverlap = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y, b.y));
  return xOverlap * yOverlap;
}

function boxDistance(a: Box, b: Box): number {
  const dx = Math.max(0, Math.max(a.x - b.x2, b.x - a.x2));
  const dy = Math.max(0, Math.max(a.y - b.y2, b.y - a.y2));
  return Math.sqrt(dx * dx + dy * dy);
}

// ─── Node → Box conversion (v11-compatible) ─────────────────────────────────

/**
 * Build a Box from a ReactFlow v11 Node, using style dimensions (set by
 * resizable canvas objects) or measured dimensions, with sensible defaults.
 */
export function nodeToSnapBox(node: Node): Box {
  const styleW = (node.style as any)?.width;
  const styleH = (node.style as any)?.height;
  const w = (typeof styleW === 'number' ? styleW : undefined)
    ?? node.width
    ?? 110;
  const h = (typeof styleH === 'number' ? styleH : undefined)
    ?? node.height
    ?? 110;
  const x = node.positionAbsolute?.x ?? node.position.x;
  const y = node.positionAbsolute?.y ?? node.position.y;
  return { x, y, x2: x + w, y2: y + h };
}

// ─── Spatial Index ───────────────────────────────────────────────────────────

const HYSTERESIS_BUFFER = 0.5;

export class SpatialIndex {
  private xLines: HelperLine[] = [];
  private yLines: HelperLine[] = [];
  private lastHorizontalLine: HelperLine | undefined;
  private lastVerticalLine: HelperLine | undefined;

  initialize(helperLines: HelperLine[]): void {
    this.xLines = helperLines.filter(l => l.orientation === 'vertical');
    this.yLines = helperLines.filter(l => l.orientation === 'horizontal');
    this.xLines.sort((a, b) => a.position - b.position);
    this.yLines.sort((a, b) => a.position - b.position);
    this.lastHorizontalLine = undefined;
    this.lastVerticalLine = undefined;
  }

  search(
    orientation: Orientation,
    pos: number,
    node: Node,
    viewportBox: Box,
    dragBox?: Box,
  ): HelperLine | undefined {
    const lines = orientation === 'horizontal' ? this.yLines : this.xLines;
    const [viewportMin, viewportMax] =
      orientation === 'horizontal'
        ? [viewportBox.y, viewportBox.y2]
        : [viewportBox.x, viewportBox.x2];

    const candidates: CandidateLine[] = [];

    // Search range: union of viewport and the dragged anchor position,
    // expanded by SNAP_RADIUS. This ensures a dragged node whose anchor
    // extends beyond the viewport edge can still snap to nearby targets.
    const searchMin = Math.min(viewportMin, pos) - SNAP_RADIUS;
    const searchMax = Math.max(viewportMax, pos) + SNAP_RADIUS;

    // Use the drag box (proposed position) for distance ranking,
    // falling back to the node's committed position.
    const currentBox = dragBox ?? nodeToSnapBox(node);

    for (const line of lines) {
      if (line.position < searchMin) continue;
      if (line.position > searchMax) break;
      // Skip lines belonging to the dragged node itself
      if (line.node.id === node.id) continue;

      const lineDist = Math.abs(line.position - pos);
      if (lineDist > SNAP_RADIUS) continue;

      const overlap = overlapArea(line.nodeBox, currentBox);
      const nodeDist = overlap > 0 ? 0 : boxDistance(line.nodeBox, currentBox);
      candidates.push({ line, lineDist, nodeDist });
    }

    const lastLine =
      orientation === 'horizontal'
        ? this.lastHorizontalLine
        : this.lastVerticalLine;

    candidates.sort((a, b) => {
      if (lastLine) {
        if (a.line === lastLine && b.line !== lastLine) return -1;
        if (b.line === lastLine && a.line !== lastLine) return 1;
      }
      if (Math.abs(a.lineDist - b.lineDist) <= HYSTERESIS_BUFFER) {
        return a.nodeDist - b.nodeDist;
      }
      return a.lineDist - b.lineDist;
    });

    const bestLine = candidates.length > 0 ? candidates[0].line : undefined;

    if (bestLine) {
      if (orientation === 'horizontal') {
        this.lastHorizontalLine = bestLine;
      } else {
        this.lastVerticalLine = bestLine;
      }
    }

    return bestLine;
  }
}

// ─── Building helper lines ───────────────────────────────────────────────────

/**
 * Build HelperLine entries for every node × every anchor.
 * In v11 we work directly with Node objects (which have positionAbsolute set
 * after initialisation) instead of InternalNode.
 */
export function buildHelperLines(
  nodes: Node[],
  anchors: Record<string, Anchor> = ALL_ANCHORS,
): HelperLine[] {
  const helperLines: HelperLine[] = [];

  for (const node of nodes) {
    // Skip nodes without a position (not yet laid out)
    if (node.position == null) continue;

    const nodeBox = nodeToSnapBox(node);
    for (const [anchorName, anchor] of Object.entries(anchors)) {
      helperLines.push({
        nodeBox,
        node,
        orientation: anchor.orientation,
        position: anchor.resolve(node, nodeBox),
        color: (node.style as any)?.backgroundColor,
        anchorName,
      });
    }
  }

  return helperLines;
}

// ─── Finding best helper lines ───────────────────────────────────────────────

export function getHelperLines(
  spatialIndex: SpatialIndex,
  viewportBox: Box,
  node: Node,
  nodeBox: Box,
  validAnchors: string[] = Object.keys(ALL_ANCHORS),
): { horizontal: AnchorMatch | undefined; vertical: AnchorMatch | undefined } {
  const candidateAnchors: AnchorMatch[] = [];

  for (const anchorName of validAnchors) {
    const anchor = ALL_ANCHORS[anchorName];
    if (!anchor) continue;
    const pos = anchor.resolve(node, nodeBox);
    const line = spatialIndex.search(anchor.orientation, pos, node, viewportBox, nodeBox);
    if (line) {
      candidateAnchors.push({ anchorName, sourcePosition: pos, anchor, line });
    }
  }

  const result: {
    horizontal: AnchorMatch | undefined;
    vertical: AnchorMatch | undefined;
  } = { horizontal: undefined, vertical: undefined };

  for (const match of candidateAnchors) {
    const current = result[match.anchor.orientation];
    const dist = Math.abs(match.sourcePosition - match.line.position);
    if (!current || dist < Math.abs(current.sourcePosition - current.line.position)) {
      result[match.anchor.orientation] = match;
    }
  }

  return result;
}

// ─── Snapping position changes ───────────────────────────────────────────────

/**
 * Mutate a position change to snap the node to the matched helper lines.
 * Returns which axes were snapped.
 */
export function snapPositionToHelperLines(
  node: Node,
  positionChange: NodePositionChange,
  hMatch?: AnchorMatch,
  vMatch?: AnchorMatch,
): { snappedX: boolean; snappedY: boolean } {
  if (!positionChange.position) {
    return { snappedX: false, snappedY: false };
  }

  let snappedX = false;
  let snappedY = false;

  const w = (node.style as any)?.width ?? node.width ?? 110;
  const h = (node.style as any)?.height ?? node.height ?? 110;

  const positionBounds: Box = {
    x: positionChange.position.x,
    y: positionChange.position.y,
    x2: positionChange.position.x + w,
    y2: positionChange.position.y + h,
  };

  // Y axis (horizontal helper line)
  if (hMatch) {
    const anchorPosY = hMatch.anchor.resolve(node, positionBounds);
    const deltaY = anchorPosY - hMatch.line.position;
    if (Math.abs(deltaY) <= SNAP_RADIUS) {
      positionChange.position.y -= deltaY;
      snappedY = true;
    }
  }

  // X axis (vertical helper line)
  if (vMatch) {
    const anchorPosX = vMatch.anchor.resolve(node, positionBounds);
    const deltaX = anchorPosX - vMatch.line.position;
    if (Math.abs(deltaX) <= SNAP_RADIUS) {
      positionChange.position.x -= deltaX;
      snappedX = true;
    }
  }

  return { snappedX, snappedY };
}

// ─── Resize change types (v11 node-resizer) ──────────────────────────────────

interface DimensionChange {
  id: string;
  type: 'dimensions';
  resizing?: boolean;
  updateStyle?: boolean;
  dimensions?: { width: number; height: number };
}

/**
 * Snap resize operations. Detects which edges are moving based on whether
 * a position change accompanies the dimension change (left/top resize)
 * and snaps the moving edges to nearby guide lines.
 *
 * Mutates the dimension and position changes in place.
 */
export function snapResizeToHelperLines(
  node: Node,
  dimChange: DimensionChange,
  posChange: NodePositionChange | undefined,
  spatialIndex: SpatialIndex,
  viewportBox: Box,
): { snappedX: boolean; snappedY: boolean; hLine?: HelperLine; vLine?: HelperLine } {
  if (!dimChange.dimensions) {
    return { snappedX: false, snappedY: false };
  }

  const nodePos = posChange?.position ?? node.position;
  const newW = dimChange.dimensions.width;
  const newH = dimChange.dimensions.height;

  // Build the proposed box
  const proposedBox: Box = {
    x: nodePos.x,
    y: nodePos.y,
    x2: nodePos.x + newW,
    y2: nodePos.y + newH,
  };

  // Determine which edges are moving during this resize.
  // If there's a position change, left/top are moving (resize from left/top edge).
  // The opposite edges (right/bottom) move when position stays fixed.
  const oldW = (node.style as any)?.width ?? node.width ?? 110;
  const oldH = (node.style as any)?.height ?? node.height ?? 110;
  const oldX = node.position.x;
  const oldY = node.position.y;

  const leftMoving = posChange?.position ? posChange.position.x !== oldX : false;
  const topMoving = posChange?.position ? posChange.position.y !== oldY : false;
  const rightMoving = newW !== oldW && !leftMoving;
  const bottomMoving = newH !== oldH && !topMoving;

  // Build anchor list for snapping — only snap moving edges
  const resizeAnchors: string[] = [];
  if (leftMoving) resizeAnchors.push('left');
  if (rightMoving) resizeAnchors.push('right');
  if (topMoving) resizeAnchors.push('top');
  if (bottomMoving) resizeAnchors.push('bottom');

  if (resizeAnchors.length === 0) {
    return { snappedX: false, snappedY: false };
  }

  // Query spatial index for matches on the moving edges
  const { horizontal: hMatch, vertical: vMatch } = getHelperLines(
    spatialIndex,
    viewportBox,
    node,
    proposedBox,
    resizeAnchors,
  );

  let snappedX = false;
  let snappedY = false;
  let hLine: HelperLine | undefined;
  let vLine: HelperLine | undefined;

  // Snap vertical (X axis) — either left or right edge
  if (vMatch) {
    const anchorPos = vMatch.anchor.resolve(node, proposedBox);
    const delta = anchorPos - vMatch.line.position;
    if (Math.abs(delta) <= SNAP_RADIUS) {
      if (vMatch.anchorName === 'left' && posChange?.position) {
        // Moving left edge: adjust position and width
        posChange.position.x -= delta;
        dimChange.dimensions.width += delta;
      } else if (vMatch.anchorName === 'right') {
        // Moving right edge: adjust width only
        dimChange.dimensions.width -= delta;
      }
      snappedX = true;
      vLine = vMatch.line;
    }
  }

  // Snap horizontal (Y axis) — either top or bottom edge
  if (hMatch) {
    const anchorPos = hMatch.anchor.resolve(node, proposedBox);
    const delta = anchorPos - hMatch.line.position;
    if (Math.abs(delta) <= SNAP_RADIUS) {
      if (hMatch.anchorName === 'top' && posChange?.position) {
        // Moving top edge: adjust position and height
        posChange.position.y -= delta;
        dimChange.dimensions.height += delta;
      } else if (hMatch.anchorName === 'bottom') {
        // Moving bottom edge: adjust height only
        dimChange.dimensions.height -= delta;
      }
      snappedY = true;
      hLine = hMatch.line;
    }
  }

  return { snappedX, snappedY, hLine, vLine };
}

// ─── Last snapped resize memory ──────────────────────────────────────────────
//
// During resize, d3-drag owns the DOM and doesn't know about snap adjustments.
// On release, onResizeEnd receives d3-drag's unsnapped params. This memory
// lets resize-end callbacks use the last snapped dimensions instead.
// A module-level variable is appropriate: only one resize can happen at a time.

interface SnappedResizeState {
  nodeId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

let _lastSnappedResize: SnappedResizeState | null = null;

export function setLastSnappedResize(state: SnappedResizeState): void {
  if (import.meta.env.DEV) {
    console.log('[snap] setLastSnappedResize:', state);
  }
  _lastSnappedResize = state;
}

export function getLastSnappedResize(): SnappedResizeState | null {
  return _lastSnappedResize;
}

export function clearLastSnappedResize(): void {
  if (import.meta.env.DEV && _lastSnappedResize) {
    console.log('[snap] clearLastSnappedResize');
  }
  _lastSnappedResize = null;
}
