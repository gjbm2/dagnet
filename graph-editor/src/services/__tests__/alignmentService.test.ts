import { describe, it, expect } from 'vitest';
import {
  computeAlignment,
  computeDistribution,
  computeEqualSize,
  toNodeRect,
  NodeRect,
} from '../alignmentService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a rect at (x, y) with given size, defaulting to 100×50. */
function rect(id: string, x: number, y: number, w = 100, h = 50): NodeRect {
  return { id, x, y, width: w, height: h };
}

// ---------------------------------------------------------------------------
// computeAlignment
// ---------------------------------------------------------------------------

describe('computeAlignment', () => {
  it('should return empty when fewer than 2 nodes', () => {
    expect(computeAlignment([rect('a', 10, 20)], 'align-left')).toEqual([]);
    expect(computeAlignment([], 'align-left')).toEqual([]);
  });

  // --- align-left ---

  it('should align left edges to the minimum left edge', () => {
    const nodes = [rect('a', 50, 0), rect('b', 200, 0), rect('c', 120, 0)];
    const updates = computeAlignment(nodes, 'align-left');

    // a is already at the min (50), so only b and c should move
    expect(updates).toHaveLength(2);
    expect(updates).toContainEqual({ id: 'b', position: { x: 50, y: 0 } });
    expect(updates).toContainEqual({ id: 'c', position: { x: 50, y: 0 } });
  });

  it('should not move nodes already aligned left', () => {
    const nodes = [rect('a', 10, 0), rect('b', 10, 100)];
    expect(computeAlignment(nodes, 'align-left')).toEqual([]);
  });

  // --- align-right ---

  it('should align right edges to the maximum right edge', () => {
    const nodes = [
      rect('a', 0, 0, 100, 50),   // right = 100
      rect('b', 200, 0, 80, 50),  // right = 280
    ];
    const updates = computeAlignment(nodes, 'align-right');

    // b.right = 280 is max; a should move so a.right = 280 → a.x = 180
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({ id: 'a', position: { x: 180, y: 0 } });
  });

  // --- align-top ---

  it('should align top edges to the minimum top edge', () => {
    const nodes = [rect('a', 0, 30), rect('b', 0, 80), rect('c', 0, 30)];
    const updates = computeAlignment(nodes, 'align-top');

    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({ id: 'b', position: { x: 0, y: 30 } });
  });

  // --- align-bottom ---

  it('should align bottom edges to the maximum bottom edge', () => {
    const nodes = [
      rect('a', 0, 0, 100, 40),   // bottom = 40
      rect('b', 0, 100, 100, 60), // bottom = 160
    ];
    const updates = computeAlignment(nodes, 'align-bottom');

    // b.bottom = 160 is max; a should move so a.bottom = 160 → a.y = 120
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({ id: 'a', position: { x: 0, y: 120 } });
  });

  // --- align-centre-horizontal ---

  it('should align horizontal centres to the selection bbox centre', () => {
    // a: x=0, w=100 → right=100
    // b: x=200, w=60 → right=260
    // bbox centreX = (0 + 260) / 2 = 130
    const nodes = [rect('a', 0, 0, 100, 50), rect('b', 200, 0, 60, 50)];
    const updates = computeAlignment(nodes, 'align-centre-horizontal');

    // a.newX = 130 - 50 = 80; b.newX = 130 - 30 = 100
    expect(updates).toHaveLength(2);
    expect(updates).toContainEqual({ id: 'a', position: { x: 80, y: 0 } });
    expect(updates).toContainEqual({ id: 'b', position: { x: 100, y: 0 } });
  });

  // --- align-centre-vertical ---

  it('should align vertical centres to the selection bbox centre', () => {
    // a: y=0, h=40 → bottom=40
    // b: y=100, h=60 → bottom=160
    // bbox centreY = (0 + 160) / 2 = 80
    const nodes = [rect('a', 0, 0, 100, 40), rect('b', 0, 100, 100, 60)];
    const updates = computeAlignment(nodes, 'align-centre-vertical');

    // a.newY = 80 - 20 = 60; b.newY = 80 - 30 = 50
    expect(updates).toHaveLength(2);
    expect(updates).toContainEqual({ id: 'a', position: { x: 0, y: 60 } });
    expect(updates).toContainEqual({ id: 'b', position: { x: 0, y: 50 } });
  });

  // --- preserves other axis ---

  it('should preserve the Y coordinate when aligning horizontally', () => {
    const nodes = [rect('a', 0, 10), rect('b', 50, 90)];
    const updates = computeAlignment(nodes, 'align-left');
    // b moves to x=0 but keeps y=90
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({ id: 'b', position: { x: 0, y: 90 } });
  });

  it('should preserve the X coordinate when aligning vertically', () => {
    const nodes = [rect('a', 10, 0), rect('b', 90, 50)];
    const updates = computeAlignment(nodes, 'align-top');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({ id: 'b', position: { x: 90, y: 0 } });
  });

  // --- mixed sizes ---

  it('should handle nodes of different sizes correctly for align-right', () => {
    const nodes = [
      rect('small', 0, 0, 30, 30),   // right = 30
      rect('big', 10, 0, 200, 80),    // right = 210
      rect('mid', 50, 0, 100, 50),    // right = 150
    ];
    const updates = computeAlignment(nodes, 'align-right');
    // max right = 210
    // small.newX = 210 - 30 = 180
    // mid.newX = 210 - 100 = 110
    expect(updates).toHaveLength(2);
    expect(updates).toContainEqual({ id: 'small', position: { x: 180, y: 0 } });
    expect(updates).toContainEqual({ id: 'mid', position: { x: 110, y: 0 } });
  });
});

