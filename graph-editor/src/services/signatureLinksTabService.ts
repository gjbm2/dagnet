import { fileRegistry } from '../contexts/TabContext';
import type { TabState } from '../types';

const FILE_ID = 'hash-mappings';

/** Context passed when opening from a graph/edge/parameter entry point. */
export interface SignatureLinksContext {
  graphId?: string;
  graphName?: string;
  paramId?: string;
  /** Workspace-prefixed param_id for DB lookups */
  dbParamId?: string;
  /** The current core_hash, if already computed by the caller */
  currentCoreHash?: string;
  /** Prefer displaying cohort/window rows for the current DSL mode */
  desiredQueryMode?: 'cohort' | 'window';
  /** Which slot on the edge: 'p', 'cost_gbp', 'labour_cost', or 'conditional_p:N' */
  paramSlot?: string;
}

/** Singleton event name for passing context to the viewer component. */
export const SIG_LINKS_CONTEXT_EVENT = 'dagnet:sigLinksContext';

export class SignatureLinksTabService {
  private static instance: SignatureLinksTabService;
  private _pendingContext: SignatureLinksContext | null = null;

  static getInstance(): SignatureLinksTabService {
    if (!SignatureLinksTabService.instance) {
      SignatureLinksTabService.instance = new SignatureLinksTabService();
    }
    return SignatureLinksTabService.instance;
  }

  /** Get and consume any pending context (called by the viewer on mount). */
  consumeContext(): SignatureLinksContext | null {
    const ctx = this._pendingContext;
    this._pendingContext = null;
    return ctx;
  }

  async openSignatureLinksTab(context?: SignatureLinksContext): Promise<string | null> {
    try {
      const timestamp = Date.now();

      // Store context for the viewer to consume on mount
      this._pendingContext = context ?? null;

      // Ensure hash-mappings file exists (seeded at init or pulled from repo).
      // If somehow missing (e.g. fresh app before first pull), seed an empty one.
      const existing = fileRegistry.getFile(FILE_ID);
      if (!existing) {
        const { seedHashMappingsFile } = await import('../init/seedHashMappings');
        await seedHashMappingsFile();
      }

      // If the tab already exists, switch to it and push context via event
      const file = fileRegistry.getFile(FILE_ID);
      if (file && Array.isArray((file as any).viewTabs) && (file as any).viewTabs.length > 0) {
        const tabId = (file as any).viewTabs[0];
        window.dispatchEvent(new CustomEvent('dagnet:switchToTab', { detail: { tabId } }));
        // Push updated context to already-mounted viewer
        if (context) {
          window.dispatchEvent(new CustomEvent(SIG_LINKS_CONTEXT_EVENT, { detail: context }));
        }
        return tabId;
      }

      const tabId = `tab-signature-links-${timestamp}`;
      const newTab: TabState = {
        id: tabId,
        fileId: FILE_ID,
        viewMode: 'interactive',
        title: 'Snapshot Manager',
        icon: '',
        closable: true,
        group: 'main-content',
      };

      await fileRegistry.addViewTab(FILE_ID, tabId);
      window.dispatchEvent(new CustomEvent('dagnet:openTemporaryTab', { detail: { tab: newTab } }));

      return tabId;
    } catch (error) {
      console.error('[SignatureLinksTabService] Failed to open Snapshot Manager tab:', error);
      return null;
    }
  }
}

export const signatureLinksTabService = SignatureLinksTabService.getInstance();
