/**
 * Path-identity topology helper.
 *
 * An edge is "path-identity" iff the topology guarantees `path = edge` for
 * latency purposes — i.e. walking back from its `from_node` against the
 * graph, no upstream edge carries `latency_parameter === true`. A chain of
 * non-latency edges contributes no delay, so the path lag distribution
 * collapses to the edge's own lag distribution.
 *
 * Used by the Bayesian source-ledger writers (bayesPatchService,
 * posteriorSliceContexting, workspaceService migration) to fill in
 * `path_*` fields with edge-level values when the Bayes engine produced
 * no cohort fit and the topology proves the path is trivial. The engine's
 * own gate at `bayes/compiler/model.py:1103-1109` excludes single-latency
 * paths from cohort fitting with the documented invariant "path CDF = edge
 * CDF (no composition needed)"; this helper applies that invariant on the
 * FE so consumers always see a defined path projection for identity
 * edges, without conflating "identity by topology" with "no cohort
 * evidence on a real multi-latency path".
 */

/** Walk upstream from the edge's `from_node`. Identity iff no reachable
 *  upstream edge has `latency_parameter === true`. Cycle-safe via visited
 *  set. Returns false defensively when the edge can't be located. */
export function isPathIdentityEdge(graph: any, edgeId: string): boolean {
  const edges: any[] = Array.isArray(graph?.edges) ? graph.edges : [];
  const target = edges.find((e) => e?.id === edgeId);
  if (!target) return false;

  const incomingByNode = new Map<string, any[]>();
  for (const e of edges) {
    const to = e?.to_node;
    if (!to) continue;
    const list = incomingByNode.get(to);
    if (list) list.push(e);
    else incomingByNode.set(to, [e]);
  }

  const visited = new Set<string>();
  const queue: string[] = [];
  if (target.from_node) queue.push(target.from_node);

  while (queue.length > 0) {
    const node = queue.shift()!;
    if (visited.has(node)) continue;
    visited.add(node);
    const incoming = incomingByNode.get(node);
    if (!incoming) continue;
    for (const up of incoming) {
      if (up?.p?.latency?.latency_parameter === true) return false;
      if (up?.from_node) queue.push(up.from_node);
    }
  }
  return true;
}

/**
 * If `latencyBlock` exists, lacks `path_mu`, and the edge is topologically
 * path-identity, fill in path_* fields from the edge-level fields. Mirrors
 * the SD families too. Mutates `latencyBlock` in place.
 *
 * Noop when:
 *   - `latencyBlock` is undefined (no Bayes latency fit at all)
 *   - `path_mu` is already set (Bayes produced a cohort fit)
 *   - the edge is non-identity (real upstream latency exists; absence of
 *     path_* is honest "no cohort fit on a real path")
 */
export function applyPathIdentityFallback(
  latencyBlock: any | undefined,
  graph: any,
  edgeId: string,
): void {
  if (!latencyBlock) return;
  if (latencyBlock.path_mu !== undefined) return;
  if (!isPathIdentityEdge(graph, edgeId)) return;

  latencyBlock.path_mu = latencyBlock.mu;
  latencyBlock.path_sigma = latencyBlock.sigma;
  latencyBlock.path_t95 = latencyBlock.t95;
  latencyBlock.path_onset_delta_days = latencyBlock.onset_delta_days;
  if (latencyBlock.mu_sd !== undefined) latencyBlock.path_mu_sd = latencyBlock.mu_sd;
  if (latencyBlock.mu_sd_pred !== undefined) latencyBlock.path_mu_sd_pred = latencyBlock.mu_sd_pred;
  if (latencyBlock.sigma_sd !== undefined) latencyBlock.path_sigma_sd = latencyBlock.sigma_sd;
  if (latencyBlock.onset_sd !== undefined) latencyBlock.path_onset_sd = latencyBlock.onset_sd;
}
