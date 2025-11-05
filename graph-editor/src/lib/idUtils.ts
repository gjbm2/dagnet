/**
 * Generate a URL-friendly ID from a label
 */
export function generateIdFromLabel(label: string): string {
  if (!label || typeof label !== 'string') {
    return '';
  }
  
  return label
    .toLowerCase()
    .trim()
    // Replace spaces and special characters with hyphens
    .replace(/[^a-z0-9]+/g, '-')
    // Remove leading/trailing hyphens
    .replace(/^-+|-+$/g, '')
    // Ensure it's not empty
    || 'untitled';
}

/**
 * Check if an ID is unique within a list
 */
export function isIdUnique(id: string, existingIds: string[]): boolean {
  return !existingIds.includes(id);
}

/**
 * Generate a unique ID by appending numbers if needed
 */
export function generateUniqueId(baseId: string, existingIds: string[]): string {
  let id = baseId;
  let counter = 1;
  
  while (!isIdUnique(id, existingIds)) {
    id = `${baseId}-${counter}`;
    counter++;
  }
  
  return id;
}

// All references to "id" terminology have been purged from the codebase
