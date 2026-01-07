"""
Path Analysis Runner

Core probability and cost calculations for path analysis.
Implements the algorithms from pathAnalysis.ts in Python.

Design Reference: /docs/current/project-analysis/PHASE_1_DESIGN.md
"""

from typing import Any, Optional
from dataclasses import dataclass, field
import networkx as nx
import re

import logging

from .constraint_eval import evaluate_constraint_condition, parse_constraint_condition, constraint_specificity_score


@dataclass
class PathResult:
    """Result of path probability calculation."""
    probability: float
    expected_cost_gbp: float
    expected_labour_cost: float
    # Conditional costs: expected cost GIVEN that the end node is reached.
    # These are None when probability == 0 (undefined).
    expected_cost_gbp_given_success: Optional[float] = None
    expected_labour_cost_given_success: Optional[float] = None
    path_exists: bool = True
    intermediate_nodes: list[str] = field(default_factory=list)


@dataclass 
class PruningResult:
    """Result of graph pruning for visited constraints."""
    excluded_edges: set[tuple[str, str]]  # (source, target) tuples
    renorm_factors: dict[tuple[str, str], float]  # edge -> renorm factor


def _extract_tracked_human_ids(condition: str | None) -> set[str]:
    """
    Extract all node IDs referenced by a conditional_p condition string that require visit-state tracking.
    This includes:
    - visited(...)
    - exclude(...)
    - visitedAny(...)
    """
    try:
        parsed = parse_constraint_condition(condition)
    except Exception:
        return set()
    out: set[str] = set(parsed.visited)
    out.update(parsed.exclude)
    for g in parsed.visited_any:
        out.update(g)
    return out


def _graph_has_conditional_probabilities(G: nx.DiGraph) -> bool:
    for _, _, data in G.edges(data=True):
        cps = data.get('conditional_p') or []
        if cps:
            return True
    return False


def _get_tracked_human_ids(G: nx.DiGraph) -> set[str]:
    tracked: set[str] = set()
    for _, _, data in G.edges(data=True):
        for cp in (data.get('conditional_p') or []):
            cond = cp.get('condition') if isinstance(cp, dict) else None
            tracked |= _extract_tracked_human_ids(cond)
    return tracked


def _effective_edge_probability(
    edge_data: dict[str, Any],
    visited_human_ids: set[str],
) -> float:
    """
    Pick edge probability accounting for conditional_p (visited(...) only for now).
    If multiple conditions match, first match wins (mirrors TS runner behaviour).
    """
    cps = edge_data.get('conditional_p') or []
    if cps:
        best_score: Optional[int] = None
        best_p: Optional[float] = None
        for cp in cps:
            if not isinstance(cp, dict):
                continue
            cond = cp.get('condition')
            try:
                matches = evaluate_constraint_condition(cond, visited_nodes=visited_human_ids)
            except Exception:
                # Invalid/unsupported condition DSL: treat as non-match here.
                # (Any caller that explicitly activates conditional semantics should surface this separately.)
                logging.getLogger(__name__).warning(
                    "Unsupported or invalid conditional_p condition DSL encountered (treated as non-match): %r", cond
                )
                matches = False
            if matches:
                p = cp.get('p') or {}
                if isinstance(p, dict):
                    pv = float(p.get('mean') or 0.0)
                elif isinstance(p, (int, float)):
                    pv = float(p)
                else:
                    pv = 0.0

                try:
                    score = constraint_specificity_score(cond)
                except Exception:
                    score = 0

                if best_score is None or score > best_score:
                    best_score = score
                    best_p = pv
        if best_p is not None:
            return best_p
    return float(edge_data.get('p') or 0.0)


def _is_terminal_for_target(G: nx.DiGraph, node_key: str, target_key: str) -> bool:
    """Stop propagation once we hit the target, or any node with no outgoing edges."""
    if node_key == target_key:
        return True
    if G.out_degree(node_key) == 0:
        return True
    return False


