/**
 * Graph Pre-Flight Check — Integration test using production IntegrityCheckService
 *
 * Loads a graph and entity files from the data repo into fake-indexeddb,
 * then runs the production IntegrityCheckService against them — the same
 * machinery that powers the Graph Issues panel in the app.
 *
 * SKIPPED by default (requires data repo on disk, slow). To run explicitly:
 *   GRAPH_PREFLIGHT=1 GRAPH_FILE=graphs/li-cohort-segmentation-v1.json npm test -- --run src/services/__tests__/graphPreflightCheck.test.ts
 *
 * GRAPH_PREFLIGHT=1 is required to enable the test.
 * GRAPH_FILE defaults to graphs/high-intent-flow-v2.json if not set.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import { db } from '../../db/appDatabase';
import { IntegrityCheckService } from '../integrityCheckService';

// ─────────────────────────────────────────────────────────────────────────────
// Setup helpers
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Data loading (fake-indexeddb ← data repo on disk)
// ─────────────────────────────────────────────────────────────────────────────

function readYaml(filePath: string): any {
  return yaml.parse(fs.readFileSync(filePath, 'utf-8'));
}

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

const DIR_TO_TYPE: Record<string, string> = {
  graphs: 'graph',
  nodes: 'node',
  events: 'event',
  parameters: 'parameter',
  contexts: 'context',
  cases: 'case',
};

async function loadDataRepoIntoIdb(graphFile?: string): Promise<{ graphCount: number; totalFiles: number }> {
  let totalFiles = 0;
  let graphCount = 0;

  const entityDirs = ['events', 'nodes', 'parameters', 'contexts', 'cases'];

  for (const dir of entityDirs) {
    const indexPath = path.join(DATA_REPO, `${dir}-index.yaml`);
    if (fs.existsSync(indexPath)) {
      try {
        const data = readYaml(indexPath);
        const type = DIR_TO_TYPE[dir] || dir;
        await db.files.put({
          fileId: `${type}-index`,
          type: type as any,
          data,
          viewTabs: [],
          isDirty: false,
        });
        totalFiles++;
      } catch (e) {
        console.warn(`  WARN: Failed to parse ${dir}-index.yaml: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  for (const dir of entityDirs) {
    const dirPath = path.join(DATA_REPO, dir);
    if (!fs.existsSync(dirPath)) continue;

    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.yaml'));
    for (const file of files) {
      try {
        const filePath = path.join(dirPath, file);
        const data = readYaml(filePath);
        const type = DIR_TO_TYPE[dir] || dir;
        const id = file.replace('.yaml', '');

        await db.files.put({
          fileId: `${type}-${id}`,
          type: type as any,
          data,
          viewTabs: [],
          isDirty: false,
        });
        totalFiles++;
      } catch (e) {
        console.warn(`  WARN: Failed to parse ${dir}/${file}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

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

// ─────────────────────────────────────────────────────────────────────────────
// Quality gate definitions
//
// Same category taxonomy as GraphIssuesViewer's ISSUE_CATEGORY_ORDER.
// Each gate groups related categories and specifies which severities block.
// ─────────────────────────────────────────────────────────────────────────────

interface QualityGate {
  id: string;
  label: string;
  categories: string[];
  blockingSeverities: string[];
}

const QUALITY_GATES: QualityGate[] = [
  {
    id: 'structural',
    label: 'Structural integrity (missing UUIDs, disconnected nodes, absorbing violations)',
    categories: ['graph-structure'],
    blockingSeverities: ['error', 'warning'],
  },
  {
    id: 'duplicate',
    label: 'Duplicate IDs / UUIDs',
    categories: ['duplicate'],
    blockingSeverities: ['error', 'warning'],
  },
  {
    id: 'reference',
    label: 'Referential integrity (broken node, event, parameter, case, context references)',
    categories: ['reference'],
    blockingSeverities: ['error', 'warning'],
  },
  {
    id: 'schema',
    label: 'Schema compliance (required fields, ID formats)',
    categories: ['schema', 'id-format'],
    blockingSeverities: ['error', 'warning'],
  },
  {
    id: 'sync',
    label: 'Data consistency (graph ↔ parameter/case file drift)',
    categories: ['sync'],
    blockingSeverities: ['error', 'warning'],
  },
  {
    id: 'semantic',
    label: 'Semantic evidence (impossible k>n, denominator incoherence, unfetchable bindings)',
    categories: ['semantic'],
    blockingSeverities: ['error', 'warning'],
  },
  {
    id: 'value',
    label: 'Value validity (probability sums >100%, out-of-range values)',
    categories: ['value'],
    blockingSeverities: ['error'],
  },
  {
    id: 'connection',
    label: 'Connection validity (unknown or misconfigured data connections)',
    categories: ['connection'],
    blockingSeverities: ['error', 'warning'],
  },
  {
    id: 'naming',
    label: 'Naming & metadata consistency',
    categories: ['naming', 'metadata'],
    blockingSeverities: ['error', 'warning'],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Formatting helpers — actionable graph issues report (file path, node/edge, details)
// ─────────────────────────────────────────────────────────────────────────────

const SEVERITY_ICON: Record<string, string> = { error: '✖', warning: '⚠', info: 'ℹ' };

/** Map fileId (e.g. parameter-xyz, repo-branch-parameter-xyz) to data-repo path (e.g. parameters/xyz.yaml) */
function fileIdToDataRepoPath(fileId: string): string | null {
  // Match type-id (handles workspace-prefixed fileIds via .* before the type)
  const m = fileId.match(/(?:^|.*-)(graph|parameter|node|event|case|context)-(.+)$/);
  if (m) {
    const [, type, id] = m;
    const dirs: Record<string, string> = { graph: 'graphs', parameter: 'parameters', node: 'nodes', event: 'events', case: 'cases', context: 'contexts' };
    const dir = dirs[type];
    if (!dir) return null;
    const ext = type === 'graph' ? '.json' : '.yaml';
    return `${dir}/${id}${ext}`;
  }
  if (fileId.match(/\b(node|parameter|event|case|context)-index$/)) {
    const type = fileId.replace(/.*-([a-z]+)-index$/, '$1');
    const plural = { node: 'nodes', parameter: 'parameters', event: 'events', case: 'cases', context: 'contexts' }[type];
    return plural ? `${plural}-index.yaml` : null;
  }
  return null;
}

