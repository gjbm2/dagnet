/**
 * Nested value access utilities for UpdateManager.
 *
 * Extracted from UpdateManager.ts (Cluster I) as part of the src-slimdown
 * modularisation.  These functions are platform-agnostic — no browser imports.
 */

/**
 * Get a value from a nested object using dot-separated path notation.
 *
 * Supports special array syntax:
 *   - `values[latest]`  — element with the most recent `window_from`
 *   - `values[0]`       — numeric index access
 */
export function getNestedValue(obj: any, path: string): any {
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

/**
 * Set a value on a nested object using dot-separated path notation.
 *
 * Supports:
 *   - Array index access in intermediate segments (`values[latest]`, `values[0]`)
 *   - Array append syntax for the final segment (`values[]`, `schedules[]`)
 *   - Auto-creates intermediate objects/arrays as needed
 */
export function setNestedValue(obj: any, path: string, value: any): void {
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
