/**
 * Helper function to apply field changes to a target object.
 *
 * Handles nested field paths (e.g., "p.mean"),
 * array append syntax (e.g., "values[]"),
 * and array index syntax (e.g., "values[0]").
 *
 * Extracted from dataOperationsService.ts during slimdown.
 */

export function applyChanges(target: any, changes: Array<{ field: string; newValue: any }>): void {
  // Regex to match array access: fieldName[index] or fieldName[]
  const arrayAccessRegex = /^(.+)\[(\d*)\]$/;

  for (const change of changes) {
    console.log('[applyChanges] Applying change:', {
      field: change.field,
      newValue: change.newValue,
      'target.p BEFORE': JSON.stringify(target.p)
    });

    const parts = change.field.split('.');
    let obj: any = target;

    // Navigate to the nested object
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      const arrayMatch = part.match(arrayAccessRegex);

      if (arrayMatch) {
        const [, arrayName, indexStr] = arrayMatch;
        if (!obj[arrayName]) {
          console.log(`[applyChanges] Creating new array at ${arrayName}`);
          obj[arrayName] = [];
        }
        if (indexStr === '') {
          // Empty brackets - don't navigate into array for intermediate paths
          obj = obj[arrayName];
        } else {
          // Specific index - navigate to that element
          const index = parseInt(indexStr, 10);
          if (!obj[arrayName][index]) {
            obj[arrayName][index] = {};
          }
          obj = obj[arrayName][index];
        }
      } else {
        if (!obj[part]) {
          console.log(`[applyChanges] Creating new object at ${part}`);
          obj[part] = {};
        }
        obj = obj[part];
      }
    }

    // Set the final value
    const finalPart = parts[parts.length - 1];
    const finalArrayMatch = finalPart.match(arrayAccessRegex);

    if (finalArrayMatch) {
      const [, arrayName, indexStr] = finalArrayMatch;
      if (!obj[arrayName]) {
        console.log(`[applyChanges] Creating new array at ${arrayName}`);
        obj[arrayName] = [];
      }

      if (indexStr === '') {
        // Array append: push the new value
        console.log(`[applyChanges] Appending to array ${arrayName}`);
        obj[arrayName].push(change.newValue);
      } else {
        // Array index: set at specific position
        const index = parseInt(indexStr, 10);
        console.log(`[applyChanges] Setting array ${arrayName}[${index}]`);
        obj[arrayName][index] = change.newValue;
      }
    } else {
      // Regular field set
      obj[finalPart] = change.newValue;
    }

    console.log('[applyChanges] After change:', {
      'target.p AFTER': JSON.stringify(target.p)
    });
  }
}
