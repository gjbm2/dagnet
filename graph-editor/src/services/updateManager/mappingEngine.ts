/**
 * Core mapping engine for UpdateManager.
 *
 * Extracted from UpdateManager.ts (Cluster G — applyMappings) as part of the
 * src-slimdown modularisation.
 *
 * This module is platform-agnostic — no browser imports. It can be used
 * server-side (e.g. webhook handler) without bundler or jsdom.
 */

import type { FieldMapping, UpdateOptions, UpdateResult } from './types';
import { getNestedValue, setNestedValue } from './nestedValueAccess';

/**
 * Apply field mappings from source to target, respecting override flags.
 *
 * This is a pure function: it reads from `source`, writes to `target` (unless
 * `validateOnly`), and returns an `UpdateResult` describing what happened.
 * It performs no I/O, no side effects, and makes no browser API calls.
 */
export async function applyMappings(
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
      // Get values first for logging
      const sourceValue = getNestedValue(source, mapping.sourceField);

      console.log('[UpdateManager.applyMappings] Processing mapping:', {
        sourceField: mapping.sourceField,
        targetField: mapping.targetField,
        sourceValue,
        hasCondition: !!mapping.condition,
        hasOverrideFlag: !!mapping.overrideFlag
      });

      // Check condition
      if (mapping.condition && !mapping.condition(source, target)) {
        console.log('[UpdateManager.applyMappings] SKIPPED - condition failed');
        continue;
      }

      // Back-compat: historically these mappings were gated on ignoreOverrideFlags.
      // New behaviour: enable them when caller opts into permission copying, without necessarily
      // bypassing override checks for value fields.
      const allowPermissionCopy = options.allowPermissionFlagCopy === true || options.ignoreOverrideFlags === true;
      if (mapping.requiresIgnoreOverrideFlags && !allowPermissionCopy) {
        console.log('[UpdateManager.applyMappings] SKIPPED - requiresIgnoreOverrideFlags (permission copy not enabled)');
        continue;
      }

      // Check override flag (unless explicitly bypassed by caller)
      if (!options.ignoreOverrideFlags && mapping.overrideFlag) {
        const isOverridden = getNestedValue(target, mapping.overrideFlag);
        if (isOverridden) {
          console.log('[UpdateManager.applyMappings] SKIPPED - overridden flag set');
          result.conflicts!.push({
            field: mapping.targetField,
            currentValue: getNestedValue(target, mapping.targetField),
            newValue: sourceValue,
            reason: 'overridden'
          });
          continue; // Skip overridden fields
        }
      }

      const currentValue = getNestedValue(target, mapping.targetField);

      // Transform if needed
      const newValue = mapping.transform
        ? mapping.transform(sourceValue, source, target)
        : sourceValue;

      // Skip if no usable data (undefined means "can't calculate, don't update")
      if (newValue === undefined) {
        console.log('[UpdateManager.applyMappings] SKIPPED - newValue is undefined');
        continue;
      }

      // Check for changes
      if (newValue !== currentValue) {
        console.log('[UpdateManager.applyMappings] APPLYING change:', {
          targetField: mapping.targetField,
          oldValue: currentValue,
          newValue
        });

        if (!options.validateOnly) {
          setNestedValue(target, mapping.targetField, newValue);
        }

        result.changes!.push({
          field: mapping.targetField,
          oldValue: currentValue,
          newValue: newValue,
          source: 'auto',
          overridden: false
        });
      } else {
        console.log('[UpdateManager.applyMappings] SKIPPED - no change (same value)');
      }
    } catch (error) {
      console.error('[UpdateManager.applyMappings] ERROR:', {
        sourceField: mapping.sourceField,
        targetField: mapping.targetField,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });

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

  console.log('[UpdateManager.applyMappings] FINAL RESULT:', {
    success: result.success,
    changesCount: result.changes?.length,
    errorsCount: result.errors?.length,
    errors: result.errors
  });

  return result;
}
