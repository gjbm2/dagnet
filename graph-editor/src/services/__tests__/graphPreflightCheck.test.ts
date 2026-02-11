/**
 * Graph Pre-Flight Check — Integration test using production IntegrityCheckService
 *
 * Loads a graph and all its entity files from the data repo into fake-indexeddb,
 * then runs the production IntegrityCheckService against them.
 *
 * Usage:
 *   GRAPH_FILE=graphs/high-intent-flow-v2.json npm test -- --run src/services/__tests__/graphPreflightCheck.test.ts
 *
 * If GRAPH_FILE is not set, defaults to checking all graphs in the data repo.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { db } from '../../db/appDatabase';
import { IntegrityCheckService } from '../integrityCheckService';

// Data repo path (relative to graph-editor/)
const DATA_REPO = path.resolve(__dirname, '../../../nous-conversion');

// Which graph to check (from env or default)
const GRAPH_FILE = process.env.GRAPH_FILE || '';

// Mock external dependencies that IntegrityCheckService touches
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

/**
 * Read a YAML file and return parsed content
 */
function readYaml(filePath: string): any {
  const content = fs.readFileSync(filePath, 'utf-8');
  return yaml.parse(content);
}

/**
 * Read a JSON file and return parsed content
 */
function readJson(filePath: string): any {
  const content = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(content);
}

/**
 * Determine file type from directory name
 */
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

/**
 * Load all entity files from the data repo into fake-indexeddb.
 * If graphFile is specified, only load entities referenced by (or relevant to) that graph.
 * If not, load everything.
 */
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

    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.yaml'));
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
    const graphFiles = fs.readdirSync(graphDir).filter(f => f.endsWith('.json') || f.endsWith('.yaml'));
    
    for (const file of graphFiles) {
      // If a specific graph was requested, only load that one
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

describe('Graph Pre-Flight Check (IntegrityCheckService)', () => {
  beforeEach(async () => {
    await db.files.clear();
    await db.tabs.clear();
    vi.clearAllMocks();
  });

  it('should pass integrity check with no errors', async () => {
    // Skip if data repo doesn't exist
    if (!fs.existsSync(DATA_REPO)) {
      console.log('Skipping: nous-conversion data repo not found');
      return;
    }

    const graphToCheck = GRAPH_FILE || undefined;
    const { graphCount, totalFiles } = await loadDataRepoIntoIdb(graphToCheck);
    
    console.log(`Loaded ${totalFiles} files (${graphCount} graph(s)) into fake-indexeddb`);

    if (graphCount === 0) {
      console.log('No graphs found to check');
      return;
    }

    // Run the production integrity check
    const mockTabOps = {
      tabs: [],
      openFile: async () => {},
      setActiveTab: () => {},
      closeTab: () => {},
    };

    const result = await IntegrityCheckService.checkIntegrity(mockTabOps as any, false);

    // Report results
    console.log(`\n=== Integrity Check Results ===`);
    console.log(`Total files checked: ${result.totalFiles}`);
    console.log(`Errors: ${result.summary.errors}`);
    console.log(`Warnings: ${result.summary.warnings}`);
    console.log(`Info: ${result.summary.info}`);
    console.log(`\nBy category:`);
    for (const [cat, count] of Object.entries(result.summary.byCategory)) {
      if (count > 0) console.log(`  ${cat}: ${count}`);
    }

    // Show errors in detail
    const errors = result.issues.filter(i => i.severity === 'error');
    if (errors.length > 0) {
      console.log(`\n=== ERRORS (${errors.length}) ===`);
      for (const err of errors) {
        const target = graphToCheck ? '' : ` [${err.fileId}]`;
        console.log(`  ${err.category}${target}: ${err.message}`);
        if (err.suggestion) console.log(`    Suggestion: ${err.suggestion}`);
      }
    }

    // Show warnings (limited)
    const warnings = result.issues.filter(i => i.severity === 'warning');
    if (warnings.length > 0) {
      console.log(`\n=== WARNINGS (${warnings.length}) ===`);
      for (const w of warnings.slice(0, 20)) {
        const target = graphToCheck ? '' : ` [${w.fileId}]`;
        console.log(`  ${w.category}${target}: ${w.message}`);
      }
      if (warnings.length > 20) {
        console.log(`  ... and ${warnings.length - 20} more`);
      }
    }

    // The test passes if there are no ERRORS (warnings are advisory)
    // Filter to only errors on the graph we're checking (if specific)
    let relevantErrors = errors;
    if (graphToCheck) {
      const graphId = graphToCheck.replace(/^graphs\//, '').replace(/\.(json|yaml)$/, '');
      // Include errors from the graph file itself + any hif-* entity errors
      relevantErrors = errors.filter(e => 
        e.fileId.includes(graphId) || 
        e.fileId.includes('hif-')
      );
      if (relevantErrors.length !== errors.length) {
        console.log(`\n(Filtered from ${errors.length} total errors to ${relevantErrors.length} relevant to ${graphId})`);
      }
    }

    expect(relevantErrors.length).toBe(0);
  }, 30_000);
});
