/**
 * Integration (param-pack level): Window/Cohort LAG semantics contracts.
 *
 * IMPORTANT — THIS FILE IS DELIBERATELY OUTCOME-FIRST.
 * ----------------------------------------------------
 * These tests are written from *first principles* / user-visible outcomes and are intended to
 * drive implementation. Do not “fix” these tests by mirroring current code behaviour.
 *
 * Canonical references (treat as spec):
 * - `graph-editor/public/docs/lag-statistics-reference.md`
 * - `docs/current/project-lag/window-cohort-lag-correction-plan.md`
 * - `docs/current/project-lag/window-cohort-lag-open-issues.md`
 *
 * How to read this file:
 * - Phase 1 tests: must pass once Phase 1 semantics are correct.
 * - Phase 2 tests: are marked as RED tests (skipped/todo) because Phase 2 is not implemented yet.
 *   They are written now so Phase 2 work has a clear target.
 *
 * Test surface:
 * sample parameter files → fetch pipeline → graph edge scalars → param pack output.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

import { fetchItem, fetchDataService, createFetchItem, type FetchItem } from '../fetchDataService';
import { extractParamsFromGraph } from '../GraphParamExtractor';
import { flattenParams } from '../ParamPackDSLService';
import { fileRegistry } from '../../contexts/TabContext';
import type { Graph } from '../../types';
import { FORECAST_BLEND_LAMBDA } from '../../constants/statisticalConstants';

function loadTestParameterYaml(id: string): any {
  const paramPath = path.resolve(__dirname, `../../../../param-registry/test/parameters/${id}.yaml`);
  const content = fs.readFileSync(paramPath, 'utf-8');
  return yaml.load(content);
}

async function registerParameterFile(paramId: string, paramData: any): Promise<void> {
  await fileRegistry.registerFile(`parameter-${paramId}`, {
    fileId: `parameter-${paramId}`,
    type: 'parameter',
    data: paramData,
    originalData: structuredClone(paramData),
    isDirty: false,
    isInitializing: false,
    source: { repository: 'test-repo', branch: 'main', isLocal: true } as any,
    viewTabs: [],
    lastModified: Date.now(),
  } as any);
}

function makeSingleEdgeGraph(params: {
  edgeId: string;
  paramId: string;
  latencyEnabled: boolean;
}): Graph {
  const { edgeId, paramId, latencyEnabled } = params;
  return {
    nodes: [
      { id: 'A', uuid: 'A', entry: { is_start: true, entry_weight: 1 } } as any,
      { id: 'B', uuid: 'B' } as any,
    ],
    edges: [
      {
        id: edgeId,
        uuid: edgeId,
        from: 'A',
        to: 'B',
        p: {
          id: paramId,
          connection: 'amplitude-test',
          ...(latencyEnabled ? { latency: { maturity_days: 30, anchor_node_id: 'A' } } : {}),
        },
      } as any,
    ],
  } as any;
}

function makeTwoEdgeGraph(params: {
  paramAX: string;
  paramXY: string;
  edgeAX: string;
  edgeXY: string;
}): Graph {
  const { paramAX, paramXY, edgeAX, edgeXY } = params;
  return {
    nodes: [
      { id: 'A', uuid: 'A', entry: { is_start: true, entry_weight: 1 } } as any,
      { id: 'X', uuid: 'X' } as any,
      { id: 'Y', uuid: 'Y' } as any,
    ],
    edges: [
      {
        id: edgeAX,
        uuid: edgeAX,
        from: 'A',
        to: 'X',
        p: { id: paramAX, connection: 'amplitude-test', latency: { maturity_days: 30, anchor_node_id: 'A' } },
      } as any,
      {
        id: edgeXY,
        uuid: edgeXY,
        from: 'X',
        to: 'Y',
        p: { id: paramXY, connection: 'amplitude-test', latency: { maturity_days: 30, anchor_node_id: 'A' } },
      } as any,
    ],
    currentQueryDSL: 'cohort(A,1-Dec-25:7-Dec-25)',
  } as any;
}

function computeExpectedBlendMean(args: {
  evidenceMean: number;
  forecastMean: number;
  completeness: number;
  nQuery: number;
  nBaseline: number;
}): number {
  const { evidenceMean, forecastMean, completeness, nQuery, nBaseline } = args;
  const nEff = completeness * nQuery;
  const m0 = FORECAST_BLEND_LAMBDA * nBaseline;
  const wEvidence = nEff / (m0 + nEff);
  return wEvidence * evidenceMean + (1 - wEvidence) * forecastMean;
}

describe('Window/Cohort LAG semantics (param-pack integration)', () => {
  beforeAll(() => {
    // Deterministic "as-of now" for cohort ages / completeness.
    // IMPORTANT: Only fake Date. Faking all timers can stall async behaviour in the fetch pipeline.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2025-12-15T12:00:00.000Z'));
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  describe('Window(start:end) semantics: evidence from narrow selection, forecast from baseline window', () => {
    it('PHASE 1 CONTRACT: evidence reflects the requested window subset; forecast stays baseline; completeness is present', async () => {
      const paramId = 'lag-window-baseline-subset';
      await registerParameterFile(paramId, loadTestParameterYaml(paramId));

      let graph: Graph | null = makeSingleEdgeGraph({
        edgeId: 'edge-A-B',
        paramId,
        latencyEnabled: true,
      });
      const setGraph = (g: Graph | null) => { graph = g; };
      const getUpdatedGraph = () => graph;

      const items: FetchItem[] = [
        createFetchItem('parameter', paramId, 'edge-A-B'),
      ];

      // Narrow window subset: last 3 days have 20% conversion in the fixture.
      // CRITICAL: Use fetchItems (not fetchItem) to trigger the LAG topo pass.
      // fetchItem is a low-level primitive that skips LAG; fetchItems runs the full pipeline.
      const dsl = 'window(8-Nov-25:10-Nov-25)';
      const results = await fetchDataService.fetchItems(items, { mode: 'from-file' }, graph as Graph, setGraph, dsl, getUpdatedGraph);
      expect(results.every(r => r.success)).toBe(true);

      const updated = graph as any;
      const edge = updated.edges.find((e: any) => e.id === 'edge-A-B' || e.uuid === 'edge-A-B');
      expect(edge?.p?.evidence?.mean).toBeDefined();
      expect(edge?.p?.forecast?.mean).toBeDefined();
      // RED-IF-FAILING: completeness is a Phase 1 user-visible field in param packs.
      // If this is undefined, it indicates the pipeline is not computing window-mode completeness.
      expect(edge?.p?.latency?.completeness).toBeDefined();

      // Outcome-level expectations (docs):
      // - evidence.mean is Σk/Σn over the *requested* window range (subset of dailies).
      // - forecast.mean is from the baseline window slice and must not drift with the narrow selection.
      expect(edge.p.evidence.mean).toBeCloseTo(0.2, 10);
      expect(edge.p.forecast.mean).toBeCloseTo(0.3, 10);

      // Phase 1: window-mode does NOT overwrite p.mean via the LAG topo pass.
      // p.mean remains the window-aggregated evidence mean.
      expect(edge.p.mean).toBeCloseTo(0.2, 10);

      // Param pack should expose the scenario-visible fields.
      const paramPack = flattenParams(extractParamsFromGraph(graph));
      expect(paramPack['e.edge-A-B.p.mean']).toBeDefined();
      expect(paramPack['e.edge-A-B.p.evidence.mean']).toBeDefined();
      expect(paramPack['e.edge-A-B.p.forecast.mean']).toBeDefined();
      expect(paramPack['e.edge-A-B.p.latency.completeness']).toBeDefined();
    });

    it('changing the narrow selection changes evidence (and p.mean), but forecast stays fixed', async () => {
      const paramId = 'lag-window-baseline-subset';

      let graph: Graph | null = makeSingleEdgeGraph({
        edgeId: 'edge-A-B',
        paramId,
        latencyEnabled: true,
      });
      const setGraph = (g: Graph | null) => { graph = g; };
      const getUpdatedGraph = () => graph;

      const items: FetchItem[] = [
        createFetchItem('parameter', paramId, 'edge-A-B'),
      ];

      // Earlier window subset: first 3 days are 0% conversion in the fixture.
      const dsl = 'window(1-Nov-25:3-Nov-25)';
      const results = await fetchDataService.fetchItems(items, { mode: 'from-file' }, graph as Graph, setGraph, dsl, getUpdatedGraph);
      expect(results.every(r => r.success)).toBe(true);

      const updated = graph as any;
      const edge = updated.edges.find((e: any) => e.id === 'edge-A-B' || e.uuid === 'edge-A-B');

      expect(edge.p.evidence.mean).toBeCloseTo(0.0, 10);
      expect(edge.p.forecast.mean).toBeCloseTo(0.3, 10);

      // Blend should keep p.mean near forecast when evidence is low / incomplete.
      // We only require it to be between evidence and forecast.
      expect(edge.p.mean).toBeGreaterThanOrEqual(0.0);
      expect(edge.p.mean).toBeLessThanOrEqual(0.3);
    });

    it('PHASE 1 CONTRACT: super-window queries treat missing days as gaps (evidence equals base window totals, not diluted)', async () => {
      // Spec: if query window fully contains the stored base window slice,
      // evidence totals should equal the base window totals (missing days are gaps, not zeros).
      const paramId = 'lag-window-baseline-subset';

      let graph: Graph | null = makeSingleEdgeGraph({
        edgeId: 'edge-A-B',
        paramId,
        latencyEnabled: true,
      });
      const setGraph = (g: Graph | null) => { graph = g; };
      const getUpdatedGraph = () => graph;

      const items: FetchItem[] = [
        createFetchItem('parameter', paramId, 'edge-A-B'),
      ];

      // Huge query window that fully contains the stored 1–10 Nov slice.
      const results = await fetchDataService.fetchItems(
        items,
        { mode: 'from-file' },
        graph as Graph,
        setGraph,
        'window(1-Oct-25:30-Nov-25)',
        getUpdatedGraph
      );
      expect(results.every(r => r.success)).toBe(true);

      const edge = (graph as any).edges.find((e: any) => e.id === 'edge-A-B');
      expect(edge.p.evidence.mean).toBeDefined();

      // Base totals are k=60, n=1000 => 0.06
      expect(edge.p.evidence.mean).toBeCloseTo(0.06, 10);
    });
  });

  describe('Window(start:end) semantics: non-latency edges', () => {
    it('PHASE 1 CONTRACT: for non-latency edges, p.mean MUST equal evidence.mean (no LAG blend), but forecast is still attached when available', async () => {
      const paramId = 'lag-nonlatency-window';
      await registerParameterFile(paramId, loadTestParameterYaml(paramId));

      let graph: Graph | null = makeSingleEdgeGraph({
        edgeId: 'edge-A-B',
        paramId,
        latencyEnabled: false,
      });
      const setGraph = (g: Graph | null) => { graph = g; };

      const item: FetchItem = {
        id: `param-${paramId}-p-edge-A-B`,
        type: 'parameter',
        name: `p: ${paramId}`,
        objectId: paramId,
        targetId: 'edge-A-B',
        paramSlot: 'p',
      };

      const result = await fetchItem(item, { mode: 'from-file' }, graph as Graph, setGraph, 'window(1-Nov-25:3-Nov-25)', () => graph);
      expect(result.success).toBe(true);

      const edge = (graph as any).edges.find((e: any) => e.id === 'edge-A-B');
      expect(edge.p.latency).toBeUndefined();
      expect(edge.p.evidence.mean).toBeCloseTo(0.1, 10);
      expect(edge.p.mean).toBeCloseTo(0.1, 10);
      expect(edge.p.forecast.mean).toBeCloseTo(0.4, 10);
    });
  });

  // ============================================================================
  // PHASE 2 RED TESTS (intentionally skipped until Phase 2 work begins)
  // ============================================================================

  describe('PHASE 2 RED TESTS (enable when starting Phase 2)', () => {
    it.skip('PHASE 2: window-mode p.mean becomes the canonical blend (evidence + forecast weighted by completeness)', async () => {
      const paramId = 'lag-window-baseline-subset';
      await registerParameterFile(paramId, loadTestParameterYaml(paramId));

      let graph: Graph | null = makeSingleEdgeGraph({
        edgeId: 'edge-A-B',
        paramId,
        latencyEnabled: true,
      });
      const setGraph = (g: Graph | null) => { graph = g; };
      const getUpdatedGraph = () => graph;

      const items: FetchItem[] = [
        createFetchItem('parameter', paramId, 'edge-A-B'),
      ];

      const dsl = 'window(8-Nov-25:10-Nov-25)';
      const results = await fetchDataService.fetchItems(items, { mode: 'from-file' }, graph as Graph, setGraph, dsl, getUpdatedGraph);
      expect(results.every(r => r.success)).toBe(true);

      const updated = graph as any;
      const edge = updated.edges.find((e: any) => e.id === 'edge-A-B' || e.uuid === 'edge-A-B');
      expect(edge?.p?.evidence?.mean).toBeDefined();
      expect(edge?.p?.forecast?.mean).toBeDefined();
      expect(edge?.p?.latency?.completeness).toBeDefined();

      expect(edge.p.evidence.mean).toBeCloseTo(0.2, 10);
      expect(edge.p.forecast.mean).toBeCloseTo(0.3, 10);

      const c = edge.p.latency.completeness;
      const expected = computeExpectedBlendMean({
        evidenceMean: 0.2,
        forecastMean: 0.3,
        completeness: c,
        nQuery: edge.p.evidence.n,
        nBaseline: 1000, // fixture baseline window n
      });

      // p.mean is stored at standard precision (see UpdateManager rounding); we only
      // require correctness within that precision.
      expect(edge.p.mean).toBeCloseTo(expected, 4);
    });
  });

  describe('Cohort(A,start:end) semantics: completeness must account for upstream A→X delay (soft transition)', () => {
    it('downstream completeness is LOWER with no anchor lag arrays (prior-only) than with anchor lag arrays (observed)', async () => {
      const paramAX = 'lag-cohort-anchor-prior-only';

      // Ensure upstream prior file is present
      await registerParameterFile(paramAX, loadTestParameterYaml(paramAX));

      async function runDownstream(paramXY: string): Promise<number> {
        await registerParameterFile(paramXY, loadTestParameterYaml(paramXY));

        let currentGraph: Graph | null = makeTwoEdgeGraph({
          paramAX,
          paramXY,
          edgeAX: 'edge-A-X',
          edgeXY: 'edge-X-Y',
        });

        const setGraph = (g: Graph | null) => { currentGraph = g; };
        const getUpdatedGraph = () => currentGraph;

        const items: FetchItem[] = [
          createFetchItem('parameter', paramAX, 'edge-A-X'),
          createFetchItem('parameter', paramXY, 'edge-X-Y'),
        ];

        // CRITICAL: run as a batch so the topo/LAG pass can propagate upstream priors
        // into downstream completeness calculations.
        await fetchDataService.fetchItems(
          items,
          { mode: 'from-file' },
          currentGraph as Graph,
          setGraph,
          'cohort(A,1-Dec-25:7-Dec-25)',
          getUpdatedGraph
        );

        const edgeXY = (currentGraph as any).edges.find((e: any) => e.id === 'edge-X-Y');
        expect(edgeXY?.p?.latency?.completeness).toBeDefined();
        expect(edgeXY?.p?.forecast?.mean).toBeCloseTo(0.4, 10);
        return edgeXY.p.latency.completeness as number;
      }

      const completenessPriorOnly = await runDownstream('lag-cohort-downstream-no-anchor');
      const completenessObserved = await runDownstream('lag-cohort-downstream-with-anchor');

      // Outcome expectation (docs/open-issues):
      // With anchor lag coverage, cohort-mode completeness must reflect an upstream delay
      // estimate that is NOT zero. When anchor lag is missing, the prior must still apply.
      //
      // RED-IF-FAILING: If completeness is higher in the prior-only case, it strongly suggests
      // the prior anchor delay is not being applied (i.e. falling back to ~0 days).
      expect(completenessObserved).toBeGreaterThan(completenessPriorOnly);
      expect(completenessObserved).toBeGreaterThan(0.6);
    });
  });

  describe('Phase 2 expectations (t95/path_t95 overrides) — integration TODOs', () => {
    // PHASE 2 RED TESTS:
    // These are intentionally not runnable yet because Phase 2 schema/behaviour is not implemented.
    // When starting Phase 2, convert these to `it(...)` (and delete the `.todo`) so they fail red-to-green.
    it.todo('PHASE 2: enabling latency_edge injects DEFAULT_T95_DAYS when t95 is missing (persists via dirty file)');
    it.todo('PHASE 2: respects t95_overridden (derived t95 must not overwrite overridden values)');
    it.todo('PHASE 2: respects path_t95_overridden (topo-computed path_t95 must not overwrite overridden values)');
  });
});


