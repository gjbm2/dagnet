/**
 * GraphComputeClient Integration Tests
 * 
 * Tests TypeScript → Python API roundtrip:
 * - Health check
 * - Query parsing
 * - Error handling
 * - Mock mode
 * - Environment detection
 * 
 * These tests require the Python dev server running on localhost:9000
 * Run: python dev-server.py
 * 
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { GraphComputeClient } from '../graphComputeClient';

// Check if Python server is available
let pythonServerAvailable = false;

beforeAll(async () => {
  // Use AbortController to prevent hanging connections
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);
  
  try {
    const response = await fetch('http://localhost:9000/', { 
      signal: controller.signal 
    });
    pythonServerAvailable = response.ok;
  } catch (e) {
    pythonServerAvailable = false;
  } finally {
    clearTimeout(timeoutId);
  }
}, 5000);

afterEach(() => {
  delete (globalThis as any).__dagnetComputeNoCache;
  delete (globalThis as any).__dagnetComputeNoCacheOnce;
  delete (globalThis as any).__dagnetCacheClearedAtMs;
  vi.restoreAllMocks();
});

describe('GraphComputeClient - Mock Mode', () => {
  const mockClient = new GraphComputeClient('http://localhost:9000', true);

  it('should return mock health status', async () => {
    const result = await mockClient.health();
    
    expect(result.status).toBe('ok');
    expect(result.env).toBe('mock');
  });

  it('should return mock query parse response', async () => {
    const result = await mockClient.parseQuery('from(a).to(b)');
    
    expect(result.from_node).toBeDefined();
    expect(result.to_node).toBeDefined();
    expect(result.exclude).toBeInstanceOf(Array);
    expect(result.visited).toBeInstanceOf(Array);
    expect(result.context).toBeInstanceOf(Array);
    expect(result.cases).toBeInstanceOf(Array);
  });

});

describe('GraphComputeClient - Real Python Backend', () => {
  const realClient = new GraphComputeClient('http://localhost:9000', false);

  it('should connect to Python server', async () => {
    if (!pythonServerAvailable) {
      console.log('⏭️  Skipping: Python server not available');
      return;
    }
    
    const result = await realClient.health();
    
    expect(result.status).toBe('ok');
    expect(result.service).toBe('dagnet-graph-compute');
  });

  it('should parse simple query', async () => {
    if (!pythonServerAvailable) return;
    
    const result = await realClient.parseQuery('from(a).to(b)');
    
    expect(result.from_node).toBe('a');
    expect(result.to_node).toBe('b');
    expect(result.exclude).toEqual([]);
    expect(result.visited).toEqual([]);
  });

  it('should parse complex query', async () => {
    if (!pythonServerAvailable) return;
    
    const queryString = 'from(start).to(end).visited(checkpoint).exclude(detour)';
    const result = await realClient.parseQuery(queryString);
    
    expect(result.from_node).toBe('start');
    expect(result.to_node).toBe('end');
    expect(result.visited).toContain('checkpoint');
    expect(result.exclude).toContain('detour');
  });

  it('should parse query with context', async () => {
    if (!pythonServerAvailable) return;
    
    const queryString = 'from(a).to(b).context(device:mobile)';
    const result = await realClient.parseQuery(queryString);
    
    expect(result.context).toHaveLength(1);
    expect(result.context[0].key).toBe('device');
    expect(result.context[0].value).toBe('mobile');
  });

  it('should parse query with case', async () => {
    if (!pythonServerAvailable) return;
    
    const queryString = 'from(a).to(b).case(test-1:treatment)';
    const result = await realClient.parseQuery(queryString);
    
    expect(result.cases).toHaveLength(1);
    expect(result.cases[0].key).toBe('test-1');
    expect(result.cases[0].value).toBe('treatment');
  });

  it('should handle invalid query syntax', async () => {
    if (!pythonServerAvailable) return;
    
    await expect(
      realClient.parseQuery('invalid query')
    ).rejects.toThrow();
  });

  it('should handle missing from clause', async () => {
    if (!pythonServerAvailable) return;
    
    await expect(
      realClient.parseQuery('to(b)')
    ).rejects.toThrow();
  });

  it('should handle missing to clause', async () => {
    if (!pythonServerAvailable) return;
    
    await expect(
      realClient.parseQuery('from(a)')
    ).rejects.toThrow();
  });
});

describe('GraphComputeClient - Error Handling', () => {
  const client = new GraphComputeClient('http://localhost:9000', false);

  it('should handle network errors gracefully', async () => {
    const offlineClient = new GraphComputeClient('http://localhost:9999', false);
    
    await expect(
      offlineClient.health()
    ).rejects.toThrow();
  });

  it('should provide meaningful error messages', async () => {
    if (!pythonServerAvailable) return;
    
    try {
      await client.parseQuery('invalid');
      expect.fail('Should have thrown');
    } catch (error: any) {
      expect(error.message).toBeDefined();
      expect(error.message.length).toBeGreaterThan(0);
    }
  });
});

describe('GraphComputeClient - Node cache bypass flags', () => {
  it('respects the CLI global no-cache flag in Node mode', async () => {
    const client = new GraphComputeClient('http://localhost:9000', false);
    (globalThis as any).__dagnetComputeNoCache = true;

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        result: {
          analysis_type: 'graph_overview',
          analysis_name: 'Graph Overview',
          analysis_description: 'Test result',
          metadata: {},
          dimension_values: {},
          data: [],
        },
      }),
    } as any);

    await client.analyzeSelection(
      { nodes: [], edges: [] },
      'from(a).to(b)',
      'window(-1d:)',
      'current',
      'Current',
      '#3b82f6',
      'graph_overview',
    );

    const analyzeCalls = fetchSpy.mock.calls.filter(
      ([url]) => String(url).includes('/api/runner/analyze')
    ) as Array<[string, RequestInit]>;
    expect(analyzeCalls).toHaveLength(1);
    const [url, init] = analyzeCalls[0];
    expect(url).toContain('/api/runner/analyze?no-cache=1');
    expect(init.body).toBeTruthy();
    const body = JSON.parse(String(init.body));
    expect(body.no_cache).toBe(true);
  });

  it('consumes the one-shot no-cache flag exactly once in Node mode', () => {
    const client = new GraphComputeClient('http://localhost:9000', true);
    (globalThis as any).__dagnetComputeNoCacheOnce = true;

    expect((client as any).shouldBypassCache()).toBe(true);
    expect((globalThis as any).__dagnetComputeNoCacheOnce).toBe(false);
    expect((client as any).shouldBypassCache()).toBe(false);
  });
});

describe('GraphComputeClient - Schema Compliance', () => {
  const mockClient = new GraphComputeClient('http://localhost:9000', true);

  it('should return response matching QueryParseResponse interface', async () => {
    const result = await mockClient.parseQuery('from(a).to(b)');
    
    // All required fields present
    expect(result).toHaveProperty('from_node');
    expect(result).toHaveProperty('to_node');
    expect(result).toHaveProperty('exclude');
    expect(result).toHaveProperty('visited');
    expect(result).toHaveProperty('context');
    expect(result).toHaveProperty('cases');
    
    // Correct types
    expect(typeof result.from_node).toBe('string');
    expect(typeof result.to_node).toBe('string');
    expect(Array.isArray(result.exclude)).toBe(true);
    expect(Array.isArray(result.visited)).toBe(true);
    expect(Array.isArray(result.context)).toBe(true);
    expect(Array.isArray(result.cases)).toBe(true);
  });

  it('should handle all 6 schema-defined functions', async () => {
    if (!pythonServerAvailable) return;
    
    const queries = [
      'from(a).to(b)',
      'from(a).to(b).visited(c)',
      'from(a).to(b).exclude(c)',
      'from(a).to(b).context(k:v)',
      'from(a).to(b).case(t:v)',
      'from(a).to(b).visited(c).exclude(d).context(k:v).case(t:v)',
    ];

    const client = new GraphComputeClient('http://localhost:9000', false);

    for (const query of queries) {
      const result = await client.parseQuery(query);
      expect(result.from_node).toBe('a');
      expect(result.to_node).toBe('b');
    }
  });
});

describe('GraphComputeClient - Cohort maturity epoch stitching', () => {
  it('collapses epoch subject_ids and stitches frames into τ-indexed curve', async () => {
    const client = new GraphComputeClient('http://localhost:9000', true);

    const request: any = {
      analysis_type: 'cohort_maturity',
      query_dsl: 'from(A).to(B).cohort(1-Oct-25:3-Oct-25)',
      scenarios: [{
        scenario_id: 'base',
        name: 'Base',
        colour: '#000000',
        visibility_mode: 'f+e',
        graph: {},
        snapshot_subjects: [
          {
            subject_id: 's1::epoch:0', subject_label: 'A → B',
            param_id: 'p1', core_hash: 'h1', read_mode: 'cohort_maturity',
            anchor_from: '2025-10-01', anchor_to: '2025-10-03',
            sweep_from: '2025-10-01', sweep_to: '2025-10-01',
            slice_keys: ['cohort()'], target: { targetId: 'edge-1', slot: 'p' },
          },
          {
            subject_id: 's1::epoch:1', subject_label: 'A → B',
            param_id: 'p1', core_hash: 'h1', read_mode: 'cohort_maturity',
            anchor_from: '2025-10-01', anchor_to: '2025-10-03',
            sweep_from: '2025-10-02', sweep_to: '2025-10-02',
            slice_keys: ['cohort()'], target: { targetId: 'edge-1', slot: 'p' },
          },
        ],
      }],
    };

    const raw: any = {
      success: true,
      scenario_id: 'base',
      subjects: [
        {
          subject_id: 's1::epoch:0',
          success: true,
          result: {
            analysis_type: 'cohort_maturity',
            frames: [
              { snapshot_date: '2025-10-01', data_points: [{ anchor_day: '2025-10-01', x: 10, y: 1 }] },
            ],
            maturity_rows: [
              { tau_days: 0, rate: 0.1, y_base: 1, tau_solid_max: 0, tau_future_max: 1, boundary_date: '2025-10-01' },
            ],
          },
        },
        {
          subject_id: 's1::epoch:1',
          success: true,
          result: {
            analysis_type: 'cohort_maturity',
            frames: [
              { snapshot_date: '2025-10-02', data_points: [{ anchor_day: '2025-10-01', x: 20, y: 2 }] },
            ],
            maturity_rows: [
              { tau_days: 1, rate: 0.1, y_base: 2, tau_solid_max: 1, tau_future_max: 2, boundary_date: '2025-10-02' },
            ],
          },
        },
      ],
    };

    const normalised = (client as any).normaliseSnapshotCohortMaturityResponse(raw, request);
    expect(normalised).not.toBeNull();
    expect(normalised!.success).toBe(true);
    expect(normalised!.result.analysis_type).toBe('cohort_maturity');

    // Data rows are now τ-indexed, stitched under the base subject_id 's1'.
    const rows = normalised.result.data;
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r: any) => r.subject_id))).toEqual(new Set(['s1']));
    // Every row has tau_days.
    for (const r of rows) {
      expect(r).toHaveProperty('tau_days');
      expect(typeof r.tau_days).toBe('number');
    }
  });
});

describe('GraphComputeClient - Environment Detection', () => {
  it('should use correct base URL for dev environment', () => {
    const devClient = new GraphComputeClient();
    expect(devClient['baseUrl']).toBeDefined();
  });

  it('should respect custom base URL', () => {
    const customClient = new GraphComputeClient('http://custom:8888', false);
    expect(customClient['baseUrl']).toBe('http://custom:8888');
  });

  it('should respect mock mode flag', () => {
    const mockClient = new GraphComputeClient('http://localhost:9000', true);
    expect(mockClient['useMock']).toBe(true);
  });

  it('should default to non-mock mode', () => {
    const realClient = new GraphComputeClient('http://localhost:9000', false);
    expect(realClient['useMock']).toBe(false);
  });
});

// ============================================================
// Cohort Maturity Normalisation
// ============================================================

describe('GraphComputeClient - Cohort Maturity Normalisation', () => {
  const client = new GraphComputeClient('http://localhost:9000', true);

  /**
   * Helper: build a minimal backend response shaped like the Python
   * cohort_maturity derivation output (per-scenario, per-subject blocks
   * wrapping the derivation result).
   */
  function buildRawResponse(frames: any[], scenarioId = 'sc1', subjectId = 'subj1') {
    return {
      success: true,
      scenarios: [
        {
          scenario_id: scenarioId,
          subjects: [
            {
              subject_id: subjectId,
              success: true,
              result: {
                analysis_type: 'cohort_maturity',
                frames,
                anchor_range: { from: '2025-10-01', to: '2025-10-01' },
                sweep_range: { from: '2025-10-01', to: '2025-11-01' },
                cohorts_analysed: 1,
              },
            },
          ],
        },
      ],
    };
  }

  function buildRequest(queryDsl = 'from(a).to(b).cohort(1-Oct-25,31-Oct-25)') {
    return {
      analysis_type: 'cohort_maturity',
      query_dsl: queryDsl,
      scenarios: [
        {
          scenario_id: 'sc1',
          scenario_name: 'Baseline',
          snapshot_subjects: [{
            subject_id: 'subj1',
            subject_label: 'a → b',
            param_id: 'repo-branch-param-1',
            canonical_signature: 'sig',
            core_hash: 'hash',
            read_mode: 'cohort_maturity',
            anchor_from: '2025-10-01',
            anchor_to: '2025-10-01',
            sweep_from: '2025-10-01',
            sweep_to: '2025-11-01',
            slice_keys: ['cohort()'],
            target: { targetId: 'edge-1', slot: 'p' },
          }],
        },
      ],
    };
  }

  it('should produce τ-indexed rows from BE-computed maturity_rows', () => {
    // Single anchor day (2025-10-01). BE computes a single maturity row at τ=3.
    const frames = [
      { snapshot_date: '2025-10-01', data_points: [], total_y: 0 },
      { snapshot_date: '2025-10-04',
        data_points: [{ anchor_day: '2025-10-01', y: 42, x: 100, a: 1000, rate: 0.42 }],
        total_y: 42,
      },
    ];
    const maturity_rows = [
      { tau_days: 3, rate: 0.42, y_base: 42, tau_solid_max: 3, tau_future_max: 30, boundary_date: '2025-10-04' },
    ];

    const raw = buildRawResponse(frames);
    // Inject maturity_rows into the subject result (BE provides these).
    raw.scenarios[0].subjects[0].result.maturity_rows = maturity_rows;
    const request = buildRequest();

    const result = (client as any).normaliseSnapshotCohortMaturityResponse(raw, request);

    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);

    const data = result!.result!.data;
    expect(data.length).toBe(1);
    expect(data[0].tau_days).toBe(3);
    expect(data[0].rate).toBeCloseTo(0.42);
    expect(data[0]).toHaveProperty('y_base');
    expect(data[0]).toHaveProperty('tau_solid_max');
    expect(data[0]).toHaveProperty('tau_future_max');
    expect(data[0]).toHaveProperty('boundary_date');
  });

  it('should produce empty data when all frames are empty', () => {
    const frames = [
      { snapshot_date: '2025-10-01', data_points: [], total_y: 0 },
      { snapshot_date: '2025-10-02', data_points: [], total_y: 0 },
    ];

    const raw = buildRawResponse(frames);
    const request = buildRequest();

    const result = (client as any).normaliseSnapshotCohortMaturityResponse(raw, request);

    expect(result).not.toBeNull();
    const data = result!.result!.data;
    // No data points at all → no τ buckets → empty data.
    expect(data).toHaveLength(0);
  });

  it('should pass through BE-computed maturity_rows with monotonically increasing rates', () => {
    // BE computes τ-indexed rows with monotonically increasing rates.
    const frames = [
      {
        snapshot_date: '2025-10-10',
        data_points: [{ anchor_day: '2025-10-01', y: 10, x: 100, a: 1000, rate: 0.10 }],
        total_y: 10,
      },
      {
        snapshot_date: '2025-10-20',
        data_points: [{ anchor_day: '2025-10-01', y: 30, x: 100, a: 1000, rate: 0.30 }],
        total_y: 30,
      },
      {
        snapshot_date: '2025-10-21',
        is_synthetic: true,
        data_points: [{ anchor_day: '2025-10-01', y: 31, x: 100, a: 1000, rate: 0.31 }],
        total_y: 31,
      },
    ];
    const maturity_rows = [
      { tau_days: 9, rate: 0.10, projected_rate: 0.20, y_base: 10, tau_solid_max: 20, tau_future_max: 30, boundary_date: '2025-10-21' },
      { tau_days: 19, rate: 0.30, projected_rate: 0.40, y_base: 30, tau_solid_max: 20, tau_future_max: 30, boundary_date: '2025-10-21' },
      { tau_days: 20, rate: 0.31, y_base: 31, tau_solid_max: 20, tau_future_max: 30, boundary_date: '2025-10-21' },
    ];

    const raw = buildRawResponse(frames);
    raw.scenarios[0].subjects[0].result.maturity_rows = maturity_rows;
    const request: any = {
      analysis_type: 'cohort_maturity',
      query_dsl: 'from(a).to(b).cohort(1-Oct-25,31-Oct-25)',
      scenarios: [{
        scenario_id: 'sc1',
        scenario_name: 'Baseline',
        snapshot_subjects: [{
          subject_id: 'subj1',
          subject_label: 'a → b',
          param_id: 'repo-branch-param-1',
          canonical_signature: 'sig',
          core_hash: 'hash',
          read_mode: 'cohort_maturity',
          anchor_from: '2025-10-01',
          anchor_to: '2025-10-01',
          sweep_from: '2025-10-01',
          sweep_to: '2025-10-21',
          slice_keys: ['cohort()'],
          target: { targetId: 'edge-1', slot: 'p' },
        }],
      }],
    };

    const result = (client as any).normaliseSnapshotCohortMaturityResponse(raw, request);
    const data = result!.result!.data;

    expect(data).toHaveLength(3);

    const tau9 = data.find((r: any) => r.tau_days === 9);
    const tau19 = data.find((r: any) => r.tau_days === 19);
    const tau20 = data.find((r: any) => r.tau_days === 20);
    expect(tau9).toBeDefined();
    expect(tau19).toBeDefined();
    expect(tau20).toBeDefined();

    expect(tau9.rate).toBeCloseTo(0.10);
    expect(tau19.rate).toBeCloseTo(0.30);
    expect(tau20.rate).toBeCloseTo(0.31);

    // Projected rates.
    expect(tau9.projected_rate).toBeCloseTo(0.20);
    expect(tau19.projected_rate).toBeCloseTo(0.40);

    // Monotonically increasing.
    expect(tau19.rate).toBeGreaterThan(tau9.rate);
    expect(tau20.rate).toBeGreaterThanOrEqual(tau19.rate);
  });

  it('should pass through BE-computed rates for non-latency edge with multiple anchor days', () => {
    // BE computes per-τ aggregated rates across anchor days.
    const frames = [
      {
        snapshot_date: '2025-10-03',
        data_points: [
          { anchor_day: '2025-10-01', y: 10, x: 100, a: 100, rate: 0.10 },
          { anchor_day: '2025-10-02', y: 20, x: 100, a: 100, rate: 0.20 },
          { anchor_day: '2025-10-03', y: 30, x: 100, a: 100, rate: 0.30 },
        ],
        total_y: 60,
      },
      {
        snapshot_date: '2025-10-04',
        data_points: [
          { anchor_day: '2025-10-01', y: 10, x: 100, a: 100, rate: 0.10 },
          { anchor_day: '2025-10-02', y: 20, x: 100, a: 100, rate: 0.20 },
          { anchor_day: '2025-10-03', y: 30, x: 100, a: 100, rate: 0.30 },
        ],
        total_y: 60,
      },
    ];
    // BE-computed τ-indexed rows (aggregated across anchor days at each age).
    const maturity_rows = [
      { tau_days: 0, rate: 0.30 },
      { tau_days: 1, rate: 0.25 },
      { tau_days: 2, rate: 0.15 },
      { tau_days: 3, rate: 0.10 },
    ];

    const raw = buildRawResponse(frames, 'sc1', 'subj1');
    raw.scenarios[0].subjects[0].result.maturity_rows = maturity_rows;
    const request: any = {
      analysis_type: 'cohort_maturity',
      query_dsl: 'from(a).to(b).cohort(1-Oct-25,3-Oct-25)',
      scenarios: [{
        scenario_id: 'sc1',
        scenario_name: 'Baseline',
        snapshot_subjects: [{
          subject_id: 'subj1',
          subject_label: 'a → b',
          param_id: 'repo-branch-param-1',
          canonical_signature: 'sig',
          core_hash: 'hash',
          read_mode: 'cohort_maturity',
          anchor_from: '2025-10-01',
          anchor_to: '2025-10-03',
          sweep_from: '2025-10-01',
          sweep_to: '2025-10-05',
          slice_keys: ['cohort()'],
          target: { targetId: 'edge-1', slot: 'p' },
        }],
      }],
    };

    const result = (client as any).normaliseSnapshotCohortMaturityResponse(raw, request);

    expect(result).not.toBeNull();
    const data = result!.result!.data;

    expect(data.length).toBe(4);
    const byTau = Object.fromEntries(data.map((r: any) => [r.tau_days, r]));
    expect(byTau[0].rate).toBeCloseTo(0.30);
    expect(byTau[1].rate).toBeCloseTo(0.25);
    expect(byTau[2].rate).toBeCloseTo(0.15);
    expect(byTau[3].rate).toBeCloseTo(0.10);
  });

  it('should attach fully detailed cohort rows for CSV export', () => {
    const frames = [
      {
        snapshot_date: '2025-10-04',
        data_points: [
          { anchor_day: '2025-10-01', y: 42, x: 100, a: 1000, rate: 0.42, median_lag_days: 3.2, mean_lag_days: 4.1, onset_delta_days: 1.0 },
          { anchor_day: '2025-10-02', y: 10, x: 50, a: 500, rate: 0.20 },
        ],
        total_y: 52,
      },
    ];
    // Need at least one maturity_row so the result doesn't take the "empty" branch.
    const maturity_rows = [
      { tau_days: 3, rate: 0.42 },
    ];

    const raw = buildRawResponse(frames);
    raw.scenarios[0].subjects[0].result.maturity_rows = maturity_rows;
    const request = buildRequest('from(a).to(b).window(1-Oct-25:31-Oct-25)');
    const result = (client as any).normaliseSnapshotCohortMaturityResponse(raw, request);

    const exportTables = (result!.result!.metadata as any)?.export_tables;
    expect(exportTables).toBeTruthy();
    const points = exportTables.cohort_maturity_points;
    expect(Array.isArray(points)).toBe(true);
    expect(points.length).toBe(2);
    expect(points[0]).toHaveProperty('snapshot_date', '2025-10-04');
    expect(points[0]).toHaveProperty('anchor_day');
    expect(points[0]).toHaveProperty('cohort_age_days');
    expect(points[0]).toHaveProperty('cohort_age_at_window_end_days');
    expect(points[0]).toHaveProperty('window_from');
    expect(points[0]).toHaveProperty('window_to');
    expect(points[0]).toHaveProperty('x');
    expect(points[0]).toHaveProperty('y');
  });
});

