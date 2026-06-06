/**
 * chartQueryLabel — builds the per-scenario "name · full query" lines used to
 * make a chart self-describing where surrounding context is missing (standalone
 * chart tab banner and exported PNG/SVG).
 *
 * A layer's full query is split across two stored fields:
 *   - the PATH lives once on the recipe: `analytics_dsl` = `from(a).to(b)`
 *   - the SCOPE lives per layer: `scenarios[].effective_dsl` =
 *     `window(...)` / `cohort(...)` / `context(...)` / `asat(...)` (no path)
 * Neither alone is the whole query, so we combine them per layer — otherwise the
 * banner shows the scope but loses `from`/`to` (or vice-versa).
 */

export interface ScenarioQueryLineArgs {
  /** Visible scenario/layer ids, in display order. */
  visibleScenarioIds?: string[];
  /** scenario_id → metadata (we use `name`). */
  scenarioNameById?: Record<string, { name?: string } | undefined>;
  /** scenario_id → its scope DSL (window/cohort/context/asat) — recipe effective_dsl. */
  scopeDslById?: Record<string, string> | undefined;
  /** Shared path DSL (from/to) — recipe analytics_dsl. */
  pathDsl?: string;
}

/**
 * Drop an empty `asat()` clause (and its dangling dot). A blank `asat()` is the
 * "no as-at date" form — noise in a human-facing label, not a real constraint.
 */
export function stripBlankAsat(dsl: string): string {
  return dsl
    .replace(/\basat\(\s*\)/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+|\.+$/g, '');
}

/**
 * Combine a layer's scope DSL with the shared path DSL into one query string.
 * Scope leads (matching how the query reads: "in this window, this funnel").
 * The two fields are disjoint by construction, but if a scope DSL already
 * carries the path we leave it alone rather than duplicate `from`/`to`.
 * A blank `asat()` is stripped so it never reaches the label.
 */
export function combineQueryDsl(pathDsl: string | undefined, scopeDsl: string | undefined): string {
  const path = (pathDsl ?? '').trim();
  const scope = (scopeDsl ?? '').trim();
  let result: string;
  if (!scope) result = path;
  else if (!path) result = scope;
  else if (scope.includes('from(')) result = scope;
  else result = `${scope}.${path}`;
  return stripBlankAsat(result);
}

/**
 * One line per visible layer: `name · <scope.path>` (or just `name` if neither
 * DSL is known). Returns an empty array only when there is nothing to describe.
 */
export function buildScenarioQueryLines(args: ScenarioQueryLineArgs): string[] {
  const ids = args.visibleScenarioIds ?? [];
  const path = (args.pathDsl ?? '').trim();
  const lines: string[] = [];

  for (const id of ids) {
    const name = args.scenarioNameById?.[id]?.name?.trim() || id;
    const full = combineQueryDsl(path, args.scopeDslById?.[id]);
    lines.push(full ? `${name} · ${full}` : name);
  }

  if (lines.length === 0 && path) lines.push(path);
  return lines;
}
