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

// ---------------------------------------------------------------------------
// JSON-aware structural 3-way merge
//
// Merges parsed JSON objects key-by-key, recursing into nested objects.
// Different keys added/modified by different sides auto-merge without conflict.
// Arrays and primitives are atomic (one-side-wins or conflict).
//
// Prior art: BitSquid 3-way JSON merge philosophy, trimerge (npm).
// ---------------------------------------------------------------------------

export interface JsonKeyConflict {
  /** Dot-separated path to the conflicting key (e.g. ["_bayes", "posteriors"]) */
  path: string[];
  base: unknown;
  local: unknown;
  remote: unknown;
}

export interface JsonMergeResult {
  /** The merged object. Conflicting keys use the LOCAL value as default. */
  merged: any;
  conflicts: JsonKeyConflict[];
  hasConflicts: boolean;
}

/**
 * Graph-specific key ownership policies.
 *
 * Certain top-level keys have known ownership and should never conflict:
 * - `_bayes`: written exclusively by the Bayes service → remote always wins.
 * - `canvasAnalyses`: local-only UI state (canvas charts) → local always wins.
 *   Remote never intentionally deletes these; their absence from a remote commit
 *   just means the remote codepath doesn't know about them.
 */
const REMOTE_WINS_KEYS = new Set(['_bayes']);

/**
 * Structural 3-way merge for parsed JSON objects.
 *
 * Rules (BitSquid-style):
 * - Objects: recurse key-by-key. Different keys auto-merge.
 * - Arrays/primitives: atomic. One-side-wins or conflict.
 * - Key added by one side only: keep the addition.
 * - Key deleted by one side, unchanged by other: delete.
 * - Key deleted by one side, modified by other: conflict.
 * - Both sides modify same key to same value: keep it.
 * - Both sides modify same key to different values: recurse if both objects, else conflict.
 * - Domain-specific policies override generic rules for known keys.
 */
export function mergeJson3Way(base: any, local: any, remote: any): JsonMergeResult {
  const conflicts: JsonKeyConflict[] = [];
  // Top-level merge must go through mergeObjects to apply ownership policies,
  // even when one side is "unchanged" from base (which would normally short-circuit).
  const merged = (isPlainObject(base) || base == null) && isPlainObject(local) && isPlainObject(remote)
    ? mergeObjects(base as Record<string, unknown> ?? {}, local, remote, [], conflicts)
    : mergeValue(base, local, remote, [], conflicts);
  return { merged, conflicts, hasConflicts: conflicts.length > 0 };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, (b as any[])[i]));
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(k => Object.prototype.hasOwnProperty.call(bObj, k) && deepEqual(aObj[k], bObj[k]));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function mergeValue(
  base: unknown,
  local: unknown,
  remote: unknown,
  path: string[],
  conflicts: JsonKeyConflict[],
): unknown {
  const baseChanged = !deepEqual(base, local);
  const remoteChanged = !deepEqual(base, remote);

  // Neither side changed → keep base.
  if (!baseChanged && !remoteChanged) return base;

  // Only local changed → take local.
  if (baseChanged && !remoteChanged) return local;

  // Only remote changed → take remote.
  if (!baseChanged && remoteChanged) return remote;

  // Both changed to the same value → keep it.
  if (deepEqual(local, remote)) return local;

  // Both changed to different values.
  // If both are objects, recurse key-by-key.
  if (isPlainObject(base) && isPlainObject(local) && isPlainObject(remote)) {
    return mergeObjects(base, local, remote, path, conflicts);
  }

  // Arrays of objects with identity keys (uuid, id) — merge element-by-element.
  if (Array.isArray(base) && Array.isArray(local) && Array.isArray(remote)) {
    const idKey = detectIdKey(base) || detectIdKey(local) || detectIdKey(remote);
    if (idKey) {
      return mergeArrayById(base, local, remote, idKey, path, conflicts);
    }
  }

  // Auto-resolve timestamp fields: take the most recent value.
  const leafKey = path[path.length - 1];
  if (leafKey && /^(updated_at|lastModified|modified_at|created_at)$/i.test(leafKey)) {
    const localTime = typeof local === 'string' ? Date.parse(local) : typeof local === 'number' ? local : 0;
    const remoteTime = typeof remote === 'string' ? Date.parse(remote) : typeof remote === 'number' ? remote : 0;
    return localTime >= remoteTime ? local : remote;
  }

  // Atomic conflict (arrays without IDs, primitives, type changes).
  // Default to local; record the conflict.
  conflicts.push({ path: [...path], base, local, remote });
  return local;
}

