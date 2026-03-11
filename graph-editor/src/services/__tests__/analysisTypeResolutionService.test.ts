/**
 * analysisTypeResolutionService INTEGRATION tests.
 *
 * Hits the REAL backend at localhost:9000.
 * Verifies that the full chain works: graph + DSL -> resolveAnalysisType -> correct primary type.
 *
 * These tests require the compute backend to be running.
 * They test the ACTUAL behaviour, not mocked stubs.
 */

import { describe, it, expect } from 'vitest';

const describeBackend = process.env.CI ? describe.skip : describe;
import { resolveAnalysisType } from '../analysisTypeResolutionService';

const SIMPLE_GRAPH = {
  nodes: [
    { uuid: 'n1', id: 'landing-page', label: 'Landing Page', type: 'conversion', entry: { is_start: true, weight: 1.0 } },
    { uuid: 'n2', id: 'signup', label: 'Signup', type: 'conversion' },
    { uuid: 'n3', id: 'purchase', label: 'Purchase', type: 'conversion', absorbing: true },
    { uuid: 'n4', id: 'dropout', label: 'Dropout', type: 'conversion', absorbing: true },
  ],
  edges: [
    { uuid: 'e1', from: 'n1', to: 'n2', id: 'landing-to-signup', p: { mean: 0.5 } },
    { uuid: 'e2', from: 'n2', to: 'n3', id: 'signup-to-purchase', p: { mean: 0.3 } },
    { uuid: 'e3', from: 'n2', to: 'n4', id: 'signup-to-dropout', p: { mean: 0.7 } },
    { uuid: 'e4', from: 'n1', to: 'n4', id: 'landing-to-dropout', p: { mean: 0.5 } },
  ],
  metadata: { id: 'test-graph', name: 'Test Graph' },
};

describeBackend('resolveAnalysisType (integration - real backend)', () => {
  it('should return graph_overview as primary when no DSL provided', async () => {
    const result = await resolveAnalysisType(SIMPLE_GRAPH);

    expect(result.primaryAnalysisType).toBeTruthy();
    expect(result.availableAnalyses.length).toBeGreaterThan(0);
    expect(result.primaryAnalysisType).toBe('graph_overview');
  });

  it('should return path_between as primary for from(a).to(b) DSL', async () => {
    const result = await resolveAnalysisType(SIMPLE_GRAPH, 'from(landing-page).to(purchase)');

    expect(result.primaryAnalysisType).toBeTruthy();
    expect(result.availableAnalyses.length).toBeGreaterThan(0);
    expect(result.primaryAnalysisType).toBe('path_between');
  });

  it('should return conversion_funnel as primary for from().to().visited() DSL', async () => {
    const result = await resolveAnalysisType(SIMPLE_GRAPH, 'from(landing-page).to(purchase).visited(signup)');

    expect(result.primaryAnalysisType).toBeTruthy();
    expect(result.availableAnalyses.length).toBeGreaterThan(0);
    expect(result.primaryAnalysisType).toBe('conversion_funnel');
  });

  it('should return from_node_outcomes as primary for single from() DSL', async () => {
    const result = await resolveAnalysisType(SIMPLE_GRAPH, 'from(landing-page)');

    expect(result.primaryAnalysisType).toBeTruthy();
    expect(result.primaryAnalysisType).toBe('from_node_outcomes');
  });

  it('should return to_node_reach as primary for single to() DSL', async () => {
    const result = await resolveAnalysisType(SIMPLE_GRAPH, 'to(purchase)');

    expect(result.primaryAnalysisType).toBeTruthy();
    expect(result.primaryAnalysisType).toBe('to_node_reach');
  });

  it('should return bridge_view as primary for to() with 2 scenarios', async () => {
    const result = await resolveAnalysisType(SIMPLE_GRAPH, 'to(purchase)', 2);

    expect(result.primaryAnalysisType).toBeTruthy();
    expect(result.primaryAnalysisType).toBe('bridge_view');
  });

  it('should return null for null graph', async () => {
    const result = await resolveAnalysisType(null);

    expect(result.primaryAnalysisType).toBeNull();
    expect(result.availableAnalyses).toHaveLength(0);
  });

  it('should always include graph_overview in available analyses', async () => {
    const result = await resolveAnalysisType(SIMPLE_GRAPH, 'from(landing-page).to(purchase).visited(signup)');

    const ids = result.availableAnalyses.map(a => a.id);
    expect(ids).toContain('graph_overview');
  });

  it('should have conversion_funnel available but NOT primary when only 2 nodes selected', async () => {
    const result = await resolveAnalysisType(SIMPLE_GRAPH, 'from(landing-page).to(purchase)');

    expect(result.primaryAnalysisType).not.toBe('conversion_funnel');
    expect(result.primaryAnalysisType).toBe('path_between');
  });
});
