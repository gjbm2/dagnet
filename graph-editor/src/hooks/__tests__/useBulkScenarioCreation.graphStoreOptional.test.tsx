/**
 * useBulkScenarioCreation - optional GraphStore
 *
 * Regression test for menu-driven modals (e.g. PinnedQueryModal) that can mount
 * QueryExpressionEditor via a portal outside GraphStoreProvider.
 *
 * @vitest-environment happy-dom
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

// Minimal TabContext mock (hook only needs activeTabId + operations)
vi.mock('../../contexts/TabContext', () => ({
  useTabContext: () => ({
    activeTabId: 'tab-1',
    operations: {
      addVisibleScenarios: vi.fn(async () => {}),
      getScenarioState: vi.fn(() => ({ visibleScenarioIds: [] })),
    },
  }),
}));

// Minimal ScenariosContext mock (optional hook may return null in some surfaces; here we provide it)
vi.mock('../../contexts/ScenariosContext', () => ({
  SCENARIO_PALETTE: ['#000000'],
  useScenariosContextOptional: () => ({
    scenarios: [],
    setBaseDSL: vi.fn(),
    createLiveScenario: vi.fn(async (dsl: string) => ({ id: `s-${dsl}`, colour: '#000000' })),
    regenerateScenario: vi.fn(async () => {}),
  }),
}));

// Keep this test focused: we don't care about actual context registry lookups here.
vi.mock('../../services/contextRegistry', () => ({
  contextRegistry: {
    getValuesForContext: vi.fn(async () => []),
  },
}));

import { useBulkScenarioCreation } from '../useBulkScenarioCreation';

function Harness() {
  // Intentionally render WITHOUT GraphStoreProvider
  const api = useBulkScenarioCreation();
  // If the hook throws, render() will fail. We just need it to mount.
  return <div data-testid="ok">{typeof api.createWindowScenario}</div>;
}

describe('useBulkScenarioCreation', () => {
  it('does not throw when GraphStoreProvider is missing', () => {
    expect(() => render(<Harness />)).not.toThrow();
  });
});




