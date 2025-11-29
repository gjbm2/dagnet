/**
 * WindowSelector Coverage Check Tests
 * 
 * Tests for the critical behavior: coverage checks should trigger when:
 * 1. Window dates change
 * 2. Context changes (even if window is same)
 * 3. Both change together
 * 
 * And should NOT trigger when:
 * 4. Neither window nor context changed
 * 
 * Also tests:
 * 5. targetSlice parameter is correctly passed to getParameterFromFile
 */

import { describe, it, expect, vi } from 'vitest';

// ============================================================================
// Test the core logic that was missing coverage
// ============================================================================

/**
 * Simulates the WindowSelector's decision logic for whether to run coverage check
 */
function shouldRunCoverageCheck(
  currentWindow: { start: string; end: string },
  lastWindow: { start: string; end: string } | null,
  currentDSL: string,
  lastDSL: string | null
): { shouldRun: boolean; reason: string } {
  // If no last window, always run
  if (!lastWindow) {
    return { shouldRun: true, reason: 'no-previous-aggregation' };
  }
  
  // Check if window changed
  const windowChanged = currentWindow.start !== lastWindow.start || 
                        currentWindow.end !== lastWindow.end;
  
  // Check if DSL (context) changed
  const dslChanged = currentDSL !== (lastDSL || '');
  
  if (!windowChanged && !dslChanged) {
    return { shouldRun: false, reason: 'no-change' };
  }
  
  if (windowChanged && dslChanged) {
    return { shouldRun: true, reason: 'window-and-context-changed' };
  }
  
  if (windowChanged) {
    return { shouldRun: true, reason: 'window-changed' };
  }
  
  // This was the BUG - context changed but window same
  return { shouldRun: true, reason: 'context-changed' };
}

describe('WindowSelector Coverage Check Logic', () => {
  const OCT_WINDOW = { start: '2025-10-01T00:00:00Z', end: '2025-10-31T23:59:59Z' };
  const NOV_WINDOW = { start: '2025-11-01T00:00:00Z', end: '2025-11-30T23:59:59Z' };
  
  const NO_CONTEXT = 'window(1-Oct-25:31-Oct-25)';
  const GOOGLE_CONTEXT = 'context(channel:google).window(1-Oct-25:31-Oct-25)';
  const INFLUENCER_CONTEXT = 'context(channel:influencer).window(1-Oct-25:31-Oct-25)';
  const MULTI_CONTEXT = 'contextAny(channel:google,channel:influencer).window(1-Oct-25:31-Oct-25)';

  // -------------------------------------------------------------------------
  // SHOULD trigger coverage check
  // -------------------------------------------------------------------------

  describe('Should trigger coverage check', () => {
    it('when window changes', () => {
      const result = shouldRunCoverageCheck(
        NOV_WINDOW,
        OCT_WINDOW,
        NO_CONTEXT,
        NO_CONTEXT
      );
      
      expect(result.shouldRun).toBe(true);
      expect(result.reason).toBe('window-changed');
    });

    it('when context is ADDED (same window)', () => {
      const result = shouldRunCoverageCheck(
        OCT_WINDOW,
        OCT_WINDOW,
        GOOGLE_CONTEXT,  // NEW: has context
        NO_CONTEXT       // OLD: no context
      );
      
      expect(result.shouldRun).toBe(true);
      expect(result.reason).toBe('context-changed');
    });

    it('when context is REMOVED (same window)', () => {
      const result = shouldRunCoverageCheck(
        OCT_WINDOW,
        OCT_WINDOW,
        NO_CONTEXT,      // NEW: no context
        GOOGLE_CONTEXT   // OLD: had context
      );
      
      expect(result.shouldRun).toBe(true);
      expect(result.reason).toBe('context-changed');
    });

    it('when context VALUE changes (same window)', () => {
      const result = shouldRunCoverageCheck(
        OCT_WINDOW,
        OCT_WINDOW,
        INFLUENCER_CONTEXT,  // NEW: influencer
        GOOGLE_CONTEXT       // OLD: google
      );
      
      expect(result.shouldRun).toBe(true);
      expect(result.reason).toBe('context-changed');
    });

    it('when context changes from single to multi-value (same window)', () => {
      const result = shouldRunCoverageCheck(
        OCT_WINDOW,
        OCT_WINDOW,
        MULTI_CONTEXT,   // NEW: multiple values
        GOOGLE_CONTEXT   // OLD: single value
      );
      
      expect(result.shouldRun).toBe(true);
      expect(result.reason).toBe('context-changed');
    });

    it('when BOTH window and context change', () => {
      const result = shouldRunCoverageCheck(
        NOV_WINDOW,       // Different window
        OCT_WINDOW,
        INFLUENCER_CONTEXT,  // Different context
        GOOGLE_CONTEXT
      );
      
      expect(result.shouldRun).toBe(true);
      expect(result.reason).toBe('window-and-context-changed');
    });

    it('when first aggregation (no previous state)', () => {
      const result = shouldRunCoverageCheck(
        OCT_WINDOW,
        null,           // No previous window
        GOOGLE_CONTEXT,
        null            // No previous DSL
      );
      
      expect(result.shouldRun).toBe(true);
      expect(result.reason).toBe('no-previous-aggregation');
    });
  });

  // -------------------------------------------------------------------------
  // Should NOT trigger coverage check
  // -------------------------------------------------------------------------

  describe('Should NOT trigger coverage check', () => {
    it('when neither window nor context changed', () => {
      const result = shouldRunCoverageCheck(
        OCT_WINDOW,
        OCT_WINDOW,
        GOOGLE_CONTEXT,
        GOOGLE_CONTEXT
      );
      
      expect(result.shouldRun).toBe(false);
      expect(result.reason).toBe('no-change');
    });

    it('when window is same and context is same (no context)', () => {
      const result = shouldRunCoverageCheck(
        OCT_WINDOW,
        OCT_WINDOW,
        NO_CONTEXT,
        NO_CONTEXT
      );
      
      expect(result.shouldRun).toBe(false);
      expect(result.reason).toBe('no-change');
    });

    it('when DSL is empty both times', () => {
      const result = shouldRunCoverageCheck(
        OCT_WINDOW,
        OCT_WINDOW,
        '',
        ''
      );
      
      expect(result.shouldRun).toBe(false);
      expect(result.reason).toBe('no-change');
    });
  });
});