def _calculate_path_probability_state_space(
    G: nx.DiGraph,
    start_key: str,
    end_key: str,
    pruning: Optional[PruningResult] = None,
) -> PathResult:
    """
    State-space expansion for graphs with conditional_p.

    State = (node_key, visited_tracked_human_ids_subset).
    """
    excluded = pruning.excluded_edges if pruning else set()
    renorm = pruning.renorm_factors if pruning else {}

    tracked = _get_tracked_human_ids(G)

    # state key serialisation
    def sk(node: str, visited: frozenset[str]) -> tuple[str, frozenset[str]]:
        return (node, visited)

    states: dict[tuple[str, frozenset[str]], float] = {}
    costs: dict[tuple[str, frozenset[str]], tuple[float, float]] = {}

    init = sk(start_key, frozenset())
    states[init] = 1.0
    costs[init] = (0.0, 0.0)

    # Process in topological order of nodes (graph is assumed DAG-ish; cycles treated as terminal-ish).
    try:
        topo = list(nx.topological_sort(G))
    except Exception:
        topo = list(G.nodes)

    # Expand node-by-node; for each node, repeatedly expand any states currently at that node.
    for node_key in topo:
        # Find all current states at this node (snapshot keys to avoid concurrent modification).
        node_states = [k for k in list(states.keys()) if k[0] == node_key]

        for state_key in node_states:
            prob = states.get(state_key, 0.0) or 0.0
            if prob == 0:
                continue

            visited = set(state_key[1])
            cost_gbp, cost_lab = costs.get(state_key, (0.0, 0.0))

            if _is_terminal_for_target(G, node_key, end_key):
                continue

            # When leaving this node, mark it as visited if it is tracked.
            node_hid = G.nodes[node_key].get('id') or node_key
            next_visited = set(visited)
            if node_hid in tracked:
                next_visited.add(node_hid)

            for _, target, data in G.out_edges(node_key, data=True):
                edge = (node_key, target)
                if edge in excluded:
                    continue

                p = _effective_edge_probability(data, next_visited)
                if edge in renorm:
                    p *= renorm[edge]
                if p == 0:
                    continue

                edge_gbp = float(data.get('cost_gbp') or 0.0)
                edge_lab = float(data.get('labour_cost') or 0.0)

                w = prob * p
                next_key = sk(target, frozenset(next_visited))

                prev_prob = states.get(next_key, 0.0) or 0.0
                new_prob = prev_prob + w
                states[next_key] = new_prob

                # Expected cumulative cost at this state (weighted average by incoming probability mass).
                next_cost = (cost_gbp + edge_gbp, cost_lab + edge_lab)
                prev_cost = costs.get(next_key)
                if prev_cost and prev_prob > 0 and new_prob > 0:
                    prev_w = prev_prob / new_prob
                    new_w = w / new_prob
                    costs[next_key] = (
                        prev_cost[0] * prev_w + next_cost[0] * new_w,
                        prev_cost[1] * prev_w + next_cost[1] * new_w,
                    )
                else:
                    costs[next_key] = next_cost

    # Aggregate probability + costs at end (across visited states).
    end_states = [k for k in states.keys() if k[0] == end_key]
    p_end = sum(states[k] for k in end_states)

    # Unconditional expected cost (per attempt) = expected cost of terminal states.
    terminal_states = [k for k in states.keys() if _is_terminal_for_target(G, k[0], end_key)]
    exp_cost = 0.0
    exp_lab = 0.0
    for k in terminal_states:
        p = states.get(k, 0.0) or 0.0
        c = costs.get(k, (0.0, 0.0))
        exp_cost += p * c[0]
        exp_lab += p * c[1]

    # Cost given success = weighted average cost among end states.
    exp_cost_given = None
    exp_lab_given = None
    if p_end > 0:
        num_cost = 0.0
        num_lab = 0.0
        for k in end_states:
            p = states.get(k, 0.0) or 0.0
            c = costs.get(k, (0.0, 0.0))
            num_cost += p * c[0]
            num_lab += p * c[1]
        exp_cost_given = num_cost / p_end
        exp_lab_given = num_lab / p_end

    return PathResult(
        probability=p_end,
        expected_cost_gbp=exp_cost,
        expected_labour_cost=exp_lab,
        expected_cost_gbp_given_success=exp_cost_given,
        expected_labour_cost_given_success=exp_lab_given,
        path_exists=p_end > 0,
    )


