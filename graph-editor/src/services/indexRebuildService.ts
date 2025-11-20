import { db } from '../db/appDatabase';
import { fileRegistry } from '../contexts/TabContext';
import { ObjectType } from '../types';
import { LogFileService } from './logFileService';
import type { TabOperations } from '../types';

interface RebuildResult {
  fileId: string;
  type: ObjectType;
  action: 'ok' | 'added' | 'updated' | 'error' | 'skipped';
  message: string;
}

/**
 * Index Rebuild Service
 * 
 * Audits all files stored in IndexedDB and ensures each has a corresponding
 * entry in the relevant index file (node-index, parameter-index, etc.)
 */
export class IndexRebuildService {
  /**
   * Rebuild all indexes
   * - Scans all files in IndexedDB
   * - Checks if each file has a corresponding index entry
   * - Adds missing entries to index files
   * - Creates a detailed log file report
   */
  static async rebuildAllIndexes(
    tabOperations: TabOperations,
    createLog: boolean = true
  ): Promise<{ 
    success: boolean;
    totalFiles: number; 
    results: RebuildResult[];
    logContent: string;
  }> {
    const results: RebuildResult[] = [];
    const startTime = new Date();
    
    try {
      // Get all files from IndexedDB
      const allFiles = await db.files.toArray();
      console.log(`📦 IndexRebuildService: Found ${allFiles.length} files in IndexedDB`);
      
      // Group files by type
      const filesByType = new Map<ObjectType, typeof allFiles>();
      for (const file of allFiles) {
        // Skip temporary files (logs) and credentials
        if (file.source?.repository === 'temporary' || 
            file.type === 'credentials' ||
            file.type === 'connections' ||
            file.type === 'markdown' ||
            file.type === 'about' ||
            file.type === 'settings') {
          results.push({
            fileId: file.fileId,
            type: file.type,
            action: 'skipped',
            message: 'Non-indexed file type'
          });
          continue;
        }
        
        // Skip index files themselves
        if (file.fileId.endsWith('-index')) {
          results.push({
            fileId: file.fileId,
            type: file.type,
            action: 'skipped',
            message: 'Index file'
          });
          continue;
        }
        
        // Skip graphs (don't have indexes)
        if (file.type === 'graph') {
          results.push({
            fileId: file.fileId,
            type: file.type,
            action: 'skipped',
            message: 'Graphs do not have index files'
          });
          continue;
        }
        
        // Only process types that have indexes
        if (['parameter', 'context', 'case', 'node', 'event'].includes(file.type)) {
          if (!filesByType.has(file.type)) {
            filesByType.set(file.type, []);
          }
          filesByType.get(file.type)!.push(file);
        } else {
          results.push({
            fileId: file.fileId,
            type: file.type,
            action: 'skipped',
            message: `Unknown or non-indexed type: ${file.type}`
          });
        }
      }
      
      console.log(`📦 IndexRebuildService: Processing ${filesByType.size} file types`);
      
      // Process each type
      for (const [type, files] of filesByType) {
        console.log(`📦 IndexRebuildService: Processing ${files.length} ${type} files`);
        
        for (const file of files) {
          try {
            const result = await this.ensureFileInIndex(file, type as 'parameter' | 'context' | 'case' | 'node' | 'event');
            results.push(result);
          } catch (error) {
            results.push({
              fileId: file.fileId,
              type: file.type,
              action: 'error',
              message: error instanceof Error ? error.message : 'Unknown error'
            });
          }
        }
      }
      
      // Generate log content
      const logContent = this.generateLogReport(results, startTime, new Date());
      
      // Create log file if requested
      if (createLog) {
        try {
          await LogFileService.createLogFile(
            logContent,
            tabOperations,
            `Index Rebuild Report - ${startTime.toISOString().split('T')[0]}`
          );
        } catch (error) {
          console.error('[IndexRebuildService] Failed to create log file:', error);
        }
      }
      
      return {
        success: true,
        totalFiles: allFiles.length,
        results,
        logContent
      };
    } catch (error) {
      console.error('[IndexRebuildService] Failed to rebuild indexes:', error);
      throw error;
    }
  }
  
