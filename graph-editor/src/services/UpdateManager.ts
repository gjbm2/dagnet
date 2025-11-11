/**
 * UpdateManager: Centralized service for all automated entity updates
 * 
 * Architecture:
 * - Level 1: 5 direction handlers (where data flows)
 * - Level 2: 4 operation types (what kind of change)
 * - Level 3: 18 mapping configurations (specific field mappings)
 * 
 * Responsibilities:
 * - Handle all data flow between graph, files, and external sources
 * - Respect override flags (don't update overridden fields)
 * - Resolve conflicts (interactive and non-interactive modes)
 * - Maintain audit trail of all updates
 * - Log events for debugging (TODO: Implement browser-compatible event system)
 * 
 * Phase: 0.3 - UpdateManager Implementation
 * Status: In Progress
 * 
 * Related Docs:
 * - PROJECT_CONNECT/CURRENT/OVERRIDE_PATTERN_DESIGN.md
 * - PROJECT_CONNECT/CURRENT/MAPPING_TYPES.md
 * - PROJECT_CONNECT/CURRENT/SCHEMA_FIELD_MAPPINGS.md
 */

// Note: Removed EventEmitter (Node.js only) - browser doesn't support it
// TODO: Implement browser-compatible event system if needed (e.g., CustomEvent)

// ============================================================
// TYPES & INTERFACES
// ============================================================

export type Direction =
  | 'graph_internal'      // Graph → Graph (MSMDC, cascades)
  | 'graph_to_file'       // Graph → File (save, export)
  | 'file_to_graph'       // File → Graph (pull, sync)
  | 'external_to_graph'   // External → Graph (direct update)
  | 'external_to_file';   // External → File (append history)

export type Operation = 'CREATE' | 'UPDATE' | 'APPEND' | 'DELETE';

export type SubDestination = 'parameter' | 'case' | 'node' | 'context' | 'event';

export type ConflictStrategy = 'skip' | 'overwrite' | 'error' | 'prompt';

export interface UpdateOptions {
  /** Interactive mode (shows modals for conflicts) vs batch mode */
  interactive?: boolean;
  
  /** How to handle conflicts in non-interactive mode */
  conflictStrategy?: ConflictStrategy;
  
  /** Validate only, don't actually apply changes */
  validateOnly?: boolean;
  
  /** Stop on first error or continue */
  stopOnError?: boolean;
  
  /** User context for audit trail */
  userId?: string;
  
  /** Additional metadata */
  metadata?: Record<string, any>;
}

export interface UpdateResult {
  success: boolean;
  changes?: FieldChange[];
  conflicts?: Conflict[];
  errors?: UpdateError[];
  warnings?: Warning[];
  metadata?: {
    affectedEntities?: string[];
    timestamp?: string;
    duration?: number;
  };
}

export interface FieldChange {
  field: string;
  oldValue: any;
  newValue: any;
  source: 'auto' | 'manual' | 'external';
  overridden?: boolean;
}

export interface Conflict {
  field: string;
  currentValue: any;
  newValue: any;
  lastModified?: string;
  reason: 'overridden' | 'modified_since_sync' | 'type_mismatch';
}

export interface UpdateError {
  code: string;
  message: string;
  field?: string;
  severity: 'error' | 'warning';
}

export interface Warning {
  code: string;
  message: string;
  field?: string;
}

export interface FieldMapping {
  sourceField: string;
  targetField: string;
  transform?: (value: any, source: any, target: any) => any;
  condition?: (source: any, target: any) => boolean;
  overrideFlag?: string;  // e.g., 'label_overridden'
}

export interface MappingConfiguration {
  direction: Direction;
  operation: Operation;
  subDestination?: SubDestination;
  mappings: FieldMapping[];
}

// ============================================================
// UPDATEMANAGER CLASS
// ============================================================

export class UpdateManager {
  private mappingConfigurations: Map<string, MappingConfiguration>;
  private auditLog: any[];
  
  constructor() {
    this.mappingConfigurations = new Map();
    this.auditLog = [];
    this.initializeMappings();
  }
  
  // ============================================================
  // LEVEL 1: DIRECTION HANDLERS (5 methods)
  // ============================================================
  
  /**
   * Flow A: Graph → Graph updates
   * Examples: MSMDC query regeneration, label cascades, copy/paste
   */
  async handleGraphInternal(
    source: any,
    target: any,
    operation: 'UPDATE',
    options: UpdateOptions = {}
  ): Promise<UpdateResult> {
    console.log('[UpdateManager] update:start', { direction: 'graph_internal', operation });
    
    try {
      const key = this.getMappingKey('graph_internal', operation);
      const config = this.mappingConfigurations.get(key);
      
      if (!config) {
        throw new Error(`No mapping configuration for ${key}`);
      }
      
      const result = await this.applyMappings(source, target, config.mappings, options);
      
      console.log('[UpdateManager] update:complete', { direction: 'graph_internal', operation, result });
      return result;
    } catch (error) {
      console.error('[UpdateManager] update:error', { direction: 'graph_internal', operation, error });
      throw error;
    }
  }
  
  /**
   * Flows B-F: Graph → File operations
   * Examples: 
   * - CREATE: New parameter file from edge, new case file from node
   * - UPDATE: Metadata changes (description, query)
   * - APPEND: New value to parameter values[], new schedule to case schedules[]
   */
  async handleGraphToFile(
    source: any,
    target: any | null,
    operation: 'CREATE' | 'UPDATE' | 'APPEND',
    subDest: SubDestination,
    options: UpdateOptions = {}
  ): Promise<UpdateResult> {
    console.log('[UpdateManager] update:start', { direction: 'graph_to_file', operation, subDest });
    
    try {
      switch (operation) {
        case 'CREATE':
          return await this.createFileFromGraph(source, subDest, options);
        case 'UPDATE':
          return await this.updateFileMetadata(source, target!, subDest, options);
        case 'APPEND':
          return await this.appendToFileHistory(source, target!, subDest, options);
        default:
          throw new Error(`Unsupported operation: ${operation}`);
      }
    } catch (error) {
      console.error('[UpdateManager] update:error', { direction: 'graph_to_file', operation, subDest, error });
      throw error;
    }
  }
  
  /**
   * Flows G-I: File → Graph updates
   * Examples:
   * - Pull from parameter file → update edge
   * - Pull from case file → update case node
   * - Link node to registry → sync label/description/event.id
   */
  async handleFileToGraph(
    source: any,
    target: any,
    operation: 'UPDATE',
    subDest: 'parameter' | 'case' | 'node',
    options: UpdateOptions = {}
  ): Promise<UpdateResult> {
    console.log('[UpdateManager] update:start', { direction: 'file_to_graph', operation, subDest });
    
    try {
      return await this.syncFileToGraph(source, target, subDest, options);
    } catch (error) {
      console.error('[UpdateManager] update:error', { direction: 'file_to_graph', operation, subDest, error });
      throw error;
    }
  }
  