def compute_pruning(
    G: nx.DiGraph,
    visited_nodes: list[str],
    visited_any_groups: list[list[str]] = None
) -> PruningResult:
    """
    Compute graph pruning for visited node constraints.
    
    When a node is "visited":
    - Sibling edges (other outgoing edges from same parent) are pruned
    - Remaining edges are renormalized to sum to 1.0
    
    Args:
        G: NetworkX DiGraph
        visited_nodes: Nodes that must be visited (visited() constraints) - UUIDs or human-readable IDs
        visited_any_groups: Groups where at least one must be visited (visitedAny()) - UUIDs or human-readable IDs
    
    Returns:
        PruningResult with excluded edges and renormalization factors
    """
    from .graph_builder import resolve_node_id
    
    excluded_edges = set()
    renorm_factors = {}
    
    visited_any_groups = visited_any_groups or []
    
    # Resolve all visited node IDs to graph keys
    resolved_visited = []
    for vid in visited_nodes:
        resolved = resolve_node_id(G, vid)
        if resolved:
            resolved_visited.append(resolved)
    
    resolved_any_groups = []
    for group in visited_any_groups:
        resolved_group = []
        for vid in group:
            resolved = resolve_node_id(G, vid)
            if resolved:
                resolved_group.append(resolved)
        if resolved_group:
            resolved_any_groups.append(resolved_group)
    
    # For each visited node, prune sibling edges
    for visited_id in resolved_visited:
        if visited_id not in G:
            continue
        
        # Find parents of this node
        parents = list(G.predecessors(visited_id))
        
        for parent in parents:
            # Get all outgoing edges from parent
            outgoing = list(G.successors(parent))
            
            # If visited node is the only child, nothing to prune
            if len(outgoing) <= 1:
                continue
            
            # Calculate probability sum of edges we're keeping
            kept_prob_sum = 0.0
            edges_to_keep = []
            
            for child in outgoing:
                edge_data = G.edges[parent, child]
                p = edge_data.get('p', 0.0) or 0.0
                
                if child == visited_id:
                    kept_prob_sum += p
                    edges_to_keep.append((parent, child))
                else:
                    # Exclude this sibling edge
                    excluded_edges.add((parent, child))
            
            # Renormalize kept edges
            if kept_prob_sum > 0:
                for edge in edges_to_keep:
                    edge_data = G.edges[edge[0], edge[1]]
                    old_p = edge_data.get('p', 0.0) or 0.0
                    if old_p > 0:
                        # Renorm factor: 1.0 / kept_prob_sum
                        renorm_factors[edge] = 1.0 / kept_prob_sum
    
    # For visitedAny groups: keep all in group, exclude others
    for group in resolved_any_groups:
        group_set = set(group)
        
        # Find common parents of group members
        parents_per_node = {n: set(G.predecessors(n)) for n in group if n in G}
        if not parents_per_node:
            continue
        
        # Get all parents that have at least one group member as child
        all_parents = set()
        for parents in parents_per_node.values():
            all_parents.update(parents)
        
        for parent in all_parents:
            outgoing = list(G.successors(parent))
            
            # Find which children are in the group
            in_group = [c for c in outgoing if c in group_set]
            not_in_group = [c for c in outgoing if c not in group_set]
            
            # Only prune if we have both group members and non-members
            if not in_group or not not_in_group:
                continue
            
            # Exclude edges to non-group children
            for child in not_in_group:
                excluded_edges.add((parent, child))
            
            # Calculate renormalization for kept edges
            kept_prob_sum = 0.0
            for child in in_group:
                edge_data = G.edges[parent, child]
                p = edge_data.get('p', 0.0) or 0.0
                kept_prob_sum += p
            
            # Apply renormalization
            if kept_prob_sum > 0:
                for child in in_group:
                    edge = (parent, child)
                    if edge not in renorm_factors:  # Don't override visited() renorm
                        renorm_factors[edge] = 1.0 / kept_prob_sum
    
    return PruningResult(
        excluded_edges=excluded_edges,
        renorm_factors=renorm_factors
    )


