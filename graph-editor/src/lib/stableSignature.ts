/**
 * Stable signature helpers
 *
 * Purpose:
 * - Provide a canonical JSON stringification for dependency stamps (stable key ordering).
 * - Provide a lightweight non-cryptographic hash for quick equality checks.
 *
 * Notes:
 * - This is intentionally not cryptographic; it is used only for staleness signatures.
 * - Output is stable across runs for semantically identical stamp objects.
 */

export function stableStringify(value: any): string {
  const seen = new WeakSet<object>();

  const norm = (v: any): any => {
    if (v === null) return null;
    if (v === undefined) return undefined;

    const t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean') return v;
    if (t === 'bigint') return v.toString();

    if (Array.isArray(v)) return v.map(norm);

    if (t === 'object') {
      if (seen.has(v)) return '[Circular]';
      seen.add(v);
      const keys = Object.keys(v).sort();
      const out: any = {};
      for (const k of keys) out[k] = norm(v[k]);
      return out;
    }

    // function / symbol
    return String(v);
  };

  return JSON.stringify(norm(value));
}

export function fnv1a32(input: string): string {
  // FNV-1a 32-bit
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}






