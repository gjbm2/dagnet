/**
 * Where Used Service
 * 
 * Scans all files in the workspace to find references to a specific file.
 * Produces a report showing where the file is used.
 */

import { db } from '../db/appDatabase';
import { ObjectType } from '../types';
import { LogFileService } from './logFileService';
import type { TabOperations } from '../types';
import { sessionLogService } from './sessionLogService';

export interface WhereUsedReference {
  fileId: string;
  type: ObjectType | 'system';
  location: string;  // e.g., "edges[0].p.id", "nodes[2].event_id"
  context?: string;  // Additional context about the reference
}

export interface WhereUsedResult {
  targetFileId: string;
  targetType: ObjectType;
  targetId: string;
  references: WhereUsedReference[];
  logContent: string;
}

export interface WhereUsedSummary {
  targetFileId: string;
  referenceCount: number;
  tooltip: string;  // Simple text for tooltip display
}

/**
 * Where Used Service
 * 
 * Finds all places where a file is referenced across the workspace.
 */
export class WhereUsedService {
  
  /**
   * Find all references to a file
   */
  static async findReferences(
    fileId: string,
    tabOperations: TabOperations,
    createLog: boolean = true
  ): Promise<WhereUsedResult> {
    
    sessionLogService.info('file', 'WHERE_USED', `Finding references to ${fileId}`);
    
    // Parse fileId to get type and id
    const [type, ...idParts] = fileId.split('-');
    const targetId = idParts.join('-');
    const targetType = type as ObjectType;
    
    const references: WhereUsedReference[] = [];
    
    try {
      // Get all files from IndexedDB
      const allFiles = await db.files.toArray();
      console.log(`🔍 WhereUsedService: Scanning ${allFiles.length} files for references to ${targetId}`);
      
      for (const file of allFiles) {
        // Skip index files, logs, and the file itself
        if (file.fileId.endsWith('-index')) continue;
        if (file.fileId.startsWith('log-')) continue;
        if (file.type === 'credentials' || file.type === 'connections') continue;
        
        // Extract clean fileId (strip workspace prefix if present)
        const cleanFileId = this.extractCleanFileId(file.fileId);
        if (cleanFileId === fileId) continue;
        
        // Scan based on file type
        if (file.type === 'graph') {
          this.scanGraphForReferences(cleanFileId, file.data, targetType, targetId, references);
        } else if (['parameter', 'case', 'context', 'node', 'event'].includes(file.type)) {
          this.scanDataFileForReferences(cleanFileId, file.type as ObjectType, file.data, targetType, targetId, references);
        }
      }
      
      // Generate report
      const logContent = this.generateReport(fileId, targetType, targetId, references);
      
      // Create log file if requested
      if (createLog && tabOperations) {
        await LogFileService.createLogFile(logContent, tabOperations, 'Where Used Report');
      }
      
      sessionLogService.success('file', 'WHERE_USED_COMPLETE', 
        `Found ${references.length} reference(s) to ${targetId}`);
      
      return {
        targetFileId: fileId,
        targetType,
        targetId,
        references,
        logContent
      };
      
    } catch (error) {
      sessionLogService.error('file', 'WHERE_USED_ERROR', 
        `Error finding references: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }
  
  /**
   * Get a lightweight tooltip summary showing where a file is used.
   * This is a faster version that doesn't create log files or session logs.
   * Returns a simple text summary suitable for tooltip display.
   */
  static async getTooltipSummary(fileId: string): Promise<WhereUsedSummary> {
    // Parse fileId to get type and id
    const [type, ...idParts] = fileId.split('-');
    const targetId = idParts.join('-');
    const targetType = type as ObjectType;
    
    const references: WhereUsedReference[] = [];
    
    try {
      // Get all files from IndexedDB
      const allFiles = await db.files.toArray();
      
      for (const file of allFiles) {
        // Skip index files, logs, and the file itself
        if (file.fileId.endsWith('-index')) continue;
        if (file.fileId.startsWith('log-')) continue;
        if (file.type === 'credentials' || file.type === 'connections') continue;
        
        // Extract clean fileId (strip workspace prefix if present)
        const cleanFileId = this.extractCleanFileId(file.fileId);
        if (cleanFileId === fileId) continue;
        
        // Scan based on file type
        if (file.type === 'graph') {
          this.scanGraphForReferences(cleanFileId, file.data, targetType, targetId, references);
        } else if (['parameter', 'case', 'context', 'node', 'event'].includes(file.type)) {
          this.scanDataFileForReferences(cleanFileId, file.type as ObjectType, file.data, targetType, targetId, references);
        }
      }
      
      // Generate simple tooltip text
      const tooltip = this.generateTooltipText(targetId, targetType, references);
      
      return {
        targetFileId: fileId,
        referenceCount: references.length,
        tooltip
      };
      
    } catch (error) {
      return {
        targetFileId: fileId,
        referenceCount: 0,
        tooltip: `Error scanning references: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }
  
  /**
   * Generate simple tooltip text from references
   */
  private static generateTooltipText(
    targetId: string,
    targetType: ObjectType,
    references: WhereUsedReference[]
  ): string {
    if (references.length === 0) {
      return `${targetId}\n\nNot used anywhere`;
    }
    
    // Group by file
    const byFile = new Map<string, WhereUsedReference[]>();
    for (const ref of references) {
      if (!byFile.has(ref.fileId)) {
        byFile.set(ref.fileId, []);
      }
      byFile.get(ref.fileId)!.push(ref);
    }
    
    const lines: string[] = [];
    lines.push(targetId);
    lines.push('');
    lines.push(`Used in ${byFile.size} file${byFile.size === 1 ? '' : 's'}:`);
    
    // Show up to 5 files, then summarize
    const sortedFiles = Array.from(byFile.entries());
    const maxToShow = 5;
    
    for (let i = 0; i < Math.min(sortedFiles.length, maxToShow); i++) {
      const [refFileId, fileRefs] = sortedFiles[i];
      // Extract just the ID part from fileId (e.g., "graph-my-graph" -> "my-graph")
      const displayId = refFileId.replace(/^(graph|parameter|case|node|event|context)-/, '');
      const refCount = fileRefs.length;
      lines.push(`  • ${displayId}${refCount > 1 ? ` (${refCount}×)` : ''}`);
    }
    
    if (sortedFiles.length > maxToShow) {
      lines.push(`  ... and ${sortedFiles.length - maxToShow} more`);
    }
    
    return lines.join('\n');
  }
  
  /**
   * Extract clean fileId (strip workspace prefix)
   */
  private static extractCleanFileId(fileId: string): string {
    // Workspace prefix format: "repo-branch-type-id"
    // Clean fileId format: "type-id"
    const parts = fileId.split('-');
    
    // If it looks like it has a workspace prefix (4+ parts and 3rd part is a type)
    const types = ['parameter', 'case', 'context', 'node', 'event', 'graph', 'image'];
    if (parts.length >= 4) {
      // Check if any part is a type
      for (let i = 2; i < parts.length - 1; i++) {
        if (types.includes(parts[i])) {
          // Return from type onwards
          return parts.slice(i).join('-');
        }
      }
    }
    
    return fileId;
  }
  
  /**
   * Scan a graph file for references
   */
  private static scanGraphForReferences(
    graphFileId: string,
    data: any,
    targetType: ObjectType,
    targetId: string,
    references: WhereUsedReference[]
  ): void {
    if (!data) return;
    
    const nodes = data.nodes || [];
    const edges = data.edges || [];
    
    // Scan nodes
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      
      // Event references
      if (targetType === 'event' && node.event_id === targetId) {
        references.push({
          fileId: graphFileId,
          type: 'graph',
          location: `nodes[${i}].event_id`,
          context: `Node "${node.id || node.uuid}" links to event`
        });
      }
      
      // Node file references (node_id links graph node to registry node file)
      if (targetType === 'node' && node.node_id === targetId) {
        references.push({
          fileId: graphFileId,
          type: 'graph',
          location: `nodes[${i}].node_id`,
          context: `Node "${node.id || node.uuid}" links to node definition`
        });
      }
      
      // Case references in nodes
      if (targetType === 'case' && node.case?.id === targetId) {
        references.push({
          fileId: graphFileId,
          type: 'graph',
          location: `nodes[${i}].case.id`,
          context: `Node "${node.id || node.uuid}" references case`
        });
      }
    }
    
    // Scan edges
    for (let i = 0; i < edges.length; i++) {
      const edge = edges[i];
      const edgeLabel = edge.id || `${edge.from}->${edge.to}`;
      
      // Parameter references (p.id)
      if (targetType === 'parameter') {
        if (edge.p?.id === targetId) {
          references.push({
            fileId: graphFileId,
            type: 'graph',
            location: `edges[${i}].p.id`,
            context: `Edge "${edgeLabel}" probability parameter`
          });
        }
        
        // Cost references
        if (edge.cost_gbp?.id === targetId) {
          references.push({
            fileId: graphFileId,
            type: 'graph',
            location: `edges[${i}].cost_gbp.id`,
            context: `Edge "${edgeLabel}" cost (GBP) parameter`
          });
        }
        
        if (edge.cost_time?.id === targetId) {
          references.push({
            fileId: graphFileId,
            type: 'graph',
            location: `edges[${i}].cost_time.id`,
            context: `Edge "${edgeLabel}" cost (time) parameter`
          });
        }
        
        // Conditional probability references
        if (edge.conditional_p) {
          for (let j = 0; j < edge.conditional_p.length; j++) {
            if (edge.conditional_p[j].p?.id === targetId) {
              const condition = edge.conditional_p[j].condition || `condition[${j}]`;
              references.push({
                fileId: graphFileId,
                type: 'graph',
                location: `edges[${i}].conditional_p[${j}].p.id`,
                context: `Edge "${edgeLabel}" conditional probability (${condition})`
              });
            }
          }
        }
      }
      
      // Case references in edges
      if (targetType === 'case' && edge.case_id === targetId) {
        references.push({
          fileId: graphFileId,
          type: 'graph',
          location: `edges[${i}].case_id`,
          context: `Edge "${edgeLabel}" case variant`
        });
      }
    }
  }
  
  /**
   * Scan a data file (parameter, case, context, node, event) for references
   */
  private static scanDataFileForReferences(
    fileId: string,
    fileType: ObjectType,
    data: any,
    targetType: ObjectType,
    targetId: string,
    references: WhereUsedReference[]
  ): void {
    if (!data) return;
    
    // Recursively scan the data structure for ID references
    this.scanObjectForId(fileId, fileType, data, '', targetType, targetId, references);
  }
  
  /**
   * Recursively scan an object for ID references
   */
  private static scanObjectForId(
    fileId: string,
    fileType: ObjectType,
    obj: any,
    path: string,
    targetType: ObjectType,
    targetId: string,
    references: WhereUsedReference[]
  ): void {
    if (!obj || typeof obj !== 'object') return;
    
    // Check for direct ID references in common patterns
    const idFields = ['id', 'parameter_id', 'case_id', 'event_id', 'node_id', 'context_id', 'ref'];
    
    for (const field of idFields) {
      if (obj[field] === targetId) {
        // Make sure it's the right type of reference
        if (this.isRelevantReference(field, targetType)) {
          const location = path ? `${path}.${field}` : field;
          references.push({
            fileId,
            type: fileType,
            location,
            context: `References ${targetType} "${targetId}"`
          });
        }
      }
    }
    
    // Recurse into arrays and objects
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        const itemPath = path ? `${path}[${i}]` : `[${i}]`;
        this.scanObjectForId(fileId, fileType, obj[i], itemPath, targetType, targetId, references);
      }
    } else {
      for (const key of Object.keys(obj)) {
        // Skip metadata and non-reference fields
        if (['metadata', 'created_at', 'updated_at', 'version'].includes(key)) continue;
        
        const valuePath = path ? `${path}.${key}` : key;
        this.scanObjectForId(fileId, fileType, obj[key], valuePath, targetType, targetId, references);
      }
    }
  }
  
  /**
   * Check if a field name is relevant for the target type
   */
  private static isRelevantReference(field: string, targetType: ObjectType): boolean {
    const fieldTypeMap: Record<string, ObjectType[]> = {
      'id': ['parameter', 'case', 'context', 'node', 'event'],  // Generic ID field
      'parameter_id': ['parameter'],
      'case_id': ['case'],
      'event_id': ['event'],
      'node_id': ['node'],
      'context_id': ['context'],
      'ref': ['parameter', 'case', 'context', 'node', 'event']  // Generic reference
    };
    
    return fieldTypeMap[field]?.includes(targetType) ?? false;
  }
  
  /**
   * Generate the markdown report
   */
  private static generateReport(
    fileId: string,
    targetType: ObjectType,
    targetId: string,
    references: WhereUsedReference[]
  ): string {
    const lines: string[] = [];
    const now = new Date();
    
    lines.push(`# Where Used Report - ${now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }).replace(/ /g, '-')}`);
    lines.push('');
    
    // Target info
    const typeIcon = this.getTypeIcon(targetType);
    lines.push(`## Target: ${typeIcon} ${targetId}`);
    lines.push('');
    lines.push(`- **File ID**: \`${fileId}\``);
    lines.push(`- **Type**: ${targetType}`);
    lines.push('');
    
    if (references.length === 0) {
      lines.push('## References');
      lines.push('');
      lines.push('*No references found. This file is not used anywhere in the workspace.*');
      lines.push('');
    } else {
      lines.push(`## References (${references.length})`);
      lines.push('');
      
      // Group by file
      const byFile = new Map<string, WhereUsedReference[]>();
      for (const ref of references) {
        if (!byFile.has(ref.fileId)) {
          byFile.set(ref.fileId, []);
        }
        byFile.get(ref.fileId)!.push(ref);
      }
      
      // Sort files by type for readability
      const sortedFiles = Array.from(byFile.entries()).sort((a, b) => {
        const typeOrder = { graph: 0, parameter: 1, case: 2, node: 3, event: 4, context: 5 };
        const aType = a[1][0].type as string;
        const bType = b[1][0].type as string;
        return (typeOrder[aType as keyof typeof typeOrder] ?? 99) - (typeOrder[bType as keyof typeof typeOrder] ?? 99);
      });
      
      for (const [refFileId, fileRefs] of sortedFiles) {
        const refType = fileRefs[0].type;
        const icon = this.getTypeIcon(refType as ObjectType);
        
        // Create navigable link for the file
        const isNavigable = ['graph', 'parameter', 'case', 'node', 'event', 'context'].includes(refType as string);
        const fileLink = isNavigable 
          ? `[${refFileId}](#dagnet-file/${refFileId})`
          : `\`${refFileId}\``;
        
        lines.push(`### ${icon} ${fileLink}`);
        lines.push('');
        
        for (const ref of fileRefs) {
          lines.push(`- \`${ref.location}\`${ref.context ? ` - ${ref.context}` : ''}`);
        }
        lines.push('');
      }
    }
    
    lines.push('---');
    lines.push(`*Generated: ${now.toISOString()}*`);
    
    return lines.join('\n');
  }
  
  /**
   * Get icon for file type
   */
  private static getTypeIcon(type: ObjectType | 'system'): string {
    const icons: Record<string, string> = {
      graph: '📊',
      parameter: '📐',
      case: '📋',
      node: '⚫',
      event: '⚡',
      context: '🏷️',
      image: '🖼️',
      system: '⚙️'
    };
    return icons[type] || '📄';
  }
}