function formatIssue(issue: any): string {
  const icon = SEVERITY_ICON[issue.severity] || '?';
  const relPath = fileIdToDataRepoPath(issue.fileId);
  // Use relative path only (never DATA_REPO_DIR) so report is shareable without revealing private repo name
  const location = relPath ?? issue.fileId;
  const parts: string[] = [
    `  ${icon}  ${location}`,
    issue.field ? `    field: ${issue.field}` : '',
    issue.nodeUuid ? `    node: ${issue.nodeUuid}` : '',
    issue.edgeUuid ? `    edge: ${issue.edgeUuid}` : '',
    `    ${issue.message}`,
    issue.details ? `    details: ${issue.details.replace(/\n/g, '\n       ')}` : '',
    issue.suggestion ? `    → ${issue.suggestion}` : '',
  ].filter(Boolean);
  return parts.join('\n');
}

function formatGateReport(label: string, issues: any[]): string {
  if (issues.length === 0) return '';
  const lines = [`\n── ${label} (${issues.length}) ──`];
  for (const issue of issues) {
    lines.push(formatIssue(issue));
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

const describeIfEnabled = GRAPH_PREFLIGHT_ENABLED ? describe : describe.skip;

describeIfEnabled('Graph Pre-Flight Check (IntegrityCheckService)', () => {
  // Shared state populated by beforeAll — individual tests filter into it.
  let allIssues: any[] = [];
  let relevantIssues: any[] = [];
  let relevantFileIds: Set<string> = new Set();
  let graphId = '';

  beforeAll(async () => {
    if (!DATA_REPO || !fs.existsSync(DATA_REPO)) return;

    await db.files.clear();
    await db.tabs.clear();
    vi.clearAllMocks();

    const graphToCheck = GRAPH_FILE || undefined;
    const { graphCount, totalFiles } = await loadDataRepoIntoIdb(graphToCheck);
    if (graphCount === 0) return;

    graphId = (graphToCheck || '')
      .replace(/^graphs\//, '')
      .replace(/\.(json|yaml)$/, '');

    // Build the set of relevant fileIds using the SAME production method
    // that GraphIssuesService.getFilteredIssues() uses.
    const graphIdbFileId = `graph-${graphId}`;
    const graphRecord = await db.files.get(graphIdbFileId);
    relevantFileIds = IntegrityCheckService.extractGraphReferences(graphRecord?.data);
    relevantFileIds.add(graphIdbFileId);

    console.log(
      `\n╔══════════════════════════════════════════════════════════════╗` +
      `\n║  Pre-flight check: "${graphId}"` +
      `\n║  ${relevantFileIds.size} relevant files (out of ${totalFiles} loaded)` +
      `\n╚══════════════════════════════════════════════════════════════╝\n`
    );

    // Run the production IntegrityCheckService — same call as GraphIssuesService.runCheck()
    const mockTabOps = {
      tabs: [],
      openFile: async () => {},
      setActiveTab: () => {},
      closeTab: () => {},
    };

    const result = await IntegrityCheckService.checkIntegrity(mockTabOps as any, false);

    // Map to GraphIssue shape — same transform as GraphIssuesService.runCheck()
    allIssues = result.issues.map((issue: any, idx: number) => ({
      id: `issue-${Date.now()}-${idx}`,
      fileId: issue.fileId,
      type: issue.type,
      severity: issue.severity,
      category: issue.category,
      message: issue.message,
      field: issue.field,
      suggestion: issue.suggestion,
      details: issue.details,
      nodeUuid: issue.nodeUuid,
      edgeUuid: issue.edgeUuid,
    }));

    // Filter to graph-relevant issues — same logic as GraphIssuesService.getFilteredIssues()
    // with includeReferencedFiles: true
    relevantIssues = allIssues.filter((issue: any) => {
      const fileId = String(issue.fileId || '');

      // Direct graph match (extractGraphName on the issue fileId)
      const issueGraphName = IntegrityCheckService.extractGraphName(fileId);
      if (issueGraphName === graphId) return true;

      // Referenced file match (issue fileId contains one of the reference IDs)
      for (const refId of relevantFileIds) {
        if (fileId.includes(refId)) return true;
      }

      return false;
    });

    const errors = relevantIssues.filter((i: any) => i.severity === 'error').length;
    const warnings = relevantIssues.filter((i: any) => i.severity === 'warning').length;
    const info = relevantIssues.filter((i: any) => i.severity === 'info').length;

    console.log(
      `Total repo issues: ${allIssues.length} | ` +
      `Relevant to "${graphId}": ${relevantIssues.length} ` +
      `(${errors} errors, ${warnings} warnings, ${info} info)\n`
    );
  }, 60_000);

  // ── Quality gate tests ──────────────────────────────────────────────────
  // Each gate filters relevant issues by category + severity and asserts zero.
  // On failure the output shows exactly which issues block the gate.

  for (const gate of QUALITY_GATES) {
    it(`should pass quality gate: ${gate.label}`, () => {
      const blocking = relevantIssues.filter(
        (i: any) =>
          gate.categories.includes(i.category) &&
          gate.blockingSeverities.includes(i.severity)
      );

      if (blocking.length > 0) {
        const report = formatGateReport(gate.label, blocking);
        console.error(report);
      }

      expect(
        blocking.length,
        `${blocking.length} blocking issue(s) in gate "${gate.id}" for graph "${graphId}"`
      ).toBe(0);
    });
  }

  // ── Full report (always passes — writes report file + prints to console) ──

  it('writes full issue report to file', () => {
    const lines: string[] = [];
    const tmpDir = path.join(REPO_ROOT, 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const reportPath = path.join(tmpDir, `${graphId}-preflight-report.txt`);

    lines.push(`Pre-Flight Report: ${graphId}`);
    lines.push(`Report file: ${reportPath}`);
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push(`Relevant files: ${relevantFileIds.size}`);
    lines.push(``);

    // Gate summary table
    const errors = relevantIssues.filter((i: any) => i.severity === 'error').length;
    const warnings = relevantIssues.filter((i: any) => i.severity === 'warning').length;
    const infoCount = relevantIssues.filter((i: any) => i.severity === 'info').length;
    lines.push(`Total: ${relevantIssues.length} issues (${errors} errors, ${warnings} warnings, ${infoCount} info)`);
    lines.push(``);

    lines.push(`QUALITY GATES`);
    lines.push(`─────────────`);
    for (const gate of QUALITY_GATES) {
      const blocking = relevantIssues.filter(
        (i: any) =>
          gate.categories.includes(i.category) &&
          gate.blockingSeverities.includes(i.severity)
      );
      const status = blocking.length === 0 ? 'PASS' : `FAIL (${blocking.length})`;
      lines.push(`  ${blocking.length === 0 ? '✔' : '✖'} ${status.padEnd(12)} ${gate.label}`);
    }
    lines.push(``);

    if (relevantIssues.length === 0) {
      lines.push(`No issues found.`);
    } else {
      // Group by category (same ordering as GraphIssuesViewer)
      const CATEGORY_ORDER = [
        'schema', 'id-format', 'reference', 'graph-structure', 'registry',
        'connection', 'credentials', 'value', 'semantic', 'sync',
        'duplicate', 'orphan', 'naming', 'metadata', 'image',
      ];

      const byCategory = new Map<string, any[]>();
      for (const issue of relevantIssues) {
        const cat = issue.category || 'unknown';
        if (!byCategory.has(cat)) byCategory.set(cat, []);
        byCategory.get(cat)!.push(issue);
      }

      lines.push(`ISSUES BY CATEGORY`);
      lines.push(`══════════════════`);

      const ordered = [...CATEGORY_ORDER, ...Array.from(byCategory.keys()).filter(c => !CATEGORY_ORDER.includes(c))];
      for (const cat of ordered) {
        const issues = byCategory.get(cat);
        if (!issues || issues.length === 0) continue;

        const catErrors = issues.filter((i: any) => i.severity === 'error').length;
        const catWarnings = issues.filter((i: any) => i.severity === 'warning').length;
        const catInfo = issues.filter((i: any) => i.severity === 'info').length;
        const counts = [
          catErrors > 0 ? `${catErrors} errors` : '',
          catWarnings > 0 ? `${catWarnings} warnings` : '',
          catInfo > 0 ? `${catInfo} info` : '',
        ].filter(Boolean).join(', ');

        lines.push(``);
        lines.push(`── ${cat} (${counts}) ──`);
        for (const issue of issues) {
          lines.push(formatIssue(issue));
        }
      }
    }

    const reportText = lines.join('\n') + '\n';

    // Write report to gitignored tmp/ (never commit)
    fs.writeFileSync(reportPath, reportText, 'utf-8');

    // Also print to stdout via process.stdout (bypasses Vitest console capture)
    process.stdout.write(`\n${reportText}`);
    process.stdout.write(`Report written to: ${reportPath}\n\n`);
  });
});