function mergeObjects(
  base: Record<string, unknown>,
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
  path: string[],
  conflicts: JsonKeyConflict[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const allKeys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);

  for (const key of allKeys) {
    const inBase = Object.prototype.hasOwnProperty.call(base, key);
    const inLocal = Object.prototype.hasOwnProperty.call(local, key);
    const inRemote = Object.prototype.hasOwnProperty.call(remote, key);

    // Domain-specific ownership policies (top-level keys only).
    if (path.length === 0) {
      if (REMOTE_WINS_KEYS.has(key)) {
        if (inRemote) result[key] = remote[key];
        // If not in remote, omit (remote is authoritative).
        continue;
      }
    }

    if (!inBase && inLocal && !inRemote) {
      // Added by local only → keep.
      result[key] = local[key];
    } else if (!inBase && !inLocal && inRemote) {
      // Added by remote only → keep.
      result[key] = remote[key];
    } else if (!inBase && inLocal && inRemote) {
      // Added by both → recurse/compare.
      result[key] = mergeValue(undefined, local[key], remote[key], [...path, key], conflicts);
    } else if (inBase && !inLocal && !inRemote) {
      // Deleted by both → omit.
    } else if (inBase && !inLocal && inRemote) {
      // Deleted by local. If remote unchanged → delete. If remote modified → conflict.
      if (deepEqual(base[key], remote[key])) {
        // Remote didn't touch it; local deleted → omit.
      } else {
        conflicts.push({ path: [...path, key], base: base[key], local: undefined, remote: remote[key] });
        // Omit (favour local deletion), but conflict is recorded.
      }
    } else if (inBase && inLocal && !inRemote) {
      // Deleted by remote. If local unchanged → delete. If local modified → conflict.
      if (deepEqual(base[key], local[key])) {
        // Local didn't touch it; remote deleted → omit.
      } else {
        conflicts.push({ path: [...path, key], base: base[key], local: local[key], remote: undefined });
        result[key] = local[key]; // Favour local modification.
      }
    } else {
      // Key in all three → recurse.
      result[key] = mergeValue(base[key], local[key], remote[key], [...path, key], conflicts);
    }
  }

  return result;
}

/** Detect an identity key (uuid, id) shared by all objects in an array. */
function detectIdKey(arr: unknown[]): string | null {
  if (arr.length === 0) return null;
  for (const candidate of ['uuid', 'id']) {
    if (arr.every(item => isPlainObject(item) && typeof (item as any)[candidate] === 'string')) {
      return candidate;
    }
  }
  return null;
}

/**
 * Merge arrays of objects by identity key (BitSquid approach).
 * Match elements by ID, merge each pair structurally, add new elements from either side.
 */
function mergeArrayById(
  base: unknown[],
  local: unknown[],
  remote: unknown[],
  idKey: string,
  path: string[],
  conflicts: JsonKeyConflict[],
): unknown[] {
  const baseMap = new Map<string, Record<string, unknown>>();
  const localMap = new Map<string, Record<string, unknown>>();
  const remoteMap = new Map<string, Record<string, unknown>>();

  for (const item of base) if (isPlainObject(item)) baseMap.set((item as any)[idKey], item);
  for (const item of local) if (isPlainObject(item)) localMap.set((item as any)[idKey], item);
  for (const item of remote) if (isPlainObject(item)) remoteMap.set((item as any)[idKey], item);

  const allIds = new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()]);
  const result: unknown[] = [];

  // Preserve local ordering as the primary order, then append new remote-only items.
  const orderedIds: string[] = [];
  for (const item of local) {
    if (isPlainObject(item)) orderedIds.push((item as any)[idKey]);
  }
  // Add remote-only IDs at the end.
  for (const id of allIds) {
    if (!orderedIds.includes(id)) orderedIds.push(id);
  }

  for (const id of orderedIds) {
    const inBase = baseMap.has(id);
    const inLocal = localMap.has(id);
    const inRemote = remoteMap.has(id);

    if (!inBase && inLocal && !inRemote) {
      // Added by local only → keep.
      result.push(localMap.get(id)!);
    } else if (!inBase && !inLocal && inRemote) {
      // Added by remote only → keep.
      result.push(remoteMap.get(id)!);
    } else if (!inBase && inLocal && inRemote) {
      // Added by both → merge the two.
      result.push(mergeValue(undefined, localMap.get(id)!, remoteMap.get(id)!, [...path, `[${id}]`], conflicts));
    } else if (inBase && !inLocal && !inRemote) {
      // Deleted by both → omit.
    } else if (inBase && !inLocal && inRemote) {
      // Deleted by local. If remote unchanged → delete. If remote modified → conflict.
      if (deepEqual(baseMap.get(id), remoteMap.get(id))) {
        // Remote didn't change it; local deleted → omit.
      } else {
        conflicts.push({ path: [...path, `[${id}]`], base: baseMap.get(id), local: undefined, remote: remoteMap.get(id) });
      }
    } else if (inBase && inLocal && !inRemote) {
      // Deleted by remote. If local unchanged → delete. If local modified → conflict (keep local).
      if (deepEqual(baseMap.get(id), localMap.get(id))) {
        // Local didn't change it; remote deleted → omit.
      } else {
        conflicts.push({ path: [...path, `[${id}]`], base: baseMap.get(id), local: localMap.get(id), remote: undefined });
        result.push(localMap.get(id)!);
      }
    } else if (inBase && inLocal && inRemote) {
      // In all three → recurse on the element.
      const merged = mergeValue(baseMap.get(id)!, localMap.get(id)!, remoteMap.get(id)!, [...path, `[${id}]`], conflicts);
      result.push(merged);
    }
  }

  return result;
}