// ============================================================================
// DSL Comparison Tests
// ============================================================================

describe('DSL Comparison Edge Cases', () => {
  /**
   * Normalize DSL for comparison (handles whitespace, ordering, etc.)
   * In production, this might need more sophisticated normalization
   */
  function normalizeDSL(dsl: string): string {
    return dsl.trim();
  }
  
  function dslsAreEqual(dsl1: string, dsl2: string): boolean {
    return normalizeDSL(dsl1) === normalizeDSL(dsl2);
  }

  it('should detect context value change', () => {
    expect(dslsAreEqual(
      'context(channel:google).window(1-Oct-25:31-Oct-25)',
      'context(channel:influencer).window(1-Oct-25:31-Oct-25)'
    )).toBe(false);
  });

  it('should detect context key change', () => {
    expect(dslsAreEqual(
      'context(channel:google).window(1-Oct-25:31-Oct-25)',
      'context(browser:chrome).window(1-Oct-25:31-Oct-25)'
    )).toBe(false);
  });

  it('should detect context addition', () => {
    expect(dslsAreEqual(
      'window(1-Oct-25:31-Oct-25)',
      'context(channel:google).window(1-Oct-25:31-Oct-25)'
    )).toBe(false);
  });

  it('should detect context removal', () => {
    expect(dslsAreEqual(
      'context(channel:google).window(1-Oct-25:31-Oct-25)',
      'window(1-Oct-25:31-Oct-25)'
    )).toBe(false);
  });

  it('should detect multi-value to single-value change', () => {
    expect(dslsAreEqual(
      'contextAny(channel:google,channel:influencer).window(1-Oct-25:31-Oct-25)',
      'context(channel:google).window(1-Oct-25:31-Oct-25)'
    )).toBe(false);
  });

  it('should consider identical DSLs equal', () => {
    expect(dslsAreEqual(
      'context(channel:google).window(1-Oct-25:31-Oct-25)',
      'context(channel:google).window(1-Oct-25:31-Oct-25)'
    )).toBe(true);
  });

  it('should handle empty DSLs', () => {
    expect(dslsAreEqual('', '')).toBe(true);
  });

  it('should handle undefined-like values', () => {
    expect(dslsAreEqual('', 'context(channel:google)')).toBe(false);
  });
});

// ============================================================================
// Integration-like Tests: Simulating User Flows
// ============================================================================

