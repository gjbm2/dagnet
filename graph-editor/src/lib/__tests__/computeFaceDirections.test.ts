import { describe, it, expect } from 'vitest';

import { computeFaceDirectionsFromEdges } from '../faceDirections';

describe('computeFaceDirectionsFromEdges', () => {
  it('returns empty map for empty edge list', () => {
    expect(computeFaceDirectionsFromEdges([])).toEqual(new Map());
  });

  it('classifies pure outbound face as convex', () => {
    const edges = [
      { source: 'A', target: 'B', sourceFace: 'right', targetFace: 'left' },
    ];
    const result = computeFaceDirectionsFromEdges(edges);

    expect(result.get('A')).toEqual({
      left: 'flat', right: 'convex', top: 'flat', bottom: 'flat',
    });
  });

  it('classifies pure inbound face as concave', () => {
    const edges = [
      { source: 'A', target: 'B', sourceFace: 'right', targetFace: 'left' },
    ];
    const result = computeFaceDirectionsFromEdges(edges);

    expect(result.get('B')).toEqual({
      left: 'concave', right: 'flat', top: 'flat', bottom: 'flat',
    });
  });

  it('classifies tied in/out as flat', () => {
    // A→B via right/left, and B→A via left/right — node A right face has 1 out and 1 in
    const edges = [
      { source: 'A', target: 'B', sourceFace: 'right', targetFace: 'left' },
      { source: 'B', target: 'A', sourceFace: 'left', targetFace: 'right' },
    ];
    const result = computeFaceDirectionsFromEdges(edges);

    // A.right: 1 out (→B) + 1 in (←B) = tied → flat
    expect(result.get('A')!.right).toBe('flat');
    // A.left: no traffic → flat
    expect(result.get('A')!.left).toBe('flat');
  });

  it('majority outbound wins as convex', () => {
    const edges = [
      { source: 'A', target: 'B', sourceFace: 'right', targetFace: 'left' },
      { source: 'A', target: 'C', sourceFace: 'right', targetFace: 'left' },
      { source: 'D', target: 'A', sourceFace: 'right', targetFace: 'right' },
    ];
    const result = computeFaceDirectionsFromEdges(edges);

    // A.right: 2 out + 1 in → convex
    expect(result.get('A')!.right).toBe('convex');
  });

  it('majority inbound wins as concave', () => {
    const edges = [
      { source: 'B', target: 'A', sourceFace: 'right', targetFace: 'left' },
      { source: 'C', target: 'A', sourceFace: 'right', targetFace: 'left' },
      { source: 'A', target: 'D', sourceFace: 'left', targetFace: 'right' },
    ];
    const result = computeFaceDirectionsFromEdges(edges);

    // A.left: 2 in + 1 out → concave
    expect(result.get('A')!.left).toBe('concave');
  });

  it('handles all four faces independently', () => {
    const edges = [
      { source: 'A', target: 'B', sourceFace: 'right', targetFace: 'left' },
      { source: 'C', target: 'A', sourceFace: 'bottom', targetFace: 'top' },
      { source: 'A', target: 'D', sourceFace: 'bottom', targetFace: 'top' },
      { source: 'E', target: 'A', sourceFace: 'right', targetFace: 'left' },
    ];
    const result = computeFaceDirectionsFromEdges(edges);

    const a = result.get('A')!;
    expect(a.right).toBe('convex');   // 1 out, 0 in
    expect(a.left).toBe('concave');   // 0 out, 1 in
    expect(a.top).toBe('concave');    // 0 out, 1 in
    expect(a.bottom).toBe('convex');  // 1 out, 0 in
  });

  it('reads faces from edge.data when direct properties are absent', () => {
    const edges = [
      { source: 'A', target: 'B', data: { sourceFace: 'right', targetFace: 'left' } },
    ];
    const result = computeFaceDirectionsFromEdges(edges);

    expect(result.get('A')).toEqual({
      left: 'flat', right: 'convex', top: 'flat', bottom: 'flat',
    });
    expect(result.get('B')).toEqual({
      left: 'concave', right: 'flat', top: 'flat', bottom: 'flat',
    });
  });

  it('prefers direct properties over edge.data', () => {
    const edges = [
      {
        source: 'A', target: 'B',
        sourceFace: 'right', targetFace: 'left',
        data: { sourceFace: 'bottom', targetFace: 'top' },
      },
    ];
    const result = computeFaceDirectionsFromEdges(edges);

    // Direct sourceFace='right' should win over data.sourceFace='bottom'
    expect(result.get('A')!.right).toBe('convex');
    expect(result.get('A')!.bottom).toBe('flat');
  });

  it('ignores edges with missing face info', () => {
    const edges = [
      { source: 'A', target: 'B' },  // no face info at all
      { source: 'C', target: 'D', sourceFace: 'right', targetFace: undefined },
    ];
    const result = computeFaceDirectionsFromEdges(edges);

    // A and B should not appear (no face data)
    expect(result.has('A')).toBe(false);
    expect(result.has('B')).toBe(false);
    // C has sourceFace only
    expect(result.get('C')).toEqual({
      left: 'flat', right: 'convex', top: 'flat', bottom: 'flat',
    });
    // D has no targetFace → not in map
    expect(result.has('D')).toBe(false);
  });

  it('does not produce entries for nodes with zero traffic on all faces', () => {
    // Edge has faces but only for source — target has undefined face
    const edges = [
      { source: 'A', target: 'B', sourceFace: 'right' },
    ];
    const result = computeFaceDirectionsFromEdges(edges);

    expect(result.has('A')).toBe(true);
    expect(result.has('B')).toBe(false);
  });

  it('handles a realistic multi-node graph', () => {
    // Diamond: Start→A, Start→B, A→End, B→End
    const edges = [
      { source: 'start', target: 'A', sourceFace: 'right', targetFace: 'left' },
      { source: 'start', target: 'B', sourceFace: 'right', targetFace: 'left' },
      { source: 'A', target: 'end', sourceFace: 'right', targetFace: 'left' },
      { source: 'B', target: 'end', sourceFace: 'right', targetFace: 'left' },
    ];
    const result = computeFaceDirectionsFromEdges(edges);

    // Start: right=convex (2 out), rest=flat
    expect(result.get('start')!.right).toBe('convex');
    expect(result.get('start')!.left).toBe('flat');

    // A: left=concave (1 in), right=convex (1 out)
    expect(result.get('A')!.left).toBe('concave');
    expect(result.get('A')!.right).toBe('convex');

    // End: left=concave (2 in), rest=flat
    expect(result.get('end')!.left).toBe('concave');
    expect(result.get('end')!.right).toBe('flat');
  });
});
