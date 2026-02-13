/**
 * resolveConnection — resolve connection inheritance (`extends`).
 *
 * When a ConnectionDefinition has `extends: "parent-name"`, this function:
 * 1. Finds the parent in the connection list.
 * 2. Deep-merges `defaults` (parent first, child overrides).
 * 3. Atomic-replaces `adapter` and `capabilities` (child wins entirely if present).
 * 4. For all other scalar fields: child wins if present, otherwise parent value.
 * 5. Strips `extends` from the result.
 *
 * Constraints:
 * - One level only: no chains (A extends B extends C).
 * - Self-reference is an error.
 * - Missing parent is an error.
 */

import type { ConnectionDefinition } from './types';

/**
 * Deep-merge two plain objects. `child` values override `parent`.
 * Arrays are replaced (not concatenated). Nested objects are recursively merged.
 */
function deepMergeDefaults(
  parent: Record<string, unknown>,
  child: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...parent };

  for (const key of Object.keys(child)) {
    const parentVal = parent[key];
    const childVal = child[key];

    if (
      childVal !== null &&
      typeof childVal === 'object' &&
      !Array.isArray(childVal) &&
      parentVal !== null &&
      typeof parentVal === 'object' &&
      !Array.isArray(parentVal)
    ) {
      // Both are plain objects — recurse
      result[key] = deepMergeDefaults(
        parentVal as Record<string, unknown>,
        childVal as Record<string, unknown>
      );
    } else {
      // Child wins (scalars, arrays, nulls, type mismatches)
      result[key] = childVal;
    }
  }

  return result;
}

/**
 * Resolve a single connection by name, applying inheritance if `extends` is present.
 *
 * @param name - The connection name to resolve.
 * @param allConnections - All raw (unresolved) connections from the file.
 * @returns A fully-resolved ConnectionDefinition with `extends` stripped.
 * @throws if the connection is not found, extends a missing parent, extends itself,
 *         or extends a connection that also has `extends` (no chains).
 */
export function resolveConnection(
  name: string,
  allConnections: ConnectionDefinition[]
): ConnectionDefinition {
  const connection = allConnections.find((c) => c.name === name);
  if (!connection) {
    const available = allConnections.map((c) => c.name).join(', ') || 'none';
    throw new Error(`Connection "${name}" not found. Available connections: ${available}`);
  }

  if (!connection.extends) {
    return connection;
  }

  // Validate: no self-reference
  if (connection.extends === name) {
    throw new Error(
      `Connection "${name}" extends itself. Self-referencing inheritance is not allowed.`
    );
  }

  // Find parent
  const parent = allConnections.find((c) => c.name === connection.extends);
  if (!parent) {
    const available = allConnections.map((c) => c.name).join(', ') || 'none';
    throw new Error(
      `Connection "${name}" extends "${connection.extends}", but that connection was not found. Available connections: ${available}`
    );
  }

  // Validate: no chains
  if (parent.extends) {
    throw new Error(
      `Connection "${name}" extends "${parent.name}", which itself extends "${parent.extends}". ` +
      `Inheritance chains are not supported — a connection may only extend a concrete (non-extending) connection.`
    );
  }

  // Build resolved connection: start with parent, overlay child
  const resolved: Record<string, unknown> = {};

  // Copy all parent fields first
  for (const key of Object.keys(parent)) {
    if (key === 'extends') continue;
    (resolved as any)[key] = (parent as any)[key];
  }

  // Overlay child fields
  for (const key of Object.keys(connection)) {
    if (key === 'extends') continue;

    const childVal = (connection as any)[key];
    if (childVal === undefined) continue;

    if (key === 'defaults') {
      // Deep merge defaults
      resolved.defaults = deepMergeDefaults(
        (parent.defaults || {}) as Record<string, unknown>,
        childVal as Record<string, unknown>
      );
    } else {
      // All other fields: child wins (atomic replace for adapter, capabilities, etc.)
      resolved[key] = childVal;
    }
  }

  return resolved as unknown as ConnectionDefinition;
}

/**
 * Resolve all connections in a list, applying inheritance.
 *
 * @param allConnections - All raw connections from the file.
 * @returns A new array of fully-resolved ConnectionDefinitions.
 */
export function resolveAllConnections(
  allConnections: ConnectionDefinition[]
): ConnectionDefinition[] {
  return allConnections.map((c) => resolveConnection(c.name, allConnections));
}
