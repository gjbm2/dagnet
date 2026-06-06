export function downloadTextFile(args: { filename: string; content: string; mimeType: string }): void {
  const blob = new Blob([args.content], { type: args.mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = args.filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Trigger a browser download from a data URL (e.g. a rasterised PNG produced
 * via canvas.toDataURL). Unlike downloadTextFile this carries binary payloads
 * already encoded in the URL, so no Blob/object-URL round-trip is needed.
 */
export function downloadDataUrl(args: { filename: string; dataUrl: string }): void {
  const a = document.createElement('a');
  a.href = args.dataUrl;
  a.download = args.filename;
  a.click();
}


