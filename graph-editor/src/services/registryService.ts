/**
 * RegistryService
 * 
 * Central service for managing the superset view of all registry items
 * (parameters, contexts, cases, nodes) combining:
 * - Index entries (from *-index.yaml files)
 * - Actual files (from FileRegistry)
 * 
 * This is the SINGLE SOURCE OF TRUTH for all registry data.
 * Used by: Navigator, ParameterSelector, validation, etc.
 */

import { fileRegistry } from '../contexts/TabContext';
import { db } from '../db/appDatabase';
import { ObjectType } from '../types';

export interface RegistryItem {
  id: string;                    // Normalized ID (no type prefix, no extension)
  type: ObjectType;
  name?: string;
  description?: string;
  
  // File state
  hasFile: boolean;              // Has actual file (remote or local)
  isLocal: boolean;              // File is local only (not committed)
  isDirty: boolean;              // Has unsaved changes
  isOpen: boolean;               // Has active tab
  
  // Index state
  inIndex: boolean;              // Listed in registry index
  isOrphan: boolean;             // Has file but NOT in index
  
  // Metadata from index
  file_path?: string;
  status?: string;
  tags?: string[];
  
  // Type-specific metadata
  parameter_type?: 'probability' | 'cost_gbp' | 'cost_time' | 'standard_deviation';
  node_type?: string;
  case_type?: string;
  event_type?: string;
  
  // Timestamps
  lastModified?: number;
  lastOpened?: number;
}

class RegistryService {
  /**
   * Normalize an ID by removing type prefix and file extension
   */
  private normalizeId(fileIdOrName: string, type?: ObjectType): string {
    let id = fileIdOrName;
    
    // Remove file extension
    id = id.replace(/\.(yaml|yml|json)$/, '');
    
    // Remove type prefix if present (e.g., 'parameter-channel' → 'channel')
    if (type) {
      const prefix = `${type}-`;
      if (id.startsWith(prefix)) {
        id = id.substring(prefix.length);
      }
    }
    
    return id;
  }

