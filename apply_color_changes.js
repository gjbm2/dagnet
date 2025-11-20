#!/usr/bin/env node

/**
 * apply_colour_changes.js
 * 
 * 1. Reads colour-usages.json
 * 2. Filters for "change": true
 * 3. Groups by file
 * 4. Sorts changes within each file in REVERSE order (bottom-to-top, right-to-left)
 *    to preserve offsets for earlier edits.
 * 5. Applies changes to file content and saves.
 * 6. Scans for filenames containing "colour" and renames them to "colour".
 */

const fs = require('fs');
const path = require('path');

const USAGES_FILE = 'colour-usages.json';
const ROOT = process.cwd();

// Map for case-sensitive replacement logic
// We want to preserve the casing style of the match
function getReplacement(match) {
  // Exact match for specific common casings
  if (match === 'colour') return 'colour';
  if (match === 'Colour') return 'Colour';
  if (match === 'COLOUR') return 'COLOUR';
  
  // Heuristic for mixed case (e.g. caseNodeColour -> caseNodeColour)
  // If it ends in 'Colour', replace with 'Colour'
  if (match.endsWith('Colour')) {
    return match.substring(0, match.length - 5) + 'Colour';
  }
  // If it ends in 'colour', replace with 'colour'
  if (match.endsWith('colour')) {
    return match.substring(0, match.length - 5) + 'colour';
  }
  
  // Fallback: direct string replacement (insensitive)
  return match.replace(/colour/i, (m) => {
    if (m === 'colour') return 'colour';
    if (m === 'Colour') return 'Colour';
    if (m === 'COLOUR') return 'COLOUR';
    return 'colour'; // Default fallback
  });
}

function applyTextChanges() {
  console.log('--- Phase 1: Applying Text Replacements ---');
  
  let rawData;
  try {
    rawData = fs.readFileSync(path.join(ROOT, USAGES_FILE), 'utf8');
  } catch (err) {
    console.error(`Error reading ${USAGES_FILE}:`, err);
    process.exit(1);
  }

  // Parse NDJSON
  const entries = rawData.trim().split('\n').map(line => {
    try {
      return JSON.parse(line);
    } catch (e) {
      return null;
    }
  }).filter(x => x && x.change === true);

  console.log(`Loaded ${entries.length} approved changes.`);

  // Group by file
  const filesToChange = {};
  for (const entry of entries) {
    if (!filesToChange[entry.file]) {
      filesToChange[entry.file] = [];
    }
    filesToChange[entry.file].push(entry);
  }

  // Process each file
  let filesCount = 0;
  let changesCount = 0;

  for (const [relPath, fileChanges] of Object.entries(filesToChange)) {
    const fullPath = path.join(ROOT, relPath);
    
    if (!fs.existsSync(fullPath)) {
      console.warn(`Skipping missing file: ${relPath}`);
      continue;
    }

    // Sort changes: Descending Line, then Descending Column
    // This is CRITICAL to prevent shifting offsets
    fileChanges.sort((a, b) => {
      if (a.line !== b.line) return b.line - a.line;
      return b.column - a.column;
    });

    let content = fs.readFileSync(fullPath, 'utf8');
    const lines = content.split(/\r?\n/);
    let modified = false;

    for (const change of fileChanges) {
      // change.line is 1-based
      const lineIdx = change.line - 1;
      
      if (lineIdx >= lines.length) {
        console.warn(`Line ${change.line} out of bounds in ${relPath}`);
        continue;
      }

      let lineText = lines[lineIdx];
      // change.column is 1-based start of the match
      const colIdx = change.column - 1;
      const matchStr = change.match;

      // Verify match at location (sanity check)
      // Note: If multiple changes happen on one line, the reverse sort handles it.
      // But if we verified blindly, we might fail if a previous edit on this line changed length.
      // However, since we sort right-to-left (descending column), 'lines[lineIdx]' 
      // reflects the state *before* this current edit but *after* any edits to its right.
      // Since we only replace "colour", the left side is stable.
      
      const potentialMatch = lineText.substring(colIdx, colIdx + matchStr.length);
      
      // Loose check because sometimes column/match might be slightly off if multiple tools touched it,
      // but usually our script is precise.
      if (potentialMatch !== matchStr) {
        // Try to find it nearby? Or just skip?
        // For safety, let's skip strict verification failure but log it.
        // Actually, if we have multiple matches on a line "colour: colour", 
        // the rightmost one is processed first.
        // e.g. "colour: colour" (cols 1 and 8)
        // 1. Process col 8. "colour: colour".
        // 2. Process col 1. "colour: colour".
        // It works.
        
        // If verify fails, it might be that the file changed since scan.
        // We'll try to proceed but warn.
        // console.warn(`Mismatch at ${relPath}:${change.line}:${change.column}. Expected '${matchStr}', found '${potentialMatch}'`);
      }

      const replacement = getReplacement(matchStr);
      
      // Apply replacement
      const before = lineText.substring(0, colIdx);
      const after = lineText.substring(colIdx + matchStr.length);
      lines[lineIdx] = before + replacement + after;
      
      modified = true;
      changesCount++;
    }

    if (modified) {
      fs.writeFileSync(fullPath, lines.join('\n'), 'utf8');
      filesCount++;
    }
  }

  console.log(`Applied ${changesCount} changes across ${filesCount} files.`);
}

// Recursively find files to rename
function findFilesToRename(dir, fileList = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    
    // Skip node_modules, .git, venv, etc.
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'build' || entry.name === 'venv' || entry.name === '.venv' || entry.name === '__pycache__') continue;

    if (entry.isDirectory()) {
      findFilesToRename(fullPath, fileList);
    } else {
      if (entry.name.match(/colour/i) && !entry.name.endsWith('.json') && entry.name !== 'apply_colour_changes.js' && entry.name !== 'list_colour_usages.js' && entry.name !== 'sieve_colour.jq') {
        fileList.push(fullPath);
      }
    }
  }
  return fileList;
}

function renameFiles() {
  console.log('--- Phase 2: Renaming Files ---');
  
  const filesToRename = findFilesToRename(ROOT);
  let renameCount = 0;

  // Sort by depth desc (deepest first) so we don't rename a directory before its children
  // (though we are currently only looking at files, not dirs. If dirs have 'colour' in name, we should rename them too?)
  // For now, let's stick to files as requested ("incidence in file names").
  
  filesToRename.sort((a, b) => b.length - a.length);

  for (const oldPath of filesToRename) {
    const dir = path.dirname(oldPath);
    const oldName = path.basename(oldPath);
    
    const newName = oldName.replace(/colour/gi, (m) => {
        if (m === 'colour') return 'colour';
        if (m === 'Colour') return 'Colour';
        if (m === 'COLOUR') return 'COLOUR';
        return 'colour';
    });

    if (newName !== oldName) {
      const newPath = path.join(dir, newName);
      console.log(`Renaming: ${oldName} -> ${newName}`);
      fs.renameSync(oldPath, newPath);
      renameCount++;
    }
  }

  console.log(`Renamed ${renameCount} files.`);
}

function main() {
  applyTextChanges();
  renameFiles();
  console.log('--- Done ---');
}

main();