  /**
   * Ensure a single file has a corresponding entry in its index
   */
  private static async ensureFileInIndex(
    file: any,
    type: 'parameter' | 'context' | 'case' | 'node' | 'event'
  ): Promise<RebuildResult> {
    const fileId = file.fileId;
    
    // Skip if file has no data or no ID
    if (!file.data || !file.data.id) {
      return {
        fileId,
        type,
        action: 'skipped',
        message: 'File has no data or ID'
      };
    }
    
    const itemId = file.data.id;
    
    // Load or create index file
    const indexFileId = `${type}-index`;
    const arrayKey = `${type}s` as 'parameters' | 'contexts' | 'cases' | 'nodes' | 'events';
    
    // Get index file from FileRegistry (load into memory if needed)
    let indexFile = fileRegistry.getFile(indexFileId);
    
    if (!indexFile) {
      // Try to load from IndexedDB
      const indexFromDb = await db.files.get(indexFileId);
      if (indexFromDb) {
        // Load into FileRegistry
        (fileRegistry as any).files.set(indexFileId, indexFromDb);
        indexFile = indexFromDb;
      } else {
        // Create new index file
        indexFile = {
          fileId: indexFileId,
          type: type,
          name: `${indexFileId}.yaml`,
          path: `${indexFileId}.yaml`,
          data: {
            version: '1.0.0',
            created_at: new Date().toISOString(),
            [arrayKey]: []
          },
          originalData: {},
          isDirty: false,
          viewTabs: [],
          lastModified: Date.now(),
          source: {
            repository: file.source?.repository || 'local',
            branch: file.source?.branch || 'main',
            path: `${indexFileId}.yaml`
          }
        };
        
        // Add to FileRegistry and save to IndexedDB
        (fileRegistry as any).files.set(indexFileId, indexFile);
        await db.files.put(indexFile);
        
        return {
          fileId,
          type,
          action: 'added',
          message: `Created index file and added entry for ${itemId}`
        };
      }
    }
    
    // Ensure data structure exists
    if (!indexFile.data) {
      indexFile.data = {
        version: '1.0.0',
        created_at: new Date().toISOString(),
        [arrayKey]: []
      };
    }
    
    // Get entries array
    const entries = indexFile.data[arrayKey] || [];
    indexFile.data[arrayKey] = entries;
    
    // Check if entry already exists
    const existingIdx = entries.findIndex((e: any) => e.id === itemId);
    
    if (existingIdx >= 0) {
      // Entry exists - check if it needs updating
      const existing = entries[existingIdx];
      let needsUpdate = false;
      
      // Check if file_path is correct
      const expectedPath = file.source?.path || `${type}s/${itemId}.yaml`;
      if (existing.file_path !== expectedPath) {
        existing.file_path = expectedPath;
        needsUpdate = true;
      }
      
      // Update name if missing or different
      if (file.data.name && existing.name !== file.data.name) {
        existing.name = file.data.name;
        needsUpdate = true;
      }
      
      // Update description if missing
      if (file.data.description && !existing.description) {
        existing.description = file.data.description;
        needsUpdate = true;
      }
      
      if (needsUpdate) {
        entries[existingIdx] = existing;
        indexFile.data.updated_at = new Date().toISOString();
        indexFile.isDirty = true;
        indexFile.lastModified = Date.now();
        
        // Save to IndexedDB
        await db.files.put(indexFile);
        
        // Notify listeners
        (fileRegistry as any).notifyListeners(indexFileId, indexFile);
        
        return {
          fileId,
          type,
          action: 'updated',
          message: `Updated index entry for ${itemId}`
        };
      }
      
      return {
        fileId,
        type,
        action: 'ok',
        message: `Entry already exists for ${itemId}`
      };
    }
    
    // Entry doesn't exist - add it
    const newEntry: any = {
      id: itemId,
      file_path: file.source?.path || `${type}s/${itemId}.yaml`,
      status: file.data.metadata?.status || file.data.status || 'active',
      created_at: file.data.metadata?.created_at || file.data.created_at || new Date().toISOString()
    };
    
    // Add optional fields
    if (file.data.name) newEntry.name = file.data.name;
    if (file.data.description) newEntry.description = file.data.description;
    if (file.data.type) newEntry.type = file.data.type;
    if (file.data.tags) newEntry.tags = file.data.tags;
    if (file.data.category) newEntry.category = file.data.category;
    
    // Type-specific fields
    if (type === 'node') {
      if (file.data.event_id) newEntry.event_id = file.data.event_id;
    } else if (type === 'event') {
      if (file.data.event_type) newEntry.category = file.data.event_type;
    }
    
    // Add to entries
    entries.push(newEntry);
    
    // Sort by id for consistency
    entries.sort((a: any, b: any) => a.id.localeCompare(b.id));
    
    // Update index file
    indexFile.data[arrayKey] = entries;
    indexFile.data.updated_at = new Date().toISOString();
    indexFile.isDirty = true;
    indexFile.lastModified = Date.now();
    
    // Save to IndexedDB
    await db.files.put(indexFile);
    
    // Notify listeners
    (fileRegistry as any).notifyListeners(indexFileId, indexFile);
    
    return {
      fileId,
      type,
      action: 'added',
      message: `Added index entry for ${itemId}`
    };
  }
  
