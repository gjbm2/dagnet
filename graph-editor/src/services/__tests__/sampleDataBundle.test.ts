/**
 * Sample Data Bundle Tests
 *
 * D1: Bundle integrity — verifies the generated bundle against source files.
 * D2: Hydration — verifies hydrateFromBundle writes correct state to IDB + FileRegistry.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml';
import { db } from '../../db/appDatabase';
import { fileRegistry } from '../../contexts/TabContext';
import { workspaceService } from '../workspaceService';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SAMPLE_DATA_PATH = path.join(REPO_ROOT, 'param-registry', 'test');
const BUNDLE_PATH = path.join(REPO_ROOT, 'graph-editor', 'public', 'defaults', 'sample-data-bundle.json');

const BASE_PATH = 'param-registry/test';

const DIRECTORIES = [
  { dirName: 'graphs',     type: 'graph',     extension: 'json' },
  { dirName: 'parameters', type: 'parameter', extension: 'yaml' },
  { dirName: 'contexts',   type: 'context',   extension: 'yaml' },
  { dirName: 'cases',      type: 'case',      extension: 'yaml' },
  { dirName: 'nodes',      type: 'node',      extension: 'yaml' },
  { dirName: 'events',     type: 'event',     extension: 'yaml' },
];

const INDEX_FILES = [
  { fileName: 'parameters-index.yaml', type: 'parameter' },
  { fileName: 'contexts-index.yaml',   type: 'context' },
  { fileName: 'cases-index.yaml',      type: 'case' },
  { fileName: 'nodes-index.yaml',      type: 'node' },
  { fileName: 'events-index.yaml',     type: 'event' },
];

const EXCLUDED_GRAPHS = new Set(['ab-bc-smooth-lag-rebalance.json']);

function listSourceFiles(dirPath: string, extension: string): string[] {
  if (!fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath)
    .filter(f => f.endsWith(`.${extension}`) && !f.startsWith('.'))
    .sort();
}

function loadBundle(): any {
  if (!fs.existsSync(BUNDLE_PATH)) {
    throw new Error(
      `Bundle not found at ${BUNDLE_PATH}. Run "npm run bundle-sample-data" first.`
    );
  }
  return JSON.parse(fs.readFileSync(BUNDLE_PATH, 'utf8'));
}

// ─────────────────────────────────────────────────────────────────────────────
// D1: Bundle integrity
// ─────────────────────────────────────────────────────────────────────────────
describe('Sample data bundle integrity', () => {
  let bundle: any;

  beforeEach(() => {
    bundle = loadBundle();
  });

  it('should have valid top-level structure', () => {
    expect(bundle.version).toBe('1.0.0');
    expect(bundle.commitSha).toBeTruthy();
    expect(bundle.basePath).toBe(BASE_PATH);
    expect(Array.isArray(bundle.files)).toBe(true);
    expect(bundle.files.length).toBeGreaterThan(0);
  });

  it('should contain every source file from each directory', () => {
    const bundlePaths = new Set(bundle.files.map((f: any) => f.path));

    for (const dir of DIRECTORIES) {
      const sourceDir = path.join(SAMPLE_DATA_PATH, dir.dirName);
      const sourceFiles = listSourceFiles(sourceDir, dir.extension);

      for (const fileName of sourceFiles) {
        if (dir.type === 'graph' && EXCLUDED_GRAPHS.has(fileName)) continue;
        const expectedPath = `${BASE_PATH}/${dir.dirName}/${fileName}`;
        expect(bundlePaths.has(expectedPath)).toBe(true);
      }
    }
  });

  it('should contain all index files', () => {
    const bundlePaths = new Set(bundle.files.map((f: any) => f.path));

    for (const idx of INDEX_FILES) {
      const expectedPath = `${BASE_PATH}/${idx.fileName}`;
      expect(bundlePaths.has(expectedPath)).toBe(true);
    }
  });

  it('should have no extra files beyond source directories and indexes', () => {
    let expectedCount = 0;
    for (const dir of DIRECTORIES) {
      const sourceDir = path.join(SAMPLE_DATA_PATH, dir.dirName);
      let count = listSourceFiles(sourceDir, dir.extension).length;
      if (dir.type === 'graph') count -= EXCLUDED_GRAPHS.size;
      expectedCount += count;
    }
    for (const idx of INDEX_FILES) {
      if (fs.existsSync(path.join(SAMPLE_DATA_PATH, idx.fileName))) {
        expectedCount++;
      }
    }
    expect(bundle.files.length).toBe(expectedCount);
  });

  it('should generate correct fileIds matching cloneWorkspace logic', () => {
    for (const file of bundle.files) {
      if (file.isIndex) {
        expect(file.fileId).toBe(`${file.type}-index`);
      } else {
        const nameWithoutExt = file.name.replace(/\.(yaml|yml|json)$/, '');
        expect(file.fileId).toBe(`${file.type}-${nameWithoutExt}`);
      }
    }
  });

  it('should have non-empty SHA for every file', () => {
    for (const file of bundle.files) {
      expect(file.sha).toBeTruthy();
      expect(file.sha.length).toBeGreaterThanOrEqual(7);
    }
  });

  it('should have parsed data matching the source file for a representative graph', () => {
    const graphEntry = bundle.files.find((f: any) => f.fileId === 'graph-ecommerce-checkout-flow');
    expect(graphEntry).toBeDefined();

    const sourcePath = path.join(SAMPLE_DATA_PATH, 'graphs', 'ecommerce-checkout-flow.json');
    const sourceData = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));

    expect(graphEntry.data.nodes.length).toBe(sourceData.nodes.length);
    expect(graphEntry.data.edges.length).toBe(sourceData.edges.length);
    expect(graphEntry.data.policies).toEqual(sourceData.policies);
  });

  it('should have parsed data matching the source file for a representative parameter', () => {
    const paramEntry = bundle.files.find((f: any) => f.fileId === 'parameter-checkout-to-payment');
    expect(paramEntry).toBeDefined();

    const sourcePath = path.join(SAMPLE_DATA_PATH, 'parameters', 'checkout-to-payment.yaml');
    const sourceData = YAML.parse(fs.readFileSync(sourcePath, 'utf8'));

    expect(paramEntry.data.id).toBe(sourceData.id);
    expect(paramEntry.data.type).toBe(sourceData.type);
  });

  it('should have parsed data matching the source file for a representative index', () => {
    const indexEntry = bundle.files.find((f: any) => f.fileId === 'node-index');
    expect(indexEntry).toBeDefined();

    const sourcePath = path.join(SAMPLE_DATA_PATH, 'nodes-index.yaml');
    const sourceData = YAML.parse(fs.readFileSync(sourcePath, 'utf8'));

    expect(indexEntry.data.nodes.length).toBe(sourceData.nodes.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D2: Hydration integration tests
// ─────────────────────────────────────────────────────────────────────────────
describe('Sample data bundle hydration', () => {
  let bundle: any;

  beforeEach(async () => {
    bundle = loadBundle();

    await db.delete();
    await db.open();
    (fileRegistry as any).files.clear();
    (fileRegistry as any).listeners.clear();
  });

  it('should write all files to IDB with workspace-prefixed fileIds', async () => {
    await workspaceService.hydrateFromBundle('dagnet', 'main', bundle);

    const idbFiles = await db.files.toArray();
    const workspaceFiles = idbFiles.filter(f => f.fileId.startsWith('dagnet-main-'));
    expect(workspaceFiles.length).toBe(bundle.files.length);
  });

  it('should write all files to FileRegistry with unprefixed fileIds', async () => {
    await workspaceService.hydrateFromBundle('dagnet', 'main', bundle);

    for (const bundleFile of bundle.files) {
      const regFile = (fileRegistry as any).files.get(bundleFile.fileId);
      expect(regFile).toBeDefined();
      expect(regFile.type).toBe(bundleFile.type);
      expect(regFile.path).toBe(bundleFile.path);
    }
  });

  it('should create correct FileState shape for each file', async () => {
    await workspaceService.hydrateFromBundle('dagnet', 'main', bundle);

    const idbFiles = await db.files.toArray();
    const graphFile = idbFiles.find(f => f.fileId === 'dagnet-main-graph-sample');

    expect(graphFile).toBeDefined();
    expect(graphFile!.type).toBe('graph');
    expect(graphFile!.isDirty).toBe(false);
    expect(graphFile!.isLocal).toBe(false);
    expect(graphFile!.isLoaded).toBe(true);
    expect(graphFile!.source?.repository).toBe('dagnet');
    expect(graphFile!.source?.branch).toBe('main');
    expect(graphFile!.sha).toBeTruthy();
  });

  it('should create workspace record with correct metadata', async () => {
    await workspaceService.hydrateFromBundle('dagnet', 'main', bundle);

    const workspace = await db.workspaces.get('dagnet-main');
    expect(workspace).toBeDefined();
    expect(workspace!.repository).toBe('dagnet');
    expect(workspace!.branch).toBe('main');
    expect(workspace!.commitSHA).toBe(bundle.commitSha);
    expect(workspace!.isCloning).toBe(false);
    expect(workspace!.fileIds.length).toBe(bundle.files.length);
  });

  it('should return all hydrated files from getWorkspaceFiles', async () => {
    await workspaceService.hydrateFromBundle('dagnet', 'main', bundle);

    const wsFiles = await workspaceService.getWorkspaceFiles('dagnet', 'main');
    expect(wsFiles.length).toBe(bundle.files.length);

    const types = new Set(wsFiles.map(f => f.type));
    expect(types.has('graph')).toBe(true);
    expect(types.has('parameter')).toBe(true);
    expect(types.has('node')).toBe(true);
    expect(types.has('event')).toBe(true);
  });

  it('should include graph files in workspace files (the original bug)', async () => {
    await workspaceService.hydrateFromBundle('dagnet', 'main', bundle);

    const wsFiles = await workspaceService.getWorkspaceFiles('dagnet', 'main');
    const graphs = wsFiles.filter(f => f.type === 'graph');
    expect(graphs.length).toBe(2);
    expect(graphs.map(g => g.fileId).sort()).toEqual([
      'graph-ecommerce-checkout-flow',
      'graph-sample'
    ]);
  });
});
