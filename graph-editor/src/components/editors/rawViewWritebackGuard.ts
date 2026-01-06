export type RawViewWritebackGuardParams = {
  readonly: boolean;
  tabId?: string;
  activeTabId?: string | null;
};

/**
 * RawView writeback guard
 *
 * The raw editor must NEVER write back to FileRegistry unless it is the *active* rc-dock tab.
 * This prevents background RawView tabs (including diff view) from overwriting newer edits
 * due to Monaco model churn, rebase, or programmatic updates.
 */
export function canRawViewWriteBack(params: RawViewWritebackGuardParams): boolean {
  const { readonly, tabId, activeTabId } = params;
  if (readonly) return false;
  if (!tabId) return false;
  return activeTabId === tabId;
}


