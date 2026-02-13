import type { ConnectionProvider } from './ConnectionProvider';
import type { ConnectionDefinition, ConnectionFile } from './types';
import { resolveConnection, resolveAllConnections } from './resolveConnection';

export class FileSystemConnectionProvider implements ConnectionProvider {
  // When running in Node (tests / local tooling), `process.cwd()` is typically `graph-editor/`.
  // Defaulting to the shipped connections file makes Node execution work out of the box,
  // without needing test-time mocks.
  constructor(private readonly connectionsPath: string = `${process.cwd()}/public/defaults/connections.yaml`) {}

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
    const resolved = resolveConnection(name, file.connections);

    if (resolved.enabled === false) {
      throw new Error(`Connection "${name}" is disabled in ${this.connectionsPath}`);
    }

    return resolved;
  }

  async getAllConnections(): Promise<ConnectionDefinition[]> {
    const file = await this.readConnectionFile();
    return resolveAllConnections(file.connections);
  }

  async getConnectionFile(): Promise<ConnectionFile> {
    return this.readConnectionFile();
  }
}









