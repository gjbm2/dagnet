import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from 'lz-string';
import pako from 'pako';

export function encodeStateToUrl(graph: any): string {
  const base = window.location.origin + window.location.pathname;
  const data = compressToEncodedURIComponent(JSON.stringify(graph));
  return `${base}?data=${data}`;
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
    // Try Apps Script compression format (base64 + gzip)
    const decoded = atob(data);
    const bytes = new Uint8Array(decoded.split('').map(c => c.charCodeAt(0)));
    const decompressed = pako.inflate(bytes, { to: 'string' });
    return JSON.parse(decompressed);
  } catch (e) {
    console.log('Apps Script compression failed, trying plain JSON...');
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
