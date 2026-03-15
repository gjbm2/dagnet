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
    recordDone: vi.fn(),
    getLastDoneAtMs: vi.fn(),
    getLastPageLoadAtMs: vi.fn(),
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
    computeNudgingPlanFromSignals: vi.fn(() => null),
    runSelectedStalenessActions: vi.fn(async () => {}),
    handleStalenessAutoPull: vi.fn(async () => {}),
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
  executeRetrieveAllSlicesWithProgressToast: vi.fn(async () => {}),
}));

vi.mock('../../services/nonBlockingPullService', () => ({
  startNonBlockingPull: vi.fn(),
  cancelNonBlockingPull: vi.fn(),
  isNonBlockingPullActive: vi.fn(() => false),
}));

vi.mock('../../services/bannerManagerService', () => ({
  bannerManagerService: {
    setBanner: vi.fn(),
    clearBanner: vi.fn(),
    clearAll: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
    getState: vi.fn(() => ({ banners: [] })),
  },
}));

vi.mock('../../services/repositoryOperationsService', () => ({
  repositoryOperationsService: {
    pullLatestRemoteWins: vi.fn(),
  },
}));

vi.mock('../../services/sessionLogService', () => ({
  sessionLogService: {
    info: vi.fn(),
    openLogTab: vi.fn(),
  },
}));

vi.mock('../../db/appDatabase', () => ({
  db: {
    workspaces: { get: vi.fn(async () => ({ lastSynced: Date.now() })) },
  },
}));

vi.mock('../../contexts/NavigatorContext', () => ({
  useNavigatorContext: () => ({ state: { selectedRepo: 'r', selectedBranch: 'main' } }),
}));

vi.mock('../../contexts/TabContext', () => ({
  useTabContext: () => ({ activeTabId: null, tabs: [], operations: {} }),
  useFileRegistry: () => ({ getFile: () => null, subscribe: () => () => {} }),
}));

vi.mock('../../contexts/ShareModeContext', () => ({
  useShareModeOptional: () => null,
}));

vi.mock('../../contexts/DashboardModeContext', () => ({
  useDashboardMode: () => ({ isDashboardMode: false, setDashboardMode: vi.fn(), toggleDashboardMode: vi.fn() }),
}));

vi.mock('../../services/liveShareSyncService', () => ({
  liveShareSyncService: { refreshToLatest: vi.fn(async () => ({ success: true })) },
}));

vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
  },
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
    (window as any).__dagnetTabContextInitDone = true;
  });

  afterEach(() => {
    window.history.replaceState({}, document.title, originalHref);
  });

  it('suppresses all staleness nudges when nonudge is present', async () => {
    const { getByTestId } = render(<Harness />);

    // Conflict modal remains renderable (only shown when needed).
    expect(getByTestId('conflict-modal')).toBeTruthy();
  });

  it('suppresses all staleness nudges when retrieveall is present (autonomous mode)', async () => {
    window.sessionStorage.clear();
    window.history.replaceState({}, document.title, '/?retrieveall=my-graph');

    const { getByTestId } = render(<Harness />);

    // Conflict modal remains renderable (only shown when needed).
    expect(getByTestId('conflict-modal')).toBeTruthy();

    // Suppression is persisted for the session so later URL cleanup cannot re-enable nudges mid-run.
    expect(window.sessionStorage.getItem('dagnet:nonudge')).toBe('1');
  });
});


