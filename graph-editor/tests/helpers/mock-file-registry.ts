/**
 * Mock File Registry
 * 
 * In-memory implementation of FileRegistry for testing.
 * Tracks all operations for assertion.
 */

export interface MockFile {
  fileId: string;
  type: 'graph' | 'parameter' | 'case' | 'event' | 'credentials';
  data: any;
  originalData?: any;
  isDirty: boolean;
  lastModified: string;
}

export interface FileOperation {
  type: 'create' | 'update' | 'delete' | 'get';
  fileId: string;
  timestamp: string;
  data?: any;
}

export class MockFileRegistry {
  private files: Map<string, MockFile> = new Map();
  private operations: FileOperation[] = [];
  private listeners: Map<string, Set<(file: MockFile) => void>> = new Map();

  /**
   * Get a file by ID
   */
  getFile(fileId: string): MockFile | undefined {
    this.recordOperation('get', fileId);
    return this.files.get(fileId);
  }

  /**
   * Create or update a file
   */
  async updateFile(fileId: string, data: any): Promise<void> {
    const existing = this.files.get(fileId);
    
    const file: MockFile = {
      fileId,
      type: this.inferType(fileId),
      data,
      originalData: existing?.originalData || data,
      isDirty: true,
      lastModified: new Date().toISOString()
    };

    this.files.set(fileId, file);
    this.recordOperation('update', fileId, data);
    this.notifyListeners(fileId, file);
  }

  /**
   * Delete a file
   */
  async deleteFile(fileId: string): Promise<void> {
    this.files.delete(fileId);
    this.recordOperation('delete', fileId);
    this.notifyListeners(fileId, undefined as any);
  }

  /**
   * Add a listener for file changes
   */
  addListener(fileId: string, callback: (file: MockFile) => void): () => void {
    if (!this.listeners.has(fileId)) {
      this.listeners.set(fileId, new Set());
    }
    this.listeners.get(fileId)!.add(callback);

    // Return cleanup function
    return () => {
      this.listeners.get(fileId)?.delete(callback);
    };
  }

  /**
   * Get all operations (for assertions)
   */
  getOperations(): FileOperation[] {
    return [...this.operations];
  }

  /**
   * Get operations for a specific file
   */
  getOperationsForFile(fileId: string): FileOperation[] {
    return this.operations.filter(op => op.fileId === fileId);
  }

  /**
   * Clear all data (reset between tests)
   */
  clear(): void {
    this.files.clear();
    this.operations = [];
    this.listeners.clear();
  }

  /**
   * Seed initial files (for test setup)
   */
  seed(files: Array<{ fileId: string; data: any }>): void {
    for (const { fileId, data } of files) {
      this.files.set(fileId, {
        fileId,
        type: this.inferType(fileId),
        data,
        originalData: data,
        isDirty: false,
        lastModified: new Date().toISOString()
      });
    }
  }

  /**
   * Assert a file was updated
   */
  assertFileUpdated(fileId: string): void {
    const ops = this.getOperationsForFile(fileId);
    const hasUpdate = ops.some(op => op.type === 'update');
    
    if (!hasUpdate) {
      throw new Error(`Expected file ${fileId} to be updated, but it wasn't`);
    }
  }

  /**
   * Assert a file was NOT updated
   */
  assertFileNotUpdated(fileId: string): void {
    const ops = this.getOperationsForFile(fileId);
    const hasUpdate = ops.some(op => op.type === 'update');
    
    if (hasUpdate) {
      throw new Error(`Expected file ${fileId} NOT to be updated, but it was`);
    }
  }

  /**
   * Get number of updates to a file
   */
  getUpdateCount(fileId: string): number {
    return this.getOperationsForFile(fileId)
      .filter(op => op.type === 'update')
      .length;
  }

  // Private helpers

  private inferType(fileId: string): MockFile['type'] {
    if (fileId.startsWith('graph-')) return 'graph';
    if (fileId.startsWith('parameter-')) return 'parameter';
    if (fileId.startsWith('case-')) return 'case';
    if (fileId.startsWith('event-')) return 'event';
    if (fileId.startsWith('credentials-')) return 'credentials';
    return 'graph';
  }

  private recordOperation(type: FileOperation['type'], fileId: string, data?: any): void {
    this.operations.push({
      type,
      fileId,
      timestamp: new Date().toISOString(),
      data
    });
  }

  private notifyListeners(fileId: string, file: MockFile): void {
    const listeners = this.listeners.get(fileId);
    if (listeners) {
      listeners.forEach(callback => callback(file));
    }
  }
}

/**
 * Create a mock parameter file
 */
export function createMockParameterFile(config: {
  id: string;
  query?: string;
  connection?: string;
  values?: Array<{
    date?: string;
    mean?: number;
    stdev?: number;
    n?: number;
    k?: number;
    query_signature?: string;
  }>;
}): any {
  return {
    id: config.id,
    query: config.query || 'from(a).to(b)',
    connection: config.connection || 'amplitude-prod',
    values: config.values || []
  };
}

/**
 * Create a mock graph file
 */
export function createMockGraphFile(config: {
  id: string;
  nodes?: any[];
  edges?: any[];
}): any {
  return {
    id: config.id,
    nodes: config.nodes || [],
    edges: config.edges || [],
    policies: {
      rebalance_on_update: true
    },
    metadata: {
      version: '1.0',
      created_at: new Date().toISOString()
    }
  };
}

