/**
 * Graph Pre-Flight Check — Integration test using production IntegrityCheckService
 *
 * Loads a graph and entity files from the data repo into fake-indexeddb,
 * then runs the production IntegrityCheckService against them.
 *
 * SKIPPED by default (requires data repo on disk, slow). To run explicitly:
 *   GRAPH_PREFLIGHT=1 GRAPH_FILE=graphs/high-intent-flow-v2.json npm test -- --run src/services/__tests__/graphPreflightCheck.test.ts
 *
 * GRAPH_PREFLIGHT=1 is required to enable the test.
 * GRAPH_FILE defaults to graphs/high-intent-flow-v2.json if not set.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import { db } from '../../db/appDatabase';
import { IntegrityCheckService } from '../integrityCheckService';

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'graph-editor'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(process.cwd(), '..');
}

function readDataRepoDir(repoRoot: string): string {
  const confPath = path.join(repoRoot, '.private-repos.conf');
  try {
    const text = fs.readFileSync(confPath, 'utf-8');
    const match = text.match(/^DATA_REPO_DIR=(.+)$/m);
    return match?.[1]?.trim() || '';
  } catch {
    return '';
  }
}

const REPO_ROOT = findRepoRoot();
const DATA_REPO_DIR = readDataRepoDir(REPO_ROOT);
const DATA_REPO = DATA_REPO_DIR ? path.join(REPO_ROOT, DATA_REPO_DIR) : '';

const GRAPH_PREFLIGHT_ENABLED = process.env.GRAPH_PREFLIGHT === '1';
const GRAPH_FILE = process.env.GRAPH_FILE || 'graphs/high-intent-flow-v2.json';

vi.mock('../logFileService', () => ({
  LogFileService: {
    createLogFile: vi.fn().mockReturnValue({ fileId: 'test-log', content: '' }),
  },
}));

vi.mock('../../lib/credentials', () => ({
  credentialsManager: {
    loadCredentials: vi.fn().mockResolvedValue({ credentials: {} }),
  },
}));

function readYaml(filePath: string): any {
  const content = fs.readFileSync(filePath, 'utf-8');
  return yaml.parse(content);
}

function readJson(filePath: string): any {
  const content = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(content);
}

function dirToType(dir: string): string {
  const map: Record<string, string> = {
    graphs: 'graph',
    nodes: 'node',
    events: 'event',
    parameters: 'parameter',
    contexts: 'context',
    cases: 'case',
  };
  return map[dir] || dir;
}

async function loadDataRepoIntoIdb(graphFile?: string): Promise<{ graphCount: number; totalFiles: number }> {
  let totalFiles = 0;
  let graphCount = 0;

  const entityDirs = ['events', 'nodes', 'parameters', 'contexts', 'cases'];

  // Load index files
  for (const dir of entityDirs) {
    const indexPath = path.join(DATA_REPO, `${dir}-index.yaml`);
    if (fs.existsSync(indexPath)) {
      const data = readYaml(indexPath);
      const type = dirToType(dir);
      await db.files.put({
        fileId: `${type}-index`,
        type: type as any,
        data,
        viewTabs: [],
        isDirty: false,
      });
      totalFiles++;
    }
  }

  // Load entity files
  for (const dir of entityDirs) {
    const dirPath = path.join(DATA_REPO, dir);
    if (!fs.existsSync(dirPath)) continue;

    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.yaml'));
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const data = readYaml(filePath);
      const type = dirToType(dir);
      const id = file.replace('.yaml', '');

      await db.files.put({
        fileId: `${type}-${id}`,
        type: type as any,
        data,
        viewTabs: [],
        isDirty: false,
      });
      totalFiles++;
    }
  }

  // Load graph files
  const graphDir = path.join(DATA_REPO, 'graphs');
  if (fs.existsSync(graphDir)) {
    const graphFiles = fs.readdirSync(graphDir).filter((f) => f.endsWith('.json') || f.endsWith('.yaml'));

    for (const file of graphFiles) {
      if (graphFile && `graphs/${file}` !== graphFile) continue;

      const filePath = path.join(graphDir, file);
      const data = file.endsWith('.json') ? readJson(filePath) : readYaml(filePath);
      const id = file.replace(/\.(json|yaml)$/, '');

      await db.files.put({
        fileId: `graph-${id}`,
        type: 'graph' as any,
        data,
        viewTabs: [],
        isDirty: false,
      });
      totalFiles++;
      graphCount++;
    }
  }

  return { graphCount, totalFiles };
}

const describeIfEnabled = GRAPH_PREFLIGHT_ENABLED ? describe : describe.skip;

describeIfEnabled('Graph Pre-Flight Check (IntegrityCheckService)', () => {
  beforeEach(async () => {
    await db.files.clear();
    await db.tabs.clear();
    vi.clearAllMocks();
  });

  it('passes integrity check with no relevant errors', async () => {
    if (!DATA_REPO || !fs.existsSync(DATA_REPO)) return;

    const graphToCheck = GRAPH_FILE || undefined;
    const { graphCount } = await loadDataRepoIntoIdb(graphToCheck);
    if (graphCount === 0) return;

    const mockTabOps = {
      tabs: [],
      openFile: async () => {},
      setActiveTab: () => {},
      closeTab: () => {},
    };

    const result = await IntegrityCheckService.checkIntegrity(mockTabOps as any, false);
    const errors = result.issues.filter((i: any) => i.severity === 'error');

    const graphId = (graphToCheck || '')
      .replace(/^graphs\//, '')
      .replace(/\.(json|yaml)$/, '');

    const relevantErrors = graphId
      ? errors.filter((e: any) => String(e.fileId || '').includes(graphId) || String(e.fileId || '').includes('hif-'))
      : errors;

    expect(relevantErrors.length).toBe(0);
  }, 30_000);
});

