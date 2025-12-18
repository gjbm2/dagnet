export function downloadTextFile(args: { filename: string; content: string; mimeType: string }): void {
  const blob = new Blob([args.content], { type: args.mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = args.filename;
  a.click();
  URL.revokeObjectURL(url);
}