  /**
   * Flows L-M: External → Graph direct updates
   * Examples:
   * - Amplitude data → update edge.p directly (no parameter file)
   * - Statsig weights → update case node directly (no case file)
   */
  async handleExternalToGraph(
    source: any,
    target: any,
    operation: 'UPDATE',
    subDest: 'parameter' | 'case',
    options: UpdateOptions = {}
  ): Promise<UpdateResult> {
    console.log('[UpdateManager] update:start', { direction: 'external_to_graph', operation, subDest });
    
    try {
      return await this.updateGraphFromExternal(source, target, subDest, options);
    } catch (error) {
      console.error('[UpdateManager] update:error', { direction: 'external_to_graph', operation, subDest, error });
      throw error;
    }
  }
  
  /**
   * Flows Q-R: External → File append to history
   * Examples:
   * - Amplitude data → append to parameter values[]
   * - Statsig weights → append to case schedules[]
   */
  async handleExternalToFile(
    source: any,
    target: any,
    operation: 'APPEND',
    subDest: 'parameter' | 'case',
    options: UpdateOptions = {}
  ): Promise<UpdateResult> {
    console.log('[UpdateManager] update:start', { direction: 'external_to_file', operation, subDest });
    
    try {
      return await this.appendExternalToFile(source, target, subDest, options);
    } catch (error) {
      console.error('[UpdateManager] update:error', { direction: 'external_to_file', operation, subDest, error });
      throw error;
    }
  }
  
  // ============================================================
  // LEVEL 2: OPERATION IMPLEMENTATIONS
  // ============================================================
  
  private async createFileFromGraph(
    graphEntity: any,
    subDest: SubDestination,
    options: UpdateOptions
  ): Promise<UpdateResult> {
    const result: UpdateResult = {
      success: true,
      changes: [],
      conflicts: [],
      errors: [],
      warnings: []
    };
    
    try {
      // 1. Get field mappings for CREATE operation
      const key = this.getMappingKey('graph_to_file', 'CREATE', subDest);
      const config = this.mappingConfigurations.get(key);
      
      if (!config) {
        throw new Error(`No mapping configuration for ${key}`);
      }
      
      // 2. Create new file structure
      const newFile: any = {};
      
      // 3. Apply mappings to populate file from graph entity
      for (const mapping of config.mappings) {
        try {
          const sourceValue = this.getNestedValue(graphEntity, mapping.sourceField);
          
          if (sourceValue !== undefined) {
            const transformedValue = mapping.transform
              ? mapping.transform(sourceValue, graphEntity, newFile)
              : sourceValue;
            
            this.setNestedValue(newFile, mapping.targetField, transformedValue);
            
            result.changes!.push({
              field: mapping.targetField,
              oldValue: undefined,
              newValue: transformedValue,
              source: 'manual'
            });
          }
        } catch (error) {
          result.errors!.push({
            code: 'MAPPING_ERROR',
            message: `Failed to map ${mapping.sourceField}: ${error}`,
            field: mapping.targetField,
            severity: 'error'
          });
        }
      }
      
      // 4. In validateOnly mode, don't actually write
      if (!options.validateOnly) {
        // TODO: Actual file write would happen here in Phase 1
        // await fs.writeFile(filePath, yaml.stringify(newFile));
        this.recordUpdate('CREATE', 'graph_to_file', subDest, graphEntity, newFile);
      }
      
      result.success = result.errors!.length === 0;
      return result;
    } catch (error) {
      result.success = false;
      result.errors!.push({
        code: 'CREATE_ERROR',
        message: `Failed to create file: ${error}`,
        severity: 'error'
      });
      return result;
    }
  }
  
  private async updateFileMetadata(
    graphEntity: any,
    existingFile: any,
    subDest: SubDestination,
    options: UpdateOptions
  ): Promise<UpdateResult> {
    // Get field mappings for UPDATE operation
    const key = this.getMappingKey('graph_to_file', 'UPDATE', subDest);
    const config = this.mappingConfigurations.get(key);
    
    if (!config) {
      throw new Error(`No mapping configuration for ${key}`);
    }
    
    // Apply mappings (metadata fields only, not history arrays)
    const result = await this.applyMappings(
      graphEntity,
      existingFile,
      config.mappings,
      options
    );
    
    // Record audit trail
    if (!options.validateOnly && result.success) {
      this.recordUpdate('UPDATE', 'graph_to_file', subDest, graphEntity, existingFile);
    }
    
    return result;
  }
  
  private async appendToFileHistory(
    graphEntity: any,
    existingFile: any,
    subDest: SubDestination,
    options: UpdateOptions
  ): Promise<UpdateResult> {
    const result: UpdateResult = {
      success: true,
      changes: [],
      conflicts: [],
      errors: [],
      warnings: []
    };
    
    try {
      // Get field mappings for APPEND operation
      const key = this.getMappingKey('graph_to_file', 'APPEND', subDest);
      const config = this.mappingConfigurations.get(key);
      
      if (!config) {
        throw new Error(`No mapping configuration for ${key}`);
      }
      
      // Apply mappings (will use values[] or schedules[] syntax)
      for (const mapping of config.mappings) {
        try {
          const sourceValue = this.getNestedValue(graphEntity, mapping.sourceField);
          
          console.log('[UpdateManager] APPEND mapping check:', {
            sourceField: mapping.sourceField,
            sourceValue,
            hasCondition: !!mapping.condition,
            conditionPassed: mapping.condition ? mapping.condition(graphEntity, existingFile) : true
          });
          
          // Check condition
          if (mapping.condition && !mapping.condition(graphEntity, existingFile)) {
            console.log('[UpdateManager] APPEND mapping SKIPPED (condition false)');
            continue;
          }
          
          if (sourceValue !== undefined) {
            const transformedValue = mapping.transform
              ? mapping.transform(sourceValue, graphEntity, existingFile)
              : sourceValue;
            
            console.log('[UpdateManager] APPEND mapping APPLYING:', {
              sourceField: mapping.sourceField,
              transformedValue
            });
            
            // Set value (will append due to [] syntax in targetField)
            if (!options.validateOnly) {
              this.setNestedValue(existingFile, mapping.targetField, transformedValue);
            }
            
            result.changes!.push({
              field: mapping.targetField,
              oldValue: undefined,
              newValue: transformedValue,
              source: 'manual'
            });
          }
        } catch (error) {
          result.errors!.push({
            code: 'APPEND_ERROR',
            message: `Failed to append ${mapping.sourceField}: ${error}`,
            field: mapping.targetField,
            severity: 'error'
          });
        }
      }
      
      // Record audit trail
      if (!options.validateOnly && result.success) {
        this.recordUpdate('APPEND', 'graph_to_file', subDest, graphEntity, existingFile);
      }
      
      result.success = result.errors!.length === 0;
      return result;
    } catch (error) {
      result.success = false;
      result.errors!.push({
        code: 'APPEND_ERROR',
        message: `Failed to append to file: ${error}`,
        severity: 'error'
      });
      return result;
    }
  }
  
  private async syncFileToGraph(
    fileData: any,
    graphEntity: any,
    subDest: 'parameter' | 'case' | 'node',
    options: UpdateOptions
  ): Promise<UpdateResult> {
    const key = this.getMappingKey('file_to_graph', 'UPDATE', subDest);
    const config = this.mappingConfigurations.get(key);
    
    if (!config) {
      throw new Error(`No mapping configuration for ${key}`);
    }
    
    const result = await this.applyMappings(fileData, graphEntity, config.mappings, options);
    
    // AUTO-REBALANCE: After parameter update from file pull, rebalance siblings
    // This applies to "Get from file" - if p(A>B) gets updated, auto-compute p(A>C)
    if (result.success && subDest === 'parameter' && !options.validateOnly) {
      result.metadata = result.metadata || {};
      (result.metadata as any).requiresSiblingRebalance = true;
      (result.metadata as any).updatedEdgeId = graphEntity.uuid || graphEntity.id;
      (result.metadata as any).updatedField = 'p';
    }
    
    return result;
  }
  
