/**
 * Integrity Check Service
 * 
 * DEEP FORENSIC INTEGRITY CHECK for all workspace files.
 * 
 * Validates:
 * - Schema validation (required fields, types, structure)
 * - ID format validation (valid characters, uniqueness per graph)
 * - Referential integrity (all references point to existing files)
 * - Graph structure (edges connect valid nodes, no orphans)
 * - Index/Registry consistency (entries match actual files, no orphans)
 * - Data connection validation (connections exist and are valid)
 * - Value validation (probabilities in [0,1], costs ≥ 0, weights sum to 1)
 * - Orphan detection (files never referenced by any graph)
 * - Duplicate detection (duplicate IDs, UUIDs)
 * - Cross-graph consistency (same IDs used consistently)
 * - Naming consistency (id matches filename)
 * - Metadata completeness
 */

import { db } from '../db/appDatabase';
import { ObjectType } from '../types';
import { LogFileService } from './logFileService';
import type { TabOperations } from '../types';
import { credentialsManager } from '../lib/credentials';

type IssueSeverity = 'error' | 'warning' | 'info';

type IssueCategory = 
  | 'schema'           // Missing required fields, invalid types
  | 'id-format'        // Invalid ID format (characters, length)
  | 'reference'        // Broken references to other files
  | 'graph-structure'  // Invalid graph topology
  | 'registry'         // Registry/index file inconsistencies
  | 'connection'       // Data connection issues
  | 'credentials'      // Missing or invalid credentials
  | 'value'            // Invalid numeric values
  | 'orphan'           // Unreferenced files
  | 'duplicate'        // Duplicate IDs/UUIDs
  | 'naming'           // Naming inconsistencies
  | 'metadata'         // Metadata issues
  | 'sync'             // Registry vs file content mismatch
  | 'image';           // Image file issues (missing, orphaned)

interface IntegrityIssue {
  fileId: string;
  type: ObjectType | 'system';
  severity: IssueSeverity;
  category: IssueCategory;
  message: string;
  field?: string;
  suggestion?: string;
  details?: string;
  // Deep linking: node/edge identifiers for graph issues
  nodeUuid?: string;
  edgeUuid?: string;
}

interface IntegrityResult {
  success: boolean;
  totalFiles: number;
  issues: IntegrityIssue[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
    byCategory: Record<IssueCategory, number>;
  };
  stats: {
    graphs: number;
    parameters: number;
    cases: number;
    nodes: number;
    events: number;
    contexts: number;
    connections: number;
  };
  logContent: string;
}

// ID format validation - based on schema definitions in public/param-schemas/
// Schema pattern: ^[a-zA-Z0-9_-]+$ (letters, numbers, hyphens, underscores - NO spaces or >)
// Note: We don't validate graph-internal IDs (node.id, edge.id) as strictly since
// they are auto-generated UUIDs or "uuid-uuid" format, not user-facing file IDs
const SCHEMA_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MAX_ID_LENGTH = 64; // Per schema

// UUID format validation (v4 UUID)
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Integrity Check Service
 * 
 * Performs comprehensive, forensic-level integrity checks on all workspace files.
 * Does NOT modify files - only reports issues.
 */
export class IntegrityCheckService {
  
