/**
 * Slice key canonicalisation for *matching* purposes.
 *
 * Slice keys are constraint-only DSL strings (a dot-chain of function calls).
 * Constraint semantics are order-independent, so we normalise into a canonical form
 * that is stable across equivalent strings.
 *
 * IMPORTANT:
 * - This is for MATCHING ONLY (e.g. DB slice-family selection), not for display.
 * - `window(...)` / `cohort(...)` arguments are not part of identity for reads; they
 *   are stripped to `window()` / `cohort()`.
 */
export type SliceKeyCanonicaliseOptions = {
  /**
   * If true (default), place mode clauses (`window()` / `cohort()`) at the end.
   * This makes `cohort().context(a:x)` canonicalise to `context(a:x).cohort()`.
   */
  modeLast?: boolean;
};

type Clause = { name: string; args: string };

const MODE_CLAUSES_LOWER = new Set(['window', 'cohort']);

function canonicalClauseName(nameLower: string): string {
  const n = String(nameLower || '').trim().toLowerCase();
  if (n === 'at') return 'asat';
  if (n === 'contextany') return 'contextAny';
  if (n === 'visitedany') return 'visitedAny';
  return n;
}

function splitTopLevelArgs(args: string): string[] {
  // Slice-key grammar forbids nested parentheses in args, so a simple split is safe.
  return String(args || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function normaliseClauseArgs(nameRaw: string, argsRaw: string): string {
  const name = String(nameRaw || '').trim().toLowerCase();
  const args = String(argsRaw || '').trim();

  // Strip temporal args from mode clauses.
  if (MODE_CLAUSES_LOWER.has(name)) return '';

  if (name === 'context' || name === 'case') {
    // context(key:value) or context(key)
    const a = args.trim();
    if (!a) return '';
    const i = a.indexOf(':');
    if (i < 0) return a.trim();
    const key = a.slice(0, i).trim();
    const value = a.slice(i + 1).trim();
    return value ? `${key}:${value}` : key;
  }

  if (name === 'contextany') {
    // contextAny(k:v, k:v, ...) — order-insensitive; canonicalise pairs.
    const pairs = splitTopLevelArgs(args)
      .map((t) => {
        const i = t.indexOf(':');
        if (i < 0) return { key: t.trim(), value: '' };
        return { key: t.slice(0, i).trim(), value: t.slice(i + 1).trim() };
      })
      .filter((p) => p.key);

    // Deduplicate and sort for stable canonical form.
    const uniq = new Map<string, { key: string; value: string }>();
    for (const p of pairs) uniq.set(`${p.key}\u0000${p.value}`, p);
    return Array.from(uniq.values())
      .sort((a, b) => (a.key === b.key ? a.value.localeCompare(b.value) : a.key.localeCompare(b.key)))
      .map((p) => (p.value ? `${p.key}:${p.value}` : p.key))
      .join(',');
  }

  // Generic list canonicalisation for any other clause types we may see in slice keys.
  // This matches the DSL's order-independence/idempotence properties for node/key lists.
  const toks = splitTopLevelArgs(args);
  if (toks.length <= 1) return toks[0] ?? '';
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of toks) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  out.sort((a, b) => a.localeCompare(b));
  return out.join(',');
}

function parseSliceKeyClauses(s: string): Clause[] | null {
  const raw = String(s || '').trim().replace(/^\.+|\.+$/g, '');
  if (!raw) return [];

  // Match a dot-chain of clauses: name(args)
  // Args are disallowed from containing parentheses by DSL validators, so this is safe.
  const re = /(?:^|\.)([a-zA-Z_-]+)\(([^()]*)\)/g;
  const clauses: Clause[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    clauses.push({ name: String(m[1] || ''), args: String(m[2] || '') });
  }
  if (clauses.length === 0) return null;
  return clauses;
}

function canonicalClauseString(nameRaw: string, argsNorm: string): string {
  // nameRaw is already canonicalised for casing (e.g. contextAny, visitedAny).
  const name = String(nameRaw || '').trim();
  const a = String(argsNorm || '').trim();
  return `${name}(${a})`;
}

/**
 * Canonicalise a slice key for *matching*.
 *
 * Examples:
 * - `context(channel:google).cohort(1-Oct-25:2-Oct-25)` → `context(channel:google).cohort()`
 * - `cohort().context(channel:google)` → `context(channel:google).cohort()`
 */
export function canonicaliseSliceKeyForMatching(
  sliceKey: string,
  options?: SliceKeyCanonicaliseOptions
): string {
  const modeLast = options?.modeLast !== false;
  const s = String(sliceKey || '').trim();
  if (!s) return '';

  const clauses = parseSliceKeyClauses(s);
  if (!clauses) {
    // No DSL clauses found — preserve the raw string as-is.
    // This handles sentinel values like "__epoch_gap__" which are not DSL
    // but must survive as literal slice_key matchers (not collapse to "").
    return s;
  }

  const canonicalised = clauses
    .map((c) => {
      const nameRaw = String(c.name || '').trim();
      const nameLower = nameRaw.toLowerCase();
      const nameCanon = canonicalClauseName(nameLower); // sugar + casing → canonical
      const argsNorm = normaliseClauseArgs(nameLower, c.args);
      return {
        nameLower,
        nameCanon,
        argsNorm,
        canon: canonicalClauseString(nameCanon, argsNorm),
      };
    })
    .filter((c) => c.nameCanon);

  // Partition mode clauses (cohort/window) and "dims/filters".
  const mode = canonicalised.filter((c) => MODE_CLAUSES_LOWER.has(c.nameLower));
  const rest = canonicalised.filter((c) => !MODE_CLAUSES_LOWER.has(c.nameLower));

  // Dedupe by canonical clause string (idempotence).
  const dedupe = (arr: Array<{ canon: string }>) => Array.from(new Set(arr.map((x) => x.canon)));
  const restCanon = dedupe(rest);
  const modeCanon = dedupe(mode);

  // Canonical order: sort non-mode clauses; optionally append mode last.
  restCanon.sort((a, b) => a.localeCompare(b));
  const out = modeLast
    ? restCanon.concat(modeCanon.sort())
    : restCanon.concat(modeCanon).sort((a, b) => a.localeCompare(b));

  return out.join('.');
}

/**
 * Back-compat alias used across services.
 */
export function normaliseSliceKeyForMatching(sliceKey: string): string {
  return canonicaliseSliceKeyForMatching(sliceKey);
}