  private async updateGraphFromExternal(
    externalData: any,
    graphEntity: any,
    subDest: 'parameter' | 'case',
    options: UpdateOptions
  ): Promise<UpdateResult> {
    const key = this.getMappingKey('external_to_graph', 'UPDATE', subDest);
    const config = this.mappingConfigurations.get(key);
    
    if (!config) {
      throw new Error(`No mapping configuration for ${key}`);
    }
    
    const result = await this.applyMappings(externalData, graphEntity, config.mappings, options);
    
    // AUTO-REBALANCE: After parameter update from external source, rebalance siblings
    // This applies to DAS (Amplitude, etc.) - if p(A>B) gets data, auto-compute p(A>C)
    if (result.success && subDest === 'parameter' && !options.validateOnly) {
      result.metadata = result.metadata || {};
      (result.metadata as any).requiresSiblingRebalance = true;
      (result.metadata as any).updatedEdgeId = graphEntity.uuid || graphEntity.id;
      (result.metadata as any).updatedField = 'p';
    }
    
    return result;
  }
  
  private async appendExternalToFile(
    externalData: any,
    fileData: any,
    subDest: 'parameter' | 'case',
    options: UpdateOptions
  ): Promise<UpdateResult> {
    const result: UpdateResult = {
      success: true,
      changes: [],
      conflicts: [],
      errors: [],
      warnings: []
    };
    
    try {
      // Get field mappings for external append
      const key = this.getMappingKey('external_to_file', 'APPEND', subDest);
      const config = this.mappingConfigurations.get(key);
      
      if (!config) {
        throw new Error(`No mapping configuration for ${key}`);
      }
      
      // Apply mappings (will transform external data and append to file)
      for (const mapping of config.mappings) {
        try {
          const sourceValue = this.getNestedValue(externalData, mapping.sourceField);
          
          if (sourceValue !== undefined) {
            const transformedValue = mapping.transform
              ? mapping.transform(sourceValue, externalData, fileData)
              : sourceValue;
            
            // Append to file (will append due to [] syntax)
            if (!options.validateOnly) {
              this.setNestedValue(fileData, mapping.targetField, transformedValue);
            }
            
            result.changes!.push({
              field: mapping.targetField,
              oldValue: undefined,
              newValue: transformedValue,
              source: 'external'
            });
          }
        } catch (error) {
          result.errors!.push({
            code: 'EXTERNAL_APPEND_ERROR',
            message: `Failed to append external data: ${error}`,
            field: mapping.targetField,
            severity: 'error'
          });
        }
      }
      
      // Record audit trail
      if (!options.validateOnly && result.success) {
        this.recordUpdate('APPEND', 'external_to_file', subDest, externalData, fileData);
      }
      
      result.success = result.errors!.length === 0;
      return result;
    } catch (error) {
      result.success = false;
      result.errors!.push({
        code: 'EXTERNAL_APPEND_ERROR',
        message: `Failed to append external data: ${error}`,
        severity: 'error'
      });
      return result;
    }
  }
  
  // ============================================================
  // CORE LOGIC: APPLY MAPPINGS WITH OVERRIDE RESPECT
  // ============================================================
  
  /**
   * Apply field mappings from source to target, respecting override flags
   */
  private async applyMappings(
    source: any,
    target: any,
    mappings: FieldMapping[],
    options: UpdateOptions
  ): Promise<UpdateResult> {
    const result: UpdateResult = {
      success: true,
      changes: [],
      conflicts: [],
      errors: [],
      warnings: []
    };
    
    for (const mapping of mappings) {
      try {
        // Check condition
        if (mapping.condition && !mapping.condition(source, target)) {
          continue;
        }
        
        // Check override flag
        if (mapping.overrideFlag) {
          const isOverridden = this.getNestedValue(target, mapping.overrideFlag);
          if (isOverridden) {
            result.conflicts!.push({
              field: mapping.targetField,
              currentValue: this.getNestedValue(target, mapping.targetField),
              newValue: this.getNestedValue(source, mapping.sourceField),
              reason: 'overridden'
            });
            continue; // Skip overridden fields
          }
        }
        
        // Get values
        const sourceValue = this.getNestedValue(source, mapping.sourceField);
        const currentValue = this.getNestedValue(target, mapping.targetField);
        
        // Transform if needed
        const newValue = mapping.transform 
          ? mapping.transform(sourceValue, source, target)
          : sourceValue;
        
        // Skip if no usable data (undefined means "can't calculate, don't update")
        if (newValue === undefined) {
          continue;
        }
        
        // Check for changes
        if (newValue !== currentValue) {
          if (!options.validateOnly) {
            this.setNestedValue(target, mapping.targetField, newValue);
          }
          
          result.changes!.push({
            field: mapping.targetField,
            oldValue: currentValue,
            newValue: newValue,
            source: 'auto',
            overridden: false
          });
        }
      } catch (error) {
        result.errors!.push({
          code: 'MAPPING_ERROR',
          message: `Failed to map ${mapping.sourceField} → ${mapping.targetField}: ${error}`,
          field: mapping.targetField,
          severity: 'error'
        });
        
        if (options.stopOnError) {
          result.success = false;
          return result;
        }
      }
    }
    
    result.success = result.errors!.length === 0;
    return result;
  }
  
  // ============================================================
  // LEVEL 3: MAPPING CONFIGURATIONS (18 configs)
  // ============================================================
  
