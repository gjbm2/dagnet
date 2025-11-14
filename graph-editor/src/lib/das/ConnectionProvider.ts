import type { ConnectionDefinition, ConnectionFile } from './types';

export interface ConnectionProvider {
  getConnection(name: string): Promise<ConnectionDefinition>;
  getAllConnections(): Promise<ConnectionDefinition[]>;
  getConnectionFile?(): Promise<ConnectionFile | undefined>;
}




