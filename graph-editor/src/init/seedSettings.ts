import { db } from '../db/appDatabase';
import yaml from 'js-yaml';

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

      await db.files.put({
        fileId,
        type: 'settings',
        path: 'settings/settings.yaml',
        data: defaultData,
        lastModified: Date.now(),
        viewTabs: existing?.viewTabs || [],
        isDirty: false,
        originalData: defaultData,
      });

      console.log('[seedSettings] ✅ settings.yaml created from defaults');
    } else if (existing?.data && defaultData) {
      // Case 2: file exists — merge new default keys without
      // overwriting user-edited values. This ensures new settings
      // (e.g. Bayes model priors) appear in the file automatically.
      const merged = structuredClone(existing.data);
      const added = mergeDefaults(merged, defaultData);
      if (added) {
        console.log('[seedSettings] Merging new default keys into existing settings.yaml');
        await db.files.put({
          ...existing,
          data: merged,
          lastModified: Date.now(),
        });
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


