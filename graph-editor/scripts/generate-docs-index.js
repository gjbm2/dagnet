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

// Files excluded from index (still accessible, just not listed in doc browser)
const excludedFiles = ['index.json'];

// Category labels for subdirectories
const categoryLabels = {
  'dev': 'Developer Documentation',
  'workshops': 'Workshop'
};

try {
  // Ensure public/docs directory exists
  if (!fs.existsSync(PUBLIC_DOCS_DIR)) {
    fs.mkdirSync(PUBLIC_DOCS_DIR, { recursive: true });
  }

  // Copy all markdown files from src/docs to public/docs
  if (fs.existsSync(SRC_DOCS_DIR)) {
    const srcFiles = fs.readdirSync(SRC_DOCS_DIR)
      .filter(file => file.endsWith('.md'));
    
    srcFiles.forEach(file => {
      const srcPath = path.join(SRC_DOCS_DIR, file);
      const destPath = path.join(PUBLIC_DOCS_DIR, file);
      fs.copyFileSync(srcPath, destPath);
    });
    console.log(`Copied ${srcFiles.length} files from src/docs to public/docs`);
  }

  // Scan public/docs for ALL markdown files at root level
  const rootFiles = fs.readdirSync(PUBLIC_DOCS_DIR)
    .filter(file => file.endsWith('.md'))
    .filter(file => !excludedFiles.includes(file))
    .sort();

  // Scan subdirectories for categorised docs
  const categories = {};
  const subdirs = fs.readdirSync(PUBLIC_DOCS_DIR, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name)
    .sort();

  subdirs.forEach(subdir => {
    const subdirPath = path.join(PUBLIC_DOCS_DIR, subdir);
    const subdirFiles = fs.readdirSync(subdirPath)
      .filter(file => file.endsWith('.md'))
      .sort()
      .map(file => `${subdir}/${file}`);
    
    if (subdirFiles.length > 0) {
      categories[subdir] = {
        label: categoryLabels[subdir] || subdir,
        files: subdirFiles
      };
    }
  });

  const indexData = {
    files: rootFiles,
    categories: categories,
    exclude: excludedFiles,
    generated_at: new Date().toISOString()
  };

  // Avoid churn: only rewrite index.json if the meaningful contents changed.
  // (generated_at is intentionally ignored for this comparison.)
  const stableIndexData = {
    files: indexData.files,
    categories: indexData.categories,
    exclude: indexData.exclude
  };

  let existingStable = null;
  if (fs.existsSync(INDEX_FILE)) {
    try {
      const existing = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
      existingStable = {
        files: existing.files || [],
        categories: existing.categories || {},
        exclude: existing.exclude || []
      };
    } catch {
      // If the existing file is malformed, we'll overwrite it below.
      existingStable = null;
    }
  }

  if (existingStable && JSON.stringify(existingStable) === JSON.stringify(stableIndexData)) {
    console.log('Docs index unchanged; skipping write.');
  } else {
    fs.writeFileSync(INDEX_FILE, JSON.stringify(indexData, null, 2));
  }

  const totalFiles = rootFiles.length + Object.values(categories).reduce((sum, cat) => sum + cat.files.length, 0);
  console.log(`Generated ${INDEX_FILE} with ${totalFiles} documentation files:`);
  console.log(`  Root: ${rootFiles.length} files`);
  rootFiles.forEach(file => console.log(`    - ${file}`));
  Object.entries(categories).forEach(([cat, data]) => {
    console.log(`  ${data.label}: ${data.files.length} files`);
    data.files.forEach(file => console.log(`    - ${file}`));
  });
} catch (error) {
  console.error('Error generating docs index:', error);
  process.exit(1);
}
