import { describe, it, expect } from 'vitest';
import { toFlow, fromFlow } from '../transform';

describe('PostIt transform round-trip', () => {
  const baseGraph = {
    nodes: [
      { uuid: 'node-1', id: 'start', label: 'Start', layout: { x: 0, y: 0 } },
    ],
    edges: [],
    policies: { default_outcome: 'end', overflow_policy: 'error', free_edge_policy: 'complement' },
    metadata: { version: '1.0.0', created_at: '2026-01-01' },
  };

  it('toFlow emits postit nodes with correct prefix, type, and zIndex based on array index', () => {
    const graph = {
      ...baseGraph,
      postits: [
        { id: 'p1', text: 'Hello', colour: '#FFF475', width: 200, height: 150, x: 100, y: 200 },
      ],
    };

    const { nodes } = toFlow(graph);

    const postitNode = nodes.find(n => n.id === 'postit-p1');
    expect(postitNode).toBeDefined();
    expect(postitNode!.type).toBe('postit');
    expect(postitNode!.position).toEqual({ x: 100, y: 200 });
    expect(postitNode!.zIndex).toBe(5000);
    expect(postitNode!.data.postit.text).toBe('Hello');
    expect(postitNode!.data.postit.colour).toBe('#FFF475');
  });

  it('toFlow assigns incrementing zIndex based on postits array order (z-order)', () => {
    const graph = {
      ...baseGraph,
      postits: [
        { id: 'back', text: 'Back', colour: '#FFF475', width: 200, height: 150, x: 0, y: 0 },
        { id: 'mid', text: 'Mid', colour: '#F4BFDB', width: 200, height: 150, x: 10, y: 10 },
        { id: 'front', text: 'Front', colour: '#B6E3E9', width: 200, height: 150, x: 20, y: 20 },
      ],
    };

    const { nodes } = toFlow(graph);

    const back = nodes.find(n => n.id === 'postit-back')!;
    const mid = nodes.find(n => n.id === 'postit-mid')!;
    const front = nodes.find(n => n.id === 'postit-front')!;

    expect(back.zIndex).toBe(5000);
    expect(mid.zIndex).toBe(5001);
    expect(front.zIndex).toBe(5002);
    expect(front.zIndex).toBeGreaterThan(mid.zIndex);
    expect(mid.zIndex).toBeGreaterThan(back.zIndex);
  });

  it('bring-to-front reorder produces correct zIndex after re-transform', () => {
    const graph = {
      ...baseGraph,
      postits: [
        { id: 'a', text: 'A', colour: '#FFF475', width: 200, height: 150, x: 0, y: 0 },
        { id: 'b', text: 'B', colour: '#F4BFDB', width: 200, height: 150, x: 10, y: 10 },
        { id: 'c', text: 'C', colour: '#B6E3E9', width: 200, height: 150, x: 20, y: 20 },
      ],
    };

    // Simulate "bring A to front": remove A from index 0, push to end
    const reordered = {
      ...graph,
      postits: [graph.postits[1], graph.postits[2], graph.postits[0]],
    };

    const { nodes } = toFlow(reordered);

    const a = nodes.find(n => n.id === 'postit-a')!;
    const b = nodes.find(n => n.id === 'postit-b')!;
    const c = nodes.find(n => n.id === 'postit-c')!;

    // A should now have highest zIndex (it's last in array)
    expect(a.zIndex).toBe(5002);
    expect(b.zIndex).toBe(5000);
    expect(c.zIndex).toBe(5001);
    expect(a.zIndex).toBeGreaterThan(b.zIndex);
    expect(a.zIndex).toBeGreaterThan(c.zIndex);
  });

  it('send-to-back reorder produces correct zIndex after re-transform', () => {
    const graph = {
      ...baseGraph,
      postits: [
        { id: 'a', text: 'A', colour: '#FFF475', width: 200, height: 150, x: 0, y: 0 },
        { id: 'b', text: 'B', colour: '#F4BFDB', width: 200, height: 150, x: 10, y: 10 },
        { id: 'c', text: 'C', colour: '#B6E3E9', width: 200, height: 150, x: 20, y: 20 },
      ],
    };

    // Simulate "send C to back": remove C from index 2, unshift to beginning
    const reordered = {
      ...graph,
      postits: [graph.postits[2], graph.postits[0], graph.postits[1]],
    };

    const { nodes } = toFlow(reordered);

    const a = nodes.find(n => n.id === 'postit-a')!;
    const b = nodes.find(n => n.id === 'postit-b')!;
    const c = nodes.find(n => n.id === 'postit-c')!;

    // C should now have lowest zIndex (it's first in array)
    expect(c.zIndex).toBe(5000);
    expect(a.zIndex).toBe(5001);
    expect(b.zIndex).toBe(5002);
    expect(c.zIndex).toBeLessThan(a.zIndex);
    expect(c.zIndex).toBeLessThan(b.zIndex);
  });

  it('toFlow handles undefined postits array', () => {
    const { nodes } = toFlow(baseGraph);
    const postitNodes = nodes.filter(n => n.id.startsWith('postit-'));
    expect(postitNodes).toHaveLength(0);
  });

  it('toFlow handles empty postits array', () => {
    const graph = { ...baseGraph, postits: [] };
    const { nodes } = toFlow(graph);
    const postitNodes = nodes.filter(n => n.id.startsWith('postit-'));
    expect(postitNodes).toHaveLength(0);
  });

  it('postit nodes do not contaminate conversion nodes in fromFlow', () => {
    const graph = {
      ...baseGraph,
      postits: [
        { id: 'p1', text: 'Test', colour: '#FFF475', width: 200, height: 150, x: 100, y: 200 },
      ],
    };

    const { nodes, edges } = toFlow(graph);

    // Move the postit
    const movedNodes = nodes.map(n =>
      n.id === 'postit-p1' ? { ...n, position: { x: 300, y: 400 } } : n
    );

    const result = fromFlow(movedNodes, edges, graph);

    // Conversion nodes unchanged
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].uuid).toBe('node-1');

    // Postit position updated
    expect(result.postits).toHaveLength(1);
    expect(result.postits[0].x).toBe(300);
    expect(result.postits[0].y).toBe(400);
    expect(result.postits[0].text).toBe('Test');
  });

  it('fromFlow preserves postits when no ReactFlow postit nodes exist', () => {
    const graph = {
      ...baseGraph,
      postits: [
        { id: 'p1', text: 'Keep me', colour: '#FFF475', width: 200, height: 150, x: 50, y: 50 },
      ],
    };

    // Only pass conversion nodes (no postit nodes)
    const conversionNodes = [
      { id: 'node-1', type: 'conversion', position: { x: 0, y: 0 }, data: { layout: { x: 0, y: 0 } } },
    ];

    const result = fromFlow(conversionNodes as any, [], graph);

    // Postit should be preserved (not stripped)
    expect(result.postits).toHaveLength(1);
    expect(result.postits[0].id).toBe('p1');
    expect(result.postits[0].text).toBe('Keep me');
  });

  it('conversion node positions are not affected by postit nodes', () => {
    const graph = {
      ...baseGraph,
      postits: [
        { id: 'p1', text: 'Note', colour: '#FFF475', width: 200, height: 150, x: 500, y: 500 },
      ],
    };

    const { nodes, edges } = toFlow(graph);

    // Move conversion node
    const movedNodes = nodes.map(n =>
      n.id === 'node-1' ? { ...n, position: { x: 99, y: 88 } } : n
    );

    const result = fromFlow(movedNodes, edges, graph);

    expect(result.nodes[0].layout.x).toBe(99);
    expect(result.nodes[0].layout.y).toBe(88);
    // Postit unchanged
    expect(result.postits[0].x).toBe(500);
    expect(result.postits[0].y).toBe(500);
  });
});
