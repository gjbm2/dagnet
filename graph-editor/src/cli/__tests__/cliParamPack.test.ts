/**
 * CLI param-pack integration tests.
 *
 * Uses stable fixtures with hand-computable values — no mocks, no
 * Python BE, no external services. Tests exercise the same code paths
 * the CLI entry point uses: disk loading → registry seeding →
 * aggregation → LAG pass → param extraction → serialisation.
 *
 * Fixture data (in ./fixtures/):
 *   Graph: 3 nodes (start → middle → end), 2 edges
 *   Parameters: 10 days each, constant daily values
 *     start→middle: n=100/day, k=40/day (mean=0.4)
 *     middle→end:   n=50/day,  k=35/day (mean=0.7)
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'path';
import { loadGraphFromDisk, seedFileRegistry, type GraphBundle } from '../diskLoader';
import { aggregateAndPopulateGraph } from '../aggregate';
import { extractParamsFromGraph } from '../../services/GraphParamExtractor';
import { flattenParams, toYAML, toJSON, toCSV } from '../../services/ParamPackDSLService';

const FIXTURES_DIR = join(__dirname, 'fixtures');

describe('CLI disk loader', () => {
  let bundle: GraphBundle;

  beforeAll(async () => {
    bundle = await loadGraphFromDisk(FIXTURES_DIR, 'test-fixture');
    seedFileRegistry(bundle);
  });

  it('should load graph with correct node and edge counts', () => {
    expect(bundle.graph.nodes).toHaveLength(3);
    expect(bundle.graph.edges).toHaveLength(2);
  });

  it('should load all event definitions keyed by id', () => {
    expect(bundle.events.size).toBe(3);
    expect(bundle.events.has('start-event')).toBe(true);
    expect(bundle.events.has('middle-event')).toBe(true);
    expect(bundle.events.has('end-event')).toBe(true);
  });

  it('should load parameter files with daily arrays intact', () => {
    expect(bundle.parameters.size).toBe(2);

    const p1 = bundle.parameters.get('param-start-middle');
    expect(p1).toBeDefined();
    expect(p1.values).toHaveLength(1);
    expect(p1.values[0].n_daily).toHaveLength(10);
    expect(p1.values[0].k_daily).toHaveLength(10);
    expect(p1.values[0].dates).toHaveLength(10);

    const p2 = bundle.parameters.get('param-middle-end');
    expect(p2).toBeDefined();
    expect(p2.values[0].n_daily).toHaveLength(10);
  });

  it('should load context definitions and pre-populate registry', () => {
    expect(bundle.contexts.size).toBe(1);
    expect(bundle.contexts.has('test-channel')).toBe(true);
    const ctx = bundle.contexts.get('test-channel')!;
    expect(ctx.values).toHaveLength(2);
    expect(ctx.values[0].id).toBe('organic');
  });

  it('should load connections file', () => {
    expect(bundle.connections).toBeDefined();
    expect(bundle.connections.connections).toHaveLength(1);
    expect(bundle.connections.connections[0].name).toBe('test-conn');
  });

  it('should resolve edge p.id to loaded parameter file', () => {
    const edge = bundle.graph.edges[0];
    const paramId = edge.p?.id;
    expect(paramId).toBeDefined();
    expect(bundle.parameters.has(paramId)).toBe(true);
  });
});

describe('CLI aggregation — full 10-day window', () => {
  let flat: Record<string, any>;
  let warnings: string[];

  beforeAll(async () => {
    const bundle = await loadGraphFromDisk(FIXTURES_DIR, 'test-fixture');
    seedFileRegistry(bundle);
    const { graph, warnings: w } = await aggregateAndPopulateGraph(bundle, 'window(1-Jan-26:10-Jan-26)');
    warnings = w;
    const params = extractParamsFromGraph(graph);
    flat = flattenParams(params);
  });

  it('should produce correct evidence n and k for start-to-middle (10 days × 100n/40k)', () => {
    expect(flat['e.start-to-middle.p.evidence.n']).toBe(1000);
    expect(flat['e.start-to-middle.p.evidence.k']).toBe(400);
  });

  it('should produce correct evidence mean for start-to-middle (400/1000 = 0.4)', () => {
    expect(flat['e.start-to-middle.p.evidence.mean']).toBeCloseTo(0.4, 6);
  });

  it('should produce correct evidence n and k for middle-to-end (10 days × 50n/35k)', () => {
    expect(flat['e.middle-to-end.p.evidence.n']).toBe(500);
    expect(flat['e.middle-to-end.p.evidence.k']).toBe(350);
  });

  it('should produce correct evidence mean for middle-to-end (350/500 = 0.7)', () => {
    expect(flat['e.middle-to-end.p.evidence.mean']).toBeCloseTo(0.7, 6);
  });

  it('should compute evidence stdev as binomial sqrt(p(1-p)/n)', () => {
    // start-to-middle: sqrt(0.4 * 0.6 / 1000) = 0.01549...
    expect(flat['e.start-to-middle.p.evidence.stdev']).toBeCloseTo(
      Math.sqrt(0.4 * 0.6 / 1000), 5
    );
    // middle-to-end: sqrt(0.7 * 0.3 / 500) = 0.02049...
    expect(flat['e.middle-to-end.p.evidence.stdev']).toBeCloseTo(
      Math.sqrt(0.7 * 0.3 / 500), 5
    );
  });

  it('should have no aggregation warnings for full window coverage', () => {
    // May have LAG warnings for edges without enough data, but no "no data" warnings
    const dataWarnings = warnings.filter(w => w.includes('no data points'));
    expect(dataWarnings).toHaveLength(0);
  });
});

describe('CLI aggregation — 5-day sub-window', () => {
  let flat: Record<string, any>;

  beforeAll(async () => {
    const bundle = await loadGraphFromDisk(FIXTURES_DIR, 'test-fixture');
    seedFileRegistry(bundle);
    // Only first 5 days: 1-Jan to 5-Jan
    const { graph } = await aggregateAndPopulateGraph(bundle, 'window(1-Jan-26:5-Jan-26)');
    const params = extractParamsFromGraph(graph);
    flat = flattenParams(params);
  });

  it('should aggregate only 5 days for start-to-middle (5 × 100n = 500)', () => {
    expect(flat['e.start-to-middle.p.evidence.n']).toBe(500);
    expect(flat['e.start-to-middle.p.evidence.k']).toBe(200);
  });

  it('should aggregate only 5 days for middle-to-end (5 × 50n = 250)', () => {
    expect(flat['e.middle-to-end.p.evidence.n']).toBe(250);
    expect(flat['e.middle-to-end.p.evidence.k']).toBe(175);
  });

  it('should produce same mean as full window (constant daily rates)', () => {
    expect(flat['e.start-to-middle.p.evidence.mean']).toBeCloseTo(0.4, 6);
    expect(flat['e.middle-to-end.p.evidence.mean']).toBeCloseTo(0.7, 6);
  });

  it('should produce larger stdev than full window (smaller n)', () => {
    // 500 samples instead of 1000 → larger stdev
    const fullStdev = Math.sqrt(0.4 * 0.6 / 1000);
    const subStdev = Math.sqrt(0.4 * 0.6 / 500);
    expect(flat['e.start-to-middle.p.evidence.stdev']).toBeCloseTo(subStdev, 5);
    expect(flat['e.start-to-middle.p.evidence.stdev']).toBeGreaterThan(fullStdev);
  });
});

describe('CLI aggregation — window outside data range', () => {
  let flat: Record<string, any>;
  let warnings: string[];

  beforeAll(async () => {
    const bundle = await loadGraphFromDisk(FIXTURES_DIR, 'test-fixture');
    seedFileRegistry(bundle);
    // Window entirely outside the data range (data is Jan, query is Mar)
    const { graph, warnings: w } = await aggregateAndPopulateGraph(bundle, 'window(1-Mar-26:10-Mar-26)');
    warnings = w;
    const params = extractParamsFromGraph(graph);
    flat = flattenParams(params);
  });

  it('should still produce a result when window is outside data range', () => {
    // The real FE pipeline handles out-of-range windows gracefully — it may
    // fall back to file-level aggregates or graph-as-saved values. The key
    // contract: the pipeline does not error, and the result is a valid
    // param pack (may have evidence from fallback, may be empty).
    expect(flat).toBeDefined();
    expect(typeof flat).toBe('object');
  });
});

describe('CLI serialisation formats', () => {
  let params: any;

  beforeAll(async () => {
    const bundle = await loadGraphFromDisk(FIXTURES_DIR, 'test-fixture');
    seedFileRegistry(bundle);
    const { graph } = await aggregateAndPopulateGraph(bundle, 'window(1-Jan-26:10-Jan-26)');
    params = extractParamsFromGraph(graph);
  });

  it('should produce valid YAML with all edge keys', () => {
    const yaml = toYAML(params, 'flat');
    expect(yaml).toContain('e.start-to-middle.p.evidence.n');
    expect(yaml).toContain('e.middle-to-end.p.evidence.n');
  });

  it('should produce valid parseable JSON', () => {
    const json = toJSON(params, 'flat');
    const parsed = JSON.parse(json);
    expect(parsed['e.start-to-middle.p.evidence.n']).toBe(1000);
    expect(parsed['e.middle-to-end.p.evidence.k']).toBe(350);
  });

  it('should produce CSV with header row and data rows', () => {
    const csv = toCSV(params);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('key,value');
    expect(lines.length).toBeGreaterThan(1);
    // Check a specific row
    const row = lines.find(l => l.startsWith('e.start-to-middle.p.evidence.n,'));
    expect(row).toBe('e.start-to-middle.p.evidence.n,1000');
  });
});

describe('CLI --get single scalar extraction', () => {
  let flat: Record<string, any>;

  beforeAll(async () => {
    const bundle = await loadGraphFromDisk(FIXTURES_DIR, 'test-fixture');
    seedFileRegistry(bundle);
    const { graph } = await aggregateAndPopulateGraph(bundle, 'window(1-Jan-26:10-Jan-26)');
    const params = extractParamsFromGraph(graph);
    flat = flattenParams(params);
  });

  it('should find exact key and return correct value', () => {
    const value = flat['e.start-to-middle.p.evidence.mean'];
    expect(value).toBeCloseTo(0.4, 6);
  });

  it('should return undefined for non-existent key', () => {
    expect(flat['e.nonexistent.p.mean']).toBeUndefined();
  });

  it('should distinguish between edges by key prefix', () => {
    expect(flat['e.start-to-middle.p.evidence.n']).toBe(1000);
    expect(flat['e.middle-to-end.p.evidence.n']).toBe(500);
    expect(flat['e.start-to-middle.p.evidence.n']).not.toBe(
      flat['e.middle-to-end.p.evidence.n']
    );
  });
});
