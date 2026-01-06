/**
 * ScenariosContext Live Scenarios Tests
 * 
 * Tests for live scenario functionality in ScenariosContext:
 * - createLiveScenario
 * - regenerateScenario  
 * - regenerateAllLive
 * - putToBase
 * - DSL inheritance
 * 
 * Design Reference: docs/current/project-live-scenarios/design.md §3.3, §5.8
 * 
 * These tests focus on the service-level logic rather than React hooks,
 * as the core logic is in scenarioRegenerationService and fetchDataService.
 * 
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

// Mock external dependencies but use REAL IndexedDB (via fake-indexeddb)
vi.mock('../../services/fetchDataService', () => ({
  fetchDataService: {
    checkDSLNeedsFetch: vi.fn().mockReturnValue({ needsFetch: false, items: [] }),
    checkMultipleDSLsNeedFetch: vi.fn().mockReturnValue([]),
    getItemsNeedingFetch: vi.fn().mockReturnValue([]),
    fetchItems: vi.fn().mockResolvedValue([]),
    extractWindowFromDSL: vi.fn().mockReturnValue({ start: '1-Nov-25', end: '7-Nov-25' }),
  },
}));

// DO NOT mock db/appDatabase - use real Dexie with fake-indexeddb

vi.mock('../GraphStoreContext', () => ({
  useGraphStore: vi.fn().mockReturnValue({
    getState: vi.fn().mockReturnValue({
      graph: {
        nodes: [],
        edges: [],
        baseDSL: '',
      },
      currentDSL: 'window(1-Nov-25:7-Nov-25)',
      currentWindow: { start: '1-Nov-25', end: '7-Nov-25' },
      setGraph: vi.fn(),
    }),
  }),
}));

vi.mock('../TabContext', () => ({
  useTabContext: vi.fn().mockReturnValue({
    activeTabId: 'test-tab',
    operations: {
      toggleScenarioVisibility: vi.fn(),
      addVisibleScenarios: vi.fn(),
      getScenarioState: vi.fn().mockReturnValue({
        visibleScenarioIds: [],
        scenarioOrder: [],
      }),
    },
  }),
  fileRegistry: {
    getFile: vi.fn().mockReturnValue(null),
  },
}));

// Import after mocks
import { ScenariosProvider, useScenariosContext } from '../ScenariosContext';
import { fetchDataService } from '../../services/fetchDataService';
import { db } from '../../db/appDatabase';

// Helper to create wrapper with provider - fileId is required for context to work correctly
function createWrapper(fileId = 'test-file') {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <ScenariosProvider fileId={fileId} tabId="test-tab">
        {children}
      </ScenariosProvider>
    );
  };
}

// Helper to wait for context to be ready (DB load complete)
async function waitForReady(result: { current: { scenariosReady: boolean } }) {
  await waitFor(() => {
    expect(result.current.scenariosReady).toBe(true);
  });
}

describe('ScenariosContext - Live Scenarios', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Close existing DB connections and reset fake-indexeddb
    await db.scenarios.clear().catch(() => {});
    db.close();
    globalThis.indexedDB = new IDBFactory();
    // Re-open the database after resetting
    await db.open();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // Clean up after each test
    await db.scenarios.clear().catch(() => {});
  });

  // ==========================================================================
  // createLiveScenario tests
  // ==========================================================================

  describe('createLiveScenario', () => {
    it('should create scenario with isLive=true in meta', async () => {
      const { result } = renderHook(() => useScenariosContext(), {
        wrapper: createWrapper(),
      });

      let newScenario: any;
      await act(async () => {
        newScenario = await result.current.createLiveScenario(
          'context(channel:google)',
          undefined,
          'test-tab'
        );
      });

      expect(newScenario).toBeDefined();
      expect(newScenario.meta?.isLive).toBe(true);
    });

    it('should set scenario.meta.queryDSL to the DSL passed in', async () => {
      const { result } = renderHook(() => useScenariosContext(), {
        wrapper: createWrapper(),
      });

      const queryDSL = 'window(-7d:-1d).context(channel:meta)';
      let newScenario: any;
      
      await act(async () => {
        newScenario = await result.current.createLiveScenario(
          queryDSL,
          undefined,
          'test-tab'
        );
      });

      expect(newScenario.meta?.queryDSL).toBe(queryDSL);
    });

    it('should generate smart label from queryDSL when no name provided', async () => {
      const { result } = renderHook(() => useScenariosContext(), {
        wrapper: createWrapper(),
      });

      let newScenario: any;
      await act(async () => {
        newScenario = await result.current.createLiveScenario(
          'context(channel:google)',
          undefined,
          'test-tab'
        );
      });

      // Smart label should be generated (e.g., "Channel: Google" instead of raw DSL)
      expect(newScenario.name).toBeDefined();
      expect(newScenario.name.length).toBeGreaterThan(0);
    });

    it('should use provided name when given', async () => {
      const { result } = renderHook(() => useScenariosContext(), {
        wrapper: createWrapper(),
      });

      const customName = 'My Custom Scenario';
      let newScenario: any;
      
      await act(async () => {
        newScenario = await result.current.createLiveScenario(
          'context(channel:google)',
          customName,
          'test-tab'
        );
      });

      expect(newScenario.name).toBe(customName);
    });

    it('should assign colour from palette', async () => {
      const { result } = renderHook(() => useScenariosContext(), {
        wrapper: createWrapper(),
      });

      let newScenario: any;
      await act(async () => {
        newScenario = await result.current.createLiveScenario(
          'context(channel:google)',
          undefined,
          'test-tab'
        );
      });

      expect(newScenario.colour).toBeDefined();
      expect(newScenario.colour).toMatch(/^#[0-9A-Fa-f]{6}$/);
    });

    it('should use provided colour when given', async () => {
      const { result } = renderHook(() => useScenariosContext(), {
        wrapper: createWrapper(),
      });

      const customColour = '#FF5733';
      let newScenario: any;
      
      await act(async () => {
        newScenario = await result.current.createLiveScenario(
          'context(channel:google)',
          undefined,
          'test-tab',
          customColour
        );
      });

      expect(newScenario.colour).toBe(customColour);
    });
  });

  // ==========================================================================
  // regenerateScenario tests - DSL inheritance
  // ==========================================================================

  describe('regenerateScenario - DSL inheritance', () => {
    it('should use baseDSL as foundation when no lower live scenarios exist', async () => {
      const { result } = renderHook(() => useScenariosContext(), {
        wrapper: createWrapper(),
      });

      // Wait for DB load to complete first
      await waitForReady(result);

      // Create a live scenario
      let scenario: any;
      await act(async () => {
        scenario = await result.current.createLiveScenario(
          'context(channel:google)',
          undefined,
          'test-tab'
        );
      });

      // Set base DSL
      await act(async () => {
        result.current.setBaseDSL('window(1-Nov-25:7-Nov-25)');
      });

      // Verify scenario was added to state
      await waitFor(() => {
        expect(result.current.scenarios.length).toBeGreaterThan(0);
      });

      await act(async () => {
        // Pass scenario directly to avoid stale closure issue
        await result.current.regenerateScenario(scenario.id, scenario);
      });

      // Verify fetchDataService was called (indicates regeneration happened)
      expect(fetchDataService.checkDSLNeedsFetch).toHaveBeenCalled();
    });

    it('should record lastEffectiveDSL after regeneration', async () => {
      const { result } = renderHook(() => useScenariosContext(), {
        wrapper: createWrapper(),
      });

      // Wait for DB load to complete first
      await waitForReady(result);

      // Create a live scenario
      let scenario: any;
      await act(async () => {
        scenario = await result.current.createLiveScenario(
          'context(channel:google)',
          undefined,
          'test-tab'
        );
      });

      // Verify scenario was added to state
      await waitFor(() => {
        expect(result.current.scenarios.length).toBeGreaterThan(0);
      });

      await act(async () => {
        // Pass scenario directly
        await result.current.regenerateScenario(scenario.id, scenario);
      });

      // Wait for scenario to be updated with lastEffectiveDSL
      await waitFor(() => {
        const updated = result.current.scenarios.find(s => s.id === scenario.id);
        expect(updated?.meta?.lastEffectiveDSL).toBeDefined();
      });
    });

    it('should update lastRegeneratedAt timestamp after regeneration', async () => {
      const { result } = renderHook(() => useScenariosContext(), {
        wrapper: createWrapper(),
      });

      // Wait for DB load to complete first
      await waitForReady(result);

      let scenario: any;
      await act(async () => {
        scenario = await result.current.createLiveScenario(
          'context(channel:google)',
          undefined,
          'test-tab'
        );
      });

      // Verify scenario was added to state
      await waitFor(() => {
        expect(result.current.scenarios.length).toBeGreaterThan(0);
      });

      const beforeRegen = new Date().toISOString();
      
      await act(async () => {
        // Pass scenario directly
        await result.current.regenerateScenario(scenario.id, scenario);
      });

      // Wait for scenario to be updated with lastRegeneratedAt
      await waitFor(() => {
        const updated = result.current.scenarios.find(s => s.id === scenario.id);
        expect(updated?.meta?.lastRegeneratedAt).toBeDefined();
        expect(new Date(updated!.meta!.lastRegeneratedAt!).getTime())
          .toBeGreaterThanOrEqual(new Date(beforeRegen).getTime());
      });
    });

    it('should skip regeneration for non-live scenarios', async () => {
      const { result } = renderHook(() => useScenariosContext(), {
        wrapper: createWrapper(),
      });

      // Wait for DB load to complete first
      await waitForReady(result);

      // Create a blank (non-live) scenario
      let scenario: any;
      await act(async () => {
        scenario = await result.current.createBlank('test-tab');
      });

      // Verify scenario was added to state
      await waitFor(() => {
        expect(result.current.scenarios.length).toBeGreaterThan(0);
      });

      // Clear mocks to track new calls
      vi.clearAllMocks();

      // Try to regenerate - should be skipped (pass scenario directly)
      await act(async () => {
        await result.current.regenerateScenario(scenario.id, scenario);
      });

      // fetchDataService should NOT have been called for non-live scenario
      expect(fetchDataService.checkDSLNeedsFetch).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // regenerateAllLive tests
  // ==========================================================================

  describe('regenerateAllLive', () => {
    it('should regenerate all live scenarios', async () => {
      const { result } = renderHook(() => useScenariosContext(), {
        wrapper: createWrapper(),
      });

      // Wait for DB load to complete first
      await waitForReady(result);

      // Create multiple live scenarios
      let scenario1: any, scenario2: any;
      await act(async () => {
        scenario1 = await result.current.createLiveScenario('context(channel:google)', undefined, 'test-tab');
        scenario2 = await result.current.createLiveScenario('context(channel:meta)', undefined, 'test-tab');
      });

      // Verify scenarios were added to state
      await waitFor(() => {
        expect(result.current.scenarios.length).toBe(2);
      });

      vi.clearAllMocks();

      // Regenerate all - pass visibleOrder with scenario IDs
      await act(async () => {
        await result.current.regenerateAllLive(undefined, [scenario1.id, scenario2.id]);
      });

      // Both scenarios should have been processed
      expect(fetchDataService.checkDSLNeedsFetch).toHaveBeenCalledTimes(2);
    });

    it('should NOT regenerate static scenarios', async () => {
      const { result } = renderHook(() => useScenariosContext(), {
        wrapper: createWrapper(),
      });

      // Wait for DB load to complete first
      await waitForReady(result);

      // Create one live and one static scenario
      let liveScenario: any, staticScenario: any;
      await act(async () => {
        liveScenario = await result.current.createLiveScenario('context(channel:google)', undefined, 'test-tab');
        staticScenario = await result.current.createBlank('test-tab'); // Static
      });

      // Verify scenarios were added to state
      await waitFor(() => {
        expect(result.current.scenarios.length).toBe(2);
      });

      vi.clearAllMocks();

      // Pass both in visibleOrder - only live should be processed
      await act(async () => {
        await result.current.regenerateAllLive(undefined, [liveScenario.id, staticScenario.id]);
      });

      // Only live scenario should be processed
      expect(fetchDataService.checkDSLNeedsFetch).toHaveBeenCalledTimes(1);
    });

    it('should use baseDSLOverride when provided', async () => {
      const { result } = renderHook(() => useScenariosContext(), {
        wrapper: createWrapper(),
      });

      // Wait for DB load to complete first
      await waitForReady(result);

      let scenario: any;
      await act(async () => {
        scenario = await result.current.createLiveScenario('context(channel:google)', undefined, 'test-tab');
      });

      // Verify scenario was added to state
      await waitFor(() => {
        expect(result.current.scenarios.length).toBe(1);
      });

      vi.clearAllMocks();

      const newBaseDSL = 'window(15-Nov-25:21-Nov-25)';
      await act(async () => {
        await result.current.regenerateAllLive(newBaseDSL, [scenario.id]);
      });

      // Verify regeneration happened with the override
      expect(fetchDataService.checkDSLNeedsFetch).toHaveBeenCalled();
    });

    it('should handle empty scenario list gracefully', async () => {
      const { result } = renderHook(() => useScenariosContext(), {
        wrapper: createWrapper(),
      });

      // No scenarios created - should not throw
      await act(async () => {
        await result.current.regenerateAllLive(undefined, []);
      });

      expect(fetchDataService.checkDSLNeedsFetch).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // putToBase tests
  // ==========================================================================

  describe('putToBase', () => {
    it('should set baseDSL from current graph DSL', async () => {
      const { result } = renderHook(() => useScenariosContext(), {
        wrapper: createWrapper(),
      });

      // Wait for DB load to complete first
      await waitForReady(result);

      // Create a live scenario first
      let scenario: any;
      await act(async () => {
        scenario = await result.current.createLiveScenario('context(channel:google)', undefined, 'test-tab');
      });

      // Verify scenario was added to state
      await waitFor(() => {
        expect(result.current.scenarios.length).toBe(1);
      });

      await act(async () => {
        await result.current.putToBase([scenario.id]);
      });

      // baseDSL should be set (from mocked currentDSL: 'window(1-Nov-25:7-Nov-25)')
      await waitFor(() => {
        expect(result.current.baseDSL).toBe('window(1-Nov-25:7-Nov-25)');
      });
    });

    it('should regenerate all live scenarios after setting baseDSL', async () => {
      const { result } = renderHook(() => useScenariosContext(), {
        wrapper: createWrapper(),
      });

      // Wait for DB load to complete first
      await waitForReady(result);

      let scenario1: any, scenario2: any;
      await act(async () => {
        scenario1 = await result.current.createLiveScenario('context(channel:google)', undefined, 'test-tab');
        scenario2 = await result.current.createLiveScenario('context(channel:meta)', undefined, 'test-tab');
      });

      // Verify scenarios were added to state
      await waitFor(() => {
        expect(result.current.scenarios.length).toBe(2);
      });

      vi.clearAllMocks();

      await act(async () => {
        await result.current.putToBase([scenario1.id, scenario2.id]);
      });

      // Both live scenarios should be regenerated
      expect(fetchDataService.checkDSLNeedsFetch).toHaveBeenCalledTimes(2);
    });

    it('should NOT regenerate static scenarios', async () => {
      const { result } = renderHook(() => useScenariosContext(), {
        wrapper: createWrapper(),
      });

      // Wait for DB load to complete first
      await waitForReady(result);

      let liveScenario: any, staticScenario: any;
      await act(async () => {
        liveScenario = await result.current.createLiveScenario('context(channel:google)', undefined, 'test-tab');
        staticScenario = await result.current.createBlank('test-tab'); // Static
      });

      // Verify scenarios were added to state
      await waitFor(() => {
        expect(result.current.scenarios.length).toBe(2);
      });

      vi.clearAllMocks();

      await act(async () => {
        await result.current.putToBase([liveScenario.id, staticScenario.id]);
      });

      // Only live scenario regenerated
      expect(fetchDataService.checkDSLNeedsFetch).toHaveBeenCalledTimes(1);
    });

    it('should fall back to regenerating all live scenarios when visibleOrder yields no live matches', async () => {
      const { result } = renderHook(() => useScenariosContext(), {
        wrapper: createWrapper(),
      });

      // Wait for DB load to complete first
      await waitForReady(result);

      let scenario: any;
      await act(async () => {
        scenario = await result.current.createLiveScenario('context(channel:google)', undefined, 'test-tab');
      });

      // Verify scenario was added to state
      await waitFor(() => {
        expect(result.current.scenarios.length).toBe(1);
      });

      vi.clearAllMocks();

      // Intentionally pass a non-empty visibleOrder that contains no scenario IDs.
      // This simulates stale tab visibility state (e.g. only special layer IDs),
      // which previously caused regenerateAllLive to do nothing.
      await act(async () => {
        await result.current.putToBase(['base', 'current']);
      });

      // Live scenario should still be regenerated via fallback.
      expect(fetchDataService.checkDSLNeedsFetch).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // updateScenarioQueryDSL tests
  // ==========================================================================

  describe('updateScenarioQueryDSL', () => {
    it('should update scenario queryDSL', async () => {
      const { result } = renderHook(() => useScenariosContext(), {
        wrapper: createWrapper(),
      });

      // Wait for DB load to complete first
      await waitForReady(result);

      let scenario: any;
      await act(async () => {
        scenario = await result.current.createLiveScenario(
          'context(channel:google)',
          undefined,
          'test-tab'
        );
      });

      // Verify scenario was added to state
      await waitFor(() => {
        expect(result.current.scenarios.length).toBe(1);
      });

      const newDSL = 'context(channel:meta)';
      await act(async () => {
        await result.current.updateScenarioQueryDSL(scenario.id, newDSL);
      });

      // Wait for queryDSL to be updated
      await waitFor(() => {
        const updatedScenario = result.current.scenarios.find(s => s.id === scenario.id);
        expect(updatedScenario?.meta?.queryDSL).toBe(newDSL);
      });
    });

    it('should trigger regeneration after DSL update', async () => {
      const { result } = renderHook(() => useScenariosContext(), {
        wrapper: createWrapper(),
      });

      // Wait for DB load to complete first
      await waitForReady(result);

      let scenario: any;
      await act(async () => {
        scenario = await result.current.createLiveScenario(
          'context(channel:google)',
          undefined,
          'test-tab'
        );
      });

      // Verify scenario was added to state
      await waitFor(() => {
        expect(result.current.scenarios.length).toBe(1);
      });

      vi.clearAllMocks();

      await act(async () => {
        await result.current.updateScenarioQueryDSL(scenario.id, 'context(channel:meta)');
      });

      // Regeneration should have been triggered
      expect(fetchDataService.checkDSLNeedsFetch).toHaveBeenCalled();
    });

    it('should set isLive=false if DSL is cleared', async () => {
      const { result } = renderHook(() => useScenariosContext(), {
        wrapper: createWrapper(),
      });

      // Wait for DB load to complete first
      await waitForReady(result);

      let scenario: any;
      await act(async () => {
        scenario = await result.current.createLiveScenario(
          'context(channel:google)',
          undefined,
          'test-tab'
        );
      });

      // Verify scenario was added to state
      await waitFor(() => {
        expect(result.current.scenarios.length).toBe(1);
      });

      await act(async () => {
        await result.current.updateScenarioQueryDSL(scenario.id, '');
      });

      // Wait for isLive to be updated
      await waitFor(() => {
        const updatedScenario = result.current.scenarios.find(s => s.id === scenario.id);
        expect(updatedScenario?.meta?.isLive).toBe(false);
      });
    });
  });
});

