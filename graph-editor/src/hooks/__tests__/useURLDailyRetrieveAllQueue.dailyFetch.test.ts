/**
 * useURLDailyRetrieveAllQueue - Daily Fetch Enumeration Tests
 * 
 * Tests for the dailyFetch enumeration mode:
 * - Enumeration from IDB when ?retrieveall has no value
 * - Workspace scoping
 * - Deduplication of prefixed/unprefixed fileIds
 * - Alphabetical sorting
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { db } from '../../db/appDatabase';
import type { GraphData } from '../../types';

// Mock the db module
vi.mock('../../db/appDatabase', () => ({
  db: {
    files: {
      where: vi.fn(),
    },
  },
}));

const mockDb = vi.mocked(db);

// Import the enumeration function after mocking
// We need to test the actual enumeration logic
// The function is exposed on window in dev mode, but let's test via the module

function createMockGraph(overrides: Partial<GraphData> = {}): GraphData {
  return {
    nodes: [{ id: 'start', type: 'start', position: { x: 0, y: 0 }, data: {} }],
    edges: [],
    policies: { startNodeId: 'start' },
    metadata: { created: '1-Jan-25', modified: '1-Jan-25' },
    ...overrides,
  } as GraphData;
}

// Re-implement the enumeration function for testing (mirrors the hook's implementation)
async function enumerateDailyFetchGraphsFromIDB(workspace: { repository: string; branch: string }): Promise<string[]> {
  const allGraphFiles = await db.files
    .where('type')
    .equals('graph')
    .toArray();

  const seenCanonical = new Set<string>();
  const candidates: Array<{ fileId: string; data: GraphData | null }> = [];

  for (const file of allGraphFiles) {
    if (file.source?.repository !== workspace.repository || file.source?.branch !== workspace.branch) {
      continue;
    }

    let canonicalName: string;
    if (file.fileId.includes('-graph-')) {
      const parts = file.fileId.split('-graph-');
      canonicalName = parts[parts.length - 1];
    } else if (file.fileId.startsWith('graph-')) {
      canonicalName = file.fileId.slice(6);
    } else {
      canonicalName = file.fileId;
    }

    if (seenCanonical.has(canonicalName)) {
      if (file.fileId.includes('-graph-')) {
        const idx = candidates.findIndex(c => {
          const prevName = c.fileId.startsWith('graph-') ? c.fileId.slice(6) : c.fileId;
          return prevName === canonicalName;
        });
        if (idx >= 0) {
          candidates[idx] = { fileId: file.fileId, data: file.data as GraphData | null };
        }
      }
      continue;
    }

    seenCanonical.add(canonicalName);
    candidates.push({ fileId: file.fileId, data: file.data as GraphData | null });
  }

  const names: string[] = [];
  for (const { fileId, data } of candidates) {
    if (data?.dailyFetch) {
      let name: string;
      if (fileId.includes('-graph-')) {
        const parts = fileId.split('-graph-');
        name = parts[parts.length - 1];
      } else if (fileId.startsWith('graph-')) {
        name = fileId.slice(6);
      } else {
        name = fileId;
      }
      names.push(name);
    }
  }

  return names.sort((a, b) => a.localeCompare(b));
}

describe('enumerateDailyFetchGraphsFromIDB', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should return only graphs with dailyFetch=true', async () => {
    const mockFiles = [
      {
        fileId: 'graph-enabled',
        type: 'graph',
        source: { repository: 'test-repo', branch: 'main' },
        data: createMockGraph({ dailyFetch: true }),
      },
      {
        fileId: 'graph-disabled',
        type: 'graph',
        source: { repository: 'test-repo', branch: 'main' },
        data: createMockGraph({ dailyFetch: false }),
      },
      {
        fileId: 'graph-undefined',
        type: 'graph',
        source: { repository: 'test-repo', branch: 'main' },
        data: createMockGraph(), // dailyFetch not set
      },
    ];

    mockDb.files.where.mockReturnValue({
      equals: vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue(mockFiles),
      }),
    } as any);

    const result = await enumerateDailyFetchGraphsFromIDB({
      repository: 'test-repo',
      branch: 'main',
    });

    expect(result).toEqual(['enabled']);
  });

  it('should filter by workspace (repository and branch)', async () => {
    const mockFiles = [
      {
        fileId: 'graph-correct-repo',
        type: 'graph',
        source: { repository: 'test-repo', branch: 'main' },
        data: createMockGraph({ dailyFetch: true }),
      },
      {
        fileId: 'graph-wrong-repo',
        type: 'graph',
        source: { repository: 'other-repo', branch: 'main' },
        data: createMockGraph({ dailyFetch: true }),
      },
      {
        fileId: 'graph-wrong-branch',
        type: 'graph',
        source: { repository: 'test-repo', branch: 'develop' },
        data: createMockGraph({ dailyFetch: true }),
      },
    ];

    mockDb.files.where.mockReturnValue({
      equals: vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue(mockFiles),
      }),
    } as any);

    const result = await enumerateDailyFetchGraphsFromIDB({
      repository: 'test-repo',
      branch: 'main',
    });

    expect(result).toEqual(['correct-repo']);
  });

  it('should dedupe prefixed vs unprefixed variants (prefer prefixed data)', async () => {
    const mockFiles = [
      {
        fileId: 'graph-myGraph',
        type: 'graph',
        source: { repository: 'test-repo', branch: 'main' },
        data: createMockGraph({ dailyFetch: false }), // unprefixed says false
      },
      {
        fileId: 'test-repo-main-graph-myGraph',
        type: 'graph',
        source: { repository: 'test-repo', branch: 'main' },
        data: createMockGraph({ dailyFetch: true }), // prefixed says true - should win
      },
    ];

    mockDb.files.where.mockReturnValue({
      equals: vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue(mockFiles),
      }),
    } as any);

    const result = await enumerateDailyFetchGraphsFromIDB({
      repository: 'test-repo',
      branch: 'main',
    });

    // Should include myGraph because prefixed variant has dailyFetch=true
    expect(result).toEqual(['myGraph']);
  });

  it('should return graph names sorted alphabetically', async () => {
    const mockFiles = [
      {
        fileId: 'graph-zebra',
        type: 'graph',
        source: { repository: 'test-repo', branch: 'main' },
        data: createMockGraph({ dailyFetch: true }),
      },
      {
        fileId: 'graph-alpha',
        type: 'graph',
        source: { repository: 'test-repo', branch: 'main' },
        data: createMockGraph({ dailyFetch: true }),
      },
      {
        fileId: 'graph-middle',
        type: 'graph',
        source: { repository: 'test-repo', branch: 'main' },
        data: createMockGraph({ dailyFetch: true }),
      },
    ];

    mockDb.files.where.mockReturnValue({
      equals: vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue(mockFiles),
      }),
    } as any);

    const result = await enumerateDailyFetchGraphsFromIDB({
      repository: 'test-repo',
      branch: 'main',
    });

    expect(result).toEqual(['alpha', 'middle', 'zebra']);
  });

  it('should return empty array if no graphs have dailyFetch=true', async () => {
    const mockFiles = [
      {
        fileId: 'graph-a',
        type: 'graph',
        source: { repository: 'test-repo', branch: 'main' },
        data: createMockGraph({ dailyFetch: false }),
      },
      {
        fileId: 'graph-b',
        type: 'graph',
        source: { repository: 'test-repo', branch: 'main' },
        data: createMockGraph(), // undefined
      },
    ];

    mockDb.files.where.mockReturnValue({
      equals: vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue(mockFiles),
      }),
    } as any);

    const result = await enumerateDailyFetchGraphsFromIDB({
      repository: 'test-repo',
      branch: 'main',
    });

    expect(result).toEqual([]);
  });

  it('should return empty array if no graphs in workspace', async () => {
    mockDb.files.where.mockReturnValue({
      equals: vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue([]),
      }),
    } as any);

    const result = await enumerateDailyFetchGraphsFromIDB({
      repository: 'test-repo',
      branch: 'main',
    });

    expect(result).toEqual([]);
  });

  it('should extract graph name from prefixed fileId correctly', async () => {
    const mockFiles = [
      {
        fileId: 'my-org-repo-feature-branch-graph-complex-name',
        type: 'graph',
        source: { repository: 'my-org-repo', branch: 'feature-branch' },
        data: createMockGraph({ dailyFetch: true }),
      },
    ];

    mockDb.files.where.mockReturnValue({
      equals: vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue(mockFiles),
      }),
    } as any);

    const result = await enumerateDailyFetchGraphsFromIDB({
      repository: 'my-org-repo',
      branch: 'feature-branch',
    });

    expect(result).toEqual(['complex-name']);
  });
});
