import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from 'lz-string';
export function encodeStateToUrl(graph) {
    const base = window.location.origin + window.location.pathname;
    const data = compressToEncodedURIComponent(JSON.stringify(graph));
    return `${base}?data=${data}`;
}
export function decodeStateFromUrl() {
    const data = new URLSearchParams(window.location.search).get('data');
    if (!data)
        return null;
    try {
        // First try LZ-string decompression (original format)
        const decompressed = decompressFromEncodedURIComponent(data);
        if (decompressed) {
            return JSON.parse(decompressed);
        }
    }
    catch (e) {
        console.log('LZ-string decompression failed, trying plain JSON...');
    }
    try {
        // Fallback: try plain JSON (for Apps Script integration)
        const decoded = decodeURIComponent(data);
        return JSON.parse(decoded);
    }
    catch (e) {
        console.log('Plain JSON parsing failed:', e);
        return null;
    }
}
