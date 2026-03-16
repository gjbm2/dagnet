/**
 * UpdateManager types and interfaces.
 *
 * Extracted from UpdateManager.ts (Cluster A) as part of the src-slimdown
 * modularisation.  These types are platform-agnostic — no browser imports.
 */

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

  /**
   * If true, do NOT honour target-side override flags when applying mappings.
   *
   * Intended for explicit user actions where copying between persistence domains is the point:
   * - graph → file ("Put to file")
   * - file → graph ("Get from file")
   *
   * Automated/background flows should leave this false and respect override flags.
   */
  ignoreOverrideFlags?: boolean;

  /**
   * If true, enable mappings that copy permission flags (override flags) across domains.
   *
   * This is intentionally separate from `ignoreOverrideFlags`:
   * - `ignoreOverrideFlags` bypasses override checks (force overwrite)
   * - `allowPermissionFlagCopy` only enables the *_overridden field mappings
   */
  allowPermissionFlagCopy?: boolean;

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
  /** If true, this mapping only runs when caller explicitly opts in via UpdateOptions.ignoreOverrideFlags */
  requiresIgnoreOverrideFlags?: boolean;
}

export interface MappingConfiguration {
  direction: Direction;
  operation: Operation;
  subDestination?: SubDestination;
  mappings: FieldMapping[];
}
