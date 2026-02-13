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
 * Seeds connections.yaml from shipped defaults on every app init.
 *
 * The shipped public/defaults/connections.yaml is the source of truth for connection
 * definitions. IDB is overwritten on each load so that new app versions automatically
 * pick up connection changes (e.g. new connections, adapter updates, inheritance).
 *
 * Users do not yet have meaningful per-user connection customisations, so this is safe.
 * When user-level connection editing is needed, switch to a merge strategy that preserves
 * user additions while still adding new shipped defaults.
 */
export async function seedConnectionsFile(): Promise<void> {
  try {
    const fileId = 'connections-connections';
    const existing = await db.files.get(fileId);
    const defaultData = await loadDefaultConnections();
    const defaultConnections = defaultData?.connections;
    const defaultCount = Array.isArray(defaultConnections) ? defaultConnections.length : 0;

    console.log(
      `[seedConnections] ${existing ? 'Updating' : 'Creating'} connections.yaml from shipped defaults (${defaultCount} connections)`
    );

    await db.files.put({
      fileId,
      type: 'connections',
      data: defaultData,
      lastModified: Date.now(),
      viewTabs: existing?.viewTabs || [],
      isDirty: false,
      originalData: defaultData,
    });

    console.log('[seedConnections] ✅ connections.yaml seeded with', defaultCount, 'connections');
  } catch (error) {
    console.error('[seedConnections] Failed to seed connections.yaml:', error);
  }
}

