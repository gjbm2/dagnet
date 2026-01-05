import { useEffect } from 'react';

/**
 * Bridge: allows non-GraphEditor UI (e.g. global menus/modals) to request the
 * existing "Put to Base" operation without duplicating scenario logic.
 *
 * IMPORTANT:
 * - This is tab-scoped. The request includes a tabId, and only the matching
 *   GraphEditor instance should handle it.
 * - Menus/modals remain access points: they dispatch the request; GraphEditor
 *   owns the actual Put to Base implementation via ScenariosContext.
 */
export const PUT_TO_BASE_REQUEST_EVENT = 'dagnet:requestPutToBase';

export function requestPutToBase(tabId: string): void {
  window.dispatchEvent(new CustomEvent(PUT_TO_BASE_REQUEST_EVENT, { detail: { tabId } }));
}

export function usePutToBaseRequestListener(tabId: string | undefined, onRequest: () => void): void {
  useEffect(() => {
    if (!tabId) return;

    const handler = (e: Event) => {
      const detail = (e as CustomEvent)?.detail as { tabId?: string } | undefined;
      if (!detail?.tabId) return;
      if (detail.tabId !== tabId) return;
      onRequest();
    };

    window.addEventListener(PUT_TO_BASE_REQUEST_EVENT, handler as EventListener);
    return () => window.removeEventListener(PUT_TO_BASE_REQUEST_EVENT, handler as EventListener);
  }, [tabId, onRequest]);
}


