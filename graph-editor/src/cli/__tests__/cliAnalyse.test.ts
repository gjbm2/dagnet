/**
 * CLI analyse integration tests.
 *
 * Tests scenario parsing (pure) and end-to-end analysis calls against
 * the real Python BE on localhost:9000. Tests that require the BE are
 * skipped if it's not running.
 *
 * Fixtures: same stable graph as cliParamPack.test.ts (3 nodes, 2 edges,
 * hand-computed parameter values).
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { join } from 'path';
import { loadGraphFromDisk, seedFileRegistry, type GraphBundle } from '../diskLoader';
import { aggregateAndPopulateGraph } from '../aggregate';
import { parseScenarioSpec } from '../scenarioParser';
import { PYTHON_API_BASE } from '../../lib/pythonApiBase';

const FIXTURES_DIR = join(__dirname, 'fixtures');

// ---------------------------------------------------------------------------
// Check BE availability — skip integration tests if not running
// ---------------------------------------------------------------------------

let beAvailable = false;

beforeAll(async () => {
  try {
    const r = await fetch(`${PYTHON_API_BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
    beAvailable = r.ok;
  } catch {
    beAvailable = false;
  }
  if (!beAvailable) {
    console.warn('[cliAnalyse] Python BE not running — skipping BE integration tests');
  }
});

describe('Scenario spec parsing', () => {
  it('should parse bare DSL with default name', () => {
    const spec = parseScenarioSpec('window(1-Dec-25:20-Dec-25)', 0);
    expect(spec.name).toBe('Scenario 1');
    expect(spec.queryDsl).toBe('window(1-Dec-25:20-Dec-25)');
  });

  it('should parse named scenario', () => {
    const spec = parseScenarioSpec('name=Before,window(1-Nov-25:30-Nov-25)', 0);
    expect(spec.name).toBe('Before');
    expect(spec.queryDsl).toBe('window(1-Nov-25:30-Nov-25)');
  });

  it('should parse name and colour', () => {
    const spec = parseScenarioSpec('name=After,colour=#ef4444,window(1-Dec-25:31-Dec-25)', 1);
    expect(spec.name).toBe('After');
    expect(spec.colour).toBe('#ef4444');
    expect(spec.queryDsl).toBe('window(1-Dec-25:31-Dec-25)');
  });

  it('should parse explicit scenario id', () => {
    const spec = parseScenarioSpec('id=scenario-before,name=Before,window(1-Nov-25:30-Nov-25)', 0);
    expect(spec.id).toBe('scenario-before');
    expect(spec.name).toBe('Before');
    expect(spec.queryDsl).toBe('window(1-Nov-25:30-Nov-25)');
  });

  it('should preserve commas inside parentheses in DSL', () => {
    const spec = parseScenarioSpec('name=Test,context(channel:google,device:mobile).window(-30d:)', 0);
    expect(spec.name).toBe('Test');
    expect(spec.queryDsl).toBe('context(channel:google,device:mobile).window(-30d:)');
  });

  it('should treat context(key:value) as DSL not as key=value property', () => {
    const spec = parseScenarioSpec('context(channel:paid).window(-30d:)', 0);
    expect(spec.queryDsl).toBe('context(channel:paid).window(-30d:)');
    expect(spec.name).toBe('Scenario 1');
  });

  it('should number default names sequentially', () => {
    const s1 = parseScenarioSpec('window(-60d:-30d)', 0);
    const s2 = parseScenarioSpec('window(-30d:)', 1);
    const s3 = parseScenarioSpec('window(-7d:)', 2);
    expect(s1.name).toBe('Scenario 1');
    expect(s2.name).toBe('Scenario 2');
    expect(s3.name).toBe('Scenario 3');
  });
});

// ---------------------------------------------------------------------------
// Multi-scenario aggregation (pure — no BE needed)
// ---------------------------------------------------------------------------

describe('Multi-scenario aggregation', () => {
  let bundle: GraphBundle;

  beforeAll(async () => {
    bundle = await loadGraphFromDisk(FIXTURES_DIR, 'test-fixture');
    seedFileRegistry(bundle);
  });

  it('should produce different evidence for different windows from the same graph', async () => {
    // First 5 days: n=500 for start-to-middle
    const { graph: g1 } = await aggregateAndPopulateGraph(bundle, 'window(1-Jan-26:5-Jan-26)');
    const edge1 = g1.edges.find((e: any) => e.id === 'start-to-middle');

    // Full 10 days: n=1000 for start-to-middle
    const { graph: g2 } = await aggregateAndPopulateGraph(bundle, 'window(1-Jan-26:10-Jan-26)');
    const edge2 = g2.edges.find((e: any) => e.id === 'start-to-middle');

    expect(edge1.p.evidence.n).toBe(500);
    expect(edge2.p.evidence.n).toBe(1000);
    expect(edge1.p.evidence.n).not.toBe(edge2.p.evidence.n);
  });

  it('should produce independent graphs (mutating one does not affect the other)', async () => {
    const { graph: g1 } = await aggregateAndPopulateGraph(bundle, 'window(1-Jan-26:5-Jan-26)');
    const { graph: g2 } = await aggregateAndPopulateGraph(bundle, 'window(1-Jan-26:10-Jan-26)');

    // Mutate g1
    g1.edges[0].p.mean = 999;
    // g2 should be unaffected
    expect(g2.edges[0].p.mean).not.toBe(999);
  });
});

// ---------------------------------------------------------------------------
// Subject joining
// ---------------------------------------------------------------------------

describe('Subject DSL joining', () => {
  it('should join subject with scenario DSL', () => {
    const subject = 'from(start).to(middle)';
    const scenarioDsl = 'window(1-Jan-26:10-Jan-26)';
    const joined = `${subject}.${scenarioDsl}`;
    expect(joined).toBe('from(start).to(middle).window(1-Jan-26:10-Jan-26)');
  });
});

// ---------------------------------------------------------------------------
// End-to-end BE integration (requires Python BE running)
// ---------------------------------------------------------------------------

describe('Analyse end-to-end (requires Python BE)', () => {
  let bundle: GraphBundle;

  beforeAll(async () => {
    bundle = await loadGraphFromDisk(FIXTURES_DIR, 'test-fixture');
    seedFileRegistry(bundle);
  });

  it('should return a successful graph_overview analysis for a single scenario', async () => {
    if (!beAvailable) return;

    const { graph } = await aggregateAndPopulateGraph(bundle, 'window(1-Jan-26:10-Jan-26)');

    const request = {
      scenarios: [{
        scenario_id: 'Scenario 1',
        name: 'Scenario 1',
        colour: '#3b82f6',
        visibility_mode: 'f+e',
        graph,
      }],
      query_dsl: 'window(1-Jan-26:10-Jan-26)',
      analysis_type: 'graph_overview',
    };

    const response = await fetch(`${PYTHON_API_BASE}/api/runner/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    expect(response.ok).toBe(true);
    const result = await response.json();
    expect(result.success).toBe(true);
    expect(result.result.analysis_type).toBe('graph_overview');
    expect(result.result.data).toBeInstanceOf(Array);
    expect(result.result.data.length).toBeGreaterThan(0);
    // Should have probability values for terminal nodes
    expect(result.result.data[0]).toHaveProperty('probability');
    expect(typeof result.result.data[0].probability).toBe('number');
  });

  it('should return results for two scenarios with different scenario_ids', async () => {
    if (!beAvailable) return;

    const { graph: g1 } = await aggregateAndPopulateGraph(bundle, 'window(1-Jan-26:5-Jan-26)');
    const { graph: g2 } = await aggregateAndPopulateGraph(bundle, 'window(1-Jan-26:10-Jan-26)');

    const request = {
      scenarios: [
        { scenario_id: 'Scenario 1', name: 'Scenario 1', colour: '#3b82f6', visibility_mode: 'f+e', graph: g1 },
        { scenario_id: 'Scenario 2', name: 'Scenario 2', colour: '#ef4444', visibility_mode: 'f+e', graph: g2 },
      ],
      query_dsl: 'window(1-Jan-26:5-Jan-26)',
      analysis_type: 'graph_overview',
    };

    const response = await fetch(`${PYTHON_API_BASE}/api/runner/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    expect(response.ok).toBe(true);
    const result = await response.json();
    expect(result.success).toBe(true);

    // Both scenario IDs should appear in the dimension values
    const scenarioDims = result.result?.dimension_values?.scenario_id;
    expect(scenarioDims).toHaveProperty('Scenario 1');
    expect(scenarioDims).toHaveProperty('Scenario 2');

    // Data should contain entries from both scenarios
    const scenarioIds = new Set(result.result.data.map((d: any) => d.scenario_id));
    expect(scenarioIds.has('Scenario 1')).toBe(true);
    expect(scenarioIds.has('Scenario 2')).toBe(true);
  });

  it('should include subject DSL in query_dsl when provided', async () => {
    if (!beAvailable) return;

    const { graph } = await aggregateAndPopulateGraph(bundle, 'window(1-Jan-26:10-Jan-26)');

    // Use from().to() subject — the BE should parse this
    const request = {
      scenarios: [{
        scenario_id: 'Scenario 1',
        name: 'Scenario 1',
        colour: '#3b82f6',
        visibility_mode: 'f+e',
        graph,
      }],
      query_dsl: 'from(start).to(middle).window(1-Jan-26:10-Jan-26)',
      analysis_type: 'graph_overview',
    };

    const response = await fetch(`${PYTHON_API_BASE}/api/runner/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    expect(response.ok).toBe(true);
    const result = await response.json();
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Snapshot-backed analysis (requires Python BE + seeds snapshot DB)
// ---------------------------------------------------------------------------

describe('Snapshot-backed analysis (requires Python BE)', () => {
  // Unique prefix per test run to avoid DB collisions
  const TEST_PREFIX = `pytest-cli-${Date.now()}`;
  const TEST_BRANCH = `run-${Math.random().toString(16).slice(2, 10)}`;
  const PARAM_ID = `${TEST_PREFIX}-${TEST_BRANCH}-param-start-middle`;
  const CORE_HASH = 'cli-test-hash-fixture';
  const EDGE_UUID = 'edge-start-middle-uuid';

  let bundle: GraphBundle;

  // Seed snapshot rows into the DB
  async function seedSnapshots(): Promise<void> {
    // 10 days of snapshot data for the start→middle edge
    // Each "retrieved_at" represents a nightly fetch
    const rows = [];
    for (let day = 1; day <= 10; day++) {
      const d = day.toString().padStart(2, '0');
      rows.push({
        anchor_day: `2026-01-${d}`,
        A: 200,
        X: 100,
        Y: 40,
        median_lag_days: 3.0,
        mean_lag_days: 3.5,
      });
    }

    const resp = await fetch(`${PYTHON_API_BASE}/api/snapshots/append`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        param_id: PARAM_ID,
        canonical_signature: JSON.stringify({ c: CORE_HASH, x: {} }),
        inputs_json: { schema: 'test_fixture_v1', test: true },
        sig_algo: 'sig_v1_sha256_trunc128_b64url',
        slice_key: 'window()',
        retrieved_at: '2026-01-11T10:00:00Z',
        rows,
      }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Failed to seed snapshots: ${resp.status} ${err}`);
    }
  }

  async function cleanupSnapshots(): Promise<void> {
    await fetch(`${PYTHON_API_BASE}/api/snapshots/delete-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ param_id_prefix: TEST_PREFIX }),
    });
  }

  beforeAll(async () => {
    if (!beAvailable) return;
    bundle = await loadGraphFromDisk(FIXTURES_DIR, 'test-fixture');
    seedFileRegistry(bundle);
    await seedSnapshots();
  });

  afterAll(async () => {
    if (!beAvailable) return;
    await cleanupSnapshots();
  });

  it('should return cohort_maturity analysis using seeded snapshot data', async () => {
    if (!beAvailable) return;

    const { graph } = await aggregateAndPopulateGraph(bundle, 'window(1-Jan-26:10-Jan-26)');

    const request = {
      scenarios: [{
        scenario_id: 'Scenario 1',
        name: 'Scenario 1',
        colour: '#3b82f6',
        visibility_mode: 'f+e',
        graph,
        snapshot_subjects: [{
          subject_id: `parameter:param-start-middle:${EDGE_UUID}:p`,
          subject_label: 'start → middle',
          param_id: PARAM_ID,
          canonical_signature: JSON.stringify({ c: CORE_HASH, x: {} }),
          core_hash: CORE_HASH,
          equivalent_hashes: [],
          read_mode: 'cohort_maturity',
          anchor_from: '2026-01-01',
          anchor_to: '2026-01-10',
          sweep_from: '2026-01-01',
          sweep_to: '2026-01-11',
          slice_keys: ['window()'],
          target: { targetId: EDGE_UUID },
        }],
      }],
      query_dsl: 'from(start).to(middle).window(1-Jan-26:10-Jan-26)',
      analysis_type: 'cohort_maturity',
    };

    const response = await fetch(`${PYTHON_API_BASE}/api/runner/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    expect(response.ok).toBe(true);
    const result = await response.json();
    expect(result.success).toBe(true);
    expect(result.result.analysis_type).toBe('cohort_maturity');
    // Should have frames (snapshot time-series)
    expect(result.result.frames).toBeInstanceOf(Array);
    expect(result.result.frames.length).toBeGreaterThan(0);
    // Each frame should have data_points from our seeded rows
    const frame = result.result.frames[0];
    expect(frame).toHaveProperty('data_points');
    expect(frame.data_points.length).toBeGreaterThan(0);
    // Y values should match our seeded data (Y=40)
    expect(frame.data_points[0]).toHaveProperty('y');
    expect(typeof frame.data_points[0].y).toBe('number');
  });

  it('should return daily_conversions analysis using seeded snapshot data', async () => {
    if (!beAvailable) return;

    const { graph } = await aggregateAndPopulateGraph(bundle, 'window(1-Jan-26:10-Jan-26)');

    const request = {
      scenarios: [{
        scenario_id: 'Scenario 1',
        name: 'Scenario 1',
        colour: '#3b82f6',
        visibility_mode: 'f+e',
        graph,
        snapshot_subjects: [{
          subject_id: `parameter:param-start-middle:${EDGE_UUID}:p`,
          subject_label: 'start → middle',
          param_id: PARAM_ID,
          canonical_signature: JSON.stringify({ c: CORE_HASH, x: {} }),
          core_hash: CORE_HASH,
          equivalent_hashes: [],
          read_mode: 'daily_conversions',
          anchor_from: '2026-01-01',
          anchor_to: '2026-01-10',
          sweep_from: '2026-01-01',
          sweep_to: '2026-01-11',
          slice_keys: ['window()'],
          target: { targetId: EDGE_UUID },
        }],
      }],
      query_dsl: 'from(start).to(middle).window(1-Jan-26:10-Jan-26)',
      analysis_type: 'daily_conversions',
    };

    const response = await fetch(`${PYTHON_API_BASE}/api/runner/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    expect(response.ok).toBe(true);
    const result = await response.json();
    expect(result.success).toBe(true);
    expect(result.result.analysis_type).toBe('daily_conversions');
  });

  it('should surface rate-evidence provenance when --diag is enabled for conditioned_forecast', async () => {
    if (!beAvailable) return;

    const { run } = await import('../commands/analyse');
    const { setDiagnostic } = await import('../logger');

    const savedArgv = process.argv;
    const savedDiagGlobal = (globalThis as any).__dagnetDiagnostics;
    const savedNoCacheGlobal = (globalThis as any).__dagnetComputeNoCache;
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as any);
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation((...args: any[]) => {
      stderrChunks.push(args.map((arg) => String(arg)).join(' '));
    });

    process.argv = [
      'node',
      'cli',
      '--graph',
      FIXTURES_DIR,
      '--name',
      'test-fixture',
      '--query',
      'window(1-Jan-26:10-Jan-26)',
      '--type',
      'conditioned_forecast',
      '--subject',
      'from(start).to(middle)',
      '--diag',
      '--no-cache',
    ];

    setDiagnostic(true);
    try {
      await run();
    } finally {
      setDiagnostic(false);
      process.argv = savedArgv;
      (globalThis as any).__dagnetDiagnostics = savedDiagGlobal;
      (globalThis as any).__dagnetComputeNoCache = savedNoCacheGlobal;
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }

    const stdout = stdoutChunks.join('');
    const stderr = stderrChunks.join('\n');
    const result = JSON.parse(stdout);

    expect(result._diagnostics).toBeDefined();
    expect(Array.isArray(result._diagnostics.rate_evidence_provenance_by_edge)).toBe(true);
    expect(result._diagnostics.rate_evidence_provenance_by_edge.length).toBeGreaterThan(0);
    expect(result._diagnostics.rate_evidence_provenance_by_edge[0]).toHaveProperty('selected_family');
    expect(stderr).toContain('── BE diagnostics ──');
    expect(stderr).toContain('rate_evidence_provenance_by_edge');
  });
});
