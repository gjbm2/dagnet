import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from 'lz-string';
import pako from 'pako';
import { buildStaticShareUrl, ShareLinkIdentity } from '../services/shareLinkService';

// Make libraries available globally for browser access
const initializeLibraries = () => {
  if (typeof window !== 'undefined') {
    (window as any).LZString = { compressToEncodedURIComponent, decompressFromEncodedURIComponent };
    (window as any).pako = pako;
  }
};

// Initialize libraries immediately
initializeLibraries();

/**
 * Encode graph state to a shareable URL.
 * 
 * @param graph - Graph data to encode
 * @param identity - Optional identity metadata for upgrade-to-live support
 * @returns Shareable URL string
 * 
 * @deprecated Prefer using shareLinkService.buildStaticShareUrl() directly for new code.
 *             This function is kept for backwards compatibility.
 */
export function encodeStateToUrl(graph: any, identity?: ShareLinkIdentity): string {
  return buildStaticShareUrl({
    graphData: graph,
    identity,
  });
}

export function decodeStateFromUrl(): any | null {
  const data = new URLSearchParams(window.location.search).get('data');
  if (!data) return null;
  
  try {
    // First try LZ-string decompression (original format)
    const decompressed = decompressFromEncodedURIComponent(data);
    if (decompressed) {
      return JSON.parse(decompressed);
    }
  } catch (e) {
    console.log('LZ-string decompression failed, trying Apps Script compression...');
  }
  
  try {
    // Try Apps Script gzip compression format (base64 + gzip)
    const decoded = atob(data);
    const bytes = new Uint8Array(decoded.split('').map(c => c.charCodeAt(0)));
    const decompressed = pako.inflate(bytes, { to: 'string' });
    return JSON.parse(decompressed);
  } catch (e) {
    console.log('Apps Script gzip decompression failed, trying plain JSON...');
  }
  
  try {
    // Fallback: try plain JSON (for Apps Script integration)
    const decoded = decodeURIComponent(data);
    return JSON.parse(decoded);
  } catch (e) {
    console.log('Plain JSON parsing failed:', e);
    return null;
  }
}
