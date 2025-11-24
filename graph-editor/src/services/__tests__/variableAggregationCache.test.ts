import { describe, it, expect, beforeEach } from 'vitest';
import { VariableAggregationCache } from '../variableAggregationCache';

describe('VariableAggregationCache', () => {
  let cache: VariableAggregationCache;
  
  beforeEach(() => {
    cache = new VariableAggregationCache();
  });
  
  it('should cache window lookups for context combinations', () => {
    const windows = [
      { sliceDSL: 'context(channel:google)', n: 100, k: 15 },
      { sliceDSL: 'context(channel:meta)', n: 80, k: 12 },
      { sliceDSL: '', n: 200, k: 30 }
    ];
    
    const result1 = cache.getWindowForContext('var1', windows, { channel: 'google' });
    expect(result1?.n).toBe(100);
    
    const result2 = cache.getWindowForContext('var1', windows, { channel: 'meta' });
    expect(result2?.n).toBe(80);
    
    const result3 = cache.getWindowForContext('var1', windows, {});
    expect(result3?.n).toBe(200);
  });
  
  it('should build index lazily (first access)', () => {
    const windows = [
      { sliceDSL: 'context(channel:google)', n: 100, k: 15 }
    ];
    
    // First access builds index
    const result1 = cache.getWindowForContext('var1', windows, { channel: 'google' });
    expect(result1?.n).toBe(100);
    
    // Second access uses cached index (would fail if windows changed without invalidation)
    const result2 = cache.getWindowForContext('var1', windows, { channel: 'google' });
    expect(result2?.n).toBe(100);
  });
  
  it('should handle multi-key context combinations', () => {
    const windows = [
      { sliceDSL: 'context(browser-type:chrome).context(channel:google)', n: 50, k: 8 }
    ];
    
    const result = cache.getWindowForContext('var1', windows, { channel: 'google', 'browser-type': 'chrome' });
    expect(result?.n).toBe(50);
  });
  
  it('should return undefined for non-existent combination', () => {
    const windows = [
      { sliceDSL: 'context(channel:google)', n: 100, k: 15 }
    ];
    
    const result = cache.getWindowForContext('var1', windows, { channel: 'meta' });
    expect(result).toBeUndefined();
  });
  
  it('should invalidate cache when requested', () => {
    const windows = [
      { sliceDSL: 'context(channel:google)', n: 100, k: 15 }
    ];
    
    cache.getWindowForContext('var1', windows, { channel: 'google' });
    cache.invalidate('var1');
    
    // After invalidation, next access rebuilds (with potentially different windows)
    const newWindows = [
      { sliceDSL: 'context(channel:google)', n: 150, k: 20 }  // Different data
    ];
    
    const result = cache.getWindowForContext('var1', newWindows, { channel: 'google' });
    expect(result?.n).toBe(150);  // Gets new data, not cached old data
  });
  
  it('should handle separate caches for different variables', () => {
    const windows1 = [{ sliceDSL: 'context(channel:google)', n: 100, k: 15 }];
    const windows2 = [{ sliceDSL: 'context(channel:google)', n: 200, k: 30 }];
    
    cache.getWindowForContext('var1', windows1, { channel: 'google' });
    cache.getWindowForContext('var2', windows2, { channel: 'google' });
    
    const result1 = cache.getWindowForContext('var1', windows1, { channel: 'google' });
    const result2 = cache.getWindowForContext('var2', windows2, { channel: 'google' });
    
    expect(result1?.n).toBe(100);
    expect(result2?.n).toBe(200);
  });
});