  private initializeMappings() {
    /**
     * Initialize all 18 mapping configurations
     * Based on validated field mappings from SCHEMA_FIELD_MAPPINGS.md (Phase 0.2)
     */
    
    // ============================================================
    // Flow A: Graph Internal (MSMDC, cascades)
    // ============================================================
    
    this.addMapping('graph_internal', 'UPDATE', undefined, [
      // MSMDC query regeneration handled separately
      // Label cascades handled by graph editor directly
    ]);
    
    // ============================================================
    // Flows B-F: Graph → File
    // ============================================================
    
    // Flow B.CREATE: Graph → File/Parameter (CREATE new file)
    // Note: When creating a new param file, we initialize its name/description from the edge
    // as a sensible default. This is different from GET, where we don't overwrite edge metadata.
    this.addMapping('graph_to_file', 'CREATE', 'parameter', [
      { sourceField: 'id', targetField: 'id' },
      { sourceField: 'label', targetField: 'name' },
      { sourceField: 'description', targetField: 'description' },
      { sourceField: 'query', targetField: 'query' },
      // Connection settings: initialize from graph if present
      // Probability parameter connection
      { 
        sourceField: 'p.connection', 
        targetField: 'connection',
        condition: (source) => !!source.p?.connection && source.p?.id
      },
      { 
        sourceField: 'p.connection_string', 
        targetField: 'connection_string',
        condition: (source) => !!source.p?.connection_string && source.p?.id
      },
      // Cost GBP parameter connection
      { 
        sourceField: 'cost_gbp.connection', 
        targetField: 'connection',
        condition: (source) => !!source.cost_gbp?.connection && source.cost_gbp?.id
      },
      { 
        sourceField: 'cost_gbp.connection_string', 
        targetField: 'connection_string',
        condition: (source) => !!source.cost_gbp?.connection_string && source.cost_gbp?.id
      },
      // Cost Time parameter connection
      { 
        sourceField: 'cost_time.connection', 
        targetField: 'connection',
        condition: (source) => !!source.cost_time?.connection && source.cost_time?.id
      },
      { 
        sourceField: 'cost_time.connection_string', 
        targetField: 'connection_string',
        condition: (source) => !!source.cost_time?.connection_string && source.cost_time?.id
      },
      // Type field: determine from which edge param is populated
      { 
        sourceField: 'p', 
        targetField: 'parameter_type',
        condition: (source) => !!source.p?.id,
        transform: () => 'probability'
      },
      { 
        sourceField: 'cost_gbp', 
        targetField: 'parameter_type',
        condition: (source) => !!source.cost_gbp?.id,
        transform: () => 'cost_gbp'
      },
      { 
        sourceField: 'cost_time', 
        targetField: 'parameter_type',
        condition: (source) => !!source.cost_time?.id,
        transform: () => 'cost_time'
      },
      // Initial values: populate from whichever param type exists
      { 
        sourceField: 'p.mean', 
        targetField: 'values[0]',
        condition: (source) => !!source.p?.id,
        transform: (value, source) => ({
          mean: value,
          stdev: source.p.stdev,
          distribution: source.p.distribution,
          n: source.p.evidence?.n,
          k: source.p.evidence?.k,
          window_from: source.p.evidence?.window_from || new Date().toISOString(),
          window_to: source.p.evidence?.window_to
        })
      },
      { 
        sourceField: 'cost_gbp.mean', 
        targetField: 'values[0]',
        condition: (source) => !!source.cost_gbp?.id,
        transform: (value, source) => ({
          mean: value,
          stdev: source.cost_gbp.stdev,
          distribution: source.cost_gbp.distribution,
          window_from: source.cost_gbp.evidence?.window_from || new Date().toISOString(),
          window_to: source.cost_gbp.evidence?.window_to
        })
      },
      { 
        sourceField: 'cost_time.mean', 
        targetField: 'values[0]',
        condition: (source) => !!source.cost_time?.id,
        transform: (value, source) => ({
          mean: value,
          stdev: source.cost_time.stdev,
          distribution: source.cost_time.distribution,
          window_from: source.cost_time.evidence?.window_from || new Date().toISOString(),
          window_to: source.cost_time.evidence?.window_to
        })
      }
    ]);
    
    // Flow B.UPDATE: Graph → File/Parameter (UPDATE metadata)
    // NOTE: Connection settings always sync from graph to file (file doesn't have override flags)
    // If graph has overridden connection, PUT will update file to match graph's override
    // NOTE: query and description respect file-side override flags
    this.addMapping('graph_to_file', 'UPDATE', 'parameter', [
      { 
        sourceField: 'description', 
        targetField: 'description',
        overrideFlag: 'metadata.description_overridden' // Respect file-side override
      },
      { 
        sourceField: 'query', 
        targetField: 'query',
        overrideFlag: 'query_overridden' // Respect file-side override
      },
      // Connection settings: always sync from graph to file
      // Probability parameter connection
      { 
        sourceField: 'p.connection', 
        targetField: 'connection',
        condition: (source) => !!source.p?.connection && source.p?.id
      },
      { 
        sourceField: 'p.connection_string', 
        targetField: 'connection_string',
        condition: (source) => !!source.p?.connection_string && source.p?.id
      },
      // Cost GBP parameter connection
      { 
        sourceField: 'cost_gbp.connection', 
        targetField: 'connection',
        condition: (source) => !!source.cost_gbp?.connection && source.cost_gbp?.id
      },
      { 
        sourceField: 'cost_gbp.connection_string', 
        targetField: 'connection_string',
        condition: (source) => !!source.cost_gbp?.connection_string && source.cost_gbp?.id
      },
      // Cost Time parameter connection
      { 
        sourceField: 'cost_time.connection', 
        targetField: 'connection',
        condition: (source) => !!source.cost_time?.connection && source.cost_time?.id
      },
      { 
        sourceField: 'cost_time.connection_string', 
        targetField: 'connection_string',
        condition: (source) => !!source.cost_time?.connection_string && source.cost_time?.id
      }
    ]);
    
    // Flow B.APPEND: Graph → File/Parameter (APPEND new value)
    this.addMapping('graph_to_file', 'APPEND', 'parameter', [
      // Probability parameter: edge.p.* → parameter.values[]
      // Preserve all relevant fields including evidence data if present
      // NOTE: Do NOT include daily values (n_daily, k_daily, dates) - those are only from external data pulls
      { 
        sourceField: 'p.mean', 
        targetField: 'values[]',
        condition: (source, target) => target.type === 'probability' || target.parameter_type === 'probability',
        transform: (value, source) => {
          const entry: any = { mean: value };
          
          // Statistical fields
          if (source.p.stdev !== undefined) entry.stdev = source.p.stdev;
          if (source.p.distribution) entry.distribution = source.p.distribution;
          
          // Evidence fields (if present - from data pulls)
          // NOTE: Do NOT include n_daily/k_daily/dates - those are only for external data pulls
          // Only include evidence if it's from a data_source (not stale from previous GET)
          // Manual edits should NOT include stale evidence - check if data_source exists and is not manual
          if (source.p.evidence && source.p.data_source && source.p.data_source.type && source.p.data_source.type !== 'manual') {
            if (source.p.evidence.n !== undefined) entry.n = source.p.evidence.n;
            if (source.p.evidence.k !== undefined) entry.k = source.p.evidence.k;
            if (source.p.evidence.window_from) entry.window_from = source.p.evidence.window_from;
            if (source.p.evidence.window_to) entry.window_to = source.p.evidence.window_to;
          }
          
          // If no evidence window_from, use current time
          if (!entry.window_from) {
            entry.window_from = new Date().toISOString();
          }
          
          // Data source: preserve from edge if exists, otherwise mark as manual
          if (source.p.data_source) {
            entry.data_source = source.p.data_source;
          } else if (source.p.evidence?.source) {
            // If evidence has source info, construct data_source from evidence
            entry.data_source = {
              type: source.p.evidence.source,
              retrieved_at: source.p.evidence.retrieved_at || new Date().toISOString(),
              full_query: source.p.evidence.full_query,
              debug_trace: source.p.evidence.debug_trace
            };
          } else {
            // Manual edit - no evidence or data_source
            entry.data_source = {
              type: 'manual',
              edited_at: new Date().toISOString()
            };
          }
          
          return entry;
        }
      },
      // Cost GBP parameter: edge.cost_gbp.* → parameter.values[]
      { 
        sourceField: 'cost_gbp.mean', 
        targetField: 'values[]',
        condition: (source, target) => target.type === 'cost_gbp' || target.parameter_type === 'cost_gbp',
        transform: (value, source) => {
          const entry: any = { mean: value };
          
          // Statistical fields
          if (source.cost_gbp.stdev !== undefined) entry.stdev = source.cost_gbp.stdev;
          if (source.cost_gbp.distribution) entry.distribution = source.cost_gbp.distribution;
          
          // Evidence fields (if present - from data pulls)
          if (source.cost_gbp.evidence) {
            if (source.cost_gbp.evidence.n !== undefined) entry.n = source.cost_gbp.evidence.n;
            if (source.cost_gbp.evidence.k !== undefined) entry.k = source.cost_gbp.evidence.k;
            if (source.cost_gbp.evidence.window_from) entry.window_from = source.cost_gbp.evidence.window_from;
            if (source.cost_gbp.evidence.window_to) entry.window_to = source.cost_gbp.evidence.window_to;
          }
          
          // If no evidence window_from, use current time
          if (!entry.window_from) {
            entry.window_from = new Date().toISOString();
          }
          
          // Data source: preserve from edge if exists, otherwise mark as manual
          if (source.cost_gbp.data_source) {
            entry.data_source = source.cost_gbp.data_source;
          } else if (source.cost_gbp.evidence?.source) {
            entry.data_source = {
              type: source.cost_gbp.evidence.source,
              retrieved_at: source.cost_gbp.evidence.retrieved_at || new Date().toISOString(),
              full_query: source.cost_gbp.evidence.full_query,
              debug_trace: source.cost_gbp.evidence.debug_trace
            };
          } else {
            entry.data_source = {
              type: 'manual',
              edited_at: new Date().toISOString()
            };
          }
          
          return entry;
        }
      },
      // Cost Time parameter: edge.cost_time.* → parameter.values[]
      { 
        sourceField: 'cost_time.mean', 
        targetField: 'values[]',
        condition: (source, target) => target.type === 'cost_time' || target.parameter_type === 'cost_time',
        transform: (value, source) => {
          const entry: any = { mean: value };
          
          // Statistical fields
          if (source.cost_time.stdev !== undefined) entry.stdev = source.cost_time.stdev;
          if (source.cost_time.distribution) entry.distribution = source.cost_time.distribution;
          
          // Evidence fields (if present - from data pulls)
          if (source.cost_time.evidence) {
            if (source.cost_time.evidence.n !== undefined) entry.n = source.cost_time.evidence.n;
            if (source.cost_time.evidence.k !== undefined) entry.k = source.cost_time.evidence.k;
            if (source.cost_time.evidence.window_from) entry.window_from = source.cost_time.evidence.window_from;
            if (source.cost_time.evidence.window_to) entry.window_to = source.cost_time.evidence.window_to;
          }
          
          // If no evidence window_from, use current time
          if (!entry.window_from) {
            entry.window_from = new Date().toISOString();
          }
          
          // Data source: preserve from edge if exists, otherwise mark as manual
          if (source.cost_time.data_source) {
            entry.data_source = source.cost_time.data_source;
          } else if (source.cost_time.evidence?.source) {
            entry.data_source = {
              type: source.cost_time.evidence.source,
              retrieved_at: source.cost_time.evidence.retrieved_at || new Date().toISOString(),
              full_query: source.cost_time.evidence.full_query,
              debug_trace: source.cost_time.evidence.debug_trace
            };
          } else {
            entry.data_source = {
              type: 'manual',
              edited_at: new Date().toISOString()
            };
          }
          
          return entry;
        }
      }
      
      // NOTE: Conditional probabilities (edge.conditional_p[i].p) reuse the same mappings above
      // The dataOperationsService must pass conditional_p[i].p (the ProbabilityParam object) as the source
      // This way, the probability parameter mappings work for both edge.p and edge.conditional_p[i].p
    ]);
    
    // Flow C.CREATE: Graph → File/Case (CREATE new file)
    // Note: When creating a new case file, we pre-populate it with helpful defaults from the graph
    // User will then edit the form and save. After that, case file and node metadata are independent.
    this.addMapping('graph_to_file', 'CREATE', 'case', [
      { sourceField: 'case.id', targetField: 'id' },  // case ID
      { sourceField: 'label', targetField: 'name' },  // Initialize case name from node label
      { sourceField: 'description', targetField: 'description' },  // Initialize case description from node
      { sourceField: 'case.variants', targetField: 'variants' }
    ]);
    
    // Flow C.UPDATE: Graph → File/Case (UPDATE current variant weights)
    // Note: This updates case.variants array with current weights from graph
    // This is NOT metadata - it's the current state of variant allocation
    this.addMapping('graph_to_file', 'UPDATE', 'case', [
      {
        sourceField: 'case.variants',
        targetField: 'case.variants',
        transform: (graphVariants, source, target) => {
          // Update weights in case file from graph node
          // Preserve all other variant properties from file
          
          // 1. Update existing file variants with graph data
          const updated = target.case.variants.map((fileVariant: any) => {
            const graphVariant = graphVariants.find((gv: any) => gv.name === fileVariant.name);
            if (graphVariant) {
              return {
                ...fileVariant,
                name: graphVariant.name_overridden ? graphVariant.name : fileVariant.name,
                weight: graphVariant.weight_overridden ? graphVariant.weight : fileVariant.weight,
                description: graphVariant.description_overridden ? graphVariant.description : fileVariant.description
              };
            }
            return fileVariant;
          });
          
          // 2. Add any new variants from graph that don't exist in file
          const fileVariantNames = new Set(target.case.variants.map((fv: any) => fv.name));
          const newVariants = graphVariants
            .filter((gv: any) => !fileVariantNames.has(gv.name))
            .map((gv: any) => ({
              name: gv.name,
              weight: gv.weight,
              description: gv.description
            }));
          
          return [...updated, ...newVariants];
        }
      }
    ]);
    
    // Flow C.APPEND: Graph → File/Case (APPEND new schedule)
    this.addMapping('graph_to_file', 'APPEND', 'case', [
      { 
        sourceField: 'case.variants', 
        targetField: 'case.schedules[]',  // Case files have schedules under case.schedules, not at root
        transform: (variants) => ({
          variants: variants.map((v: any) => ({
            name: v.name,
            weight: v.weight
          })),
          window_from: new Date().toISOString(),
          source: 'manual',
          edited_at: new Date().toISOString()
          // TODO: Add author from credentials when available
        })
      }
    ]);
    
    // Flow D.CREATE: Graph → File/Node (CREATE new registry entry)
    this.addMapping('graph_to_file', 'CREATE', 'node', [
      { sourceField: 'id', targetField: 'id' },  // human-readable ID
      { sourceField: 'label', targetField: 'name' },
      { sourceField: 'description', targetField: 'description' },
      { sourceField: 'event_id', targetField: 'event_id' }
    ]);
    
    // Flow D.UPDATE: Graph → File/Node (UPDATE registry entry)
    this.addMapping('graph_to_file', 'UPDATE', 'node', [
      { sourceField: 'label', targetField: 'name' },
      { sourceField: 'description', targetField: 'description' },
      { sourceField: 'event_id', targetField: 'event_id' }
    ]);
    
    // Flow E.CREATE: Graph → File/Context (CREATE new registry entry)
    this.addMapping('graph_to_file', 'CREATE', 'context', [
      // Contexts are curated manually, not auto-created from graph
      // This mapping exists for completeness but is rarely used
    ]);
    
    // Flow F.CREATE: Graph → File/Event (CREATE new registry entry)
    this.addMapping('graph_to_file', 'CREATE', 'event', [
      // Events are curated manually, not auto-created from graph
      // This mapping exists for completeness but is rarely used
    ]);
    
    // ============================================================
    // Flows G-I: File → Graph
    // ============================================================
    
    // Flow G: File/Parameter → Graph (UPDATE edge)
    // Note: This updates edge.p.* fields (probability parameter data), NOT edge-level metadata
    this.addMapping('file_to_graph', 'UPDATE', 'parameter', [
      // Probability parameters → edge.p.*
      { 
        sourceField: 'values[latest].mean', 
        targetField: 'p.mean',
        overrideFlag: 'p.mean_overridden',
        condition: (source) => source.type === 'probability' || source.parameter_type === 'probability'
      },
      { 
        sourceField: 'values[latest].stdev', 
        targetField: 'p.stdev',
        overrideFlag: 'p.stdev_overridden',
        condition: (source) => source.type === 'probability' || source.parameter_type === 'probability'
      },
      { 
        sourceField: 'values[latest].distribution', 
        targetField: 'p.distribution',
        overrideFlag: 'p.distribution_overridden',
        condition: (source) => source.type === 'probability' || source.parameter_type === 'probability'
      },
      { 
        sourceField: 'values[latest].n', 
        targetField: 'p.evidence.n',
        condition: (source) => source.type === 'probability' || source.parameter_type === 'probability'
      },
      { 
        sourceField: 'values[latest].k', 
        targetField: 'p.evidence.k',
        condition: (source) => source.type === 'probability' || source.parameter_type === 'probability'
      },
      { 
        sourceField: 'values[latest].window_from', 
        targetField: 'p.evidence.window_from',
        condition: (source) => source.type === 'probability' || source.parameter_type === 'probability'
      },
      { 
        sourceField: 'values[latest].window_to', 
        targetField: 'p.evidence.window_to',
        condition: (source) => source.type === 'probability' || source.parameter_type === 'probability'
      },
      { 
        sourceField: 'values[latest].data_source', 
        targetField: 'p.data_source',
        condition: (source) => source.type === 'probability' || source.parameter_type === 'probability'
      },
      // Map data_source fields to evidence if data_source exists
      { 
        sourceField: 'values[latest].data_source.retrieved_at', 
        targetField: 'p.evidence.retrieved_at',
        condition: (source) => (source.type === 'probability' || source.parameter_type === 'probability') && source.values?.[source.values.length - 1]?.data_source?.retrieved_at
      },
      { 
        sourceField: 'values[latest].data_source.type', 
        targetField: 'p.evidence.source',
        condition: (source) => (source.type === 'probability' || source.parameter_type === 'probability') && source.values?.[source.values.length - 1]?.data_source?.type
      },
      { 
        sourceField: 'values[latest].data_source.full_query', 
        targetField: 'p.evidence.full_query',
        condition: (source) => (source.type === 'probability' || source.parameter_type === 'probability') && source.values?.[source.values.length - 1]?.data_source?.full_query
      },
      { 
        sourceField: 'values[latest].data_source.debug_trace', 
        targetField: 'p.evidence.debug_trace',
        condition: (source) => (source.type === 'probability' || source.parameter_type === 'probability') && source.values?.[source.values.length - 1]?.data_source?.debug_trace
      },
      
      // Cost GBP parameters → edge.cost_gbp.*
      { 
        sourceField: 'values[latest].mean', 
        targetField: 'cost_gbp.mean',
        overrideFlag: 'cost_gbp.mean_overridden',
        condition: (source) => source.type === 'cost_gbp' || source.parameter_type === 'cost_gbp'
      },
      { 
        sourceField: 'values[latest].stdev', 
        targetField: 'cost_gbp.stdev',
        overrideFlag: 'cost_gbp.stdev_overridden',
        condition: (source) => source.type === 'cost_gbp' || source.parameter_type === 'cost_gbp'
      },
      { 
        sourceField: 'values[latest].distribution', 
        targetField: 'cost_gbp.distribution',
        overrideFlag: 'cost_gbp.distribution_overridden',
        condition: (source) => source.type === 'cost_gbp' || source.parameter_type === 'cost_gbp'
      },
      { 
        sourceField: 'values[latest].window_from', 
        targetField: 'cost_gbp.evidence.window_from',
        condition: (source) => source.type === 'cost_gbp' || source.parameter_type === 'cost_gbp'
      },
      { 
        sourceField: 'values[latest].window_to', 
        targetField: 'cost_gbp.evidence.window_to',
        condition: (source) => source.type === 'cost_gbp' || source.parameter_type === 'cost_gbp'
      },
      
      // Cost Time parameters → edge.cost_time.*
      { 
        sourceField: 'values[latest].mean', 
        targetField: 'cost_time.mean',
        overrideFlag: 'cost_time.mean_overridden',
        condition: (source) => source.type === 'cost_time' || source.parameter_type === 'cost_time'
      },
      { 
        sourceField: 'values[latest].stdev', 
        targetField: 'cost_time.stdev',
        overrideFlag: 'cost_time.stdev_overridden',
        condition: (source) => source.type === 'cost_time' || source.parameter_type === 'cost_time'
      },
      { 
        sourceField: 'values[latest].distribution', 
        targetField: 'cost_time.distribution',
        overrideFlag: 'cost_time.distribution_overridden',
        condition: (source) => source.type === 'cost_time' || source.parameter_type === 'cost_time'
      },
      { 
        sourceField: 'values[latest].window_from', 
        targetField: 'cost_time.evidence.window_from',
        condition: (source) => source.type === 'cost_time' || source.parameter_type === 'cost_time'
      },
      { 
        sourceField: 'values[latest].window_to', 
        targetField: 'cost_time.evidence.window_to',
        condition: (source) => source.type === 'cost_time' || source.parameter_type === 'cost_time'
      },
      { 
        sourceField: 'values[latest].data_source', 
        targetField: 'cost_time.data_source',
        condition: (source) => source.type === 'cost_time' || source.parameter_type === 'cost_time'
      },
      { 
        sourceField: 'values[latest].data_source.retrieved_at', 
        targetField: 'cost_time.evidence.retrieved_at',
        condition: (source) => (source.type === 'cost_time' || source.parameter_type === 'cost_time') && source.values?.[source.values.length - 1]?.data_source?.retrieved_at
      },
      { 
        sourceField: 'values[latest].data_source.type', 
        targetField: 'cost_time.evidence.source',
        condition: (source) => (source.type === 'cost_time' || source.parameter_type === 'cost_time') && source.values?.[source.values.length - 1]?.data_source?.type
      },
      { 
        sourceField: 'values[latest].data_source.full_query', 
        targetField: 'cost_time.evidence.full_query',
        condition: (source) => (source.type === 'cost_time' || source.parameter_type === 'cost_time') && source.values?.[source.values.length - 1]?.data_source?.full_query
      },
      { 
        sourceField: 'values[latest].data_source.debug_trace', 
        targetField: 'cost_time.evidence.debug_trace',
        condition: (source) => (source.type === 'cost_time' || source.parameter_type === 'cost_time') && source.values?.[source.values.length - 1]?.data_source?.debug_trace
      },
      
      // NOTE: Query string is NOT synced from file→graph
      // The dataOperationsService must:
      // 1. Find the conditional_p[i] element where p.parameter_id matches the paramId
      // 2. Pass conditional_p[i].p (the ProbabilityParam object) as the target to UpdateManager
      // 3. After update, replace conditional_p[i].p with the updated object
      // This way, the same mappings work for both edge.p and edge.conditional_p[i].p
      
      // NOTE: We do NOT map parameter.name or parameter.description to edge.label or edge.description
      // Those are edge-level metadata and should be independent of the parameter
      
      // Connection settings: sync from file to graph if not overridden
      // Probability parameter connection
      { 
        sourceField: 'connection', 
        targetField: 'p.connection',
        overrideFlag: 'p.connection_overridden',
        condition: (source) => (source.type === 'probability' || source.parameter_type === 'probability') && !!source.connection
      },
      { 
        sourceField: 'connection_string', 
        targetField: 'p.connection_string',
        overrideFlag: 'p.connection_overridden',
        condition: (source) => (source.type === 'probability' || source.parameter_type === 'probability') && !!source.connection_string
      },
      // Cost GBP parameter connection
      { 
        sourceField: 'connection', 
        targetField: 'cost_gbp.connection',
        overrideFlag: 'cost_gbp.connection_overridden',
        condition: (source) => (source.type === 'cost_gbp' || source.parameter_type === 'cost_gbp') && !!source.connection
      },
      { 
        sourceField: 'connection_string', 
        targetField: 'cost_gbp.connection_string',
        overrideFlag: 'cost_gbp.connection_overridden',
        condition: (source) => (source.type === 'cost_gbp' || source.parameter_type === 'cost_gbp') && !!source.connection_string
      },
      // Cost Time parameter connection
      { 
        sourceField: 'connection', 
        targetField: 'cost_time.connection',
        overrideFlag: 'cost_time.connection_overridden',
        condition: (source) => (source.type === 'cost_time' || source.parameter_type === 'cost_time') && !!source.connection
      },
      { 
        sourceField: 'connection_string', 
        targetField: 'cost_time.connection_string',
        overrideFlag: 'cost_time.connection_overridden',
        condition: (source) => (source.type === 'cost_time' || source.parameter_type === 'cost_time') && !!source.connection_string
      }
    ]);
    
    // Flow H: File/Case → Graph (UPDATE case node)
    // Note: This updates node.case.* fields (case-specific data), NOT node-level metadata
    // Node label/description come from node files, not case files
    this.addMapping('file_to_graph', 'UPDATE', 'case', [
      // Case status
      {
        sourceField: 'case.status',
        targetField: 'case.status',
        overrideFlag: 'case.status_overridden'
      },
      // Case variants - prefer schedules[latest].variants if schedules exist
      { 
        sourceField: 'case.variants',  // Fallback field
        targetField: 'case.variants',
        transform: (fileVariants, source, target) => {
          // Sync variant names and weights from case file to graph node
          // Respect override flags: if graph has overridden a variant, preserve it
          
          // Normalize fileVariants to array format
          let normalizedFileVariants = fileVariants;
          if (fileVariants && !Array.isArray(fileVariants) && typeof fileVariants === 'object') {
            normalizedFileVariants = Object.entries(fileVariants).map(([name, weight]) => ({
              name,
              weight: typeof weight === 'number' ? weight : parseFloat(String(weight))
            }));
          }
          
          // If case file has schedules, use the latest schedule's variants
          let variantsToUse = normalizedFileVariants;
          if (source.case?.schedules && source.case.schedules.length > 0) {
            // Get schedules[latest] by timestamp
            const sortedSchedules = source.case.schedules.slice().sort((a: any, b: any) => {
              const timeA = a.window_from ? new Date(a.window_from).getTime() : 0;
              const timeB = b.window_from ? new Date(b.window_from).getTime() : 0;
              return timeB - timeA; // Most recent first
            });
            const scheduleVariants = sortedSchedules[0].variants;
            
            // Convert variants from object/map to array if necessary
            // Schema has two formats:
            // - Array: [{ name: 'control', weight: 0.5 }, ...]
            // - Object/Map: { control: 0.5, 'single-page': 0.5 }
            if (Array.isArray(scheduleVariants)) {
              variantsToUse = scheduleVariants;
            } else if (scheduleVariants && typeof scheduleVariants === 'object') {
              // Convert object to array
              variantsToUse = Object.entries(scheduleVariants).map(([name, weight]) => ({
                name,
                weight: typeof weight === 'number' ? weight : parseFloat(String(weight))
              }));
            }
          }
          
          // If target doesn't have variants yet, create fresh from file
          if (!target.case || !target.case.variants || target.case.variants.length === 0) {
            return variantsToUse.map((fv: any) => ({
              name: fv.name,
              name_overridden: false,
              weight: fv.weight,
              weight_overridden: false,
              description: fv.description,
              description_overridden: false
            }));
          }
          
        // Merge: respect overrides, sync non-overridden fields
        // 1. Start with all variants from file (these are authoritative)
        const merged = variantsToUse.map((fv: any) => {
          const graphVariant = target.case.variants.find((gv: any) => gv.name === fv.name);
          
          return {
            name: graphVariant?.name_overridden ? graphVariant.name : fv.name,
            name_overridden: graphVariant?.name_overridden ?? false,
            weight: graphVariant?.weight_overridden ? graphVariant.weight : fv.weight,
            weight_overridden: graphVariant?.weight_overridden ?? false,
            description: graphVariant?.description_overridden ? graphVariant.description : fv.description,
            description_overridden: graphVariant?.description_overridden ?? false,
            // Preserve graph-only fields (e.g. edges array)
            ...(graphVariant && graphVariant.edges ? { edges: graphVariant.edges } : {})
          };
        });
        
        // 2. Preserve graph-only variants ONLY if they have edges or overrides
        // Non-overridden variants without edges are "disposable" and should be removed on GET
        const fileVariantNames = new Set(variantsToUse.map((fv: any) => fv.name));
        const graphOnlyVariants = target.case.variants.filter((gv: any) => {
          if (fileVariantNames.has(gv.name)) return false; // Already in file
          
          // Keep if it has edges or any override flags
          return gv.edges?.length > 0 || 
                 gv.name_overridden || 
                 gv.weight_overridden || 
                 gv.description_overridden;
        });
        
        return [...merged, ...graphOnlyVariants];
        }
      }
      // NOTE: We do NOT map case.name or case.description to node.label or node.description
      // Those are node-level metadata and come from node files, not case files
      // If needed, we could add node.case.name and node.case.description fields for case metadata
    ]);
    
    // Flow I: File/Node → Graph (UPDATE node from registry)
    this.addMapping('file_to_graph', 'UPDATE', 'node', [
      { 
        sourceField: 'name', 
        targetField: 'label',
        overrideFlag: 'label_overridden'
      },
      { 
        sourceField: 'description', 
        targetField: 'description',
        overrideFlag: 'description_overridden'
      },
      { 
        sourceField: 'event_id', 
        targetField: 'event_id',
        overrideFlag: 'event_id_overridden'
      }
    ]);
    
    // ============================================================
    // Flows L-M: External → Graph
    // ============================================================
    
    // Flow L: External → Graph/Parameter (UPDATE edge directly)
    this.addMapping('external_to_graph', 'UPDATE', 'parameter', [
      { 
        sourceField: 'probability', 
        targetField: 'p.mean',
        overrideFlag: 'p.mean_overridden',
        transform: (probability, source) => {
          // Prefer explicit probability if provided (may be adjusted/rounded)
          // Only recalculate if explicit probability not available
          if (probability !== undefined && probability !== null) {
            return probability;
          }
          // Fallback: calculate from n/k if both are available
          if (source.sample_size > 0 && source.successes !== undefined) {
            // Calculate probability, clamping to [0, 1] in case of data errors
            const calculated = source.successes / source.sample_size;
            return Math.max(0, Math.min(1, calculated));
          }
          // No probability data available - don't update mean
          return undefined;
        }
      },
      { 
        sourceField: 'sample_size', 
        targetField: 'p.evidence.n'
      },
      { 
        sourceField: 'successes', 
        targetField: 'p.evidence.k'
      },
      { 
        sourceField: 'retrieved_at', 
        targetField: 'p.evidence.retrieved_at'
      },
      { 
        sourceField: 'source', 
        targetField: 'p.evidence.source'
      },
      { 
        sourceField: 'data_source', 
        targetField: 'p.data_source'
      }
    ]);
    
    // Flow M: External → Graph/Case (UPDATE case node directly)
    this.addMapping('external_to_graph', 'UPDATE', 'case', [
      { 
        sourceField: 'variants', 
        targetField: 'case.variants',
        transform: (externalVariants, source, target) => {
          // Merge external weights with existing case structure
          return target.case.variants.map((v: any) => {
            const externalVariant = externalVariants.find((ev: any) => ev.name === v.name);
            return {
              ...v,
              weight: externalVariant?.weight ?? v.weight
            };
          });
        }
      }
    ]);
    
    // ============================================================
    // Flows Q-R: External → File
    // ============================================================
    
    // Flow Q: External → File/Parameter (APPEND to values[])
    this.addMapping('external_to_file', 'APPEND', 'parameter', [
      { 
        sourceField: 'data', 
        targetField: 'values[]',
        transform: (externalData) => {
          // Calculate mean from n/k if not provided directly
          let mean = externalData.probability;
          if (mean === undefined && externalData.sample_size > 0 && externalData.successes !== undefined) {
            // Calculate and clamp to [0, 1]
            mean = Math.max(0, Math.min(1, externalData.successes / externalData.sample_size));
          }
          
          // Build value object with whatever fields we have
          const value: any = {};
          if (mean !== undefined) value.mean = mean;
          if (externalData.stdev !== undefined) value.stdev = externalData.stdev;
          if (externalData.sample_size !== undefined) value.n = externalData.sample_size;
          if (externalData.successes !== undefined) value.k = externalData.successes;
          if (externalData.window_from) value.window_from = externalData.window_from;
          if (externalData.window_to) value.window_to = externalData.window_to;
          if (externalData.retrieved_at) value.retrieved_at = externalData.retrieved_at;
          
          return value;
        }
      }
    ]);
    
    // Flow R: External → File/Case (APPEND to schedules[])
    this.addMapping('external_to_file', 'APPEND', 'case', [
      { 
        sourceField: 'data', 
        targetField: 'schedules[]',
        transform: (externalData) => ({
          variants: externalData.variants.map((v: any) => ({
            name: v.name,
            weight: v.weight
          })),
          window_from: externalData.window_from,
          window_to: externalData.window_to,
          retrieved_at: externalData.retrieved_at
        })
      }
    ]);
  }
  
