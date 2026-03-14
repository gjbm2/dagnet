/**
 * Alignment & Distribution Service
 *
 * Pure geometry functions for aligning and distributing canvas objects.
 * No side effects, no state — accepts rects, returns position updates.
 *
 * Follows Figma conventions:
 *   - Alignment is relative to the selection bounding box
 *   - Distribution preserves outermost objects and equalises gaps
 *   - Align requires 2+, distribute requires 3+
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NodeRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PositionUpdate {
  id: string;
  position: { x: number; y: number };
}

export interface SizeUpdate {
  id: string;
  size: { width: number; height: number };
}

export type AlignCommand =
  | 'align-left'
  | 'align-right'
  | 'align-top'
  | 'align-bottom'
  | 'align-centre-horizontal'
  | 'align-centre-vertical';

export type DistributeCommand =
  | 'distribute-horizontal'
  | 'distribute-vertical';

export type EqualSizeCommand =
  | 'equal-width'
  | 'equal-height';

// ---------------------------------------------------------------------------
// Alignment
// ---------------------------------------------------------------------------

/**
 * Compute new positions for alignment.
 * Returns only nodes that actually move.
 */
export function computeAlignment(
  nodes: NodeRect[],
  command: AlignCommand,
): PositionUpdate[] {
  if (nodes.length < 2) return [];

  const updates: PositionUpdate[] = [];

  switch (command) {
    case 'align-left': {
      const target = Math.min(...nodes.map(n => n.x));
      for (const n of nodes) {
        if (n.x !== target) {
          updates.push({ id: n.id, position: { x: target, y: n.y } });
        }
      }
      break;
    }

    case 'align-right': {
      const target = Math.max(...nodes.map(n => n.x + n.width));
      for (const n of nodes) {
        const newX = target - n.width;
        if (n.x !== newX) {
          updates.push({ id: n.id, position: { x: newX, y: n.y } });
        }
      }
      break;
    }

    case 'align-top': {
      const target = Math.min(...nodes.map(n => n.y));
      for (const n of nodes) {
        if (n.y !== target) {
          updates.push({ id: n.id, position: { x: n.x, y: target } });
        }
      }
      break;
    }

    case 'align-bottom': {
      const target = Math.max(...nodes.map(n => n.y + n.height));
      for (const n of nodes) {
        const newY = target - n.height;
        if (n.y !== newY) {
          updates.push({ id: n.id, position: { x: n.x, y: newY } });
        }
      }
      break;
    }

    case 'align-centre-horizontal': {
      const minX = Math.min(...nodes.map(n => n.x));
      const maxX = Math.max(...nodes.map(n => n.x + n.width));
      const centreX = (minX + maxX) / 2;
      for (const n of nodes) {
        const newX = centreX - n.width / 2;
        if (n.x !== newX) {
          updates.push({ id: n.id, position: { x: newX, y: n.y } });
        }
      }
      break;
    }

    case 'align-centre-vertical': {
      const minY = Math.min(...nodes.map(n => n.y));
      const maxY = Math.max(...nodes.map(n => n.y + n.height));
      const centreY = (minY + maxY) / 2;
      for (const n of nodes) {
        const newY = centreY - n.height / 2;
        if (n.y !== newY) {
          updates.push({ id: n.id, position: { x: n.x, y: newY } });
        }
      }
      break;
    }
  }

  return updates;
}

// ---------------------------------------------------------------------------
// Distribution
// ---------------------------------------------------------------------------

/**
 * Compute new positions for even distribution.
 * Returns only nodes that actually move.
 */
