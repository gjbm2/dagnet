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
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import React from 'react';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

// Mock external dependencies but use REAL IndexedDB (via fake-indexeddb)
vi.mock('../../services/fetchDataService', () => ({
  fetchDataService: {
    checkDSLNeedsFetch: vi.fn().mockReturnValue({ needsFetch: false, items: [] }),
    checkMultipleDSLsNeedFetch: vi.fn().mockReturnValue([]),
    getItemsNeedingFetch: vi.fn().mockReturnValue([]),
    getItemsForFromFileLoad: vi.fn().mockReturnValue([]),
    fetchItems: vi.fn().mockResolvedValue([]),
    extractWindowFromDSL: vi.fn().mockReturnValue({ start: '1-Nov-25', end: '7-Nov-25' }),
  },
}));

vi.mock('../../services/fetchOrchestratorService', () => ({
  fetchOrchestratorService: {
    buildPlan: vi.fn(() => ({ plan: { version: 1, createdAt: 'x', referenceNow: 'x', dsl: 'x', items: [] } })),
    executePlan: vi.fn(async () => ({ plan: { version: 1, createdAt: 'x', referenceNow: 'x', dsl: 'x', items: [] }, executedItemKeys: [], skippedCoveredItemKeys: [], skippedUnfetchableItemKeys: [], errors: [] })),
    refreshFromFilesWithRetries: vi.fn(async () => ({ attempts: 1, failures: 0 })),
  },
}));

// Force "normal workspace" boot mode for these tests.
// Share boot config is cached globally, so tests must not depend on ambient URL state.
vi.mock('../../lib/shareBootResolver', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    getShareBootConfig: () => ({ ...(actual.getShareBootConfig?.() || {}), mode: 'none' }),
  };
});

// DO NOT mock db/appDatabase - use real Dexie with fake-indexeddb

