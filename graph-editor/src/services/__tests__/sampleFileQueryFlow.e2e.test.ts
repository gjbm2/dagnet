/**
 * E2E Test: Sample File Query Flow
 *
 * Tests the COMPLETE flow from sample parameter files through to param pack output.
 * NO MOCKING - uses real production code throughout.
 * 
 * ============================================================================
 * CURRENT STATUS: TESTS FAILING - REAL BUGS IDENTIFIED IN PRODUCTION PIPELINE
 * ============================================================================
 * 
 * These tests correctly exercise the real pipeline and have identified TWO BUGS:
 * 
 * BUG 1: WRONG SLICE SELECTED
 * ---------------------------
 * When passing DSL like 'cohort(landing-page,1-Sep-25:30-Nov-25)', the pipeline
 * returns the WRONG slice. Test expects mean=0.742 (cohort) but gets 0.689 (window).
 * 
 * Root cause: dataOperationsService.getParameterFromFile is not correctly matching
 * slices by DSL. It appears to be using the last slice or a default, ignoring the
 * targetSlice parameter.
 * 
 * Fix needed in: dataOperationsService.ts - getParameterFromFile() slice matching logic
 * 
 * BUG 2: p.evidence.mean NOT POPULATED ON EDGE
 * --------------------------------------------
 * After fetch, edge.p.evidence.mean is undefined. The param pack therefore doesn't
 * include this field.
 * 
 * Root cause: The pipeline has THREE places that should handle this:
 *   1. dataOperationsService.ts (lines ~1212-1235): DOES compute evidence.mean in
 *      aggregatedValue during window aggregation, BUT this path only runs when
 *      daily data (n_daily, k_daily, dates) is present AND window aggregation applies.
 *   2. UpdateManager.ts (lines 1838-1849): Has mappings for values[latest].evidence.mean
 *      → p.evidence.mean, BUT the condition checks if evidence.mean EXISTS in source.
 *      The sample files don't have evidence.mean pre-computed - it should be computed
 *      at query time from n/k.
 *   3. The fallback path (no daily data / no window aggregation) does NOT compute
 *      evidence.mean at all.
 * 
 * Fix needed: Per lag-fixes.md §4.2, dataOperationsService must ALWAYS compute
 * evidence.mean = k/n and evidence.stdev = sqrt(p*(1-p)/n) from the raw counts
 * before passing to UpdateManager. This computation must happen for ALL code paths,
 * not just window aggregation.
 * 
 * BUG 3: p.forecast.mean NOT POPULATED FOR COHORT QUERIES
 * -------------------------------------------------------
 * The param file stores `forecast` on WINDOW slices only (per design §3.2.1).
 * But the param pack should ALWAYS include p.forecast.mean regardless of query type.
 * 
 * Root cause: When doing a cohort() query, the system doesn't cross-reference the
 * window slice to retrieve forecast. It only looks at the matched cohort slice.
 * 
 * Fix needed: Per design §4.6 (dual-slice retrieval), dataOperationsService must:
 *   1. Match the requested slice (cohort or window)
 *   2. ALSO look up the corresponding window slice to get forecast (p_∞)
 *   3. Merge forecast into the result before passing to UpdateManager
 * 
 * This is the whole point of storing both slice types in the same param file.
 * 
 * ============================================================================
 * 
 * KEY DESIGN SEMANTICS (lag-fixes.md, design.md §4.8):
 * - p.mean = BLENDED probability from Formula A (may include forecasted tail)
 * - p.evidence.mean = RAW observed rate (Σk / Σn from query window)
 * - p.forecast.mean = BASELINE probability from mature cohorts (p_∞)
 * - For MATURE data: p.mean ≈ p.evidence.mean (no forecasting needed)
 * - For IMMATURE data: p.mean > p.evidence.mean (includes forecasted conversions)
 * 
 * PARAM PACK FIELDS (scenario-visible, per design §9.K.1):
 * - p.mean, p.stdev
 * - p.forecast.mean, p.forecast.stdev
 * - p.evidence.mean, p.evidence.stdev
 * - p.latency.completeness, p.latency.t95, p.latency.median_lag_days
 * 
 * NOT IN PARAM PACK (internal/config):
 * - evidence.n, evidence.k, evidence.window_from/to, etc.
 * - latency.maturity_days, latency.anchor_node_id, latency.mean_lag_days
 * - distribution, min, max, alpha, beta
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

// Import real production services - NO MOCKING
import { extractParamsFromGraph } from '../GraphParamExtractor';
import { flattenParams } from '../ParamPackDSLService';
import { fetchItem as fetchSingleItem, type FetchItem } from '../fetchDataService';
import { UpdateManager } from '../UpdateManager';
import { fileRegistry } from '../../contexts/TabContext';
import type { Graph } from '../../types';

// ============================================================================
// TEST DATA: Expected values from sample files
// ============================================================================

// From: param-registry/test/parameters/checkout-to-payment-latency.yaml
const CHECKOUT_TO_PAYMENT_COHORT = {
  sliceDSL: 'cohort(landing-page,1-Sep-25:30-Nov-25)',
  mean: 0.742,
  stdev: 0.025,
  n: 4850,
  k: 3599,
  // p_∞ baseline from window slice (dual-slice retrieval – design.md §4.6)
  forecast: 0.745,
  latency: {
    median_lag_days: 3.0,
    mean_lag_days: 3.5,
    completeness: 0.92,
    t95: 10.2,
  },
};

const CHECKOUT_TO_PAYMENT_WINDOW = {
  sliceDSL: 'window(25-Nov-25:1-Dec-25)',
  mean: 0.689,
  stdev: 0.042,
  n: 385,
  k: 265,
  forecast: 0.745,
  latency: {
    median_lag_days: 3.1,
    t95: 10.5,
  },
};

const CHECKOUT_TO_PAYMENT_CONTEXT_GOOGLE = {
  sliceDSL: 'cohort(landing-page,1-Sep-25:30-Nov-25).context(channel:google)',
  mean: 0.768,
  stdev: 0.031,
  n: 1820,
  k: 1398,
  forecast: 0.772, // p_∞ baseline from mature cohorts
  latency: {
    median_lag_days: 2.9,
    completeness: 0.94,
    t95: 9.8,
  },
};

// ============================================================================
// HELPER: Load sample files
// ============================================================================

function loadSampleGraph(): Graph {
  const graphPath = path.resolve(__dirname, '../../../../param-registry/test/graphs/ecommerce-checkout-flow.json');
  const content = fs.readFileSync(graphPath, 'utf-8');
  return JSON.parse(content) as Graph;
}

function loadSampleParameter(id: string): any {
  const paramPath = path.resolve(__dirname, `../../../../param-registry/test/parameters/${id}.yaml`);
  const content = fs.readFileSync(paramPath, 'utf-8');
  return yaml.load(content);
}

// ============================================================================
// REAL PRODUCTION FLOW: UpdateManager.handleFileToGraph
// ============================================================================

/**
 * Apply parameter file data to graph edge using the REAL UpdateManager.
 * This mimics exactly what dataOperationsService does during window aggregation:
 * 1. Load slice from param file
 * 2. Compute evidence block from n/k (LAG FIX: lag-fixes.md §4.2)
 * 3. Pass through UpdateManager
 * 4. Apply changes to edge
 */
