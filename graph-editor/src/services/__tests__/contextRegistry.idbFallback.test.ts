/**
 * ContextRegistry IndexedDB fallback tests
 *
 * Regression: When the pinned DSL contains no context() constraints, WindowSelector’s "+ Context"
 * must still show ALL contexts. That requires ContextRegistry to be able to list and load contexts
 * from IndexedDB (source of truth), not only from FileRegistry (open tabs subset) or param-registry.
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '../../db/appDatabase';

// Mock FileRegistry to be empty (represents "user hasn't opened any context tabs yet")
vi.mock('../../contexts/TabContext', () => ({
  fileRegistry: {
    // ContextRegistry reads (fileRegistry as any).files?.values()
    files: new Map(),
  },
}));

import { ContextRegistry } from '../contextRegistry';

describe('ContextRegistry: IndexedDB fallbacks', () => {
  beforeEach(async () => {
    // Fresh DB per test - MUST re-open immediately after delete to avoid
    // DatabaseClosedError in parallel tests
    await db.delete();
    await db.open();
  });

  it('getAllContextKeys should list contexts from IndexedDB even when FileRegistry is empty', async () => {

    await db.files.put({
      fileId: 'context-channel',
      type: 'context',
      data: {
        id: 'channel',
        type: 'categorical',
        otherPolicy: 'computed',
        values: [{ id: 'google', label: 'Google' }],
        metadata: { status: 'active', created_at: '1-Dec-25', version: '1.0.0' },
      },
      originalData: {},
      isDirty: false,
      isLocal: false,
      lastModified: Date.now(),
      lastSaved: Date.now(),
      source: { repository: 'test-repo', branch: 'main' },
    } as any);

    await db.files.put({
      fileId: 'context-browser_type',
      type: 'context',
      data: {
        id: 'browser_type',
        type: 'categorical',
        otherPolicy: 'null',
        values: [{ id: 'chrome', label: 'Chrome' }],
        metadata: { status: 'active', created_at: '1-Dec-25', version: '1.0.0' },
      },
      originalData: {},
      isDirty: false,
      isLocal: false,
      lastModified: Date.now(),
      lastSaved: Date.now(),
      source: { repository: 'test-repo', branch: 'main' },
    } as any);

    const registry = new ContextRegistry();
    const keys = await registry.getAllContextKeys();

    const ids = keys.map(k => k.id).sort();
    expect(ids).toEqual(['browser_type', 'channel']);
  });

  it('getContext should load a context from IndexedDB when not present in FileRegistry', async () => {
    await db.files.put({
      fileId: 'context-channel',
      type: 'context',
      data: {
        id: 'channel',
        name: 'Channel',
        description: 'Test',
        type: 'categorical',
        otherPolicy: 'computed',
        values: [
          { id: 'google', label: 'Google' },
          { id: 'other', label: 'Other' },
        ],
        metadata: { status: 'active', created_at: '1-Dec-25', version: '1.0.0' },
      },
      originalData: {},
      isDirty: false,
      isLocal: false,
      lastModified: Date.now(),
      lastSaved: Date.now(),
      source: { repository: 'test-repo', branch: 'main' },
    } as any);

    const registry = new ContextRegistry();
    const ctx = await registry.getContext('channel', { workspace: { repository: 'test-repo', branch: 'main' } });

    expect(ctx?.id).toBe('channel');
    expect(ctx?.values?.length).toBeGreaterThan(0);
  });

  it('getContextSections should skip malformed contexts (missing values) instead of throwing', async () => {
    // Valid context
    await db.files.put({
      fileId: 'context-channel',
      type: 'context',
      data: {
        id: 'channel',
        name: 'Channel',
        description: 'Test',
        type: 'categorical',
        otherPolicy: 'computed',
        values: [{ id: 'google', label: 'Google' }],
        metadata: { status: 'active', created_at: '1-Dec-25', version: '1.0.0' },
      },
      originalData: {},
      isDirty: false,
      isLocal: false,
      lastModified: Date.now(),
      lastSaved: Date.now(),
      source: { repository: 'test-repo', branch: 'main' },
    } as any);

    // Malformed context (no values array)
    await db.files.put({
      fileId: 'context-nousmates',
      type: 'context',
      data: {
        id: 'nousmates',
        name: 'Nousmates',
        description: 'Malformed: missing values',
        type: 'categorical',
        otherPolicy: 'undefined',
        metadata: { status: 'active', created_at: '1-Dec-25', version: '1.0.0' },
      },
      originalData: {},
      isDirty: false,
      isLocal: false,
      lastModified: Date.now(),
      lastSaved: Date.now(),
      source: { repository: 'test-repo', branch: 'main' },
    } as any);

    const registry = new ContextRegistry();
    const sections = await registry.getContextSections(
      [{ id: 'channel' }, { id: 'nousmates' }],
      { workspace: { repository: 'test-repo', branch: 'main' } }
    );

    // Should include the valid one and NOT crash on malformed
    expect(sections.map(s => s.id).sort()).toEqual(['channel', 'nousmates']);
    const nousmates = sections.find(s => s.id === 'nousmates');
    expect(nousmates?.values).toEqual([]);
  });
});


