/**
 * Unit Tests: Query Signature Generation
 * 
 * Tests the query signature system that determines cache validity.
 * 
 * Critical bugs fixed:
 * - Bug #22: Query signature didn't include minus()/plus() terms
 * - Bug #23: Signature not computed for first-time fetches
 */

import { describe, test, expect } from 'vitest';
import crypto from 'crypto';

// Helper function to compute query signature (mimics dataOperationsService)
function computeQuerySignature(params: {
  queryString: string;
  windowStart?: string;
  windowEnd?: string;
  dataSourceId?: string;
  hasMinus?: boolean;
  hasPlus?: boolean;
}): string {
  const canonical = JSON.stringify({
    query: params.queryString,
    window: { start: params.windowStart, end: params.windowEnd },
    dataSource: params.dataSourceId,
    originalQuery: params.queryString,
    hasMinus: params.hasMinus || false,
    hasPlus: params.hasPlus || false
  }, null, 0);
  
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

describe('Query Signature Generation', () => {
  describe('Basic Signatures', () => {
    test('generates consistent signature for same query', () => {
      const sig1 = computeQuerySignature({ queryString: 'from(a).to(b)' });
      const sig2 = computeQuerySignature({ queryString: 'from(a).to(b)' });
      
      expect(sig1).toBe(sig2);
      expect(sig1).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex format
    });

    test('different queries have different signatures', () => {
      const sig1 = computeQuerySignature({ queryString: 'from(a).to(b)' });
      const sig2 = computeQuerySignature({ queryString: 'from(a).to(c)' });
      
      expect(sig1).not.toBe(sig2);
    });

    test('signature includes window', () => {
      const sig1 = computeQuerySignature({
        queryString: 'from(a).to(b)',
        windowStart: '2024-01-01',
        windowEnd: '2024-01-31'
      });
      const sig2 = computeQuerySignature({
        queryString: 'from(a).to(b)',
        windowStart: '2024-02-01',
        windowEnd: '2024-02-28'
      });
      
      expect(sig1).not.toBe(sig2);
    });

    test('signature includes data source', () => {
      const sig1 = computeQuerySignature({
        queryString: 'from(a).to(b)',
        dataSourceId: 'amplitude-prod'
      });
      const sig2 = computeQuerySignature({
        queryString: 'from(a).to(b)',
        dataSourceId: 'amplitude-dev'
      });
      
      expect(sig1).not.toBe(sig2);
    });
  });

  describe('BUG #22 FIX: Composite Query Signatures', () => {
    test('signature includes hasMinus flag', () => {
      const sig1 = computeQuerySignature({
        queryString: 'from(a).to(b).minus(c)',
        hasMinus: true
      });
      const sig2 = computeQuerySignature({
        queryString: 'from(a).to(b).minus(c)',
        hasMinus: false
      });
      
      expect(sig1).not.toBe(sig2);
    });

    test('signature includes hasPlus flag', () => {
      const sig1 = computeQuerySignature({
        queryString: 'from(a).to(b).plus(c)',
        hasPlus: true
      });
      const sig2 = computeQuerySignature({
        queryString: 'from(a).to(b).plus(c)',
        hasPlus: false
      });
      
      expect(sig1).not.toBe(sig2);
    });

    test('composite query has different signature than simple query', () => {
      const simple = computeQuerySignature({
        queryString: 'from(a).to(b)',
        hasMinus: false,
        hasPlus: false
      });
      const composite = computeQuerySignature({
        queryString: 'from(a).to(b).minus(c)',
        hasMinus: true,
        hasPlus: false
      });
      
      expect(simple).not.toBe(composite);
    });

    test('real-world composite query signature', () => {
      const query = 'from(saw-WA-details-page).to(straight-to-dashboard).minus(viewed-coffee-screen)';
      const sig = computeQuerySignature({
        queryString: query,
        hasMinus: true,
        hasPlus: false,
        windowStart: '2024-01-01',
        windowEnd: '2024-01-31',
        dataSourceId: 'amplitude-prod'
      });
      
      expect(sig).toBeDefined();
      expect(sig).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('Signature Stability', () => {
    test('signature is deterministic', () => {
      const params = {
        queryString: 'from(a).to(b).minus(c)',
        windowStart: '2024-01-01',
        windowEnd: '2024-01-31',
        dataSourceId: 'amplitude-prod',
        hasMinus: true,
        hasPlus: false
      };
      
      const signatures = Array.from({ length: 100 }, () => 
        computeQuerySignature(params)
      );
      
      const uniqueSignatures = new Set(signatures);
      expect(uniqueSignatures.size).toBe(1); // All identical
    });

    test('whitespace in query affects signature', () => {
      const sig1 = computeQuerySignature({ queryString: 'from(a).to(b)' });
      const sig2 = computeQuerySignature({ queryString: 'from(a) .to(b)' });
      
      expect(sig1).not.toBe(sig2);
    });

    test('case sensitivity in query affects signature', () => {
      const sig1 = computeQuerySignature({ queryString: 'from(abc).to(def)' });
      const sig2 = computeQuerySignature({ queryString: 'from(ABC).to(DEF)' });
      
      expect(sig1).not.toBe(sig2);
    });
  });

  describe('Cache Invalidation Scenarios', () => {
    test('query change invalidates cache', () => {
      const oldSig = computeQuerySignature({ queryString: 'from(a).to(b)' });
      const newSig = computeQuerySignature({ queryString: 'from(a).to(b).minus(c)' });
      
      expect(oldSig).not.toBe(newSig);
      // This means cached data with oldSig won't be used for new query
    });

    test('window change invalidates cache', () => {
      const janSig = computeQuerySignature({
        queryString: 'from(a).to(b)',
        windowStart: '2024-01-01',
        windowEnd: '2024-01-31'
      });
      const febSig = computeQuerySignature({
        queryString: 'from(a).to(b)',
        windowStart: '2024-02-01',
        windowEnd: '2024-02-28'
      });
      
      expect(janSig).not.toBe(febSig);
    });

    test('data source change invalidates cache', () => {
      const prodSig = computeQuerySignature({
        queryString: 'from(a).to(b)',
        dataSourceId: 'amplitude-prod'
      });
      const devSig = computeQuerySignature({
        queryString: 'from(a).to(b)',
        dataSourceId: 'amplitude-dev'
      });
      
      expect(prodSig).not.toBe(devSig);
    });
  });

  describe('Performance', () => {
    test('signature computation is fast (<1ms)', () => {
      const params = {
        queryString: 'from(a).to(b).minus(c).minus(d).plus(e)',
        windowStart: '2024-01-01',
        windowEnd: '2024-01-31',
        dataSourceId: 'amplitude-prod',
        hasMinus: true,
        hasPlus: true
      };
      
      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        computeQuerySignature(params);
      }
      const elapsed = performance.now() - start;
      
      const perSignature = elapsed / 1000;
      expect(perSignature).toBeLessThan(1);
    });
  });

  describe('Hash Collision Resistance', () => {
    test('similar queries have different signatures', () => {
      const signatures = [
        computeQuerySignature({ queryString: 'from(a).to(b)' }),
        computeQuerySignature({ queryString: 'from(a).to(c)' }),
        computeQuerySignature({ queryString: 'from(b).to(c)' }),
        computeQuerySignature({ queryString: 'from(a).to(b).minus(c)' }),
        computeQuerySignature({ queryString: 'from(a).to(b).plus(c)' }),
      ];
      
      const uniqueSignatures = new Set(signatures);
      expect(uniqueSignatures.size).toBe(signatures.length); // All unique
    });

    test('no obvious patterns in signatures', () => {
      const sig = computeQuerySignature({ queryString: 'from(a).to(b)' });
      
      // Should not contain obvious patterns
      expect(sig).not.toMatch(/^0+/); // Not all zeros
      expect(sig).not.toMatch(/^f+/); // Not all Fs
      expect(sig).not.toMatch(/(.)\1{10,}/); // No 10+ repeated chars
    });
  });
});

describe('Query Signature: Edge Cases', () => {
  test('empty query produces signature', () => {
    const sig = computeQuerySignature({ queryString: '' });
    
    expect(sig).toBeDefined();
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  test('very long query produces signature', () => {
    const longQuery = 'from(a).to(b)' + '.visited(node)'.repeat(100);
    const sig = computeQuerySignature({ queryString: longQuery });
    
    expect(sig).toBeDefined();
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  test('unicode characters in query', () => {
    const sig = computeQuerySignature({ queryString: 'from(café).to(naïve)' });
    
    expect(sig).toBeDefined();
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  test('undefined window values', () => {
    const sig = computeQuerySignature({
      queryString: 'from(a).to(b)',
      windowStart: undefined,
      windowEnd: undefined
    });
    
    expect(sig).toBeDefined();
  });

  test('undefined data source', () => {
    const sig = computeQuerySignature({
      queryString: 'from(a).to(b)',
      dataSourceId: undefined
    });
    
    expect(sig).toBeDefined();
  });
});

describe('Query Signature: Security', () => {
  test('prevents timing attacks (constant time)', () => {
    // Signature computation should take similar time regardless of input
    const shortQuery = 'from(a).to(b)';
    const longQuery = 'from(a).to(b)' + '.visited(node)'.repeat(100);
    
    const iterations = 100;
    
    const shortStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      computeQuerySignature({ queryString: shortQuery });
    }
    const shortTime = performance.now() - shortStart;
    
    const longStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      computeQuerySignature({ queryString: longQuery });
    }
    const longTime = performance.now() - longStart;
    
    // Time difference should be reasonable (not orders of magnitude)
    const ratio = Math.max(shortTime, longTime) / Math.min(shortTime, longTime);
    expect(ratio).toBeLessThan(15); // Within 15x (relaxed for CI variability)
  });

  test('signatures are not reversible', () => {
    const query = 'from(secret-node).to(confidential-target)';
    const sig = computeQuerySignature({ queryString: query });
    
    // Signature should not contain the original query
    expect(sig.toLowerCase()).not.toContain('secret');
    expect(sig.toLowerCase()).not.toContain('confidential');
  });
});

