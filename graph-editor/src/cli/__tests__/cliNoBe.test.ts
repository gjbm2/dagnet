/**
 * Doc 73e §8.3 Stage 6 — blind tests for `--no-be` (`skipBackendCalls`).
 *
 * Three cases that must fail against current code (before the runtime gate
 * is wired):
 *
 *   (a) `param-pack`-shape aggregation with `skipBackendCalls=true` must
 *       not dispatch any fetch to the BE host, must leave `cf_mode`
 *       absent on output edges, and `p.mean` must match FE-topo Step 2
 *       (evidence k/n) rather than the post-CF authoritative value.
 *
 *   (b) `analyse --type conditioned_forecast` with `skipBackendCalls=true`
 *       must surface a typed error from `runPreparedAnalysis` naming the
 *       analysis type and that BE compute is required, and must not
 *       dispatch any fetch.
 *
 *   (c) Any runner-analyze type (e.g. `cohort_maturity_v3`) with
 *       `skipBackendCalls=true` must surface the same typed error.
 *
 * Tests are run against the stable disk fixture used by the other CLI
 * test files (3 nodes, 2 edges, hand-computable values).
 *
 * @vitest-environment node
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { join } from 'path';

const fetchSpy = vi.fn();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(global as any).fetch = fetchSpy;

import { loadGraphFromDisk, seedFileRegistry, type GraphBundle } from '../diskLoader';
import { aggregateAndPopulateGraph } from '../aggregate';
import { injectBeSkippedMeta } from '../commands/paramPack';
import {
  prepareAnalysisComputeInputs,
  runPreparedAnalysis,
  type PreparedAnalysisComputeReady,
} from '../../services/analysisComputePreparationService';

const FIXTURES_DIR = join(__dirname, 'fixtures');

// Any URL pointing at the Python BE counts as a BE call. The fixture
// graph has no external connections configured, so cache-only fetches
// stay in-process. Anything that lands on `/api/...` came from CF, the
// snapshot service, or runner-analyze.
const isBeCall = (url: string): boolean =>
  url.includes('/api/forecast/conditioned')
  || url.includes('/api/runner/analyze')
  || url.includes('/api/snapshot')
  || url.includes('/api/');

beforeEach(() => {
  fetchSpy.mockReset();
  fetchSpy.mockResolvedValue(
    new Response(
      JSON.stringify({ success: true, result: {} }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  );
});

describe('Doc 73e §8.3 Stage 6 — --no-be (skipBackendCalls)', () => {
  let bundle: GraphBundle;

  beforeAll(async () => {
    bundle = await loadGraphFromDisk(FIXTURES_DIR, 'test-fixture');
    seedFileRegistry(bundle);
  });

  it('(a) param-pack: aggregateAndPopulateGraph with skipBackendCalls=true does not dispatch any BE call, leaves cf_mode absent, p.mean = FE-topo provisional', async () => {
    const { graph } = await aggregateAndPopulateGraph(
      bundle,
      'window(1-Jan-26:10-Jan-26)',
      { skipBackendCalls: true },
    );

    const beCalls = fetchSpy.mock.calls.filter(([url]) => isBeCall(String(url)));
    expect(beCalls).toEqual([]);

    for (const edge of (graph.edges || []) as Array<{ p?: Record<string, unknown> }>) {
      expect(edge.p?.cf_mode).toBeUndefined();
      expect(edge.p?.cf_reason).toBeUndefined();
    }

    // FE-topo Step 2 provisional p.mean = evidence.k / evidence.n.
    // start-to-middle: 400 / 1000 = 0.4 (per fixture's hand-computable
    // values). With CF suppressed, FE-topo's value stands; with CF on
    // the gate ignored, CF would overwrite p.mean post-fact.
    type EdgeShape = {
      uuid?: string;
      id?: string;
      p?: { mean?: number };
    };
    const edges = (graph.edges as EdgeShape[] | undefined) || [];
    const e1 = edges.find((e) =>
      (e.uuid === 'start-to-middle') || (e.id === 'start-to-middle'),
    );
    expect(e1?.p?.mean).toBeCloseTo(0.4, 6);
  });

  it('(b) analyse --type conditioned_forecast with skipBackendCalls=true: throws typed error, no BE call', async () => {
    const { graph } = await aggregateAndPopulateGraph(
      bundle,
      'window(1-Jan-26:10-Jan-26)',
      { skipBackendCalls: true },
    );

    fetchSpy.mockClear();

    const prepared = await prepareAnalysisComputeInputs({
      mode: 'custom',
      graph: bundle.graph,
      analysisType: 'conditioned_forecast',
      analyticsDsl: '',
      currentDSL: '',
      needsSnapshots: true,
      workspace: { repository: 'cli', branch: 'local' },
      skipBackendCalls: true,
      customScenarios: [{
        scenario_id: 'sc-1',
        name: 'Scenario 1',
        colour: '#3b82f6',
        visibility_mode: 'f+e',
        graph,
        effective_dsl: 'window(1-Jan-26:10-Jan-26)',
      }],
      hiddenScenarioIds: [],
      frozenWhatIfDsl: null,
      resolveParameterFile: (id: string) => bundle.parameters.get(id),
    });

    if (prepared.status !== 'ready') {
      throw new Error(`prepare unexpectedly blocked: ${(prepared as { reason?: string }).reason}`);
    }
    expect((prepared as PreparedAnalysisComputeReady).skipBackendCalls).toBe(true);

    let caught: unknown;
    try {
      await runPreparedAnalysis(prepared);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    const msg = String((caught as { message?: string })?.message ?? caught);
    expect(msg).toContain('conditioned_forecast');
    expect(msg).toContain('requires BE compute');

    const beCalls = fetchSpy.mock.calls.filter(([url]) => isBeCall(String(url)));
    expect(beCalls).toEqual([]);
  });

  it('(c) analyse --type cohort_maturity_v3 with skipBackendCalls=true: throws typed error, no BE call', async () => {
    const { graph } = await aggregateAndPopulateGraph(
      bundle,
      'window(1-Jan-26:10-Jan-26)',
      { skipBackendCalls: true },
    );

    fetchSpy.mockClear();

    const prepared = await prepareAnalysisComputeInputs({
      mode: 'custom',
      graph: bundle.graph,
      analysisType: 'cohort_maturity_v3',
      analyticsDsl: '',
      currentDSL: '',
      needsSnapshots: true,
      workspace: { repository: 'cli', branch: 'local' },
      skipBackendCalls: true,
      customScenarios: [{
        scenario_id: 'sc-1',
        name: 'Scenario 1',
        colour: '#3b82f6',
        visibility_mode: 'f+e',
        graph,
        effective_dsl: 'window(1-Jan-26:10-Jan-26)',
      }],
      hiddenScenarioIds: [],
      frozenWhatIfDsl: null,
      resolveParameterFile: (id: string) => bundle.parameters.get(id),
    });

    if (prepared.status !== 'ready') {
      throw new Error(`prepare unexpectedly blocked: ${(prepared as { reason?: string }).reason}`);
    }

    let caught: unknown;
    try {
      await runPreparedAnalysis(prepared);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    const msg = String((caught as { message?: string })?.message ?? caught);
    expect(msg).toContain('cohort_maturity_v3');
    expect(msg).toContain('requires BE compute');

    const beCalls = fetchSpy.mock.calls.filter(([url]) => isBeCall(String(url)));
    expect(beCalls).toEqual([]);
  });
});

describe('Doc 73e §8.3 Stage 6 — param-pack be_skipped metadata', () => {
  it('injects meta.be_skipped at the top of YAML output', () => {
    const yaml = 'e.edge-1.p.mean: 0.4\ne.edge-1.p.evidence.n: 1000\n';
    const out = injectBeSkippedMeta(yaml, 'yaml');
    expect(out.startsWith('meta.be_skipped: true\n')).toBe(true);
    expect(out).toContain('e.edge-1.p.mean: 0.4');
  });

  it('injects meta.be_skipped at the top of JSON output (after the opening brace)', () => {
    const json = JSON.stringify({ 'e.edge-1.p.mean': 0.4 }, null, 2);
    const out = injectBeSkippedMeta(json, 'json');
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed['meta.be_skipped']).toBe(true);
    // Insertion order: meta key first (preserved by object spread).
    expect(Object.keys(parsed)[0]).toBe('meta.be_skipped');
  });

  it('injects meta.be_skipped after the CSV header row', () => {
    const csv = 'key,value\ne.edge-1.p.mean,0.4\n';
    const out = injectBeSkippedMeta(csv, 'csv');
    const lines = out.split('\n');
    expect(lines[0]).toBe('key,value');
    expect(lines[1]).toBe('meta.be_skipped,true');
    expect(lines[2]).toBe('e.edge-1.p.mean,0.4');
  });
});
