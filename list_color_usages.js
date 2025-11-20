#!/usr/bin/env node

/**
 * list_color_usages.js
 *
 * Scans the repository for every occurrence of the alpha string "color"
 * (case-insensitive) and writes a JSON file with one entry per match.
 *
 * Output file: color-usages.json at the repo root.
 *
 * Each entry looks like:
 * {
 *   "change": true,
 *   "id": "1",
 *   "file": "graph-editor/src/types/index.ts",
 *   "line": 456,
 *   "column": 10,
 *   "match": "color",
 *   "context": "  color?: string; // hex color"
 * }
 *
 * You can then manually review / annotate this JSON and drive a second pass
 * that applies only the replacements you explicitly approve.
 */

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();

/** Directories to skip entirely */
const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'coverage',
  '.turbo',
  '.next',
  'tmp_slowpath'
]);

/** File extensions we care about */
const ALLOWED_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.json',
  '.yaml',
  '.yml',
  '.md',
  '.mdx'
]);

/** Specific files to skip even if extension matches */
const EXCLUDED_FILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'color-usages.json'  // Don't scan our own output!
]);

/** Maximum length of the context line we store in JSON */
const MAX_CONTEXT_LENGTH = 200;

/**
 * Recursively walk the directory tree starting at `dir`,
 * calling `onFile(fullPath)` for each file we care about.
 */
function walk(dir, onFile) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // Ignore unreadable directories (permissions, etc.)
    return;
  }

  for (const entry of entries) {
    const name = entry.name;

    // Skip excluded directories
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(name)) continue;
      walk(path.join(dir, name), onFile);
      continue;
    }

    if (!entry.isFile()) continue;

    if (EXCLUDED_FILES.has(name)) continue;

    const ext = path.extname(name);
    if (!ALLOWED_EXTS.has(ext)) continue;

    onFile(path.join(dir, name));
  }
}

/**
 * Analyze a single file for all case-insensitive occurrences of "color".
 * Returns an array of match descriptors for this file.
 * Line numbers are 1-based and reset for each file.
 */
function analyzeFile(filePath, nextIdRef) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    // Ignore unreadable files
    return [];
  }

  const relPath = path.relative(ROOT, filePath);
  const lines = text.split(/\r?\n/);
  const results = [];

  // Case-insensitive global regex
  const regex = /color/gi;

  // Process each line independently - line numbers start at 1 for each file
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const lineText = lines[lineIndex];
    const lineNumber = lineIndex + 1; // 1-based line number
    
    // Reset regex lastIndex for each line
    regex.lastIndex = 0;
    
    let match;
    while ((match = regex.exec(lineText)) !== null) {
      const column = match.index + 1; // 1-based column
      const matchedText = match[0]; // Preserve actual casing (color, Color, COLOR, etc.)
      
      let context = lineText;
      if (context.length > MAX_CONTEXT_LENGTH) {
        context = context.slice(0, MAX_CONTEXT_LENGTH) + '…';
      }

      const id = String(nextIdRef.value++);

      results.push({
        change: true, // Default to true - we'll sieve it to false for safe cases
        id,
        file: relPath,
        line: lineNumber,
        column,
        match: matchedText,
        context
      });
    }
  }

  return results;
}

function main() {
  const nextIdRef = { value: 1 };

  const outPath = path.join(ROOT, 'color-usages.json');

  let stream;
  try {
    stream = fs.createWriteStream(outPath, { encoding: 'utf8' });
  } catch (err) {
    console.error('Failed to open color-usages.json for writing:', err);
    process.exit(1);
  }

  let totalMatches = 0;

  walk(ROOT, (filePath) => {
    const matches = analyzeFile(filePath, nextIdRef);
    if (matches.length > 0) {
      for (const m of matches) {
        stream.write(JSON.stringify(m) + '\n');
        totalMatches++;
      }
    }
  });

  try {
    stream.end();
  } catch (err) {
    console.error('Failed to write color-usages.json:', err);
    process.exit(1);
  }

  console.error(`Wrote ${totalMatches} entries to ${outPath} (one JSON object per line)`);
  console.error(`Each entry defaults to "change": true - use sieve_color.jq to flip safe cases to false`);
}

if (require.main === module) {
  main();
}
