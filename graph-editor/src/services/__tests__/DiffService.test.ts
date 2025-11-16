/**
 * Tests for DiffService
 * 
 * Tests computation of parameter differences
 * 
 * @group unit
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { computeDiff } from '../DiffService';
import { ScenarioParams } from '../../types/scenarios';

describe('DiffService', () => {
  describe('computeDiff - all mode', () => {
    it('returns full current params', () => {
      const current: ScenarioParams = {
        edges: {
          'edge-1': {
            p: { mean: 0.5, stdev: 0.1 }
          }
        }
      };
      
      const base: ScenarioParams = {
        edges: {
          'edge-1': {
            p: { mean: 0.3, stdev: 0.1 }
          }
        }
      };
      
      const diff = computeDiff(current, base, 'all');
      
      expect(diff.edges?.['edge-1']?.p?.mean).toBe(0.5);
      expect(diff.edges?.['edge-1']?.p?.stdev).toBe(0.1);
    });
  });
  
  describe('computeDiff - differences mode', () => {
    it('returns only changed fields', () => {
      const current: ScenarioParams = {
        edges: {
          'edge-1': {
            p: { mean: 0.5, stdev: 0.1 }
          }
        }
      };
      
      const base: ScenarioParams = {
        edges: {
          'edge-1': {
            p: { mean: 0.3, stdev: 0.1 }
          }
        }
      };
      
      const diff = computeDiff(current, base, 'differences');
      
      // Only mean should be in diff (changed)
      expect(diff.edges?.['edge-1']?.p?.mean).toBe(0.5);
      // stdev should not be in diff (unchanged)
      expect(diff.edges?.['edge-1']?.p?.stdev).toBeUndefined();
    });
    
    it('respects epsilon threshold', () => {
      const current: ScenarioParams = {
        edges: {
          'edge-1': {
            p: { mean: 0.5000001 }
          }
        }
      };
      
      const base: ScenarioParams = {
        edges: {
          'edge-1': {
            p: { mean: 0.5 }
          }
        }
      };
      
      // With default epsilon (1e-6), this should not show as a difference
      const diff = computeDiff(current, base, 'differences', 1e-6);
      
      expect(diff.edges).toBeUndefined();
    });
    
    it('detects differences above epsilon', () => {
      const current: ScenarioParams = {
        edges: {
          'edge-1': {
            p: { mean: 0.51 }
          }
        }
      };
      
      const base: ScenarioParams = {
        edges: {
          'edge-1': {
            p: { mean: 0.5 }
          }
        }
      };
      
      const diff = computeDiff(current, base, 'differences', 1e-6);
      
      expect(diff.edges?.['edge-1']?.p?.mean).toBe(0.51);
    });
    
    it('returns empty diff when nothing changed', () => {
      const current: ScenarioParams = {
        edges: {
          'edge-1': {
            p: { mean: 0.5 }
          }
        }
      };
      
      const base: ScenarioParams = {
        edges: {
          'edge-1': {
            p: { mean: 0.5 }
          }
        }
      };
      
      const diff = computeDiff(current, base, 'differences');
      
      expect(diff.edges).toBeUndefined();
      expect(diff.nodes).toBeUndefined();
    });
    
    it('handles new edges not in base', () => {
      const current: ScenarioParams = {
        edges: {
          'edge-1': {
            p: { mean: 0.5 }
          },
          'edge-2': {
            p: { mean: 0.7 }
          }
        }
      };
      
      const base: ScenarioParams = {
        edges: {
          'edge-1': {
            p: { mean: 0.5 }
          }
        }
      };
      
      const diff = computeDiff(current, base, 'differences');
      
      // edge-2 is new, so it should be in diff
      expect(diff.edges?.['edge-2']?.p?.mean).toBe(0.7);
      // edge-1 is unchanged, so it should not be in diff
      expect(diff.edges?.['edge-1']).toBeUndefined();
    });
  });
});




