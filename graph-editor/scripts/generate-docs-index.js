#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DOCS_DIR = path.join(__dirname, '..', 'src', 'docs');
const INDEX_FILE = path.join(DOCS_DIR, 'index.json');

console.log('Generating documentation index...');

// Get all .md files except excluded ones
const excludedFiles = ['about.md', 'keyboard-shortcuts.md', 'index.json'];

try {
  const files = fs.readdirSync(DOCS_DIR)
    .filter(file => file.endsWith('.md'))
    .filter(file => !excludedFiles.includes(file))
    .sort();

  const indexData = {
    files: files,
    exclude: excludedFiles,
    generated_at: new Date().toISOString()
  };

  fs.writeFileSync(INDEX_FILE, JSON.stringify(indexData, null, 2));

  console.log(`Generated ${INDEX_FILE} with ${files.length} documentation files:`);
  files.forEach(file => console.log(`  - ${file}`));
} catch (error) {
  console.error('Error generating docs index:', error);
  process.exit(1);
}
