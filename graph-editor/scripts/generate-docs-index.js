#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SRC_DOCS_DIR = path.join(__dirname, '..', 'src', 'docs');
const PUBLIC_DOCS_DIR = path.join(__dirname, '..', 'public', 'docs');
const INDEX_FILE = path.join(PUBLIC_DOCS_DIR, 'index.json');

console.log('Generating documentation index...');

// Get all .md files except excluded ones
const excludedFiles = ['about.md', 'keyboard-shortcuts.md', 'index.json'];

try {
  // Ensure public/docs directory exists
  if (!fs.existsSync(PUBLIC_DOCS_DIR)) {
    fs.mkdirSync(PUBLIC_DOCS_DIR, { recursive: true });
  }

  // Get all markdown files from src/docs
  const files = fs.readdirSync(SRC_DOCS_DIR)
    .filter(file => file.endsWith('.md'))
    .filter(file => !excludedFiles.includes(file))
    .sort();

  // Copy all markdown files to public/docs (including excluded ones)
  const allMdFiles = fs.readdirSync(SRC_DOCS_DIR)
    .filter(file => file.endsWith('.md'));
  
  allMdFiles.forEach(file => {
    const srcPath = path.join(SRC_DOCS_DIR, file);
    const destPath = path.join(PUBLIC_DOCS_DIR, file);
    fs.copyFileSync(srcPath, destPath);
  });

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
