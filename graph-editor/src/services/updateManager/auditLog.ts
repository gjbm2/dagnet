/**
 * Audit trail / logging helpers for UpdateManager.
 *
 * Extracted from UpdateManager.ts (Cluster J) as part of the src-slimdown
 * modularisation.  These functions are platform-agnostic — no browser imports.
 */

import type { Operation, Direction, SubDestination } from './types';

/**
 * Deep-clone `data` for safe inclusion in the audit log (no shared references).
 */
export function sanitizeForAudit(data: any): any {
  // TODO: Remove sensitive data, limit size
  return JSON.parse(JSON.stringify(data));
}

/**
 * Build an audit-log entry for a completed mapping operation.
 */
export function buildAuditEntry(
  operation: Operation,
  direction: Direction,
  subDest: SubDestination | undefined,
  source: any,
  target: any
): {
  timestamp: string;
  operation: Operation;
  direction: Direction;
  subDestination: SubDestination | undefined;
  source: any;
  target: any;
} {
  return {
    timestamp: new Date().toISOString(),
    operation,
    direction,
    subDestination: subDest,
    source: sanitizeForAudit(source),
    target: sanitizeForAudit(target),
  };
}
