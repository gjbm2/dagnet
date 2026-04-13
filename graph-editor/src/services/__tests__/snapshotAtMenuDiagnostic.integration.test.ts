/**
 * Diagnostic test: why does the @ menu show no snapshots for li-cohort-segmentation-v2
 * but works for gm-rebuild-jan-26?
 *
 * ZERO MOCKS. Real graph files, real signatures, real Python server, real DB.
 *
 * Tests both graphs with their actual DSLs. For each edge, it:
 * 1. Computes the signature via computeCurrentSignatureForEdge
 * 2. Computes the short DB core_hash
 * 3. Queries the real DB to check if snapshots exist for that hash
 * 4. Runs the full coverage path (both batched and per-edge) and compares
 *
 * Key variables to test:
 * - Size: li-v2 has 31 connected edges vs gm's 4
 * - Contexts: li-v2's dataInterestsDSL includes context(channel), context(onboarding-blueprint-variant),
 *   context(energy-blueprint-variant); gm has no contexts
 *
 * Requires:
 * - Python server running on localhost:9000
 * - nous-conversion data repo on main branch
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
  computeCurrentSignatureForEdge,
  getSnapshotCoverageForEdges,
  getSnapshotCoverageForEdgesBatched,
} from '../snapshotRetrievalsService';
import { computeShortCoreHash } from '../coreHashService';

// ---------------------------------------------------------------------------
// Setup helpers
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

// Graph configs to test
const GRAPHS = [
  {
    name: 'li-cohort-segmentation-v2',
    file: 'li-cohort-segmentation-v2.json',
    // Use the graph's actual currentQueryDSL
    dsl: 'cohort(15-Mar-26:30-Mar-26)',
    expectedConnectedEdges: 31,
  },
  {
    name: 'gm-rebuild-jan-26',
    file: 'gm-rebuild-jan-26.json',
    dsl: 'cohort(15-Mar-26:30-Mar-26)',
    expectedConnectedEdges: 4,
  },
];

let ready = false;

// ---------------------------------------------------------------------------
// File loading
// ---------------------------------------------------------------------------

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
      } catch (e) {
        console.warn(`Failed to load ${dir}/${file}:`, e);
      }
    }
  }

  // Also load hash-mappings.json (it's YAML despite the extension)
  const hmPath = path.join(DATA_PATH, 'hash-mappings.json');
  if (fs.existsSync(hmPath)) {
    try {
      const data = yaml.load(fs.readFileSync(hmPath, 'utf-8'));
      if (data) {
        await fileRegistry.registerFile('hash-mappings', {
          fileId: 'hash-mappings',
          type: 'hash-mappings',
          source: { repository: WORKSPACE.repository, branch: WORKSPACE.branch },
          data,
          isDirty: false,
        } as any);
        count++;
      }
    } catch (e) {
      console.warn('Failed to load hash-mappings:', e);
    }
  }

  return count;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('@-menu snapshot diagnostic (zero-mock, real DB)', () => {
  beforeAll(async () => {
    // Check prerequisites
    for (const g of GRAPHS) {
      const gPath = path.join(DATA_PATH, 'graphs', g.file);
      if (!fs.existsSync(gPath)) {
        console.warn(`Graph ${g.file} not found at ${gPath} — skipping`);
        return;
      }
    }

    try {
      const h = await fetch('http://localhost:9000/api/snapshots/health');
      if (!h.ok) throw new Error(`health check returned ${h.status}`);
    } catch (e) {
      console.warn('Python server not available — skipping:', e);
      return;
    }

    const fileCount = await loadAllEntityFiles();
    console.log(`Loaded ${fileCount} entity files into FileRegistry`);

    ready = true;
  });

  // ── Stage 2: Per-edge signature computation ──
  for (const graphConfig of GRAPHS) {
    describe(`Stage 2 — signature computation: ${graphConfig.name}`, () => {
      it('should compute non-null signatures for all connected edges', async () => {
        if (!ready) return;

        const graphPath = path.join(DATA_PATH, 'graphs', graphConfig.file);
        const graph = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));

        const connectedEdges = (graph.edges || []).filter(
          (e: any) => e?.p?.id || e?.p?.parameter_id
        );
        expect(connectedEdges.length).toBe(graphConfig.expectedConnectedEdges);

        const results: Array<{
          edgeId: string;
          paramId: string;
          signature: string | null;
          identityHash: string | null;
          shortHash: string | null;
          error: string | null;
        }> = [];

        for (const edge of connectedEdges) {
          const edgeId = edge.uuid || edge.id;
          const paramId = edge.p?.id || edge.p?.parameter_id;
          try {
            const sig = await computeCurrentSignatureForEdge({
              graph,
              edgeId,
              effectiveDSL: graphConfig.dsl,
              workspace: WORKSPACE,
            });

            if (sig) {
              const shortHash = await computeShortCoreHash(sig.signature);
              results.push({
                edgeId,
                paramId,
                signature: sig.signature,
                identityHash: sig.identityHash,
                shortHash,
                error: null,
              });
            } else {
              results.push({ edgeId, paramId, signature: null, identityHash: null, shortHash: null, error: 'returned null' });
            }
          } catch (e) {
            results.push({
              edgeId,
              paramId,
              signature: null,
              identityHash: null,
              shortHash: null,
              error: String(e),
            });
          }
        }

        // Report all results
        const succeeded = results.filter(r => r.shortHash);
        const failed = results.filter(r => !r.shortHash);

        console.log(`\n${graphConfig.name}: ${succeeded.length}/${results.length} edges produced signatures`);
        for (const r of succeeded) {
          console.log(`  ✓ ${r.paramId} → shortHash=${r.shortHash}`);
        }
        for (const r of failed) {
          console.log(`  ✗ ${r.paramId} → ${r.error}`);
        }

        // ALL edges must produce signatures
        expect(failed.length).toBe(0);
      }, 60_000);
    });
  }

  // ── Stage 2b: Check computed hashes against DB ──
  for (const graphConfig of GRAPHS) {
    describe(`Stage 2b — hash vs DB check: ${graphConfig.name}`, () => {
      it('should produce core_hashes that exist in the snapshot DB', async () => {
        if (!ready) return;

        const graphPath = path.join(DATA_PATH, 'graphs', graphConfig.file);
        const graph = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));

        const connectedEdges = (graph.edges || []).filter(
          (e: any) => e?.p?.id || e?.p?.parameter_id
        );

        const hashCheckResults: Array<{
          paramId: string;
          dbParamId: string;
          shortHash: string;
          snapshotCount: number;
          matchedFamily: boolean;
        }> = [];

        for (const edge of connectedEdges) {
          const edgeId = edge.uuid || edge.id;
          const sig = await computeCurrentSignatureForEdge({
            graph,
            edgeId,
            effectiveDSL: graphConfig.dsl,
            workspace: WORKSPACE,
          });
          if (!sig) continue;

          const shortHash = await computeShortCoreHash(sig.signature);
          const dbParamId = sig.dbParamId;

          // Query the real DB to check if this hash has snapshots
          const response = await fetch('http://localhost:9000/api/snapshots/inventory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              param_ids: [dbParamId],
              current_signatures: { [dbParamId]: sig.signature },
              current_core_hashes: { [dbParamId]: shortHash },
              limit_families_per_param: 50,
              limit_slices_per_family: 200,
            }),
          });
          const invData = await response.json();
          const paramInv = invData.inventory?.[dbParamId];
          const matchedFamilyId = paramInv?.current?.matched_family_id;

          // Also do a direct count query
          const countResp = await fetch('http://localhost:9000/api/snapshots/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              param_id: dbParamId,
              core_hash: shortHash,
              limit: 1,
            }),
          });
          const countData = await countResp.json();
          const snapshotCount = countData.count ?? 0;

          hashCheckResults.push({
            paramId: edge.p?.id,
            dbParamId,
            shortHash,
            snapshotCount,
            matchedFamily: !!matchedFamilyId,
          });
        }

        // Report
        const matched = hashCheckResults.filter(r => r.matchedFamily);
        const unmatched = hashCheckResults.filter(r => !r.matchedFamily);
        const hasSnapshots = hashCheckResults.filter(r => r.snapshotCount > 0);
        const noSnapshots = hashCheckResults.filter(r => r.snapshotCount === 0);

        console.log(`\n${graphConfig.name}: hash vs DB check`);
        console.log(`  Matched family: ${matched.length}/${hashCheckResults.length}`);
        console.log(`  Has snapshots for computed hash: ${hasSnapshots.length}/${hashCheckResults.length}`);

        if (unmatched.length > 0) {
          console.log(`\n  UNMATCHED (no family for computed hash):`);
          for (const r of unmatched) {
            console.log(`    ${r.paramId}: shortHash=${r.shortHash}, snapshotCount=${r.snapshotCount}`);
          }
        }
        if (noSnapshots.length > 0) {
          console.log(`\n  NO SNAPSHOTS for computed hash:`);
          for (const r of noSnapshots) {
            console.log(`    ${r.paramId}: shortHash=${r.shortHash}, matchedFamily=${r.matchedFamily}`);
          }
        }

        // At least SOME edges should have matching snapshots
        // (If zero match, the @ menu will be empty)
        expect(hasSnapshots.length).toBeGreaterThan(0);
      }, 120_000);
    });
  }

  // ── Stage 2c: Trace the per-edge retrieval for one li-c edge ──
  describe('Stage 2c — per-edge retrieval trace: li-cohort-segmentation-v2', () => {
    it('should trace why getSnapshotRetrievalsForEdge returns empty', async () => {
      if (!ready) return;

      const graphPath = path.join(DATA_PATH, 'graphs', 'li-cohort-segmentation-v2.json');
      const graph = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));
      const dsl = 'cohort(15-Mar-26:30-Mar-26)';

      // Pick the first connected edge
      const edge = (graph.edges || []).find((e: any) => e?.p?.id);
      const edgeId = edge.uuid || edge.id;
      const paramId = edge.p.id;

      console.log(`\nTracing edge: ${paramId}`);
      console.log(`  effectiveDSL: "${dsl}"`);

      // Step 1: Compute signature
      const sig = await computeCurrentSignatureForEdge({
        graph, edgeId, effectiveDSL: dsl, workspace: WORKSPACE,
      });
      expect(sig).not.toBeNull();
      const shortHash = await computeShortCoreHash(sig!.signature);
      console.log(`  signature computed: shortHash=${shortHash}`);
      console.log(`  dbParamId: ${sig!.dbParamId}`);

      // Step 2: Check slice filtering logic
      const { stripAsatClause: strip } = await import('../snapshotRetrievalsService' as any)
        .then(() => import('../../services/snapshotRetrievalsService'))
        .catch(() => ({ stripAsatClause: (s: string) => s.replace(/\.?(?:asat|at)\([^)]+\)/g, '').replace(/^\./, '') }));

      const dslWithoutAsat = dsl.replace(/\.?(?:asat|at)\([^)]+\)/g, '').replace(/^\./, '');
      console.log(`  dslWithoutAsat: "${dslWithoutAsat}"`);

      const { extractSliceDimensions } = await import('../sliceIsolation');
      const contextDims = extractSliceDimensions(dslWithoutAsat);
      console.log(`  contextDims: "${contextDims}" (truthy=${!!contextDims})`);

      const { hasContextAny } = await import('../sliceIsolation');
      const hasAny = hasContextAny(dslWithoutAsat);
      console.log(`  hasContextAny: ${hasAny}`);

      const wantSliceFilter = !!contextDims && !hasAny;
      console.log(`  wantSliceFilter: ${wantSliceFilter}`);

      // Step 3: Call the actual per-edge retrieval
      const { getSnapshotRetrievalsForEdge } = await import('../snapshotRetrievalsService');
      const result = await getSnapshotRetrievalsForEdge({
        graph, edgeId, effectiveDSL: dsl, workspace: WORKSPACE,
      });

      console.log(`\n  Per-edge retrieval result:`);
      console.log(`    success: ${result.success}`);
      console.log(`    count: ${result.count}`);
      console.log(`    retrieved_days: ${result.retrieved_days?.length ?? 0}`);
      console.log(`    error: ${result.error || 'none'}`);

      // Step 4: Also try with a simple DSL (no cohort anchor)
      const simpleDsl = 'window(-30d:)';
      const simpleResult = await getSnapshotRetrievalsForEdge({
        graph, edgeId, effectiveDSL: simpleDsl, workspace: WORKSPACE,
      });

      console.log(`\n  Per-edge retrieval with '${simpleDsl}':`);
      console.log(`    success: ${simpleResult.success}`);
      console.log(`    count: ${simpleResult.count}`);
      console.log(`    retrieved_days: ${simpleResult.retrieved_days?.length ?? 0}`);
      console.log(`    error: ${simpleResult.error || 'none'}`);

      // Step 5: Direct batch retrieval with just the core_hash (no slice filter)
      const { getBatchRetrievals } = await import('../snapshotWriteService');
      const directResult = await getBatchRetrievals([{
        param_id: sig!.dbParamId,
        core_hash: shortHash,
      }], 50);

      console.log(`\n  Direct batch retrieval (no slice filter):`);
      console.log(`    results: ${directResult.length}`);
      if (directResult[0]) {
        console.log(`    success: ${directResult[0].success}`);
        console.log(`    days: ${directResult[0].retrieved_days?.length ?? 0}`);
        console.log(`    error: ${directResult[0].error || 'none'}`);
      }

      // The direct retrieval should find data
      expect(directResult.length).toBe(1);
      expect(directResult[0]?.success).toBe(true);

      // FAIL deliberately so output is visible
      if (result.retrieved_days?.length === 0) {
        throw new Error(
          `Per-edge retrieval returned 0 days despite valid signature and DB data.\n` +
          `  paramId: ${paramId}\n` +
          `  shortHash: ${shortHash}\n` +
          `  dslWithoutAsat: "${dslWithoutAsat}"\n` +
          `  contextDims: "${contextDims}" (truthy=${!!contextDims})\n` +
          `  wantSliceFilter: ${wantSliceFilter}\n` +
          `  per-edge result: success=${result.success}, days=${result.retrieved_days?.length}, error=${result.error}\n` +
          `  direct batch result: success=${directResult[0]?.success}, days=${directResult[0]?.retrieved_days?.length}\n` +
          `  simple DSL result: success=${simpleResult.success}, days=${simpleResult.retrieved_days?.length}`
        );
      }
    }, 60_000);
  });

  // ── Stage 3-5: Full coverage path comparison ──
  for (const graphConfig of GRAPHS) {
    describe(`Stage 3-5 — full coverage: ${graphConfig.name}`, () => {
      it('batched path should return non-empty results', async () => {
        if (!ready) return;

        const graphPath = path.join(DATA_PATH, 'graphs', graphConfig.file);
        const graph = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));

        const args = {
          graph,
          effectiveDSL: graphConfig.dsl,
          workspace: WORKSPACE,
        };

        const batched = await getSnapshotCoverageForEdgesBatched(args);

        console.log(`\n${graphConfig.name} batched coverage:`);
        console.log(`  success: ${batched.success}`);
        console.log(`  totalParams: ${batched.totalParams}`);
        console.log(`  allDays count: ${batched.allDays.length}`);
        console.log(`  first 5 days: ${batched.allDays.slice(0, 5).join(', ')}`);
        console.log(`  error: ${batched.error || 'none'}`);

        expect(batched.success).toBe(true);
        expect(batched.allDays.length).toBeGreaterThan(0);
      }, 120_000);

      it('per-edge path should return non-empty results', async () => {
        if (!ready) return;

        const graphPath = path.join(DATA_PATH, 'graphs', graphConfig.file);
        const graph = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));

        const args = {
          graph,
          effectiveDSL: graphConfig.dsl,
          workspace: WORKSPACE,
        };

        const perEdge = await getSnapshotCoverageForEdges(args);

        console.log(`\n${graphConfig.name} per-edge coverage:`);
        console.log(`  success: ${perEdge.success}`);
        console.log(`  totalParams: ${perEdge.totalParams}`);
        console.log(`  allDays count: ${perEdge.allDays.length}`);
        console.log(`  first 5 days: ${perEdge.allDays.slice(0, 5).join(', ')}`);
        console.log(`  error: ${perEdge.error || 'none'}`);

        expect(perEdge.success).toBe(true);
        expect(perEdge.allDays.length).toBeGreaterThan(0);
      }, 120_000);

      it('batched and per-edge paths should produce the same results', async () => {
        if (!ready) return;

        const graphPath = path.join(DATA_PATH, 'graphs', graphConfig.file);
        const graph = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));

        const args = {
          graph,
          effectiveDSL: graphConfig.dsl,
          workspace: WORKSPACE,
        };

        const [perEdge, batched] = await Promise.all([
          getSnapshotCoverageForEdges(args),
          getSnapshotCoverageForEdgesBatched(args),
        ]);

        console.log(`\n${graphConfig.name} parity check:`);
        console.log(`  per-edge: ${perEdge.allDays.length} days, totalParams=${perEdge.totalParams}`);
        console.log(`  batched:  ${batched.allDays.length} days, totalParams=${batched.totalParams}`);

        expect(batched.success).toBe(perEdge.success);
        expect(batched.totalParams).toBe(perEdge.totalParams);
        expect(batched.allDays).toEqual(perEdge.allDays);
        expect(batched.coverageByDay).toEqual(perEdge.coverageByDay);
      }, 120_000);
    });
  }
});