  /**
   * Get all items of a specific type (parameter, context, case, node, or event)
   * Returns the superset of index entries + actual files
   */
  async getItems(type: 'parameter' | 'context' | 'case' | 'node' | 'event', tabs: any[] = []): Promise<RegistryItem[]> {
    const itemsMap = new Map<string, RegistryItem>();
    
    // 1. Load index file from FileRegistry only (don't load stale data from IDB)
    // The workspace loading process should have already loaded the correct index file into FileRegistry
    const indexFileId = `${type}-index`; // FileIds use singular form (e.g., parameter-index)
    const indexFile = fileRegistry.getFile(indexFileId);
    
    // 2. Process index entries
    if (indexFile?.data) {
      const arrayKey = `${type}s` as 'parameters' | 'contexts' | 'cases' | 'nodes' | 'events';
      const entries = (indexFile.data as any)[arrayKey] || [];
      
      for (const entry of entries) {
        const normalizedId = this.normalizeId(entry.id, type);
        
        itemsMap.set(normalizedId, {
          id: normalizedId,
          type: type as ObjectType,
          name: entry.name,
          description: entry.description,
          hasFile: false,       // Will be updated if file exists
          isLocal: false,       // Will be updated if file exists
          isDirty: false,       // Will be updated if file exists
          isOpen: false,        // Will be updated if file exists
          inIndex: true,
          isOrphan: false,
          file_path: entry.file_path,
          status: entry.status,
          tags: entry.tags,
          parameter_type: entry.parameter_type || entry.type,  // For parameters
          node_type: entry.node_type || entry.type,            // For nodes
          case_type: entry.case_type || entry.type,            // For cases
          event_type: entry.event_type || entry.type           // For events
        });
      }
    }
    
    // 3. Process actual files from FileRegistry - get fresh data
    const allFiles = fileRegistry.getAllFiles();
    console.log(`RegistryService.getItems(${type}): FileRegistry has ${allFiles.length} total files`);
    const typeFiles = allFiles.filter(f => f.type === type && f.fileId !== `${type}-index`); // Skip index files
    
    console.log(`RegistryService: Processing ${typeFiles.length} ${type} files for dirty state`);
    
    for (const file of typeFiles) {
      const normalizedId = this.normalizeId(file.fileId, type);
      const existing = itemsMap.get(normalizedId);
      
      if (existing) {
        // File exists for this index entry - update flags
        existing.hasFile = true;
        existing.isLocal = file.isLocal || false;
        existing.isDirty = file.isDirty || false;
        existing.isOpen = tabs.some((tab: any) => tab.fileId === file.fileId);
        existing.lastModified = file.lastModified;
        existing.lastOpened = file.lastOpened;
        
        // Extract type from file data if available (overrides index type)
        if (file.data?.type) {
          if (type === 'parameter') existing.parameter_type = file.data.type;
          else if (type === 'node') existing.node_type = file.data.type;
          else if (type === 'case') existing.case_type = file.data.type;
        }
        if (file.data?.event_type && type === 'event') {
          existing.event_type = file.data.event_type;
        }
        
        console.log(`RegistryService: Updated ${file.fileId} - isDirty: ${existing.isDirty}, isOpen: ${existing.isOpen}`);
      } else {
        // Orphan file (not in index)
        itemsMap.set(normalizedId, {
          id: normalizedId,
          type: type as ObjectType,
          name: file.name,
          hasFile: true,
          isLocal: file.isLocal || false,
          isDirty: file.isDirty || false,
          isOpen: tabs.some((tab: any) => tab.fileId === file.fileId),
          inIndex: false,
          isOrphan: true,
          lastModified: file.lastModified,
          lastOpened: file.lastOpened,
          // Extract type from file data
          parameter_type: type === 'parameter' && file.data?.type ? file.data.type : undefined,
          node_type: type === 'node' && file.data?.type ? file.data.type : undefined,
          case_type: type === 'case' && file.data?.type ? file.data.type : undefined,
          event_type: type === 'event' && file.data?.event_type ? file.data.event_type : undefined
        });
      }
    }
    
    // 4. Mark orphans (has file but not in index)
    for (const item of itemsMap.values()) {
      if (item.hasFile && !item.inIndex) {
        item.isOrphan = true;
      }
    }
    
    return Array.from(itemsMap.values());
  }

  /**
   * Get all parameters
   */
  async getParameters(tabs: any[] = []): Promise<RegistryItem[]> {
    return this.getItems('parameter', tabs);
  }

  /**
   * Get parameters filtered by type
   */
  async getParametersByType(parameterType: 'probability' | 'cost_gbp' | 'cost_time', tabs: any[] = []): Promise<RegistryItem[]> {
    const allParams = await this.getParameters(tabs);
    
    // Schema uses 'type' field directly with values: probability, cost_gbp, cost_time
    // This is stored in RegistryItem.parameter_type
    return allParams.filter(p => p.parameter_type === parameterType);
  }

  /**
   * Get all contexts
   */
  async getContexts(tabs: any[] = []): Promise<RegistryItem[]> {
    return this.getItems('context', tabs);
  }

  /**
   * Get all cases
   */
  async getCases(tabs: any[] = []): Promise<RegistryItem[]> {
    return this.getItems('case', tabs);
  }

  /**
   * Get all nodes
   */
  async getNodes(tabs: any[] = []): Promise<RegistryItem[]> {
    return this.getItems('node', tabs);
  }

  /**
   * Get all events
   */
  async getEvents(tabs: any[] = []): Promise<RegistryItem[]> {
    return this.getItems('event', tabs);
  }

  /**
   * Get a specific item by ID and type
   */
  async getItem(type: 'parameter' | 'context' | 'case' | 'node' | 'event', id: string): Promise<RegistryItem | null> {
    const items = await this.getItems(type);
    const normalizedId = this.normalizeId(id, type);
    return items.find(item => item.id === normalizedId) || null;
  }

  /**
   * Check if an item exists in the registry
   */
  async exists(type: 'parameter' | 'context' | 'case' | 'node', id: string): Promise<boolean> {
    const item = await this.getItem(type, id);
    return item !== null;
  }
}

// Export singleton instance
export const registryService = new RegistryService();

