import { db } from '../db/appDatabase';
import yaml from 'js-yaml';
import { fileRegistry } from '../contexts/TabContext';

/**
 * Loads default settings.yaml from public/defaults/
 */
async function loadDefaultSettings(): Promise<any> {
  try {
    const response = await fetch('/defaults/settings.yaml');
    if (!response.ok) {
      throw new Error(`Failed to fetch default settings: ${response.status}`);
    }
    const text = await response.text();
    return yaml.load(text);
  } catch (error) {
    console.error('[seedSettings] Failed to load default settings.yaml:', error);
    // Fallback to minimal structure with safe defaults (schema also provides defaults)
    return {
      version: '1.0.0',
      forecasting: {},
    };
  }
}

/**
 * Seeds settings/settings.yaml - priority: git > local > defaults
 *
 * Rationale:
 * - This file is intended to be shared and versioned (like connections.yaml).
 * - It must be present in IndexedDB so it can be opened/edited in the UI and committed back.
 */
/**
 * Deep-merge defaults into existing data: adds missing keys at every
 * level without overwriting user-edited values. Returns true if any
 * keys were added.
 */
function mergeDefaults(existing: any, defaults: any): boolean {
  if (!defaults || typeof defaults !== 'object' || typeof existing !== 'object') return false;
  let changed = false;
  for (const key of Object.keys(defaults)) {
    if (!(key in existing)) {
      existing[key] = defaults[key];
      changed = true;
    } else if (
      typeof defaults[key] === 'object' && defaults[key] !== null &&
      !Array.isArray(defaults[key]) &&
      typeof existing[key] === 'object' && existing[key] !== null &&
      !Array.isArray(existing[key])
    ) {
      if (mergeDefaults(existing[key], defaults[key])) changed = true;
    }
  }
  return changed;
}

/**
 * Push a file state into the in-memory FileRegistry so the UI doesn't
 * lag behind IDB.  Best-effort: swallows errors to avoid breaking init.
 */
function _syncToFileRegistry(fileId: string, fileState: any): void {
  try {
    const reg = fileRegistry as any;
    if (reg?.files?.set) {
      reg.files.set(fileId, fileState);
      if (typeof reg.notifyListeners === 'function') {
        reg.notifyListeners(fileId, fileState);
      }
    }
  } catch {
    // best-effort — FileRegistry may not be ready during early init
  }
}

export async function seedSettingsFile(): Promise<void> {
  try {
    const fileId = 'settings-settings';
    const existing = await db.files.get(fileId);

    // Policy: never sync repo files from git during app init.
    // Repo content must only be refreshed by explicit pull/automation/user repo change flows.

    const defaultData = await loadDefaultSettings();

    // Case 1: no file or empty — seed from defaults
    const shouldSeedFromDefaults = !existing || (!existing.isDirty && !existing.data);

    if (shouldSeedFromDefaults) {
      console.log('[seedSettings] Creating settings.yaml from defaults');

      const seeded = {
        fileId,
        type: 'settings' as const,
        path: 'settings/settings.yaml',
        data: defaultData,
        lastModified: Date.now(),
        viewTabs: existing?.viewTabs || [],
        isDirty: false,
        originalData: structuredClone(defaultData),
      };
      await db.files.put(seeded);

      // Keep FileRegistry in sync so the UI sees the seeded data immediately
      _syncToFileRegistry(fileId, seeded);

      console.log('[seedSettings] ✅ settings.yaml created from defaults');
    } else if (existing?.data && defaultData) {
      // Case 2: file exists — merge new default keys without
      // overwriting user-edited values. This ensures new settings
      // (e.g. Bayes model priors) appear in the file automatically.
      const merged = structuredClone(existing.data);
      const added = mergeDefaults(merged, defaultData);
      if (added) {
        console.log('[seedSettings] Merging new default keys into existing settings.yaml');

        // Also merge into originalData so the added defaults don't look like
        // local edits to the 3-way merge during the next git pull.
        const mergedOriginal = existing.originalData
          ? structuredClone(existing.originalData)
          : structuredClone(merged);
        if (existing.originalData) {
          mergeDefaults(mergedOriginal, defaultData);
        }

        const updated = {
          ...existing,
          data: merged,
          originalData: mergedOriginal,
          lastModified: Date.now(),
        };
        await db.files.put(updated);

        // Keep FileRegistry in sync so the UI sees merged keys immediately
        _syncToFileRegistry(fileId, updated);

        console.log('[seedSettings] ✅ settings.yaml updated with new defaults');
      } else {
        console.log('[seedSettings] settings.yaml up to date, no new keys');
      }
    } else {
      console.log('[seedSettings] settings.yaml already exists, skipping seed');
    }
  } catch (error) {
    console.error('[seedSettings] Failed to seed settings.yaml:', error);
  }
}

/**
 * Re-merge default keys into the settings file after a git pull.
 *
 * Git pull can overwrite the IDB settings file with the repo version,
 * which may lack newly-added default keys (e.g. Bayes settings).
 * Call this after every successful pull to restore any missing defaults.
 *
 * Exported separately so repositoryOperationsService can call it without
 * re-fetching the defaults template (we always re-fetch because the
 * template may have been updated by HMR).
 */
export async function mergeSettingsDefaults(): Promise<void> {
  try {
    const fileId = 'settings-settings';
    const existing = await db.files.get(fileId);
    if (!existing?.data) return;

    const defaultData = await loadDefaultSettings();
    if (!defaultData) return;

    const merged = structuredClone(existing.data);
    const added = mergeDefaults(merged, defaultData);
    if (!added) return;

    console.log('[seedSettings] Post-pull: re-merging default keys into settings.yaml');

    // Mirror the originalData merge so added defaults don't trigger false
    // dirty detection on subsequent pulls.
    const mergedOriginal = existing.originalData
      ? structuredClone(existing.originalData)
      : structuredClone(merged);
    if (existing.originalData) {
      mergeDefaults(mergedOriginal, defaultData);
    }

    const updated = {
      ...existing,
      data: merged,
      originalData: mergedOriginal,
      lastModified: Date.now(),
    };
    await db.files.put(updated);
    _syncToFileRegistry(fileId, updated);

    console.log('[seedSettings] ✅ Post-pull: settings.yaml updated with new defaults');
  } catch (error) {
    console.error('[seedSettings] Post-pull merge failed:', error);
  }
}

// Export mergeDefaults for testing
export { mergeDefaults as _mergeDefaults };
