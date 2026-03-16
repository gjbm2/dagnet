/**
 * Shared types for data operations modules.
 *
 * Extracted from dataOperationsService.ts to avoid circular imports
 * between the facade and its extracted modules.
 */

export type PermissionCopyMode = 'copy_all' | 'copy_if_false' | 'do_not_copy';

export interface PutToFileCopyOptions {
  includeValues?: boolean;
  includeMetadata?: boolean;
  permissionsMode?: PermissionCopyMode;
}

export interface GetFromFileCopyOptions {
  /**
   * If true, copy scalar/value fields from file → graph.
   * Default true for explicit GET.
   */
  includeValues?: boolean;
  /**
   * If true, copy metadata/config fields from file → graph (query/connection/latency config/etc).
   * Default true for explicit GET.
   */
  includeMetadata?: boolean;
  /**
   * Controls copying of permission flags (override flags) from file → graph.
   * Default do_not_copy to avoid unexpected permission changes.
   */
  permissionsMode?: PermissionCopyMode;
}
