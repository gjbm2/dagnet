import type { ConnectionProvider } from './ConnectionProvider';
import type { ConnectionDefinition, ConnectionFile } from './types';

export class FileSystemConnectionProvider implements ConnectionProvider {
  constructor(private readonly connectionsPath: string = './config/connections.yaml') {}

  private async readConnectionFile(): Promise<ConnectionFile> {
    const fs = await import('fs/promises');
    const yaml = await import('js-yaml');

    const content = await fs.readFile(this.connectionsPath, 'utf8');
    const parsed = yaml.load(content) as ConnectionFile;

    if (!parsed || !Array.isArray(parsed.connections)) {
      throw new Error(`Invalid connections file at ${this.connectionsPath}`);
    }

    return parsed;
  }

  async getConnection(name: string): Promise<ConnectionDefinition> {
    const file = await this.readConnectionFile();
    const connection = file.connections.find((c) => c.name === name);

    if (!connection) {
      const available = file.connections.map((c) => c.name).join(', ') || 'none';
      throw new Error(`Connection "${name}" not found in ${this.connectionsPath}. Available: ${available}`);
    }

    if (connection.enabled === false) {
      throw new Error(`Connection "${name}" is disabled in ${this.connectionsPath}`);
    }

    return connection;
  }

  async getAllConnections(): Promise<ConnectionDefinition[]> {
    const file = await this.readConnectionFile();
    return file.connections;
  }

  async getConnectionFile(): Promise<ConnectionFile> {
    return this.readConnectionFile();
  }
}






