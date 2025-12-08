import { describe, it, expect, vi, beforeEach } from 'vitest';
import { explodeDSL, countAtomicSlices } from '../dslExplosion';
import { contextRegistry } from '../../services/contextRegistry';
import type { ContextDefinition } from '../../services/contextRegistry';

describe('DSL Explosion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Mock channel context
    const channelContext: ContextDefinition = {
      id: 'channel',
      name: 'Channel',
      description: 'Test',
      type: 'categorical',
      values: [
        { id: 'google', label: 'Google' },
        { id: 'meta', label: 'Meta' }
      ],
      metadata: { created_at: '2025-01-01T00:00:00Z', version: '1.0.0', status: 'active' }
    };
    
    // Mock browser context
    const browserContext: ContextDefinition = {
      id: 'browser',
      name: 'Browser',
      description: 'Test',
      type: 'categorical',
      values: [
        { id: 'chrome', label: 'Chrome' },
        { id: 'safari', label: 'Safari' }
      ],
      metadata: { created_at: '2025-01-01T00:00:00Z', version: '1.0.0', status: 'active' }
    };
    
    vi.spyOn(contextRegistry, 'getContext').mockImplementation(async (id: string) => {
      if (id === 'channel') return channelContext;
      if (id === 'browser') return browserContext;
      return undefined;
    });
    
    vi.spyOn(contextRegistry, 'getValuesForContext').mockImplementation(async (id: string) => {
      if (id === 'channel') return channelContext.values;
      if (id === 'browser') return browserContext.values;
      return [];
    });
  });
  
  describe('Simple semicolon expansion', () => {
    it('should expand a;b;c to 3 slices', async () => {
      const result = await explodeDSL('context(channel:google);context(channel:meta);context(browser:chrome)');
      
      expect(result).toHaveLength(3);
      expect(result).toContain('context(channel:google)');
      expect(result).toContain('context(channel:meta)');
      expect(result).toContain('context(browser:chrome)');
    });
  });
  
  describe('or() operator', () => {
    it('should expand or(a,b,c) to 3 slices', async () => {
      const result = await explodeDSL('or(context(channel:google),context(channel:meta),context(browser:chrome))');
      
      expect(result).toHaveLength(3);
    });
    
    it('should handle or() with n terms', async () => {
      const result = await explodeDSL('or(context(channel:google),context(channel:meta))');
      
      expect(result).toHaveLength(2);
    });
  });
  
  describe('Parenthesized expressions with window', () => {
    it('should apply window to all terms in (a;b).window(...)', async () => {
      const result = await explodeDSL('(context(channel:google);context(channel:meta)).window(1-Jan-25:31-Dec-25)');
      
      expect(result).toHaveLength(2);
      expect(result[0]).toContain('window(1-Jan-25:31-Dec-25)');
      expect(result[1]).toContain('window(1-Jan-25:31-Dec-25)');
    });
    
    it('should handle or() with window', async () => {
      const result = await explodeDSL('or(context(browser:chrome),context(channel:test)).window(1-Jan-25:31-Dec-25)');
      
      expect(result).toHaveLength(2);
      expect(result.every(s => s.includes('window('))).toBe(true);
    });
  });
  
  describe('Bare key expansion', () => {
    it('should expand context(channel) to all channel values', async () => {
      const result = await explodeDSL('context(channel)');
      
      expect(result).toHaveLength(2); // google, meta
      expect(result).toContain('context(channel:google)');
      expect(result).toContain('context(channel:meta)');
    });
    
    it('should expand multiple bare keys (Cartesian product)', async () => {
      const result = await explodeDSL('context(channel).context(browser)');
      
      // 2 channels × 2 browsers = 4 combinations
      expect(result).toHaveLength(4);
      expect(result).toContain('context(browser:chrome).context(channel:google)');
      expect(result).toContain('context(browser:chrome).context(channel:meta)');
      expect(result).toContain('context(browser:safari).context(channel:google)');
      expect(result).toContain('context(browser:safari).context(channel:meta)');
    });
  });
  
  describe('Nesting', () => {
    it('should handle or(a,or(b,c))', async () => {
      const result = await explodeDSL('or(context(channel:google),or(context(channel:meta),context(browser:chrome)))');
      
      expect(result).toHaveLength(3);
    });
  });
  
  describe('Mixed syntax', () => {
    it('should handle a;or(b,c);d', async () => {
      const result = await explodeDSL('context(channel:google);or(context(channel:meta),context(browser:chrome));context(browser:safari)');
      
      expect(result).toHaveLength(4); // google, meta, chrome, safari
    });
  });
  
  describe('countAtomicSlices', () => {
    it('should return slice count without full expansion', async () => {
      const count = await countAtomicSlices('context(channel);context(browser)');
      
      // Two clauses with bare keys: channel expands to 2, browser expands to 2
      // Total: 2 + 2 = 4 slices (not Cartesian - they're semicolon-separated)
      expect(count).toBe(4);
    });
  });

  // ============================================================
  // Cohort Explosion Tests (C2-T.2)
  // ============================================================

  describe('Cohort explosion', () => {
    it('should pass cohort through with context as single atomic slice', async () => {
      const result = await explodeDSL('cohort(-30d:).context(channel:google)');
      
      expect(result).toHaveLength(1);
      expect(result[0]).toContain('cohort(-30d:)');
      expect(result[0]).toContain('context(channel:google)');
    });

    it('should expand or(cohort, window) to two separate slices', async () => {
      const result = await explodeDSL('or(cohort(-30d:),window(-7d:))');
      
      expect(result).toHaveLength(2);
      // One slice should have cohort, other should have window
      const hasCohort = result.some(s => s.includes('cohort(-30d:)'));
      const hasWindow = result.some(s => s.includes('window(-7d:)'));
      expect(hasCohort).toBe(true);
      expect(hasWindow).toBe(true);
    });

    it('should expand or(cohort, window) with context to four slices (2×2)', async () => {
      const result = await explodeDSL('or(cohort(-30d:),window(-7d:)).context(channel)');
      
      // 2 time slices × 2 channel values = 4 slices
      expect(result).toHaveLength(4);
      
      // Check that each time slice appears with each channel value
      const cohortGoogle = result.some(s => s.includes('cohort(-30d:)') && s.includes('channel:google'));
      const cohortMeta = result.some(s => s.includes('cohort(-30d:)') && s.includes('channel:meta'));
      const windowGoogle = result.some(s => s.includes('window(-7d:)') && s.includes('channel:google'));
      const windowMeta = result.some(s => s.includes('window(-7d:)') && s.includes('channel:meta'));
      
      expect(cohortGoogle).toBe(true);
      expect(cohortMeta).toBe(true);
      expect(windowGoogle).toBe(true);
      expect(windowMeta).toBe(true);
    });

    it('should apply cohort to all semicolon-separated context terms', async () => {
      const result = await explodeDSL('(context(channel:google);context(channel:meta)).cohort(-30d:)');
      
      expect(result).toHaveLength(2);
      expect(result.every(s => s.includes('cohort(-30d:)'))).toBe(true);
    });

    it('should preserve cohort with contextAny (not expanded)', async () => {
      const result = await explodeDSL('cohort(-30d:).contextAny(channel:google,channel:meta)');
      
      // contextAny is passed through as-is (not expanded by dslExplosion)
      // The OR semantics are handled at query execution time
      expect(result).toHaveLength(1);
      expect(result[0]).toContain('cohort(-30d:)');
      expect(result[0]).toContain('contextAny(channel:google,channel:meta)');
    });

    it('should preserve cohort anchor in explosion', async () => {
      const result = await explodeDSL('cohort(start-node,-14d:).context(channel:google)');
      
      expect(result).toHaveLength(1);
      expect(result[0]).toContain('cohort(start-node,-14d:)');
    });
  });
});