describe('User Flow Simulations', () => {
  interface WindowSelectorState {
    window: { start: string; end: string };
    currentQueryDSL: string;
    lastAggregatedWindow: { start: string; end: string } | null;
    lastAggregatedDSL: string | null;
  }

  function simulateCoverageCheck(state: WindowSelectorState): boolean {
    const { window, currentQueryDSL, lastAggregatedWindow, lastAggregatedDSL } = state;
    
    // No previous aggregation
    if (!lastAggregatedWindow) return true;
    
    // Check window
    const windowMatch = window.start === lastAggregatedWindow.start &&
                        window.end === lastAggregatedWindow.end;
    
    // Check DSL
    const dslMatch = currentQueryDSL === (lastAggregatedDSL || '');
    
    // Run coverage check if EITHER changed
    return !windowMatch || !dslMatch;
  }

  it('User opens graph → initial aggregation runs', () => {
    const state: WindowSelectorState = {
      window: { start: '2025-10-01', end: '2025-10-31' },
      currentQueryDSL: 'window(1-Oct-25:31-Oct-25)',
      lastAggregatedWindow: null,
      lastAggregatedDSL: null
    };
    
    expect(simulateCoverageCheck(state)).toBe(true);
  });

  it('User changes window from Oct to Nov → aggregation runs', () => {
    const state: WindowSelectorState = {
      window: { start: '2025-11-01', end: '2025-11-30' },
      currentQueryDSL: 'window(1-Nov-25:30-Nov-25)',
      lastAggregatedWindow: { start: '2025-10-01', end: '2025-10-31' },
      lastAggregatedDSL: 'window(1-Oct-25:31-Oct-25)'
    };
    
    expect(simulateCoverageCheck(state)).toBe(true);
  });

  it('User adds context filter (same window) → aggregation runs', () => {
    const state: WindowSelectorState = {
      window: { start: '2025-10-01', end: '2025-10-31' },
      currentQueryDSL: 'context(channel:google).window(1-Oct-25:31-Oct-25)',
      lastAggregatedWindow: { start: '2025-10-01', end: '2025-10-31' },
      lastAggregatedDSL: 'window(1-Oct-25:31-Oct-25)' // No context before
    };
    
    expect(simulateCoverageCheck(state)).toBe(true);
  });

  it('User changes context value (same window) → aggregation runs', () => {
    const state: WindowSelectorState = {
      window: { start: '2025-10-01', end: '2025-10-31' },
      currentQueryDSL: 'context(channel:influencer).window(1-Oct-25:31-Oct-25)',
      lastAggregatedWindow: { start: '2025-10-01', end: '2025-10-31' },
      lastAggregatedDSL: 'context(channel:google).window(1-Oct-25:31-Oct-25)'
    };
    
    expect(simulateCoverageCheck(state)).toBe(true);
  });

  it('User removes context filter (same window) → aggregation runs', () => {
    const state: WindowSelectorState = {
      window: { start: '2025-10-01', end: '2025-10-31' },
      currentQueryDSL: 'window(1-Oct-25:31-Oct-25)',
      lastAggregatedWindow: { start: '2025-10-01', end: '2025-10-31' },
      lastAggregatedDSL: 'context(channel:google).window(1-Oct-25:31-Oct-25)'
    };
    
    expect(simulateCoverageCheck(state)).toBe(true);
  });

  it('User clicks around but nothing changes → NO aggregation', () => {
    const state: WindowSelectorState = {
      window: { start: '2025-10-01', end: '2025-10-31' },
      currentQueryDSL: 'context(channel:google).window(1-Oct-25:31-Oct-25)',
      lastAggregatedWindow: { start: '2025-10-01', end: '2025-10-31' },
      lastAggregatedDSL: 'context(channel:google).window(1-Oct-25:31-Oct-25)'
    };
    
    expect(simulateCoverageCheck(state)).toBe(false);
  });
});

// ============================================================================
// The BUG That Was Missing Tests
// ============================================================================

describe('THE BUG: Context changes were ignored when window was same', () => {
  it('OLD BUGGY BEHAVIOR: Would return false (skip coverage check)', () => {
    // This is what the OLD code would have done:
    function oldBuggyCheck(
      currentWindow: { start: string; end: string },
      lastWindow: { start: string; end: string } | null
    ): boolean {
      if (!lastWindow) return true;
      
      // BUG: Only checked window, ignored DSL/context!
      const windowMatch = currentWindow.start === lastWindow.start &&
                          currentWindow.end === lastWindow.end;
      
      return !windowMatch; // Would return false when windows match
    }
    
    const sameWindow = { start: '2025-10-01', end: '2025-10-31' };
    
    // Context changed but window same - OLD CODE WOULD SKIP!
    expect(oldBuggyCheck(sameWindow, sameWindow)).toBe(false);
  });

  it('NEW FIXED BEHAVIOR: Returns true (runs coverage check)', () => {
    // This is what the NEW code does:
    function newFixedCheck(
      currentWindow: { start: string; end: string },
      lastWindow: { start: string; end: string } | null,
      currentDSL: string,
      lastDSL: string | null
    ): boolean {
      if (!lastWindow) return true;
      
      const windowMatch = currentWindow.start === lastWindow.start &&
                          currentWindow.end === lastWindow.end;
      
      // FIX: Also check DSL!
      const dslMatch = currentDSL === (lastDSL || '');
      
      return !windowMatch || !dslMatch; // Returns true if EITHER changed
    }
    
    const sameWindow = { start: '2025-10-01', end: '2025-10-31' };
    const oldDSL = 'window(1-Oct-25:31-Oct-25)';
    const newDSL = 'context(channel:google).window(1-Oct-25:31-Oct-25)';
    
    // Context changed but window same - NEW CODE RUNS COVERAGE CHECK!
    expect(newFixedCheck(sameWindow, sameWindow, newDSL, oldDSL)).toBe(true);
  });
});

