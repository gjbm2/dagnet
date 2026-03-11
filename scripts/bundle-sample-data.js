#!/usr/bin/env node
/**
 * Bundle Sample Data
 *
 * Reads param-registry/test/ and generates a single JSON bundle at
 * graph-editor/public/defaults/sample-data-bundle.json.
 *
 * The bundle contains all parsed file data, per-file git blob SHAs, and the
 * commit SHA at generation time.  The "Use sample data" button in the app
 * fetches this bundle and hydrates IndexedDB directly — zero GitHub API calls.
 *
 * Regenerate after editing files in param-registry/test/:
 *   node scripts/bundle-sample-data.js
 *
 * Automatically runs as part of `npm run dev` and `npm run build`.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SAMPLE_DATA_PATH = path.join(REPO_ROOT, 'param-registry', 'test');
const OUTPUT_PATH = path.join(REPO_ROOT, 'graph-editor', 'public', 'defaults', 'sample-data-bundle.json');

const BASE_PATH = 'param-registry/test';

// Graphs that exist as test fixtures but should not appear in the user-facing sample data bundle.
const EXCLUDED_GRAPHS = new Set([
  'ab-bc-smooth-lag-rebalance.json',
]);

// Must match cloneWorkspace directory config (workspaceService.ts line 294-302)
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

function getCommitSha() {
  try {
    return execSync('git rev-parse HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function getBlobSha(filePath) {
  try {
    return execSync(`git hash-object "${filePath}"`, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function parseYaml(content) {
  // Lightweight YAML parsing using js-yaml (available via graph-editor/node_modules)
  // Fall back to a simple require if available
  try {
    const yaml = require(path.join(REPO_ROOT, 'graph-editor', 'node_modules', 'yaml'));
    return yaml.parse(content);
  } catch {
    try {
      const yaml = require('yaml');
      return yaml.parse(content);
    } catch {
      console.error('ERROR: Cannot find yaml parser. Run npm install in graph-editor/ first.');
      process.exit(1);
    }
  }
}

function listFiles(dirPath, extension) {
  if (!fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath)
    .filter(f => f.endsWith(`.${extension}`) && !f.startsWith('.'))
    .sort();
}

function main() {
  const commitSha = getCommitSha();
  const files = [];

  // 1. Directory files (graphs, parameters, contexts, cases, nodes, events)
  for (const dir of DIRECTORIES) {
    const dirPath = path.join(SAMPLE_DATA_PATH, dir.dirName);
    const fileNames = listFiles(dirPath, dir.extension);

    for (const fileName of fileNames) {
      if (dir.type === 'graph' && EXCLUDED_GRAPHS.has(fileName)) continue;
      const filePath = path.join(dirPath, fileName);
      const repoPath = `${BASE_PATH}/${dir.dirName}/${fileName}`;
      const content = fs.readFileSync(filePath, 'utf8');
      const fileNameWithoutExt = fileName.replace(/\.(yaml|yml|json)$/, '');

      // Must match cloneWorkspace fileId logic (workspaceService.ts line 435-439)
      const fileId = `${dir.type}-${fileNameWithoutExt}`;

      let data;
      if (dir.extension === 'json') {
        data = JSON.parse(content);
      } else {
        data = parseYaml(content);
      }

      files.push({
        path: repoPath,
        type: dir.type,
        fileId,
        name: fileName,
        sha: getBlobSha(filePath),
        data,
      });
    }
  }

  // 2. Index files
  for (const idx of INDEX_FILES) {
    const filePath = path.join(SAMPLE_DATA_PATH, idx.fileName);
    if (!fs.existsSync(filePath)) {
      console.warn(`WARNING: Index file not found: ${filePath}`);
      continue;
    }

    const repoPath = `${BASE_PATH}/${idx.fileName}`;
    const content = fs.readFileSync(filePath, 'utf8');

    // Must match cloneWorkspace fileId logic for indexes
    const fileId = `${idx.type}-index`;

    files.push({
      path: repoPath,
      type: idx.type,
      fileId,
      name: idx.fileName,
      sha: getBlobSha(filePath),
      isIndex: true,
      data: parseYaml(content),
    });
  }

  const bundle = {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    commitSha,
    basePath: BASE_PATH,
    files,
  };

  // Ensure output directory exists
  const outputDir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(bundle, null, 2), 'utf8');

  // Summary
  const byType = {};
  for (const f of files) {
    byType[f.type] = (byType[f.type] || 0) + 1;
  }
  const typeSummary = Object.entries(byType).map(([t, c]) => `${t}: ${c}`).join(', ');

  console.log(`[bundle-sample-data] Generated ${OUTPUT_PATH}`);
  console.log(`  ${files.length} files (${typeSummary})`);
  console.log(`  Commit: ${commitSha.substring(0, 8)}`);
  console.log(`  Size: ${(fs.statSync(OUTPUT_PATH).size / 1024).toFixed(1)} KB`);
}

main();
