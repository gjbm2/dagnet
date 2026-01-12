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
export async function seedSettingsFile(): Promise<void> {
  try {
    const fileId = 'settings-settings';
    const existing = await db.files.get(fileId);

    // Policy: never sync repo files from git during app init.
    // Repo content must only be refreshed by explicit pull/automation/user repo change flows.

    // Fallback: defaults (if missing, or present-but-empty and not dirty)
    const defaultData = await loadDefaultSettings();
    const shouldSeedFromDefaults = !existing || (!existing.isDirty && !existing.data);

    if (shouldSeedFromDefaults) {
      console.log('[seedSettings] Creating settings.yaml from defaults');

      await db.files.put({
        fileId,
        type: 'settings',
        // Ensure this seed is commit-able if the repo is missing the file (and avoids commit crashes due to missing path).
        // Source (repo/branch) is intentionally unset during init; it will be populated by pull/clone flows.
        path: 'settings/settings.yaml',
        data: defaultData,
        lastModified: Date.now(),
        viewTabs: existing?.viewTabs || [],
        isDirty: false,
        originalData: defaultData,
        // Intentionally no repo source: this is a local default seed until repo selection/pull populates source.
      });

      console.log('[seedSettings] ✅ settings.yaml created from defaults');
    } else {
      console.log('[seedSettings] settings.yaml already exists, skipping seed');
    }
  } catch (error) {
    console.error('[seedSettings] Failed to seed settings.yaml:', error);
  }
}


