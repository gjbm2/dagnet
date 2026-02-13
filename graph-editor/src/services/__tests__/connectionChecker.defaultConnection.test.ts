/**
 * ConnectionChecker — tests for graph.defaultConnection fallback.
 *
 * Verifies that createProductionConnectionChecker() correctly falls back to
 * graph.defaultConnection when edge/node-level connections are not set.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { createProductionConnectionChecker } from '../fetchPlanBuilderService';
import type { Graph } from '../../types';

describe('createProductionConnectionChecker with graph.defaultConnection', () => {
  // -- hasEdgeConnection --

  it('returns true when edge.p.connection is set (no graph default needed)', () => {
    const checker = createProductionConnectionChecker();
    expect(checker.hasEdgeConnection({ p: { connection: 'amplitude-prod' } })).toBe(true);
  });

  it('returns false when edge has no connection and no graph default', () => {
    const checker = createProductionConnectionChecker();
    expect(checker.hasEdgeConnection({ p: { mean: 0.5 } })).toBe(false);
  });

  it('returns true when edge has no connection but graph has defaultConnection', () => {
    const graph = { defaultConnection: 'amplitude-prod' } as Graph;
    const checker = createProductionConnectionChecker(graph);
    expect(checker.hasEdgeConnection({ p: { mean: 0.5 } })).toBe(true);
  });

  it('returns true when edge.cost_gbp.connection is set', () => {
    const checker = createProductionConnectionChecker();
    expect(checker.hasEdgeConnection({ cost_gbp: { connection: 'sheets-readonly' } })).toBe(true);
  });

  it('returns true when conditional_p has connection', () => {
    const checker = createProductionConnectionChecker();
    const edge = {
      p: { mean: 0.5 },
      conditional_p: [{ p: { connection: 'amplitude-prod' } }],
    };
    expect(checker.hasEdgeConnection(edge)).toBe(true);
  });

  it('returns true for null/undefined edge when graph has defaultConnection', () => {
    const graph = { defaultConnection: 'amplitude-prod' } as Graph;
    const checker = createProductionConnectionChecker(graph);
    expect(checker.hasEdgeConnection(null)).toBe(true);
    expect(checker.hasEdgeConnection(undefined)).toBe(true);
  });

  it('returns false for null/undefined edge when no graph default', () => {
    const checker = createProductionConnectionChecker();
    expect(checker.hasEdgeConnection(null)).toBe(false);
    expect(checker.hasEdgeConnection(undefined)).toBe(false);
  });

  // -- hasCaseConnection --

  it('returns true when node.case.connection is set', () => {
    const checker = createProductionConnectionChecker();
    expect(checker.hasCaseConnection({ case: { connection: 'statsig-prod' } })).toBe(true);
  });

  it('returns false when node.case has no connection and no graph default', () => {
    const checker = createProductionConnectionChecker();
    expect(checker.hasCaseConnection({ case: { id: 'my-case' } })).toBe(false);
  });

  it('returns true when node.case has no connection but graph has defaultConnection', () => {
    const graph = { defaultConnection: 'statsig-prod' } as Graph;
    const checker = createProductionConnectionChecker(graph);
    expect(checker.hasCaseConnection({ case: { id: 'my-case' } })).toBe(true);
  });

  // -- edge-level takes precedence (implicit) --

  it('edge.p.connection takes precedence — returns true regardless of graph default', () => {
    const graph = { defaultConnection: 'amplitude-staging' } as Graph;
    const checker = createProductionConnectionChecker(graph);
    // Edge has its own connection — should return true (would return true with or without graph default)
    expect(checker.hasEdgeConnection({ p: { connection: 'amplitude-prod' } })).toBe(true);
  });
});
