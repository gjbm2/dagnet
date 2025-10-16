/**
 * Generate a URL-friendly slug from a label
 */
export function generateSlugFromLabel(label: string): string {
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
 * Check if a slug is unique within a list of nodes
 */
export function isSlugUnique(slug: string, existingSlugs: string[]): boolean {
  return !existingSlugs.includes(slug);
}

/**
 * Generate a unique slug by appending numbers if needed
 */
export function generateUniqueSlug(baseSlug: string, existingSlugs: string[]): string {
  let slug = baseSlug;
  let counter = 1;
  
  while (!isSlugUnique(slug, existingSlugs)) {
    slug = `${baseSlug}-${counter}`;
    counter++;
  }
  
  return slug;
}
