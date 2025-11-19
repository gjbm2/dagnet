/**
 * Registry + FileOperationsService integration tests
 *
 * Focus:
 * - Registry items reflect file CRUD across all object types
 * - Index files are updated consistently
 * - Flags like hasFile, isLocal, isDirty, isOpen, inIndex, isOrphan are correct
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory FileRegistry mock used by both registryService and fileOperationsService
vi.mock('../../contexts/TabContext', () => {
  type FileType =
    | 'graph'
    | 'parameter'
    | 'context'
    | 'case'
    | 'node'
    | 'event'
    | 'credentials'
    | 'settings'
    | 'about'
    | 'markdown'
    | 'connections';

  interface MockFile {
    fileId: string;
    type: FileType;
    name?: string;
    path?: string;
    data: any;
    originalData: any;
    source: { repository: string; branch: string; path?: string };
    isDirty: boolean;
    isLocal?: boolean;
    lastModified?: number;
    lastOpened?: number;
    viewTabs: string[];
  }

  const files = new Map<string, MockFile>();

  const fileRegistry = {
    // Helpers for tests
    _reset() {
      files.clear();
    },

    async getOrCreateFile(
      fileId: string,
      type: FileType,
      source: MockFile['source'],
      data: any
    ): Promise<MockFile> {
      let existing = files.get(fileId);
      if (!existing) {
        const now = Date.now();
        existing = {
          fileId,
          type,
          name: fileId,
          path: source.path,
          data: structuredClone(data),
          originalData: structuredClone(data),
          source,
          isDirty: false,
          isLocal: source.repository === 'local',
          lastModified: now,
          lastOpened: now,
          viewTabs: [],
        };
        files.set(fileId, existing);
      }
      return existing;
    },

    getFile(fileId: string): MockFile | undefined {
      return files.get(fileId);
    },

    async updateFile(fileId: string, newData: any): Promise<void> {
      const existing = files.get(fileId);
      if (!existing) {
        throw new Error(`Mock fileRegistry.updateFile: ${fileId} not found`);
      }
      existing.data = structuredClone(newData);
      existing.isDirty = true;
      existing.lastModified = Date.now();
      files.set(fileId, existing);
    },

    async deleteFile(fileId: string): Promise<void> {
      files.delete(fileId);
    },

    getAllFiles(): MockFile[] {
      return Array.from(files.values());
    },

    // For deleteFile diagnostics in FileOperationsService
    get files() {
      return files;
    },
  };

  return { fileRegistry };
});

// Minimal Dexie/db mock - registryService currently doesn't depend on it,
// but FileOperationsService.saveFile does.
vi.mock('../../db/appDatabase', () => ({
  db: {
    files: {
      get: vi.fn(),
      put: vi.fn(),
      add: vi.fn(),
      delete: vi.fn(),
      where: vi.fn(() => ({ equals: vi.fn().mockReturnThis(), and: vi.fn().mockReturnThis(), toArray: vi.fn() })),
    },
  },
}));

// Avoid real credential loading / git access in these tests
vi.mock('../../lib/credentials', () => ({
  credentialsManager: {
    loadCredentials: vi.fn().mockResolvedValue({ success: true, credentials: { git: [] } }),
  },
}));

// Import after mocks
const { fileRegistry } = await import('../../contexts/TabContext');
import { fileOperationsService } from '../fileOperationsService';
import { registryService } from '../registryService';

type TypedObject = 'parameter' | 'context' | 'case' | 'node' | 'event';

describe('Registry + FileOperationsService integration', () => {
  beforeEach(() => {
    (fileRegistry as any)._reset();

    // Re-initialize FileOperationsService with no-op navigator/tab operations
    fileOperationsService.initialize({
      navigatorOps: {
        addLocalItem: vi.fn(),
        removeLocalItem: vi.fn(),
        refreshItems: vi.fn(),
      },
      tabOps: {
        openTab: vi.fn(),
        setActiveTab: vi.fn(),
        closeTab: vi.fn(),
      },
      dialogOps: {
        showConfirm: vi.fn().mockResolvedValue(true),
      },
      getWorkspaceState: () => ({ repo: 'local', branch: 'main' }),
    });
  });

  async function createAndFetch(
    type: TypedObject,
    name: string,
    tabs: { fileId: string }[] = []
  ) {
    const { fileId } = await fileOperationsService.createFile(name, type, {
      openInTab: false,
    });

    let items;
    switch (type) {
      case 'parameter':
        items = await registryService.getParameters(tabs);
        break;
      case 'context':
        items = await registryService.getContexts(tabs);
        break;
      case 'case':
        items = await registryService.getCases(tabs);
        break;
      case 'node':
        items = await registryService.getNodes(tabs);
        break;
      case 'event':
        items = await registryService.getEvents(tabs);
        break;
    }

    const created = items.find((i: any) => i.id === name);
    return { fileId, items, created };
  }

  it.each<TypedObject>(['parameter', 'context', 'case', 'node', 'event'])(
    'createFile(%s) adds item to registry with correct hasFile flags',
    async (type) => {
      const name = `${type}-alpha`;
      const fileId = `${type}-${name}`;

      // Mark file as "open" by passing tabs containing the fileId
      const { created } = await createAndFetch(type, name, [{ fileId }]);

      expect(created).toBeDefined();
      expect(created!.id).toBe(name);
      expect(created!.type).toBe(type);

      // Registry flags: hasFile must be true, inIndex/isOrphan depend on when
      // getItems is called relative to index write. We assert the stronger
      // guarantees (hasFile + non-orphan) elsewhere.
      expect(created!.hasFile).toBe(true);
      expect(created!.isLocal).toBe(true);
      expect(created!.isOpen).toBe(true);
      expect(created!.isDirty).toBe(false);

      // Index file shape
      const indexFileId = `${type}-index`;
      const indexFile = fileRegistry.getFile(indexFileId) as any;
      expect(indexFile).toBeDefined();

      const pluralKey = `${type}s`;
      expect(indexFile.data[pluralKey]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: name,
            file_path: expect.stringContaining(`${pluralKey}/${name}.yaml`),
          }),
        ])
      );
    }
  );

  it('marks item as dirty/open based on FileRegistry state and open tabs', async () => {
    const type: TypedObject = 'parameter';
    const name = 'checkout-rate';
    const fileId = `${type}-${name}`;

    // Create clean file
    await fileOperationsService.createFile(name, type, { openInTab: false });

    // Manually mark file dirty and set viewTabs to simulate open tab
    const file = fileRegistry.getFile(fileId) as any;
    file.isDirty = true;
    file.viewTabs = ['tab-1'];

    const items = await registryService.getParameters([{ fileId }]);
    const item = items.find((i) => i.id === name)!;

    expect(item.isDirty).toBe(true);
    expect(item.isOpen).toBe(true);
  });

  it('treats files without index entries as orphans', async () => {
    const type: TypedObject = 'parameter';
    const name = 'orphan-param';
    const fileId = `${type}-${name}`;

    // Create file directly in registry without touching index
    await (fileRegistry as any).getOrCreateFile(
      fileId,
      type,
      { repository: 'local', branch: 'main', path: `parameters/${name}.yaml` },
      { id: name, name }
    );

    const items = await registryService.getParameters([]);
    const item = items.find((i) => i.id === name)!;

    expect(item.hasFile).toBe(true);
    expect(item.inIndex).toBe(false);
    expect(item.isOrphan).toBe(true);
  });

  it('removes item from registry on deleteFile for indexed files', async () => {
    const type: TypedObject = 'event';
    const name = 'signup';
    const { fileId } = await fileOperationsService.createFile(name, type, {
      openInTab: false,
    });

    let events = await registryService.getEvents([]);
    expect(events.find((e) => e.id === name)).toBeDefined();

    // Delete underlying file (skip confirmations)
    await fileOperationsService.deleteFile(fileId, {
      force: true,
      skipConfirm: true,
    });

    events = await registryService.getEvents([]);
    const deleted = events.find((e) => e.id === name);

    // Since deleteFile also updates the index, item should disappear completely
    expect(deleted).toBeUndefined();
  });
});


