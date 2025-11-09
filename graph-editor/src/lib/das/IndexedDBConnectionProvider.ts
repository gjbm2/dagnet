import type { ConnectionDefinition, ConnectionFile } from './types';
import type { ConnectionProvider } from './ConnectionProvider';
import { db } from '@/db/appDatabase';

export class IndexedDBConnectionProvider implements ConnectionProvider {
  private async loadConnectionFile(): Promise<ConnectionFile | undefined> {
    if (typeof window === 'undefined') {
      return undefined;
    }

    const record = await db.files.get('connections-connections');
    return record?.data as ConnectionFile | undefined;
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


