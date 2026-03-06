import { fileRegistry } from '../contexts/TabContext';

export const FAVOURITE_TAG = '_favourite';

/**
 * Toggle the `_favourite` tag on a file.
 * Works for all file types: graphs store tags at `metadata.tags`,
 * everything else at `data.tags`.
 */
export function toggleFavourite(fileId: string): boolean {
  const file = fileRegistry.getFile(fileId);
  if (!file) return false;

  const data = { ...(file.data as any) };
  const isGraph = file.type === 'graph';

  const currentTags: string[] = isGraph
    ? (data.metadata?.tags ?? [])
    : (data.tags ?? []);

  const isFav = currentTags.includes(FAVOURITE_TAG);
  const newTags = isFav
    ? currentTags.filter((t: string) => t !== FAVOURITE_TAG)
    : [...currentTags, FAVOURITE_TAG];

  if (isGraph) {
    data.metadata = { ...(data.metadata || {}), tags: newTags };
  } else {
    data.tags = newTags;
  }

  fileRegistry.updateFile(fileId, data);

  // Nudge navigator to re-render (updateFile only fires the dirty-changed
  // event when isDirty actually transitions; tags-only edits on an
  // already-dirty file would otherwise be invisible to the navigator).
  window.dispatchEvent(new CustomEvent('dagnet:fileDirtyChanged', {
    detail: { fileId, isDirty: true }
  }));

  return !isFav;
}

/** Check whether a tag array contains the favourite marker. */
export function isFavourite(tags?: string[]): boolean {
  return tags?.includes(FAVOURITE_TAG) ?? false;
}

/** Filter out system tags (underscore-prefixed) from a tag list. */
export function filterSystemTags(tags: string[]): string[] {
  return tags.filter(t => !t.startsWith('_'));
}
