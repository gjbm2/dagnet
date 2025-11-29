import { describe, it, expect } from 'vitest';
import { isolateSlice } from '../sliceIsolation';

describe('Slice Isolation', () => {
  describe('isolateSlice', () => {
    it('should isolate values for a specific slice', () => {
      const values = [
        { sliceDSL: 'context(channel:google)', n: 100, k: 15 },
        { sliceDSL: 'context(channel:meta)', n: 80, k: 12 },
        { sliceDSL: 'context(channel:other)', n: 20, k: 2 }
      ];
      
      const result = isolateSlice(values, 'context(channel:google)');
      
      expect(result).toHaveLength(1);
      expect(result[0].n).toBe(100);
      expect(result[0].k).toBe(15);
    });
    
    it('should handle uncontexted slice (empty string)', () => {
      const values = [
        { sliceDSL: '', n: 100, k: 15 },
        { sliceDSL: 'context(channel:google)', n: 80, k: 12 }
      ];
      
      const result = isolateSlice(values, '');
      
      expect(result).toHaveLength(1);
      expect(result[0].n).toBe(100);
    });
    
    it('should handle undefined sliceDSL as empty string', () => {
      const values = [
        { n: 100, k: 15 },  // No sliceDSL (legacy data)
        { sliceDSL: 'context(channel:google)', n: 80, k: 12 }
      ];
      
      const result = isolateSlice(values, '');
      
      expect(result).toHaveLength(1);
      expect(result[0].n).toBe(100);
    });
    
    it('should normalize slice DSL before matching', () => {
      const values = [
        { sliceDSL: 'context(channel:google)', n: 100, k: 15 }
      ];
      
      // Query with different order should still match
      const result = isolateSlice(values, 'context(channel:google)');
      
      expect(result).toHaveLength(1);
    });
    
    it('should throw error when requesting uncontexted from contexted file', () => {
      const values = [
        { sliceDSL: 'context(channel:google)', n: 100, k: 15 },
        { sliceDSL: 'context(channel:meta)', n: 80, k: 12 }
      ];
      
      // Requesting uncontexted ('') but file only has contexted data
      expect(() => isolateSlice(values, '')).toThrow('Slice isolation error');
      expect(() => isolateSlice(values, '')).toThrow('MECE aggregation');
    });
    
    it('should allow empty result for missing slice (valid scenario)', () => {
      const values = [
        { sliceDSL: 'context(channel:google)', n: 100, k: 15 }
      ];
      
      // Requesting a different context that doesn't exist
      const result = isolateSlice(values, 'context(channel:meta)');
      
      expect(result).toHaveLength(0); // Empty is valid (data not fetched yet)
    });
    
    it('should prevent cross-slice contamination', () => {
      const values = [
        { sliceDSL: 'context(channel:google)', dates: ['1-Jan-25', '2-Jan-25'] },
        { sliceDSL: 'context(channel:meta)', dates: ['2-Jan-25', '3-Jan-25'] }
      ];
      
      const googleSlice = isolateSlice(values, 'context(channel:google)');
      const metaSlice = isolateSlice(values, 'context(channel:meta)');
      
      expect(googleSlice).toHaveLength(1);
      expect(metaSlice).toHaveLength(1);
      expect(googleSlice[0].dates).toEqual(['1-Jan-25', '2-Jan-25']);
      expect(metaSlice[0].dates).toEqual(['2-Jan-25', '3-Jan-25']);
      // Critically: day 2 appears in both, but slices are separate
    });
    
    it('BUG FIX: should match when targetSlice has window but sliceDSL does not', () => {
      // This was the bug: file stores sliceDSL without window, 
      // but targetSlice from UI includes both context and window
      const values = [
        { sliceDSL: 'context(channel:google)', n: 100, k: 15 },
        { sliceDSL: 'context(channel:meta)', n: 80, k: 12 }
      ];
      
      // Query with window - should STILL match (window is ignored for slice matching)
      const result = isolateSlice(values, 'context(channel:google).window(1-Oct-25:31-Oct-25)');
      
      expect(result).toHaveLength(1);
      expect(result[0].n).toBe(100);
    });
    
    it('BUG FIX: should match different window specifications for same context', () => {
      const values = [
        { sliceDSL: 'context(channel:google)', n: 100, k: 15 }
      ];
      
      // Different windows should all match the same context
      const result1 = isolateSlice(values, 'context(channel:google).window(1-Oct-25:31-Oct-25)');
      const result2 = isolateSlice(values, 'context(channel:google).window(1-Nov-25:30-Nov-25)');
      const result3 = isolateSlice(values, 'window(-30d:).context(channel:google)');
      
      expect(result1).toHaveLength(1);
      expect(result2).toHaveLength(1);
      expect(result3).toHaveLength(1);
    });
    
    it('BUG FIX: should handle window-only targetSlice matching uncontexted data', () => {
      // When file has uncontexted data and query is just a window
      const values = [
        { sliceDSL: '', n: 100, k: 15 },
        { sliceDSL: 'context(channel:google)', n: 80, k: 12 }
      ];
      
      // Query with ONLY window (no context) should match uncontexted slice
      const result = isolateSlice(values, 'window(1-Oct-25:31-Oct-25)');
      
      expect(result).toHaveLength(1);
      expect(result[0].n).toBe(100);  // The uncontexted one
    });
  });
});