def calculate_path_probability(
    G: nx.DiGraph,
    start_id: str,
    end_id: str,
    pruning: Optional[PruningResult] = None,
) -> PathResult:
    """
    Calculate probability and expected costs from start to end.
    
    Uses DFS with memoization to handle multiple paths.
    
    Args:
        G: NetworkX DiGraph with edge 'p', 'cost_gbp', 'labour_cost' attrs
        start_id: Start node ID (UUID or human-readable)
        end_id: End node ID (UUID or human-readable)
        pruning: Optional pruning result for visited constraints
    
    Returns:
        PathResult with probability and expected costs
    """
    from .graph_builder import resolve_node_id
    
    # Resolve human-readable IDs to graph keys (UUIDs)
    resolved_start = resolve_node_id(G, start_id) if start_id else None
    resolved_end = resolve_node_id(G, end_id) if end_id else None
    
    if not resolved_start or not resolved_end:
        return PathResult(
            probability=0.0,
            expected_cost_gbp=0.0,
            expected_labour_cost=0.0,
            path_exists=False
        )
    
    start_id = resolved_start
    end_id = resolved_end
    
    excluded = pruning.excluded_edges if pruning else set()
    renorm = pruning.renorm_factors if pruning else {}
    
    # IMPORTANT (Layer-1 decision): Do NOT apply edge.conditional_p implicitly in runner analytics.
    #
    # conditional_p is currently treated as What-If modelling, not intrinsic Markov semantics.
    # Runner analytics should therefore use the (already-baked) edge probability `p` only,
    # unless/when conditional activation is explicitly requested by the analysis DSL.
    #
    # NOTE: This means we intentionally do NOT switch to the state-space algorithm based
    # on the mere presence of conditional_p on any edge.

    # Otherwise, use fast DFS with memoization.
    # DFS with memoization for probability to reach end_id
    prob_cache: dict[str, float] = {}
    visiting: set[str] = set()  # For cycle detection
    
    def calc_prob(node_id: str) -> float:
        if node_id == end_id:
            return 1.0
        
        if node_id in prob_cache:
            return prob_cache[node_id]
        
        if node_id in visiting:
            return 0.0  # Cycle detected
        
        visiting.add(node_id)
        
        total_prob = 0.0
        for _, target, data in G.out_edges(node_id, data=True):
            edge = (node_id, target)
            
            # Skip excluded edges
            if edge in excluded:
                continue
            
            # Get edge probability
            p = data.get('p', 0.0) or 0.0
            
            # Apply renormalization
            if edge in renorm:
                p *= renorm[edge]
            
            # Recursive probability to end
            target_prob = calc_prob(target)
            total_prob += p * target_prob
        
        visiting.discard(node_id)
        prob_cache[node_id] = total_prob
        return total_prob
    
    # DFS with memoization for expected costs (UNCONDITIONAL / from the start):
    # i.e. expected cost incurred while traversing the process, regardless of whether end_id is reached.
    cost_cache: dict[str, tuple[float, float]] = {}
    cost_visiting: set[str] = set()
    
    def calc_cost(node_id: str) -> tuple[float, float]:
        """Returns (expected_gbp, expected_time)"""
        if node_id == end_id:
            return (0.0, 0.0)
        
        if node_id in cost_cache:
            return cost_cache[node_id]
        
        if node_id in cost_visiting:
            return (0.0, 0.0)  # Cycle
        
        cost_visiting.add(node_id)
        
        total_gbp = 0.0
        total_time = 0.0
        
        for _, target, data in G.out_edges(node_id, data=True):
            edge = (node_id, target)
            
            if edge in excluded:
                continue
            
            p = data.get('p', 0.0) or 0.0
            if edge in renorm:
                p *= renorm[edge]
            
            # Edge costs
            edge_gbp = data.get('cost_gbp', 0.0) or 0.0
            edge_time = data.get('labour_cost', 0.0) or 0.0
            
            # Recursive costs
            target_gbp, target_time = calc_cost(target)
            
            # Probability-weighted costs
            total_gbp += p * (edge_gbp + target_gbp)
            total_time += p * (edge_time + target_time)
        
        cost_visiting.discard(node_id)
        cost_cache[node_id] = (total_gbp, total_time)
        return (total_gbp, total_time)

    # DFS for CONDITIONAL cost numerator:
    # numerator(node) = E[cost * I(reach end_id) | starting at node]
    # Then: E[cost | reach end_id] = numerator(start) / P(reach end_id).
    cond_num_cache: dict[str, tuple[float, float]] = {}
    cond_visiting: set[str] = set()

    def calc_conditional_numerator(node_id: str) -> tuple[float, float]:
        """Returns (gbp_numerator, labour_numerator)."""
        if node_id == end_id:
            return (0.0, 0.0)

        if node_id in cond_num_cache:
            return cond_num_cache[node_id]

        if node_id in cond_visiting:
            return (0.0, 0.0)  # Cycle

        cond_visiting.add(node_id)

        total_num_gbp = 0.0
        total_num_labour = 0.0

        for _, target, data in G.out_edges(node_id, data=True):
            edge = (node_id, target)

            if edge in excluded:
                continue

            p = data.get('p', 0.0) or 0.0
            if edge in renorm:
                p *= renorm[edge]

            if p == 0:
                continue

            edge_gbp = data.get('cost_gbp', 0.0) or 0.0
            edge_labour = data.get('labour_cost', 0.0) or 0.0

            target_prob = calc_prob(target)
            if target_prob == 0:
                # If the target can't reach end_id, this branch contributes nothing to the conditional numerator.
                continue

            target_num_gbp, target_num_labour = calc_conditional_numerator(target)

            # Edge cost only contributes if we eventually reach end_id from target.
            total_num_gbp += p * (target_num_gbp + (target_prob * edge_gbp))
            total_num_labour += p * (target_num_labour + (target_prob * edge_labour))

        cond_visiting.discard(node_id)
        cond_num_cache[node_id] = (total_num_gbp, total_num_labour)
        return (total_num_gbp, total_num_labour)
    
    probability = calc_prob(start_id)
    exp_gbp, exp_time = calc_cost(start_id)

    exp_gbp_given = None
    exp_labour_given = None
    if probability > 0:
        num_gbp, num_labour = calc_conditional_numerator(start_id)
        exp_gbp_given = num_gbp / probability
        exp_labour_given = num_labour / probability
    
    return PathResult(
        probability=probability,
        expected_cost_gbp=exp_gbp,
        expected_labour_cost=exp_time,
        expected_cost_gbp_given_success=exp_gbp_given,
        expected_labour_cost_given_success=exp_labour_given,
        path_exists=probability > 0
    )