// ============================================================================
// Family F — chart payload normaliser preserves canonical semantics block.
//
// §3.6 receipt:
//   Family:    F (projection / authority)
//   Invariant: The snapshot-response normaliser emits a canonical `semantics`
//              block — fixed dimension IDs, fixed metric IDs, `chart.recommended`
//              matching `analysis_type` — on both the populated and empty paths.
//              The normaliser must NOT invent new computed metrics or promote
//              BE-raw fields into the metrics list.
//   Oracle:    static canonical spec (no reference implementation)
//   Apparatus: TS unit test against `normaliseSnapshotCohortMaturityResponse`
//   Fixtures:  minimal cohort_maturity raw response (populated + empty)
//   Reality:   catches regressions where the normaliser invents metric IDs or
//              sets `chart.recommended` to a non-canonical string; catches the
//              empty-path forgetting to emit semantics at all.
//   False-pass: a fixture that hand-constructs the semantics block and the
//              normaliser trusts it through (covered: semantics is authored
//              by the normaliser from the analysis_type, not copied from BE).
//   Retires:   ad-hoc assertions scattered across the populated-path tests
//              that checked `analysis_type` and `chart.recommended` piecemeal.
// ============================================================================

describe('GraphComputeClient - Chart payload semantics contract (Family F)', () => {
  const client = new GraphComputeClient('http://localhost:9000', true);

  const COHORT_MATURITY_CANONICAL_DIMENSION_IDS = new Set([
    'tau_days',
    'scenario_id',
    'subject_id',
  ]);
  const COHORT_MATURITY_CANONICAL_METRIC_IDS = new Set([
    'rate',
    'projected_rate',
    'x_covered',
    'y_base',
    'y_projected',
  ]);

  function buildRawResponse(frames: any[], scenarioId = 'sc1', subjectId = 'subj1') {
    return {
      success: true,
      scenarios: [
        {
          scenario_id: scenarioId,
          subjects: [
            {
              subject_id: subjectId,
              success: true,
              result: {
                analysis_type: 'cohort_maturity',
                frames,
                anchor_range: { from: '2025-10-01', to: '2025-10-01' },
                sweep_range: { from: '2025-10-01', to: '2025-11-01' },
                cohorts_analysed: 1,
              },
            },
          ],
        },
      ],
    };
  }

  function buildRequest(queryDsl = 'from(a).to(b).cohort(1-Oct-25,31-Oct-25)') {
    return {
      analysis_type: 'cohort_maturity',
      query_dsl: queryDsl,
      scenarios: [
        {
          scenario_id: 'sc1',
          scenario_name: 'Baseline',
          snapshot_subjects: [{
            subject_id: 'subj1',
            subject_label: 'a → b',
            param_id: 'repo-branch-param-1',
            canonical_signature: 'sig',
            core_hash: 'hash',
            read_mode: 'cohort_maturity',
            anchor_from: '2025-10-01',
            anchor_to: '2025-10-01',
            sweep_from: '2025-10-01',
            sweep_to: '2025-11-01',
            slice_keys: ['cohort()'],
            target: { targetId: 'edge-1', slot: 'p' },
          }],
        },
      ],
    };
  }

  it('populated path: emits canonical semantics with analysis-type-matching chart.recommended', () => {
    const frames = [
      { snapshot_date: '2025-10-04',
        data_points: [{ anchor_day: '2025-10-01', y: 42, x: 100, a: 1000, rate: 0.42 }],
        total_y: 42 },
    ];
    const raw = buildRawResponse(frames);
    raw.scenarios[0].subjects[0].result.maturity_rows = [
      { tau_days: 3, rate: 0.42 },
    ];

    const response = (client as any).normaliseSnapshotCohortMaturityResponse(raw, buildRequest());
    expect(response).not.toBeNull();

    const result = response.result;
    expect(result.analysis_type).toBe('cohort_maturity');

    const semantics = result.semantics;
    expect(semantics).toBeDefined();
    expect(semantics.dimensions).toBeDefined();
    expect(semantics.metrics).toBeDefined();
    expect(semantics.chart).toBeDefined();

    expect(semantics.chart.recommended).toBe(result.analysis_type);
  });

  it('populated path: dimension IDs are drawn only from the canonical set', () => {
    const frames = [
      { snapshot_date: '2025-10-04',
        data_points: [{ anchor_day: '2025-10-01', y: 42, x: 100, a: 1000, rate: 0.42 }],
        total_y: 42 },
    ];
    const raw = buildRawResponse(frames);
    raw.scenarios[0].subjects[0].result.maturity_rows = [{ tau_days: 3, rate: 0.42 }];

    const response = (client as any).normaliseSnapshotCohortMaturityResponse(raw, buildRequest());
    const semantics = response.result.semantics;
    const seenDimensionIds = (semantics.dimensions as any[]).map(d => d.id);

    for (const id of seenDimensionIds) {
      expect(COHORT_MATURITY_CANONICAL_DIMENSION_IDS.has(id)).toBe(true);
    }
    expect(seenDimensionIds).toContain('tau_days');
  });

  it('populated path: metric IDs are drawn only from the canonical set and are not derived from BE raw keys', () => {
    const frames = [
      { snapshot_date: '2025-10-04',
        data_points: [{ anchor_day: '2025-10-01', y: 42, x: 100, a: 1000, rate: 0.42 }],
        total_y: 42 },
    ];
    const raw = buildRawResponse(frames);
    raw.scenarios[0].subjects[0].result.maturity_rows = [
      { tau_days: 3, rate: 0.42, some_new_be_metric: 0.99, another_fabricated_field: 'x' },
    ];

    const response = (client as any).normaliseSnapshotCohortMaturityResponse(raw, buildRequest());
    const semantics = response.result.semantics;
    const seenMetricIds = (semantics.metrics as any[]).map(m => m.id);

    for (const id of seenMetricIds) {
      expect(COHORT_MATURITY_CANONICAL_METRIC_IDS.has(id)).toBe(true);
    }
    expect(seenMetricIds).toContain('rate');
    expect(seenMetricIds).not.toContain('some_new_be_metric');
    expect(seenMetricIds).not.toContain('another_fabricated_field');
  });

  it('empty path: still emits canonical semantics block with analysis-type-matching chart.recommended', () => {
    const frames = [
      { snapshot_date: '2025-10-01', data_points: [], total_y: 0 },
    ];
    const raw = buildRawResponse(frames);

    const response = (client as any).normaliseSnapshotCohortMaturityResponse(raw, buildRequest());
    expect(response).not.toBeNull();

    const result = response.result;
    expect(result.analysis_type).toBe('cohort_maturity');
    expect(result.semantics).toBeDefined();
    expect(result.semantics.chart).toBeDefined();
    expect(result.semantics.chart.recommended).toBe(result.analysis_type);
    expect(Array.isArray(result.semantics.dimensions)).toBe(true);
    expect(Array.isArray(result.semantics.metrics)).toBe(true);
  });

  it('semantics block is authored by the normaliser and is independent of BE-supplied semantics', () => {
    const frames = [
      { snapshot_date: '2025-10-04',
        data_points: [{ anchor_day: '2025-10-01', y: 42, x: 100, a: 1000, rate: 0.42 }],
        total_y: 42 },
    ];
    const raw = buildRawResponse(frames);
    raw.scenarios[0].subjects[0].result.maturity_rows = [{ tau_days: 3, rate: 0.42 }];
    raw.scenarios[0].subjects[0].result.semantics = {
      dimensions: [{ id: 'bogus_dim', name: 'Bogus', type: 'number', role: 'primary' }],
      metrics: [{ id: 'bogus_metric', name: 'Bogus', type: 'number', role: 'primary' }],
      chart: { recommended: 'bogus_chart', alternatives: [] },
    };

    const response = (client as any).normaliseSnapshotCohortMaturityResponse(raw, buildRequest());
    const semantics = response.result.semantics;

    expect(semantics.chart.recommended).toBe('cohort_maturity');
    const dimIds = (semantics.dimensions as any[]).map(d => d.id);
    const metIds = (semantics.metrics as any[]).map(m => m.id);
    expect(dimIds).not.toContain('bogus_dim');
    expect(metIds).not.toContain('bogus_metric');
  });
});

