/**
 * Unit tests for sheetsContextFallback (Phase 4)
 * 
 * Tests fallback policy for Sheets adapter with context HRNs.
 */

import { describe, it, expect } from 'vitest';
import { resolveSheetParameter, removeContextFromHRN } from '../sheetsContextFallback';

describe('sheetsContextFallback', () => {
  
  // ===========================================
  // resolveSheetParameter Tests
  // ===========================================

  describe('resolveSheetParameter - exact match', () => {
    
    it('should return exact match when HRN exists', () => {
      const hrn = 'e.edge-1.context(channel:google).p.mean';
      const paramPack = {
        'e.edge-1.context(channel:google).p.mean': 0.62,
        'e.edge-1.p.mean': 0.50
      };
      
      const result = resolveSheetParameter(hrn, paramPack, 'fallback');
      
      expect(result.value).toBe(0.62);
      expect(result.usedFallback).toBe(false);
      expect(result.warning).toBeUndefined();
    });

    it('should return value without warning for exact match', () => {
      const hrn = 'e.edge-1.window(-30d:).p.mean';
      const paramPack = {
        'e.edge-1.window(-30d:).p.mean': 0.55
      };
      
      const result = resolveSheetParameter(hrn, paramPack, 'fallback');
      
      expect(result.value).toBe(0.55);
      expect(result.usedFallback).toBe(false);
    });
  });

  describe('resolveSheetParameter - fallback policy', () => {
    
    it('should fallback to uncontexted HRN when contexted not found', () => {
      const hrn = 'e.edge-1.context(channel:google).p.mean';
      const paramPack = {
        'e.edge-1.p.mean': 0.50 // Only uncontexted exists
      };
      
      const result = resolveSheetParameter(hrn, paramPack, 'fallback');
      
      expect(result.value).toBe(0.50);
      expect(result.usedFallback).toBe(true);
      expect(result.warning).toBeDefined();
      expect(result.warning).toContain('fallback');
      expect(result.warning).toContain('e.edge-1.context(channel:google).p.mean');
    });

    it('should return null with strict policy when not found', () => {
      const hrn = 'e.edge-1.context(channel:google).p.mean';
      const paramPack = {
        'e.edge-1.p.mean': 0.50
      };
      
      const result = resolveSheetParameter(hrn, paramPack, 'strict');
      
      expect(result.value).toBeNull();
      expect(result.usedFallback).toBe(false);
      expect(result.warning).toBeDefined();
      expect(result.warning).toContain('strict mode');
    });

    it('should fallback for window HRN', () => {
      const hrn = 'e.edge-1.window(-90d:).p.stdev';
      const paramPack = {
        'e.edge-1.p.stdev': 0.08
      };
      
      const result = resolveSheetParameter(hrn, paramPack, 'fallback');
      
      expect(result.value).toBe(0.08);
      expect(result.usedFallback).toBe(true);
      expect(result.warning).toContain('window(-90d:)');
    });

    it('should fallback for contextAny HRN', () => {
      const hrn = 'e.edge-1.contextAny(channel:google,channel:meta).p.mean';
      const paramPack = {
        'e.edge-1.p.mean': 0.45
      };
      
      const result = resolveSheetParameter(hrn, paramPack, 'fallback');
      
      expect(result.value).toBe(0.45);
      expect(result.usedFallback).toBe(true);
      expect(result.warning).toContain('contextAny');
    });

    it('should fallback for combined context + window HRN', () => {
      const hrn = 'e.edge-1.context(channel:google).window(-30d:).p.mean';
      const paramPack = {
        'e.edge-1.p.mean': 0.52
      };
      
      const result = resolveSheetParameter(hrn, paramPack, 'fallback');
      
      expect(result.value).toBe(0.52);
      expect(result.usedFallback).toBe(true);
      expect(result.warning).toContain('context(channel:google)');
      expect(result.warning).toContain('window(-30d:)');
    });
  });

  describe('resolveSheetParameter - edge cases', () => {
    
    it('should return null when neither contexted nor uncontexted exists', () => {
      const hrn = 'e.edge-1.context(channel:google).p.mean';
      const paramPack = {
        'e.edge-2.p.mean': 0.50 // Different edge
      };
      
      const result = resolveSheetParameter(hrn, paramPack, 'fallback');
      
      expect(result.value).toBeNull();
      expect(result.usedFallback).toBe(false);
    });

    it('should handle cost params with context', () => {
      const hrn = 'e.checkout-to-purchase.context(region:us).cost_gbp.mean';
      const paramPack = {
        'e.checkout-to-purchase.cost_gbp.mean': 12.50
      };
      
      const result = resolveSheetParameter(hrn, paramPack, 'fallback');
      
      expect(result.value).toBe(12.50);
      expect(result.usedFallback).toBe(true);
      expect(result.warning).toContain('cost_gbp');
    });

    it('should handle nested constraints', () => {
      const hrn = 'e.edge-1.visited(promo).context(channel:google).p.mean';
      const paramPack = {
        'e.edge-1.visited(promo).p.mean': 0.60
      };
      
      const result = resolveSheetParameter(hrn, paramPack, 'fallback');
      
      expect(result.value).toBe(0.60);
      expect(result.usedFallback).toBe(true);
    });
  });

  // ===========================================
  // removeContextFromHRN Tests
  // ===========================================

  describe('removeContextFromHRN', () => {
    
    it('should strip context() from HRN', () => {
      const hrn = 'e.edge-1.context(channel:google).p.mean';
      const stripped = removeContextFromHRN(hrn);
      
      expect(stripped).toBe('e.edge-1.p.mean');
    });

    it('should strip window() from HRN', () => {
      const hrn = 'e.edge-1.window(-30d:).p.mean';
      const stripped = removeContextFromHRN(hrn);
      
      expect(stripped).toBe('e.edge-1.p.mean');
    });

    it('should strip contextAny() from HRN', () => {
      const hrn = 'e.edge-1.contextAny(channel:google,channel:meta).p.mean';
      const stripped = removeContextFromHRN(hrn);
      
      expect(stripped).toBe('e.edge-1.p.mean');
    });

    it('should strip multiple constraints from HRN', () => {
      const hrn = 'e.edge-1.context(channel:google).context(device:mobile).window(-30d:).p.mean';
      const stripped = removeContextFromHRN(hrn);
      
      expect(stripped).toBe('e.edge-1.p.mean');
    });

    it('should preserve visited() and other non-context constraints', () => {
      const hrn = 'e.edge-1.visited(promo).context(channel:google).p.mean';
      const stripped = removeContextFromHRN(hrn);
      
      expect(stripped).toBe('e.edge-1.visited(promo).p.mean');
    });

    it('should handle case() constraints', () => {
      const hrn = 'e.edge-1.case(exp:variant).context(channel:google).p.mean';
      const stripped = removeContextFromHRN(hrn);
      
      expect(stripped).toBe('e.edge-1.case(exp:variant).p.mean');
    });

    it('should handle HRN without context (no-op)', () => {
      const hrn = 'e.edge-1.p.mean';
      const stripped = removeContextFromHRN(hrn);
      
      expect(stripped).toBe('e.edge-1.p.mean');
    });

    it('should handle HRN with only visited (no context)', () => {
      const hrn = 'e.edge-1.visited(a,b).p.mean';
      const stripped = removeContextFromHRN(hrn);
      
      expect(stripped).toBe('e.edge-1.visited(a,b).p.mean');
    });

    it('should strip context from cost params', () => {
      const hrn = 'e.edge-1.context(region:us).cost_gbp.mean';
      const stripped = removeContextFromHRN(hrn);
      
      expect(stripped).toBe('e.edge-1.cost_gbp.mean');
    });
  });

  // ===========================================
  // Warning Message Tests
  // ===========================================

  describe('warning messages', () => {
    
    it('should generate descriptive warning for single context', () => {
      const hrn = 'e.edge-1.context(channel:google).p.mean';
      const paramPack = { 'e.edge-1.p.mean': 0.50 };
      
      const result = resolveSheetParameter(hrn, paramPack, 'fallback');
      
      expect(result.warning).toContain('fallback');
      expect(result.warning).toContain('e.edge-1.context(channel:google).p.mean');
      expect(result.warning).toContain('e.edge-1.p.mean');
    });

    it('should include HRN details in warning', () => {
      const hrn = 'e.edge-1.context(channel:google).p.mean';
      const paramPack = { 'e.edge-1.p.mean': 0.50 };
      
      const result = resolveSheetParameter(hrn, paramPack, 'fallback');
      
      expect(result.warning).toContain('edge-1');
      expect(result.warning).toContain('p.mean');
    });
  });
});

