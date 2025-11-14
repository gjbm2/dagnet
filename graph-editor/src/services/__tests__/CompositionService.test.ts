/**
 * Tests for CompositionService
 * 
 * Tests deep-merging of scenario parameter overlays
 * 
 * @group unit
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { composeParams, areParamsEqual } from '../CompositionService';
import { ScenarioParams } from '../../types/scenarios';

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
});



