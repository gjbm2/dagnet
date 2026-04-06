/**
 * Parity test: getSnapshotCoverageForEdges vs getSnapshotCoverageForEdgesBatched
 *
 * ZERO MOCKS. Real graph files, real signatures, real Python server, real DB.
 *
 * Requires:
 * - Python server running on localhost:9000
 * - nous-conversion data repo with conversion-flow-v2-recs-collapsed
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
  getSnapshotCoverageForEdges,
  getSnapshotCoverageForEdgesBatched,
} from '../snapshotRetrievalsService';

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
const GRAPH_PATH = path.join(DATA_PATH, 'graphs', 'conversion-flow-v2-recs-collapsed.json');
const WORKSPACE = { repository: DATA_REPO, branch: 'main' };

let graph: any = null;
let ready = false;

describe('getSnapshotCoverageForEdges parity (zero-mock, real DB)', () => {
  beforeAll(async () => {
    if (!fs.existsSync(GRAPH_PATH)) { console.warn('Graph not found — skipping'); return; }
    try {
      const h = await fetch('http://localhost:9000/api/snapshots/health');
      if (!h.ok) throw new Error();
    } catch { console.warn('Python server not available — skipping'); return; }

    graph = JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf-8'));

    // Register every YAML file the graph could reference
    for (const dir of ['events', 'parameters', 'contexts']) {
      const full = path.join(DATA_PATH, dir);
      if (!fs.existsSync(full)) continue;
      for (const file of fs.readdirSync(full)) {
        if (!file.endsWith('.yaml')) continue;
        const id = file.replace('.yaml', '');
        const type = dir === 'events' ? 'event' : dir === 'parameters' ? 'parameter' : 'context';
        const data = yaml.load(fs.readFileSync(path.join(full, file), 'utf-8'));
        if (data) {
          await fileRegistry.registerFile(`${type}-${id}`, {
            fileId: `${type}-${id}`, type, source: WORKSPACE, data, isDirty: false,
          } as any);
        }
      }
    }

    ready = true;
  });

  it('batched path produces identical coverage to per-edge path', async () => {
    if (!ready) return;

    const args = { graph, effectiveDSL: 'window(-120d:)', workspace: WORKSPACE };

    const perEdge = await getSnapshotCoverageForEdges(args);
    const batched = await getSnapshotCoverageForEdgesBatched(args);

    expect(perEdge.success).toBe(true);
    expect(batched.success).toBe(perEdge.success);
    expect(batched.totalParams).toBe(perEdge.totalParams);
    expect(batched.allDays).toEqual(perEdge.allDays);
    expect(batched.coverageByDay).toEqual(perEdge.coverageByDay);
  }, 60_000);
});