vi.mock('../GraphStoreContext', () => ({
  useGraphStore: vi.fn((() => {
    const state = {
      graph: {
        nodes: [],
        edges: [],
        baseDSL: '',
      },
      currentDSL: 'window(1-Nov-25:7-Nov-25)',
      currentWindow: { start: '1-Nov-25', end: '7-Nov-25' },
      setGraph: vi.fn(),
    };
    const store: any = (sel?: any) => (typeof sel === 'function' ? sel(state) : undefined);
    store.getState = () => state;
    return (selector?: any) => (typeof selector === 'function' ? selector(state) : store);
  })()),
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

vi.mock('../../services/chartRecomputeService', () => ({
  recomputeOpenChartsForGraph: vi.fn().mockResolvedValue({ updatedChartFileIds: [], skippedChartFileIds: [] }),
}));

// Import after mocks
import { ScenariosProvider, useScenariosContext } from '../ScenariosContext';
import { fetchDataService } from '../../services/fetchDataService';
import { fetchOrchestratorService } from '../../services/fetchOrchestratorService';
import { db } from '../../db/appDatabase';
import { recomputeOpenChartsForGraph } from '../../services/chartRecomputeService';
import { autoUpdatePolicyService } from '../../services/autoUpdatePolicyService';

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
    // Ensure default singleton rows exist (app-state/settings), otherwise saveAppState(update) is a no-op.
    await db.initialize();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    cleanup();
    // Clean up after each test
    await db.scenarios.clear().catch(() => {});
  });

  describe('auto-update charts orchestration', () => {
    it('auto-reconciles charts after live scenario regeneration when auto-update is enabled', async () => {
      vi.mocked(recomputeOpenChartsForGraph).mockClear();

      const { result } = renderHook(() => useScenariosContext(), {
        wrapper: createWrapper(),
      });

      await waitForReady(result);

      let scenario: any;
      await act(async () => {
        scenario = await result.current.createLiveScenario('context(channel:google)', undefined, 'test-tab');
      });

      await act(async () => {
        await result.current.regenerateScenario(scenario.id, scenario);
      });

      // Debounced reconcile (250ms)
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(vi.mocked(recomputeOpenChartsForGraph)).toHaveBeenCalled();
    });

    it('does not auto-reconcile charts when the workspace toggle is disabled', async () => {
      await db.saveAppState({ autoUpdateChartsEnabled: false });
      const policy = await autoUpdatePolicyService.getAutoUpdateChartsPolicy();
      expect(policy.enabled).toBe(false);
      vi.mocked(recomputeOpenChartsForGraph).mockClear();

      const { result } = renderHook(() => useScenariosContext(), {
        wrapper: createWrapper(),
      });

      await waitForReady(result);

      // Allow the policy load effect to run.
      await act(async () => {
        await Promise.resolve();
      });

      let scenario: any;
      await act(async () => {
        scenario = await result.current.createLiveScenario('context(channel:google)', undefined, 'test-tab');
      });

      await act(async () => {
        await result.current.regenerateScenario(scenario.id, scenario);
      });

      await new Promise(resolve => setTimeout(resolve, 300));

      expect(vi.mocked(recomputeOpenChartsForGraph)).not.toHaveBeenCalled();
    });

    it('still reconciles charts on manual refresh even when the workspace toggle is disabled', async () => {
      // Auto-update is disabled…
      await db.saveAppState({ autoUpdateChartsEnabled: false });
      const policy = await autoUpdatePolicyService.getAutoUpdateChartsPolicy();
      expect(policy.enabled).toBe(false);

      vi.mocked(recomputeOpenChartsForGraph).mockClear();

      const { result } = renderHook(() => useScenariosContext(), {
        wrapper: createWrapper('graph-test-manual-refresh'),
      });

      await waitForReady(result);

      // Fire the same event used by linked Refresh (chartRefreshService → ScenariosContext listener).
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent('dagnet:chartRefreshRequested', {
            detail: { graphFileId: 'graph-test-manual-refresh', chartFileId: 'chart-any' },
          })
        );
      });

      // Debounced reconcile (250ms)
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(vi.mocked(recomputeOpenChartsForGraph)).toHaveBeenCalled();
    });

    it('reconciles charts after workspace file revisions change (e.g. git pull) when auto-update is enabled', async () => {
      vi.mocked(recomputeOpenChartsForGraph).mockClear();
      vi.mocked(fetchDataService.checkDSLNeedsFetch).mockClear();

      // Capture the registered handler so we can invoke it deterministically (happy-dom event delivery can be finicky).
      const realAdd = window.addEventListener;
      const captured: any[] = [];
      (window as any).addEventListener = (type: any, listener: any, options?: any) => {
        if (type === 'dagnet:workspaceFilesChanged') captured.push(listener);
        return realAdd.call(window, type, listener, options);
      };

      // Seed the graph file source so the listener can match repo/branch.
      await db.files.put({
        fileId: 'test-file',
        type: 'graph',
        viewTabs: [],
        data: { nodes: [], edges: [], baseDSL: '', currentQueryDSL: '' },
        source: { repository: 'repo-1', branch: 'main', path: 'graphs/test.json' },
        lastModified: Date.now(),
        sha: 'graphsha1',
      } as any);
      const seeded: any = await db.files.get('test-file');
      expect(seeded?.source?.repository).toBe('repo-1');
      expect(seeded?.source?.branch).toBe('main');
      // Ensure workspace preference is explicitly ON for this test (avoid leakage from other tests).
      await db.saveAppState({ autoUpdateChartsEnabled: true });
      const p = await autoUpdatePolicyService.getAutoUpdateChartsPolicy();
      expect(p.enabled).toBe(true);

      const { result } = renderHook(() => useScenariosContext(), {
        wrapper: createWrapper('test-file'),
      });

      await waitForReady(result);

      // Create at least one live scenario so regenerateAllLive has work to do.
      let scenario: any;
      await act(async () => {
        scenario = await result.current.createLiveScenario('context(channel:google)', undefined, 'test-tab');
      });
      expect(scenario?.meta?.isLive).toBe(true);
      await waitFor(() => {
        expect(result.current.scenarios.some((s: any) => s.id === scenario.id)).toBe(true);
      });

      await waitFor(() => {
        expect(captured.length).toBeGreaterThan(0);
      }, { timeout: 2000 });

      // Invoke the handler directly (equivalent to a pullLatest signal).
      await act(async () => {
        await captured[captured.length - 1]({
          detail: { repository: 'repo-1', branch: 'main', changedFiles: ['parameters/foo.yaml'] },
        });
      });

      // Sanity: the handler should attempt regeneration (which calls fetch planning).
      await waitFor(() => {
        expect((fetchOrchestratorService as any).buildPlan).toHaveBeenCalled();
      }, { timeout: 2000 });

      // Reconcile is debounced (250ms) and also waits for regenerateAllLive to complete.
      await waitFor(() => {
        expect(vi.mocked(recomputeOpenChartsForGraph)).toHaveBeenCalled();
      }, { timeout: 2000 });

      // Restore addEventListener for isolation.
      (window as any).addEventListener = realAdd;
    });

    it('ignores workspace change events with missing or mismatched repo/branch', async () => {
      vi.mocked(recomputeOpenChartsForGraph).mockClear();
      vi.mocked(fetchDataService.checkDSLNeedsFetch).mockClear();

      const realAdd = window.addEventListener;
      const captured: any[] = [];
      (window as any).addEventListener = (type: any, listener: any, options?: any) => {
        if (type === 'dagnet:workspaceFilesChanged') captured.push(listener);
        return realAdd.call(window, type, listener, options);
      };

      await db.files.put({
        fileId: 'test-file',
        type: 'graph',
        viewTabs: [],
        data: { nodes: [], edges: [], baseDSL: '', currentQueryDSL: '' },
        source: { repository: 'repo-1', branch: 'main', path: 'graphs/test.json' },
        lastModified: Date.now(),
        sha: 'graphsha1',
      } as any);
      await db.saveAppState({ autoUpdateChartsEnabled: true });

      const { result } = renderHook(() => useScenariosContext(), {
        wrapper: createWrapper('test-file'),
      });

      await waitForReady(result);

      await waitFor(() => {
        expect(captured.length).toBeGreaterThan(0);
      }, { timeout: 2000 });

      await act(async () => {
        await captured[captured.length - 1]({ detail: { repository: 'repo-2', branch: 'main' } });
        await captured[captured.length - 1]({ detail: { repository: 'repo-1', branch: '' } });
        await captured[captured.length - 1]({ detail: { repository: '', branch: 'main' } });
      });

      expect((fetchOrchestratorService as any).buildPlan).not.toHaveBeenCalled();
      expect(vi.mocked(recomputeOpenChartsForGraph)).not.toHaveBeenCalled();

      (window as any).addEventListener = realAdd;
    });
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
      expect((fetchOrchestratorService as any).buildPlan).toHaveBeenCalled();

      // IMPORTANT: Live scenario regeneration should match Current semantics by default:
      // Stage-2 (LAG topo + inbound-n + evidence/forecast blending) must run unless explicitly disabled.
      expect((fetchOrchestratorService as any).refreshFromFilesWithRetries).toHaveBeenCalledWith(
        expect.objectContaining({ skipStage2: false })
      );
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

    it('should persist a deps_signature_v1 provenance stamp after live scenario regeneration', async () => {
      const { result } = renderHook(() => useScenariosContext(), {
        wrapper: createWrapper('graph-provenance-test'),
      });

      await waitForReady(result);

      let scenario: any;
      await act(async () => {
        scenario = await result.current.createLiveScenario('context(channel:google)', undefined, 'test-tab');
      });

      await act(async () => {
        await result.current.regenerateScenario(scenario.id, scenario);
      });

      await waitFor(() => {
        const updated = result.current.scenarios.find(s => s.id === scenario.id);
        expect(typeof updated?.meta?.deps_signature_v1).toBe('string');
        expect(updated?.meta?.deps_signature_v1?.startsWith('v1:')).toBe(true);
        expect(updated?.meta?.deps_v1?.v).toBe(1);
        expect(Array.isArray(updated?.meta?.deps_v1?.inputs)).toBe(true);
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
        scenario = await result.current.createBlank('Blank', 'test-tab');
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

      // Orchestrator should NOT have been called for non-live scenario
      expect((fetchOrchestratorService as any).buildPlan).not.toHaveBeenCalled();
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
      expect((fetchOrchestratorService as any).buildPlan).toHaveBeenCalledTimes(2);
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
        staticScenario = await result.current.createBlank('Static', 'test-tab'); // Static
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
      expect((fetchOrchestratorService as any).buildPlan).toHaveBeenCalledTimes(1);
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
      expect((fetchOrchestratorService as any).buildPlan).toHaveBeenCalled();
    });

    it('should handle empty scenario list gracefully', async () => {
      const { result } = renderHook(() => useScenariosContext(), {
        wrapper: createWrapper(),
      });

      // No scenarios created - should not throw
      await act(async () => {
        await result.current.regenerateAllLive(undefined, []);
      });

      expect((fetchOrchestratorService as any).buildPlan).not.toHaveBeenCalled();
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
      expect((fetchOrchestratorService as any).buildPlan).toHaveBeenCalledTimes(2);
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
        staticScenario = await result.current.createBlank('Static', 'test-tab'); // Static
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
      expect((fetchOrchestratorService as any).buildPlan).toHaveBeenCalledTimes(1);
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
      expect((fetchOrchestratorService as any).buildPlan).toHaveBeenCalledTimes(1);
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
      expect((fetchOrchestratorService as any).buildPlan).toHaveBeenCalled();
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