  private addMapping(
    direction: Direction,
    operation: Operation,
    subDest: SubDestination | undefined,
    mappings: FieldMapping[]
  ) {
    const key = this.getMappingKey(direction, operation, subDest);
    this.mappingConfigurations.set(key, {
      direction,
      operation,
      subDestination: subDest,
      mappings
    });
  }
  
  private getMappingKey(
    direction: Direction,
    operation: Operation,
    subDest?: SubDestination
  ): string {
    return subDest ? `${direction}:${operation}:${subDest}` : `${direction}:${operation}`;
  }
  
  // ============================================================
  // UTILITIES
  // ============================================================
  
  private getNestedValue(obj: any, path: string): any {
    // Handle special array syntax: values[latest], values[0], schedules[latest]
    const parts = path.split('.');
    
    return parts.reduce((current, key) => {
      if (!current) return undefined;
      
      // Handle array access like "values[latest]" or "values[0]"
      const arrayMatch = key.match(/^(\w+)\[(\w+)\]$/);
      if (arrayMatch) {
        const [, arrayName, index] = arrayMatch;
        const array = current[arrayName];
        
        if (!Array.isArray(array) || array.length === 0) {
          return undefined;
        }
        
        if (index === 'latest') {
          // Get the entry with the most recent window_from timestamp
          // This is critical for parameter files where entries can be added out of order
          const sortedByTime = array.slice().sort((a, b) => {
            const timeA = a.window_from ? new Date(a.window_from).getTime() : 0;
            const timeB = b.window_from ? new Date(b.window_from).getTime() : 0;
            return timeB - timeA; // Most recent first
          });
          return sortedByTime[0];
        } else {
          const numIndex = parseInt(index, 10);
          return isNaN(numIndex) ? undefined : array[numIndex];
        }
      }
      
      return current[key];
    }, obj);
  }
  
