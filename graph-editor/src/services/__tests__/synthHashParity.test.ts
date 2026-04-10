/**
 * Hash parity test: verify the FULL FE runtime hash computation chain
 * matches what Python wrote to the param files and snapshot DB.
 *
 * Uses computeCurrentSignatureForEdge — the ACTUAL runtime function
 * that the FE calls when querying snapshots. This catches divergences
 * that a direct computeQuerySignature call would miss (connection
 * name resolution, buildDslFromEdge payload construction, etc.).
 *
 * Run with:
 *   cd graph-editor && npm test -- --run src/services/__tests__/synthHashParity.test.ts
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { computeShortCoreHash } from '../coreHashService';
import { computeQuerySignature } from '../dataOperations/querySignature';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const PRIVATE_REPOS_CONF = path.join(REPO_ROOT, '.private-repos.conf');
const DATA_REPO_DIR = (() => {
  const conf = fs.readFileSync(PRIVATE_REPOS_CONF, 'utf-8');
  const match = conf.match(/DATA_REPO_DIR=(.+)/);
  return match ? path.join(REPO_ROOT, match[1].trim()) : '';
})();

const GRAPH_PATH = path.join(DATA_REPO_DIR, 'graphs', 'synth-diamond-test.json');
const EVENTS_DIR = path.join(DATA_REPO_DIR, 'events');
const PARAMS_DIR = path.join(DATA_REPO_DIR, 'parameters');

function loadGraph() {
  if (!fs.existsSync(GRAPH_PATH)) return null;
  return JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf-8'));
}

function loadEventDef(eventId: string): any {
  const p = path.join(EVENTS_DIR, `${eventId}.yaml`);
  if (!fs.existsSync(p)) return null;
  return yaml.parse(fs.readFileSync(p, 'utf-8'));
}

function loadParamFile(paramId: string): any {
  const p = path.join(PARAMS_DIR, `${paramId}.yaml`);
  if (!fs.existsSync(p)) return null;
  return yaml.parse(fs.readFileSync(p, 'utf-8'));
}

// Mock fileRegistry so computeCurrentSignatureForEdge can resolve
// param files and event files without a real browser environment.
const mockFiles = new Map<string, any>();

vi.mock('../../contexts/TabContext', () => ({
  fileRegistry: {
    getFile: (fileId: string) => mockFiles.get(fileId) || null,
  },
}));

// Mock IDB (used as fallback for event loading)
vi.mock('../../db', () => ({
  default: {
    files: {
      get: async (fileId: string) => mockFiles.get(fileId) || null,
    },
  },
}));

describe('Synth Diamond Hash Parity — Full Runtime Chain', () => {
  const graph = loadGraph();
  if (!graph) {
    it.skip('Diamond graph not found in data repo', () => {});
    return;
  }

  const eventedEdges = graph.edges.filter((e: any) => e.p?.id);

  beforeAll(() => {
    // Populate mock fileRegistry with event and param files
    for (const node of graph.nodes) {
      const eventId = node.event_id;
      if (!eventId) continue;
      const eventData = loadEventDef(eventId);
      if (eventData) {
        mockFiles.set(`event-${eventId}`, {
          data: eventData,
          source: { repository: 'nous-conversion', branch: 'feature/bayes-test-graph' },
        });
      }
    }
    for (const edge of eventedEdges) {
      const paramId = edge.p.id;
      const paramData = loadParamFile(paramId);
      if (paramData) {
        mockFiles.set(`parameter-${paramId}`, {
          data: paramData,
          source: { repository: 'nous-conversion', branch: 'feature/bayes-test-graph' },
        });
      }
    }
  });

  // ─── Graph structure checks ───

  it('should have dataInterestsDSL set', () => {
    expect(graph.dataInterestsDSL).toBeTruthy();
    expect(graph.dataInterestsDSL).toMatch(/^window\(/);
  });

  it('should have simulation guard set', () => {
    expect(graph.simulation).toBe(true);
    expect(graph.dailyFetch).toBe(false);
  });

  it('should have top-level query on all evented edges', () => {
    for (const edge of eventedEdges) {
      expect(edge.query).toBeTruthy();
      expect(edge.query).toMatch(/^from\(.+\)\.to\(.+\)$/);
    }
  });

  // ─── Per-edge: full runtime hash parity ───

  for (const edge of eventedEdges) {
    const paramId = edge.p.id;

    it(`[${paramId}] runtime computeCurrentSignatureForEdge matches Python param file`, async () => {
      // Import the ACTUAL runtime function
      const { computeCurrentSignatureForEdge } = await import('../snapshotRetrievalsService');

      // Use ONLY the window clause from dataInterestsDSL (the FE resolves
      // scenarios to individual window or cohort DSLs, never the compound)
      const windowDsl = (graph.dataInterestsDSL || '').split(';')
        .map((s: string) => s.trim())
        .find((s: string) => s.startsWith('window(')) || 'window(-100d:)';

      const result = await computeCurrentSignatureForEdge({
        graph,
        edgeId: edge.uuid,
        effectiveDSL: windowDsl,
        workspace: { repository: 'nous-conversion', branch: 'feature/bayes-test-graph' },
      });

      expect(result).not.toBeNull();
      if (!result) return;

      const { signature, identityHash, dbParamId } = result;

      // The signature should be a valid structured sig
      expect(signature).toMatch(/^\{"c":"/);

      // Compute the short hash
      const feShortHash = await computeShortCoreHash(signature);
      expect(feShortHash.length).toBeGreaterThanOrEqual(20);

      // Load Python's query_signature from param file
      const paramData = loadParamFile(paramId);
      expect(paramData).not.toBeNull();
      const pythonSig = paramData.values?.[0]?.query_signature;
      expect(pythonSig).toBeTruthy();

      const pythonShortHash = await computeShortCoreHash(pythonSig);

      // THE DEFINITIVE PARITY CHECK
      // If this fails, the FE runtime computes a different hash than
      // what Python wrote — snapshots won't be found.
      // Capture FE coreCanonical for diff analysis
      const feCoreCanonical = (computeQuerySignature as any).__lastCoreCanonical || '';
      fs.writeFileSync(`/tmp/fe-canonical-${paramId}.json`, feCoreCanonical);
      expect(feShortHash).toBe(pythonShortHash);

      // Verify dbParamId is workspace-prefixed
      expect(dbParamId).toBe(`nous-conversion-feature/bayes-test-graph-${paramId}`);
    });

    it(`[${paramId}] param file has window + cohort values[] entries with required fields`, () => {
      const paramData = loadParamFile(paramId);
      expect(paramData?.values?.length).toBeGreaterThanOrEqual(2);

      // Window entry
      const w = paramData.values[0];
      expect(w.sliceDSL).toMatch(/^window\(/);
      expect(w.window_from).toBeTruthy();
      expect(w.window_to).toBeTruthy();
      expect(w.query_signature).toBeTruthy();
      expect(w.n).toBeGreaterThan(0);
      expect(w.k).toBeLessThanOrEqual(w.n);
      expect(w.mean).toBeGreaterThan(0);
      expect(w.mean).toBeLessThanOrEqual(1);
      expect(w.n_daily.length).toBe(w.dates.length);
      for (let i = 0; i < w.n_daily.length; i++) {
        expect(w.k_daily[i]).toBeLessThanOrEqual(w.n_daily[i]);
      }

      // Cohort entry (required for cohort_maturity chart)
      const c = paramData.values[1];
      expect(c.sliceDSL).toMatch(/^cohort\(/);
      expect(c.cohort_from).toBeTruthy();
      expect(c.cohort_to).toBeTruthy();
      expect(c.query_signature).toBeTruthy();
      expect(c.n).toBeGreaterThan(0);
      expect(c.k).toBeLessThanOrEqual(c.n);
      expect(c.n_daily.length).toBe(c.dates.length);

      // Cohort signature should differ from window signature
      expect(c.query_signature).not.toBe(w.query_signature);
    });

    it(`[${paramId}] cohort query_signature matches FE runtime computation`, async () => {
      const fromNode = graph.nodes.find((n: any) => n.uuid === edge.from);
      const toNode = graph.nodes.find((n: any) => n.uuid === edge.to);

      const { computeCurrentSignatureForEdge } = await import('../snapshotRetrievalsService');

      // Use ONLY the cohort clause from dataInterestsDSL
      const cohortDsl = (graph.dataInterestsDSL || '').split(';')
        .map((s: string) => s.trim())
        .find((s: string) => s.startsWith('cohort(')) || 'cohort(-100d:)';

      const result = await computeCurrentSignatureForEdge({
        graph,
        edgeId: edge.uuid,
        effectiveDSL: cohortDsl,
        workspace: { repository: 'nous-conversion', branch: 'feature/bayes-test-graph' },
      });

      if (!result) {
        // Some edges may not resolve (dropout edges) — skip
        return;
      }

      const feShortHash = await computeShortCoreHash(result.signature);

      // Load cohort sig from param file
      const paramData = loadParamFile(paramId);
      const cohortEntry = paramData?.values?.find((v: any) => v.sliceDSL?.startsWith('cohort('));
      expect(cohortEntry?.query_signature).toBeTruthy();

      const pythonShortHash = await computeShortCoreHash(cohortEntry.query_signature);

      // Capture for debugging
      fs.writeFileSync(`/tmp/fe-canonical-cohort-${paramId}.json`,
        (computeQuerySignature as any).__lastCoreCanonical || '');

      expect(feShortHash).toBe(pythonShortHash);
    });
  }
});
