/**
 * @ menu snapshot retrieval — integration specification tests.
 *
 * ZERO MOCKS. Real graph files, real signatures, real Python server, real DB.
 *
 * Tests the contract: given a graph with stored parameter data (including
 * context-sliced values from multiple dataInterestsDSL epochs), the @ menu
 * retrieval functions should find all available snapshot days.
 *
 * Written blind from the contract — does not read the implementation to
 * shape assertions. Verifies:
 *   1. computePlausibleSignaturesForEdge returns multiple signatures for
 *      contexted graphs (one per plausible context key-set)
 *   2. Per-edge retrieval returns non-empty days for both contexted and
 *      uncontexted graphs
 *   3. Batched retrieval returns non-empty days
 *   4. Batched and per-edge paths produce identical results
 *   5. No double-counting — day count from batched path matches per-edge
 *
 * Requires:
 *   - Python server running on localhost:9000
 *   - nous-conversion data repo on main branch with real parameter files
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll } from 'vitest';
import 'fake-indexeddb/auto';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

import { fileRegistry } from '../../contexts/TabContext';
import {
  computePlausibleSignaturesForEdge,
  getSnapshotCoverageForEdges,
  getSnapshotCoverageForEdgesBatched,
  getSnapshotRetrievalsForEdge,
} from '../snapshotRetrievalsService';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'graph-editor')) && fs.existsSync(path.join(dir, '.private-repos.conf'))) return dir;
    dir = path.dirname(dir);
  }
  return path.resolve(process.cwd(), '..');
}

function readDataRepoName(repoRoot: string): string {
  const conf = fs.readFileSync(path.join(repoRoot, '.private-repos.conf'), 'utf-8');
  return conf.match(/DATA_REPO_DIR=(\S+)/)?.[1] || 'nous-conversion';
}

const REPO_ROOT = findRepoRoot();
const DATA_REPO = readDataRepoName(REPO_ROOT);
const DATA_PATH = path.join(REPO_ROOT, DATA_REPO);
const WORKSPACE = { repository: DATA_REPO, branch: 'main' };

const GRAPHS = [
  {
    name: 'li-cohort-segmentation-v2',
    file: 'li-cohort-segmentation-v2.json',
    dsl: 'cohort(15-Mar-26:30-Mar-26)',
    hasContexts: true,
    minConnectedEdges: 20,
  },
  {
    name: 'gm-rebuild-jan-26',
    file: 'gm-rebuild-jan-26.json',
    dsl: 'cohort(15-Mar-26:30-Mar-26)',
    hasContexts: false,
    minConnectedEdges: 3,
  },
];

let ready = false;

async function loadAllEntityFiles(): Promise<number> {
  let count = 0;
  for (const dir of ['events', 'parameters', 'contexts', 'nodes']) {
    const full = path.join(DATA_PATH, dir);
    if (!fs.existsSync(full)) continue;
    for (const file of fs.readdirSync(full)) {
      if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
      const id = file.replace(/\.(yaml|yml)$/, '');
      const type = dir === 'events' ? 'event'
        : dir === 'parameters' ? 'parameter'
        : dir === 'contexts' ? 'context'
        : 'node';
      try {
        const data = yaml.load(fs.readFileSync(path.join(full, file), 'utf-8'));
        if (data) {
          await fileRegistry.registerFile(`${type}-${id}`, {
            fileId: `${type}-${id}`,
            type,
            source: { repository: WORKSPACE.repository, branch: WORKSPACE.branch },
            data,
            isDirty: false,
          } as any);
          count++;
        }
      } catch { /* skip unreadable files */ }
    }
  }

  // Load hash-mappings (YAML despite .json extension)
  const hmPath = path.join(DATA_PATH, 'hash-mappings.json');
  if (fs.existsSync(hmPath)) {
    try {
      const data = yaml.load(fs.readFileSync(hmPath, 'utf-8'));
      if (data) {
        await fileRegistry.registerFile('hash-mappings', {
          fileId: 'hash-mappings', type: 'hash-mappings',
          source: { repository: WORKSPACE.repository, branch: WORKSPACE.branch },
          data, isDirty: false,
        } as any);
        count++;
      }
    } catch { /* skip */ }
  }

  return count;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('@ menu snapshot retrieval (zero-mock, real DB)', () => {
  beforeAll(async () => {
    for (const g of GRAPHS) {
      if (!fs.existsSync(path.join(DATA_PATH, 'graphs', g.file))) {
        console.warn(`Graph ${g.file} not found — skipping`);
        return;
      }
    }
    try {
      const h = await fetch('http://localhost:9000/api/snapshots/health');
      if (!h.ok) throw new Error(`health check ${h.status}`);
    } catch (e) {
      console.warn('Python server not available — skipping:', e);
      return;
    }
    await loadAllEntityFiles();
    ready = true;
  });

  for (const gc of GRAPHS) {
    describe(gc.name, () => {
      const loadGraph = () => {
        const p = path.join(DATA_PATH, 'graphs', gc.file);
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
      };

      it('should produce plausible signatures for connected edges', async () => {
        if (!ready) return;
        const graph = loadGraph();
        const connectedEdges = (graph.edges || []).filter(
          (e: any) => e?.p?.id || e?.p?.parameter_id
        );
        expect(connectedEdges.length).toBeGreaterThanOrEqual(gc.minConnectedEdges);

        // Pick first connected edge
        const edge = connectedEdges[0];
        const edgeId = edge.uuid || edge.id;

        const sigs = await computePlausibleSignaturesForEdge({
          graph, edgeId, effectiveDSL: gc.dsl, workspace: WORKSPACE,
        });

        expect(sigs.length).toBeGreaterThan(0);

        // Contexted graphs should produce multiple plausible signatures
        // (uncontexted hash + at least one contexted hash)
        if (gc.hasContexts) {
          expect(sigs.length).toBeGreaterThan(1);
        }
      }, 30_000);

      it('should find snapshot days via per-edge retrieval', async () => {
        if (!ready) return;
        const graph = loadGraph();
        const edge = (graph.edges || []).find((e: any) => e?.p?.id);
        const edgeId = edge.uuid || edge.id;

        const result = await getSnapshotRetrievalsForEdge({
          graph, edgeId, effectiveDSL: gc.dsl, workspace: WORKSPACE,
        });

        expect(result.success).toBe(true);
        expect(result.retrieved_days.length).toBeGreaterThan(0);
      }, 30_000);

      it('should find snapshot days via batched coverage', async () => {
        if (!ready) return;
        const graph = loadGraph();

        const result = await getSnapshotCoverageForEdgesBatched({
          graph, effectiveDSL: gc.dsl, workspace: WORKSPACE,
        });

        expect(result.success).toBe(true);
        expect(result.allDays.length).toBeGreaterThan(0);
        expect(result.totalParams).toBeGreaterThanOrEqual(gc.minConnectedEdges);
      }, 120_000);

      it('should produce identical results from batched and per-edge paths', async () => {
        if (!ready) return;
        const graph = loadGraph();

        const [perEdge, batched] = await Promise.all([
          getSnapshotCoverageForEdges({
            graph, effectiveDSL: gc.dsl, workspace: WORKSPACE,
          }),
          getSnapshotCoverageForEdgesBatched({
            graph, effectiveDSL: gc.dsl, workspace: WORKSPACE,
          }),
        ]);

        expect(batched.success).toBe(perEdge.success);
        expect(batched.totalParams).toBe(perEdge.totalParams);
        expect(batched.allDays).toEqual(perEdge.allDays);
        expect(batched.coverageByDay).toEqual(perEdge.coverageByDay);
      }, 120_000);
    });
  }
});