  /**
   * Check integrity of all files in the workspace
   * @param tabOperations Tab operations for file access
   * @param createLog Whether to create a log entry
   * @param workspace Optional workspace filter (repository/branch) - if provided, only checks files from that workspace
   */
  static async checkIntegrity(
    tabOperations: TabOperations,
    createLog: boolean = true,
    workspace?: { repository: string; branch: string }
  ): Promise<IntegrityResult> {
    const issues: IntegrityIssue[] = [];
    const startTime = new Date();
    const workspaceInfo = workspace ? `${workspace.repository}/${workspace.branch}` : 'all workspaces';
    
    try {
      // Get files from IndexedDB - filter by workspace if provided
      let allFiles;
      if (workspace) {
        allFiles = await db.files
          .where('source.repository').equals(workspace.repository)
          .and(file => file.source?.branch === workspace.branch)
          .toArray();
        console.log(`🔍 IntegrityCheckService: Deep checking ${allFiles.length} files from ${workspaceInfo}`);
      } else {
        allFiles = await db.files.toArray();
        console.log(`🔍 IntegrityCheckService: Deep checking ${allFiles.length} files from all workspaces`);
      }
      
      // ═══════════════════════════════════════════════════════════════════════
      // PHASE 1: Build comprehensive lookup maps
      // ═══════════════════════════════════════════════════════════════════════
      
      const parameterFiles = new Map<string, any>(); // id -> file (full file for registry sync)
      const caseFiles = new Map<string, any>();
      const contextFiles = new Map<string, any>();
      const nodeFiles = new Map<string, any>(); // registry node files
      const eventFiles = new Map<string, any>();
      const graphFiles: any[] = [];
      const indexFiles = new Map<string, any>(); // type -> index file
      const connectionNames = new Set<string>();
      const connectionDefs = new Map<string, any>(); // name -> connection definition
      
      // Track what's referenced to find orphans
      const referencedParams = new Set<string>();
      const referencedCases = new Set<string>();
      const referencedContexts = new Set<string>();
      const referencedNodes = new Set<string>();
      const referencedEvents = new Set<string>();
      
      // File stats
      const stats = {
        graphs: 0,
        parameters: 0,
        cases: 0,
        nodes: 0,
        events: 0,
        contexts: 0,
        connections: 0
      };
      
      // First pass: collect all IDs and build maps
      for (const file of allFiles) {
        if (file.source?.repository === 'temporary') continue;
        
        const fileData = file.data;
        
        // Handle index files
        if (file.fileId.endsWith('-index')) {
          const type = file.type as 'parameter' | 'context' | 'case' | 'node' | 'event';
          indexFiles.set(type, file);
          continue;
        }
        
        // Handle connections file
        if (file.type === 'connections') {
          stats.connections++;
          if (fileData?.connections && Array.isArray(fileData.connections)) {
            for (const conn of fileData.connections) {
              if (conn.name) {
                connectionNames.add(conn.name);
                // Also store full connection for credential validation
                connectionDefs.set(conn.name, conn);
              }
            }
          }
          continue;
        }
        
        // Skip system files
        if (['credentials', 'settings', 'markdown', 'about'].includes(file.type)) {
          continue;
        }
        
        if (!fileData) continue;
        
        switch (file.type) {
          case 'parameter':
            stats.parameters++;
            if (fileData.id) parameterFiles.set(fileData.id, file);
            break;
          case 'case':
            stats.cases++;
            if (fileData.id) caseFiles.set(fileData.id, file);
            break;
          case 'context':
            stats.contexts++;
            if (fileData.id) contextFiles.set(fileData.id, file);
            break;
          case 'node':
            stats.nodes++;
            if (fileData.id) nodeFiles.set(fileData.id, file);
            break;
          case 'event':
            stats.events++;
            if (fileData.id) eventFiles.set(fileData.id, file);
            break;
          case 'graph':
            stats.graphs++;
            graphFiles.push(file);
            break;
        }
      }
      
      // ═══════════════════════════════════════════════════════════════════════
      // PHASE 2: Validate each file individually
      // ═══════════════════════════════════════════════════════════════════════
      
      for (const file of allFiles) {
        if (file.source?.repository === 'temporary') continue;
        if (['credentials', 'connections', 'settings', 'markdown', 'about'].includes(file.type)) continue;
        if (file.fileId.endsWith('-index')) continue;
        
        const fileData = file.data;
        // Extract expected ID from fileId, handling workspace prefixes
        // fileId format: "type-name" or "repo-branch-type-name"
        // We need to find the type marker and extract the name after it
        const expectedId = this.extractExpectedId(file.fileId, file.type);
        
        // ─────────────────────────────────────────────────────────────────────
        // Empty/Null Data Check
        // ─────────────────────────────────────────────────────────────────────
        
        if (!fileData || (typeof fileData === 'object' && Object.keys(fileData).length === 0)) {
          issues.push({
            fileId: file.fileId,
            type: file.type,
            severity: 'error',
            category: 'schema',
            message: 'File has empty or null data',
            suggestion: 'File may be corrupted - consider deleting and recreating'
          });
          continue;
        }
        
        // ─────────────────────────────────────────────────────────────────────
        // Schema Validation (non-graph files)
        // ─────────────────────────────────────────────────────────────────────
        
        if (file.type !== 'graph') {
          // Required id field
          if (!fileData.id) {
            issues.push({
              fileId: file.fileId,
              type: file.type,
              severity: 'error',
              category: 'schema',
              field: 'id',
              message: 'Missing required field: id',
              suggestion: `Add "id: ${expectedId}"`
            });
          } else {
            // Validate ID format against schema
            this.validateFileIdFormat(file.fileId, file.type, 'id', fileData.id, issues);
          }
          
          // Name field
          if (!fileData.name) {
            issues.push({
              fileId: file.fileId,
              type: file.type,
              severity: 'warning',
              category: 'schema',
              field: 'name',
              message: 'Missing field: name',
              suggestion: `Add "name: ${expectedId}"`
            });
          }
          
          // Metadata block
          if (!fileData.metadata) {
            issues.push({
              fileId: file.fileId,
              type: file.type,
              severity: 'warning',
              category: 'metadata',
              field: 'metadata',
              message: 'Missing metadata block',
              suggestion: 'Add metadata with created_at, updated_at, author'
            });
          } else {
            const requiredMetadata = ['created_at', 'updated_at'];
            for (const field of requiredMetadata) {
              if (!fileData.metadata[field]) {
                issues.push({
                  fileId: file.fileId,
                  type: file.type,
                  severity: 'info',
                  category: 'metadata',
                  field: `metadata.${field}`,
                  message: `Missing metadata field: ${field}`
                });
              }
            }
            
            // Validate date formats
            if (fileData.metadata.created_at && !this.isValidISODate(fileData.metadata.created_at)) {
              issues.push({
                fileId: file.fileId,
                type: file.type,
                severity: 'info',
                category: 'metadata',
                field: 'metadata.created_at',
                message: `Invalid date format: ${fileData.metadata.created_at}`,
                suggestion: 'Use ISO 8601 format (YYYY-MM-DDTHH:mm:ssZ)'
              });
            }
          }
          
          // Naming consistency
          if (fileData.id && fileData.id !== expectedId) {
            issues.push({
              fileId: file.fileId,
              type: file.type,
              severity: 'warning',
              category: 'naming',
              field: 'id',
              message: `ID "${fileData.id}" doesn't match filename "${expectedId}"`,
              suggestion: `Change id to "${expectedId}" or rename file`
            });
          }
        }
        
        // ─────────────────────────────────────────────────────────────────────
        // Type-Specific Validation
        // ─────────────────────────────────────────────────────────────────────
        
        if (file.type === 'parameter') {
          this.validateParameter(file, fileData, issues);
        } else if (file.type === 'case') {
          this.validateCase(file, fileData, issues);
        } else if (file.type === 'node') {
          this.validateNodeFile(file, fileData, issues, eventFiles);
        } else if (file.type === 'event') {
          this.validateEvent(file, fileData, issues);
        } else if (file.type === 'context') {
          this.validateContext(file, fileData, issues);
        } else if (file.type === 'graph') {
          this.validateGraph(
            file, fileData, issues,
            parameterFiles, caseFiles, contextFiles, nodeFiles, eventFiles, connectionNames,
            referencedParams, referencedCases, referencedContexts, referencedNodes, referencedEvents
          );
        }
      }
      
      // ═══════════════════════════════════════════════════════════════════════
      // PHASE 3: Registry/Index File Validation + Content Sync
      // ═══════════════════════════════════════════════════════════════════════
      
      this.validateRegistryFiles(
        indexFiles, parameterFiles, caseFiles, contextFiles, nodeFiles, eventFiles, issues
      );
      
      // ═══════════════════════════════════════════════════════════════════════
      // PHASE 4: Orphan Detection (files never referenced)
      // ═══════════════════════════════════════════════════════════════════════
      
      this.detectOrphans(
        parameterFiles, caseFiles, contextFiles, nodeFiles, eventFiles,
        referencedParams, referencedCases, referencedContexts, referencedNodes, referencedEvents,
        issues
      );
      
      // ═══════════════════════════════════════════════════════════════════════
      // PHASE 5: Duplicate Detection
      // ═══════════════════════════════════════════════════════════════════════
      
      this.detectDuplicates(allFiles, issues);
      
      // ═══════════════════════════════════════════════════════════════════════
      // PHASE 6: Cross-Graph Consistency
      // ═══════════════════════════════════════════════════════════════════════
      
      if (graphFiles.length > 1) {
        this.checkCrossGraphConsistency(graphFiles, issues);
      }
      
      // ═══════════════════════════════════════════════════════════════════════
      // PHASE 7: Credentials Validation (connections have required credentials)
      // ═══════════════════════════════════════════════════════════════════════
      
      await this.validateCredentials(connectionDefs, issues);
      
      // ═══════════════════════════════════════════════════════════════════════
      // PHASE 8: Image Validation (images referenced by nodes exist, orphan detection)
      // ═══════════════════════════════════════════════════════════════════════
      
      await this.validateImages(graphFiles, allFiles, issues);
      
      // ═══════════════════════════════════════════════════════════════════════
      // Generate Results
      // ═══════════════════════════════════════════════════════════════════════
      
      // Build category counts
      const byCategory: Record<IssueCategory, number> = {
        'schema': 0,
        'id-format': 0,
        'reference': 0,
        'graph-structure': 0,
        'registry': 0,
        'connection': 0,
        'credentials': 0,
        'value': 0,
        'orphan': 0,
        'duplicate': 0,
        'naming': 0,
        'metadata': 0,
        'sync': 0,
        'image': 0
      };
      
      for (const issue of issues) {
        byCategory[issue.category]++;
      }
      
      const summary = {
        errors: issues.filter(i => i.severity === 'error').length,
        warnings: issues.filter(i => i.severity === 'warning').length,
        info: issues.filter(i => i.severity === 'info').length,
        byCategory
      };
      
      const logContent = this.generateLogContent(allFiles.length, issues, summary, stats, startTime);
      
      if (createLog) {
        await LogFileService.createLogFile(logContent, tabOperations, 'Integrity Check Report');
      }
      
      return {
        success: summary.errors === 0,
        totalFiles: allFiles.length,
        issues,
        summary,
        stats,
        logContent
      };
      
    } catch (error) {
      throw error;
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ═══════════════════════════════════════════════════════════════════════════
  
  /**
   * Extract the expected ID from a fileId, handling workspace prefixes.
   * FileId formats:
   * - "parameter-coffee-to-bds" → "coffee-to-bds"
   * - "nous-conversion-main-parameter-coffee-to-bds" → "coffee-to-bds"
   */
  private static extractExpectedId(fileId: string, type: string): string {
    // Type markers that indicate the start of the actual file type
    const typeMarker = `${type}-`;
    const idx = fileId.indexOf(typeMarker);
    
    if (idx >= 0) {
      // Found the type marker - extract everything after "type-"
      return fileId.substring(idx + typeMarker.length);
    }
    
    // Fallback: no type marker found, use old logic (split by first hyphen)
    const firstHyphen = fileId.indexOf('-');
    return firstHyphen >= 0 ? fileId.substring(firstHyphen + 1) : fileId;
  }
  
  /**
   * Get the canonical (normalized) fileId by stripping workspace prefix.
   * Used for comparing files that might have different prefixes.
   * 
   * Examples:
   * - "nous-conversion-main-parameter-coffee-to-bds" → "parameter-coffee-to-bds"
   * - "parameter-coffee-to-bds" → "parameter-coffee-to-bds"
   * - "graph-myname" → "graph-myname"
   * - "repo-branch-graph-myname" → "graph-myname"
   */
  static getCanonicalFileId(fileId: string, type: string): string {
    const typeMarker = `${type}-`;
    const idx = fileId.indexOf(typeMarker);
    
    if (idx > 0) {
      // Found type marker not at start - strip workspace prefix
      return fileId.substring(idx);
    }
    
    // No prefix or already canonical
    return fileId;
  }
  
  /**
   * Get a human-readable display name from a fileId.
   * Strips workspace prefix and type prefix to get just the name.
   * 
   * Examples:
   * - "nous-conversion-main-parameter-coffee-to-bds" → "coffee-to-bds"
   * - "parameter-coffee-to-bds" → "coffee-to-bds"
   * - "graph-myname" → "myname"
   */
  static getDisplayName(fileId: string, type: string): string {
    return this.extractExpectedId(fileId, type);
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // ID FORMAT VALIDATION
  // ═══════════════════════════════════════════════════════════════════════════
  
  /**
   * Validate ID format against schema rules.
   * Schema pattern: ^[a-z0-9-]+$ (lowercase letters, numbers, hyphens)
   * 
   * Note: This is for FILE IDs only (parameter, case, node, event, context).
   * Graph-internal IDs (node.uuid, edge.uuid, edge.id) are NOT validated here
   * as they use UUIDs or auto-generated formats.
   */
  private static validateFileIdFormat(
    fileId: string,
    type: ObjectType | 'system',
    field: string,
    id: string,
    issues: IntegrityIssue[],
    nodeUuid?: string,
    edgeUuid?: string
  ): void {
    if (!id) return;
    
    // Check length (per schema: maxLength: 64)
    if (id.length > MAX_ID_LENGTH) {
      issues.push({
        fileId,
        type,
        severity: 'warning',
        category: 'id-format',
        field,
        message: `ID exceeds max length (${id.length} > ${MAX_ID_LENGTH})`,
        suggestion: 'Use a shorter identifier (max 64 chars)',
        nodeUuid,
        edgeUuid
      });
    }
    
    // Check valid characters per schema: ^[a-zA-Z0-9_-]+$
    // Invalid: spaces, >, <, etc.
    if (!SCHEMA_ID_PATTERN.test(id)) {
      // Provide specific feedback
      const hasSpace = / /.test(id);
      const hasGreaterThan = />/.test(id);
      const hasInvalidChars = /[^a-zA-Z0-9_-]/.test(id);
      
      let suggestion = 'Use letters, numbers, hyphens, and underscores only';
      if (hasSpace) {
        suggestion = `Replace spaces with hyphens: "${id.replace(/ /g, '-')}"`;
      } else if (hasGreaterThan) {
        suggestion = `Replace ">" with "-": "${id.replace(/>/g, '-')}"`;
      }
      
      issues.push({
        fileId,
        type,
        severity: 'warning',
        category: 'id-format',
        field,
        message: `ID "${id}" contains invalid characters (spaces, > not allowed)`,
        suggestion,
        nodeUuid,
        edgeUuid
      });
    }
  }
  
  private static validateUuidFormat(
    fileId: string,
    type: ObjectType | 'system',
    field: string,
    uuid: string,
    issues: IntegrityIssue[],
    nodeUuid?: string,
    edgeUuid?: string
  ): void {
    if (!uuid) return;
    
    if (!UUID_PATTERN.test(uuid)) {
      issues.push({
        fileId,
        type,
        severity: 'warning',
        category: 'id-format',
        field,
        message: `Invalid UUID format: "${uuid}"`,
        suggestion: 'UUIDs should be v4 format (xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx)',
        nodeUuid,
        edgeUuid
      });
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // PARAMETER VALIDATION
  // ═══════════════════════════════════════════════════════════════════════════
  
  private static validateParameter(file: any, data: any, issues: IntegrityIssue[]): void {
    // Required type field
    if (!data.type && !data.parameter_type) {
      issues.push({
        fileId: file.fileId,
        type: file.type,
        severity: 'warning',
        category: 'schema',
        field: 'type',
        message: 'Missing parameter type',
        suggestion: 'Add "type: probability" or cost_gbp, labour_cost, etc.'
      });
    }
    
    // Values array
    if (!data.values || !Array.isArray(data.values)) {
      issues.push({
        fileId: file.fileId,
        type: file.type,
        severity: 'info',
        category: 'schema',
        field: 'values',
        message: 'Missing or invalid values array'
      });
    } else {
      // Validate each value entry
      for (let i = 0; i < data.values.length; i++) {
        const val = data.values[i];
        
        // Check probability range
        if (data.type === 'probability' || val.type === 'probability') {
          if (typeof val.value === 'number') {
            if (val.value < 0 || val.value > 1) {
              issues.push({
                fileId: file.fileId,
                type: file.type,
                severity: 'error',
                category: 'value',
                field: `values[${i}].value`,
                message: `Probability ${val.value} out of range [0, 1]`
              });
            }
          }
        }
        
        // Check cost is non-negative
        if (['cost', 'cost_gbp', 'labour_cost'].includes(data.type)) {
          if (typeof val.value === 'number' && val.value < 0) {
            issues.push({
              fileId: file.fileId,
              type: file.type,
              severity: 'warning',
              category: 'value',
              field: `values[${i}].value`,
              message: `Negative cost value: ${val.value}`
            });
          }
        }
      }
    }
    
    // Check distribution if specified
    if (data.distribution) {
      const validDistributions = ['normal', 'beta', 'uniform', 'lognormal', 'gamma'];
      if (!validDistributions.includes(data.distribution)) {
        issues.push({
          fileId: file.fileId,
          type: file.type,
          severity: 'warning',
          category: 'schema',
          field: 'distribution',
          message: `Unknown distribution: ${data.distribution}`,
          suggestion: `Valid: ${validDistributions.join(', ')}`
        });
      }
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // CASE VALIDATION
  // ═══════════════════════════════════════════════════════════════════════════
  
  private static validateCase(file: any, data: any, issues: IntegrityIssue[]): void {
    // Check for case structure (per case-parameter-schema)
    if (!data.case) {
      issues.push({
        fileId: file.fileId,
        type: file.type,
        severity: 'warning',
        category: 'schema',
        field: 'case',
        message: 'Missing case block',
        suggestion: 'Case files should have a "case:" block with variants'
      });
      return;
    }
    
    // Variants array
    if (!data.case.variants || !Array.isArray(data.case.variants)) {
      issues.push({
        fileId: file.fileId,
        type: file.type,
        severity: 'warning',
        category: 'schema',
        field: 'case.variants',
        message: 'Missing or invalid variants array'
      });
    } else {
      const variants = data.case.variants;
      if (variants.length > 0) {
        let totalWeight = 0;
        let hasWeights = false;
        const variantNames = new Set<string>();
        
        for (let i = 0; i < variants.length; i++) {
          const variant = variants[i];
          
          if (!variant.name) {
            issues.push({
              fileId: file.fileId,
              type: file.type,
              severity: 'warning',
              category: 'schema',
              field: `case.variants[${i}].name`,
              message: 'Variant missing name'
            });
          } else {
            // Check for duplicate variant names
            if (variantNames.has(variant.name)) {
              issues.push({
                fileId: file.fileId,
                type: file.type,
                severity: 'warning',
                category: 'duplicate',
                field: `case.variants[${i}].name`,
                message: `Duplicate variant name: "${variant.name}"`
              });
            }
            variantNames.add(variant.name);
          }
          
          if (typeof variant.weight === 'number') {
            hasWeights = true;
            totalWeight += variant.weight;
            
            if (variant.weight < 0 || variant.weight > 1) {
              issues.push({
                fileId: file.fileId,
                type: file.type,
                severity: 'error',
                category: 'value',
                field: `case.variants[${i}].weight`,
                message: `Variant weight ${variant.weight} out of range [0, 1]`
              });
            }
          }
        }
        
        if (hasWeights && Math.abs(totalWeight - 1.0) > 0.001) {
          issues.push({
            fileId: file.fileId,
            type: file.type,
            severity: 'error',
            category: 'value',
            field: 'case.variants',
            message: `Variant weights sum to ${totalWeight.toFixed(4)}, should be 1.0`
          });
        }
      }
    }
    
    // Status check
    if (data.case.status) {
      const validStatuses = ['active', 'paused', 'completed', 'draft', 'archived', 'deprecated'];
      if (!validStatuses.includes(data.case.status)) {
        issues.push({
          fileId: file.fileId,
          type: file.type,
          severity: 'info',
          category: 'schema',
          field: 'case.status',
          message: `Unknown status: ${data.case.status}`
        });
      }
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // NODE FILE (REGISTRY) VALIDATION
  // ═══════════════════════════════════════════════════════════════════════════
  
  private static validateNodeFile(
    file: any,
    data: any,
    issues: IntegrityIssue[],
    eventFiles: Map<string, any>
  ): void {
    // Node type validation
    if (data.type) {
      const validTypes = ['normal', 'case', 'entry', 'exit', 'terminal'];
      if (!validTypes.includes(data.type)) {
        issues.push({
          fileId: file.fileId,
          type: file.type,
          severity: 'info',
          category: 'schema',
          field: 'type',
          message: `Unknown node type: ${data.type}`
        });
      }
    }
    
    // Check event_id reference (schema allows underscores: ^[a-z0-9_]+$)
    if (data.event_id) {
      // event_id has different schema pattern - skip format validation, just check reference
      if (!eventFiles.has(data.event_id)) {
        issues.push({
          fileId: file.fileId,
          type: file.type,
          severity: 'warning',
          category: 'reference',
          field: 'event_id',
          message: `References non-existent event: ${data.event_id}`,
          suggestion: 'Create the event file or remove the reference'
        });
      }
    }
    
    // Outcome type validation
    if (data.outcome_type) {
      const validOutcomes = ['conversion', 'exit', 'success', 'failure', 'neutral'];
      if (!validOutcomes.includes(data.outcome_type)) {
        issues.push({
          fileId: file.fileId,
          type: file.type,
          severity: 'info',
          category: 'schema',
          field: 'outcome_type',
          message: `Unknown outcome_type: ${data.outcome_type}`
        });
      }
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // EVENT FILE VALIDATION
  // ═══════════════════════════════════════════════════════════════════════════
  
  private static validateEvent(file: any, data: any, issues: IntegrityIssue[]): void {
    // Event type/category
    if (!data.event_type && !data.category) {
      issues.push({
        fileId: file.fileId,
        type: file.type,
        severity: 'info',
        category: 'schema',
        field: 'event_type',
        message: 'Missing event type/category'
      });
    }
    
    // Check for provider-specific event names
    if (data.provider_events) {
      if (typeof data.provider_events !== 'object') {
        issues.push({
          fileId: file.fileId,
          type: file.type,
          severity: 'warning',
          category: 'schema',
          field: 'provider_events',
          message: 'provider_events should be an object'
        });
      }
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // CONTEXT FILE VALIDATION
  // ═══════════════════════════════════════════════════════════════════════════
  
  private static validateContext(file: any, data: any, issues: IntegrityIssue[]): void {
    // Variables should be an object if present
    if (data.variables && typeof data.variables !== 'object') {
      issues.push({
        fileId: file.fileId,
        type: file.type,
        severity: 'warning',
        category: 'schema',
        field: 'variables',
        message: 'variables should be an object'
      });
    }
    
    // Check for context type (schema uses 'type' field with enum: categorical, ordinal, continuous)
    if (!data.type) {
      issues.push({
        fileId: file.fileId,
        type: file.type,
        severity: 'info',
        category: 'schema',
        field: 'type',
        message: 'Missing context type (should be: categorical, ordinal, or continuous)'
      });
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // GRAPH VALIDATION (COMPREHENSIVE)
  // ═══════════════════════════════════════════════════════════════════════════
  
  private static validateGraph(
    file: any,
    data: any,
    issues: IntegrityIssue[],
    parameterFiles: Map<string, any>,
    caseFiles: Map<string, any>,
    contextFiles: Map<string, any>,
    nodeFiles: Map<string, any>,
    eventFiles: Map<string, any>,
    connectionNames: Set<string>,
    referencedParams: Set<string>,
    referencedCases: Set<string>,
    referencedContexts: Set<string>,
    referencedNodes: Set<string>,
    referencedEvents: Set<string>
  ): void {
    const nodes = data.nodes || [];
    const edges = data.edges || [];
    const graphFileId = file.fileId;
    
    // Build node UUID lookup for this graph
    const nodeUuids = new Set<string>();
    const nodeHumanIds = new Set<string>();
    
    // ─────────────────────────────────────────────────────────────────────────
    // Graph Metadata
    // ─────────────────────────────────────────────────────────────────────────
    
    if (!data.metadata) {
      issues.push({
        fileId: graphFileId,
        type: 'graph',
        severity: 'warning',
        category: 'metadata',
        message: 'Graph missing metadata block'
      });
    }
    
    if (!data.policies) {
      issues.push({
        fileId: graphFileId,
        type: 'graph',
        severity: 'info',
        category: 'schema',
        message: 'Graph missing policies block'
      });
    }
    
    // ─────────────────────────────────────────────────────────────────────────
    // Node Validation
    // ─────────────────────────────────────────────────────────────────────────
    
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      
      // UUID validation
      if (!node.uuid) {
        issues.push({
          fileId: graphFileId,
          type: 'graph',
          severity: 'error',
          category: 'graph-structure',
          field: `nodes[${i}]`,
          message: 'Node missing uuid'
        });
      } else {
        this.validateUuidFormat(graphFileId, 'graph', `nodes[${i}].uuid`, node.uuid, issues, node.uuid);
        
        // Check for duplicate UUIDs
        if (nodeUuids.has(node.uuid)) {
          issues.push({
            fileId: graphFileId,
            type: 'graph',
            severity: 'error',
            category: 'duplicate',
            field: `nodes[${i}].uuid`,
            message: `Duplicate node UUID: ${node.uuid.substring(0, 8)}...`,
            nodeUuid: node.uuid
          });
        }
        nodeUuids.add(node.uuid);
      }
      
      // Human ID validation
      if (!node.id) {
        issues.push({
          fileId: graphFileId,
          type: 'graph',
          severity: 'warning',
          category: 'schema',
          field: `nodes[${i}]`,
          message: 'Node missing human-readable id',
          nodeUuid: node.uuid
        });
      } else {
        // Note: node.id is a human-readable label in the graph, not a schema-validated file ID
        // It can be any format (often matches a file ID, but not required)
        if (nodeHumanIds.has(node.id)) {
          issues.push({
            fileId: graphFileId,
            type: 'graph',
            severity: 'warning',
            category: 'duplicate',
            field: `nodes[${i}].id`,
            message: `Duplicate node id in graph: "${node.id}"`,
            nodeUuid: node.uuid
          });
        }
        nodeHumanIds.add(node.id);
      }
      
      // Event reference (event_id can have underscores per schema)
      if (node.event_id) {
        referencedEvents.add(node.event_id);
        if (!eventFiles.has(node.event_id)) {
          issues.push({
            fileId: graphFileId,
            type: 'graph',
            severity: 'warning',
            category: 'reference',
            field: `nodes[${i}].event_id`,
            message: `Node references non-existent event: ${node.event_id}`,
            nodeUuid: node.uuid
          });
        }
      }
      
      // Case reference
      // Note: If node.type === 'case', the case is defined inline on the node itself (not a reference)
      // Only warn about missing external case file if it's NOT an inline definition
      if (node.case?.id) {
        referencedCases.add(node.case.id);
        this.validateFileIdFormat(graphFileId, 'graph', `nodes[${i}].case.id`, node.case.id, issues, node.uuid);
        
        // Only warn if node.type !== 'case' (i.e., it's a reference, not an inline definition)
        // When node.type === 'case', the case.id is the ID OF this case, not a reference to another file
        const isInlineCaseDefinition = node.type === 'case';
        if (!caseFiles.has(node.case.id) && !isInlineCaseDefinition) {
          issues.push({
            fileId: graphFileId,
            type: 'graph',
            severity: 'warning',
            category: 'reference',
            field: `nodes[${i}].case.id`,
            message: `Node references non-existent case: ${node.case.id}`,
            nodeUuid: node.uuid
          });
        }
        
        // Validate case connection
        if (node.case.connection && connectionNames.size > 0) {
          if (!connectionNames.has(node.case.connection)) {
            issues.push({
              fileId: graphFileId,
              type: 'graph',
              severity: 'warning',
              category: 'connection',
              field: `nodes[${i}].case.connection`,
              message: `Unknown connection: ${node.case.connection}`,
              nodeUuid: node.uuid
            });
          }
        }
        
        // Validate case variants if present
        if (node.case.variants && Array.isArray(node.case.variants)) {
          let totalWeight = 0;
          let hasWeights = false;
          
          for (let j = 0; j < node.case.variants.length; j++) {
            const variant = node.case.variants[j];
            if (typeof variant.weight === 'number') {
              hasWeights = true;
              totalWeight += variant.weight;
            }
          }
          
          if (hasWeights && Math.abs(totalWeight - 1.0) > 0.001) {
            issues.push({
              fileId: graphFileId,
              type: 'graph',
              severity: 'error',
              category: 'value',
              field: `nodes[${i}].case.variants`,
              message: `Variant weights sum to ${totalWeight.toFixed(4)}, not 1.0`,
              nodeUuid: node.uuid
            });
          }
        }
      }
      
      // Context reference
      if (node.context?.id) {
        referencedContexts.add(node.context.id);
        if (!contextFiles.has(node.context.id)) {
          issues.push({
            fileId: graphFileId,
            type: 'graph',
            severity: 'info',
            category: 'reference',
            field: `nodes[${i}].context.id`,
            message: `Node references non-existent context: ${node.context.id}`,
            nodeUuid: node.uuid
          });
        }
      }
      
      // Entry weight validation
      if (node.entry?.entry_weight !== undefined) {
        if (typeof node.entry.entry_weight === 'number' && node.entry.entry_weight < 0) {
          issues.push({
            fileId: graphFileId,
            type: 'graph',
            severity: 'warning',
            category: 'value',
            field: `nodes[${i}].entry.entry_weight`,
            message: `Negative entry weight: ${node.entry.entry_weight}`,
            nodeUuid: node.uuid
          });
        }
      }
    }
    
    // ─────────────────────────────────────────────────────────────────────────
    // Edge Validation
    // ─────────────────────────────────────────────────────────────────────────
    
    const edgeUuids = new Set<string>();
    const edgeHumanIds = new Set<string>();
    const connectedNodes = new Set<string>();
    
    for (let i = 0; i < edges.length; i++) {
      const edge = edges[i];
      
      // UUID validation
      if (edge.uuid) {
        this.validateUuidFormat(graphFileId, 'graph', `edges[${i}].uuid`, edge.uuid, issues, undefined, edge.uuid);
        
        if (edgeUuids.has(edge.uuid)) {
          issues.push({
            fileId: graphFileId,
            type: 'graph',
            severity: 'error',
            category: 'duplicate',
            field: `edges[${i}].uuid`,
            message: `Duplicate edge UUID: ${edge.uuid.substring(0, 8)}...`,
            edgeUuid: edge.uuid
          });
        }
        edgeUuids.add(edge.uuid);
      }
      
      // Edge human ID validation (unique per graph)
      // Edge IDs should follow schema pattern: ^[a-zA-Z0-9_-]+$ (no spaces, no ">")
      if (edge.id) {
        if (edgeHumanIds.has(edge.id)) {
          issues.push({
            fileId: graphFileId,
            type: 'graph',
            severity: 'warning',
            category: 'duplicate',
            field: `edges[${i}].id`,
            message: `Duplicate edge id in graph: "${edge.id}"`,
            edgeUuid: edge.uuid
          });
        }
        edgeHumanIds.add(edge.id);
        
        // Check for invalid characters in edge ID (legacy "->" format)
        if (!SCHEMA_ID_PATTERN.test(edge.id)) {
          let suggestion = 'Use letters, numbers, hyphens, underscores only';
          if (edge.id.includes('->')) {
            suggestion = `Replace "->" with "-": "${edge.id.replace(/->/g, '-')}"`;
          } else if (edge.id.includes('>')) {
            suggestion = `Remove ">" from ID`;
          } else if (edge.id.includes(' ')) {
            suggestion = `Replace spaces with hyphens`;
          }
          issues.push({
            fileId: graphFileId,
            type: 'graph',
            severity: 'warning',
            category: 'id-format',
            field: `edges[${i}].id`,
            message: `Edge ID contains invalid characters: "${edge.id}"`,
            suggestion,
            edgeUuid: edge.uuid
          });
        }
      }
      
      // From/To validation
      // Note: edge.from/to should use UUIDs per GraphEdge type definition, but some legacy
      // graphs may use human-readable IDs. We validate both but warn about non-UUID usage.
      if (!edge.from) {
        issues.push({
          fileId: graphFileId,
          type: 'graph',
          severity: 'error',
          category: 'graph-structure',
          field: `edges[${i}].from`,
          message: 'Edge missing "from" node reference',
          edgeUuid: edge.uuid
        });
      } else {
        const fromIsUuid = nodeUuids.has(edge.from);
        const fromIsHumanId = nodeHumanIds.has(edge.from);
        
        if (!fromIsUuid && !fromIsHumanId) {
          issues.push({
            fileId: graphFileId,
            type: 'graph',
            severity: 'error',
            category: 'graph-structure',
            field: `edges[${i}].from`,
            message: `Edge references non-existent source node`,
            details: `Reference: ${edge.from.substring(0, 20)}...`,
            edgeUuid: edge.uuid
          });
        } else if (fromIsHumanId && !fromIsUuid) {
          // edge.from uses human-readable ID instead of UUID - this is bad practice
          issues.push({
            fileId: graphFileId,
            type: 'graph',
            severity: 'warning',
            category: 'graph-structure',
            field: `edges[${i}].from`,
            message: `Edge "from" uses human-readable ID "${edge.from}" instead of UUID`,
            suggestion: 'Edge from/to fields should use node UUIDs for consistency',
            edgeUuid: edge.uuid
          });
          // Find the node and add its UUID to connectedNodes
          const sourceNode = nodes.find(n => n.id === edge.from);
          if (sourceNode?.uuid) connectedNodes.add(sourceNode.uuid);
        } else {
          connectedNodes.add(edge.from);
        }
      }
      
      if (!edge.to) {
        issues.push({
          fileId: graphFileId,
          type: 'graph',
          severity: 'error',
          category: 'graph-structure',
          field: `edges[${i}].to`,
          message: 'Edge missing "to" node reference',
          edgeUuid: edge.uuid
        });
      } else {
        const toIsUuid = nodeUuids.has(edge.to);
        const toIsHumanId = nodeHumanIds.has(edge.to);
        
        if (!toIsUuid && !toIsHumanId) {
          issues.push({
            fileId: graphFileId,
            type: 'graph',
            severity: 'error',
            category: 'graph-structure',
            field: `edges[${i}].to`,
            message: `Edge references non-existent target node`,
            details: `Reference: ${edge.to.substring(0, 20)}...`,
            edgeUuid: edge.uuid
          });
        } else if (toIsHumanId && !toIsUuid) {
          // edge.to uses human-readable ID instead of UUID - this is bad practice
          issues.push({
            fileId: graphFileId,
            type: 'graph',
            severity: 'warning',
            category: 'graph-structure',
            field: `edges[${i}].to`,
            message: `Edge "to" uses human-readable ID "${edge.to}" instead of UUID`,
            suggestion: 'Edge from/to fields should use node UUIDs for consistency',
            edgeUuid: edge.uuid
          });
          // Find the node and add its UUID to connectedNodes
          const targetNode = nodes.find(n => n.id === edge.to);
          if (targetNode?.uuid) connectedNodes.add(targetNode.uuid);
        } else {
          connectedNodes.add(edge.to);
        }
      }
      
      // Self-loops
      if (edge.from && edge.to && edge.from === edge.to) {
        issues.push({
          fileId: graphFileId,
          type: 'graph',
          severity: 'info',
          category: 'graph-structure',
          field: `edges[${i}]`,
          message: 'Edge is a self-loop (connects node to itself)',
          edgeUuid: edge.uuid
        });
      }
      
      // Parameter references
      if (edge.p?.id) {
        referencedParams.add(edge.p.id);
        this.validateFileIdFormat(graphFileId, 'graph', `edges[${i}].p.id`, edge.p.id, issues, undefined, edge.uuid);
        if (!parameterFiles.has(edge.p.id)) {
          issues.push({
            fileId: graphFileId,
            type: 'graph',
            severity: 'warning',
            category: 'reference',
            field: `edges[${i}].p.id`,
            message: `Edge references non-existent parameter: ${edge.p.id}`,
            edgeUuid: edge.uuid
          });
        }
        
        // Validate connection
        if (edge.p.connection && connectionNames.size > 0) {
          if (!connectionNames.has(edge.p.connection)) {
            issues.push({
              fileId: graphFileId,
              type: 'graph',
              severity: 'warning',
              category: 'connection',
              field: `edges[${i}].p.connection`,
              message: `Unknown connection: ${edge.p.connection}`,
              edgeUuid: edge.uuid
            });
          }
        }
      }
      
      // Cost references
      if (edge.cost_gbp?.id) {
        referencedParams.add(edge.cost_gbp.id);
        if (!parameterFiles.has(edge.cost_gbp.id)) {
          issues.push({
            fileId: graphFileId,
            type: 'graph',
            severity: 'warning',
            category: 'reference',
            field: `edges[${i}].cost_gbp.id`,
            message: `Edge references non-existent cost parameter: ${edge.cost_gbp.id}`,
            edgeUuid: edge.uuid
          });
        }
      }
      
      if (edge.labour_cost?.id) {
        referencedParams.add(edge.labour_cost.id);
        if (!parameterFiles.has(edge.labour_cost.id)) {
          issues.push({
            fileId: graphFileId,
            type: 'graph',
            severity: 'warning',
            category: 'reference',
            field: `edges[${i}].labour_cost.id`,
            message: `Edge references non-existent time cost: ${edge.labour_cost.id}`,
            edgeUuid: edge.uuid
          });
        }
      }
      
      // Probability value validation (inline values)
      if (edge.p?.value !== undefined && typeof edge.p.value === 'number') {
        if (edge.p.value < 0 || edge.p.value > 1) {
          issues.push({
            fileId: graphFileId,
            type: 'graph',
            severity: 'error',
            category: 'value',
            field: `edges[${i}].p.value`,
            message: `Probability ${edge.p.value} out of range [0, 1]`,
            edgeUuid: edge.uuid
          });
        }
      }
      
      // Weight validation
      if (edge.weight_default !== undefined && typeof edge.weight_default === 'number') {
        if (edge.weight_default < 0) {
          issues.push({
            fileId: graphFileId,
            type: 'graph',
            severity: 'warning',
            category: 'value',
            field: `edges[${i}].weight_default`,
            message: `Negative edge weight: ${edge.weight_default}`,
            edgeUuid: edge.uuid
          });
        }
      }
      
      // Conditional probability validation
      if (edge.conditional_p && Array.isArray(edge.conditional_p)) {
        for (let j = 0; j < edge.conditional_p.length; j++) {
          const cp = edge.conditional_p[j];
          
          // Check value if present (legacy format)
          if (cp.value !== undefined && typeof cp.value === 'number') {
            if (cp.value < 0 || cp.value > 1) {
              issues.push({
                fileId: graphFileId,
                type: 'graph',
                severity: 'error',
                category: 'value',
                field: `edges[${i}].conditional_p[${j}].value`,
                message: `Conditional probability ${cp.value} out of range [0, 1]`,
                edgeUuid: edge.uuid
              });
            }
          }
          
          // Check p.mean if present (current format)
          if (cp.p?.mean !== undefined && typeof cp.p.mean === 'number') {
            if (cp.p.mean < 0 || cp.p.mean > 1) {
              issues.push({
                fileId: graphFileId,
                type: 'graph',
                severity: 'error',
                category: 'value',
                field: `edges[${i}].conditional_p[${j}].p.mean`,
                message: `Conditional probability ${cp.p.mean} out of range [0, 1]`,
                edgeUuid: edge.uuid
              });
            }
          }
          
          // Track parameter references in conditional_p.p.id
          if (cp.p?.id) {
            referencedParams.add(cp.p.id);
            this.validateFileIdFormat(graphFileId, 'graph', `edges[${i}].conditional_p[${j}].p.id`, cp.p.id, issues, undefined, edge.uuid);
            if (!parameterFiles.has(cp.p.id)) {
              issues.push({
                fileId: graphFileId,
                type: 'graph',
                severity: 'warning',
                category: 'reference',
                field: `edges[${i}].conditional_p[${j}].p.id`,
                message: `Conditional probability references non-existent parameter: ${cp.p.id}`,
                edgeUuid: edge.uuid
              });
            }
          }
        }
      }
    }
    
    // ─────────────────────────────────────────────────────────────────────────
    // Sibling Edge Probability Constraints (LAG)
    // For nodes with multiple outgoing edges where both have latency tracking,
    // check if Σ p.mean > 1 (forecasting artefact) or Σ p.evidence > 1 (error)
    // ─────────────────────────────────────────────────────────────────────────
    
    // Group edges by source node
    const edgesBySource = new Map<string, any[]>();
    for (const edge of edges) {
      const sourceKey = edge.from || edge.source;
      if (sourceKey) {
        if (!edgesBySource.has(sourceKey)) {
          edgesBySource.set(sourceKey, []);
        }
        edgesBySource.get(sourceKey)!.push(edge);
      }
    }
    
    // Check each node's outgoing edges
    for (const [sourceKey, outgoingEdges] of edgesBySource) {
      // Only check if there are multiple outgoing edges
      if (outgoingEdges.length < 2) continue;
      
      // Only check edges with latency tracking enabled (maturity_days > 0)
      const latencyEdges = outgoingEdges.filter((e: any) => 
        e.p?.latency?.maturity_days && e.p.latency.maturity_days > 0
      );
      
      // Need at least 2 sibling latency edges for this check to be relevant
      if (latencyEdges.length < 2) continue;
      
      // Sum p.mean and p.evidence across sibling latency edges
      let sumMean = 0;
      let sumEvidence = 0;
      let hasEvidence = false;
      
      for (const edge of latencyEdges) {
        const mean = edge.p?.mean ?? 0;
        const evidence = edge.p?.evidence?.p ?? edge.p?.evidence?.mean ?? 0;
        
        sumMean += mean;
        if (edge.p?.evidence !== undefined) {
          sumEvidence += evidence;
          hasEvidence = true;
        }
      }
      
      // Find the source node for clearer error messages
      const sourceNode = nodes.find((n: any) => n.id === sourceKey || n.uuid === sourceKey);
      const sourceName = sourceNode?.id || sourceKey;
      
      // Check for errors and warnings
      if (hasEvidence && sumEvidence > 1.0) {
        // Σ p.evidence > 1.0: Error - data inconsistency
        issues.push({
          fileId: graphFileId,
          type: 'graph',
          severity: 'error',
          category: 'value',
          field: `node: ${sourceName}`,
          message: `Sibling edges from "${sourceName}" have Σ p.evidence = ${(sumEvidence * 100).toFixed(1)}% > 100% — data inconsistency`,
          suggestion: 'Check if n/k counts are correct; evidence probabilities should never sum > 100%',
          nodeUuid: sourceNode?.uuid
        });
      } else if (sumMean > 1.0) {
        // Σ p.mean > 1.0 AND Σ p.evidence ≤ 1.0: Info - forecasting artefact
        issues.push({
          fileId: graphFileId,
          type: 'graph',
          severity: 'info',
          category: 'value',
          field: `node: ${sourceName}`,
          message: `Sibling edges from "${sourceName}" have Σ p.mean = ${(sumMean * 100).toFixed(1)}% > 100% — forecasting artefact for immature data`,
          suggestion: 'This is expected when cohorts are immature. For accurate flow calculations, use p.evidence instead of p.mean.',
          nodeUuid: sourceNode?.uuid
        });
      }
    }
    
    // ─────────────────────────────────────────────────────────────────────────
    // Orphan Node Detection (within graph)
    // ─────────────────────────────────────────────────────────────────────────
    
    for (const node of nodes) {
      if (node.uuid && !connectedNodes.has(node.uuid)) {
        const isEntryExit = node.type === 'entry' || node.type === 'exit' || 
                            node.entry?.is_start || node.absorbing;
        
        if (!isEntryExit) {
          issues.push({
            fileId: graphFileId,
            type: 'graph',
            severity: 'info',
            category: 'graph-structure',
            field: `node: ${node.id || node.uuid?.substring(0, 8)}`,
            message: `Node "${node.id || 'unnamed'}" is disconnected (no edges)`
          });
        }
      }
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // REGISTRY/INDEX FILE VALIDATION + CONTENT SYNC
  // ═══════════════════════════════════════════════════════════════════════════
  
  private static validateRegistryFiles(
    indexFiles: Map<string, any>,
    parameterFiles: Map<string, any>,
    caseFiles: Map<string, any>,
    contextFiles: Map<string, any>,
    nodeFiles: Map<string, any>,
    eventFiles: Map<string, any>,
    issues: IntegrityIssue[]
  ): void {
    const typeToMap: Record<string, [Map<string, any>, string]> = {
      parameter: [parameterFiles, 'parameters'],
      case: [caseFiles, 'cases'],
      context: [contextFiles, 'contexts'],
      node: [nodeFiles, 'nodes'],
      event: [eventFiles, 'events']
    };
    
    for (const [type, [filesMap, pluralKey]] of Object.entries(typeToMap)) {
      const indexFile = indexFiles.get(type);
      
      if (!indexFile) {
        if (filesMap.size > 0) {
          issues.push({
            fileId: `${type}-index`,
            type: 'system' as any,
            severity: 'warning',
            category: 'registry',
            message: `Missing ${pluralKey}-index.yaml but ${filesMap.size} ${type} file(s) exist`,
            suggestion: 'Run "Rebuild Indexes" from File menu'
          });
        }
        continue;
      }
      
      const indexData = indexFile.data;
      if (!indexData) {
        issues.push({
          fileId: indexFile.fileId,
          type: 'system' as any,
          severity: 'error',
          category: 'registry',
          message: `${pluralKey}-index.yaml has null/empty data`,
          suggestion: 'Run "Rebuild Indexes" to regenerate'
        });
        continue;
      }
      
      // Check index file path
      if (indexFile.source?.path && !indexFile.source.path.endsWith(`${pluralKey}-index.yaml`)) {
        issues.push({
          fileId: indexFile.fileId,
          type: 'system' as any,
          severity: 'warning',
          category: 'registry',
          field: 'path',
          message: `Index file at wrong path: ${indexFile.source.path}`,
          suggestion: `Should be at root: ${pluralKey}-index.yaml`
        });
      }
      
      // Get entries from index
      const entries = indexData[pluralKey] || [];
      const indexedIds = new Map<string, any>(); // id -> entry
      
      // Check for orphan index entries (pointing to non-existent files)
      for (const entry of entries) {
        if (!entry.id) {
          issues.push({
            fileId: indexFile.fileId,
            type: 'system' as any,
            severity: 'warning',
            category: 'registry',
            message: 'Index entry missing id field'
          });
          continue;
        }
        
        indexedIds.set(entry.id, entry);
        
        if (!filesMap.has(entry.id)) {
          issues.push({
            fileId: indexFile.fileId,
            type: 'system' as any,
            severity: 'warning',
            category: 'registry',
            field: entry.id,
            message: `Index entry references non-existent file: ${type}-${entry.id}`,
            suggestion: 'Remove stale entry or create the file'
          });
        }
      }
      
      // Check for files missing from index AND sync validation
      for (const [id, file] of filesMap) {
        const indexEntry = indexedIds.get(id);
        
        if (!indexEntry) {
          issues.push({
            fileId: `${type}-${id}`,
            type: type as ObjectType,
            severity: 'warning',
            category: 'registry',
            message: `File not listed in ${pluralKey}-index.yaml`,
            suggestion: 'Run "Rebuild Indexes" to add'
          });
        } else {
          // SYNC VALIDATION: Check registry entry matches file content
          const fileData = file.data;
          
          // Check name sync
          if (indexEntry.name && fileData.name && indexEntry.name !== fileData.name) {
            issues.push({
              fileId: `${type}-${id}`,
              type: type as ObjectType,
              severity: 'info',
              category: 'sync',
              field: 'name',
              message: `Registry name "${indexEntry.name}" ≠ file name "${fileData.name}"`
            });
          }
          
          // Check description sync (if both exist)
          if (indexEntry.description && fileData.description && 
              indexEntry.description !== fileData.description) {
            issues.push({
              fileId: `${type}-${id}`,
              type: type as ObjectType,
              severity: 'info',
              category: 'sync',
              field: 'description',
              message: 'Registry description differs from file description'
            });
          }
          
          // Type-specific sync checks
          if (type === 'event') {
            const indexCategory = indexEntry.category;
            const fileCategory = fileData.event_type || fileData.category;
            if (indexCategory && fileCategory && indexCategory !== fileCategory) {
              issues.push({
                fileId: `${type}-${id}`,
                type: type as ObjectType,
                severity: 'warning',
                category: 'sync',
                field: 'category',
                message: `Registry category "${indexCategory}" ≠ file category "${fileCategory}"`
              });
            }
          }
          
          if (type === 'node') {
            if (indexEntry.event_id && fileData.event_id && 
                indexEntry.event_id !== fileData.event_id) {
              issues.push({
                fileId: `${type}-${id}`,
                type: type as ObjectType,
                severity: 'warning',
                category: 'sync',
                field: 'event_id',
                message: `Registry event_id "${indexEntry.event_id}" ≠ file event_id "${fileData.event_id}"`
              });
            }
          }
        }
      }
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // ORPHAN DETECTION (Files never referenced by any graph)
  // ═══════════════════════════════════════════════════════════════════════════
  
  private static detectOrphans(
    parameterFiles: Map<string, any>,
    caseFiles: Map<string, any>,
    contextFiles: Map<string, any>,
    nodeFiles: Map<string, any>,
    eventFiles: Map<string, any>,
    referencedParams: Set<string>,
    referencedCases: Set<string>,
    referencedContexts: Set<string>,
    referencedNodes: Set<string>,
    referencedEvents: Set<string>,
    issues: IntegrityIssue[]
  ): void {
    for (const [id] of parameterFiles) {
      if (!referencedParams.has(id)) {
        issues.push({
          fileId: `parameter-${id}`,
          type: 'parameter',
          severity: 'info',
          category: 'orphan',
          message: `Not referenced by any graph`
        });
      }
    }
    
    for (const [id] of caseFiles) {
      if (!referencedCases.has(id)) {
        issues.push({
          fileId: `case-${id}`,
          type: 'case',
          severity: 'info',
          category: 'orphan',
          message: `Not referenced by any graph`
        });
      }
    }
    
    for (const [id] of eventFiles) {
      if (!referencedEvents.has(id)) {
        issues.push({
          fileId: `event-${id}`,
          type: 'event',
          severity: 'info',
          category: 'orphan',
          message: `Not referenced by any graph or node`
        });
      }
    }
    
    for (const [id] of contextFiles) {
      if (!referencedContexts.has(id)) {
        issues.push({
          fileId: `context-${id}`,
          type: 'context',
          severity: 'info',
          category: 'orphan',
          message: `Not referenced by any graph`
        });
      }
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // DUPLICATE DETECTION
  // ═══════════════════════════════════════════════════════════════════════════
  
  private static detectDuplicates(allFiles: any[], issues: IntegrityIssue[]): void {
    // Group files by type, then by canonical fileId to dedupe workspace-prefixed variants
    const canonicalByType = new Map<string, Map<string, any>>();
    
    for (const file of allFiles) {
      if (file.source?.repository === 'temporary') continue;
      if (['credentials', 'connections', 'settings', 'markdown', 'about'].includes(file.type)) continue;
      if (file.fileId.endsWith('-index')) continue;
      
      const data = file.data;
      if (!data?.id) continue;
      
      const typeKey = file.type;
      const canonicalId = this.getCanonicalFileId(file.fileId, typeKey);
      
      if (!canonicalByType.has(typeKey)) {
        canonicalByType.set(typeKey, new Map());
      }
      
      // Store by canonical ID - prefer the first one seen (skip if already present)
      const typeMap = canonicalByType.get(typeKey)!;
      if (!typeMap.has(canonicalId)) {
        typeMap.set(canonicalId, file);
      }
    }
    
    // Now check for duplicates by data.id (the ID inside the file)
    const idsByType = new Map<string, Map<string, any[]>>();
    
    for (const [typeKey, canonicalMap] of canonicalByType) {
      for (const [_canonicalId, file] of canonicalMap) {
        const data = file.data;
        if (!data?.id) continue;
        
        if (!idsByType.has(typeKey)) {
          idsByType.set(typeKey, new Map());
        }
        
        const typeMap = idsByType.get(typeKey)!;
        if (!typeMap.has(data.id)) {
          typeMap.set(data.id, []);
        }
        typeMap.get(data.id)!.push(file);
      }
    }
    
    for (const [type, idsMap] of idsByType) {
      for (const [id, files] of idsMap) {
        if (files.length > 1) {
          // Use display names for the details, not raw fileIds
          const displayNames = files.map(f => this.getDisplayName(f.fileId, type)).join(', ');
          issues.push({
            fileId: files[0].fileId,
            type: type as ObjectType,
            severity: 'error',
            category: 'duplicate',
            field: 'id',
            message: `Duplicate ${type} ID "${id}"`,
            details: `Found in files: ${displayNames}`
          });
        }
      }
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // CROSS-GRAPH CONSISTENCY
  // ═══════════════════════════════════════════════════════════════════════════
  
  private static checkCrossGraphConsistency(graphFiles: any[], issues: IntegrityIssue[]): void {
    const paramUsage = new Map<string, Set<string>>();
    
    for (const graph of graphFiles) {
      const edges = graph.data?.edges || [];
      
      for (const edge of edges) {
        if (edge.p?.id) {
          if (!paramUsage.has(edge.p.id)) {
            paramUsage.set(edge.p.id, new Set());
          }
          paramUsage.get(edge.p.id)!.add(graph.fileId);
        }
      }
    }
    
    for (const [paramId, graphs] of paramUsage) {
      if (graphs.size > 1) {
        issues.push({
          fileId: `parameter-${paramId}`,
          type: 'parameter',
          severity: 'info',
          category: 'reference',
          message: `Shared across ${graphs.size} graphs`,
          details: Array.from(graphs).join(', ')
        });
      }
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // CREDENTIALS VALIDATION
  // ═══════════════════════════════════════════════════════════════════════════
  
  private static async validateCredentials(
    connectionDefs: Map<string, any>,
    issues: IntegrityIssue[]
  ): Promise<void> {
    // Load credentials
    const credResult = await credentialsManager.loadCredentials();
    
    if (!credResult.success || !credResult.credentials) {
      issues.push({
        fileId: 'credentials',
        type: 'system' as any,
        severity: 'warning',
        category: 'credentials',
        message: 'Unable to load credentials for validation',
        suggestion: 'Check credentials configuration in Settings'
      });
      return;
    }
    
    const providers = credResult.credentials.providers || {};
    const availableProviders = Object.keys(providers);
    
    // Check each connection's credential requirements
    for (const [connName, conn] of connectionDefs) {
      // Skip disabled connections
      if (conn.enabled === false) {
        continue;
      }
      
      // Check if connection has a credsRef
      if (conn.credsRef) {
        const hasCredential = providers[conn.credsRef] !== undefined;
        
        if (!hasCredential) {
          issues.push({
            fileId: 'connections',
            type: 'connections' as any,
            severity: 'error',
            category: 'credentials',
            field: `${connName}.credsRef`,
            message: `Connection "${connName}" references missing credentials: "${conn.credsRef}"`,
            suggestion: availableProviders.length > 0 
              ? `Available providers: ${availableProviders.join(', ')}`
              : 'Add provider credentials in Settings'
          });
        } else {
          // Check if credential has required fields based on auth_type
          const creds = providers[conn.credsRef];
          
          if (conn.auth_type === 'google-service-account') {
            if (!creds.service_account_json_b64 && !creds.service_account_json) {
              issues.push({
                fileId: 'connections',
                type: 'connections' as any,
                severity: 'warning',
                category: 'credentials',
                field: `${connName}.credsRef`,
                message: `Connection "${connName}" uses Google service account but credentials missing service_account_json`,
                suggestion: 'Add service_account_json or service_account_json_b64 to credentials'
              });
            }
          }
          
          if (conn.auth_type === 'api-key') {
            if (!creds.api_key) {
              issues.push({
                fileId: 'connections',
                type: 'connections' as any,
                severity: 'warning',
                category: 'credentials',
                field: `${connName}.credsRef`,
                message: `Connection "${connName}" uses API key auth but credentials missing api_key`,
                suggestion: 'Add api_key to credentials'
              });
            }
          }
          
          // Check for Amplitude-specific requirements
          if (conn.provider === 'amplitude' || conn.credsRef === 'amplitude') {
            if (!creds.api_key || !creds.secret_key) {
              issues.push({
                fileId: 'connections',
                type: 'connections' as any,
                severity: 'warning',
                category: 'credentials',
                field: `${connName}.credsRef`,
                message: `Amplitude connection "${connName}" missing api_key or secret_key`,
                suggestion: 'Add api_key and secret_key for Amplitude'
              });
            }
          }
        }
      } else if (conn.auth_type && conn.auth_type !== 'none') {
        // Connection requires auth but has no credsRef
        issues.push({
          fileId: 'connections',
          type: 'connections' as any,
          severity: 'warning',
          category: 'credentials',
          field: `${connName}`,
          message: `Connection "${connName}" has auth_type "${conn.auth_type}" but no credsRef`,
          suggestion: 'Add credsRef to specify which credentials to use'
        });
      }
      
      // Validate connection has required adapter fields
      if (!conn.adapter) {
        issues.push({
          fileId: 'connections',
          type: 'connections' as any,
          severity: 'warning',
          category: 'connection',
          field: `${connName}.adapter`,
          message: `Connection "${connName}" missing adapter configuration`
        });
      } else if (!conn.adapter.url && !conn.adapter.project_id) {
        issues.push({
          fileId: 'connections',
          type: 'connections' as any,
          severity: 'info',
          category: 'connection',
          field: `${connName}.adapter`,
          message: `Connection "${connName}" adapter may be missing URL or project_id`
        });
      }
    }
    
    // Check for orphan credentials (not used by any connection)
    const usedCredsRefs = new Set<string>();
    for (const [_, conn] of connectionDefs) {
      if (conn.credsRef) {
        usedCredsRefs.add(conn.credsRef);
      }
    }
    
    for (const providerKey of availableProviders) {
      if (!usedCredsRefs.has(providerKey)) {
        issues.push({
          fileId: 'credentials',
          type: 'system' as any,
          severity: 'info',
          category: 'orphan',
          field: providerKey,
          message: `Credential provider "${providerKey}" is not used by any connection`
        });
      }
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // IMAGE VALIDATION
  // ═══════════════════════════════════════════════════════════════════════════
  
  /**
   * Validate images referenced by nodes and detect orphan images
   */
  private static async validateImages(
    graphFiles: any[],
    allFiles: any[],
    issues: IntegrityIssue[]
  ): Promise<void> {
    // Collect all image references from all graphs
    const referencedImages = new Map<string, { graphId: string; nodeId: string }[]>();
    
    for (const graphFile of graphFiles) {
      const graph = graphFile.data;
      const graphFileId = graphFile.fileId;
      
      if (!graph?.nodes) continue;
      
      for (const node of graph.nodes) {
        if (!node.images || !Array.isArray(node.images)) continue;
        
        for (const img of node.images) {
          if (!img.image_id) continue;
          
          // Build expected image file path
          const imageId = img.image_id;
          const ext = img.file_extension || 'png';
          
          // Track which nodes reference this image
          if (!referencedImages.has(imageId)) {
            referencedImages.set(imageId, []);
          }
          referencedImages.get(imageId)!.push({
            graphId: graphFileId,
            nodeId: node.id || node.uuid
          });
        }
      }
    }
    
    // Find all image files in the workspace
    // Note: Binary image files are NOT loaded into the file registry (only their paths are tracked)
    // So we can only do limited validation here
    const imageFiles = allFiles.filter(f => 
      f.type === 'image' || 
      f.path?.startsWith('images/') ||
      f.path?.match(/\.(png|jpg|jpeg|gif|webp)$/i)
    );
    
    const actualImageIds = new Set<string>();
    for (const imgFile of imageFiles) {
      // Extract image ID from path or fileId
      // Path format: images/{id}.{ext}
      const path = imgFile.path || imgFile.fileId;
      const match = path.match(/images\/([^.]+)\./);
      if (match) {
        actualImageIds.add(match[1]);
      } else {
        // Fallback: use fileId without 'image-' prefix
        const id = imgFile.fileId?.replace(/^image-/, '');
        if (id) actualImageIds.add(id);
      }
    }
    
    // Only report missing images if we have SOME images loaded (otherwise skip check)
    // This avoids false positives when images aren't in the workspace cache
    const hasAnyImages = actualImageIds.size > 0;
    
    if (hasAnyImages) {
      // Check referenced images exist
      for (const [imageId, refs] of referencedImages) {
        if (!actualImageIds.has(imageId)) {
          // Image is referenced but doesn't exist in loaded workspace
          const refLocations = refs.map(r => `${r.graphId}/${r.nodeId}`).slice(0, 3);
          const moreCount = refs.length > 3 ? ` and ${refs.length - 3} more` : '';
          
          issues.push({
            fileId: refs[0].graphId,
            type: 'graph',
            severity: 'warning', // Warning not error - image might exist in git but not loaded
            category: 'image',
            field: `node.images`,
            message: `Image "${imageId}" referenced but not found in workspace cache`,
            suggestion: 'Image may exist in git but not be loaded locally. Check images/ folder.',
            details: `Referenced by: ${refLocations.join(', ')}${moreCount}`
          });
        }
      }
      
      // Check for orphan images (exist but not referenced)
      for (const imageId of actualImageIds) {
        if (!referencedImages.has(imageId)) {
          issues.push({
            fileId: `image-${imageId}`,
            type: 'system' as any,
            severity: 'info',
            category: 'image',
            field: 'images',
            message: `Image "${imageId}" in workspace but not referenced by any node`,
            suggestion: 'Remove if unused, or attach to a node'
          });
        }
      }
    } else if (referencedImages.size > 0) {
      // We have image references but no images loaded - just note this
      issues.push({
        fileId: 'system',
        type: 'system' as any,
        severity: 'info',
        category: 'image',
        field: 'images',
        message: `${referencedImages.size} image(s) referenced by nodes but image files not loaded in workspace`,
        suggestion: 'Image validation skipped - images exist in git but binary files not cached locally'
      });
    }
    
    // Validate image_id format in nodes
    for (const graphFile of graphFiles) {
      const graph = graphFile.data;
      const graphFileId = graphFile.fileId;
      
      if (!graph?.nodes) continue;
      
      for (let i = 0; i < graph.nodes.length; i++) {
        const node = graph.nodes[i];
        if (!node.images || !Array.isArray(node.images)) continue;
        
        for (let j = 0; j < node.images.length; j++) {
          const img = node.images[j];
          
          // Check image_id format
          if (img.image_id && !SCHEMA_ID_PATTERN.test(img.image_id)) {
            issues.push({
              fileId: graphFileId,
              type: 'graph',
              severity: 'warning',
              category: 'image',
              field: `nodes[${i}].images[${j}].image_id`,
              message: `Image ID "${img.image_id}" contains invalid characters`,
              suggestion: 'Use only letters, numbers, hyphens, underscores'
            });
          }
          
          // Check for missing required fields
          if (!img.caption && img.caption !== '') {
            issues.push({
              fileId: graphFileId,
              type: 'graph',
              severity: 'info',
              category: 'image',
              field: `nodes[${i}].images[${j}].caption`,
              message: `Image "${img.image_id}" is missing a caption`,
              suggestion: 'Add a descriptive caption for accessibility'
            });
          }
        }
      }
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════════════════════════════════════
  
  private static isValidISODate(str: string): boolean {
    const d = new Date(str);
    return d instanceof Date && !isNaN(d.getTime());
  }
  
  /**
   * Convert file ID references in text to clickable links
   * Patterns: "parameter-xxx", "case-xxx", "event-xxx", "node-xxx", "context-xxx", "graph-xxx"
   */
  private static linkifyFileReferences(text: string): string {
    // Match file ID patterns like "parameter-my-param" or "case-test-case"
    const fileIdPattern = /\b(parameter|case|event|node|context|graph)-([a-zA-Z0-9_-]+)\b/g;
    
    return text.replace(fileIdPattern, (match, type, name) => {
      // Don't linkify if already inside a markdown link
      // Use hash URL to avoid browser stripping unknown protocols
      return `[${match}](#dagnet-file/${match})`;
    });
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // LOG GENERATION - GROUPED BY FILE
  // ═══════════════════════════════════════════════════════════════════════════
  
  private static generateLogContent(
    totalFiles: number,
    issues: IntegrityIssue[],
    summary: { errors: number; warnings: number; info: number; byCategory: Record<IssueCategory, number> },
    stats: Record<string, number>,
    startTime: Date
  ): string {
    const lines: string[] = [];
    const endTime = new Date();
    const duration = (endTime.getTime() - startTime.getTime()) / 1000;
    
    // ─────────────────────────────────────────────────────────────────────────
    // Header
    // ─────────────────────────────────────────────────────────────────────────
    
    lines.push('# Integrity Check Report');
    lines.push('');
    lines.push(`**Started:** ${startTime.toISOString()}`);
    lines.push(`**Duration:** ${duration.toFixed(2)}s`);
    lines.push('');
    
    // ─────────────────────────────────────────────────────────────────────────
    // File Statistics
    // ─────────────────────────────────────────────────────────────────────────
    
    lines.push('## Files Checked');
    lines.push('');
    lines.push('| Type | Count |');
    lines.push('|------|-------|');
    lines.push(`| 📊 Graphs | ${stats.graphs} |`);
    lines.push(`| 📐 Parameters | ${stats.parameters} |`);
    lines.push(`| 📁 Cases | ${stats.cases} |`);
    lines.push(`| 🔘 Nodes | ${stats.nodes} |`);
    lines.push(`| ⚡ Events | ${stats.events} |`);
    lines.push(`| 🌐 Contexts | ${stats.contexts} |`);
    lines.push(`| 🔗 Connections | ${stats.connections} |`);
    lines.push(`| **Total** | **${totalFiles}** |`);
    lines.push('');
    
    // ─────────────────────────────────────────────────────────────────────────
    // Summary
    // ─────────────────────────────────────────────────────────────────────────
    
    lines.push('## Summary');
    lines.push('');
    
    if (summary.errors === 0 && summary.warnings === 0 && summary.info === 0) {
      lines.push('✅ **All checks passed!** No issues found.');
      lines.push('');
      lines.push('- All referential integrity verified');
      lines.push('- All IDs valid and unique');
      lines.push('- All registry/index files consistent');
      lines.push('- All values within valid ranges');
    } else {
      lines.push(`| Severity | Count |`);
      lines.push(`|----------|-------|`);
      lines.push(`| ❌ Errors | ${summary.errors} |`);
      lines.push(`| ⚠️ Warnings | ${summary.warnings} |`);
      lines.push(`| ℹ️ Info | ${summary.info} |`);
      lines.push('');
      
      // Category breakdown
      const activeCategories = Object.entries(summary.byCategory)
        .filter(([_, count]) => count > 0)
        .sort((a, b) => b[1] - a[1]);
      
      if (activeCategories.length > 0) {
        lines.push('### Issues by Category');
        lines.push('');
        for (const [cat, count] of activeCategories) {
          lines.push(`- ${this.getCategoryIcon(cat as IssueCategory)} **${cat}**: ${count}`);
        }
        lines.push('');
      }
    }
    
    // ─────────────────────────────────────────────────────────────────────────
    // Issues Grouped by File
    // ─────────────────────────────────────────────────────────────────────────
    
    if (issues.length > 0) {
      lines.push('---');
      lines.push('');
      lines.push('## Issues by File');
      lines.push('');
      
      // Group issues by fileId
      const issuesByFile = new Map<string, IntegrityIssue[]>();
      for (const issue of issues) {
        if (!issuesByFile.has(issue.fileId)) {
          issuesByFile.set(issue.fileId, []);
        }
        issuesByFile.get(issue.fileId)!.push(issue);
      }
      
      // Sort files: errors first, then warnings, then info
      const sortedFiles = Array.from(issuesByFile.entries()).sort((a, b) => {
        const aErrors = a[1].filter(i => i.severity === 'error').length;
        const bErrors = b[1].filter(i => i.severity === 'error').length;
        if (aErrors !== bErrors) return bErrors - aErrors;
        
        const aWarnings = a[1].filter(i => i.severity === 'warning').length;
        const bWarnings = b[1].filter(i => i.severity === 'warning').length;
        return bWarnings - aWarnings;
      });
      
      for (const [fileId, fileIssues] of sortedFiles) {
        const errorCount = fileIssues.filter(i => i.severity === 'error').length;
        const warnCount = fileIssues.filter(i => i.severity === 'warning').length;
        const infoCount = fileIssues.filter(i => i.severity === 'info').length;
        
        // File header with counts
        const counts: string[] = [];
        if (errorCount > 0) counts.push(`${errorCount} error${errorCount > 1 ? 's' : ''}`);
        if (warnCount > 0) counts.push(`${warnCount} warning${warnCount > 1 ? 's' : ''}`);
        if (infoCount > 0) counts.push(`${infoCount} info`);
        
        const type = fileIssues[0].type;
        const icon = this.getTypeIcon(type);
        
        // Strip workspace prefix for cleaner display (e.g., "dagnet-main-graph-sample" → "graph-sample")
        const displayFileId = typeof type === 'string' && type !== 'system'
          ? this.getCanonicalFileId(fileId, type)
          : fileId;
        
        // Create internal link for navigable files
        // Use hash URL to avoid browser stripping unknown protocols
        const isNavigable = ['graph', 'parameter', 'case', 'node', 'event', 'context'].includes(type as string);
        const fileLink = isNavigable 
          ? `[${displayFileId}](#dagnet-file/${fileId})`  // Display clean name, but link with full fileId
          : `\`${displayFileId}\``;
        
        lines.push(`### ${icon} ${fileLink}`);
        lines.push('');
        lines.push(`*${counts.join(', ')}*`);
        lines.push('');
        
        // Sort issues by severity
        const sortedIssues = [...fileIssues].sort((a, b) => {
          const order = { error: 0, warning: 1, info: 2 };
          return order[a.severity] - order[b.severity];
        });
        
        for (const issue of sortedIssues) {
          const icon = this.getSeverityIcon(issue.severity);
          
          // Convert file ID references in messages to links
          const messageWithLinks = this.linkifyFileReferences(issue.message);
          
          lines.push(`- ${icon} **[${issue.category}]** ${messageWithLinks}`);
          if (issue.field) {
            lines.push(`  - Field: \`${issue.field}\``);
          }
          if (issue.details) {
            const detailsWithLinks = this.linkifyFileReferences(issue.details);
            lines.push(`  - Details: ${detailsWithLinks}`);
          }
          if (issue.suggestion) {
            lines.push(`  - 💡 ${issue.suggestion}`);
          }
        }
        lines.push('');
      }
    }
    
    // ─────────────────────────────────────────────────────────────────────────
    // Footer
    // ─────────────────────────────────────────────────────────────────────────
    
    lines.push('---');
    lines.push('');
    lines.push(`*Report generated: ${endTime.toISOString()}*`);
    
    return lines.join('\n');
  }
  
  private static getSeverityIcon(severity: IssueSeverity): string {
    return { error: '❌', warning: '⚠️', info: 'ℹ️' }[severity];
  }
  
  private static getTypeIcon(type: ObjectType | 'system'): string {
    const icons: Record<string, string> = {
      'graph': '📊',
      'parameter': '📐',
      'case': '📁',
      'node': '🔘',
      'event': '⚡',
      'context': '🌐',
      'connections': '🔗',
      'system': '⚙️'
    };
    return icons[type] || '📄';
  }
  
  private static getCategoryIcon(category: IssueCategory): string {
    const icons: Record<IssueCategory, string> = {
      'schema': '📋',
      'id-format': '🔤',
      'reference': '🔗',
      'graph-structure': '🕸️',
      'registry': '📇',
      'connection': '🔌',
      'credentials': '🔐',
      'value': '🔢',
      'orphan': '👻',
      'duplicate': '♊',
      'naming': '🏷️',
      'metadata': '📎',
      'sync': '🔄',
      'image': '🖼️'
    };
    return icons[category] || '•';
  }
}
