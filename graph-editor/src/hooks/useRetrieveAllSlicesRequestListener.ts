import { useEffect } from 'react';

/**
 * Bridge: allows non-menu callers (e.g. safety nudges) to request opening the
 * existing "Retrieve All Slices" flow without duplicating UI logic.
 *
 * Menus remain access points: they own rendering the modals and call this hook
 * to wire an event → initiateRetrieveAllSlices().
 */
export const RETRIEVE_ALL_SLICES_REQUEST_EVENT = 'dagnet:requestRetrieveAllSlices';

export function requestRetrieveAllSlices(): void {
  window.dispatchEvent(new CustomEvent(RETRIEVE_ALL_SLICES_REQUEST_EVENT));
}

export function useRetrieveAllSlicesRequestListener(onRequest: () => void): void {
  useEffect(() => {
    const handler = () => onRequest();
    window.addEventListener(RETRIEVE_ALL_SLICES_REQUEST_EVENT, handler as EventListener);
    return () => window.removeEventListener(RETRIEVE_ALL_SLICES_REQUEST_EVENT, handler as EventListener);
  }, [onRequest]);
}