def calculate_path_through_node(
    G: nx.DiGraph,
    node_id: str,
    pruning: Optional[PruningResult] = None,
) -> PathResult:
    """
    Calculate probability and costs of paths through a specific node.
    
    This is P(reaching node from any entry) * P(reaching any absorbing from node)
    
    Args:
        G: NetworkX DiGraph
        node_id: The node to analyze paths through (UUID or human-readable)
        pruning: Optional pruning result
    
    Returns:
        PathResult with combined probability and costs
    """
    from .graph_builder import find_entry_nodes, find_absorbing_nodes, resolve_node_id
    
    # Resolve human-readable ID to graph key
    resolved_id = resolve_node_id(G, node_id)
    if not resolved_id:
        return PathResult(
            probability=0.0,
            expected_cost_gbp=0.0,
            expected_labour_cost=0.0,
            path_exists=False
        )
    
    node_id = resolved_id  # Use resolved ID from here on
    
    entry_nodes = find_entry_nodes(G)
    absorbing_nodes = find_absorbing_nodes(G)
    
    if not entry_nodes or not absorbing_nodes:
        return PathResult(
            probability=0.0,
            expected_cost_gbp=0.0,
            expected_labour_cost=0.0,
            path_exists=False
        )
    
    # Calculate probability of reaching this node from any entry
    prob_to_node = 0.0
    cost_to_node_gbp = 0.0
    cost_to_node_time = 0.0
    
    for entry in entry_nodes:
        result = calculate_path_probability(G, entry, node_id, pruning)
        # Weight by entry weight if specified, else equal weight
        entry_weight = G.nodes[entry].get('entry_weight', 1.0 / len(entry_nodes))
        prob_to_node += entry_weight * result.probability
        cost_to_node_gbp += entry_weight * result.expected_cost_gbp
        cost_to_node_time += entry_weight * result.expected_labour_cost
    
    # Calculate probability of reaching any absorbing from this node
    prob_from_node = 0.0
    cost_from_node_gbp = 0.0
    cost_from_node_time = 0.0
    
    for absorbing in absorbing_nodes:
        result = calculate_path_probability(G, node_id, absorbing, pruning)
        prob_from_node += result.probability
        cost_from_node_gbp += result.probability * result.expected_cost_gbp
        cost_from_node_time += result.probability * result.expected_labour_cost
    
    # Combined result
    # Note: prob_from_node should sum to 1.0 if graph is well-formed
    combined_prob = prob_to_node * min(prob_from_node, 1.0)
    
    return PathResult(
        probability=combined_prob,
        expected_cost_gbp=cost_to_node_gbp + cost_from_node_gbp,
        expected_labour_cost=cost_to_node_time + cost_from_node_time,
        path_exists=combined_prob > 0
    )


