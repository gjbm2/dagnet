import { fileRegistry } from '../contexts/TabContext';
import type { TabState } from '../types';

const FILE_ID = 'signature-links';

export class SignatureLinksTabService {
  private static instance: SignatureLinksTabService;

  static getInstance(): SignatureLinksTabService {
    if (!SignatureLinksTabService.instance) {
      SignatureLinksTabService.instance = new SignatureLinksTabService();
    }
    return SignatureLinksTabService.instance;
  }

  async openSignatureLinksTab(): Promise<string | null> {
    try {
      const timestamp = Date.now();

      // Ensure file exists (temporary/non-git)
      const existing = fileRegistry.getFile(FILE_ID);
      if (!existing) {
        await fileRegistry.getOrCreateFile(
          FILE_ID,
          'signature-links' as any,
          { repository: 'temporary', path: 'signature-links', branch: 'main' },
          {}
        );
      }

      const file = fileRegistry.getFile(FILE_ID);
      if (file && Array.isArray((file as any).viewTabs) && (file as any).viewTabs.length > 0) {
        const tabId = (file as any).viewTabs[0];
        window.dispatchEvent(new CustomEvent('dagnet:switchToTab', { detail: { tabId } }));
        return tabId;
      }

      const tabId = `tab-signature-links-${timestamp}`;
      const newTab: TabState = {
        id: tabId,
        fileId: FILE_ID,
        viewMode: 'interactive',
        title: 'Signature Links',
        icon: '',
        closable: true,
        group: 'main-content',
      };

      await fileRegistry.addViewTab(FILE_ID, tabId);
      window.dispatchEvent(new CustomEvent('dagnet:openTemporaryTab', { detail: { tab: newTab } }));

      return tabId;
    } catch (error) {
      console.error('[SignatureLinksTabService] Failed to open Signature Links tab:', error);
      return null;
    }
  }
}

export const signatureLinksTabService = SignatureLinksTabService.getInstance();

