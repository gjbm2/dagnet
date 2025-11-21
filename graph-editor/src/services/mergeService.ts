/**
 * Merge Service
 * 
 * Implements line-level 3-way merge for pull operations.
 * Similar to git merge - compares base (original), local (current), and remote (incoming).
 */

export interface MergeResult {
  success: boolean;
  merged?: string;
  conflicts?: MergeConflict[];
  hasConflicts: boolean;
}

export interface MergeConflict {
  startLine: number;
  endLine: number;
  base: string[];
  local: string[];
  remote: string[];
}

/**
 * Perform 3-way merge at line level
 * 
 * @param base - Original version (before local changes)
 * @param local - Current version (with local changes)
 * @param remote - Incoming version (from pull)
 * @returns Merge result with merged content or conflicts
 */
export function merge3Way(base: string, local: string, remote: string): MergeResult {
  const baseLines = base.split('\n');
  const localLines = local.split('\n');
  const remoteLines = remote.split('\n');

  const result: string[] = [];
  const conflicts: MergeConflict[] = [];

  // Compute diffs for both local and remote against base
  const localChanges = computeDiff(baseLines, localLines);
  const remoteChanges = computeDiff(baseLines, remoteLines);

  // Build a sorted list of all changes
  const allChanges: Array<{ type: 'local' | 'remote' | 'both', change: DiffChange, remoteChange?: DiffChange}> = [];
  
  for (const lc of localChanges) {
    const rc = remoteChanges.find(r => r.baseStart === lc.baseStart);
    if (rc) {
      allChanges.push({ type: 'both', change: lc, remoteChange: rc });
    } else {
      allChanges.push({ type: 'local', change: lc });
    }
  }
  
  for (const rc of remoteChanges) {
    const lc = localChanges.find(l => l.baseStart === rc.baseStart);
    if (!lc) {
      allChanges.push({ type: 'remote', change: rc });
    }
  }
  
  allChanges.sort((a, b) => a.change.baseStart - b.change.baseStart);

  // Apply changes in order
  let baseIdx = 0;

  for (const item of allChanges) {
    // Add unchanged lines before this change
    while (baseIdx < item.change.baseStart) {
      result.push(baseLines[baseIdx]);
      baseIdx++;
    }

    if (item.type === 'local') {
      // Only local changed
      const content = localLines.slice(item.change.modStart, item.change.modStart + item.change.modLength);
      result.push(...content);
      baseIdx = item.change.baseStart + item.change.baseLength;
    } else if (item.type === 'remote') {
      // Only remote changed
      const content = remoteLines.slice(item.change.modStart, item.change.modStart + item.change.modLength);
      result.push(...content);
      baseIdx = item.change.baseStart + item.change.baseLength;
    } else {
      // Both changed
      const localContent = localLines.slice(item.change.modStart, item.change.modStart + item.change.modLength);
      const remoteContent = remoteLines.slice(item.remoteChange!.modStart, item.remoteChange!.modStart + item.remoteChange!.modLength);

      if (arraysEqual(localContent, remoteContent)) {
        // Same change
        result.push(...localContent);
      } else {
        // CONFLICT!
        const baseContent = baseLines.slice(item.change.baseStart, item.change.baseStart + item.change.baseLength);
        
        conflicts.push({
          startLine: result.length,
          endLine: result.length,
          base: baseContent,
          local: localContent,
          remote: remoteContent
        });

        result.push('<<<<<<< LOCAL');
        result.push(...localContent);
        result.push('=======');
        result.push(...remoteContent);
        result.push('>>>>>>> REMOTE');
      }
      
      baseIdx = item.change.baseStart + item.change.baseLength;
    }
  }

  // Add remaining unchanged lines
  while (baseIdx < baseLines.length) {
    result.push(baseLines[baseIdx]);
    baseIdx++;
  }

  return {
    success: conflicts.length === 0,
    merged: result.join('\n'),
    conflicts: conflicts.length > 0 ? conflicts : undefined,
    hasConflicts: conflicts.length > 0
  };
}

interface DiffChange {
  baseStart: number;
  baseLength: number;
  modStart: number;
  modLength: number;
}

/**
 * Compute diff between two versions (simplified Myers algorithm)
 */
function computeDiff(base: string[], modified: string[]): DiffChange[] {
  const changes: DiffChange[] = [];
  let baseIdx = 0;
  let modIdx = 0;

  while (baseIdx < base.length || modIdx < modified.length) {
    // Find next difference
    while (baseIdx < base.length && modIdx < modified.length && base[baseIdx] === modified[modIdx]) {
      baseIdx++;
      modIdx++;
    }

    if (baseIdx >= base.length && modIdx >= modified.length) {
      break;
    }

    // Found a difference - find the extent
    const changeBaseStart = baseIdx;
    const changeModStart = modIdx;
    let changeBaseEnd = baseIdx;
    let changeModEnd = modIdx;

    // Look ahead to find where they sync up again
    let foundSync = false;
    for (let lookAhead = 1; lookAhead <= 10 && !foundSync; lookAhead++) {
      for (let baseOffset = 0; baseOffset <= lookAhead; baseOffset++) {
        const modOffset = lookAhead - baseOffset;
        if (
          baseIdx + baseOffset < base.length &&
          modIdx + modOffset < modified.length &&
          base[baseIdx + baseOffset] === modified[modIdx + modOffset]
        ) {
          changeBaseEnd = baseIdx + baseOffset;
          changeModEnd = modIdx + modOffset;
          foundSync = true;
          break;
        }
      }
    }

    if (!foundSync) {
      // No sync found - consume rest
      changeBaseEnd = base.length;
      changeModEnd = modified.length;
    }

    changes.push({
      baseStart: changeBaseStart,
      baseLength: changeBaseEnd - changeBaseStart,
      modStart: changeModStart,
      modLength: changeModEnd - changeModStart
    });

    baseIdx = changeBaseEnd;
    modIdx = changeModEnd;
  }

  return changes;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Check if file can be auto-merged (no conflicts)
 */
export function canAutoMerge(base: string, local: string, remote: string): boolean {
  const result = merge3Way(base, local, remote);
  return result.success;
}

/**
 * Format conflict for display
 */
export function formatConflict(conflict: MergeConflict): string {
  return [
    '<<<<<<< LOCAL (Your changes)',
    ...conflict.local,
    '=======',
    ...conflict.remote,
    '>>>>>>> REMOTE (Incoming changes)',
    '',
    'BASE (Original):',
    ...conflict.base
  ].join('\n');
}

