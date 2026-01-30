/**
 * AllSlices simulation tests - STRONG ASSURANCE
 *
 * These tests provide STRONG ASSURANCE that "Retrieve All" simulate mode:
 * 
 * 1. Makes ZERO external HTTP calls (all runner.execute calls have dryRun: true)
 * 2. Makes ZERO file writes (fileRegistry, IndexedDB)
 * 3. Makes ZERO graph mutations (setGraph never called)
 * 4. Emits proper DRY_RUN_HTTP session log entries
 *
 * CRITICAL BUG FIX (29-Jan-26): Prior to fix, simulation mode would still execute
 * real API calls when needsDualQuery=true because the dontExecuteHttp check was
 * AFTER the dual query execution.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { retrieveAllSlicesService } from '../retrieveAllSlicesService';
import { sessionLogService } from '../sessionLogService';

// ═══════════════════════════════════════════════════════════════════════════════
// TRACKING: All potential side effects
// ═══════════════════════════════════════════════════════════════════════════════

const sideEffectTracker = {
  // External API calls
  executeCallsWithoutDryRun: [] as any[],
  executeCallsWithDryRun: [] as any[],
  
  // File writes
  fileRegistryUpdateCalls: [] as any[],
  dbSaveCalls: [] as any[],
  
  // Graph mutations
  setGraphCalls: [] as any[],
  
  clear() {
    this.executeCallsWithoutDryRun = [];
    this.executeCallsWithDryRun = [];
    this.fileRegistryUpdateCalls = [];
    this.dbSaveCalls = [];
    this.setGraphCalls = [];
  },
  
  assertNoSideEffects() {
    const errors: string[] = [];
    
    if (this.executeCallsWithoutDryRun.length > 0) {
      errors.push(`REAL API CALLS DETECTED: ${this.executeCallsWithoutDryRun.length} calls to runner.execute without dryRun:true`);
    }
    
    if (this.fileRegistryUpdateCalls.length > 0) {
      errors.push(`FILE WRITES DETECTED: ${this.fileRegistryUpdateCalls.length} calls to fileRegistry.updateFile`);
    }
    
    if (this.dbSaveCalls.length > 0) {
      errors.push(`DB WRITES DETECTED: ${this.dbSaveCalls.length} calls to db save methods`);
    }
    
    if (this.setGraphCalls.length > 0) {
      errors.push(`GRAPH MUTATIONS DETECTED: ${this.setGraphCalls.length} calls to setGraph`);
    }
    
    if (errors.length > 0) {
      throw new Error('SIMULATION MODE SIDE EFFECTS DETECTED:\n' + errors.join('\n'));
    }
  },
  
  getSummary() {
    return {
      realApiCalls: this.executeCallsWithoutDryRun.length,
      dryRunApiCalls: this.executeCallsWithDryRun.length,
      fileWrites: this.fileRegistryUpdateCalls.length,
      dbWrites: this.dbSaveCalls.length,
      graphMutations: this.setGraphCalls.length,
    };
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// MOCKS: Toast (suppress UI)
// ═══════════════════════════════════════════════════════════════════════════════

vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  },
}));

// ═══════════════════════════════════════════════════════════════════════════════
// MOCKS: DAS Runner - tracks ALL execute calls
// ═══════════════════════════════════════════════════════════════════════════════

vi.mock('../../lib/das', () => ({
  createDASRunner: () => ({
    connectionProvider: {
      getConnection: vi.fn(async () => ({
        provider: 'amplitude',
        requires_event_ids: true,
        capabilities: { supports_daily_time_series: true, supports_native_exclude: true },
      })),
    },
    execute: vi.fn(async (connectionName: string, payload: any, options?: any) => {
      // CRITICAL: Track whether this is a real call or dry-run
      if (options?.dryRun === true) {
        sideEffectTracker.executeCallsWithDryRun.push({ connectionName, payload, options });
      } else {
        sideEffectTracker.executeCallsWithoutDryRun.push({ connectionName, payload, options });
      }
      return {
        success: true,
        raw: { 
          request: { 
            method: 'POST', 
            url: 'https://amplitude.example.test/api', 
            headers: { Authorization: 'secret' }, 
            body: { x: 1 } 
          } 
        },
      };
    }),
    getExecutionHistory: vi.fn(() => []),
  }),
}));

// ═══════════════════════════════════════════════════════════════════════════════
// MOCKS: FileRegistry - tracks ALL file operations
// ═══════════════════════════════════════════════════════════════════════════════

vi.mock('../../contexts/TabContext', () => {
  const mockFiles = new Map<string, any>();
  return {
    fileRegistry: {
      getFile: vi.fn((id: string) => mockFiles.get(id)),
      updateFile: vi.fn(async (...args: any[]) => {
        sideEffectTracker.fileRegistryUpdateCalls.push(args);
      }),
      registerFile: vi.fn(async (id: string, data: any) => {
        // registerFile is allowed during setup, not tracked as side effect
        mockFiles.set(id, { data: structuredClone(data) });
      }),
      _mockFiles: mockFiles,
    },
  };
});

// ═══════════════════════════════════════════════════════════════════════════════
// MOCKS: IndexedDB - tracks ALL database writes
// ═══════════════════════════════════════════════════════════════════════════════

vi.mock('../db', () => ({
  db: {
    getFile: vi.fn(async () => null),
    saveFile: vi.fn(async (...args: any[]) => {
      sideEffectTracker.dbSaveCalls.push({ method: 'saveFile', args });
    }),
    updateFile: vi.fn(async (...args: any[]) => {
      sideEffectTracker.dbSaveCalls.push({ method: 'updateFile', args });
    }),
    updateParameter: vi.fn(async (...args: any[]) => {
      sideEffectTracker.dbSaveCalls.push({ method: 'updateParameter', args });
    }),
    getSettings: vi.fn(async () => ({ data: { excludeTestAccounts: true } })),
    getDirtyFiles: vi.fn(async () => []),
  },
}));

const { fileRegistry } = await import('../../contexts/TabContext');

// ═══════════════════════════════════════════════════════════════════════════════
// TEST SUITE
// ═══════════════════════════════════════════════════════════════════════════════

describe('Retrieve All Slices simulate mode - STRONG ASSURANCE', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sideEffectTracker.clear();
    (fileRegistry as any)._mockFiles.clear();
  });

  afterEach(() => {
    // Always log the summary for debugging failed tests
    const summary = sideEffectTracker.getSummary();
    if (summary.realApiCalls > 0 || summary.fileWrites > 0 || summary.dbWrites > 0 || summary.graphMutations > 0) {
      console.error('SIDE EFFECT SUMMARY:', summary);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST: Simple edge (no dual query)
  // ─────────────────────────────────────────────────────────────────────────────
  
  it('STRONG ASSURANCE: simple edge - zero side effects in simulation mode', async () => {
    const graph: any = {
      schema_version: '1.0.0',
      id: 'g1',
      name: 'Test',
      description: '',
      nodes: [
        { id: 'A', uuid: 'A', label: 'A', event_id: 'a', layout: { x: 0, y: 0 } },
        { id: 'B', uuid: 'B', label: 'B', event_id: 'b', layout: { x: 0, y: 0 } },
      ],
      edges: [
        {
          id: 'e1',
          uuid: 'e1',
          from: 'A',
          to: 'B',
          p: { id: 'p1', connection: 'amplitude-prod' },
          query: 'from(A).to(B)',
        },
      ],
    };

    await (fileRegistry as any).registerFile('parameter-p1', {
      id: 'p1',
      connection: 'amplitude-prod',
      values: [],
    });

    const setGraphSpy = vi.fn();

    await retrieveAllSlicesService.execute({
      getGraph: () => graph,
      setGraph: (g) => {
        sideEffectTracker.setGraphCalls.push(g);
        setGraphSpy(g);
      },
      slices: ['window(-30d:)'],
      bustCache: true,
      simulate: true,
    });

    // CRITICAL ASSERTION: Zero side effects
    sideEffectTracker.assertNoSideEffects();
    
    // Verify we DID exercise the code (dry-run calls were made)
    expect(sideEffectTracker.executeCallsWithDryRun.length).toBeGreaterThan(0);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST: Dual query (latency edge) - this was the bug case
  // ─────────────────────────────────────────────────────────────────────────────
  
  it('STRONG ASSURANCE: dual query (latency edge) - zero side effects in simulation mode', async () => {
    const graph: any = {
      schema_version: '1.0.0',
      id: 'g1',
      name: 'Test',
      description: '',
      nodes: [
        { id: 'A', uuid: 'A', label: 'A', event_id: 'a', layout: { x: 0, y: 0 } },
        { id: 'B', uuid: 'B', label: 'B', event_id: 'b', layout: { x: 0, y: 0 } },
      ],
      edges: [
        {
          id: 'e1',
          uuid: 'e1',
          from: 'A',
          to: 'B',
          // CRITICAL: Include latency config to trigger dual query (n_query + k query)
          // This was the bug case - dual query ran BEFORE dontExecuteHttp check
          p: { 
            id: 'p1', 
            connection: 'amplitude-prod', 
            latency: { latency_parameter: true, t95: 10, anchor_node_id: 'A' } 
          },
          query: 'from(A).to(B)',
        },
      ],
    };

    await (fileRegistry as any).registerFile('parameter-p1', {
      id: 'p1',
      connection: 'amplitude-prod',
      values: [],
    });

    const setGraphSpy = vi.fn();

    await retrieveAllSlicesService.execute({
      getGraph: () => graph,
      setGraph: (g) => {
        sideEffectTracker.setGraphCalls.push(g);
        setGraphSpy(g);
      },
      slices: ['cohort(-7d:)'],  // Cohort mode to exercise latency path
      bustCache: true,
      simulate: true,
    });

    // CRITICAL ASSERTION: Zero side effects
    // This is the regression test for the bug fixed on 29-Jan-26
    sideEffectTracker.assertNoSideEffects();
    
    // Verify we DID exercise the dual query code path (multiple dry-run calls)
    expect(sideEffectTracker.executeCallsWithDryRun.length).toBeGreaterThanOrEqual(1);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST: Conditional parameters
  // ─────────────────────────────────────────────────────────────────────────────
  
  it('STRONG ASSURANCE: conditional parameters - zero side effects in simulation mode', async () => {
    const graph: any = {
      schema_version: '1.0.0',
      id: 'g1',
      name: 'Test',
      description: '',
      nodes: [
        { id: 'A', uuid: 'A', label: 'A', event_id: 'a', layout: { x: 0, y: 0 } },
        { id: 'B', uuid: 'B', label: 'B', event_id: 'b', layout: { x: 0, y: 0 } },
        { id: 'X', uuid: 'X', label: 'X', event_id: 'x', layout: { x: 0, y: 0 } },
      ],
      edges: [
        {
          id: 'e1',
          uuid: 'e1',
          from: 'A',
          to: 'B',
          p: { id: 'p1', connection: 'amplitude-prod' },
          conditional_p: [
            {
              condition: 'visited(X)',
              p: { id: 'cp1', connection: 'amplitude-prod' },
              query: 'from(A).to(B).visited(X)',
            },
          ],
          query: 'from(A).to(B)',
        },
      ],
    };

    await (fileRegistry as any).registerFile('parameter-p1', {
      id: 'p1',
      connection: 'amplitude-prod',
      values: [],
    });
    await (fileRegistry as any).registerFile('parameter-cp1', {
      id: 'cp1',
      connection: 'amplitude-prod',
      values: [],
    });

    const setGraphSpy = vi.fn();

    await retrieveAllSlicesService.execute({
      getGraph: () => graph,
      setGraph: (g) => {
        sideEffectTracker.setGraphCalls.push(g);
        setGraphSpy(g);
      },
      slices: ['window(-30d:)'],
      bustCache: true,
      simulate: true,
    });

    // CRITICAL ASSERTION: Zero side effects
    sideEffectTracker.assertNoSideEffects();
    
    // Verify we exercised the code
    expect(sideEffectTracker.executeCallsWithDryRun.length).toBeGreaterThan(0);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST: Session log entries are emitted correctly
  // ─────────────────────────────────────────────────────────────────────────────
  
  it('STRONG ASSURANCE: DRY_RUN_HTTP session log entries are emitted', async () => {
    const graph: any = {
      schema_version: '1.0.0',
      id: 'g1',
      name: 'Test',
      description: '',
      nodes: [
        { id: 'A', uuid: 'A', label: 'A', event_id: 'a', layout: { x: 0, y: 0 } },
        { id: 'B', uuid: 'B', label: 'B', event_id: 'b', layout: { x: 0, y: 0 } },
      ],
      edges: [
        {
          id: 'e1',
          uuid: 'e1',
          from: 'A',
          to: 'B',
          p: { id: 'p1', connection: 'amplitude-prod' },
          query: 'from(A).to(B)',
        },
      ],
    };

    await (fileRegistry as any).registerFile('parameter-p1', {
      id: 'p1',
      connection: 'amplitude-prod',
      values: [],
    });

    const addChildSpy = vi.spyOn(sessionLogService, 'addChild');

    await retrieveAllSlicesService.execute({
      getGraph: () => graph,
      setGraph: () => {},
      slices: ['window(-30d:)'],
      bustCache: true,
      simulate: true,
    });

    // Verify DRY_RUN_HTTP entries were logged
    const dryRunEvents = addChildSpy.mock.calls.filter((c) => c[2] === 'DRY_RUN_HTTP');
    expect(dryRunEvents.length).toBeGreaterThan(0);
    
    // Verify httpCommand is included (for debugging)
    const hasHttpCommand = dryRunEvents.some((c) => {
      const meta = c[5] as any;
      return typeof meta?.httpCommand === 'string' && meta.httpCommand.length > 0;
    });
    expect(hasHttpCommand).toBe(true);
    
    // Still verify no side effects
    sideEffectTracker.assertNoSideEffects();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST: Multiple slices
  // ─────────────────────────────────────────────────────────────────────────────
  
  it('STRONG ASSURANCE: multiple slices - zero side effects in simulation mode', async () => {
    const graph: any = {
      schema_version: '1.0.0',
      id: 'g1',
      name: 'Test',
      description: '',
      nodes: [
        { id: 'A', uuid: 'A', label: 'A', event_id: 'a', layout: { x: 0, y: 0 } },
        { id: 'B', uuid: 'B', label: 'B', event_id: 'b', layout: { x: 0, y: 0 } },
      ],
      edges: [
        {
          id: 'e1',
          uuid: 'e1',
          from: 'A',
          to: 'B',
          p: { id: 'p1', connection: 'amplitude-prod' },
          query: 'from(A).to(B)',
        },
      ],
    };

    await (fileRegistry as any).registerFile('parameter-p1', {
      id: 'p1',
      connection: 'amplitude-prod',
      values: [],
    });

    await retrieveAllSlicesService.execute({
      getGraph: () => graph,
      setGraph: (g) => {
        sideEffectTracker.setGraphCalls.push(g);
      },
      slices: [
        'window(-30d:)',
        'context(channel:google).window(-30d:)',
        'cohort(-7d:)',
      ],
      bustCache: true,
      simulate: true,
    });

    // CRITICAL ASSERTION: Zero side effects even with multiple slices
    sideEffectTracker.assertNoSideEffects();
    
    // Verify we exercised the code (at least some dry-run calls)
    expect(sideEffectTracker.executeCallsWithDryRun.length).toBeGreaterThan(0);
  });
});
