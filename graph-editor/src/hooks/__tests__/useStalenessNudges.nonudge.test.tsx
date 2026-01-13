/**
 * useStalenessNudges – nonudge URL param suppression
 *
 * @vitest-environment happy-dom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';

// Minimal stubs for dependencies used by useStalenessNudges.
vi.mock('../../services/stalenessNudgeService', () => ({
  stalenessNudgeService: {
    clearVolatileFlags: vi.fn(),
    recordPageLoad: vi.fn(),
    isSnoozed: vi.fn(() => false),
    shouldPromptReload: vi.fn(() => true),
    canPrompt: vi.fn(() => true),
    shouldCheckRemoteHead: vi.fn(() => false),
    markRemoteHeadChecked: vi.fn(),
    isRemoteShaDismissed: vi.fn(() => false),
    dismissRemoteSha: vi.fn(),
    clearDismissedRemoteSha: vi.fn(),
    getRemoteAheadStatus: vi.fn(async () => ({ isRemoteAhead: false })),
    getRetrieveAllSlicesStalenessStatus: vi.fn(async () => ({ isStale: true })),
    markPrompted: vi.fn(),
    snooze: vi.fn(),
  },
}));

vi.mock('../usePullAll', () => ({
  usePullAll: () => ({ pullAll: vi.fn(async () => {}), conflictModal: React.createElement('div', { 'data-testid': 'conflict-modal' }) }),
}));

vi.mock('../useRetrieveAllSlicesRequestListener', () => ({
  requestRetrieveAllSlices: vi.fn(),
}));

vi.mock('../../services/retrieveAllSlicesService', () => ({
  retrieveAllSlicesService: {
    execute: vi.fn(async () => {}),
  },
}));

vi.mock('../../services/sessionLogService', () => ({
  sessionLogService: {
    info: vi.fn(),
    openLogTab: vi.fn(),
  },
}));

vi.mock('../../contexts/NavigatorContext', () => ({
  useNavigatorContext: () => ({ state: { selectedRepo: 'r', selectedBranch: 'main' } }),
}));

vi.mock('../../contexts/TabContext', () => ({
  useTabContext: () => ({ activeTabId: null, tabs: [], operations: {} }),
  useFileRegistry: () => ({ getFile: () => null, subscribe: () => () => {} }),
}));

import { useStalenessNudges } from '../useStalenessNudges';

function Harness() {
  const { modals } = useStalenessNudges();
  return <div>{modals}</div>;
}

describe('useStalenessNudges (nonudge)', () => {
  const originalHref = window.location.href;

  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    window.history.replaceState({}, document.title, '/?nonudge=1');
  });

  afterEach(() => {
    window.history.replaceState({}, document.title, originalHref);
  });

  it('suppresses the staleness update modal when nonudge is present', async () => {
    const { queryByText, getByTestId } = render(<Harness />);

    // Conflict modal remains renderable (only shown when needed).
    expect(getByTestId('conflict-modal')).toBeTruthy();

    // The staleness modal title should not appear when suppressed.
    expect(queryByText('Updates recommended')).toBeNull();
  });
});


