/**
 * Unit tests for ParamPackDSLService context extensions (Phase 4)
 * 
 * Tests contextAny and window HRN patterns added in Phase 4.
 */

import { describe, it, expect } from 'vitest';
import {
  flattenParams,
  unflattenParams,
} from '../ParamPackDSLService';
import type { ScenarioParams } from '../../types/scenarios';

describe('ParamPackDSLService - Context Extensions (Phase 4)', () => {
  
  // ===========================================
  // contextAny HRN Tests
  // ===========================================

  describe('contextAny HRN patterns', () => {
    
    it('should parse contextAny with single key-value pair', () => {
      const flat = {
        'e.edge-1.contextAny(channel:google).p.mean': 0.6,
        'e.edge-1.contextAny(channel:google).p.stdev': 0.05
      };
      
      const unflat = unflattenParams(flat);
      
      expect(unflat.edges).toBeDefined();
      expect(unflat.edges!['edge-1']).toBeDefined();
      expect(unflat.edges!['edge-1'].conditional_p).toBeDefined();
      expect(unflat.edges!['edge-1'].conditional_p!['contextAny(channel:google)']).toEqual({
        mean: 0.6,
        stdev: 0.05
      });
    });

    it('should parse contextAny with multiple values (OR within key)', () => {
      const flat = {
        'e.edge-1.contextAny(channel:google,channel:meta).p.mean': 0.7
      };
      
      const unflat = unflattenParams(flat);
      
      expect(unflat.edges!['edge-1'].conditional_p!['contextAny(channel:google,channel:meta)']).toEqual({
        mean: 0.7
      });
    });

    it('should parse contextAny with multiple keys (AND across keys)', () => {
      const flat = {
        'e.edge-1.contextAny(channel:google,device:mobile).p.mean': 0.5
      };
      
      const unflat = unflattenParams(flat);
      
      expect(unflat.edges!['edge-1'].conditional_p!['contextAny(channel:google,device:mobile)']).toEqual({
        mean: 0.5
      });
    });

    it('should round-trip contextAny params', () => {
      const params: ScenarioParams = {
        edges: {
          'edge-1': {
            conditional_p: {
              'contextAny(channel:google,channel:meta)': { mean: 0.7, stdev: 0.1 }
            }
          }
        }
      };
      
      const flat = flattenParams(params);
      expect(flat['e.edge-1.contextAny(channel:google,channel:meta).p.mean']).toBe(0.7);
      expect(flat['e.edge-1.contextAny(channel:google,channel:meta).p.stdev']).toBe(0.1);
      
      const unflat = unflattenParams(flat);
      expect(unflat.edges).toEqual(params.edges);
    });
  });

  // ===========================================
  // window HRN Tests
  // ===========================================

  describe('window HRN patterns', () => {
    
    it('should parse window with relative offset', () => {
      const flat = {
        'e.edge-1.window(-30d:).p.mean': 0.45
      };
      
      const unflat = unflattenParams(flat);
      
      expect(unflat.edges!['edge-1'].conditional_p!['window(-30d:)']).toEqual({
        mean: 0.45
      });
    });

    it('should parse window with date range', () => {
      const flat = {
        'e.edge-1.window(1-Jan-25:31-Dec-25).p.mean': 0.55,
        'e.edge-1.window(1-Jan-25:31-Dec-25).p.stdev': 0.08
      };
      
      const unflat = unflattenParams(flat);
      
      expect(unflat.edges!['edge-1'].conditional_p!['window(1-Jan-25:31-Dec-25)']).toEqual({
        mean: 0.55,
        stdev: 0.08
      });
    });

    it('should parse window with relative range', () => {
      const flat = {
        'e.edge-1.window(-2w:-1w).p.mean': 0.42
      };
      
      const unflat = unflattenParams(flat);
      
      expect(unflat.edges!['edge-1'].conditional_p!['window(-2w:-1w)']).toEqual({
        mean: 0.42
      });
    });

    it('should round-trip window params', () => {
      const params: ScenarioParams = {
        edges: {
          'edge-1': {
            conditional_p: {
              'window(-90d:)': { mean: 0.38, stdev: 0.12 }
            }
          }
        }
      };
      
      const flat = flattenParams(params);
      expect(flat['e.edge-1.window(-90d:).p.mean']).toBe(0.38);
      
      const unflat = unflattenParams(flat);
      expect(unflat.edges).toEqual(params.edges);
    });
  });

  // ===========================================
  // Combined Patterns
  // ===========================================

  describe('combined context and window patterns', () => {
    
    it('should parse context + window', () => {
      const flat = {
        'e.edge-1.context(channel:google).window(-30d:).p.mean': 0.62
      };
      
      const unflat = unflattenParams(flat);
      
      expect(unflat.edges!['edge-1'].conditional_p!['context(channel:google).window(-30d:)']).toEqual({
        mean: 0.62
      });
    });

    it('should parse contextAny + window', () => {
      const flat = {
        'e.edge-1.contextAny(channel:google,channel:meta).window(-90d:).p.mean': 0.71
      };
      
      const unflat = unflattenParams(flat);
      
      expect(unflat.edges!['edge-1'].conditional_p!['contextAny(channel:google,channel:meta).window(-90d:)']).toEqual({
        mean: 0.71
      });
    });

    it('should parse multiple contexts + window', () => {
      const flat = {
        'e.edge-1.context(channel:google).context(device:mobile).window(1-Jan-25:31-Dec-25).p.mean': 0.58
      };
      
      const unflat = unflattenParams(flat);
      
      expect(unflat.edges!['edge-1'].conditional_p!['context(channel:google).context(device:mobile).window(1-Jan-25:31-Dec-25)']).toEqual({
        mean: 0.58
      });
    });

    it('should round-trip complex combined params', () => {
      const params: ScenarioParams = {
        edges: {
          'signup-to-purchase': {
            p: { mean: 0.5 },
            conditional_p: {
              'context(channel:google).window(-30d:)': { mean: 0.62, stdev: 0.08 },
              'contextAny(channel:meta,channel:organic).window(-90d:)': { mean: 0.45 }
            }
          }
        }
      };
      
      const flat = flattenParams(params);
      const unflat = unflattenParams(flat);
      
      expect(unflat.edges).toEqual(params.edges);
    });
  });

  // ===========================================
  // Edge Cases
  // ===========================================

  describe('edge cases', () => {
    
    it('should handle window with empty start (:-30d)', () => {
      const flat = {
        'e.edge-1.window(:-30d).p.mean': 0.40
      };
      
      const unflat = unflattenParams(flat);
      
      expect(unflat.edges!['edge-1'].conditional_p!['window(:-30d)']).toEqual({
        mean: 0.40
      });
    });

    it('should handle window with empty end (-30d:)', () => {
      const flat = {
        'e.edge-1.window(-30d:).p.mean': 0.48
      };
      
      const unflat = unflattenParams(flat);
      
      expect(unflat.edges!['edge-1'].conditional_p!['window(-30d:)']).toEqual({
        mean: 0.48
      });
    });

    it('should handle contextAny with hyphens in key names', () => {
      const flat = {
        'e.edge-1.contextAny(browser-type:chrome,browser-type:safari).p.mean': 0.65
      };
      
      const unflat = unflattenParams(flat);
      
      expect(unflat.edges!['edge-1'].conditional_p!['contextAny(browser-type:chrome,browser-type:safari)']).toEqual({
        mean: 0.65
      });
    });
  });
});

