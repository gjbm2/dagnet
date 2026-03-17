/**
 * FileRegistry initialisation normalisation tests
 *
 * During file initialisation (first 500 ms after load), editors may normalise
 * data (add defaults, sort keys, reorder arrays). These normalisation changes
 * must be absorbed into originalData so that isDirty remains false.
 *
 * Without this absorption, normalisation drift accumulates and causes:
 *   1. Files appear "dirty" even though the user never edited them
 *   2. Pull-all routes such files through the fragile text-based 3-way merge
 *      instead of the clean-update path
 *   3. The text-based merge can produce structurally invalid JSON/YAML,
 *      silently failing to update the file
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { fileRegistry } from '../TabContext';
import { db } from '../../db/appDatabase';

describe('FileRegistry: initialisation normalisation absorption', () => {
  beforeEach(async () => {
    // Clear IDB
    await db.files.clear();
    await db.workspaces.clear();
    // Clear in-memory FileRegistry state — use internal maps directly since
    // there is no public reset method on the singleton.
    (fileRegistry as any).files.clear();
    (fileRegistry as any).listeners.clear();
    (fileRegistry as any).updatingFiles.clear();
    (fileRegistry as any).pendingUpdates.clear();
    (fileRegistry as any).fileGenerations.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should absorb normalisation during init — isDirty stays false, originalData updated', async () => {
    const originalGraph = {
      nodes: [{ id: 'a', label: 'Node A' }],
      edges: [],
    };

    // Register a new file (isInitializing = true for 500 ms)
    await fileRegistry.getOrCreateFile(
      'graph-test',
      'graph',
      { repository: 'repo', branch: 'main', path: 'graphs/test.json', commitHash: 'sha1' },
      originalGraph
    );

    const afterCreate = fileRegistry.getFile('graph-test');
    expect(afterCreate?.isInitializing).toBe(true);
    expect(afterCreate?.isDirty).toBe(false);

    // Simulate editor normalisation: adds defaults, reorders keys
    const normalisedGraph = {
      nodes: [{ id: 'a', label: 'Node A', position: { x: 0, y: 0 } }],
      edges: [],
      canvasAnalyses: [],
    };

    await fileRegistry.updateFile('graph-test', normalisedGraph);

    const afterNorm = fileRegistry.getFile('graph-test');

    // CRITICAL: isDirty must be false — normalisation is not a user edit
    expect(afterNorm?.isDirty).toBe(false);
    // originalData must match the normalised data (absorbed)
    expect(afterNorm?.originalData).toEqual(normalisedGraph);
    // data is the normalised version
    expect(afterNorm?.data).toEqual(normalisedGraph);
    // Still initialising (completeInitialization not yet called)
    expect(afterNorm?.isInitializing).toBe(true);
  });

  it('should track dirty correctly after init completes', async () => {
    const graph = { nodes: [{ id: 'a' }], edges: [] };

    await fileRegistry.getOrCreateFile(
      'graph-post-init',
      'graph',
      { repository: 'repo', branch: 'main', path: 'graphs/test.json', commitHash: 'sha1' },
      graph
    );

    // Normalisation during init — absorbed
    const normalised = { nodes: [{ id: 'a', pos: { x: 0, y: 0 } }], edges: [] };
    await fileRegistry.updateFile('graph-post-init', normalised);
    expect(fileRegistry.getFile('graph-post-init')?.isDirty).toBe(false);

    // Complete initialisation (simulates the 500ms timer firing)
    await fileRegistry.completeInitialization('graph-post-init');

    const afterInit = fileRegistry.getFile('graph-post-init');
    expect(afterInit?.isInitializing).toBe(false);
    expect(afterInit?.isDirty).toBe(false);

    // Now a genuine user edit — must mark dirty
    const userEdit = { nodes: [{ id: 'a', pos: { x: 0, y: 0 } }, { id: 'b' }], edges: [] };
    await fileRegistry.updateFile('graph-post-init', userEdit);

    const afterEdit = fileRegistry.getFile('graph-post-init');
    expect(afterEdit?.isDirty).toBe(true);
    // originalData should still be the normalised version (from init absorption)
    expect(afterEdit?.originalData).toEqual(normalised);
  });

  it('should absorb multiple normalisation passes during init', async () => {
    const raw = { id: 'param-1', value: 10 };

    await fileRegistry.getOrCreateFile(
      'parameter-multi',
      'parameter',
      { repository: 'repo', branch: 'main', path: 'parameters/p.yaml', commitHash: 'sha1' },
      raw
    );

    // First normalisation pass
    const pass1 = { id: 'param-1', value: 10, query: '' };
    await fileRegistry.updateFile('parameter-multi', pass1);
    expect(fileRegistry.getFile('parameter-multi')?.isDirty).toBe(false);
    expect(fileRegistry.getFile('parameter-multi')?.originalData).toEqual(pass1);

    // Second normalisation pass (editor adds another default)
    const pass2 = { id: 'param-1', value: 10, query: '', n_query: '' };
    await fileRegistry.updateFile('parameter-multi', pass2);
    expect(fileRegistry.getFile('parameter-multi')?.isDirty).toBe(false);
    expect(fileRegistry.getFile('parameter-multi')?.originalData).toEqual(pass2);
  });

  it('should persist absorbed originalData to IDB', async () => {
    const raw = { nodes: [{ id: 'x' }], edges: [] };

    await fileRegistry.getOrCreateFile(
      'graph-idb-check',
      'graph',
      { repository: 'repo', branch: 'main', path: 'graphs/g.json', commitHash: 'sha1' },
      raw
    );

    const normalised = { nodes: [{ id: 'x', label: '' }], edges: [], meta: {} };
    await fileRegistry.updateFile('graph-idb-check', normalised);

    // Check IDB directly
    const idbFile = await db.files.get('graph-idb-check');
    expect(idbFile?.isDirty).toBe(false);
    expect(idbFile?.originalData).toEqual(normalised);
    expect(idbFile?.data).toEqual(normalised);
  });

  it('should NOT absorb changes when isInitializing is false (file loaded dirty from IDB)', async () => {
    // Seed IDB with a dirty file from a previous session
    await db.files.add({
      fileId: 'graph-dirty-prior',
      type: 'graph',
      data: { nodes: [{ id: 'a' }, { id: 'b' }], edges: [] },   // User's edits
      originalData: { nodes: [{ id: 'a' }], edges: [] },          // Original from git
      isDirty: true,
      isInitializing: true,  // Stale flag from previous session
      source: { repository: 'repo', branch: 'main', path: 'graphs/g.json', commitHash: 'sha1' },
      viewTabs: [],
      lastModified: Date.now()
    });

    // Load into FileRegistry — isDirty + isInitializing → isInitializing set to false
    await fileRegistry.getOrCreateFile(
      'graph-dirty-prior',
      'graph',
      { repository: 'repo', branch: 'main', path: 'graphs/g.json', commitHash: 'sha1' },
      { nodes: [{ id: 'a' }], edges: [] }  // This param is ignored since file exists in IDB
    );

    const loaded = fileRegistry.getFile('graph-dirty-prior');
    expect(loaded?.isInitializing).toBe(false);  // Completed because dirty
    expect(loaded?.isDirty).toBe(true);           // User's edits preserved

    // An update now should follow normal dirty tracking, not init absorption
    const updated = { nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], edges: [] };
    await fileRegistry.updateFile('graph-dirty-prior', updated);

    const afterUpdate = fileRegistry.getFile('graph-dirty-prior');
    expect(afterUpdate?.isDirty).toBe(true);
    // originalData should NOT have been updated — this is not init normalisation
    expect(afterUpdate?.originalData).toEqual({ nodes: [{ id: 'a' }], edges: [] });
  });
});