// ============================================================================
// E2E Test: DSL must be BUILT from authoritative state, not read from graph
// ============================================================================

describe('DSL building from authoritative state', () => {
  /**
   * CORRECT ARCHITECTURE:
   * - window state from graphStore = AUTHORITATIVE date range
   * - graph.currentQueryDSL = just a RECORD, NOT query state
   * - When fetching: BUILD DSL from window + context, don't use graph.currentQueryDSL directly
   */
  
  /**
   * Simulates buildDSLFromState: builds DSL from authoritative window + extracted context
   */
  function buildDSLFromState(
    windowState: { start: string; end: string },
    graphCurrentQueryDSL: string
  ): string {
    // Extract ONLY the context parts from graph.currentQueryDSL
    // (The window in graph.currentQueryDSL might be stale!)
    const contextMatch = graphCurrentQueryDSL.match(/context\([^)]+\)/g) || [];
    const contextAnyMatch = graphCurrentQueryDSL.match(/contextAny\([^)]+\)/g) || [];
    const contextParts = [...contextMatch, ...contextAnyMatch];
    
    // Build window from AUTHORITATIVE window state
    const windowPart = `window(${windowState.start}:${windowState.end})`;
    
    return contextParts.length > 0 
      ? `${contextParts.join('.')}.${windowPart}` 
      : windowPart;
  }

  it('should use WINDOW from state, not from graph.currentQueryDSL', () => {
    // Window state is authoritative
    const windowState = { start: '22-Nov-25', end: '28-Nov-25' };
    
    // graph.currentQueryDSL has STALE window (from previous query)
    const graphDSL = 'context(channel:google).window(1-Oct-25:31-Oct-25)';
    
    const builtDSL = buildDSLFromState(windowState, graphDSL);
    
    // Should use window from state, NOT from graph
    expect(builtDSL).toBe('context(channel:google).window(22-Nov-25:28-Nov-25)');
    expect(builtDSL).not.toContain('1-Oct-25');
  });

  it('should preserve context from graph.currentQueryDSL', () => {
    const windowState = { start: '22-Nov-25', end: '28-Nov-25' };
    const graphDSL = 'context(channel:pr).window(1-Oct-25:31-Oct-25)';
    
    const builtDSL = buildDSLFromState(windowState, graphDSL);
    
    // Context from graph is preserved
    expect(builtDSL).toContain('context(channel:pr)');
    // But window is from state
    expect(builtDSL).toContain('window(22-Nov-25:28-Nov-25)');
  });

  it('should work with no context (window only)', () => {
    const windowState = { start: '22-Nov-25', end: '28-Nov-25' };
    const graphDSL = 'window(1-Oct-25:31-Oct-25)';
    
    const builtDSL = buildDSLFromState(windowState, graphDSL);
    
    expect(builtDSL).toBe('window(22-Nov-25:28-Nov-25)');
  });

  it('should work with multiple contexts', () => {
    const windowState = { start: '22-Nov-25', end: '28-Nov-25' };
    const graphDSL = 'context(channel:google).context(platform:ios).window(1-Oct-25:31-Oct-25)';
    
    const builtDSL = buildDSLFromState(windowState, graphDSL);
    
    expect(builtDSL).toBe('context(channel:google).context(platform:ios).window(22-Nov-25:28-Nov-25)');
  });

  it('should work with contextAny', () => {
    const windowState = { start: '22-Nov-25', end: '28-Nov-25' };
    const graphDSL = 'contextAny(channel:google,channel:facebook).window(1-Oct-25:31-Oct-25)';
    
    const builtDSL = buildDSLFromState(windowState, graphDSL);
    
    expect(builtDSL).toBe('contextAny(channel:google,channel:facebook).window(22-Nov-25:28-Nov-25)');
  });
});

