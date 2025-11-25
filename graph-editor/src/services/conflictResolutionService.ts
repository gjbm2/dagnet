/**
 * Conflict Resolution Service
 * 
 * Handles applying conflict resolutions from the MergeConflictModal
 */

import { fileRegistry } from '../contexts/TabContext';
import { db } from '../db/appDatabase';
import YAML from 'yaml';
import toast from 'react-hot-toast';
import type { MergeConflict } from './workspaceService';
import { sessionLogService } from './sessionLogService';

export class ConflictResolutionService {
  /**
   * Apply conflict resolutions
   * 
   * @param conflicts - Array of conflicts that were resolved
   * @param resolutions - Map of fileId to resolution choice
   * @returns Number of conflicts resolved
   */
  async applyResolutions(
    conflicts: MergeConflict[],
    resolutions: Map<string, 'local' | 'remote' | 'manual'>
  ): Promise<number> {
    console.log('🔀 ConflictResolutionService: Applying resolutions:', resolutions);
    sessionLogService.info('merge', 'MERGE_RESOLVE', `Resolving ${conflicts.length} merge conflict(s)`,
      undefined, { conflicts: conflicts.map(c => c.fileName) });
    
    let resolvedCount = 0;
    
    for (const conflict of conflicts) {
      const resolution = resolutions.get(conflict.fileId);
      if (!resolution) continue;

      const currentFile = fileRegistry.getFile(conflict.fileId);
      if (!currentFile) {
        console.warn(`⚠️ ConflictResolutionService: File ${conflict.fileId} not found in registry`);
        continue;
      }

      if (resolution === 'local') {
        // Keep local version - mark as dirty so user can commit
        console.log(`📝 ConflictResolutionService: Keeping local version of ${conflict.fileId}`);
        currentFile.isDirty = true;
        (fileRegistry as any).notifyListeners(conflict.fileId, currentFile);
        resolvedCount++;
        
      } else if (resolution === 'remote') {
        // Accept remote version
        console.log(`⬇️ ConflictResolutionService: Accepting remote version of ${conflict.fileId}`);
        
        try {
          const remoteData = conflict.type === 'graph'
            ? JSON.parse(conflict.remoteContent)
            : YAML.parse(conflict.remoteContent);
          
          currentFile.data = remoteData;
          currentFile.originalData = structuredClone(remoteData);
          currentFile.isDirty = false;
          currentFile.lastModified = Date.now();
          
          // Persist to IndexedDB
          await db.files.put(currentFile);
          
          // Notify listeners to update UI (form editors, YAML viewers, etc.)
          (fileRegistry as any).notifyListeners(conflict.fileId, currentFile);
          
          resolvedCount++;
        } catch (error) {
          console.error(`❌ ConflictResolutionService: Failed to apply remote version for ${conflict.fileId}:`, error);
          toast.error(`Failed to apply remote version for ${conflict.fileName}`);
        }
        
      } else if (resolution === 'manual') {
        // Manual merge - file will be edited by user
        console.log(`✏️ ConflictResolutionService: Manual merge required for ${conflict.fileId}`);
        toast(`Please manually edit ${conflict.fileName} to resolve conflicts`, { icon: 'ℹ️' });
        currentFile.isDirty = true;
        (fileRegistry as any).notifyListeners(conflict.fileId, currentFile);
        resolvedCount++;
      }
    }

    console.log(`✅ ConflictResolutionService: Resolved ${resolvedCount} conflicts`);
    
    if (resolvedCount > 0) {
      // Count resolution types
      const localCount = Array.from(resolutions.values()).filter(r => r === 'local').length;
      const remoteCount = Array.from(resolutions.values()).filter(r => r === 'remote').length;
      const manualCount = Array.from(resolutions.values()).filter(r => r === 'manual').length;
      
      sessionLogService.success('merge', 'MERGE_RESOLVE_SUCCESS', `Resolved ${resolvedCount} conflict(s)`,
        `Local: ${localCount}, Remote: ${remoteCount}, Manual: ${manualCount}`);
    }
    
    return resolvedCount;
  }
}

// Export singleton instance
export const conflictResolutionService = new ConflictResolutionService();

