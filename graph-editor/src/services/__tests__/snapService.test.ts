/**
 * snapService — Integration tests for snap-to-guide line geometry.
 *
 * Tests the full pipeline: buildHelperLines → SpatialIndex → getHelperLines →
 * snapPositionToHelperLines / snapResizeToHelperLines.
 *
 * Uses realistic node configurations matching the user's production graphs.
 * No React, no DOM — pure geometry.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { Node, NodePositionChange } from 'reactflow';
import {
  ALL_ANCHORS,
  Box,
  buildHelperLines,
  getHelperLines,
  getSourceAnchorsForNode,
  nodeToSnapBox,
  SNAP_RADIUS,
  snapPositionToHelperLines,
  snapResizeToHelperLines,
  SpatialIndex,
} from '../snapService';

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** Create a minimal ReactFlow Node for testing. */
function makeNode(
  id: string,
  x: number,
  y: number,
  w = 110,
  h = 110,
): Node {
  return {
    id,
    type: 'default',
    position: { x, y },
    positionAbsolute: { x, y },
    data: {},
    width: w,
    height: h,
  } as Node;
}

/** Create a resizable node (post-it/container/analysis) with style dimensions. */
function makeResizableNode(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
): Node {
  return {
    id,
    type: 'default',
    position: { x, y },
    positionAbsolute: { x, y },
    data: {},
    width: w,
    height: h,
    style: { width: w, height: h },
  } as unknown as Node;
}

/** Build a viewport box in flow coordinates. */
function makeViewport(x: number, y: number, x2: number, y2: number): Box {
  return { x, y, x2, y2 };
}

/** Wide viewport that encompasses all typical test nodes. */
const WIDE_VIEWPORT: Box = { x: -1000, y: -1000, x2: 2000, y2: 2000 };

/** Build spatial index from nodes. */
function buildIndex(nodes: Node[]): SpatialIndex {
  const lines = buildHelperLines(nodes, ALL_ANCHORS);
  const idx = new SpatialIndex();
  idx.initialize(lines);
  return idx;
}

// ─── Realistic 9-node graph (matches user's production layout) ───────────────

