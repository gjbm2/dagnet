/**
 * useFileAudit Hook
 * 
 * Centralized hook for auditing all files in IndexedDB/FileRegistry.
 * Produces a report showing all files grouped by type.
 * Used by FileMenu.
 */

import { useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { useTabContext } from '../contexts/TabContext';
import { db } from '../db/appDatabase';
import { fileRegistry } from '../contexts/TabContext';
import { LogFileService } from '../services/logFileService';
import { sessionLogService } from '../services/sessionLogService';

interface UseFileAuditResult {
  /** Run the file audit */
  runAudit: () => Promise<void>;
  /** Whether audit is currently running */
  isAuditing: boolean;
}

interface FileInfo {
  fileId: string;
  type: string;
  name?: string;
  path?: string;
  isDirty: boolean;
  isLoaded: boolean;
  source?: string;
  sha?: string;
  lastModified?: number;
  dataKeys?: string[];
}

/**
 * Hook to audit all files in IndexedDB and FileRegistry
 * 
 * Produces a detailed report of:
 * - All files by type
 * - File IDs and names
 * - Dirty state
 * - Source information
 * - Potential issues (mismatches between IDB and registry)
 */
export function useFileAudit(): UseFileAuditResult {
  const { operations } = useTabContext();
  const [isAuditing, setIsAuditing] = useState(false);
  
  const runAudit = useCallback(async () => {
    if (isAuditing) return;
    
    setIsAuditing(true);
    const toastId = toast.loading('Auditing files...');
    const logOpId = sessionLogService.startOperation('info', 'file', 'FILE_AUDIT', 'Running file audit');
    
    try {
      // Get all files from IndexedDB
      const idbFiles = await db.files.toArray();
      
      // Get all files from FileRegistry (in-memory)
      const registryFiles = new Map<string, any>();
      const registryFilesInternal = (fileRegistry as any).files as Map<string, any>;
      for (const [key, value] of registryFilesInternal.entries()) {
        registryFiles.set(key, value);
      }
      
      // Collect file info
      const filesByType = new Map<string, FileInfo[]>();
      const allFileIds = new Set<string>();
      
      // Process IDB files
      // Track both prefixed and unprefixed IDs for proper matching
      const unprefixedIdbIds = new Set<string>();
      
      for (const file of idbFiles) {
        allFileIds.add(file.fileId);
        
        // Also track the unprefixed version for comparison with registry
        const unprefixedId = stripWorkspacePrefix(file.fileId);
        unprefixedIdbIds.add(unprefixedId);
        
        const type = file.type || extractTypeFromFileId(file.fileId);
        
        if (!filesByType.has(type)) {
          filesByType.set(type, []);
        }
        
        const info: FileInfo = {
          fileId: file.fileId,
          type,
          name: file.name,
          path: file.path || file.source?.path,
          isDirty: file.isDirty || false,
          isLoaded: !!file.data,
          source: file.source?.repository,
          sha: file.sha?.substring(0, 8),
          lastModified: file.lastModified,
          dataKeys: file.data ? Object.keys(file.data).slice(0, 10) : undefined
        };
        
        filesByType.get(type)!.push(info);
      }
      
      // Check for files only in registry (not in IDB)
      // Must compare unprefixed IDs since registry uses unprefixed, IDB uses prefixed
      const registryOnlyFiles: FileInfo[] = [];
      for (const [fileId, file] of registryFiles.entries()) {
        // Check if this unprefixed ID has a corresponding prefixed entry in IDB
        if (!unprefixedIdbIds.has(fileId) && !allFileIds.has(fileId)) {
          const type = file.type || extractTypeFromFileId(fileId);
          registryOnlyFiles.push({
            fileId,
            type,
            name: file.name,
            path: file.path || file.source?.path,
            isDirty: file.isDirty || false,
            isLoaded: !!file.data,
            source: file.source?.repository,
            dataKeys: file.data ? Object.keys(file.data).slice(0, 10) : undefined
          });
        }
      }
      
      // Build report
      const lines: string[] = [];
      lines.push('# File Audit Report');
      lines.push('');
      lines.push(`**Generated:** ${new Date().toLocaleString('en-GB')}`);
      lines.push('');
      
      // Summary
      lines.push('## Summary');
      lines.push('');
      lines.push(`- **Total files in IndexedDB:** ${idbFiles.length} (stored with workspace prefix)`);
      lines.push(`- **Total files in FileRegistry (memory):** ${registryFiles.size} (stored without prefix)`);
      lines.push(`- **True orphan files (in memory only, no IDB backing):** ${registryOnlyFiles.length}`);
      lines.push('');
      lines.push('> **Note:** IDB uses prefixed IDs (e.g., `repo-branch-event-xyz`) while FileRegistry uses');
      lines.push('> unprefixed IDs (e.g., `event-xyz`). This is by design for multi-workspace support.');
      lines.push('');
      
      // Files by type table
      lines.push('### Files by Type');
      lines.push('');
      lines.push('| Type | Count | Dirty |');
      lines.push('|------|-------|-------|');
      
      const sortedTypes = Array.from(filesByType.keys()).sort();
      for (const type of sortedTypes) {
        const files = filesByType.get(type)!;
        const dirtyCount = files.filter(f => f.isDirty).length;
        lines.push(`| ${type} | ${files.length} | ${dirtyCount} |`);
      }
      lines.push('');
      
      // Detailed listing by type
      lines.push('## Detailed File Listing');
      lines.push('');
      
      for (const type of sortedTypes) {
        const files = filesByType.get(type)!;
        lines.push(`### ${type} (${files.length} files)`);
        lines.push('');
        
        // Sort by fileId
        files.sort((a, b) => a.fileId.localeCompare(b.fileId));
        
        for (const file of files) {
          const dirtyMarker = file.isDirty ? ' 🔴' : '';
          const sourceInfo = file.source ? ` [${file.source}]` : '';
          const shaInfo = file.sha ? ` (${file.sha})` : '';
          
          lines.push(`- **${file.fileId}**${dirtyMarker}${sourceInfo}${shaInfo}`);
          
          if (file.path) {
            lines.push(`  - Path: \`${file.path}\``);
          }
          if (file.dataKeys && file.dataKeys.length > 0) {
            lines.push(`  - Data keys: ${file.dataKeys.join(', ')}`);
          }
          if (file.lastModified) {
            lines.push(`  - Modified: ${new Date(file.lastModified).toLocaleString('en-GB')}`);
          }
        }
        lines.push('');
      }
      
      // Registry-only files (potential issues)
      if (registryOnlyFiles.length > 0) {
        lines.push('## ⚠️ True Orphan Files (Memory Only, No IDB Backing)');
        lines.push('');
        lines.push('These files exist in FileRegistry but have no corresponding entry in IndexedDB');
        lines.push('(even accounting for workspace prefix differences):');
        lines.push('');
        
        for (const file of registryOnlyFiles) {
          lines.push(`- **${file.fileId}** (${file.type})${file.isDirty ? ' 🔴 dirty' : ''} [source: ${file.source || 'unknown'}]`);
        }
        lines.push('');
      } else {
        lines.push('## ✅ No Orphan Files');
        lines.push('');
        lines.push('All FileRegistry entries have corresponding IDB backing (accounting for prefix differences).');
        lines.push('');
      }
      
      // Look for potential ID mismatches (e.g., event files where fileId doesn't match data.id)
      lines.push('## Potential Issues');
      lines.push('');
      
      let issueCount = 0;
      const idMismatches: { fileId: string; dataId: string; type: string }[] = [];
      
      for (const file of idbFiles) {
        if (file.data?.id) {
          const expectedFileId = `${file.type}-${file.data.id}`;
          // Strip workspace prefix for comparison
          const actualFileId = file.fileId.includes('-') && file.fileId.split('-').length > 2
            ? file.fileId.split('-').slice(-2).join('-')
            : file.fileId;
          
          if (actualFileId !== expectedFileId && !file.fileId.endsWith(expectedFileId)) {
            lines.push(`- **ID Mismatch:** fileId=\`${file.fileId}\` but data.id=\`${file.data.id}\` (expected \`${expectedFileId}\`)`);
            idMismatches.push({ fileId: file.fileId, dataId: file.data.id, type: file.type || 'unknown' });
            issueCount++;
          }
        }
      }
      
      if (issueCount === 0) {
        lines.push('✅ No issues detected');
      }
      lines.push('');
      
      // Check FileRegistry for the same mismatches
      lines.push('## FileRegistry ID Audit (Memory)');
      lines.push('');
      lines.push('Checking if fileId matches data.id in FileRegistry:');
      lines.push('');
      
      let registryMismatchCount = 0;
      for (const [fileId, file] of registryFiles.entries()) {
        if (file.data?.id && file.type) {
          const expectedId = fileId.replace(`${file.type}-`, '');
          if (file.data.id !== expectedId) {
            lines.push(`- **Registry Mismatch:** \`${fileId}\` contains data.id=\`${file.data.id}\` (expected \`${expectedId}\`)`);
            registryMismatchCount++;
          }
        }
      }
      
      if (registryMismatchCount === 0) {
        lines.push('✅ All FileRegistry entries have matching IDs');
      } else {
        lines.push('');
        lines.push(`⚠️ Found ${registryMismatchCount} mismatches in FileRegistry!`);
        lines.push('');
        lines.push('**This is likely causing navigation issues!** When you click on an item,');
        lines.push('the file opens but shows data from a different item because `data.id` is wrong.');
      }
      lines.push('');
      
      // CRITICAL: Check index files for corruption
      lines.push('## Index File Audit');
      lines.push('');
      lines.push('Checking index files for entry/file mismatches:');
      lines.push('');
      
      for (const indexType of ['parameter', 'node', 'context', 'case', 'event']) {
        const indexFileId = `${indexType}-index`;
        const indexFile = registryFiles.get(indexFileId);
        
        if (!indexFile?.data) {
          lines.push(`### ${indexType}s-index: Not loaded`);
          lines.push('');
          continue;
        }
        
        const arrayKey = `${indexType}s` as 'parameters' | 'contexts' | 'cases' | 'nodes' | 'events';
        const entries = (indexFile.data as any)[arrayKey] || [];
        
        lines.push(`### ${indexType}s-index: ${entries.length} entries`);
        lines.push('');
        
        let indexMismatchCount = 0;
        for (const entry of entries) {
          const entryId = entry.id;
          const entryName = entry.name || entryId;
          const expectedFileId = `${indexType}-${entryId}`;
          const actualFile = registryFiles.get(expectedFileId);
          
          if (actualFile?.data?.id && actualFile.data.id !== entryId) {
            lines.push(`- **Index→File Mismatch:** Index entry id=\`${entryId}\` name=\`${entryName}\` → File has data.id=\`${actualFile.data.id}\``);
            indexMismatchCount++;
          }
        }
        
        if (indexMismatchCount === 0) {
          lines.push('✅ All index entries match their files');
        } else {
          lines.push('');
          lines.push(`⚠️ ${indexMismatchCount} index entries have mismatched files!`);
        }
        lines.push('');
      }
      
      // Show a sample of what's in FileRegistry for parameters to debug the click issue
      lines.push('## Parameter Files Debug (first 20)');
      lines.push('');
      lines.push('| fileId | data.id | data.name | Match? |');
      lines.push('|--------|---------|-----------|--------|');
      
      let paramCount = 0;
      for (const [fileId, file] of registryFiles.entries()) {
        if (file.type === 'parameter' && fileId !== 'parameter-index' && paramCount < 20) {
          const expectedId = fileId.replace('parameter-', '');
          const dataId = file.data?.id || '(none)';
          const dataName = file.data?.name || '(none)';
          const match = dataId === expectedId ? '✅' : '❌';
          lines.push(`| ${fileId} | ${dataId} | ${dataName} | ${match} |`);
          paramCount++;
        }
      }
      lines.push('');
      
      const logContent = lines.join('\n');
      
      // Create log file
      await LogFileService.createLogFile(
        logContent,
        operations,
        `File Audit ${new Date().toLocaleDateString('en-GB')}`
      );
      
      sessionLogService.endOperation(logOpId, 'success', `Audited ${idbFiles.length} files`);
      
      toast.success(
        `Audit complete: ${idbFiles.length} files`,
        { id: toastId }
      );
    } catch (error) {
      sessionLogService.endOperation(logOpId, 'error', `Audit failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      toast.error(
        `File audit failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { id: toastId }
      );
    } finally {
      setIsAuditing(false);
    }
  }, [operations, isAuditing]);
  
  return {
    runAudit,
    isAuditing
  };
}

/**
 * Extract type from fileId (e.g., "event-switch-success" -> "event")
 */
function extractTypeFromFileId(fileId: string): string {
  const knownTypes = ['graph', 'parameter', 'case', 'node', 'event', 'context', 'credentials', 'connection', 'log', 'markdown', 'session-log', 'image'];
  
  for (const type of knownTypes) {
    if (fileId.startsWith(`${type}-`)) {
      return type;
    }
    // Handle workspace-prefixed IDs (repo-branch-type-id)
    if (fileId.includes(`-${type}-`)) {
      return type;
    }
  }
  
  // Fallback: use first part
  return fileId.split('-')[0] || 'unknown';
}

/**
 * Strip workspace prefix from fileId
 * e.g., "nous-conversion-main-event-xyz" -> "event-xyz"
 */
function stripWorkspacePrefix(fileId: string): string {
  const knownTypes = ['graph', 'parameter', 'case', 'node', 'event', 'context', 'credentials', 'connection', 'log', 'markdown', 'session-log', 'image'];
  
  for (const type of knownTypes) {
    // Look for pattern: anything-type-rest
    const pattern = new RegExp(`^.+-${type}-(.+)$`);
    const match = fileId.match(pattern);
    if (match) {
      return `${type}-${match[1]}`;
    }
    
    // Also handle index files: anything-type-index
    if (fileId.endsWith(`-${type}-index`)) {
      return `${type}-index`;
    }
  }
  
  // No prefix found, return as-is
  return fileId;
}

