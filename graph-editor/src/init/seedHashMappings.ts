import { db } from '../db/appDatabase';

/** Empty hash-mappings.json default structure. */
const DEFAULT_HASH_MAPPINGS = {
  version: 1,
  mappings: [],
};

/**
 * Seeds hash-mappings.json — priority: git > local > defaults
 *
 * Rationale:
 * - This file stores pairwise equivalence links between core hashes.
 * - It is versioned in git and committed like other repo files.
 * - It must be present in IndexedDB so hashMappingsService can read it
 *   and Snapshot Manager can edit it.
 */
export async function seedHashMappingsFile(): Promise<void> {
  try {
    const fileId = 'hash-mappings';
    const existing = await db.files.get(fileId);

    // Policy: never sync repo files from git during app init.
    // Repo content must only be refreshed by explicit pull/automation/user repo change flows.

    // Seed from defaults if missing, or present-but-empty and not dirty.
    const shouldSeedFromDefaults = !existing || (!existing.isDirty && !existing.data);

    if (shouldSeedFromDefaults) {
      console.log('[seedHashMappings] Creating hash-mappings.json from defaults');

      const defaultData = structuredClone(DEFAULT_HASH_MAPPINGS);

      await db.files.put({
        fileId,
        type: 'hash-mappings',
        // Repo-root path so it is commit-able and recognisable by pull/clone.
        // Source (repo/branch) is intentionally unset during init; populated by pull/clone flows.
        path: 'hash-mappings.json',
        data: defaultData,
        lastModified: Date.now(),
        viewTabs: existing?.viewTabs || [],
        isDirty: false,
        originalData: structuredClone(defaultData),
      });

      console.log('[seedHashMappings] hash-mappings.json created from defaults');
    } else {
      console.log('[seedHashMappings] hash-mappings.json already exists, skipping seed');
    }
  } catch (error) {
    console.error('[seedHashMappings] Failed to seed hash-mappings.json:', error);
  }
}