export function computeDistribution(
  nodes: NodeRect[],
  command: DistributeCommand,
): PositionUpdate[] {
  if (nodes.length < 3) return [];

  const updates: PositionUpdate[] = [];

  if (command === 'distribute-horizontal') {
    // Sort by left edge
    const sorted = [...nodes].sort((a, b) => a.x - b.x);

    const totalNodeWidth = sorted.reduce((sum, n) => sum + n.width, 0);
    const spanStart = sorted[0].x;
    const spanEnd = sorted[sorted.length - 1].x + sorted[sorted.length - 1].width;
    const totalGap = (spanEnd - spanStart) - totalNodeWidth;
    const gapSize = totalGap / (sorted.length - 1);

    let cursor = spanStart;
    for (let i = 0; i < sorted.length; i++) {
      const n = sorted[i];
      const newX = i === 0 ? n.x : cursor; // first stays put
      if (i === sorted.length - 1) break;   // last stays put
      if (i > 0 && n.x !== newX) {
        updates.push({ id: n.id, position: { x: newX, y: n.y } });
      }
      cursor = (i === 0 ? n.x : newX) + n.width + gapSize;
    }
  } else {
    // distribute-vertical — sort by top edge
    const sorted = [...nodes].sort((a, b) => a.y - b.y);

    const totalNodeHeight = sorted.reduce((sum, n) => sum + n.height, 0);
    const spanStart = sorted[0].y;
    const spanEnd = sorted[sorted.length - 1].y + sorted[sorted.length - 1].height;
    const totalGap = (spanEnd - spanStart) - totalNodeHeight;
    const gapSize = totalGap / (sorted.length - 1);

    let cursor = spanStart;
    for (let i = 0; i < sorted.length; i++) {
      const n = sorted[i];
      const newY = i === 0 ? n.y : cursor;
      if (i === sorted.length - 1) break;
      if (i > 0 && n.y !== newY) {
        updates.push({ id: n.id, position: { x: n.x, y: newY } });
      }
      cursor = (i === 0 ? n.y : newY) + n.height + gapSize;
    }
  }

  return updates;
}

// ---------------------------------------------------------------------------
// Equal Size
// ---------------------------------------------------------------------------

/**
 * Compute new sizes to make all selected objects the same width or height.
 * Target is the average of the selected objects.
 * Top-left position stays fixed; size changes rightward/downward.
 * Returns only nodes that actually change.
 */
export function computeEqualSize(
  nodes: NodeRect[],
  command: EqualSizeCommand,
): SizeUpdate[] {
  if (nodes.length < 2) return [];

  const updates: SizeUpdate[] = [];

  if (command === 'equal-width') {
    const avg = Math.round(nodes.reduce((sum, n) => sum + n.width, 0) / nodes.length);
    for (const n of nodes) {
      if (n.width !== avg) {
        updates.push({ id: n.id, size: { width: avg, height: n.height } });
      }
    }
  } else {
    const avg = Math.round(nodes.reduce((sum, n) => sum + n.height, 0) / nodes.length);
    for (const n of nodes) {
      if (n.height !== avg) {
        updates.push({ id: n.id, size: { width: n.width, height: avg } });
      }
    }
  }

  return updates;
}

// ---------------------------------------------------------------------------
// Helpers for extracting NodeRect from ReactFlow nodes
// ---------------------------------------------------------------------------

/**
 * Extract a NodeRect from a ReactFlow node.
 * Uses style.width/height (set by canvas objects) or measured dimensions,
 * falling back to defaults.
 */
export function toNodeRect(
  node: { id: string; position: { x: number; y: number }; style?: any; measured?: any },
  defaultWidth = 110,
  defaultHeight = 110,
): NodeRect {
  const styleW = node.style?.width;
  const styleH = node.style?.height;
  const measW = node.measured?.width;
  const measH = node.measured?.height;
  const width = (typeof styleW === 'number' ? styleW : undefined)
    ?? (typeof measW === 'number' ? measW : undefined)
    ?? defaultWidth;
  const height = (typeof styleH === 'number' ? styleH : undefined)
    ?? (typeof measH === 'number' ? measH : undefined)
    ?? defaultHeight;
  return {
    id: node.id,
    x: node.position.x,
    y: node.position.y,
    width,
    height,
  };
}
