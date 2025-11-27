/**
 * Tests for CompositionService
 * 
 * Tests deep-merging of scenario parameter overlays
 * 
 * @group unit
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { 
  composeParams, 
  areParamsEqual, 
  getComposedParamsForLayer,
  applyComposedParamsToGraph,
  buildGraphForLayer
} from '../CompositionService';
import { ScenarioParams } from '../../types/scenarios';
import { Graph } from '../../types';

describe('CompositionService', () => {
  describe('composeParams', () => {
    it('merges simple edge parameters', () => {
      const base: ScenarioParams = {
        edges: {
          'edge-1': {
            p: { mean: 0.5 }
          }
        }
      };
      
      const overlay: ScenarioParams = {
        edges: {
          'edge-1': {
            p: { mean: 0.7 }
          }
        }
      };
      
      const result = composeParams(base, [overlay]);
      
      expect(result.edges?.['edge-1']?.p?.mean).toBe(0.7);
    });
    
    it('merges multiple overlays in order', () => {
      const base: ScenarioParams = {
        edges: {
          'edge-1': {
            p: { mean: 0.5 }
          }
        }
      };
      
      const overlay1: ScenarioParams = {
        edges: {
          'edge-1': {
            p: { mean: 0.6 }
          }
        }
      };
      
      const overlay2: ScenarioParams = {
        edges: {
          'edge-1': {
            p: { mean: 0.8 }
          }
        }
      };
      
      const result = composeParams(base, [overlay1, overlay2]);
      
      expect(result.edges?.['edge-1']?.p?.mean).toBe(0.8);
    });
    
    it('handles null values (removes keys)', () => {
      const base: ScenarioParams = {
        edges: {
          'edge-1': {
            p: { mean: 0.5, stdev: 0.1 }
          }
        }
      };
      
      const overlay: ScenarioParams = {
        edges: {
          'edge-1': {
            p: null as any
          }
        }
      };
      
      const result = composeParams(base, [overlay]);
      
      expect(result.edges?.['edge-1']?.p).toBeUndefined();
    });
    
    it('merges conditional_p correctly', () => {
      const base: ScenarioParams = {
        edges: {
          'edge-1': {
            conditional_p: {
              'visited(node-a)': { mean: 0.5 }
            }
          }
        }
      };
      
      const overlay: ScenarioParams = {
        edges: {
          'edge-1': {
            conditional_p: {
              'visited(node-b)': { mean: 0.7 }
            }
          }
        }
      };
      
      const result = composeParams(base, [overlay]);
      
      expect(result.edges?.['edge-1']?.conditional_p?.['visited(node-a)']?.mean).toBe(0.5);
      expect(result.edges?.['edge-1']?.conditional_p?.['visited(node-b)']?.mean).toBe(0.7);
    });
    
    it('merges node parameters', () => {
      const base: ScenarioParams = {
        nodes: {
          'node-1': {
            entry: { entry_weight: 1.0 }
          }
        }
      };
      
      const overlay: ScenarioParams = {
        nodes: {
          'node-1': {
            entry: { entry_weight: 2.0 }
          }
        }
      };
      
      const result = composeParams(base, [overlay]);
      
      expect(result.nodes?.['node-1']?.entry?.entry_weight).toBe(2.0);
    });
    
    it('handles empty overlays array', () => {
      const base: ScenarioParams = {
        edges: {
          'edge-1': {
            p: { mean: 0.5 }
          }
        }
      };
      
      const result = composeParams(base, []);
      
      expect(result.edges?.['edge-1']?.p?.mean).toBe(0.5);
    });
  });
  
  describe('areParamsEqual', () => {
    it('returns true for identical params', () => {
      const params1: ScenarioParams = {
        edges: {
          'edge-1': {
            p: { mean: 0.5 }
          }
        }
      };
      
      const params2: ScenarioParams = {
        edges: {
          'edge-1': {
            p: { mean: 0.5 }
          }
        }
      };
      
      expect(areParamsEqual(params1, params2)).toBe(true);
    });
    
    it('returns false for different params', () => {
      const params1: ScenarioParams = {
        edges: {
          'edge-1': {
            p: { mean: 0.5 }
          }
        }
      };
      
      const params2: ScenarioParams = {
        edges: {
          'edge-1': {
            p: { mean: 0.7 }
          }
        }
      };
      
      expect(areParamsEqual(params1, params2)).toBe(false);
    });
  });

  describe('getComposedParamsForLayer', () => {
    const baseParams: ScenarioParams = {
      edges: {
        'edge-1': { p: { mean: 0.5 } }
      }
    };
    
    const currentParams: ScenarioParams = {
      edges: {
        'edge-1': { p: { mean: 0.6 } }
      }
    };
    
    const scenarios = [
      { id: 'scenario-1', params: { edges: { 'edge-1': { p: { mean: 0.7 } } } } },
      { id: 'scenario-2', params: { edges: { 'edge-1': { p: { mean: 0.8 } } } } },
    ];

    it('returns base params for "base" layer', () => {
      const result = getComposedParamsForLayer('base', baseParams, currentParams, scenarios);
      expect(result.edges?.['edge-1']?.p?.mean).toBe(0.5);
    });

    it('returns current params for "current" layer', () => {
      const result = getComposedParamsForLayer('current', baseParams, currentParams, scenarios);
      expect(result.edges?.['edge-1']?.p?.mean).toBe(0.6);
    });

    it('composes up to specific scenario layer', () => {
      const result = getComposedParamsForLayer('scenario-1', baseParams, currentParams, scenarios);
      expect(result.edges?.['edge-1']?.p?.mean).toBe(0.7);
    });

    it('composes through all preceding layers', () => {
      const result = getComposedParamsForLayer('scenario-2', baseParams, currentParams, scenarios);
      // scenario-2 comes after scenario-1, so both are applied
      expect(result.edges?.['edge-1']?.p?.mean).toBe(0.8);
    });

    it('respects custom layer order from visibleScenarioIds', () => {
      // If we only have scenario-2 visible (not scenario-1), only scenario-2's overlay applies
      const result = getComposedParamsForLayer(
        'scenario-2', 
        baseParams, 
        currentParams, 
        scenarios,
        ['scenario-2']  // Only scenario-2 is visible
      );
      expect(result.edges?.['edge-1']?.p?.mean).toBe(0.8);
    });

    it('returns base params for unknown scenario', () => {
      const result = getComposedParamsForLayer('unknown', baseParams, currentParams, scenarios);
      expect(result.edges?.['edge-1']?.p?.mean).toBe(0.5);
    });
  });

  describe('applyComposedParamsToGraph', () => {
    const baseGraph: Graph = {
      nodes: [
        { uuid: 'node-1', id: 'start', label: 'Start' }
      ],
      edges: [
        { uuid: 'edge-uuid-1', id: 'edge-1', from: 'node-1', to: 'node-2', p: { mean: 0.5 } }
      ],
      policies: { default_outcome: 'end' },
      metadata: { version: '1.0.0', created_at: '2024-01-01' }
    };

    it('applies probability params to edges', () => {
      const params: ScenarioParams = {
        edges: {
          'edge-1': { p: { mean: 0.9, stdev: 0.1 } }
        }
      };
      
      const result = applyComposedParamsToGraph(baseGraph, params);
      
      expect(result.edges[0].p?.mean).toBe(0.9);
      expect(result.edges[0].p?.stdev).toBe(0.1);
      // Original graph unchanged
      expect(baseGraph.edges[0].p?.mean).toBe(0.5);
    });

    it('applies weight_default to edges', () => {
      const params: ScenarioParams = {
        edges: {
          'edge-1': { weight_default: 100 }
        }
      };
      
      const result = applyComposedParamsToGraph(baseGraph, params);
      
      expect(result.edges[0].weight_default).toBe(100);
    });
  });

  describe('buildGraphForLayer', () => {
    const baseParams: ScenarioParams = {
      edges: { 'edge-1': { p: { mean: 0.5 } } }
    };
    
    const currentParams: ScenarioParams = {
      edges: { 'edge-1': { p: { mean: 0.6 } } }
    };
    
    const scenarios = [
      { id: 'scenario-1', params: { edges: { 'edge-1': { p: { mean: 0.9 } } } } },
    ];

    const graph: Graph = {
      nodes: [],
      edges: [
        { uuid: 'e1', id: 'edge-1', from: 'n1', to: 'n2', p: { mean: 0.5 } }
      ],
      policies: { default_outcome: 'end' },
      metadata: { version: '1.0.0', created_at: '2024-01-01' }
    };

    it('builds graph with scenario params baked in', () => {
      const result = buildGraphForLayer(
        'scenario-1',
        graph,
        baseParams,
        currentParams,
        scenarios
      );
      
      expect(result.edges[0].p?.mean).toBe(0.9);
    });

    it('builds graph with current params for current layer', () => {
      const result = buildGraphForLayer(
        'current',
        graph,
        baseParams,
        currentParams,
        scenarios
      );
      
      expect(result.edges[0].p?.mean).toBe(0.6);
    });
  });
});








