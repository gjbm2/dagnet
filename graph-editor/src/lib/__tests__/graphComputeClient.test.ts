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

import { describe, it, expect, beforeAll } from 'vitest';
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
              { as_at_date: '2025-10-01', data_points: [{ anchor_day: '2025-10-01', x: 10, y: 1 }] },
            ],
          },
        },
        {
          subject_id: 's1::epoch:1',
          success: true,
          result: {
            analysis_type: 'cohort_maturity',
            frames: [
              { as_at_date: '2025-10-02', data_points: [{ anchor_day: '2025-10-01', x: 20, y: 2 }] },
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

  it('should produce τ-indexed rows from group-by-age aggregation', () => {
    // Single anchor day (2025-10-01). One frame at τ=3 (as_at 2025-10-04).
    // Group-by-age: data point has age = Oct 4 − Oct 1 = 3 → single row at τ=3.
    const frames = [
      { as_at_date: '2025-10-01', data_points: [], total_y: 0 },
      { as_at_date: '2025-10-02', data_points: [], total_y: 0 },
      { as_at_date: '2025-10-03', data_points: [], total_y: 0 },
      {
        as_at_date: '2025-10-04',
        data_points: [{ anchor_day: '2025-10-01', y: 42, x: 100, a: 1000, rate: 0.42 }],
        total_y: 42,
      },
    ];

    const raw = buildRawResponse(frames);
    const request = buildRequest();

    const result = (client as any).normaliseSnapshotCohortMaturityResponse(raw, request);

    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);

    const data = result!.result!.data;
    // Only τ=3 has data (gap frames have no data points → no τ rows).
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
      { as_at_date: '2025-10-01', data_points: [], total_y: 0 },
      { as_at_date: '2025-10-02', data_points: [], total_y: 0 },
    ];

    const raw = buildRawResponse(frames);
    const request = buildRequest();

    const result = (client as any).normaliseSnapshotCohortMaturityResponse(raw, request);

    expect(result).not.toBeNull();
    const data = result!.result!.data;
    // No data points at all → no τ buckets → empty data.
    expect(data).toHaveLength(0);
  });

  it('should produce monotonically increasing evidence rate with sparse frames', () => {
    // Single anchor day (2025-10-01). Three observation frames at increasing ages.
    // Y grows over time (cumulative conversions). Rate must be monotonically increasing.
    const frames = [
      {
        as_at_date: '2025-10-10',
        data_points: [{ anchor_day: '2025-10-01', y: 10, x: 100, a: 1000, rate: 0.10, projected_y: 20, completeness: 0.5 }],
        total_y: 10,
      },
      {
        as_at_date: '2025-10-20',
        data_points: [{ anchor_day: '2025-10-01', y: 30, x: 100, a: 1000, rate: 0.30, projected_y: 40, completeness: 0.75 }],
        total_y: 30,
      },
      {
        as_at_date: '2025-10-21',
        is_synthetic: true,
        data_points: [{ anchor_day: '2025-10-01', y: 31, x: 100, a: 1000, rate: 0.31, projected_y: 40, completeness: 0.775 }],
        total_y: 31,
      },
    ];

    const raw = buildRawResponse(frames);
    const request: any = {
      analysis_type: 'cohort_maturity',
      query_dsl: 'from(a).to(b).cohort(1-Oct-25,31-Oct-25)',
      scenarios: [{
        scenario_id: 'sc1',
        scenario_name: 'Baseline',
        graph: {
          edges: [{ uuid: 'edge-1', p: { latency: { t95: 10, path_t95: 20 } } }],
        },
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

    // 3 data points at τ=9 (Oct 10), τ=19 (Oct 20), τ=20 (Oct 21 synthetic).
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

  it('should produce correct rates for non-latency edge with multiple anchor days', () => {
    // Non-latency edge: 3 anchor days (Oct 1–3). Real frames at Oct 3–5.
    // Each frame has data for all 3 anchors. Group-by-age produces multiple τ values.
    // At each τ, rate = Σ Y / Σ X across the anchor days at that age.
    const frames = [
      {
        as_at_date: '2025-10-03',
        data_points: [
          { anchor_day: '2025-10-01', y: 10, x: 100, a: 100, rate: 0.10 },
          { anchor_day: '2025-10-02', y: 20, x: 100, a: 100, rate: 0.20 },
          { anchor_day: '2025-10-03', y: 30, x: 100, a: 100, rate: 0.30 },
        ],
        total_y: 60,
      },
      {
        as_at_date: '2025-10-04',
        data_points: [
          { anchor_day: '2025-10-01', y: 10, x: 100, a: 100, rate: 0.10 },
          { anchor_day: '2025-10-02', y: 20, x: 100, a: 100, rate: 0.20 },
          { anchor_day: '2025-10-03', y: 30, x: 100, a: 100, rate: 0.30 },
        ],
        total_y: 60,
      },
    ];

    const raw = buildRawResponse(frames, 'sc1', 'subj1');
    const request: any = {
      analysis_type: 'cohort_maturity',
      query_dsl: 'from(a).to(b).cohort(1-Oct-25,3-Oct-25)',
      scenarios: [{
        scenario_id: 'sc1',
        scenario_name: 'Baseline',
        graph: { edges: [{ uuid: 'edge-1', p: {} }] },
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

    // Frame Oct 3 contributes: Oct 1 at τ=2, Oct 2 at τ=1, Oct 3 at τ=0.
    // Frame Oct 4 contributes: Oct 1 at τ=3, Oct 2 at τ=2, Oct 3 at τ=1.
    // τ=0: only Oct 3 from Oct 3 frame → rate = 30/100 = 0.30
    // τ=1: Oct 2 (Oct 3 frame) + Oct 3 (Oct 4 frame) → (20+30)/(100+100) = 0.25
    // τ=2: Oct 1 (Oct 3 frame) + Oct 2 (Oct 4 frame) → (10+20)/(100+100) = 0.15
    // τ=3: Oct 1 (Oct 4 frame) → rate = 10/100 = 0.10
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
        as_at_date: '2025-10-04',
        data_points: [
          { anchor_day: '2025-10-01', y: 42, x: 100, a: 1000, rate: 0.42, median_lag_days: 3.2, mean_lag_days: 4.1, onset_delta_days: 1.0 },
          { anchor_day: '2025-10-02', y: 10, x: 50, a: 500, rate: 0.20 },
        ],
        total_y: 52,
      },
    ];

    const raw = buildRawResponse(frames);
    const request = buildRequest('from(a).to(b).window(1-Oct-25:31-Oct-25)');
    const result = (client as any).normaliseSnapshotCohortMaturityResponse(raw, request);

    const exportTables = (result!.result!.metadata as any)?.export_tables;
    expect(exportTables).toBeTruthy();
    const points = exportTables.cohort_maturity_points;
    expect(Array.isArray(points)).toBe(true);
    expect(points.length).toBe(2);
    expect(points[0]).toHaveProperty('as_at_date', '2025-10-04');
    expect(points[0]).toHaveProperty('anchor_day');
    expect(points[0]).toHaveProperty('cohort_age_days');
    expect(points[0]).toHaveProperty('cohort_age_at_window_end_days');
    expect(points[0]).toHaveProperty('window_from');
    expect(points[0]).toHaveProperty('window_to');
    expect(points[0]).toHaveProperty('x');
    expect(points[0]).toHaveProperty('y');
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