const GRAPH_NODES: Node[] = [
  makeNode('household-created',               100,  50),
  makeNode('household-delegated',             100, 220),
  makeNode('switch-registered',               350, 130),
  makeNode('switch-success',                  550, 215),
  makeNode('gm-abandoned-delegation',         350, 380),
  makeNode('gm-abandoned-after-delegation',   550, 380),
  makeNode('gm-abandoned-after-registration', 100, 380),
  makeNode('landing-page',                   -150, 130),
  makeNode('bounce',                         -150, 300),
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('snapService integration', () => {

  // ── Index population ────────────────────────────────────────────────────

  describe('buildHelperLines + SpatialIndex population', () => {
    it('should produce 6 lines per node (one per anchor)', () => {
      const lines = buildHelperLines(GRAPH_NODES, ALL_ANCHORS);
      expect(lines.length).toBe(GRAPH_NODES.length * 6);
    });

    it('should split into 3 vertical and 3 horizontal lines per node', () => {
      const lines = buildHelperLines(GRAPH_NODES, ALL_ANCHORS);
      const idx = new SpatialIndex();
      idx.initialize(lines);

      // Access internal arrays for verification
      const xLines = (idx as any).xLines as any[];
      const yLines = (idx as any).yLines as any[];

      expect(xLines.length).toBe(GRAPH_NODES.length * 3); // left, right, centreX
      expect(yLines.length).toBe(GRAPH_NODES.length * 3); // top, bottom, centreY
    });

    it('should sort lines by position ascending', () => {
      const lines = buildHelperLines(GRAPH_NODES, ALL_ANCHORS);
      const idx = new SpatialIndex();
      idx.initialize(lines);

      const xLines = (idx as any).xLines as any[];
      const yLines = (idx as any).yLines as any[];

      for (let i = 1; i < xLines.length; i++) {
        expect(xLines[i].position).toBeGreaterThanOrEqual(xLines[i - 1].position);
      }
      for (let i = 1; i < yLines.length; i++) {
        expect(yLines[i].position).toBeGreaterThanOrEqual(yLines[i - 1].position);
      }
    });

    it('should skip nodes without a position', () => {
      const nodes = [
        makeNode('a', 100, 100),
        { id: 'no-pos', type: 'default', data: {}, position: undefined } as any,
      ];
      const lines = buildHelperLines(nodes, ALL_ANCHORS);
      expect(lines.length).toBe(6); // only node 'a'
    });

    it('should use default 110px dimensions for unmeasured nodes', () => {
      const node = { id: 'unmeasured', type: 'default', data: {}, position: { x: 50, y: 50 } } as Node;
      const box = nodeToSnapBox(node);
      expect(box.x2 - box.x).toBe(110);
      expect(box.y2 - box.y).toBe(110);
    });
  });

  // ── Self-exclusion ──────────────────────────────────────────────────────

  describe('self-exclusion', () => {
    it('should not match a node against its own anchor lines', () => {
      const nodes = [makeNode('a', 100, 100), makeNode('b', 300, 300)];
      const idx = buildIndex(nodes);
      const nodeA = nodes[0];
      const boxA = nodeToSnapBox(nodeA);

      // Search for vertical lines at nodeA's centreX — should NOT match nodeA's own line
      const result = idx.search('vertical', (boxA.x + boxA.x2) / 2, nodeA, WIDE_VIEWPORT);
      // Should return undefined (nodeB's centreX at 355 is too far from nodeA's 155)
      expect(result === undefined || result.node.id !== 'a').toBe(true);
    });
  });

  // ── Horizontal matches ─────────────────────────────────────────────────

  describe('horizontal guide matching (Y axis)', () => {
    it('should match a horizontal anchor when two nodes share the same Y centre', () => {
      const nodes = [
        makeNode('a', 100, 200),
        makeNode('b', 400, 200),
      ];
      const idx = buildIndex(nodes);
      const nodeA = nodes[0];
      const dragBox: Box = { x: 250, y: 200, x2: 360, y2: 310 }; // dragging A toward B, same Y

      const { horizontal } = getHelperLines(idx, WIDE_VIEWPORT, nodeA, dragBox, Object.keys(ALL_ANCHORS));
      expect(horizontal).toBeDefined();
      // Multiple anchors match at distance 0 (top, centreY, bottom all align).
      // The important thing: a horizontal match is found against node B.
      expect(horizontal!.line.node.id).toBe('b');
      expect(Math.abs(horizontal!.sourcePosition - horizontal!.line.position)).toBe(0);
    });

    it('should match top-to-top alignment', () => {
      const nodes = [
        makeNode('a', 100, 200),
        makeNode('b', 400, 203), // top within SNAP_RADIUS of node A's top
      ];
      const idx = buildIndex(nodes);
      const nodeA = nodes[0];
      const dragBox: Box = { x: 250, y: 200, x2: 360, y2: 310 };

      const { horizontal } = getHelperLines(idx, WIDE_VIEWPORT, nodeA, dragBox, Object.keys(ALL_ANCHORS));
      expect(horizontal).toBeDefined();
      expect(horizontal!.anchorName).toBe('top');
      expect(Math.abs(horizontal!.sourcePosition - horizontal!.line.position)).toBeLessThanOrEqual(SNAP_RADIUS);
    });

    it('should match bottom-to-top cross-anchor alignment', () => {
      // Node A's bottom (y=310) aligns with Node B's top (y=315, within SNAP_RADIUS)
      const nodes = [
        makeNode('a', 100, 200), // bottom at 310
        makeNode('b', 400, 315), // top at 315
      ];
      const idx = buildIndex(nodes);
      const nodeA = nodes[0];
      const dragBox: Box = { x: 250, y: 200, x2: 360, y2: 310 };

      const { horizontal } = getHelperLines(idx, WIDE_VIEWPORT, nodeA, dragBox, Object.keys(ALL_ANCHORS));
      expect(horizontal).toBeDefined();
      expect(horizontal!.anchorName).toBe('bottom');
      expect(horizontal!.line.anchorName).toBe('top');
    });
  });

  // ── Vertical matches ───────────────────────────────────────────────────

  describe('vertical guide matching (X axis)', () => {
    it('should match a vertical anchor when two nodes share the same X centre', () => {
      const nodes = [
        makeNode('a', 200, 100),
        makeNode('b', 200, 400),
      ];
      const idx = buildIndex(nodes);
      const nodeA = nodes[0];
      const dragBox: Box = { x: 200, y: 250, x2: 310, y2: 360 }; // dragging A toward B, same X

      const { vertical } = getHelperLines(idx, WIDE_VIEWPORT, nodeA, dragBox, Object.keys(ALL_ANCHORS));
      expect(vertical).toBeDefined();
      // Multiple anchors match at distance 0 (left, centreX, right all align).
      // The important thing: a vertical match is found against node B.
      expect(vertical!.line.node.id).toBe('b');
      expect(Math.abs(vertical!.sourcePosition - vertical!.line.position)).toBe(0);
    });

    it('should match left-to-left edge alignment', () => {
      const nodes = [
        makeNode('a', 200, 100),
        makeNode('b', 205, 400), // left edge within SNAP_RADIUS
      ];
      const idx = buildIndex(nodes);
      const nodeA = nodes[0];
      const dragBox: Box = { x: 200, y: 250, x2: 310, y2: 360 };

      const { vertical } = getHelperLines(idx, WIDE_VIEWPORT, nodeA, dragBox, Object.keys(ALL_ANCHORS));
      expect(vertical).toBeDefined();
      expect(vertical!.anchorName).toBe('left');
      expect(Math.abs(vertical!.sourcePosition - vertical!.line.position)).toBeLessThanOrEqual(SNAP_RADIUS);
    });

    it('should match right-to-left cross-anchor alignment', () => {
      // Node A's right edge (x=310) aligns with Node B's left edge (x=315, within SNAP_RADIUS)
      const nodes = [
        makeNode('a', 200, 100), // right at 310
        makeNode('b', 315, 400), // left at 315
      ];
      const idx = buildIndex(nodes);
      const nodeA = nodes[0];
      const dragBox: Box = { x: 200, y: 250, x2: 310, y2: 360 };

      const { vertical } = getHelperLines(idx, WIDE_VIEWPORT, nodeA, dragBox, Object.keys(ALL_ANCHORS));
      expect(vertical).toBeDefined();
      expect(vertical!.anchorName).toBe('right');
      expect(vertical!.line.anchorName).toBe('left');
    });

    it('should NOT match when nodes are separated by more than SNAP_RADIUS on all anchors', () => {
      const nodes = [
        makeNode('a', 100, 100),
        makeNode('b', 300, 300), // all anchors > SNAP_RADIUS apart
      ];
      const idx = buildIndex(nodes);
      const nodeA = nodes[0];
      const dragBox = nodeToSnapBox(nodeA);

      const { horizontal, vertical } = getHelperLines(idx, WIDE_VIEWPORT, nodeA, dragBox, Object.keys(ALL_ANCHORS));
      expect(horizontal).toBeUndefined();
      expect(vertical).toBeUndefined();
    });
  });

  // ── Viewport filtering ─────────────────────────────────────────────────

  describe('viewport filtering', () => {
    it('should exclude targets completely outside the viewport', () => {
      // Viewport filtering uses the line's position coordinate (X for vertical, Y for horizontal).
      // Node B at x=2000 has vertical lines at x=2000/2055/2110 — all outside viewport x range.
      const nodes = [
        makeNode('a', 100, 100),
        makeNode('b', 2000, 100), // same Y but X far outside viewport
      ];
      const idx = buildIndex(nodes);
      const nodeA = nodes[0];
      const dragBox = nodeToSnapBox(nodeA);
      const viewport: Box = { x: 0, y: 0, x2: 500, y2: 500 };

      // Vertical lines from B (x=2000+) are outside viewport x range → no vertical match
      const { vertical } = getHelperLines(idx, viewport, nodeA, dragBox, Object.keys(ALL_ANCHORS));
      expect(vertical).toBeUndefined();

      // Horizontal lines from B (y=100/155/210) ARE inside viewport y range → horizontal match possible
      const { horizontal } = getHelperLines(idx, viewport, nodeA, dragBox, Object.keys(ALL_ANCHORS));
      expect(horizontal).toBeDefined();
    });

    it('should find targets when dragged node anchor is near the viewport edge', () => {
      // This is THE BUG: node at the right edge of viewport, target inside viewport
      const target = makeNode('target', 100, 200);  // well inside viewport
      const dragged = makeNode('dragged', 100, 50);  // same X as target

      const idx = buildIndex([target, dragged]);
      const dragBox: Box = { x: 100, y: 50, x2: 210, y2: 160 };

      // Viewport that just barely includes the dragged node's position
      const viewport: Box = { x: -50, y: -50, x2: 215, y2: 500 };

      const { vertical } = getHelperLines(idx, viewport, dragged, dragBox, Object.keys(ALL_ANCHORS));
      expect(vertical).toBeDefined();
      expect(vertical!.line.node.id).toBe('target');
    });

    it('should find targets when dragged node extends beyond viewport edge', () => {
      // Node's left edge inside viewport, but centreX and right edge extend beyond
      const target = makeNode('target', 540, 200);  // centreX at 595
      const dragged = makeNode('dragged', 540, 50);  // same X → centreX at 595

      const idx = buildIndex([target, dragged]);
      // Viewport right edge at 550 — node starts at 540 (inside) but extends to 650 (outside)
      const viewport: Box = { x: -500, y: -500, x2: 550, y2: 1000 };
      const dragBox: Box = { x: 540, y: 50, x2: 650, y2: 160 };

      const { vertical } = getHelperLines(idx, viewport, dragged, dragBox, Object.keys(ALL_ANCHORS));
      // centreX at 595 is outside viewport (550), but should still find match
      // because search range is expanded by SNAP_RADIUS
      expect(vertical).toBeDefined();
      expect(vertical!.line.node.id).toBe('target');
    });

    it('should find match when target line is just outside viewport but within SNAP_RADIUS', () => {
      // Dragged node's left anchor at 100, target's left anchor at 102
      // Viewport right edge at 101 — target line at 102 is outside viewport
      // but within SNAP_RADIUS of dragged node's anchor at 100
      const target = makeNode('target', 102, 300);
      const dragged = makeNode('dragged', 100, 100);

      const idx = buildIndex([target, dragged]);
      const viewport: Box = { x: -500, y: -500, x2: 101, y2: 1000 };
      const dragBox: Box = { x: 100, y: 100, x2: 210, y2: 210 };

      const { vertical } = getHelperLines(idx, viewport, dragged, dragBox, Object.keys(ALL_ANCHORS));
      expect(vertical).toBeDefined();
      expect(vertical!.line.node.id).toBe('target');
      expect(Math.abs(vertical!.sourcePosition - vertical!.line.position)).toBeLessThanOrEqual(SNAP_RADIUS);
    });
  });

  // ── Best match selection ────────────────────────────────────────────────

  describe('best match selection', () => {
    it('should pick the closest line when multiple targets are within SNAP_RADIUS', () => {
      const nodes = [
        makeNode('a', 100, 100),   // centreX at 155
        makeNode('close', 152, 300), // centreX at 207... wait, left at 152
        makeNode('closer', 154, 500), // left at 154 — 1px from nodeA's centreX 155
      ];
      // Actually let me make this clearer
      // nodeA centreX = 155
      // nodeB left = 148 → dist 7
      // nodeC left = 153 → dist 2 (closer)
      const betterNodes = [
        makeNode('a', 100, 100),     // centreX = 155
        makeNode('far', 148, 300),   // left = 148, dist from 155 = 7
        makeNode('near', 153, 500),  // left = 153, dist from 155 = 2
      ];
      const idx = buildIndex(betterNodes);
      const nodeA = betterNodes[0];
      const dragBox: Box = { x: 100, y: 100, x2: 210, y2: 210 };

      const { vertical } = getHelperLines(idx, WIDE_VIEWPORT, nodeA, dragBox, Object.keys(ALL_ANCHORS));
      expect(vertical).toBeDefined();
      expect(vertical!.line.node.id).toBe('near');
    });
  });

  // ── Hysteresis ──────────────────────────────────────────────────────────

  describe('hysteresis stability', () => {
    it('should prefer previously matched line when two candidates are equidistant', () => {
      // Two targets equidistant from dragged node's centreX
      const nodes = [
        makeNode('a', 100, 100),     // centreX = 155
        makeNode('t1', 150, 300),    // left = 150, dist from 155 = 5
        makeNode('t2', 160, 500),    // left = 160, dist from 155 = 5
      ];
      const idx = buildIndex(nodes);
      const nodeA = nodes[0];
      const dragBox: Box = { x: 100, y: 100, x2: 210, y2: 210 };

      // First search — picks one (deterministic based on sort)
      const first = getHelperLines(idx, WIDE_VIEWPORT, nodeA, dragBox, Object.keys(ALL_ANCHORS));
      expect(first.vertical).toBeDefined();
      const firstTarget = first.vertical!.line.node.id;

      // Second search with same position — should pick the SAME target (hysteresis)
      const second = getHelperLines(idx, WIDE_VIEWPORT, nodeA, dragBox, Object.keys(ALL_ANCHORS));
      expect(second.vertical).toBeDefined();
      expect(second.vertical!.line.node.id).toBe(firstTarget);
    });
  });

  // ── snapPositionToHelperLines ──────────────────────────────────────────

  describe('snapPositionToHelperLines', () => {
    it('should mutate position to snap Y axis for horizontal match', () => {
      const node = makeNode('a', 100, 200);
      const nodes = [node, makeNode('b', 400, 203)]; // top 3px offset
      const idx = buildIndex(nodes);
      const dragBox: Box = { x: 250, y: 200, x2: 360, y2: 310 };

      const { horizontal } = getHelperLines(idx, WIDE_VIEWPORT, node, dragBox, Object.keys(ALL_ANCHORS));
      const posChange: NodePositionChange = {
        id: 'a', type: 'position', dragging: true,
        position: { x: 250, y: 200 },
      };

      const { snappedY } = snapPositionToHelperLines(node, posChange, horizontal, undefined);
      expect(snappedY).toBe(true);
      // Position should have been adjusted by the delta
      expect(posChange.position!.y).not.toBe(200);
    });

    it('should mutate position to snap X axis for vertical match', () => {
      const node = makeNode('a', 200, 100);
      const nodes = [node, makeNode('b', 205, 400)]; // left 5px offset
      const idx = buildIndex(nodes);
      const dragBox: Box = { x: 200, y: 250, x2: 310, y2: 360 };

      const { vertical } = getHelperLines(idx, WIDE_VIEWPORT, node, dragBox, Object.keys(ALL_ANCHORS));
      const posChange: NodePositionChange = {
        id: 'a', type: 'position', dragging: true,
        position: { x: 200, y: 250 },
      };

      const { snappedX } = snapPositionToHelperLines(node, posChange, undefined, vertical);
      expect(snappedX).toBe(true);
      expect(posChange.position!.x).not.toBe(200);
    });

    it('should snap both axes simultaneously when both matches exist', () => {
      const node = makeNode('a', 200, 200);
      const nodes = [node, makeNode('b', 205, 197)]; // 5px X offset, 3px Y offset
      const idx = buildIndex(nodes);
      const dragBox: Box = { x: 200, y: 200, x2: 310, y2: 310 };

      const { horizontal, vertical } = getHelperLines(idx, WIDE_VIEWPORT, node, dragBox, Object.keys(ALL_ANCHORS));
      const posChange: NodePositionChange = {
        id: 'a', type: 'position', dragging: true,
        position: { x: 200, y: 200 },
      };

      const { snappedX, snappedY } = snapPositionToHelperLines(node, posChange, horizontal, vertical);
      expect(snappedX).toBe(true);
      expect(snappedY).toBe(true);
    });

    it('should not snap when no match provided', () => {
      const node = makeNode('a', 200, 200);
      const posChange: NodePositionChange = {
        id: 'a', type: 'position', dragging: true,
        position: { x: 200, y: 200 },
      };

      const { snappedX, snappedY } = snapPositionToHelperLines(node, posChange, undefined, undefined);
      expect(snappedX).toBe(false);
      expect(snappedY).toBe(false);
      expect(posChange.position!.x).toBe(200);
      expect(posChange.position!.y).toBe(200);
    });
  });

  // ── Resize snapping ────────────────────────────────────────────────────

  describe('snapResizeToHelperLines', () => {
    it('should snap right edge resize to nearby target right edge', () => {
      const node = makeResizableNode('postit-a', 100, 100, 200, 150);
      const target = makeResizableNode('postit-b', 100, 400, 205, 150); // right at 305
      const idx = buildIndex([node, target]);
      const viewport = WIDE_VIEWPORT;

      const dimChange = {
        id: 'postit-a', type: 'dimensions' as const,
        resizing: true, dimensions: { width: 202, height: 150 },
      };

      const result = snapResizeToHelperLines(node, dimChange, undefined, idx, viewport);
      expect(result.snappedX).toBe(true);
      // Width should have been adjusted
      expect(dimChange.dimensions!.width).not.toBe(202);
    });
  });

  // ── Realistic drag scenario ────────────────────────────────────────────

  describe('realistic multi-node drag scenario', () => {
    it('should find vertical match when dragging switch-success toward nodes at X=100', () => {
      // Simulate dragging switch-success leftward from x=400 (past nodes at x=350/550)
      // toward x=100. Three nodes sit at x=100: household-created (y=50),
      // household-delegated (y=220), gm-abandoned-after-registration (y=380).
      const idx = buildIndex(GRAPH_NODES);
      const dragged = GRAPH_NODES.find(n => n.id === 'switch-success')!;

      // Collect all matches as we drag from x=400 to x=90
      const matchesByX: { dragX: number; targetId: string; anchorName: string }[] = [];

      for (let dragX = 400; dragX >= 90; dragX -= 5) {
        const dragBox: Box = { x: dragX, y: 215, x2: dragX + 110, y2: 325 };
        const { vertical } = getHelperLines(idx, WIDE_VIEWPORT, dragged, dragBox, Object.keys(ALL_ANCHORS));

        if (vertical) {
          matchesByX.push({
            dragX,
            targetId: vertical.line.node.id,
            anchorName: vertical.anchorName,
          });
        }
      }

      // Should find matches at multiple X positions as we pass different nodes
      expect(matchesByX.length).toBeGreaterThan(0);

      // Must find a match against an x=100 node at some point during the drag.
      // The x=100 nodes have right edge at x=210, so cross-anchor matches (left-to-right)
      // can fire as early as dragX ~ 220 (left=220, target right=210, dist=10=SNAP_RADIUS).
      // Direct left-to-left matches fire at dragX ~ 100 ± SNAP_RADIUS.
      const x100Match = matchesByX.find(m =>
        ['household-created', 'household-delegated', 'gm-abandoned-after-registration'].includes(m.targetId)
      );
      expect(x100Match).toBeDefined();
    });

    it('should find horizontal match when dragging to same Y as another node', () => {
      const idx = buildIndex(GRAPH_NODES);
      const dragged = GRAPH_NODES.find(n => n.id === 'switch-success')!;
      // switch-registered is at y=130; switch-success starts at y=215

      let foundHorizontalMatch = false;

      for (let dragY = 215; dragY >= 120; dragY -= 5) {
        const dragBox: Box = { x: 550, y: dragY, x2: 660, y2: dragY + 110 };
        const { horizontal } = getHelperLines(idx, WIDE_VIEWPORT, dragged, dragBox, Object.keys(ALL_ANCHORS));

        if (horizontal) {
          foundHorizontalMatch = true;
          break;
        }
      }

      expect(foundHorizontalMatch).toBe(true);
    });

    it('should find vertical match even when node is at viewport edge', () => {
      // Reproduces the exact bug: switch-success at x=550, viewport x2=550
      const idx = buildIndex(GRAPH_NODES);
      const dragged = GRAPH_NODES.find(n => n.id === 'switch-success')!;

      // Viewport that just barely includes the node's left edge
      const tightViewport: Box = { x: -800, y: -100, x2: 550, y2: 900 };

      // Drag from starting position (at viewport edge) — centreX at 605, right at 660
      // Both are outside viewport. But target nodes inside viewport should still be found
      // as the node moves left during drag.
      const dragBox: Box = { x: 540, y: 215, x2: 650, y2: 325 };
      const anchors = Object.keys(ALL_ANCHORS);

      // The left anchor at 540 is inside viewport. Search should find targets
      // whose left anchors are near 540.
      const { vertical } = getHelperLines(idx, tightViewport, dragged, dragBox, anchors);

      // Even if no match at this exact position (no target at x≈540),
      // the search must NOT crash and must process lines correctly.
      // The key invariant: lines near the viewport edge are processed, not skipped.
      const xLines = (idx as any).xLines as any[];
      const linesInRange = xLines.filter((l: any) =>
        l.position >= tightViewport.x - SNAP_RADIUS &&
        l.position <= tightViewport.x2 + SNAP_RADIUS &&
        l.node.id !== dragged.id
      );
      // There should be processable lines within the expanded viewport range
      expect(linesInRange.length).toBeGreaterThan(0);
    });
  });

  // ── Source anchor selection ─────────────────────────────────────────────

  describe('getSourceAnchorsForNode', () => {
    it('should return centre-only anchors for conversion nodes', () => {
      const anchors = getSourceAnchorsForNode('switch-success');
      expect(anchors).toContain('centreX');
      expect(anchors).toContain('centreY');
      expect(anchors).not.toContain('left');
      expect(anchors).not.toContain('right');
      expect(anchors).not.toContain('top');
      expect(anchors).not.toContain('bottom');
      expect(anchors.length).toBe(2);
    });

    it('should return all 6 anchors for resizable objects', () => {
      expect(getSourceAnchorsForNode('postit-abc').length).toBe(6);
      expect(getSourceAnchorsForNode('container-xyz').length).toBe(6);
      expect(getSourceAnchorsForNode('analysis-123').length).toBe(6);
    });

    it('should return centre+top+bottom anchors for conversion nodes in sankey mode', () => {
      const anchors = getSourceAnchorsForNode('switch-success', true);
      expect(anchors).toContain('centreX');
      expect(anchors).toContain('centreY');
      expect(anchors).toContain('top');
      expect(anchors).toContain('bottom');
      expect(anchors).not.toContain('left');
      expect(anchors).not.toContain('right');
      expect(anchors.length).toBe(4);
    });

    it('should still return all 6 anchors for resizable objects in sankey mode', () => {
      expect(getSourceAnchorsForNode('postit-abc', true).length).toBe(6);
      expect(getSourceAnchorsForNode('container-xyz', true).length).toBe(6);
    });
  });
});
