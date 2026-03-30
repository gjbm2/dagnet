#!/usr/bin/env npx tsx
/**
 * add-mapping — Write a hash-mappings.json entry.
 *
 * Appends an equivalence mapping (old core_hash ↔ new core_hash) to the
 * specified hash-mappings.json file. Validates format and prevents duplicates.
 *
 * Usage:
 *   cd graph-editor
 *   npx tsx scripts/add-mapping.ts \
 *     --mappings path/to/hash-mappings.json \
 *     --old <old_core_hash> \
 *     --new <new_core_hash> \
 *     --reason "description of change"
 *
 * @see docs/current/project-contexts/VARIANT_CONTEXTS_DESIGN.md
 */

import fs from 'fs';
import path from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

const BASE64URL_RE = /^[A-Za-z0-9_-]{10,30}$/;

function validateHash(hash: string, label: string): void {
  if (!hash || !BASE64URL_RE.test(hash)) {
    console.error(`Invalid ${label} hash: '${hash}'. Expected base64url format (10-30 chars).`);
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let mappingsPath = '', oldHash = '', newHash = '', reason = '';

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--mappings': mappingsPath = args[++i]; break;
      case '--old': oldHash = args[++i]; break;
      case '--new': newHash = args[++i]; break;
      case '--reason': reason = args[++i]; break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }

  if (!mappingsPath || !oldHash || !newHash || !reason) {
    console.error('Usage: npx tsx scripts/add-mapping.ts --mappings <path> --old <hash> --new <hash> --reason <text>');
    process.exit(1);
  }

  return { mappingsPath: path.resolve(mappingsPath), oldHash, newHash, reason };
}

function main() {
  const { mappingsPath, oldHash, newHash, reason } = parseArgs();

  validateHash(oldHash, 'old');
  validateHash(newHash, 'new');

  if (oldHash === newHash) {
    console.error('Self-link: old and new hashes are identical. No mapping needed.');
    process.exit(1);
  }

  // Load or create mappings file
  let mappings: { version: number; mappings: any[] };
  if (fs.existsSync(mappingsPath)) {
    mappings = JSON.parse(fs.readFileSync(mappingsPath, 'utf8'));
  } else {
    mappings = { version: 1, mappings: [] };
  }

  // Check for duplicate (either direction)
  const isDuplicate = mappings.mappings.some((m: any) =>
    (m.core_hash === oldHash && m.equivalent_to === newHash) ||
    (m.core_hash === newHash && m.equivalent_to === oldHash)
  );

  if (isDuplicate) {
    console.log(`Mapping already exists: ${oldHash} ↔ ${newHash}. Skipping.`);
    process.exit(0);
  }

  // Append new mapping
  const entry = {
    core_hash: oldHash,
    equivalent_to: newHash,
    operation: 'equivalent',
    weight: 1.0,
    reason,
    created_by: 'cli',
  };

  mappings.mappings.push(entry);

  // Write back
  fs.writeFileSync(mappingsPath, JSON.stringify(mappings, null, 2) + '\n', 'utf8');

  console.log(`Added mapping: ${oldHash} ↔ ${newHash}`);
  console.log(`  reason: ${reason}`);
  console.log(`  file:   ${mappingsPath}`);
  console.log(`  total:  ${mappings.mappings.length} mapping(s)`);
}

main();