  /**
   * Generate a formatted log report
   */
  private static generateLogReport(
    results: RebuildResult[],
    startTime: Date,
    endTime: Date
  ): string {
    const lines: string[] = [];
    
    lines.push('Index Rebuild Operation');
    lines.push('');
    lines.push(`Started: ${startTime.toISOString()}`);
    lines.push(`Total files processed: ${results.length}`);
    lines.push('');
    
    // Count by action
    const counts = {
      ok: results.filter(r => r.action === 'ok').length,
      added: results.filter(r => r.action === 'added').length,
      updated: results.filter(r => r.action === 'updated').length,
      skipped: results.filter(r => r.action === 'skipped').length,
      error: results.filter(r => r.action === 'error').length
    };
    
    lines.push('Results:');
    lines.push('');
    
    // Group by action for better readability
    const actionGroups = {
      'Added to Index': results.filter(r => r.action === 'added'),
      'Updated in Index': results.filter(r => r.action === 'updated'),
      'Already in Index': results.filter(r => r.action === 'ok'),
      'Skipped': results.filter(r => r.action === 'skipped'),
      'Errors': results.filter(r => r.action === 'error')
    };
    
    for (const [groupName, groupResults] of Object.entries(actionGroups)) {
      if (groupResults.length === 0) continue;
      
      lines.push(`${groupName} (${groupResults.length}):`);
      for (const result of groupResults) {
        const icon = {
          ok: '✓',
          added: '✓',
          updated: '✓',
          skipped: '⊘',
          error: '✗'
        }[result.action];
        
        lines.push(`  ${icon} ${result.fileId} (${result.type}): ${result.message}`);
      }
      lines.push('');
    }
    
    lines.push('Summary:');
    lines.push(`  ✓ Already in index: ${counts.ok}`);
    lines.push(`  ✓ Added to index: ${counts.added}`);
    lines.push(`  ✓ Updated in index: ${counts.updated}`);
    lines.push(`  ⊘ Skipped: ${counts.skipped}`);
    lines.push(`  ✗ Errors: ${counts.error}`);
    lines.push('');
    
    const duration = (endTime.getTime() - startTime.getTime()) / 1000;
    lines.push(`Completed: ${endTime.toISOString()}`);
    lines.push(`Duration: ${duration.toFixed(2)}s`);
    
    return lines.join('\n');
  }
}

