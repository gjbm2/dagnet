/**
 * discardLocalChanges Integration Tests
 *
 * Verifies that discardLocalChanges uses IDB (source of truth) to find ALL
 * dirty files — not just those loaded in FileRegistry (open tabs).
 *
 * Scenarios:
 *  - Dirty file in both IDB and FileRegistry → reverted via fileRegistry.revertFile
 *  - Dirty file only in IDB (not open) → patched directly in IDB
 *  - Local-only file (no originalData) in IDB → deleted from IDB
 *  - Files from other workspaces are NOT touched
 *  - Returns correct count
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fileRegistry } from '../../contexts/TabContext';

// IDB store — accumulates put/delete calls so we can assert on them
const idbStore = new Map<string, any>();

vi.mock('../../db/appDatabase', () => ({
  db: {
    getDirtyFiles: vi.fn(async () => {
      return Array.from(idbStore.values()).filter((f: any) => f.isDirty);
    }),
    files: {
      put: vi.fn(async (file: any) => { idbStore.set(file.fileId, { ...file }); }),
      delete: vi.fn(async (id: string) => { idbStore.delete(id); }),
      toArray: vi.fn(async () => Array.from(idbStore.values())),
      get: vi.fn(async (id: string) => idbStore.get(id) ?? null),
    },
  },
}));

vi.mock('../sessionLogService', () => ({
  sessionLogService: {
    startOperation: vi.fn(() => 'op-1'),
    addChild: vi.fn(),
    endOperation: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

// We import AFTER mocks are set up
const { repositoryOperationsService } = await import('../repositoryOperationsService');

const REPO = 'test-repo';
const BRANCH = 'main';
const PREFIX = `${REPO}-${BRANCH}-`;

function makeIdbFile(unprefixedId: string, overrides: Record<string, any> = {}) {
  const base = {
    fileId: `${PREFIX}${unprefixedId}`,
    type: 'graph' as const,
    data: { nodes: [{ id: 'changed' }], edges: [] },
    originalData: { nodes: [], edges: [] },
    isDirty: true,
    isLoaded: true,
    viewTabs: [],
    lastModified: Date.now(),
    source: { repository: REPO, branch: BRANCH, path: `graphs/${unprefixedId}.json` },
  };
  return { ...base, ...overrides };
}

function makeRegistryFile(unprefixedId: string, overrides: Record<string, any> = {}) {
  const base = {
    fileId: unprefixedId,
    type: 'graph' as const,
    data: { nodes: [{ id: 'changed' }], edges: [] },
    originalData: { nodes: [], edges: [] },
    isDirty: true,
    isLoaded: true,
    viewTabs: [],
    lastModified: Date.now(),
    source: { repository: REPO, branch: BRANCH, path: `graphs/${unprefixedId}.json` },
  };
  return { ...base, ...overrides };
}

describe('repositoryOperationsService.discardLocalChanges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    idbStore.clear();
    (fileRegistry as any).files.clear();
  });

  it('should revert dirty files found in IDB that are also loaded in FileRegistry', async () => {
    // File exists in both IDB (prefixed) and FileRegistry (unprefixed)
    idbStore.set(`${PREFIX}graph-open`, makeIdbFile('graph-open'));
    (fileRegistry as any).files.set('graph-open', makeRegistryFile('graph-open'));

    const count = await repositoryOperationsService.discardLocalChanges(REPO, BRANCH);

    expect(count).toBe(1);

    // FileRegistry file should be reverted (data matches originalData, not dirty)
    const regFile = fileRegistry.getFile('graph-open');
    expect(regFile).toBeTruthy();
    expect(regFile!.isDirty).toBe(false);
    expect(regFile!.data).toEqual({ nodes: [], edges: [] });
  });

  it('should revert dirty files in IDB that are NOT loaded in FileRegistry', async () => {
    // File only in IDB — user never opened it in a tab
    idbStore.set(`${PREFIX}graph-closed`, makeIdbFile('graph-closed'));
    // FileRegistry has nothing for this file

    const count = await repositoryOperationsService.discardLocalChanges(REPO, BRANCH);

    expect(count).toBe(1);

    // IDB record should be patched: isDirty=false, data=originalData
    const idbFile = idbStore.get(`${PREFIX}graph-closed`);
    expect(idbFile).toBeTruthy();
    expect(idbFile.isDirty).toBe(false);
    expect(idbFile.data).toEqual({ nodes: [], edges: [] });
  });

  it('should delete local-only files (no originalData) from IDB', async () => {
    idbStore.set(`${PREFIX}graph-local`, makeIdbFile('graph-local', {
      originalData: undefined,
      isLocal: true,
    }));

    const count = await repositoryOperationsService.discardLocalChanges(REPO, BRANCH);

    expect(count).toBe(1);
    expect(idbStore.has(`${PREFIX}graph-local`)).toBe(false);
  });

  it('should NOT touch dirty files from other workspaces', async () => {
    const otherPrefix = 'other-repo-dev-';
    idbStore.set(`${otherPrefix}graph-other`, {
      ...makeIdbFile('graph-other'),
      fileId: `${otherPrefix}graph-other`,
      source: { repository: 'other-repo', branch: 'dev', path: 'graphs/graph-other.json' },
    });
    // Also add one file in our workspace
    idbStore.set(`${PREFIX}graph-ours`, makeIdbFile('graph-ours'));

    const count = await repositoryOperationsService.discardLocalChanges(REPO, BRANCH);

    expect(count).toBe(1); // Only our file
    // Other workspace file still dirty
    const otherFile = idbStore.get(`${otherPrefix}graph-other`);
    expect(otherFile.isDirty).toBe(true);
  });

  it('should return 0 when no dirty files exist for the workspace', async () => {
    const count = await repositoryOperationsService.discardLocalChanges(REPO, BRANCH);
    expect(count).toBe(0);
  });

  it('should handle a mix of open and closed dirty files in one pass', async () => {
    // File A: in both IDB and FileRegistry
    idbStore.set(`${PREFIX}graph-a`, makeIdbFile('graph-a'));
    (fileRegistry as any).files.set('graph-a', makeRegistryFile('graph-a'));

    // File B: only in IDB
    idbStore.set(`${PREFIX}graph-b`, makeIdbFile('graph-b'));

    // File C: local-only, no originalData, only in IDB
    idbStore.set(`${PREFIX}graph-c`, makeIdbFile('graph-c', {
      originalData: undefined,
      isLocal: true,
    }));

    const count = await repositoryOperationsService.discardLocalChanges(REPO, BRANCH);

    expect(count).toBe(3);

    // A: reverted via FileRegistry
    const regA = fileRegistry.getFile('graph-a');
    expect(regA!.isDirty).toBe(false);
    expect(regA!.data).toEqual({ nodes: [], edges: [] });

    // B: reverted directly in IDB
    const idbB = idbStore.get(`${PREFIX}graph-b`);
    expect(idbB.isDirty).toBe(false);
    expect(idbB.data).toEqual({ nodes: [], edges: [] });

    // C: deleted from IDB
    expect(idbStore.has(`${PREFIX}graph-c`)).toBe(false);
  });
});