// ---------------------------------------------------------------------------
// computeDistribution
// ---------------------------------------------------------------------------

describe('computeDistribution', () => {
  it('should return empty when fewer than 3 nodes', () => {
    expect(computeDistribution([rect('a', 0, 0), rect('b', 100, 0)], 'distribute-horizontal')).toEqual([]);
    expect(computeDistribution([], 'distribute-horizontal')).toEqual([]);
  });

  // --- distribute-horizontal ---

  it('should distribute 3 nodes horizontally with equal gaps', () => {
    // a: x=0, w=100 → occupies [0,100]
    // b: x=150, w=100 → occupies [150,250]  (gap from a = 50)
    // c: x=400, w=100 → occupies [400,500]  (gap from b = 150)
    //
    // Total span = 500, total node width = 300, total gap = 200, gap each = 100
    // a stays at 0 (leftmost), c stays at 400 (rightmost)
    // b.newX = 0 + 100 + 100 = 200
    const nodes = [rect('a', 0, 0), rect('b', 150, 50), rect('c', 400, 20)];
    const updates = computeDistribution(nodes, 'distribute-horizontal');

    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({ id: 'b', position: { x: 200, y: 50 } });
  });

  it('should preserve Y coordinates when distributing horizontally', () => {
    const nodes = [rect('a', 0, 10), rect('b', 100, 90), rect('c', 500, 50)];
    const updates = computeDistribution(nodes, 'distribute-horizontal');

    for (const u of updates) {
      const original = nodes.find(n => n.id === u.id)!;
      expect(u.position.y).toBe(original.y);
    }
  });

  it('should not move outermost nodes when distributing horizontally', () => {
    const nodes = [rect('a', 0, 0), rect('b', 100, 0), rect('c', 500, 0)];
    const updates = computeDistribution(nodes, 'distribute-horizontal');

    const movedIds = updates.map(u => u.id);
    expect(movedIds).not.toContain('a'); // leftmost
    expect(movedIds).not.toContain('c'); // rightmost
  });

  it('should distribute 4 nodes horizontally with equal gaps', () => {
    // Positions chosen so nodes need redistribution:
    // a: x=0, w=100; b: x=110, w=100; c: x=220, w=100; d: x=600, w=100
    // Sorted by x: a(0), b(110), c(220), d(600)
    // Total span = 700, total width = 400, total gap = 300, gap each = 100
    // a stays at 0, d stays at 600
    // b.newX = 0 + 100 + 100 = 200
    // c.newX = 200 + 100 + 100 = 400
    const nodes = [
      rect('a', 0, 0),
      rect('b', 110, 0),
      rect('c', 220, 0),
      rect('d', 600, 0),
    ];
    const updates = computeDistribution(nodes, 'distribute-horizontal');

    expect(updates).toContainEqual({ id: 'b', position: { x: 200, y: 0 } });
    expect(updates).toContainEqual({ id: 'c', position: { x: 400, y: 0 } });
  });

  // --- distribute-vertical ---

  it('should distribute 3 nodes vertically with equal gaps', () => {
    // a: y=0, h=50; b: y=80, h=50; c: y=350, h=50
    // Sorted by y: a(0), b(80), c(350)
    // Total span = 400, total height = 150, total gap = 250, gap each = 125
    // a stays at 0, c stays at 350
    // b.newY = 0 + 50 + 125 = 175
    const nodes = [rect('a', 0, 0), rect('b', 0, 80), rect('c', 0, 350)];
    const updates = computeDistribution(nodes, 'distribute-vertical');

    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({ id: 'b', position: { x: 0, y: 175 } });
  });

  it('should preserve X coordinates when distributing vertically', () => {
    const nodes = [rect('a', 10, 0), rect('b', 90, 100), rect('c', 50, 500)];
    const updates = computeDistribution(nodes, 'distribute-vertical');

    for (const u of updates) {
      const original = nodes.find(n => n.id === u.id)!;
      expect(u.position.x).toBe(original.x);
    }
  });

  // --- handles different sizes ---

  it('should handle nodes of different widths when distributing horizontally', () => {
    // a: x=0, w=50;  b: x=100, w=200;  c: x=500, w=50
    // Sorted by x: a(0), b(100), c(500)
    // Total span = 550, total width = 300, total gap = 250, gap each = 125
    // a stays at 0, c stays at 500
    // b.newX = 0 + 50 + 125 = 175
    const nodes = [
      rect('a', 0, 0, 50, 50),
      rect('b', 100, 0, 200, 50),
      rect('c', 500, 0, 50, 50),
    ];
    const updates = computeDistribution(nodes, 'distribute-horizontal');

    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({ id: 'b', position: { x: 175, y: 0 } });
  });

  it('should return empty when nodes are already evenly distributed', () => {
    // a: x=0, w=100; b: x=200, w=100; c: x=400, w=100
    // gap = 100 each — already even
    const nodes = [rect('a', 0, 0), rect('b', 200, 0), rect('c', 400, 0)];
    const updates = computeDistribution(nodes, 'distribute-horizontal');
    expect(updates).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// computeEqualSize
// ---------------------------------------------------------------------------

describe('computeEqualSize', () => {
  it('should return empty when fewer than 2 nodes', () => {
    expect(computeEqualSize([rect('a', 0, 0, 100, 50)], 'equal-width')).toEqual([]);
    expect(computeEqualSize([], 'equal-height')).toEqual([]);
  });

  // --- equal-width ---

  it('should set all widths to the average for equal-width', () => {
    // widths: 80, 120 → avg = 100
    const nodes = [rect('a', 0, 0, 80, 50), rect('b', 200, 0, 120, 50)];
    const updates = computeEqualSize(nodes, 'equal-width');

    expect(updates).toHaveLength(2);
    expect(updates).toContainEqual({ id: 'a', size: { width: 100, height: 50 } });
    expect(updates).toContainEqual({ id: 'b', size: { width: 100, height: 50 } });
  });

  it('should not include nodes already at the average width', () => {
    // widths: 100, 100, 200 → avg = 133
    const nodes = [
      rect('a', 0, 0, 100, 50),
      rect('b', 0, 0, 100, 50),
      rect('c', 0, 0, 200, 50),
    ];
    const updates = computeEqualSize(nodes, 'equal-width');
    // avg = Math.round(400/3) = 133 — all three differ from their original
    expect(updates).toHaveLength(3);
    for (const u of updates) {
      expect(u.size.width).toBe(133);
    }
  });

  it('should preserve heights when equalising widths', () => {
    const nodes = [rect('a', 0, 0, 80, 30), rect('b', 0, 0, 120, 70)];
    const updates = computeEqualSize(nodes, 'equal-width');

    const aUpdate = updates.find(u => u.id === 'a')!;
    const bUpdate = updates.find(u => u.id === 'b')!;
    expect(aUpdate.size.height).toBe(30);
    expect(bUpdate.size.height).toBe(70);
  });

  it('should return empty when all widths are already equal', () => {
    const nodes = [rect('a', 0, 0, 100, 50), rect('b', 200, 0, 100, 50)];
    expect(computeEqualSize(nodes, 'equal-width')).toEqual([]);
  });

  // --- equal-height ---

  it('should set all heights to the average for equal-height', () => {
    // heights: 40, 60 → avg = 50
    const nodes = [rect('a', 0, 0, 100, 40), rect('b', 0, 100, 100, 60)];
    const updates = computeEqualSize(nodes, 'equal-height');

    expect(updates).toHaveLength(2);
    expect(updates).toContainEqual({ id: 'a', size: { width: 100, height: 50 } });
    expect(updates).toContainEqual({ id: 'b', size: { width: 100, height: 50 } });
  });

  it('should preserve widths when equalising heights', () => {
    const nodes = [rect('a', 0, 0, 80, 30), rect('b', 0, 0, 120, 70)];
    const updates = computeEqualSize(nodes, 'equal-height');

    const aUpdate = updates.find(u => u.id === 'a')!;
    const bUpdate = updates.find(u => u.id === 'b')!;
    expect(aUpdate.size.width).toBe(80);
    expect(bUpdate.size.width).toBe(120);
  });

  it('should return empty when all heights are already equal', () => {
    const nodes = [rect('a', 0, 0, 100, 50), rect('b', 200, 0, 80, 50)];
    expect(computeEqualSize(nodes, 'equal-height')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// toNodeRect
// ---------------------------------------------------------------------------

describe('toNodeRect', () => {
  it('should extract rect from node with style dimensions', () => {
    const node = {
      id: 'postit-1',
      position: { x: 100, y: 200 },
      style: { width: 300, height: 150 },
    };
    const r = toNodeRect(node);
    expect(r).toEqual({ id: 'postit-1', x: 100, y: 200, width: 300, height: 150 });
  });

  it('should fall back to measured dimensions when style is absent', () => {
    const node = {
      id: 'node-1',
      position: { x: 10, y: 20 },
      measured: { width: 110, height: 110 },
    };
    const r = toNodeRect(node);
    expect(r).toEqual({ id: 'node-1', x: 10, y: 20, width: 110, height: 110 });
  });

  it('should fall back to defaults when neither style nor measured is present', () => {
    const node = {
      id: 'node-2',
      position: { x: 0, y: 0 },
    };
    const r = toNodeRect(node, 110, 110);
    expect(r).toEqual({ id: 'node-2', x: 0, y: 0, width: 110, height: 110 });
  });

  it('should prefer style over measured', () => {
    const node = {
      id: 'container-1',
      position: { x: 0, y: 0 },
      style: { width: 400, height: 300 },
      measured: { width: 100, height: 100 },
    };
    const r = toNodeRect(node);
    expect(r).toEqual({ id: 'container-1', x: 0, y: 0, width: 400, height: 300 });
  });
});
