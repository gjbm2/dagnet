/**
 * Copy text to clipboard with fallback for non-secure contexts (e.g. HTTP on LAN IP).
 *
 * Tries `navigator.clipboard.writeText` first; if that's unavailable or fails,
 * falls back to a temporary textarea + `document.execCommand('copy')`.
 *
 * Returns `true` on success, `false` on failure.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // Try modern Clipboard API first
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to legacy fallback
    }
  }

  // Legacy fallback — works in non-secure contexts
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    // Off-screen so it doesn't flash
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}
