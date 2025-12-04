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
import { renderHook, act } from '@testing-library/react';
import React from 'react';

// Mock dependencies before importing the context
vi.mock('../../services/fetchDataService', () => ({
  fetchDataService: {
    checkDSLNeedsFetch: vi.fn().mockReturnValue({ needsFetch: false, items: [] }),
    checkMultipleDSLsNeedFetch: vi.fn().mockReturnValue([]),
    getItemsNeedingFetch: vi.fn().mockReturnValue([]),
    fetchItems: vi.fn().mockResolvedValue([]),
    extractWindowFromDSL: vi.fn().mockReturnValue({ start: '1-Nov-25', end: '7-Nov-25' }),
  },
}));

vi.mock('../../db/appDatabase', () => ({
  db: {
    scenarios: {
      where: vi.fn().mockReturnValue({
        equals: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([]),
        }),
      }),
      bulkPut: vi.fn().mockResolvedValue(undefined),
      bulkDelete: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

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

// Helper to create wrapper with provider
function createWrapper(fileId = 'test-file') {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <ScenariosProvider fileId={fileId} tabId="test-tab">
        {children}
      </ScenariosProvider>
    );
  };
}

describe('ScenariosContext - Live Scenarios', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

      // Regenerate - should use baseDSL
      await act(async () => {
        await result.current.regenerateScenario(scenario.id);
      });

      // Verify fetchDataService was called (indicates regeneration happened)
      expect(fetchDataService.checkDSLNeedsFetch).toHaveBeenCalled();
    });

    it('should record lastEffectiveDSL after regeneration', async () => {
      const { result } = renderHook(() => useScenariosContext(), {
        wrapper: createWrapper(),
      });

      // Create and regenerate a live scenario
      let scenario: any;
      await act(async () => {
        scenario = await result.current.createLiveScenario(
          'context(channel:google)',
          undefined,
          'test-tab'
        );
      });

      await act(async () => {
        await result.current.regenerateScenario(scenario.id);
      });

      // Find the updated scenario
      const updatedScenario = result.current.scenarios.find(s => s.id === scenario.id);
      expect(updatedScenario?.meta?.lastEffectiveDSL).toBeDefined();
    });

    it('should update lastRegeneratedAt timestamp after regeneration', async () => {
      const { result } = renderHook(() => useScenariosContext(), {
        wrapper: createWrapper(),
      });

      let scenario: any;
      await act(async () => {
        scenario = await result.current.createLiveScenario(
          'context(channel:google)',
          undefined,
          'test-tab'
        );
      });

      const beforeRegen = new Date().toISOString();
      
      await act(async () => {
        await result.current.regenerateScenario(scenario.id);
      });

      const updatedScenario = result.current.scenarios.find(s => s.id === scenario.id);
      expect(updatedScenario?.meta?.lastRegeneratedAt).toBeDefined();
      expect(new Date(updatedScenario!.meta!.lastRegeneratedAt!).getTime())
        .toBeGreaterThanOrEqual(new Date(beforeRegen).getTime());
    });

    it('should skip regeneration for non-live scenarios', async () => {
      const { result } = renderHook(() => useScenariosContext(), {
        wrapper: createWrapper(),
      });

      // Create a blank (non-live) scenario
      let scenario: any;
      await act(async () => {
        scenario = await result.current.createBlank('test-tab');
      });

      // Clear mocks to track new calls
      vi.clearAllMocks();

      // Try to regenerate - should be skipped
      await act(async () => {
        await result.current.regenerateScenario(scenario.id);
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

      // Create multiple live scenarios
      await act(async () => {
        await result.current.createLiveScenario('context(channel:google)', undefined, 'test-tab');
        await result.current.createLiveScenario('context(channel:meta)', undefined, 'test-tab');
      });

      vi.clearAllMocks();

      // Regenerate all
      await act(async () => {
        await result.current.regenerateAllLive();
      });

      // Both scenarios should have been processed
      // (checkDSLNeedsFetch called for each)
      expect(fetchDataService.checkDSLNeedsFetch).toHaveBeenCalledTimes(2);
    });

    it('should NOT regenerate static scenarios', async () => {
      const { result } = renderHook(() => useScenariosContext(), {
        wrapper: createWrapper(),
      });

      // Create one live and one static scenario
      await act(async () => {
        await result.current.createLiveScenario('context(channel:google)', undefined, 'test-tab');
        await result.current.createBlank('test-tab'); // Static
      });

      vi.clearAllMocks();

      await act(async () => {
        await result.current.regenerateAllLive();
      });

      // Only live scenario should be processed
      expect(fetchDataService.checkDSLNeedsFetch).toHaveBeenCalledTimes(1);
    });

    it('should use baseDSLOverride when provided', async () => {
      const { result } = renderHook(() => useScenariosContext(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await result.current.createLiveScenario('context(channel:google)', undefined, 'test-tab');
      });

      vi.clearAllMocks();

      const newBaseDSL = 'window(15-Nov-25:21-Nov-25)';
      await act(async () => {
        await result.current.regenerateAllLive(newBaseDSL);
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
        await result.current.regenerateAllLive();
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

      // Create a live scenario first
      await act(async () => {
        await result.current.createLiveScenario('context(channel:google)', undefined, 'test-tab');
      });

      await act(async () => {
        await result.current.putToBase();
      });

      // baseDSL should be set (from mocked currentDSL: 'window(1-Nov-25:7-Nov-25)')
      expect(result.current.baseDSL).toBeDefined();
    });

    it('should regenerate all live scenarios after setting baseDSL', async () => {
      const { result } = renderHook(() => useScenariosContext(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await result.current.createLiveScenario('context(channel:google)', undefined, 'test-tab');
        await result.current.createLiveScenario('context(channel:meta)', undefined, 'test-tab');
      });

      vi.clearAllMocks();

      await act(async () => {
        await result.current.putToBase();
      });

      // Both live scenarios should be regenerated
      expect(fetchDataService.checkDSLNeedsFetch).toHaveBeenCalledTimes(2);
    });

    it('should NOT regenerate static scenarios', async () => {
      const { result } = renderHook(() => useScenariosContext(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await result.current.createLiveScenario('context(channel:google)', undefined, 'test-tab');
        await result.current.createBlank('test-tab'); // Static
      });

      vi.clearAllMocks();

      await act(async () => {
        await result.current.putToBase();
      });

      // Only live scenario regenerated
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

      let scenario: any;
      await act(async () => {
        scenario = await result.current.createLiveScenario(
          'context(channel:google)',
          undefined,
          'test-tab'
        );
      });

      const newDSL = 'context(channel:meta)';
      await act(async () => {
        await result.current.updateScenarioQueryDSL(scenario.id, newDSL);
      });

      const updatedScenario = result.current.scenarios.find(s => s.id === scenario.id);
      expect(updatedScenario?.meta?.queryDSL).toBe(newDSL);
    });

    it('should trigger regeneration after DSL update', async () => {
      const { result } = renderHook(() => useScenariosContext(), {
        wrapper: createWrapper(),
      });

      let scenario: any;
      await act(async () => {
        scenario = await result.current.createLiveScenario(
          'context(channel:google)',
          undefined,
          'test-tab'
        );
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

      let scenario: any;
      await act(async () => {
        scenario = await result.current.createLiveScenario(
          'context(channel:google)',
          undefined,
          'test-tab'
        );
      });

      await act(async () => {
        await result.current.updateScenarioQueryDSL(scenario.id, '');
      });

      const updatedScenario = result.current.scenarios.find(s => s.id === scenario.id);
      expect(updatedScenario?.meta?.isLive).toBe(false);
    });
  });
});

