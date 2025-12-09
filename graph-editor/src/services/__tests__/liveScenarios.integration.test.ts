/**
 * Live Scenarios Integration Tests
 * 
 * End-to-end tests for live scenario functionality:
 * - DSL splitting and building
 * - DSL inheritance across scenario stack
 * - Effective DSL computation
 * - Smart label generation
 * - Cache checking with checkMultipleDSLsNeedFetch
 * 
 * These tests use real service implementations with minimal mocking.
 * 
 * Design Reference: docs/current/project-live-scenarios/design.md §5.8
 * 
 * @group integration
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  splitDSLParts,
  buildFetchDSL,
  buildWhatIfDSL,
  computeInheritedDSL,
  computeEffectiveFetchDSL,
  generateSmartLabel,
  isLiveScenario,
} from '../scenarioRegenerationService';
import {
  fetchDataService,
  checkDSLNeedsFetch,
  checkMultipleDSLsNeedFetch,
} from '../fetchDataService';
import { parseConstraints, augmentDSLWithConstraint } from '../../lib/queryDSL';
import type { Graph } from '../../types';

// Mock fileRegistry with in-memory storage for cache checking tests
vi.mock('../../contexts/TabContext', () => {
  const mockFiles = new Map<string, any>();
  
  return {
    fileRegistry: {
      registerFile: vi.fn((id: string, data: any) => {
        mockFiles.set(id, { data: structuredClone(data) });
        return Promise.resolve();
      }),
      getFile: vi.fn((id: string) => {
        return mockFiles.get(id);
      }),
      updateFile: vi.fn((id: string, data: any) => {
        if (mockFiles.has(id)) {
          mockFiles.set(id, { data: structuredClone(data) });
        }
        return Promise.resolve();
      }),
      _mockFiles: mockFiles
    }
  };
});

// Mock windowAggregationService for date handling
vi.mock('../windowAggregationService', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    calculateIncrementalFetch: vi.fn().mockReturnValue({ needsFetch: false }),
    parseDate: vi.fn((dateStr: string) => {
      // Handle UK date format
      const ukMatch = dateStr.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/);
      if (ukMatch) {
        const day = parseInt(ukMatch[1], 10);
        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const month = monthNames.indexOf(ukMatch[2]);
        const year = 2000 + parseInt(ukMatch[3], 10);
        return new Date(year, month, day);
      }
      return new Date(dateStr);
    }),
  };
});

const { fileRegistry } = await import('../../contexts/TabContext');
const { calculateIncrementalFetch } = await import('../windowAggregationService');

// Helper to create mock graph
function createMockGraph(options: {
  edges?: Array<{
    uuid?: string;
    id?: string;
    p?: { id?: string; connection?: any; mean?: number };
  }>;
  nodes?: Array<{
    uuid?: string;
    id?: string;
    case?: { id?: string; connection?: any };
  }>;
  baseDSL?: string;
} = {}): Graph {
  return {
    nodes: options.nodes || [],
    edges: options.edges || [],
    baseDSL: options.baseDSL,
  } as Graph;
}

// Helper to create mock scenario
function createMockScenario(options: {
  id?: string;
  isLive?: boolean;
  queryDSL?: string;
  lastEffectiveDSL?: string;
}) {
  return {
    id: options.id || `scenario-${Date.now()}`,
    meta: {
      isLive: options.isLive ?? true,
      queryDSL: options.queryDSL,
      lastEffectiveDSL: options.lastEffectiveDSL,
    },
  };
}

describe('Live Scenarios Integration Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fileRegistry as any)._mockFiles.clear();
  });

  // ==========================================================================
  // DSL Splitting and Building - Full Roundtrip
  // ==========================================================================

  describe('DSL Splitting and Building Roundtrip', () => {
    it('should split and rebuild fetch-only DSL correctly', () => {
      const originalDSL = 'window(1-Nov-25:7-Nov-25).context(channel:google)';
      
      const { fetchParts, whatIfParts } = splitDSLParts(originalDSL);
      const rebuiltFetch = buildFetchDSL(fetchParts);
      const rebuiltWhatIf = buildWhatIfDSL(whatIfParts);
      
      // Fetch parts should contain window and context
      expect(fetchParts.window).toEqual({ start: '1-Nov-25', end: '7-Nov-25' });
      expect(fetchParts.context).toContainEqual({ key: 'channel', value: 'google' });
      
      // What-if parts should be empty
      expect(whatIfParts.cases).toEqual([]);
      expect(whatIfParts.visited).toEqual([]);
      
      // Rebuilt fetch DSL should match original
      expect(rebuiltFetch).toBe(originalDSL);
      expect(rebuiltWhatIf).toBe('');
    });

    it('should split and rebuild what-if-only DSL correctly', () => {
      const originalDSL = 'case(my-case:treatment).visited(node-a,node-b)';
      
      const { fetchParts, whatIfParts } = splitDSLParts(originalDSL);
      const rebuiltFetch = buildFetchDSL(fetchParts);
      const rebuiltWhatIf = buildWhatIfDSL(whatIfParts);
      
      // Fetch parts should be empty
      expect(fetchParts.window).toBeNull();
      expect(fetchParts.context).toEqual([]);
      
      // What-if parts should contain case and visited
      expect(whatIfParts.cases).toContainEqual({ key: 'my-case', value: 'treatment' });
      expect(whatIfParts.visited).toEqual(['node-a', 'node-b']);
      
      // Rebuilt what-if DSL should match original
      expect(rebuiltFetch).toBe('');
      expect(rebuiltWhatIf).toBe(originalDSL);
    });

    it('should split mixed DSL into fetch and what-if parts', () => {
      const mixedDSL = 'window(1-Nov-25:7-Nov-25).context(channel:google).case(my-case:treatment).visited(node-a)';
      
      const { fetchParts, whatIfParts } = splitDSLParts(mixedDSL);
      const rebuiltFetch = buildFetchDSL(fetchParts);
      const rebuiltWhatIf = buildWhatIfDSL(whatIfParts);
      
      // Fetch parts
      expect(fetchParts.window).toEqual({ start: '1-Nov-25', end: '7-Nov-25' });
      expect(fetchParts.context).toContainEqual({ key: 'channel', value: 'google' });
      
      // What-if parts
      expect(whatIfParts.cases).toContainEqual({ key: 'my-case', value: 'treatment' });
      expect(whatIfParts.visited).toEqual(['node-a']);
      
      // Rebuilt DSLs should be correct subsets
      expect(rebuiltFetch).toBe('window(1-Nov-25:7-Nov-25).context(channel:google)');
      expect(rebuiltWhatIf).toBe('case(my-case:treatment).visited(node-a)');
    });
  });

  // ==========================================================================
  // DSL Inheritance Chain - Design §5.8
  // ==========================================================================

  describe('DSL Inheritance Chain', () => {
    it('should inherit only from base when scenario is at bottom of visible stack', () => {
      // Visual order: [A] where A is at the bottom (closest to Base)
      // A (index 0, only item) inherits from nothing below it, just Base
      const baseDSL = 'window(1-Nov-25:7-Nov-25)';
      const scenarios = [
        createMockScenario({ id: 'A', isLive: true, queryDSL: 'context(channel:google)' }),
      ];
      
      const inherited = computeInheritedDSL(0, scenarios, baseDSL);
      
      expect(inherited).toBe(baseDSL);
    });

    it('should inherit from base + scenarios BELOW in visible stack', () => {
      // Visual order: [A, B] where A is TOP (index 0), B is BOTTOM (index 1, closer to Base)
      // A should inherit from B + Base
      // B should inherit from Base only
      const baseDSL = 'window(1-Nov-25:7-Nov-25)';
      const scenarios = [
        createMockScenario({ 
          id: 'A', 
          isLive: true, 
          queryDSL: 'context(channel:google)',
          lastEffectiveDSL: 'window(1-Nov-25:7-Nov-25).context(channel:google)'
        }),
        createMockScenario({ 
          id: 'B', 
          isLive: true, 
          queryDSL: 'context(region:uk)',
          lastEffectiveDSL: 'window(1-Nov-25:7-Nov-25).context(region:uk)'
        }),
      ];
      
      // A (index 0, TOP) should inherit from B (index 1, BOTTOM) + base
      const inheritedForA = computeInheritedDSL(0, scenarios, baseDSL);
      expect(inheritedForA).toContain('window');
      expect(inheritedForA).toContain('context(region:uk)'); // B's context
      
      // B (index 1, BOTTOM) should inherit from Base only
      const inheritedForB = computeInheritedDSL(1, scenarios, baseDSL);
      expect(inheritedForB).toBe(baseDSL);
    });

    it('should skip static scenarios in inheritance chain', () => {
      // Visual order: [A, B-static, C] where A=TOP, C=BOTTOM
      // A should inherit from C (skipping B-static) + Base
      const baseDSL = 'window(1-Nov-25:7-Nov-25)';
      const scenarios = [
        createMockScenario({ 
          id: 'A', 
          isLive: true, 
          queryDSL: 'context(channel:google)',
        }),
        createMockScenario({ 
          id: 'B-static', 
          isLive: false, // Static scenario - no queryDSL
          queryDSL: undefined
        }),
        createMockScenario({ 
          id: 'C', 
          isLive: true, 
          queryDSL: 'context(region:uk)',
          lastEffectiveDSL: 'window(1-Nov-25:7-Nov-25).context(region:uk)'
        }),
      ];
      
      // A (index 0, TOP) should inherit from C (index 2, BOTTOM), skipping B (static)
      const inheritedForA = computeInheritedDSL(0, scenarios, baseDSL);
      
      // Should include C's context (B is skipped because not live)
      expect(inheritedForA).toContain('context(region:uk)');
    });

    it('should compute effective fetch DSL by merging inherited + scenario DSL', () => {
      const inheritedDSL = 'window(1-Nov-25:7-Nov-25).context(region:uk)';
      const scenarioQueryDSL = 'context(channel:google)';
      
      const effectiveDSL = computeEffectiveFetchDSL(inheritedDSL, scenarioQueryDSL);
      
      // Should contain window from inherited and both contexts
      expect(effectiveDSL).toContain('window(1-Nov-25:7-Nov-25)');
      expect(effectiveDSL).toContain('context(region:uk)');
      expect(effectiveDSL).toContain('context(channel:google)');
    });

    it('should replace same-type constraints in effective DSL (smart merge)', () => {
      const inheritedDSL = 'window(1-Nov-25:7-Nov-25).context(channel:meta)';
      const scenarioQueryDSL = 'context(channel:google)'; // Same key, different value
      
      const effectiveDSL = computeEffectiveFetchDSL(inheritedDSL, scenarioQueryDSL);
      
      // Scenario's channel should REPLACE inherited channel
      expect(effectiveDSL).toContain('context(channel:google)');
      expect(effectiveDSL).not.toContain('context(channel:meta)');
    });
  });

  // ==========================================================================
  // Smart Label Generation
  // ==========================================================================

  describe('Smart Label Generation', () => {
    it('should generate smart label for context DSL', () => {
      const label = generateSmartLabel('context(channel:google)');
      
      // Should be human-readable, not raw DSL
      expect(label).toMatch(/channel.*google/i);
      expect(label).not.toBe('context(channel:google)');
    });

    it('should generate smart label for window DSL', () => {
      const label = generateSmartLabel('window(1-Nov-25:7-Nov-25)');
      
      // Should include date range
      expect(label).toMatch(/1-Nov.*7-Nov/i);
    });

    it('should generate smart label for combined DSL', () => {
      const label = generateSmartLabel('window(1-Nov-25:7-Nov-25).context(channel:google)');
      
      // Should include both parts
      expect(label.length).toBeGreaterThan(0);
    });

    it('should handle empty DSL gracefully', () => {
      const label = generateSmartLabel('');
      
      expect(label).toBe('');
    });
  });

  // ==========================================================================
  // isLiveScenario Helper
  // ==========================================================================

  describe('isLiveScenario', () => {
    // Note: isLiveScenario checks for non-empty queryDSL, not the isLive flag
    // This is because a scenario with queryDSL is functionally "live" regardless of flag
    
    it('should return true for scenario with queryDSL', () => {
      const scenario = createMockScenario({ isLive: true, queryDSL: 'context(channel:google)' });
      expect(isLiveScenario(scenario)).toBe(true);
    });

    it('should return true for scenario with queryDSL even if isLive=false', () => {
      // The function checks queryDSL presence, not the isLive flag
      const scenario = createMockScenario({ isLive: false, queryDSL: 'context(channel:google)' });
      expect(isLiveScenario(scenario)).toBe(true);
    });

    it('should return false for scenario without queryDSL', () => {
      const scenario = createMockScenario({ isLive: true, queryDSL: undefined });
      expect(isLiveScenario(scenario)).toBe(false);
    });

    it('should return false for scenario with empty queryDSL', () => {
      const scenario = createMockScenario({ isLive: true, queryDSL: '' });
      expect(isLiveScenario(scenario)).toBe(false);
    });
  });

  // ==========================================================================
  // Cache Checking - checkMultipleDSLsNeedFetch
  // ==========================================================================

  describe('checkMultipleDSLsNeedFetch Integration', () => {
    it('should check multiple DSLs and return results in order', () => {
      const graph = createMockGraph({
        edges: [{ uuid: 'edge-1', p: { id: 'param-1', connection: {} } }],
      });
      
      // Mock: all cached
      (calculateIncrementalFetch as ReturnType<typeof vi.fn>).mockReturnValue({ needsFetch: false });
      (fileRegistry.getFile as ReturnType<typeof vi.fn>).mockReturnValue({ data: { connection: {} } });
      
      const dsls = [
        'window(1-Nov-25:7-Nov-25).context(channel:google)',
        'window(8-Nov-25:14-Nov-25).context(channel:meta)',
        'window(15-Nov-25:21-Nov-25).context(channel:referral)',
      ];
      
      const results = checkMultipleDSLsNeedFetch(dsls, graph);
      
      expect(results.length).toBe(3);
      expect(results[0].dsl).toBe(dsls[0]);
      expect(results[1].dsl).toBe(dsls[1]);
      expect(results[2].dsl).toBe(dsls[2]);
    });

    it('should correctly identify which DSLs need fetch', () => {
      const graph = createMockGraph({
        edges: [{ uuid: 'edge-1', p: { id: 'param-1', connection: {} } }],
      });
      
      // Param file has a single window slice covering 1–7 Nov.
      // - First DSL (1–7 Nov) is fully covered → no fetch needed.
      // - Second DSL (8–14 Nov) lies outside header range → needs fetch.
      (fileRegistry.getFile as ReturnType<typeof vi.fn>).mockReturnValue({
        data: {
          connection: {},
          values: [
            {
              sliceDSL: 'window(1-Nov-25:7-Nov-25)',
              window_from: '1-Nov-25',
              window_to: '7-Nov-25',
            },
          ],
        },
      });
      
      const results = checkMultipleDSLsNeedFetch([
        'window(1-Nov-25:7-Nov-25)',
        'window(8-Nov-25:14-Nov-25)',
      ], graph);
      
      expect(results[0].needsFetch).toBe(false);
      expect(results[1].needsFetch).toBe(true);
    });

    it('should handle graph with no connections (nothing to fetch)', () => {
      const graph = createMockGraph({
        edges: [{ uuid: 'edge-1', p: { id: 'param-1' } }], // No connection
      });
      
      const results = checkMultipleDSLsNeedFetch([
        'window(1-Nov-25:7-Nov-25)',
      ], graph);
      
      expect(results[0].needsFetch).toBe(false);
      expect(results[0].items).toEqual([]);
    });

    it('should return items needing fetch for uncached DSLs', () => {
      const graph = createMockGraph({
        edges: [
          { uuid: 'edge-1', p: { id: 'param-1', connection: {} } },
          { uuid: 'edge-2', p: { id: 'param-2', connection: {} } },
        ],
      });
      
      (fileRegistry.getFile as ReturnType<typeof vi.fn>).mockReturnValue(null);
      
      const results = checkMultipleDSLsNeedFetch([
        'window(1-Nov-25:7-Nov-25)',
      ], graph);
      
      expect(results[0].needsFetch).toBe(true);
      expect(results[0].items.length).toBe(2);
    });
  });

  // ==========================================================================
  // Full Scenario Stack - Worked Example from Design §5.8.4
  // ==========================================================================

  describe('Full Scenario Stack - Worked Example', () => {
    it('should correctly compute inheritance for mixed live/static stack', () => {
      // Visual order (top to bottom): [A, B-static, C, D-static]
      // A = TOP (index 0), D = BOTTOM (index 3, closest to Base)
      // 
      // Inheritance (from below):
      // D (index 3, BOTTOM) inherits: Base only
      // C (index 2) inherits: D + Base (but D is static, so just Base)
      // B (index 1) inherits: C + D + Base (but B is static, doesn't matter)
      // A (index 0, TOP) inherits: B + C + D + Base (B,D static, so just C + Base)
      
      const baseDSL = 'window(1-Nov-25:7-Nov-25)';
      const scenarios = [
        createMockScenario({ 
          id: 'A', 
          isLive: true,
          queryDSL: 'context(channel:google)',
        }),
        createMockScenario({ 
          id: 'B', 
          isLive: false, // Static - skipped in inheritance
          queryDSL: undefined
        }),
        createMockScenario({ 
          id: 'C', 
          isLive: true,
          queryDSL: 'context(region:uk)',
          lastEffectiveDSL: 'window(1-Nov-25:7-Nov-25).context(region:uk)'
        }),
        createMockScenario({ 
          id: 'D', 
          isLive: false, // Static - skipped in inheritance
          queryDSL: undefined
        }),
      ];
      
      // D (index 3, BOTTOM) should inherit only from base
      const inheritedForD = computeInheritedDSL(3, scenarios, baseDSL);
      expect(inheritedForD).toBe(baseDSL);
      
      // C (index 2) should inherit from D + Base (D is static, so just Base)
      const inheritedForC = computeInheritedDSL(2, scenarios, baseDSL);
      expect(inheritedForC).toBe(baseDSL);
      
      // A (index 0, TOP) should inherit from C + Base (B,D are static)
      const inheritedForA = computeInheritedDSL(0, scenarios, baseDSL);
      expect(inheritedForA).toContain('window');
      expect(inheritedForA).toContain('context(region:uk)'); // C's context
    });

    it('should compute correct effective DSL for each live scenario in stack', () => {
      // Visual order: [A, C] where A=TOP, C=BOTTOM
      // C inherits from Base only
      // A inherits from C + Base
      
      const baseDSL = 'window(1-Nov-25:7-Nov-25)';
      const scenarios = [
        createMockScenario({ 
          id: 'A', 
          isLive: true, 
          queryDSL: 'context(channel:google)' 
        }),
        createMockScenario({ 
          id: 'C', 
          isLive: true, 
          queryDSL: 'context(region:uk)',
          lastEffectiveDSL: 'window(1-Nov-25:7-Nov-25).context(region:uk)'
        }),
      ];
      
      // C (index 1, BOTTOM) inherits only Base
      const inheritedForC = computeInheritedDSL(1, scenarios, baseDSL);
      const effectiveC = computeEffectiveFetchDSL(inheritedForC, 'context(region:uk)');
      expect(effectiveC).toContain('window(1-Nov-25:7-Nov-25)');
      expect(effectiveC).toContain('context(region:uk)');
      
      // A (index 0, TOP) inherits from C + Base
      const inheritedForA = computeInheritedDSL(0, scenarios, baseDSL);
      const effectiveA = computeEffectiveFetchDSL(inheritedForA, 'context(channel:google)');
      
      // A should have: window from base, region from C, channel from A
      expect(effectiveA).toContain('window(1-Nov-25:7-Nov-25)');
      expect(effectiveA).toContain('context(channel:google)');
      expect(effectiveA).toContain('context(region:uk)');
    });
  });

  // ==========================================================================
  // augmentDSLWithConstraint - Smart Merge
  // ==========================================================================

  describe('augmentDSLWithConstraint - Smart Merge', () => {
    it('should combine different constraint types', () => {
      const base = 'window(1-Nov-25:7-Nov-25)';
      const addition = 'context(channel:google)';
      
      const result = augmentDSLWithConstraint(base, addition);
      
      expect(result).toContain('window(1-Nov-25:7-Nov-25)');
      expect(result).toContain('context(channel:google)');
    });

    it('should replace same context key with new value', () => {
      const base = 'context(channel:meta)';
      const addition = 'context(channel:google)';
      
      const result = augmentDSLWithConstraint(base, addition);
      
      expect(result).toContain('context(channel:google)');
      expect(result).not.toContain('context(channel:meta)');
    });

    it('should replace window with new window', () => {
      const base = 'window(1-Nov-25:7-Nov-25)';
      const addition = 'window(8-Nov-25:14-Nov-25)';
      
      const result = augmentDSLWithConstraint(base, addition);
      
      expect(result).toContain('window(8-Nov-25:14-Nov-25)');
      expect(result).not.toContain('window(1-Nov-25:7-Nov-25)');
    });

    it('should preserve different context keys', () => {
      const base = 'context(channel:google)';
      const addition = 'context(region:uk)';
      
      const result = augmentDSLWithConstraint(base, addition);
      
      expect(result).toContain('context(channel:google)');
      expect(result).toContain('context(region:uk)');
    });
  });
});

