import { db } from '../db/appDatabase';
import yaml from 'js-yaml';

/**
 * Loads default connections.yaml from public/defaults/
 */
async function loadDefaultConnections(): Promise<any> {
  try {
    const response = await fetch('/defaults/connections.yaml');
    if (!response.ok) {
      throw new Error(`Failed to fetch default connections: ${response.status}`);
    }
    const text = await response.text();
    return yaml.load(text);
  } catch (error) {
    console.error('[seedConnections] Failed to load default connections.yaml:', error);
    // Fallback to minimal empty structure
    return {
      version: '1.0.0',
      connections: []
    };
  }
}

/**
 * Seeds connections.yaml - priority: git > local > defaults
 * Called during app initialization (mirrors credential and registry file loading)
 */
export async function seedConnectionsFile(): Promise<void> {
  try {
    const fileId = 'connections-connections';
    const existing = await db.files.get(fileId);

    // Policy: never sync repo files from git during app init.
    // Repo content must only be refreshed by explicit pull/automation/user repo change flows.
    
    // Fallback: Load default connections.yaml if it doesn't exist locally
    const defaultData = await loadDefaultConnections();
    const defaultConnections = defaultData?.connections;
    const defaultCount = Array.isArray(defaultConnections) ? defaultConnections.length : 0;
    const existingConnections = existing?.data?.connections;
    const existingCount = Array.isArray(existingConnections) ? existingConnections.length : 0;
    const shouldReseedFromDefaults =
      (!existing || (!existing.isDirty && existingCount === 0 && defaultCount > 0));

    if (shouldReseedFromDefaults) {
      console.log(
        `[seedConnections] ${existing ? 'Reseeding' : 'Creating'} connections.yaml from defaults (${defaultCount} connections)`
      );
      
      await db.files.put({
        fileId,
        type: 'connections',
        data: defaultData,
        lastModified: Date.now(),
        viewTabs: existing?.viewTabs || [],
        isDirty: false,
        originalData: defaultData,
        // Intentionally no repo source: this is a local default seed.
      });
      console.log(
        '[seedConnections] ✅ connections.yaml',
        existing ? 'reseeded' : 'created',
        'with',
        defaultCount,
        'default connections'
      );
    } else {
      console.log('[seedConnections] connections.yaml already exists, skipping seed');
    }
  } catch (error) {
    console.error('[seedConnections] Failed to seed connections.yaml:', error);
    // Don't throw - this is a nice-to-have initialization
  }
}

