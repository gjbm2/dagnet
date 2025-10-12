import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from 'lz-string';

export function encodeStateToUrl(graph: any): string {
  const base = window.location.origin + window.location.pathname;
  const data = compressToEncodedURIComponent(JSON.stringify(graph));
  return `${base}?data=${data}`;
}

export function decodeStateFromUrl(): any | null {
  const data = new URLSearchParams(window.location.search).get('data');
  if (!data) return null;
  try { return JSON.parse(decompressFromEncodedURIComponent(data) || 'null'); }
  catch { return null; }
}