  private setNestedValue(obj: any, path: string, value: any): void {
    const parts = path.split('.');
    const lastPart = parts.pop()!;
    
    // Navigate to parent
    let current = obj;
    for (const part of parts) {
      // Handle array access in path
      const arrayMatch = part.match(/^(\w+)\[(\w+)\]$/);
      if (arrayMatch) {
        const [, arrayName, index] = arrayMatch;
        if (!current[arrayName]) current[arrayName] = [];
        
        if (index === 'latest') {
          // Access latest element
          const array = current[arrayName];
          if (array.length === 0) {
            array.push({});
          }
          current = array[array.length - 1];
        } else {
          const numIndex = parseInt(index, 10);
          if (!isNaN(numIndex)) {
            const array = current[arrayName];
            while (array.length <= numIndex) {
              array.push({});
            }
            current = array[numIndex];
          }
        }
      } else {
        if (!current[part]) current[part] = {};
        current = current[part];
      }
    }
    
    // Set final value
    // Handle array append syntax: "values[]" or "schedules[]"
    if (lastPart.endsWith('[]')) {
      const arrayName = lastPart.slice(0, -2);
      if (!current[arrayName]) current[arrayName] = [];
      current[arrayName].push(value);
    } else {
      current[lastPart] = value;
    }
  }
  
  private recordUpdate(
    operation: Operation,
    direction: Direction,
    subDest: SubDestination | undefined,
    source: any,
    target: any
  ): void {
    this.auditLog.push({
      timestamp: new Date().toISOString(),
      operation,
      direction,
      subDestination: subDest,
      source: this.sanitizeForAudit(source),
      target: this.sanitizeForAudit(target)
    });
  }
  
  private sanitizeForAudit(data: any): any {
    // TODO: Remove sensitive data, limit size
    return JSON.parse(JSON.stringify(data));
  }
  
  public getAuditLog(): any[] {
    return [...this.auditLog];
  }
  
  public clearAuditLog(): void {
    this.auditLog = [];
  }
}

// ============================================================
// SINGLETON INSTANCE
// ============================================================

export const updateManager = new UpdateManager();