def calculate_path_to_absorbing(
    G: nx.DiGraph,
    absorbing_id: str,
    pruning: Optional[PruningResult] = None,
) -> PathResult:
    """
    Calculate probability and costs of reaching a specific absorbing node.
    
    Args:
        G: NetworkX DiGraph
        absorbing_id: The absorbing node (UUID or human-readable)
        pruning: Optional pruning result
    
    Returns:
        PathResult with probability from entries to this absorbing node
    """
    from .graph_builder import find_entry_nodes, resolve_node_id
    
    # Resolve human-readable ID to graph key
    resolved_id = resolve_node_id(G, absorbing_id)
    if not resolved_id:
        return PathResult(
            probability=0.0,
            expected_cost_gbp=0.0,
            expected_labour_cost=0.0,
            path_exists=False
        )
    
    absorbing_id = resolved_id  # Use resolved ID from here on
    
    entry_nodes = find_entry_nodes(G)
    
    if not entry_nodes:
        return PathResult(
            probability=0.0,
            expected_cost_gbp=0.0,
            expected_labour_cost=0.0,
            path_exists=False
        )
    
    total_prob = 0.0
    total_gbp = 0.0
    total_time = 0.0
    total_num_gbp = 0.0
    total_num_labour = 0.0
    
    for entry in entry_nodes:
        result = calculate_path_probability(G, entry, absorbing_id, pruning)
        entry_weight = G.nodes[entry].get('entry_weight', 1.0 / len(entry_nodes))
        
        total_prob += entry_weight * result.probability
        total_gbp += entry_weight * result.expected_cost_gbp
        total_time += entry_weight * result.expected_labour_cost

        # Numerator aggregation for conditional-on-success costs.
        if result.expected_cost_gbp_given_success is not None and result.probability > 0:
            total_num_gbp += entry_weight * result.probability * result.expected_cost_gbp_given_success
        if result.expected_labour_cost_given_success is not None and result.probability > 0:
            total_num_labour += entry_weight * result.probability * result.expected_labour_cost_given_success

    exp_gbp_given = None
    exp_labour_given = None
    if total_prob > 0:
        exp_gbp_given = total_num_gbp / total_prob
        exp_labour_given = total_num_labour / total_prob
    
    return PathResult(
        probability=total_prob,
        expected_cost_gbp=total_gbp,
        expected_labour_cost=total_time,
        expected_cost_gbp_given_success=exp_gbp_given,
        expected_labour_cost_given_success=exp_labour_given,
        path_exists=total_prob > 0
    )


def run_path_analysis(
    G: nx.DiGraph,
    start_id: Optional[str],
    end_id: Optional[str],
    visited_nodes: list[str] = None,
    visited_any_groups: list[list[str]] = None,
) -> dict[str, Any]:
    """
    Run path analysis with DSL constraints.
    
    High-level entry point that handles:
    - Pruning from visited() and visitedAny() constraints
    - Different analysis modes (path, through, to_end)
    
    Args:
        G: NetworkX DiGraph
        start_id: Start node (from DSL from() clause, or None)
        end_id: End node (from DSL to() clause, or None)
        visited_nodes: Nodes from visited() constraints
        visited_any_groups: Node groups from visitedAny() constraints
    
    Returns:
        Analysis results dict
    """
    visited_nodes = visited_nodes or []
    visited_any_groups = visited_any_groups or []
    
    # Compute pruning if we have constraints
    pruning = None
    if visited_nodes or visited_any_groups:
        pruning = compute_pruning(G, visited_nodes, visited_any_groups)
    
    # Determine analysis mode
    if start_id and end_id:
        # Full path analysis
        result = calculate_path_probability(G, start_id, end_id, pruning)
        return {
            'analysis_type': 'path',
            'from_node': start_id,
            'to_node': end_id,
            'probability': result.probability,
            'expected_cost_gbp': result.expected_cost_gbp,
            'expected_labour_cost': result.expected_labour_cost,
            'path_exists': result.path_exists,
            'visited_constraints': visited_nodes,
            'visited_any_constraints': visited_any_groups,
        }
    
    elif end_id and not start_id:
        # Path to specific end from any entry
        result = calculate_path_to_absorbing(G, end_id, pruning)
        return {
            'analysis_type': 'path_to_end',
            'to_node': end_id,
            'probability': result.probability,
            'expected_cost_gbp': result.expected_cost_gbp,
            'expected_labour_cost': result.expected_labour_cost,
            'path_exists': result.path_exists,
        }
    
    elif start_id and not end_id:
        # Path through/from specific node
        result = calculate_path_through_node(G, start_id, pruning)
        return {
            'analysis_type': 'path_through',
            'node': start_id,
            'probability': result.probability,
            'expected_cost_gbp': result.expected_cost_gbp,
            'expected_labour_cost': result.expected_labour_cost,
            'path_exists': result.path_exists,
        }
    
    else:
        # No from/to specified - general graph stats
        from .graph_builder import get_graph_stats
        stats = get_graph_stats(G)
        return {
            'analysis_type': 'general',
            'graph_stats': stats,
        }