async function applyParameterToEdgeViaUpdateManager(
  graph: Graph,
  edgeId: string,
  paramFileData: any,
  targetSliceDSL: string
): Promise<Graph> {
  // DEPRECATED: This helper previously reimplemented the dataOperationsService/UpdateManager
  // pipeline inside the test. Tests now use fetchDataService + dataOperationsService instead.
  // Keeping this stub to catch any accidental future usage.
  throw new Error(
    `applyParameterToEdgeViaUpdateManager is deprecated. ` +
    `Use fetchDataService.fetchItem(..., { mode: 'from-file' }) to drive the real pipeline.`
  );
}

/**
 * Set a nested value on an object using dot notation path
 */
function setNestedValue(_obj: any, _path: string, _value: any): void {
  // DEPRECATED: Nested field updates are now handled by UpdateManager.applyChanges
  // inside dataOperationsService. This stub exists only to avoid accidental reuse.
  throw new Error('setNestedValue is deprecated in this test file.');
}

// ============================================================================
// TESTS
// ============================================================================

describe('Sample File Query Flow E2E', () => {
  let sampleGraph: Graph;
  let checkoutToPaymentParam: any;
  
  beforeAll(async () => {
    sampleGraph = loadSampleGraph();
    checkoutToPaymentParam = loadSampleParameter('checkout-to-payment-latency');

    // Register parameter file in the real FileRegistry so fetchDataService/dataOperationsService
    // can load it exactly as the app does (no mocks, no synthetic slices).
    await fileRegistry.registerFile('parameter-checkout-to-payment-latency', {
      fileId: 'parameter-checkout-to-payment-latency',
      type: 'parameter',
      data: checkoutToPaymentParam,
      originalData: structuredClone(checkoutToPaymentParam),
      isDirty: false,
      isInitializing: false,
      source: { repository: 'test-repo', branch: 'main', isLocal: true } as any,
      viewTabs: [],
      lastModified: Date.now(),
    } as any);
  });
  
  describe('Cohort Query', () => {
    it('should produce param pack with correct fields from cohort slice', async () => {
      // Fresh graph per test
      let currentGraph: Graph | null = structuredClone(sampleGraph);
      const setGraph = (g: Graph | null) => { currentGraph = g; };

      // Simulate user choosing cohort() DSL over the test window
      const dsl = CHECKOUT_TO_PAYMENT_COHORT.sliceDSL;

      const item: FetchItem = {
        id: 'param-checkout-to-payment-latency-p-checkout-to-payment',
        type: 'parameter',
        name: 'p: checkout-to-payment-latency',
        objectId: 'checkout-to-payment-latency',
        targetId: 'checkout-to-payment',
        paramSlot: 'p',
      };

      const result = await fetchSingleItem(
        item,
        { mode: 'from-file' },
        currentGraph as Graph,
        setGraph,
        dsl,
      );

      expect(result.success).toBe(true);

      // Extract params and flatten to param pack
      const params = extractParamsFromGraph(currentGraph);
      const paramPack = flattenParams(params);
      
      // DEBUG: Log what's actually on the edge after fetch
      const edge = currentGraph?.edges?.find((e: any) => e.id === 'checkout-to-payment');
      console.log('[E2E TEST] After fetch - edge.p:', JSON.stringify(edge?.p, null, 2));
      console.log('[E2E TEST] Param pack keys:', Object.keys(paramPack).filter(k => k.includes('checkout-to-payment')));
      
      // === CORE FIELDS (IN param pack) ===
      // p.mean is the BLENDED probability (from slice, already computed by Formula A)
      expect(paramPack['e.checkout-to-payment.p.mean']).toBe(CHECKOUT_TO_PAYMENT_COHORT.mean);
      expect(paramPack['e.checkout-to-payment.p.stdev']).toBe(CHECKOUT_TO_PAYMENT_COHORT.stdev);
      
      // === EVIDENCE.MEAN (IN param pack - RAW k/n) ===
      // This comes from UpdateManager mapping: values[latest].evidence.mean -> p.evidence.mean
      const expectedEvidenceMean = CHECKOUT_TO_PAYMENT_COHORT.k / CHECKOUT_TO_PAYMENT_COHORT.n;
      expect(paramPack['e.checkout-to-payment.p.evidence.mean']).toBeCloseTo(expectedEvidenceMean, 3);
      
      // === EVIDENCE.STDEV (IN param pack - binomial uncertainty) ===
      const expectedEvidenceStdev = Math.sqrt((expectedEvidenceMean * (1 - expectedEvidenceMean)) / CHECKOUT_TO_PAYMENT_COHORT.n);
      expect(paramPack['e.checkout-to-payment.p.evidence.stdev']).toBeCloseTo(expectedEvidenceStdev, 4);
      
      // === FORECAST (IN param pack - p_∞ baseline) ===
      expect(paramPack['e.checkout-to-payment.p.forecast.mean']).toBe(CHECKOUT_TO_PAYMENT_COHORT.forecast);
      
      // === LATENCY (IN param pack - only these 3 fields) ===
      expect(paramPack['e.checkout-to-payment.p.latency.median_lag_days']).toBe(CHECKOUT_TO_PAYMENT_COHORT.latency.median_lag_days);
      expect(paramPack['e.checkout-to-payment.p.latency.completeness']).toBe(CHECKOUT_TO_PAYMENT_COHORT.latency.completeness);
      expect(paramPack['e.checkout-to-payment.p.latency.t95']).toBe(CHECKOUT_TO_PAYMENT_COHORT.latency.t95);
      
      // === NOT IN PARAM PACK (should be undefined) ===
      expect(paramPack['e.checkout-to-payment.p.evidence.n']).toBeUndefined();
      expect(paramPack['e.checkout-to-payment.p.evidence.k']).toBeUndefined();
      expect(paramPack['e.checkout-to-payment.p.latency.maturity_days']).toBeUndefined();
      expect(paramPack['e.checkout-to-payment.p.latency.anchor_node_id']).toBeUndefined();
      expect(paramPack['e.checkout-to-payment.p.latency.mean_lag_days']).toBeUndefined();
      
      // === MATHEMATICAL VERIFICATION ===
      // For this MATURE cohort (completeness=0.92), blended p.mean should be close to evidence
      expect(Math.abs(expectedEvidenceMean - CHECKOUT_TO_PAYMENT_COHORT.mean)).toBeLessThan(0.01);
    });

    it('should fail cleanly for a cohort() window completely outside sample coverage (\"today\"-like)', async () => {
      // Fresh graph per test
      let currentGraph: Graph | null = structuredClone(sampleGraph);
      const setGraph = (g: Graph | null) => { currentGraph = g; };

      // Simulate a "today" cohort() selection well beyond the stored sample coverage.
      // Sample cohorts run 1-Sep-25 → 30-Nov-25; this date is safely outside.
      const dsl = 'cohort(9-Dec-25:9-Dec-25)';

      const item: FetchItem = {
        id: 'param-checkout-to-payment-latency-p-checkout-to-payment',
        type: 'parameter',
        name: 'p: checkout-to-payment-latency',
        objectId: 'checkout-to-payment-latency',
        targetId: 'checkout-to-payment',
        paramSlot: 'p',
      };

      const result = await fetchSingleItem(
        item,
        { mode: 'from-file' },
        currentGraph as Graph,
        setGraph,
        dsl,
      );

      // There is genuinely no cached data for this cohort window in the sample files,
      // so the real pipeline MUST report a failure, not silently succeed.
      expect(result.success).toBe(false);
      expect(result.error).toBeInstanceOf(Error);
    });

    it('should slice cohort evidence correctly for a narrower cohort() window', async () => {
      // Use a narrower cohort window fully inside the stored slice:
      // cohort(landing-page,1-Oct-25:15-Oct-25)
      // From checkout-to-payment-latency.yaml cohort slice (base, uncontexted):
      //
      // dates:
      //   1-Sep-25, 2-Sep-25, 3-Sep-25, 10-Sep-25, 20-Sep-25,
      //   1-Oct-25, 15-Oct-25, 1-Nov-25, 15-Nov-25, 20-Nov-25,
      //   25-Nov-25, 28-Nov-25, 30-Nov-25
      //
      // n_daily: [52, 48, 55, 61, 58, 54, 62, 57, 53, 49, 51, 47, 45]
      // k_daily: [39, 36, 41, 46, 44, 41, 47, 43, 39, 35, 32, 22, 12]
      //
      // Narrower cohort window 1-Oct-25:15-Oct-25 picks indices 5 and 6:
      // n = 54 + 62 = 116
      // k = 41 + 47 = 88
      // p_evidence = 88 / 116 ≈ 0.7586

      let currentGraph: Graph | null = structuredClone(sampleGraph);
      const setGraph = (g: Graph | null) => { currentGraph = g; };

      const dsl = 'cohort(landing-page,1-Oct-25:15-Oct-25)';

      const item: FetchItem = {
        id: 'param-checkout-to-payment-latency-p-checkout-to-payment',
        type: 'parameter',
        name: 'p: checkout-to-payment-latency',
        objectId: 'checkout-to-payment-latency',
        targetId: 'checkout-to-payment',
        paramSlot: 'p',
      };

      const result = await fetchSingleItem(
        item,
        { mode: 'from-file' },
        currentGraph as Graph,
        setGraph,
        dsl,
      );

      expect(result.success).toBe(true);

      const params = extractParamsFromGraph(currentGraph);
      const paramPack = flattenParams(params);

      const expectedN = 54 + 62;
      const expectedK = 41 + 47;
      const expectedEvidenceMean = expectedK / expectedN;
      const expectedEvidenceStdev = Math.sqrt((expectedEvidenceMean * (1 - expectedEvidenceMean)) / expectedN);

      // DEBUG: log actual evidence fields for inspection
      console.log('[E2E TEST] Narrow window evidence:', {
        actualMean: paramPack['e.checkout-to-payment.p.evidence.mean'],
        actualStdev: paramPack['e.checkout-to-payment.p.evidence.stdev'],
        expectedMean: expectedEvidenceMean,
        expectedStdev: expectedEvidenceStdev,
      });

      expect(paramPack['e.checkout-to-payment.p.evidence.mean']).toBeCloseTo(expectedEvidenceMean, 3);
      expect(paramPack['e.checkout-to-payment.p.evidence.stdev']).toBeCloseTo(expectedEvidenceStdev, 4);
    });
  });
  
  describe('Window Query', () => {
    it('should produce param pack with correct fields from window slice', async () => {
      let currentGraph: Graph | null = structuredClone(sampleGraph);
      const setGraph = (g: Graph | null) => { currentGraph = g; };

      // Simulate user choosing window() DSL over the test window
      const dsl = CHECKOUT_TO_PAYMENT_WINDOW.sliceDSL;

      const item: FetchItem = {
        id: 'param-checkout-to-payment-latency-p-checkout-to-payment',
        type: 'parameter',
        name: 'p: checkout-to-payment-latency',
        objectId: 'checkout-to-payment-latency',
        targetId: 'checkout-to-payment',
        paramSlot: 'p',
      };

      const result = await fetchSingleItem(
        item,
        { mode: 'from-file' },
        currentGraph as Graph,
        setGraph,
        dsl,
      );

      expect(result.success).toBe(true);

      // Extract params and flatten to param pack
      const params = extractParamsFromGraph(currentGraph);
      const paramPack = flattenParams(params);
      
      // === CORE FIELDS (IN param pack) ===
      expect(paramPack['e.checkout-to-payment.p.mean']).toBe(CHECKOUT_TO_PAYMENT_WINDOW.mean);
      expect(paramPack['e.checkout-to-payment.p.stdev']).toBe(CHECKOUT_TO_PAYMENT_WINDOW.stdev);
      
      // === EVIDENCE.MEAN (IN param pack - RAW k/n) ===
      const expectedEvidenceMean = CHECKOUT_TO_PAYMENT_WINDOW.k / CHECKOUT_TO_PAYMENT_WINDOW.n;
      expect(paramPack['e.checkout-to-payment.p.evidence.mean']).toBeCloseTo(expectedEvidenceMean, 3);
      
      // === EVIDENCE.STDEV (IN param pack - binomial uncertainty) ===
      const expectedEvidenceStdev = Math.sqrt((expectedEvidenceMean * (1 - expectedEvidenceMean)) / CHECKOUT_TO_PAYMENT_WINDOW.n);
      expect(paramPack['e.checkout-to-payment.p.evidence.stdev']).toBeCloseTo(expectedEvidenceStdev, 4);
      
      // === FORECAST (IN param pack) ===
      expect(paramPack['e.checkout-to-payment.p.forecast.mean']).toBe(CHECKOUT_TO_PAYMENT_WINDOW.forecast);
      
      // === LATENCY (IN param pack) ===
      expect(paramPack['e.checkout-to-payment.p.latency.median_lag_days']).toBe(CHECKOUT_TO_PAYMENT_WINDOW.latency.median_lag_days);
      expect(paramPack['e.checkout-to-payment.p.latency.t95']).toBe(CHECKOUT_TO_PAYMENT_WINDOW.latency.t95);
      
      // === NOT IN PARAM PACK ===
      expect(paramPack['e.checkout-to-payment.p.evidence.n']).toBeUndefined();
      expect(paramPack['e.checkout-to-payment.p.evidence.k']).toBeUndefined();
      
      // === MATHEMATICAL VERIFICATION ===
      // For window data, evidence (k/n = 265/385 = 0.688) should be close to blended mean (0.689)
      expect(Math.abs(expectedEvidenceMean - CHECKOUT_TO_PAYMENT_WINDOW.mean)).toBeLessThan(0.01);
    });

    it('should aggregate correctly for a narrower window inside the stored slice', async () => {
      let currentGraph: Graph | null = structuredClone(sampleGraph);
      const setGraph = (g: Graph | null) => { currentGraph = g; };

      // Narrower window fully inside stored window slice (26–30 Nov)
      const dsl = 'window(26-Nov-25:30-Nov-25)';

      const item: FetchItem = {
        id: 'param-checkout-to-payment-latency-p-checkout-to-payment',
        type: 'parameter',
        name: 'p: checkout-to-payment-latency',
        objectId: 'checkout-to-payment-latency',
        targetId: 'checkout-to-payment',
        paramSlot: 'p',
      };

      const result = await fetchSingleItem(
        item,
        { mode: 'from-file' },
        currentGraph as Graph,
        setGraph,
        dsl,
      );

      expect(result.success).toBe(true);

      const params = extractParamsFromGraph(currentGraph);
      const paramPack = flattenParams(params);

      // Daily data from window slice (see checkout-to-payment-latency.yaml):
      // dates: 25–Nov → 1–Dec
      // n_daily: [51, 58, 62, 55, 49, 54, 56]
      // k_daily: [32, 38, 42, 36, 28, 35, 34]
      //
      // Narrower window 26–30 Nov uses indices 1–5:
      // n = 58 + 62 + 55 + 49 + 54 = 278
      // k = 38 + 42 + 36 + 28 + 35 = 179
      const expectedN = 278;
      const expectedK = 179;
      const expectedEvidenceMean = expectedK / expectedN;
      const expectedEvidenceStdev = Math.sqrt((expectedEvidenceMean * (1 - expectedEvidenceMean)) / expectedN);

      expect(paramPack['e.checkout-to-payment.p.evidence.mean']).toBeCloseTo(expectedEvidenceMean, 3);
      expect(paramPack['e.checkout-to-payment.p.evidence.stdev']).toBeCloseTo(expectedEvidenceStdev, 4);
    });

    it('should aggregate correctly when window extends beyond stored slice dates', async () => {
      let currentGraph: Graph | null = structuredClone(sampleGraph);
      const setGraph = (g: Graph | null) => { currentGraph = g; };

      // Wider window that extends one day before and after stored slice
      const dsl = 'window(24-Nov-25:2-Dec-25)';

      const item: FetchItem = {
        id: 'param-checkout-to-payment-latency-p-checkout-to-payment',
        type: 'parameter',
        name: 'p: checkout-to-payment-latency',
        objectId: 'checkout-to-payment-latency',
        targetId: 'checkout-to-payment',
        paramSlot: 'p',
      };

      const result = await fetchSingleItem(
        item,
        { mode: 'from-file' },
        currentGraph as Graph,
        setGraph,
        dsl,
      );

      expect(result.success).toBe(true);

      const params = extractParamsFromGraph(currentGraph);
      const paramPack = flattenParams(params);

      // Even though the requested window is wider, only dates with data
      // (25-Nov-25 → 1-Dec-25) should contribute to evidence.
      const expectedEvidenceMean = CHECKOUT_TO_PAYMENT_WINDOW.k / CHECKOUT_TO_PAYMENT_WINDOW.n; // 265 / 385
      const expectedEvidenceStdev = Math.sqrt((expectedEvidenceMean * (1 - expectedEvidenceMean)) / CHECKOUT_TO_PAYMENT_WINDOW.n);

      expect(paramPack['e.checkout-to-payment.p.evidence.mean']).toBeCloseTo(expectedEvidenceMean, 3);
      expect(paramPack['e.checkout-to-payment.p.evidence.stdev']).toBeCloseTo(expectedEvidenceStdev, 4);
    });
  });
  
  describe('Context Query', () => {
    it('should produce param pack with correct fields from context-filtered slice', async () => {
      let currentGraph: Graph | null = structuredClone(sampleGraph);
      const setGraph = (g: Graph | null) => { currentGraph = g; };

      // Simulate user choosing cohort() + context() DSL
      const dsl = CHECKOUT_TO_PAYMENT_CONTEXT_GOOGLE.sliceDSL;

      const item: FetchItem = {
        id: 'param-checkout-to-payment-latency-p-checkout-to-payment',
        type: 'parameter',
        name: 'p: checkout-to-payment-latency',
        objectId: 'checkout-to-payment-latency',
        targetId: 'checkout-to-payment',
        paramSlot: 'p',
      };

      const result = await fetchSingleItem(
        item,
        { mode: 'from-file' },
        currentGraph as Graph,
        setGraph,
        dsl,
      );

      expect(result.success).toBe(true);

      // Extract params and flatten to param pack
      const params = extractParamsFromGraph(currentGraph);
      const paramPack = flattenParams(params);
      
      // === CORE FIELDS (IN param pack) ===
      expect(paramPack['e.checkout-to-payment.p.mean']).toBe(CHECKOUT_TO_PAYMENT_CONTEXT_GOOGLE.mean);
      expect(paramPack['e.checkout-to-payment.p.stdev']).toBe(CHECKOUT_TO_PAYMENT_CONTEXT_GOOGLE.stdev);
      
      // === EVIDENCE.MEAN (IN param pack - RAW k/n) ===
      const expectedEvidenceMean = CHECKOUT_TO_PAYMENT_CONTEXT_GOOGLE.k / CHECKOUT_TO_PAYMENT_CONTEXT_GOOGLE.n;
      expect(paramPack['e.checkout-to-payment.p.evidence.mean']).toBeCloseTo(expectedEvidenceMean, 3);
      
      // === EVIDENCE.STDEV (IN param pack - binomial uncertainty) ===
      const expectedEvidenceStdev = Math.sqrt((expectedEvidenceMean * (1 - expectedEvidenceMean)) / CHECKOUT_TO_PAYMENT_CONTEXT_GOOGLE.n);
      expect(paramPack['e.checkout-to-payment.p.evidence.stdev']).toBeCloseTo(expectedEvidenceStdev, 4);
      
      // === FORECAST (IN param pack - p_∞ baseline) ===
      expect(paramPack['e.checkout-to-payment.p.forecast.mean']).toBe(CHECKOUT_TO_PAYMENT_CONTEXT_GOOGLE.forecast);
      
      // === LATENCY (IN param pack) ===
      expect(paramPack['e.checkout-to-payment.p.latency.median_lag_days']).toBe(CHECKOUT_TO_PAYMENT_CONTEXT_GOOGLE.latency.median_lag_days);
      expect(paramPack['e.checkout-to-payment.p.latency.completeness']).toBe(CHECKOUT_TO_PAYMENT_CONTEXT_GOOGLE.latency.completeness);
      expect(paramPack['e.checkout-to-payment.p.latency.t95']).toBe(CHECKOUT_TO_PAYMENT_CONTEXT_GOOGLE.latency.t95);
      
      // === NOT IN PARAM PACK ===
      expect(paramPack['e.checkout-to-payment.p.evidence.n']).toBeUndefined();
      expect(paramPack['e.checkout-to-payment.p.evidence.k']).toBeUndefined();
      
      // === MATHEMATICAL VERIFICATION ===
      // For context-filtered data (completeness=0.94), evidence should be close to blended
      expect(Math.abs(expectedEvidenceMean - CHECKOUT_TO_PAYMENT_CONTEXT_GOOGLE.mean)).toBeLessThan(0.01);
    });
  });
  
  describe('Param Pack Key Format', () => {
    it('should use correct HRN key format and only include scenario-visible fields', async () => {
      let currentGraph: Graph | null = structuredClone(sampleGraph);
      const setGraph = (g: Graph | null) => { currentGraph = g; };

      const dsl = CHECKOUT_TO_PAYMENT_COHORT.sliceDSL;

      const item: FetchItem = {
        id: 'param-checkout-to-payment-latency-p-checkout-to-payment',
        type: 'parameter',
        name: 'p: checkout-to-payment-latency',
        objectId: 'checkout-to-payment-latency',
        targetId: 'checkout-to-payment',
        paramSlot: 'p',
      };

      const result = await fetchSingleItem(
        item,
        { mode: 'from-file' },
        currentGraph as Graph,
        setGraph,
        dsl,
      );

      expect(result.success).toBe(true);

      const params = extractParamsFromGraph(currentGraph);
      const paramPack = flattenParams(params);
      
      // All keys should start with 'e.' for edge params
      const edgeKeys = Object.keys(paramPack).filter(k => k.startsWith('e.'));
      expect(edgeKeys.length).toBeGreaterThan(0);
      
      // Verify scenario-visible fields ARE present (per lag-fixes.md §3.3)
      // CORE: p.mean/stdev (blended probability)
      expect(paramPack).toHaveProperty('e.checkout-to-payment.p.mean');
      expect(paramPack).toHaveProperty('e.checkout-to-payment.p.stdev');
      // EVIDENCE: computed at query time from n/k
      expect(paramPack).toHaveProperty('e.checkout-to-payment.p.evidence.mean');
      expect(paramPack).toHaveProperty('e.checkout-to-payment.p.evidence.stdev');
      // FORECAST: p_∞ baseline from mature cohorts
      expect(paramPack).toHaveProperty('e.checkout-to-payment.p.forecast.mean');
      // LATENCY: completeness, t95, median_lag_days
      expect(paramPack).toHaveProperty('e.checkout-to-payment.p.latency.median_lag_days');
      expect(paramPack).toHaveProperty('e.checkout-to-payment.p.latency.completeness');
      expect(paramPack).toHaveProperty('e.checkout-to-payment.p.latency.t95');
      
      // Verify internal fields are NOT present
      expect(paramPack).not.toHaveProperty('e.checkout-to-payment.p.evidence.n');
      expect(paramPack).not.toHaveProperty('e.checkout-to-payment.p.evidence.k');
      expect(paramPack).not.toHaveProperty('e.checkout-to-payment.p.evidence.window_from');
      expect(paramPack).not.toHaveProperty('e.checkout-to-payment.p.latency.maturity_days');
      expect(paramPack).not.toHaveProperty('e.checkout-to-payment.p.latency.anchor_node_id');
      expect(paramPack).not.toHaveProperty('e.checkout-to-payment.p.distribution');
    });
  });
});
