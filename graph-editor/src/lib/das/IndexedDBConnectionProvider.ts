import type { ConnectionDefinition, ConnectionFile } from './types';
import type { ConnectionProvider } from './ConnectionProvider';
import { db } from '@/db/appDatabase';

export class IndexedDBConnectionProvider implements ConnectionProvider {
  // Cache the connection file to avoid repeated IndexedDB queries
  private cachedConnectionFile: ConnectionFile | undefined = undefined;
  private cacheTimestamp: number = 0;
  private static CACHE_TTL_MS = 1500; // 1.5 second cache - enough for batch fetches, minimal staleness

  private async loadConnectionFile(): Promise<ConnectionFile | undefined> {
    if (typeof window === 'undefined') {
      return undefined;
    }

    // Return cached value if fresh
    const now = Date.now();
    if (this.cachedConnectionFile && (now - this.cacheTimestamp) < IndexedDBConnectionProvider.CACHE_TTL_MS) {
      return this.cachedConnectionFile;
    }

    const record = await db.files.get('connections-connections');
    this.cachedConnectionFile = record?.data as ConnectionFile | undefined;
    this.cacheTimestamp = now;
    return this.cachedConnectionFile;
  }

  /** Clear the cache (call when connections file is edited) */
  clearCache(): void {
    this.cachedConnectionFile = undefined;
    this.cacheTimestamp = 0;
  }

  async getConnection(name: string): Promise<ConnectionDefinition> {
    const file = await this.loadConnectionFile();
    if (!file || !Array.isArray(file.connections)) {
      throw new Error('No connections file is available. Use File > Connections to create one.');
    }

    const connection = file.connections.find((c) => c.name === name);
    if (!connection) {
      const availableNames = file.connections.map((c) => c.name).join(', ') || 'none';
      throw new Error(`Connection "${name}" not found. Available connections: ${availableNames}`);
    }

    if (connection.enabled === false) {
      throw new Error(`Connection "${name}" is disabled. Enable it in connections.yaml to use it.`);
    }

    return connection;
  }

  async getAllConnections(): Promise<ConnectionDefinition[]> {
    const file = await this.loadConnectionFile();
    return file?.connections ?? [];
  }

  async getConnectionFile(): Promise<ConnectionFile | undefined> {
    return this.loadConnectionFile();
  }
}