describe('GraphComputeClient - Surprise Gauge Normalisation', () => {
  const client = new GraphComputeClient('http://localhost:9000', true);

  it('preserves per-scenario gauge payloads and focuses the last scenario by default', () => {
    const request: any = {
      analysis_type: 'surprise_gauge',
      scenarios: [
        {
          scenario_id: 'scenario-1',
          name: 'Scenario 1',
          colour: '#ec4899',
          visibility_mode: 'f+e',
          graph: {},
        },
        {
          scenario_id: 'current',
          name: 'Current',
          colour: '#3b82f6',
          visibility_mode: 'f+e',
          graph: {},
        },
      ],
    };

    const raw: any = {
      success: true,
      scenarios: [
        {
          scenario_id: 'scenario-1',
          subjects: [
            {
              subject_id: 's-scenario-1',
              success: true,
              result: {
                analysis_type: 'surprise_gauge',
                analysis_name: 'Expectation Gauge',
                variables: [
                  {
                    name: 'p',
                    label: 'Conversion rate',
                    available: true,
                    observed: 0.2,
                    expected: 0.25,
                    sigma: -1,
                    quantile: 0.16,
                    posterior_sd: 0.05,
                    zone: 'noteworthy',
                    evidence_n: 100,
                    evidence_k: 20,
                  },
                ],
                hint: 'Run Bayes model for better forecasts',
              },
            },
          ],
        },
        {
          scenario_id: 'current',
          subjects: [
            {
              subject_id: 's-current',
              success: true,
              result: {
                analysis_type: 'surprise_gauge',
                analysis_name: 'Expectation Gauge',
                variables: [
                  {
                    name: 'p',
                    label: 'Conversion rate',
                    available: true,
                    observed: 0.4,
                    expected: 0.3,
                    sigma: 1.5,
                    quantile: 0.93,
                    posterior_sd: 0.04,
                    zone: 'surprising',
                    evidence_n: 120,
                    evidence_k: 48,
                  },
                  {
                    name: 'completeness',
                    label: 'Completeness',
                    available: true,
                    observed: 0.72,
                    expected: 0.61,
                    sigma: 1.2,
                    quantile: 0.88,
                    posterior_sd: 0.03,
                    zone: 'noteworthy',
                    evidence_n: 120,
                    evidence_k: 48,
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const result = (client as any).normaliseSnapshotSurpriseGaugeResponse(raw, request);

    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
    expect((result!.result as any).focused_scenario_id).toBe('current');
    expect((result!.result as any).scenario_results).toHaveLength(2);
    expect((result!.result as any).variables).toHaveLength(2);
    expect((result!.result as any).variables[0].observed).toBe(0.4);
    expect(result!.result!.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ scenario_id: 'scenario-1', variable: 'p', observed: 0.2 }),
      expect.objectContaining({ scenario_id: 'current', variable: 'completeness', observed: 0.72 }),
    ]));
    expect((result!.result as any).dimension_values.scenario_id.current.name).toBe('Current');
  });
});

describe('GraphComputeClient - Performance', () => {
  const client = new GraphComputeClient('http://localhost:9000', true);

  it('should respond quickly in mock mode', async () => {
    const start = Date.now();
    await client.parseQuery('from(a).to(b)');
    const duration = Date.now() - start;
    
    // Mock should be < 50ms (no network latency)
    // Using generous threshold to avoid flakiness from system load
    expect(duration).toBeLessThan(50);
  });

  it('should respond within reasonable time', async () => {
    if (!pythonServerAvailable) return;
    
    const realClient = new GraphComputeClient('http://localhost:9000', false);
    
    const start = Date.now();
    await realClient.health();
    const duration = Date.now() - start;
    
    // Real backend should be < 5000ms (allowing for cold start / full-suite load)
    expect(duration).toBeLessThan(5000);
  });
});

