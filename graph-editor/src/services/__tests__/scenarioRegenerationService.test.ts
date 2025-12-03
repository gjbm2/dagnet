/**
 * Scenario Regeneration Service Unit Tests
 * 
 * Tests the core logic for live scenario regeneration:
 * - DSL splitting (fetch vs what-if parts)
 * - DSL building from parts
 * - Effective params computation
 * - DSL inheritance chain
 * 
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  splitDSLParts,
  buildFetchDSL,
  buildWhatIfDSL,
  computeInheritedDSL,
  computeEffectiveFetchDSL,
  isLiveScenario,
  generateSmartLabel,
  prepareScenariosForBatch,
  type FetchParts,
  type WhatIfParts,
  type ScenarioForBatch,
} from '../scenarioRegenerationService';

// ==========================================================================
// splitDSLParts tests
// ==========================================================================

describe('splitDSLParts', () => {
  it('should return empty parts for null/undefined DSL', () => {
    const result = splitDSLParts(null);
    
    expect(result.fetchParts.window).toBeNull();
    expect(result.fetchParts.context).toEqual([]);
    expect(result.fetchParts.contextAny).toEqual([]);
    expect(result.whatIfParts.cases).toEqual([]);
    expect(result.whatIfParts.visited).toEqual([]);
    expect(result.whatIfParts.visitedAny).toEqual([]);
    expect(result.whatIfParts.exclude).toEqual([]);
  });

  it('should return empty parts for empty string', () => {
    const result = splitDSLParts('');
    
    expect(result.fetchParts.window).toBeNull();
    expect(result.fetchParts.context).toEqual([]);
  });

  it('should extract window into fetch parts', () => {
    const result = splitDSLParts('window(-30d:-1d)');
    
    expect(result.fetchParts.window).toEqual({ start: '-30d', end: '-1d' });
    expect(result.whatIfParts.cases).toEqual([]);
  });

  it('should extract context into fetch parts', () => {
    const result = splitDSLParts('context(channel:google)');
    
    expect(result.fetchParts.context).toEqual([{ key: 'channel', value: 'google' }]);
    expect(result.fetchParts.window).toBeNull();
  });

  it('should extract bare context key into fetch parts', () => {
    const result = splitDSLParts('context(channel)');
    
    expect(result.fetchParts.context).toEqual([{ key: 'channel', value: '' }]);
  });

  it('should extract case into what-if parts', () => {
    const result = splitDSLParts('case(my-case:treatment)');
    
    expect(result.whatIfParts.cases).toEqual([{ key: 'my-case', value: 'treatment' }]);
    expect(result.fetchParts.window).toBeNull();
  });

  it('should extract visited into what-if parts', () => {
    const result = splitDSLParts('visited(node-a,node-b)');
    
    expect(result.whatIfParts.visited).toContain('node-a');
    expect(result.whatIfParts.visited).toContain('node-b');
  });

  it('should extract exclude into what-if parts', () => {
    const result = splitDSLParts('exclude(node-x)');
    
    expect(result.whatIfParts.exclude).toContain('node-x');
  });

  it('should correctly split mixed DSL with both fetch and what-if elements', () => {
    const result = splitDSLParts('window(-30d:-1d).context(channel:google).case(my-case:treatment).visited(node-a)');
    
    // Fetch parts
    expect(result.fetchParts.window).toEqual({ start: '-30d', end: '-1d' });
    expect(result.fetchParts.context).toEqual([{ key: 'channel', value: 'google' }]);
    
    // What-if parts
    expect(result.whatIfParts.cases).toEqual([{ key: 'my-case', value: 'treatment' }]);
    expect(result.whatIfParts.visited).toContain('node-a');
  });

  it('should handle multiple context values', () => {
    const result = splitDSLParts('context(channel:google).context(browser:chrome)');
    
    expect(result.fetchParts.context).toHaveLength(2);
    expect(result.fetchParts.context).toContainEqual({ key: 'channel', value: 'google' });
    expect(result.fetchParts.context).toContainEqual({ key: 'browser', value: 'chrome' });
  });

  it('should handle multiple case overrides', () => {
    const result = splitDSLParts('case(case-a:variant-1).case(case-b:variant-2)');
    
    expect(result.whatIfParts.cases).toHaveLength(2);
    expect(result.whatIfParts.cases).toContainEqual({ key: 'case-a', value: 'variant-1' });
    expect(result.whatIfParts.cases).toContainEqual({ key: 'case-b', value: 'variant-2' });
  });
});

// ==========================================================================
// buildFetchDSL tests
// ==========================================================================

describe('buildFetchDSL', () => {
  it('should return empty string for empty parts', () => {
    const parts: FetchParts = { window: null, context: [], contextAny: [] };
    
    expect(buildFetchDSL(parts)).toBe('');
  });

  it('should build window-only DSL', () => {
    const parts: FetchParts = {
      window: { start: '-30d', end: '-1d' },
      context: [],
      contextAny: [],
    };
    
    expect(buildFetchDSL(parts)).toBe('window(-30d:-1d)');
  });

  it('should build context-only DSL', () => {
    const parts: FetchParts = {
      window: null,
      context: [{ key: 'channel', value: 'google' }],
      contextAny: [],
    };
    
    expect(buildFetchDSL(parts)).toBe('context(channel:google)');
  });

  it('should build bare context key DSL', () => {
    const parts: FetchParts = {
      window: null,
      context: [{ key: 'channel', value: '' }],
      contextAny: [],
    };
    
    expect(buildFetchDSL(parts)).toBe('context(channel)');
  });

  it('should build combined window + context DSL', () => {
    const parts: FetchParts = {
      window: { start: '1-Nov-25', end: '30-Nov-25' },
      context: [{ key: 'channel', value: 'google' }],
      contextAny: [],
    };
    
    const result = buildFetchDSL(parts);
    expect(result).toContain('window(1-Nov-25:30-Nov-25)');
    expect(result).toContain('context(channel:google)');
  });

  it('should build multiple contexts DSL', () => {
    const parts: FetchParts = {
      window: null,
      context: [
        { key: 'channel', value: 'google' },
        { key: 'browser', value: 'chrome' },
      ],
      contextAny: [],
    };
    
    const result = buildFetchDSL(parts);
    expect(result).toContain('context(channel:google)');
    expect(result).toContain('context(browser:chrome)');
  });

  it('should handle empty window start/end', () => {
    const parts: FetchParts = {
      window: { start: '', end: '-1d' },
      context: [],
      contextAny: [],
    };
    
    expect(buildFetchDSL(parts)).toBe('window(:-1d)');
  });
});

// ==========================================================================
// buildWhatIfDSL tests
// ==========================================================================

describe('buildWhatIfDSL', () => {
  it('should return empty string for empty parts', () => {
    const parts: WhatIfParts = { cases: [], visited: [], visitedAny: [], exclude: [] };
    
    expect(buildWhatIfDSL(parts)).toBe('');
  });

  it('should build case-only DSL', () => {
    const parts: WhatIfParts = {
      cases: [{ key: 'my-case', value: 'treatment' }],
      visited: [],
      visitedAny: [],
      exclude: [],
    };
    
    expect(buildWhatIfDSL(parts)).toBe('case(my-case:treatment)');
  });

  it('should build visited-only DSL', () => {
    const parts: WhatIfParts = {
      cases: [],
      visited: ['node-a', 'node-b'],
      visitedAny: [],
      exclude: [],
    };
    
    expect(buildWhatIfDSL(parts)).toBe('visited(node-a,node-b)');
  });

  it('should build exclude-only DSL', () => {
    const parts: WhatIfParts = {
      cases: [],
      visited: [],
      visitedAny: [],
      exclude: ['node-x'],
    };
    
    expect(buildWhatIfDSL(parts)).toBe('exclude(node-x)');
  });

  it('should build combined what-if DSL', () => {
    const parts: WhatIfParts = {
      cases: [{ key: 'my-case', value: 'treatment' }],
      visited: ['node-a'],
      visitedAny: [],
      exclude: ['node-x'],
    };
    
    const result = buildWhatIfDSL(parts);
    expect(result).toContain('case(my-case:treatment)');
    expect(result).toContain('visited(node-a)');
    expect(result).toContain('exclude(node-x)');
  });

  it('should build multiple cases DSL', () => {
    const parts: WhatIfParts = {
      cases: [
        { key: 'case-a', value: 'variant-1' },
        { key: 'case-b', value: 'variant-2' },
      ],
      visited: [],
      visitedAny: [],
      exclude: [],
    };
    
    const result = buildWhatIfDSL(parts);
    expect(result).toContain('case(case-a:variant-1)');
    expect(result).toContain('case(case-b:variant-2)');
  });
});

// ==========================================================================
// computeInheritedDSL tests
// ==========================================================================

describe('computeInheritedDSL', () => {
  it('should return baseDSL when scenario is at index 0', () => {
    const scenarios = [{ meta: { isLive: true, queryDSL: 'context(channel:google)' } }];
    
    const result = computeInheritedDSL(0, scenarios, 'window(-30d:-1d)');
    
    expect(result).toBe('window(-30d:-1d)');
  });

  it('should return empty string when baseDSL is null/undefined', () => {
    const scenarios = [{ meta: { isLive: true, queryDSL: 'context(channel:google)' } }];
    
    expect(computeInheritedDSL(0, scenarios, null)).toBe('');
    expect(computeInheritedDSL(0, scenarios, undefined)).toBe('');
  });

  it('should include DSL from scenarios BELOW in visual stack (higher indices)', () => {
    // Visual order: [A (index 0, TOP), B (index 1, BOTTOM)]
    // A inherits from B + Base
    // B inherits from Base only
    const scenarios = [
      { meta: { isLive: true, queryDSL: 'context(channel:google)' } },  // TOP (index 0)
      { meta: { isLive: true, queryDSL: 'context(browser:chrome)' } },  // BOTTOM (index 1)
    ];
    
    // A (index 0) should inherit from B (index 1) + Base
    const resultForA = computeInheritedDSL(0, scenarios, 'window(-30d:-1d)');
    expect(resultForA).toContain('window(-30d:-1d)');
    expect(resultForA).toContain('context(browser:chrome)'); // B's context
    expect(resultForA).not.toContain('google'); // A is the target, not inherited
    
    // B (index 1, BOTTOM) should inherit from Base only
    const resultForB = computeInheritedDSL(1, scenarios, 'window(-30d:-1d)');
    expect(resultForB).toBe('window(-30d:-1d)');
  });

  it('should skip static scenarios (not isLive)', () => {
    // Visual order: [A (static), B (live)]
    // B inherits from Base only (A is static, skipped)
    const scenarios = [
      { meta: { isLive: false, queryDSL: 'context(channel:google)' } }, // Static - should skip
      { meta: { isLive: true, queryDSL: 'context(browser:chrome)' } },  // BOTTOM
    ];
    
    // B (index 1, BOTTOM) inherits from Base only
    const result = computeInheritedDSL(1, scenarios, 'window(-30d:-1d)');
    expect(result).toBe('window(-30d:-1d)');
    
    // A (index 0) would inherit from B, but A is static so this wouldn't normally be called
    // But if it were, B's context would be inherited
    const resultForA = computeInheritedDSL(0, scenarios, 'window(-30d:-1d)');
    expect(resultForA).toContain('context(browser:chrome)');
    expect(resultForA).not.toContain('google'); // A is target, not inherited
  });

  it('should skip scenarios without queryDSL', () => {
    // Visual order: [A (no queryDSL), B (live)]
    const scenarios = [
      { meta: { isLive: true } }, // No queryDSL - should skip
      { meta: { isLive: true, queryDSL: 'context(browser:chrome)' } },
    ];
    
    // A (index 0) inherits from B + Base, but B has queryDSL
    const resultForA = computeInheritedDSL(0, scenarios, 'window(-30d:-1d)');
    expect(resultForA).toContain('context(browser:chrome)');
    
    // B (index 1, BOTTOM) inherits from Base only
    const resultForB = computeInheritedDSL(1, scenarios, 'window(-30d:-1d)');
    expect(resultForB).toBe('window(-30d:-1d)');
  });

  it('should use lastEffectiveDSL when available', () => {
    // Visual order: [A (target), B (has lastEffectiveDSL)]
    // A inherits from B's lastEffectiveDSL
    const scenarios = [
      { meta: { isLive: true, queryDSL: 'context(browser:chrome)' } },  // TOP (target)
      { meta: { 
        isLive: true, 
        queryDSL: 'context(channel)', // Fragment
        lastEffectiveDSL: 'window(-30d:-1d).context(channel:google)' // Full effective
      }},  // BOTTOM
    ];
    
    // A (index 0) inherits from B's lastEffectiveDSL
    const result = computeInheritedDSL(0, scenarios, '');
    expect(result).toContain('context(channel:google)');
  });

  it('should handle complex inheritance chain', () => {
    // Visual order (top to bottom): [A, B-static, C, D]
    // Each scenario inherits from scenarios BELOW it (higher indices)
    // A (index 0) inherits from: B + C + D + Base (B is static, skipped)
    // B (index 1) inherits from: C + D + Base (but B is static so wouldn't be called)
    // C (index 2) inherits from: D + Base
    // D (index 3, BOTTOM) inherits from: Base only
    const scenarios = [
      { meta: { isLive: true, queryDSL: 'context(channel:google)' } },  // A (index 0, TOP)
      { meta: { isLive: false, queryDSL: 'context(platform:web)' } },   // B (index 1, static - skip)
      { meta: { isLive: true, queryDSL: 'window(-7d:-1d)' } },          // C (index 2)
      { meta: { isLive: true, queryDSL: 'visited(node-x)' } },          // D (index 3, BOTTOM)
    ];
    
    // D (index 3, BOTTOM) inherits from Base only (nothing below it)
    const resultForD = computeInheritedDSL(3, scenarios, 'window(-30d:-1d)');
    expect(resultForD).toBe('window(-30d:-1d)');
    
    // C (index 2) inherits from D + Base
    const resultForC = computeInheritedDSL(2, scenarios, 'window(-30d:-1d)');
    expect(resultForC).toContain('visited(node-x)'); // D's visited
    expect(resultForC).toContain('window(-30d:-1d)'); // Base window (not overridden by D)
    
    // A (index 0, TOP) inherits from B + C + D + Base (B skipped as static)
    const resultForA = computeInheritedDSL(0, scenarios, 'window(-30d:-1d)');
    expect(resultForA).toContain('window(-7d:-1d)'); // C's window overrides base
    expect(resultForA).not.toContain('platform'); // B is static, skipped
    expect(resultForA).toContain('visited(node-x)'); // D's visited
  });
});

// ==========================================================================
// computeEffectiveFetchDSL tests
// ==========================================================================

describe('computeEffectiveFetchDSL', () => {
  it('should return scenario DSL when no inherited DSL', () => {
    const result = computeEffectiveFetchDSL('', 'window(-7d:-1d)');
    
    expect(result).toBe('window(-7d:-1d)');
  });

  it('should return inherited DSL when no scenario DSL', () => {
    const result = computeEffectiveFetchDSL('window(-30d:-1d)', '');
    
    expect(result).toBe('window(-30d:-1d)');
  });

  it('should strip what-if parts from scenario DSL', () => {
    const result = computeEffectiveFetchDSL(
      'window(-30d:-1d)',
      'context(channel:google).case(my-case:treatment)'
    );
    
    // Should contain fetch parts merged
    expect(result).toContain('window(-30d:-1d)');
    expect(result).toContain('context(channel:google)');
    // Should NOT contain what-if parts
    expect(result).not.toContain('case(');
    expect(result).not.toContain('treatment');
  });

  it('should override same-type constraints (window)', () => {
    const result = computeEffectiveFetchDSL(
      'window(-30d:-1d)',
      'window(-7d:-1d)'
    );
    
    // Scenario window should override inherited window
    expect(result).toContain('window(-7d:-1d)');
    expect(result).not.toContain('-30d');
  });

  it('should combine different-type constraints', () => {
    const result = computeEffectiveFetchDSL(
      'window(-30d:-1d)',
      'context(channel:google)'
    );
    
    expect(result).toContain('window(-30d:-1d)');
    expect(result).toContain('context(channel:google)');
  });

  it('should handle null values', () => {
    expect(computeEffectiveFetchDSL(null, 'window(-7d:-1d)')).toContain('window(-7d:-1d)');
    expect(computeEffectiveFetchDSL('window(-30d:-1d)', null)).toContain('window(-30d:-1d)');
    expect(computeEffectiveFetchDSL(null, null)).toBe('');
  });
});

// ==========================================================================
// isLiveScenario tests
// ==========================================================================

describe('isLiveScenario', () => {
  it('should return true for scenario with queryDSL', () => {
    expect(isLiveScenario({ meta: { queryDSL: 'window(-7d:-1d)' } })).toBe(true);
  });

  it('should return false for scenario without queryDSL', () => {
    expect(isLiveScenario({ meta: {} })).toBe(false);
    expect(isLiveScenario({})).toBe(false);
  });

  it('should return false for empty queryDSL', () => {
    expect(isLiveScenario({ meta: { queryDSL: '' } })).toBe(false);
    expect(isLiveScenario({ meta: { queryDSL: '   ' } })).toBe(false);
  });

  it('should ignore isLive flag, only check queryDSL', () => {
    // Has isLive=true but no queryDSL - should be false
    expect(isLiveScenario({ meta: { isLive: true } })).toBe(false);
    
    // Has queryDSL but isLive=false - should be true (queryDSL is the source of truth)
    expect(isLiveScenario({ meta: { isLive: false, queryDSL: 'window(-7d:-1d)' } })).toBe(true);
  });
});

// ==========================================================================
// generateSmartLabel tests
// ==========================================================================

describe('generateSmartLabel', () => {
  it('should return empty string for null/undefined/empty DSL', () => {
    expect(generateSmartLabel(null)).toBe('');
    expect(generateSmartLabel(undefined)).toBe('');
    expect(generateSmartLabel('')).toBe('');
    expect(generateSmartLabel('   ')).toBe('');
  });

  it('should format absolute window dates nicely', () => {
    const result = generateSmartLabel('window(2-Dec-25:20-Dec-25)');
    expect(result).toBe('2-Dec – 20-Dec');
  });

  it('should format relative window dates nicely', () => {
    const result = generateSmartLabel('window(-90d:-30d)');
    expect(result).toBe('90d ago – 30d ago');
  });

  it('should format context with key:value', () => {
    const result = generateSmartLabel('context(channel:google)');
    expect(result).toBe('Channel: Google');
  });

  it('should format bare context key', () => {
    const result = generateSmartLabel('context(channel)');
    expect(result).toBe('By Channel');
  });

  it('should format case overrides', () => {
    const result = generateSmartLabel('case(my-case:treatment)');
    expect(result).toBe('My case: Treatment');
  });

  it('should combine multiple parts with separator', () => {
    const result = generateSmartLabel('window(-7d:-1d).context(channel:google)');
    expect(result).toContain('7d ago – 1d ago');
    expect(result).toContain('Channel: Google');
    expect(result).toContain(' · ');
  });

  it('should format visited nodes', () => {
    const result = generateSmartLabel('visited(node-a)');
    expect(result).toBe('Visited: node-a');
  });

  it('should summarise multiple visited nodes', () => {
    const result = generateSmartLabel('visited(node-a,node-b,node-c)');
    expect(result).toBe('Visited: 3 nodes');
  });

  it('should handle complex combined DSL', () => {
    const result = generateSmartLabel('window(-30d:-1d).context(channel:meta).case(experiment:control)');
    expect(result).toContain('30d ago – 1d ago');
    expect(result).toContain('Channel: Meta');
    expect(result).toContain('Experiment: Control');
  });
});

// ==========================================================================
// prepareScenariosForBatch tests
// ==========================================================================

describe('prepareScenariosForBatch', () => {
  const baseDSL = 'window(1-Nov-25:7-Nov-25)';
  
  it('should return empty array when no scenarios', () => {
    const result = prepareScenariosForBatch([], [], baseDSL);
    expect(result).toEqual([]);
  });

  it('should return empty array when no visible scenarios', () => {
    const scenarios: ScenarioForBatch[] = [
      { id: 's1', meta: { isLive: true, queryDSL: 'context(channel:google)' } },
    ];
    // visibleOrder doesn't include s1
    const result = prepareScenariosForBatch(scenarios, ['s2'], baseDSL);
    expect(result).toEqual([]);
  });

  it('should skip non-live scenarios', () => {
    const scenarios: ScenarioForBatch[] = [
      { id: 's1', meta: { isLive: false, queryDSL: 'context(channel:google)' } },
      { id: 's2', meta: { isLive: true, queryDSL: 'context(channel:meta)' } },
    ];
    const result = prepareScenariosForBatch(scenarios, ['s1', 's2'], baseDSL);
    
    // Only s2 should be prepared
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('s2');
  });

  it('should skip scenarios without queryDSL', () => {
    const scenarios: ScenarioForBatch[] = [
      { id: 's1', meta: { isLive: true } }, // No queryDSL
      { id: 's2', meta: { isLive: true, queryDSL: 'context(channel:meta)' } },
    ];
    const result = prepareScenariosForBatch(scenarios, ['s1', 's2'], baseDSL);
    
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('s2');
  });

  it('should process single scenario correctly', () => {
    const scenarios: ScenarioForBatch[] = [
      { id: 's1', meta: { isLive: true, queryDSL: 'context(channel:google)' } },
    ];
    const result = prepareScenariosForBatch(scenarios, ['s1'], baseDSL);
    
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('s1');
    expect(result[0].queryDSL).toBe('context(channel:google)');
    expect(result[0].inheritedDSL).toBe(baseDSL);
    // effectiveFetchDSL should combine base + scenario DSL
    expect(result[0].effectiveFetchDSL).toContain('window(1-Nov-25:7-Nov-25)');
    expect(result[0].effectiveFetchDSL).toContain('context(channel:google)');
  });

  it('should process scenarios in bottom-to-top order', () => {
    const scenarios: ScenarioForBatch[] = [
      { id: 'top', meta: { isLive: true, queryDSL: 'context(channel:google)' } },
      { id: 'bottom', meta: { isLive: true, queryDSL: 'context(channel:meta)' } },
    ];
    // Visual order: top is at index 0, bottom is at index 1
    const visibleOrder = ['top', 'bottom'];
    
    const result = prepareScenariosForBatch(scenarios, visibleOrder, baseDSL);
    
    // Should be processed bottom-first (reversed order)
    expect(result.length).toBe(2);
    expect(result[0].id).toBe('bottom'); // Processed first
    expect(result[1].id).toBe('top');    // Processed second
  });

  it('should inherit DSL from scenarios below (later in visual order)', () => {
    // Setup: 3 scenarios stacked
    // Visual order: [top, middle, bottom]
    // Inheritance: bottom inherits from base only
    //              middle inherits from base + bottom
    //              top inherits from base + bottom + middle
    const scenarios: ScenarioForBatch[] = [
      { id: 'top', meta: { isLive: true, queryDSL: 'context(region:uk)' } },
      { id: 'middle', meta: { isLive: true, queryDSL: 'context(device:mobile)' } },
      { id: 'bottom', meta: { isLive: true, queryDSL: 'context(channel:google)' } },
    ];
    const visibleOrder = ['top', 'middle', 'bottom'];
    
    const result = prepareScenariosForBatch(scenarios, visibleOrder, baseDSL);
    
    expect(result.length).toBe(3);
    
    // Bottom: inherits only from base
    const bottomResult = result.find(r => r.id === 'bottom')!;
    expect(bottomResult.inheritedDSL).toBe(baseDSL);
    expect(bottomResult.effectiveFetchDSL).toContain('context(channel:google)');
    
    // Middle: inherits from base + bottom's effective DSL
    const middleResult = result.find(r => r.id === 'middle')!;
    expect(middleResult.inheritedDSL).toContain('context(channel:google)');
    expect(middleResult.effectiveFetchDSL).toContain('context(device:mobile)');
    
    // Top: inherits from base + bottom + middle
    const topResult = result.find(r => r.id === 'top')!;
    expect(topResult.inheritedDSL).toContain('context(channel:google)');
    expect(topResult.inheritedDSL).toContain('context(device:mobile)');
    expect(topResult.effectiveFetchDSL).toContain('context(region:uk)');
  });

  it('should filter base and current from visibleOrder', () => {
    const scenarios: ScenarioForBatch[] = [
      { id: 's1', meta: { isLive: true, queryDSL: 'context(channel:google)' } },
    ];
    // visibleOrder includes special IDs that should be filtered
    const result = prepareScenariosForBatch(scenarios, ['base', 's1', 'current'], baseDSL);
    
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('s1');
  });

  it('should split DSL into fetch and whatIf parts', () => {
    const scenarios: ScenarioForBatch[] = [
      { 
        id: 's1', 
        meta: { 
          isLive: true, 
          queryDSL: 'context(channel:google).case(experiment:treatment)' 
        } 
      },
    ];
    const result = prepareScenariosForBatch(scenarios, ['s1'], baseDSL);
    
    expect(result.length).toBe(1);
    expect(result[0].fetchParts.context).toEqual([{ key: 'channel', value: 'google' }]);
    expect(result[0].whatIfParts.cases).toEqual([{ key: 'experiment', value: 'treatment' }]);
  });

  it('should handle empty baseDSL', () => {
    const scenarios: ScenarioForBatch[] = [
      { id: 's1', meta: { isLive: true, queryDSL: 'context(channel:google)' } },
    ];
    const result = prepareScenariosForBatch(scenarios, ['s1'], '');
    
    expect(result.length).toBe(1);
    expect(result[0].inheritedDSL).toBe('');
    expect(result[0].effectiveFetchDSL).toContain('context(channel:google)');
  });
});

// ==========================================================================
// What-If DSL handling tests
// ==========================================================================

describe('What-If DSL handling in live scenarios', () => {
  it('should separate case() from fetch DSL', () => {
    const dsl = 'window(-30d:-1d).context(channel:google).case(experiment:treatment)';
    const result = splitDSLParts(dsl);
    
    // Fetch parts should have window and context
    expect(result.fetchParts.window).toEqual({ start: '-30d', end: '-1d' });
    expect(result.fetchParts.context).toEqual([{ key: 'channel', value: 'google' }]);
    
    // What-if parts should have case
    expect(result.whatIfParts.cases).toEqual([{ key: 'experiment', value: 'treatment' }]);
    expect(result.whatIfParts.visited).toEqual([]);
  });

  it('should separate visited() from fetch DSL', () => {
    const dsl = 'context(channel:google).visited(node-a,node-b)';
    const result = splitDSLParts(dsl);
    
    // Fetch parts should have context
    expect(result.fetchParts.context).toEqual([{ key: 'channel', value: 'google' }]);
    
    // What-if parts should have visited
    expect(result.whatIfParts.visited).toEqual(['node-a', 'node-b']);
    expect(result.whatIfParts.cases).toEqual([]);
  });

  it('should handle multiple what-if elements', () => {
    const dsl = 'window(-7d:-1d).case(exp1:treatment).case(exp2:control).visited(node-x)';
    const result = splitDSLParts(dsl);
    
    // Fetch parts should have window only
    expect(result.fetchParts.window).toEqual({ start: '-7d', end: '-1d' });
    expect(result.fetchParts.context).toEqual([]);
    
    // What-if parts should have both cases and visited
    expect(result.whatIfParts.cases).toHaveLength(2);
    expect(result.whatIfParts.cases).toContainEqual({ key: 'exp1', value: 'treatment' });
    expect(result.whatIfParts.cases).toContainEqual({ key: 'exp2', value: 'control' });
    expect(result.whatIfParts.visited).toEqual(['node-x']);
  });

  it('should build correct what-if DSL string from parts', () => {
    const parts = {
      window: null,
      context: [],
      cases: [
        { key: 'experiment', value: 'treatment' },
      ],
      visited: ['node-a'],
      visitedAny: [],
      exclude: [],
    };
    
    const whatIfDSL = buildWhatIfDSL(parts);
    expect(whatIfDSL).toContain('case(experiment:treatment)');
    expect(whatIfDSL).toContain('visited(node-a)');
  });

  it('should handle exclude() in what-if parts', () => {
    const dsl = 'context(channel:google).exclude(node-x,node-y)';
    const result = splitDSLParts(dsl);
    
    // Exclude should be in what-if parts
    expect(result.whatIfParts.exclude).toEqual(['node-x', 'node-y']);
    expect(result.fetchParts.context).toEqual([{ key: 'channel', value: 'google' }]);
  });

  it('should handle pure what-if DSL (no fetch elements)', () => {
    const dsl = 'case(experiment:treatment).visited(node-a)';
    const result = splitDSLParts(dsl);
    
    // No fetch parts
    expect(result.fetchParts.window).toBeNull();
    expect(result.fetchParts.context).toEqual([]);
    
    // Only what-if parts
    expect(result.whatIfParts.cases).toEqual([{ key: 'experiment', value: 'treatment' }]);
    expect(result.whatIfParts.visited).toEqual(['node-a']);
  });

  it('should handle pure fetch DSL (no what-if elements)', () => {
    const dsl = 'window(-30d:-1d).context(channel:google)';
    const result = splitDSLParts(dsl);
    
    // Only fetch parts
    expect(result.fetchParts.window).toEqual({ start: '-30d', end: '-1d' });
    expect(result.fetchParts.context).toEqual([{ key: 'channel', value: 'google' }]);
    
    // No what-if parts
    expect(result.whatIfParts.cases).toEqual([]);
    expect(result.whatIfParts.visited).toEqual([]);
    expect(result.whatIfParts.exclude).toEqual([]);
  });

  it('should preserve what-if DSL through prepareScenariosForBatch', () => {
    const scenarios: ScenarioForBatch[] = [
      { 
        id: 's1', 
        meta: { 
          isLive: true, 
          queryDSL: 'context(channel:google).case(experiment:treatment).visited(node-a)' 
        } 
      },
    ];
    
    const result = prepareScenariosForBatch(scenarios, ['s1'], 'window(-30d:-1d)');
    
    expect(result.length).toBe(1);
    // Fetch parts should include inherited window and scenario context
    expect(result[0].effectiveFetchDSL).toContain('window(-30d:-1d)');
    expect(result[0].effectiveFetchDSL).toContain('context(channel:google)');
    
    // What-if parts should be preserved
    expect(result[0].whatIfParts.cases).toEqual([{ key: 'experiment', value: 'treatment' }]);
    expect(result[0].whatIfParts.visited).toEqual(['node-a']);
  });
});

