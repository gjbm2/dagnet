"""
Analysis Runners

Specialized runners for different analysis types.

Design Reference: /docs/current/project-analysis/PHASE_1_DESIGN.md
"""

from typing import Any, Optional
import networkx as nx

from .path_runner import (
    calculate_path_probability,
    calculate_path_to_absorbing,
    calculate_path_through_node,
    compute_pruning,
    PruningResult,
)
from .graph_builder import (
    find_entry_nodes,
    find_absorbing_nodes,
    get_graph_stats,
    apply_visibility_mode,
    get_probability_label,
)

def _is_close(a: float, b: float, tol: float = 1e-12) -> bool:
    return abs(a - b) <= tol


def _prepare_scenarios(
    G: nx.DiGraph,
    all_scenarios: Optional[list],
) -> list[dict[str, Any]]:
    """
    Centralised scenario preparation for ALL analysis runners.

    Goal: avoid duplicating the same "build NX graph + apply visibility_mode + label" logic
    in each runner implementation.

    Returns a list of dicts with:
    - scenario_id, scenario_name, scenario_colour
    - visibility_mode, probability_label
    - scenario_G (NetworkX graph with visibility mode already applied)

    NOTE:
    - Uses a copy of the base graph for the implicit "current" scenario to avoid mutating
      the shared G across multiple scenario computations.
    """
    from .graph_builder import build_networkx_graph

    prepared: list[dict[str, Any]] = []
    scenarios_to_process = all_scenarios if all_scenarios else [None]

    for scenario in scenarios_to_process:
        if scenario:
            scenario_G = build_networkx_graph(scenario.graph)
            scenario_id = scenario.scenario_id
            scenario_name = scenario.name or scenario.scenario_id
            scenario_colour = scenario.colour or '#3b82f6'
            visibility_mode = getattr(scenario, 'visibility_mode', 'f+e') or 'f+e'
        else:
            scenario_G = G.copy()
            scenario_id = 'current'
            scenario_name = 'Current'
            scenario_colour = '#3b82f6'
            visibility_mode = 'f+e'

        apply_visibility_mode(scenario_G, visibility_mode)
        prepared.append({
            'scenario_id': scenario_id,
            'scenario_name': scenario_name,
            'scenario_colour': scenario_colour,
            'visibility_mode': visibility_mode,
            'probability_label': get_probability_label(visibility_mode),
            'scenario_G': scenario_G,
        })

    return prepared


def _filter_optional_metrics(result_obj: dict[str, Any], data_rows: list[dict[str, Any]], optional_metric_ids: list[str]) -> None:
    """
    Remove optional metrics that are all-null / all-zero across rows to reduce UI noise.
    """
    semantics = result_obj.get('semantics') or {}
    metrics = semantics.get('metrics') or []
    filtered_metrics = []
    for m in metrics:
        mid = m.get('id')
        if mid in optional_metric_ids:
            vals = [(row.get(mid)) for row in data_rows]
            if all(v is None or v == 0 for v in vals):
                continue
        filtered_metrics.append(m)
    semantics['metrics'] = filtered_metrics
    result_obj['semantics'] = semantics


def run_single_node_entry(
    G: nx.DiGraph,
    node_id: str,
    pruning: Optional[PruningResult] = None,
    all_scenarios: Optional[list] = None,
) -> dict[str, Any]:
    """
    Analyze entry/start node.
    
    Returns probabilities of reaching all absorbing nodes from this entry.
    New declarative schema: scenario-first layout with outcomes nested.
    
    LAG support: includes visibility_mode per scenario for UI adaptors.
    """
    from .graph_builder import build_networkx_graph
    
    if node_id not in G:
        return {'error': f'Node {node_id} not found'}
    
    node_label = G.nodes[node_id].get('label') or node_id
    
    prepared_scenarios = _prepare_scenarios(G, all_scenarios)
    scenario_dimension_values = {
        s['scenario_id']: {
            'name': s['scenario_name'],
            'colour': s['scenario_colour'],
            'visibility_mode': s['visibility_mode'],
            'probability_label': s['probability_label'],
        }
        for s in prepared_scenarios
    }
    
    # Get outcome dimension values (absorbing nodes)
    absorbing_nodes = find_absorbing_nodes(G)
    outcome_dimension_values = {}
    for i, absorbing in enumerate(absorbing_nodes):
        outcome_label = G.nodes[absorbing].get('label') if absorbing in G else None
        outcome_dimension_values[absorbing] = {
            'name': outcome_label or absorbing,  # Fallback to node ID if label is None
            'order': i
        }
    
    # Build flat data rows (scenario × outcome)
    data_rows = []
    for s in prepared_scenarios:
        scenario_G = s['scenario_G']
        scenario_id = s['scenario_id']
        visibility_mode = s['visibility_mode']
        p_label = s['probability_label']
        scenario_name = s['scenario_name']
        for absorbing in absorbing_nodes:
            result = calculate_path_probability(scenario_G, node_id, absorbing, pruning)
            data_rows.append({
                'scenario_id': scenario_id,
                'scenario_name': scenario_name,
                'visibility_mode': visibility_mode,
                'probability_label': p_label,
                'outcome': absorbing,
                'probability': result.probability,
                'expected_cost_gbp': result.expected_cost_gbp,
                'expected_labour_cost': result.expected_labour_cost,
            })
    
    return {
        'metadata': {
            'node_id': node_id,
            'node_label': node_label,
        },
        'semantics': {
            'dimensions': [
                {'id': 'scenario_id', 'name': 'Scenario', 'type': 'scenario', 'role': 'primary'},
                {'id': 'outcome', 'name': 'Outcome', 'type': 'node', 'role': 'secondary'},
            ],
            'metrics': [
                {'id': 'probability', 'name': 'Probability', 'type': 'probability', 'format': 'percent', 'role': 'primary'},
                {'id': 'expected_cost_gbp', 'name': 'Expected Cost (£)', 'type': 'currency', 'format': 'currency_gbp'},
                {'id': 'expected_labour_cost', 'name': 'Expected Cost (Labour)', 'type': 'duration', 'format': 'number'},
            ],
            'chart': {
                'recommended': 'bar_grouped',
                'alternatives': ['table'],
                'hints': {
                    'sort': {'by': 'probability', 'order': 'desc'}  # Highest first
                }
            }
        },
        'dimension_values': {
            'scenario_id': scenario_dimension_values,
            'outcome': outcome_dimension_values,
        },
        'data': data_rows,
    }


def run_path_to_end(
    G: nx.DiGraph,
    node_id: str,
    pruning: Optional[PruningResult] = None,
    all_scenarios: Optional[list] = None,
) -> dict[str, Any]:
    """
    Analyze absorbing/outcome node.
    
    Returns probability of reaching this outcome from all entries.
    New declarative schema: scenario-first, simple metrics.
    
    LAG support: includes visibility_mode per scenario for UI adaptors.
    """
    from .graph_builder import build_networkx_graph, resolve_node_id
    
    node_label = G.nodes[node_id].get('label') or node_id if node_id in G else node_id
    
    # Build scenario dimension values and data rows
    prepared_scenarios = _prepare_scenarios(G, all_scenarios)
    scenario_dimension_values = {}
    data_rows = []

    for s in prepared_scenarios:
        scenario_G = s['scenario_G']
        scenario_id = s['scenario_id']
        scenario_name = s['scenario_name']
        scenario_colour = s['scenario_colour']
        visibility_mode = s['visibility_mode']
        p_label = s['probability_label']

        scenario_dimension_values[scenario_id] = {
            'name': scenario_name,
            'colour': scenario_colour,
            'visibility_mode': visibility_mode,
            'probability_label': p_label,
        }

        result = calculate_path_to_absorbing(scenario_G, node_id, pruning)
        cost_per_success_gbp = None
        cost_per_success_labour = None
        if result.probability and result.probability > 0:
            # Commercial framing: "total expected cost per starter" apportioned across successes.
            # This is E(cost) / P(reach target).
            cost_per_success_gbp = result.expected_cost_gbp / result.probability
            cost_per_success_labour = result.expected_labour_cost / result.probability

        # n/k context for Reach Probability
        # - n: starters at the start of the graph (entry population)
        # - k: arrivals at the reached node (incoming edge converters)
        #
        # This is intentionally "n at start; k at reached node".
        n_start = None
        try:
            entry_nodes = find_entry_nodes(scenario_G)
        except Exception:
            entry_nodes = []

        if entry_nodes:
            n_total = 0
            has_any_n = False
            for entry in entry_nodes:
                # Outgoing edges should share the same underlying n (PMF split),
                # so use MAX to avoid double-counting when multiple outgoing edges exist.
                max_n_for_entry = None
                for succ in scenario_G.successors(entry):
                    edge_evidence = (scenario_G.edges[entry, succ].get('evidence') or {})
                    edge_n = edge_evidence.get('n')
                    if edge_n is None:
                        continue
                    max_n_for_entry = edge_n if max_n_for_entry is None else max(max_n_for_entry, edge_n)
                if max_n_for_entry is not None:
                    has_any_n = True
                    n_total += max_n_for_entry
            if has_any_n:
                n_start = n_total

        k_reached = None
        resolved_node = resolve_node_id(scenario_G, node_id)
        if resolved_node and resolved_node in scenario_G:
            k_total = 0
            has_any_k = False
            for pred in scenario_G.predecessors(resolved_node):
                edge_evidence = (scenario_G.edges[pred, resolved_node].get('evidence') or {})
                edge_k = edge_evidence.get('k')
                if edge_k is None:
                    continue
                has_any_k = True
                k_total += edge_k
            if has_any_k:
                k_reached = k_total

        # Completeness is only well-defined here when there is a single inbound edge to the reached node.
        completeness = None
        if resolved_node and resolved_node in scenario_G:
            preds = list(scenario_G.predecessors(resolved_node))
            if len(preds) == 1:
                latency = (scenario_G.edges[preds[0], resolved_node].get('latency') or {})
                completeness = latency.get('completeness')

        row = {
            'scenario_id': scenario_id,
            'scenario_name': scenario_name,
            'visibility_mode': visibility_mode,
            'probability_label': p_label,
            'probability': result.probability,
            'n': n_start,
            'k': k_reached,
            'completeness': completeness,
            'expected_cost_gbp': result.expected_cost_gbp,
            'expected_labour_cost': result.expected_labour_cost,
            'expected_cost_gbp_given_success': result.expected_cost_gbp_given_success,
            'expected_labour_cost_given_success': result.expected_labour_cost_given_success,
            'cost_per_success_gbp': cost_per_success_gbp,
            'cost_per_success_labour': cost_per_success_labour,
        }
        data_rows.append(row)
    
    # IMPORTANT: probability basis is per-scenario (visibility_mode may differ),
    # so the shared metric label stays generic. Use per-row/per-scenario `probability_label`
    # to display the actual basis in the UI.
    metric_name = 'Probability'

    result_obj = {
        'metadata': {
            'node_id': node_id,
            'node_label': node_label,
        },
        'semantics': {
            'dimensions': [
                {'id': 'scenario_id', 'name': 'Scenario', 'type': 'scenario', 'role': 'primary'},
            ],
            'metrics': [
                {'id': 'probability', 'name': metric_name, 'type': 'probability', 'format': 'percent', 'role': 'primary'},
                {'id': 'n', 'name': 'n (start)', 'type': 'count', 'format': 'number'},
                {'id': 'k', 'name': 'k (reached)', 'type': 'count', 'format': 'number'},
                {'id': 'completeness', 'name': 'Completeness', 'type': 'ratio', 'format': 'percent'},
                {'id': 'expected_cost_gbp', 'name': 'Expected Cost (£)', 'type': 'currency', 'format': 'currency_gbp'},
                {'id': 'expected_labour_cost', 'name': 'Expected Cost (Labour)', 'type': 'duration', 'format': 'number'},
                {'id': 'expected_cost_gbp_given_success', 'name': 'Cost (£) Given success', 'type': 'currency', 'format': 'currency_gbp'},
                {'id': 'expected_labour_cost_given_success', 'name': 'Cost (Labour) Given success', 'type': 'duration', 'format': 'number'},
                {'id': 'cost_per_success_gbp', 'name': 'Cost (£) per success', 'type': 'currency', 'format': 'currency_gbp'},
                {'id': 'cost_per_success_labour', 'name': 'Cost (Labour) per success', 'type': 'duration', 'format': 'number'},
            ],
            'chart': {
                'recommended': 'bar',
                'alternatives': ['table'],
            }
        },
        'dimension_values': {
            'scenario_id': scenario_dimension_values,
        },
        'data': data_rows,
    }

    # If a metric is all-zero / all-null across all scenarios, omit it to reduce UI noise.
    optional_metric_ids = [
        'n',
        'k',
        'expected_cost_gbp',
        'expected_labour_cost',
        'expected_cost_gbp_given_success',
        'expected_labour_cost_given_success',
        'cost_per_success_gbp',
        'cost_per_success_labour',
    ]
    _filter_optional_metrics(result_obj, data_rows, optional_metric_ids)

    return result_obj


def run_bridge_view(
    G: nx.DiGraph,
    node_id: str,
    pruning: Optional[PruningResult] = None,
    all_scenarios: Optional[list] = None,
    other_threshold_pct: float = 0.025,
) -> dict[str, Any]:
    """
    Bridge View (two-scenario only): decompose Reach Probability difference between A and B.

    Spec:
    - Requires exactly 2 visible scenarios.
    - Start bar is Reach(A), end bar is Reach(B).
    - Intermediate steps are an additive factor decomposition of the difference, derived
      from a stable sequential-replacement attribution:
        - Start from scenario A probabilities.
        - Topologically iterate the induced subgraph of nodes on any path from entry → target.
        - For each node, swap that node's outgoing edge probabilities from A to B (basis already applied
          per scenario visibility_mode), recompute Reach(target), and record the incremental delta.
        - The sum of deltas equals Reach(B) - Reach(A) (within floating tolerance).
    - Bucket long tails: steps with |delta| < other_threshold_pct * |total_delta| are grouped into "Other".
    """
    from .graph_builder import get_human_id

    node_label = G.nodes[node_id].get('label') or node_id if node_id in G else node_id

    prepared_scenarios = _prepare_scenarios(G, all_scenarios)
    if len(prepared_scenarios) != 2:
        return {'error': 'Bridge View requires exactly 2 scenarios'}

    sA = prepared_scenarios[0]
    sB = prepared_scenarios[1]
    GA: nx.DiGraph = sA['scenario_G']
    GB: nx.DiGraph = sB['scenario_G']

    # Induced subgraph: nodes that are both
    # - descendants of (any) entry nodes
    # - ancestors of the target node (including the target)
    try:
        entry_nodes = find_entry_nodes(GA)
    except Exception:
        entry_nodes = []

    if not entry_nodes:
        return {'error': 'No entry nodes found for Bridge View'}

    if node_id not in GA:
        return {'error': f'Node not found: {node_id}'}

    ancestors = set(nx.ancestors(GA, node_id))
    ancestors.add(node_id)
    reachable_from_entries = set()
    for e in entry_nodes:
        reachable_from_entries.add(e)
        reachable_from_entries.update(nx.descendants(GA, e))

    induced_nodes = ancestors.intersection(reachable_from_entries)
    inducedA = GA.subgraph(induced_nodes).copy()
    inducedB = GB.subgraph(induced_nodes).copy()

    # Totals
    reachA = calculate_path_to_absorbing(inducedA, node_id, pruning).probability
    reachB = calculate_path_to_absorbing(inducedB, node_id, pruning).probability
    total_delta = reachB - reachA

    # Sequential replacement attribution over nodes in induced topo order.
    hybrid = inducedA.copy()
    try:
        topo_nodes = list(nx.topological_sort(hybrid))
    except Exception:
        # Fallback: deterministic ordering
        topo_nodes = sorted(list(hybrid.nodes()))

    deltas: list[dict[str, Any]] = []
    prev = reachA

    # Swap outgoing edge probabilities per node (skip target; swapping it can't affect reaching it).
    for u in topo_nodes:
        if u == node_id:
            continue
        if u not in hybrid:
            continue
        # Copy relevant edge fields from B for outgoing edges within the induced subgraph.
        for v in list(hybrid.successors(u)):
            if not inducedB.has_edge(u, v):
                continue
            src = inducedB.edges[u, v]
            dst = hybrid.edges[u, v]
            # Probability basis already applied to src['p'] via visibility_mode.
            for key in ('p', 'conditional_p', 'evidence', 'forecast', 'latency', 'p_n'):
                if key in src:
                    dst[key] = src.get(key)

        new = calculate_path_to_absorbing(hybrid, node_id, pruning).probability
        d = new - prev
        if abs(d) > 1e-12:
            deltas.append({
                'node_id': u,
                'node_label': (hybrid.nodes[u].get('label') if u in hybrid.nodes else None) or u,
                'delta': d,
                'reach_before': prev,
                'reach_after': new,
            })
        prev = new

    # Enforce balancing sum as a safety net.
    # (The attribution should sum exactly; floating noise can accumulate.)
    sum_d = sum(x['delta'] for x in deltas)
    if not _is_close(sum_d, total_delta, tol=1e-9):
        # Add a small balancing adjustment into a special bucket so the chart closes.
        deltas.append({
            'node_id': '__balance__',
            'node_label': 'Other',
            'delta': total_delta - sum_d,
            'reach_before': None,
            'reach_after': None,
        })

    # Bucketing for long tails.
    bucketed: list[dict[str, Any]] = []
    other_sum = 0.0
    if abs(total_delta) > 1e-12 and other_threshold_pct > 0:
        threshold = abs(total_delta) * other_threshold_pct
        for d in deltas:
            if d['node_id'] == '__balance__':
                other_sum += float(d['delta'])
                continue
            if abs(float(d['delta'])) < threshold:
                other_sum += float(d['delta'])
            else:
                bucketed.append(d)

        # Make "Other" the balancing remainder for stability.
        major_sum = sum(float(d['delta']) for d in bucketed)
        other_sum = total_delta - major_sum
    else:
        bucketed = deltas
        other_sum = 0.0

    # Build bridge steps (human-readable IDs for UI consistency).
    steps: list[dict[str, Any]] = []
    step_meta: dict[str, Any] = {}

    def _add_step(step_id: str, name: str, order: int, kind: str, total: Optional[float], delta: Optional[float], colour: Optional[str] = None) -> None:
        step_meta[step_id] = {'name': name, 'order': order, 'colour': colour}
        steps.append({
            'bridge_step': step_id,
            'kind': kind,
            'total': total,
            'delta': delta,
        })

    order = 0
    _add_step('start', f"Start ({sA['scenario_name']})", order, 'start', reachA, None, sA.get('scenario_colour'))
    order += 1

    # Recompute a stable before/after sequence for the displayed steps post-bucketing.
    running_before = reachA
    for d in bucketed:
        nid = d['node_id']
        if nid == '__balance__':
            continue
        human = get_human_id(G, nid) if isinstance(nid, str) else str(nid)
        label = d.get('node_label') or human
        delta_val = float(d['delta'])
        running_after = running_before + delta_val
        _add_step(human, str(label), order, 'step', None, delta_val)
        steps[-1]['reach_before'] = running_before
        steps[-1]['reach_after'] = running_after
        running_before = running_after
        order += 1

    if abs(other_sum) > 1e-12:
        delta_val = float(other_sum)
        running_after = running_before + delta_val
        _add_step('other', 'Other', order, 'other', None, delta_val)
        steps[-1]['reach_before'] = running_before
        steps[-1]['reach_after'] = running_after
        running_before = running_after
        order += 1

    _add_step('end', f"End ({sB['scenario_name']})", order, 'end', reachB, None, sB.get('scenario_colour'))
    steps[-1]['reach_before'] = None
    steps[-1]['reach_after'] = reachB

    return {
        'metadata': {
            'to_node': get_human_id(G, node_id),
            'to_label': node_label,
            'scenario_a': {
                'scenario_id': sA['scenario_id'],
                'name': sA['scenario_name'],
                'colour': sA.get('scenario_colour'),
                'visibility_mode': sA['visibility_mode'],
                'probability_label': sA['probability_label'],
            },
            'scenario_b': {
                'scenario_id': sB['scenario_id'],
                'name': sB['scenario_name'],
                'colour': sB.get('scenario_colour'),
                'visibility_mode': sB['visibility_mode'],
                'probability_label': sB['probability_label'],
            },
            'reach_a': reachA,
            'reach_b': reachB,
            'delta': total_delta,
            'other_threshold_pct': other_threshold_pct,
        },
        'semantics': {
            'dimensions': [
                {'id': 'bridge_step', 'name': 'Step', 'type': 'stage', 'role': 'primary'},
            ],
            'metrics': [
                {'id': 'total', 'name': 'Reach', 'type': 'probability', 'format': 'percent', 'role': 'secondary'},
                {'id': 'delta', 'name': 'Change', 'type': 'delta', 'format': 'percent', 'role': 'primary'},
                {'id': 'reach_before', 'name': f"Reach before ({sA['scenario_name']}→{sB['scenario_name']})", 'type': 'probability', 'format': 'percent', 'role': 'secondary'},
                {'id': 'reach_after', 'name': f"Reach after ({sA['scenario_name']}→{sB['scenario_name']})", 'type': 'probability', 'format': 'percent', 'role': 'secondary'},
            ],
            'chart': {
                'recommended': 'bridge',
                'alternatives': ['bridge_horizontal', 'table'],
                'hints': {
                    'other_threshold_pct': other_threshold_pct,
                }
            }
        },
        'dimension_values': {
            'bridge_step': step_meta,
        },
        'data': steps,
    }


def run_path_through(
    G: nx.DiGraph,
    node_id: str,
    pruning: Optional[PruningResult] = None,
    all_scenarios: Optional[list] = None,
) -> dict[str, Any]:
    """
    Analyze middle node - paths through it.
    New declarative schema: scenario-first with total probability.
    
    LAG support: includes visibility_mode per scenario for UI adaptors.
    """
    from .graph_builder import build_networkx_graph
    
    node_label = G.nodes[node_id].get('label') or node_id if node_id in G else node_id
    
    prepared_scenarios = _prepare_scenarios(G, all_scenarios)
    scenario_dimension_values = {}
    data_rows = []

    for s in prepared_scenarios:
        scenario_G = s['scenario_G']
        scenario_id = s['scenario_id']
        scenario_name = s['scenario_name']
        scenario_colour = s['scenario_colour']
        visibility_mode = s['visibility_mode']
        p_label = s['probability_label']

        scenario_dimension_values[scenario_id] = {
            'name': scenario_name,
            'colour': scenario_colour,
            'visibility_mode': visibility_mode,
            'probability_label': p_label,
        }

        result = calculate_path_through_node(scenario_G, node_id, pruning)
        data_rows.append({
            'scenario_id': scenario_id,
            'scenario_name': scenario_name,
            'visibility_mode': visibility_mode,
            'probability_label': p_label,
            'probability': result.probability,
            'expected_cost_gbp': result.expected_cost_gbp,
            'expected_labour_cost': result.expected_labour_cost,
        })
    
    return {
        'metadata': {
            'node_id': node_id,
            'node_label': node_label,
        },
        'semantics': {
            'dimensions': [
                {'id': 'scenario_id', 'name': 'Scenario', 'type': 'scenario', 'role': 'primary'},
            ],
            'metrics': [
                {'id': 'probability', 'name': 'Probability', 'type': 'probability', 'format': 'percent', 'role': 'primary'},
                {'id': 'expected_cost_gbp', 'name': 'Expected Cost (£)', 'type': 'currency', 'format': 'currency_gbp'},
                {'id': 'expected_labour_cost', 'name': 'Expected Cost (Labour)', 'type': 'duration', 'format': 'number'},
            ],
            'chart': {
                'recommended': 'bar',
                'alternatives': ['table'],
            }
        },
        'dimension_values': {
            'scenario_id': scenario_dimension_values,
        },
        'data': data_rows,
    }


def run_end_comparison(
    G: nx.DiGraph,
    node_ids: list[str],
    pruning: Optional[PruningResult] = None,
    all_scenarios: Optional[list] = None,
) -> dict[str, Any]:
    """
    Compare probabilities of reaching multiple nodes (any type, not just absorbing).
    New declarative schema: node-first with scenario secondary.

    LAG support: includes visibility_mode per scenario for UI adaptors.
    """
    from .graph_builder import resolve_node_id
    # Build node dimension values
    node_dimension_values = {}
    for i, node_id in enumerate(node_ids):
        node_label = G.nodes[node_id].get('label') or node_id if node_id in G else node_id
        node_dimension_values[node_id] = {
            'name': node_label,
            'order': i
        }
    
    prepared_scenarios = _prepare_scenarios(G, all_scenarios)
    scenario_dimension_values = {}
    data_rows = []

    for s in prepared_scenarios:
        scenario_G = s['scenario_G']
        scenario_id = s['scenario_id']
        scenario_name = s['scenario_name']
        scenario_colour = s['scenario_colour']
        visibility_mode = s['visibility_mode']

        scenario_dimension_values[scenario_id] = {
            'name': scenario_name,
            'colour': scenario_colour,
            'visibility_mode': visibility_mode,
            'probability_label': s['probability_label'],
        }

        for node_id in node_ids:
            result = calculate_path_to_absorbing(scenario_G, node_id, pruning)
            # Get LAG data from incoming edge(s)
            forecast_mean = None
            evidence_mean = None
            completeness = None
            evidence_k = None
            evidence_n = None
            forecast_k = None
            resolved = resolve_node_id(scenario_G, node_id)
            target = resolved or node_id
            parents = list(scenario_G.predecessors(target)) if target in scenario_G else []
            if parents:
                parent = parents[0]
                edge_data = scenario_G.edges.get((parent, target), {})
                forecast = edge_data.get('forecast') or {}
                forecast_mean = forecast.get('mean')
                forecast_k = forecast.get('k')
                evidence = edge_data.get('evidence') or {}
                evidence_mean = evidence.get('mean')
                evidence_k = evidence.get('k')
                evidence_n = evidence.get('n')
                latency = edge_data.get('latency') or {}
                completeness = latency.get('completeness')

            row = {
                'node': node_id,
                'scenario_id': scenario_id,
                'scenario_name': scenario_name,
                'visibility_mode': visibility_mode,
                'probability': result.probability,
                'expected_cost_gbp': result.expected_cost_gbp,
                'expected_labour_cost': result.expected_labour_cost,
            }
            # LAG fields: include if available
            if forecast_mean is not None:
                row['forecast_mean'] = forecast_mean
            if evidence_mean is not None:
                row['evidence_mean'] = evidence_mean
            if completeness is not None:
                row['completeness'] = completeness
            if evidence_k is not None:
                row['evidence_k'] = evidence_k
            if evidence_n is not None:
                row['evidence_n'] = evidence_n
            if forecast_k is not None:
                row['forecast_k'] = forecast_k

            data_rows.append(row)
    
    return {
        'metadata': {
            'node_ids': node_ids,
        },
        'semantics': {
            'dimensions': [
                {'id': 'node', 'name': 'Outcome', 'type': 'node', 'role': 'primary'},
                {'id': 'scenario_id', 'name': 'Scenario', 'type': 'scenario', 'role': 'secondary'},
            ],
            'metrics': [
                {'id': 'probability', 'name': 'Probability', 'type': 'probability', 'format': 'percent', 'role': 'primary'},
                {'id': 'forecast_mean', 'name': 'Forecast', 'type': 'probability', 'format': 'percent'},
                {'id': 'evidence_mean', 'name': 'Evidence', 'type': 'probability', 'format': 'percent'},
                {'id': 'completeness', 'name': 'Completeness', 'type': 'ratio', 'format': 'percent'},
                {'id': 'evidence_k', 'name': 'Observed k', 'type': 'count', 'format': 'number'},
                {'id': 'evidence_n', 'name': 'Population n', 'type': 'count', 'format': 'number'},
                {'id': 'forecast_k', 'name': 'Forecast k', 'type': 'count', 'format': 'number'},
                {'id': 'expected_cost_gbp', 'name': 'Expected Cost (£)', 'type': 'currency', 'format': 'currency_gbp'},
                {'id': 'expected_labour_cost', 'name': 'Expected Cost (Labour)', 'type': 'duration', 'format': 'number'},
            ],
            'chart': {
                'recommended': 'bar_grouped',
                'alternatives': ['pie', 'table'],
                'hints': {
                    'sort': {'by': 'probability', 'order': 'desc'}  # Highest first
                }
            }
        },
        'dimension_values': {
            'node': node_dimension_values,
            'scenario_id': scenario_dimension_values,
        },
        'data': data_rows,
    }


def run_branch_comparison(
    G: nx.DiGraph,
    node_ids: list[str],
    pruning: Optional[PruningResult] = None,
    all_scenarios: Optional[list] = None,
) -> dict[str, Any]:
    """
    Compare parallel branches (siblings).
    New declarative schema: branch-first with scenario secondary.
    
    LAG support: includes visibility_mode and forecast/evidence data per scenario.
    """
    # Build branch dimension values
    branch_dimension_values = {}
    for i, node_id in enumerate(node_ids):
        node_label = G.nodes[node_id].get('label') or node_id if node_id in G else node_id
        branch_dimension_values[node_id] = {
            'name': node_label,
            'order': i
        }
    
    prepared_scenarios = _prepare_scenarios(G, all_scenarios)
    scenario_dimension_values = {}
    data_rows = []

    for s in prepared_scenarios:
        scenario_G = s['scenario_G']
        scenario_id = s['scenario_id']
        scenario_name = s['scenario_name']
        scenario_colour = s['scenario_colour']
        visibility_mode = s['visibility_mode']

        scenario_dimension_values[scenario_id] = {
            'name': scenario_name,
            'colour': scenario_colour,
            'visibility_mode': visibility_mode,
            'probability_label': s['probability_label'],
        }

        for node_id in node_ids:
            result = calculate_path_through_node(scenario_G, node_id, pruning)
            # Get edge probability and LAG data from parent
            edge_prob = None
            forecast_mean = None
            evidence_mean = None
            completeness = None
            evidence_k = None
            evidence_n = None
            forecast_k = None
            parents = list(scenario_G.predecessors(node_id)) if node_id in scenario_G else []
            if parents:
                parent = parents[0]
                edge_data = scenario_G.edges.get((parent, node_id), {})
                edge_prob = edge_data.get('p')
                
                # LAG fields
                forecast = edge_data.get('forecast') or {}
                forecast_mean = forecast.get('mean')
                forecast_k = forecast.get('k')
                evidence = edge_data.get('evidence') or {}
                evidence_mean = evidence.get('mean')
                evidence_k = evidence.get('k')
                evidence_n = evidence.get('n')
                latency = edge_data.get('latency') or {}
                completeness = latency.get('completeness')
            
            row = {
                'branch': node_id,
                'scenario_id': scenario_id,
                'scenario_name': scenario_name,
                'visibility_mode': visibility_mode,
                'probability_label': s['probability_label'],
                'edge_probability': edge_prob,
                'path_through_probability': result.probability,
                'expected_cost_gbp': result.expected_cost_gbp,
                'expected_labour_cost': result.expected_labour_cost,
            }
            
            # LAG fields: always include if available
            if forecast_mean is not None:
                row['forecast_mean'] = forecast_mean
            if evidence_mean is not None:
                row['evidence_mean'] = evidence_mean
            if completeness is not None:
                row['completeness'] = completeness
            # Absolute traffic metrics
            if evidence_k is not None:
                row['evidence_k'] = evidence_k
            if evidence_n is not None:
                row['evidence_n'] = evidence_n
            if forecast_k is not None:
                row['forecast_k'] = forecast_k
            
            data_rows.append(row)
    
    return {
        'metadata': {
            'node_ids': node_ids,
        },
        'semantics': {
            'dimensions': [
                {'id': 'branch', 'name': 'Branch', 'type': 'node', 'role': 'primary'},
                {'id': 'scenario_id', 'name': 'Scenario', 'type': 'scenario', 'role': 'secondary'},
            ],
            'metrics': [
                {'id': 'edge_probability', 'name': 'Edge Probability', 'type': 'probability', 'format': 'percent', 'role': 'primary'},
                {'id': 'forecast_mean', 'name': 'Forecast', 'type': 'probability', 'format': 'percent'},
                {'id': 'evidence_mean', 'name': 'Evidence', 'type': 'probability', 'format': 'percent'},
                {'id': 'completeness', 'name': 'Completeness', 'type': 'ratio', 'format': 'percent'},
                {'id': 'evidence_k', 'name': 'Observed k', 'type': 'count', 'format': 'number'},
                {'id': 'evidence_n', 'name': 'Population n', 'type': 'count', 'format': 'number'},
                {'id': 'forecast_k', 'name': 'Forecast k', 'type': 'count', 'format': 'number'},
                {'id': 'path_through_probability', 'name': 'Path Through', 'type': 'probability', 'format': 'percent'},
                {'id': 'expected_cost_gbp', 'name': 'Expected Cost (£)', 'type': 'currency', 'format': 'currency_gbp'},
                {'id': 'expected_labour_cost', 'name': 'Expected Cost (Labour)', 'type': 'duration', 'format': 'number'},
            ],
            'chart': {
                'recommended': 'bar_grouped',
                'alternatives': ['pie', 'table'],
            }
        },
        'dimension_values': {
            'branch': branch_dimension_values,
            'scenario_id': scenario_dimension_values,
        },
        'data': data_rows,
    }


def _sort_nodes_topologically(G: nx.DiGraph, start_id: str, nodes: list[str]) -> list[str]:
    """
    Sort nodes by their topological distance from start_id.
    Uses shortest path length to determine order.
    """
    if not nodes:
        return []
    
    # Get shortest path lengths from start
    try:
        distances = nx.single_source_shortest_path_length(G, start_id)
    except nx.NetworkXError:
        # If start not in graph, return original order
        return nodes
    
    # Sort by distance (nodes not reachable go to end)
    def get_distance(node):
        return distances.get(node, float('inf'))
    
    return sorted(nodes, key=get_distance)


def _expected_additive_latency_between_nodes(
    G: nx.DiGraph,
    start_id: str,
    end_id: str,
    pruning: Optional[PruningResult] = None,
) -> tuple[Optional[float], Optional[float]]:
    """
    Estimate the (probability-weighted) mean and "median" lag between two nodes.

    Notes:
    - We treat edge-level `latency.mean_lag_days` and `latency.median_lag_days` as additive along a path.
      This yields a useful, interpretable estimate for "how long does it take to get from A to B".
    - For median we apply the same additive expectation to `median_lag_days` (approximation).
    - Respects pruning (excluded edges + renormalisation factors) because pruning defines the allowed flows.
    """
    if start_id not in G or end_id not in G:
        return (None, None)

    excluded = pruning.excluded_edges if pruning else set()
    renorm = pruning.renorm_factors if pruning else {}

    # Restrict to nodes that are on some path start -> ... -> end (for speed + correctness).
    try:
        reachable_from_start = {start_id} | nx.descendants(G, start_id)
        can_reach_end = {end_id} | nx.ancestors(G, end_id)
        nodes_in_play = reachable_from_start & can_reach_end
        H = G.subgraph(nodes_in_play).copy()
    except Exception:
        H = G

    # Topological order (DagNet graphs are expected DAG-ish).
    try:
        topo = list(nx.topological_sort(H))
    except Exception:
        topo = list(H.nodes)

    # Probability mass reaching each node.
    P: dict[str, float] = {n: 0.0 for n in topo}
    P[start_id] = 1.0

    # Weighted cumulative lag sums: Sum_over_paths (path_prob * path_lag).
    T_mean: dict[str, float] = {n: 0.0 for n in topo}
    T_median: dict[str, float] = {n: 0.0 for n in topo}

    for u in topo:
        p_u = P.get(u, 0.0) or 0.0
        if p_u == 0.0:
            continue
        if u == end_id:
            continue

        for _, v, data in H.out_edges(u, data=True):
            edge = (u, v)
            if edge in excluded:
                continue

            p_edge = float((data or {}).get('p') or 0.0)
            if edge in renorm:
                p_edge *= renorm[edge]
            if p_edge == 0.0:
                continue

            w = p_u * p_edge

            latency = (data or {}).get('latency') or {}
            edge_mean = latency.get('mean_lag_days') or 0.0
            edge_median = latency.get('median_lag_days') or 0.0

            P[v] = (P.get(v, 0.0) or 0.0) + w
            T_mean[v] = (T_mean.get(v, 0.0) or 0.0) + (T_mean.get(u, 0.0) or 0.0) * p_edge + w * float(edge_mean)
            T_median[v] = (T_median.get(v, 0.0) or 0.0) + (T_median.get(u, 0.0) or 0.0) * p_edge + w * float(edge_median)

    p_end = P.get(end_id, 0.0) or 0.0
    if p_end == 0.0:
        return (None, None)

    mean_lag = (T_mean.get(end_id, 0.0) or 0.0) / p_end
    median_lag = (T_median.get(end_id, 0.0) or 0.0) / p_end
    return (median_lag, mean_lag)


def _make_group_stage_id(member_ids: list[str]) -> str:
    """Build a deterministic composite stage ID for a visitedAny group."""
    return 'visitedAny:' + ','.join(sorted(member_ids))


def _build_stage_slots(
    G: nx.DiGraph,
    start_id: str,
    end_id: str,
    intermediate_nodes: list[str],
    visited_any_groups: Optional[list[list[str]]],
) -> list:
    """
    Build an ordered list of stage slots from intermediates and visitedAny groups.

    Each slot is either:
      - a str (single node ID) for a plain intermediate
      - a list[str] (member node IDs) for a visitedAny group

    Returns [start_id, ...slots..., end_id].
    """
    groups = visited_any_groups or []

    # Identify which intermediates belong to a group
    grouped_node_ids: set[str] = set()
    for group in groups:
        grouped_node_ids.update(group)

    # Solo intermediates (not part of any group)
    solo = [n for n in intermediate_nodes if n not in grouped_node_ids]

    # Build mixed slot list: solo nodes + groups
    slots: list = list(solo)
    for group in groups:
        # Only include group members that are actually in the intermediates list
        intermediates_set = set(intermediate_nodes)
        members_in_intermediates = [m for m in group if m in intermediates_set]
        if len(members_in_intermediates) <= 1:
            # Degenerate single-member group: treat as plain stage
            slots.extend(members_in_intermediates)
        else:
            slots.append(members_in_intermediates)

    # Sort slots topologically by distance from start
    try:
        distances = nx.single_source_shortest_path_length(G, start_id)
    except nx.NetworkXError:
        distances = {}

    def slot_distance(slot):
        if isinstance(slot, list):
            # Group: use min distance across members
            return min((distances.get(m, float('inf')) for m in slot), default=float('inf'))
        return distances.get(slot, float('inf'))

    slots.sort(key=slot_distance)

    return [start_id] + slots + [end_id]


def _detect_branch_specific_intermediates(
    G: nx.DiGraph,
    stage_slots: list,
) -> list[dict]:
    """
    Detect non-group intermediates that are only reachable from a subset of
    a preceding visitedAny group's members. Returns a list of warning dicts.
    """
    warnings = []
    seen_groups = []

    for slot in stage_slots:
        if isinstance(slot, list):
            seen_groups.append(slot)
        elif isinstance(slot, str) and seen_groups:
            # Check reachability from all preceding groups
            for group in seen_groups:
                reachable_from = [m for m in group if nx.has_path(G, m, slot)]
                if 0 < len(reachable_from) < len(group):
                    node_label = G.nodes[slot].get('label') or slot if slot in G else slot
                    reachable_labels = [
                        (G.nodes[m].get('label') or m) if m in G else m
                        for m in reachable_from
                    ]
                    warnings.append({
                        'type': 'branch_specific_intermediate',
                        'node': slot,
                        'reachable_from': reachable_from,
                        'group': list(group),
                        'message': f'Stage "{node_label}" is only reachable via {", ".join(reachable_labels)}, not all branches',
                    })
    return warnings


def run_path(
    G: nx.DiGraph,
    start_id: str,
    end_id: str,
    intermediate_nodes: list[str] = None,
    pruning: Optional[PruningResult] = None,
    all_scenarios: Optional[list] = None,
    visited_any_groups: Optional[list[list[str]]] = None,
) -> dict[str, Any]:
    """
    Calculate path between two nodes with optional intermediate constraints.
    
    Returns declarative schema with stage-first structure for funnel visualization.
    See: /docs/current/project-analysis/ANALYSIS_RETURN_SCHEMA.md
    
    LAG support: includes forecast_mean, evidence_mean, and completeness fields
    when available on edges, conditional upon scenario visibility_mode.
    """
    intermediate_nodes = intermediate_nodes or []

    # Get labels from primary graph
    from_label = G.nodes[start_id].get('label') or start_id if start_id in G else start_id
    to_label = G.nodes[end_id].get('label') or end_id if end_id in G else end_id

    # Build stage slots (supports grouped stages from visitedAny)
    has_groups = visited_any_groups and any(len(g) > 1 for g in visited_any_groups)
    if has_groups:
        stage_slots = _build_stage_slots(G, start_id, end_id, intermediate_nodes, visited_any_groups)
        branch_warnings = _detect_branch_specific_intermediates(G, stage_slots)
    else:
        # Legacy path: flat stage_ids
        sorted_intermediates = _sort_nodes_topologically(G, start_id, intermediate_nodes)
        stage_slots = [start_id] + sorted_intermediates + [end_id]
        branch_warnings = []

    # Build stage entries: (stage_key, member_node_ids, is_group) tuples
    stage_entries: list[tuple[str, list[str], bool]] = []
    for slot in stage_slots:
        if isinstance(slot, list):
            stage_key = _make_group_stage_id(slot)
            stage_entries.append((stage_key, slot, True))
        else:
            stage_entries.append((slot, [slot], False))

    # Flat stage_ids for iteration (one key per logical stage)
    stage_ids = [key for key, _, _ in stage_entries]

    # Flat list of intermediate node IDs for metadata
    sorted_intermediates_meta = []
    for key, members, is_group in stage_entries:
        if key != start_id and key != end_id:
            sorted_intermediates_meta.extend(members)

    prepared_scenarios = _prepare_scenarios(G, all_scenarios)
    scenario_count = len(prepared_scenarios)

    # Build dimension_values for stages and scenarios
    stage_dimension_values = {}
    scenario_dimension_values = {}

    for i, (stage_key, members, is_group) in enumerate(stage_entries):
        if is_group:
            member_labels = {}
            label_parts = []
            for m in members:
                lbl = G.nodes[m].get('label') or m if m in G else m
                member_labels[m] = lbl
                label_parts.append(lbl)
            stage_dimension_values[stage_key] = {
                'name': ' / '.join(label_parts),
                'order': i,
                'is_group': True,
                'members': list(members),
                'member_labels': member_labels,
            }
        else:
            stage_label = G.nodes[stage_key].get('label') if stage_key in G else None
            stage_dimension_values[stage_key] = {
                'name': stage_label or stage_key,
                'order': i,
            }
    
    for s in prepared_scenarios:
        scenario_dimension_values[s['scenario_id']] = {
            'name': s['scenario_name'],
            'colour': s['scenario_colour'],
            'visibility_mode': s['visibility_mode'],
            'probability_label': s['probability_label'],
        }

    # Start population N per scenario (used for stage-0 n and cumulative evidence probability).
    start_n_by_scenario_id: dict[str, int] = {}
    for s in prepared_scenarios:
        scenario_G = s['scenario_G']
        scenario_id = s['scenario_id']
        max_n_for_start = None
        if start_id in scenario_G:
            for succ in scenario_G.successors(start_id):
                edge_evidence = (scenario_G.edges[start_id, succ].get('evidence') or {})
                edge_n = edge_evidence.get('n')
                if edge_n is None:
                    continue
                max_n_for_start = edge_n if max_n_for_start is None else max(max_n_for_start, edge_n)
        if max_n_for_start is not None:
            start_n_by_scenario_id[scenario_id] = max_n_for_start
    
    # Build flat data rows (stage × scenario), supporting grouped stages.
    # Track previous stage total probability per scenario for dropoff/step_probability.
    prev_stage_total_prob: dict[str, float] = {}  # scenario_id -> probability
    data_rows = []

    for i, (stage_key, member_nodes, is_group) in enumerate(stage_entries):
        # For each member node in this stage (1 for solo, N for groups)
        for member_idx, node_id in enumerate(member_nodes):
            for s in prepared_scenarios:
                scenario_G = s['scenario_G']
                scenario_id = s['scenario_id']
                scenario_name = s['scenario_name']
                visibility_mode = s['visibility_mode']
                p_label = s['probability_label']

                # Calculate probability to reach this node from start
                if i == 0:
                    prob = 1.0
                    cost_gbp = 0.0
                    labour_cost = 0.0
                    median_lag_days = 0.0
                    mean_lag_days = 0.0
                    step_probability = None
                else:
                    result = calculate_path_probability(scenario_G, start_id, node_id, pruning)
                    prob = result.probability
                    cost_gbp = result.expected_cost_gbp
                    labour_cost = result.expected_labour_cost

                    median_lag_days = None
                    mean_lag_days = None

                    # Stage-level evidence and latency summary
                    inbound_edges = []
                    if node_id in scenario_G:
                        inbound_edges = [(pred, node_id) for pred in scenario_G.predecessors(node_id)]

                    total_inbound_k = 0
                    has_any_inbound_k = False
                    completeness_weighted_sum = 0.0
                    completeness_weight_total = 0.0
                    completeness_min = None
                    median_lag_weighted_sum = 0.0
                    median_lag_weight_total = 0.0
                    mean_lag_weighted_sum = 0.0
                    mean_lag_weight_total = 0.0

                    for (pred, node) in inbound_edges:
                        edge_data = scenario_G.edges.get((pred, node), {}) or {}
                        evidence = edge_data.get('evidence') or {}
                        latency = edge_data.get('latency') or {}

                        k = evidence.get('k')
                        if k is not None:
                            has_any_inbound_k = True
                            total_inbound_k += k

                        comp = latency.get('completeness')
                        if comp is not None:
                            completeness_min = comp if completeness_min is None else min(completeness_min, comp)
                            if k is not None and k > 0:
                                completeness_weighted_sum += comp * k
                                completeness_weight_total += k

                        med = latency.get('median_lag_days')
                        if med is not None and k is not None and k > 0:
                            median_lag_weighted_sum += med * k
                            median_lag_weight_total += k

                        mean = latency.get('mean_lag_days')
                        if mean is not None and k is not None and k > 0:
                            mean_lag_weighted_sum += mean * k
                            mean_lag_weight_total += k

                    arrivals_n = total_inbound_k if has_any_inbound_k else None

                    if median_lag_weight_total > 0:
                        median_lag_days = median_lag_weighted_sum / median_lag_weight_total
                    if mean_lag_weight_total > 0:
                        mean_lag_days = mean_lag_weighted_sum / mean_lag_weight_total

                    completeness = None
                    if visibility_mode in ('e', 'f+e'):
                        if completeness_weight_total > 0:
                            completeness = completeness_weighted_sum / completeness_weight_total
                        else:
                            completeness = completeness_min

                    evidence_mean = None
                    forecast_mean = None
                    p_mean = None

                    # Gap metrics: for groups, use start→member; for solo, use prev_stage→stage
                    if not is_group and i > 0:
                        prev_stage_key = stage_ids[i - 1]
                        # For prev stage that was a group, use first member for lag estimate
                        prev_entry = stage_entries[i - 1]
                        prev_node = prev_entry[1][0] if prev_entry[2] else prev_stage_key
                        seg_median, seg_mean = _expected_additive_latency_between_nodes(scenario_G, prev_node, node_id, pruning)
                        if seg_median is not None:
                            median_lag_days = seg_median
                        if seg_mean is not None:
                            mean_lag_days = seg_mean

                # Calculate dropoff/step_probability from previous stage total
                dropoff = None
                step_probability = None
                prev_total = prev_stage_total_prob.get(scenario_id)
                if i > 0 and prev_total is not None and prev_total > 0:
                    dropoff = prev_total - prob
                    step_probability = prob / prev_total

                row = {
                    'stage': stage_key,
                    'scenario_id': scenario_id,
                    'scenario_name': scenario_name,
                    'visibility_mode': visibility_mode,
                    'probability_label': p_label,
                    'probability': prob,
                    'expected_cost_gbp': cost_gbp,
                    'expected_labour_cost': labour_cost,
                }

                # Add stage_member field for grouped stages
                if is_group:
                    row['stage_member'] = node_id

                # First stage conventions: 100% and show start population N as "n".
                if i == 0:
                    start_n = start_n_by_scenario_id.get(scenario_id)
                    if start_n is not None:
                        row['n'] = start_n

                    if visibility_mode in ('e', 'f+e'):
                        row['evidence_mean'] = 1.0
                        row['completeness'] = 1.0
                    if visibility_mode == 'f':
                        row['forecast_mean'] = 1.0
                    if visibility_mode == 'f+e':
                        row['p_mean'] = 1.0

                    row['median_lag_days'] = 0.0
                    row['mean_lag_days'] = 0.0
                else:
                    if visibility_mode in ('e', 'f+e') and arrivals_n is not None:
                        row['n'] = arrivals_n

                    if visibility_mode in ('e', 'f+e'):
                        start_n = start_n_by_scenario_id.get(scenario_id)
                        if isinstance(start_n, (int, float)) and start_n and arrivals_n is not None:
                            row['evidence_mean'] = arrivals_n / float(start_n)

                    # Edge-direct forecast/evidence for non-group stages
                    if not is_group and i > 0:
                        prev_entry = stage_entries[i - 1]
                        prev_node = prev_entry[1][0] if prev_entry[2] else stage_ids[i - 1]
                        if prev_node in scenario_G and node_id in scenario_G and scenario_G.has_edge(prev_node, node_id):
                            edge_data_direct = scenario_G.edges.get((prev_node, node_id), {}) or {}
                            direct_forecast = edge_data_direct.get('forecast') or {}
                            direct_forecast_mean = direct_forecast.get('mean')
                            if direct_forecast_mean is not None:
                                row['forecast_mean'] = direct_forecast_mean
                            if 'evidence_mean' not in row:
                                direct_evidence = edge_data_direct.get('evidence') or {}
                                direct_evidence_mean = direct_evidence.get('mean')
                                if direct_evidence_mean is not None:
                                    row['evidence_mean'] = direct_evidence_mean

                    if visibility_mode == 'f+e':
                        row['p_mean'] = prob

                    if completeness is not None:
                        row['completeness'] = completeness

                    if median_lag_days is not None:
                        row['median_lag_days'] = median_lag_days
                    if mean_lag_days is not None:
                        row['mean_lag_days'] = mean_lag_days

                if dropoff is not None:
                    row['dropoff'] = dropoff
                if step_probability is not None:
                    row['step_probability'] = step_probability

                data_rows.append(row)

        # After processing all members of this stage, update prev_stage_total_prob.
        # For groups: sum of member probabilities. For solo: the single probability.
        for s in prepared_scenarios:
            scenario_id = s['scenario_id']
            scenario_G = s['scenario_G']
            if i == 0:
                prev_stage_total_prob[scenario_id] = 1.0
            else:
                total = 0.0
                for node_id in member_nodes:
                    result = calculate_path_probability(scenario_G, start_id, node_id, pruning)
                    total += result.probability
                prev_stage_total_prob[scenario_id] = total

    # Build metadata
    metadata: dict[str, Any] = {
        'from_node': start_id,
        'from_label': from_label,
        'to_node': end_id,
        'to_label': to_label,
        'intermediate_nodes': sorted_intermediates_meta,
    }
    if branch_warnings:
        metadata['warnings'] = branch_warnings

    return {
        'metadata': metadata,
        'semantics': {
            'dimensions': [
                {'id': 'stage', 'name': 'Stage', 'type': 'stage', 'role': 'primary'},
                {'id': 'scenario_id', 'name': 'Scenario', 'type': 'scenario', 'role': 'secondary'},
            ],
            'metrics': [
                {'id': 'probability', 'name': 'Cum. probability', 'type': 'probability', 'format': 'percent', 'role': 'primary'},
                {'id': 'n', 'name': 'n', 'type': 'count', 'format': 'number'},
                {'id': 'evidence_mean', 'name': 'Evidence probability', 'type': 'probability', 'format': 'percent'},
                {'id': 'forecast_mean', 'name': 'Forecast probability', 'type': 'probability', 'format': 'percent'},
                {'id': 'p_mean', 'name': 'Blended probability', 'type': 'probability', 'format': 'percent'},
                {'id': 'completeness', 'name': 'Completeness', 'type': 'ratio', 'format': 'percent'},
                {'id': 'median_lag_days', 'name': 'Median lag (days)', 'type': 'number', 'format': 'number'},
                {'id': 'mean_lag_days', 'name': 'Mean lag (days)', 'type': 'number', 'format': 'number'},
                {'id': 'step_probability', 'name': 'Step probability', 'type': 'probability', 'format': 'percent'},
                {'id': 'dropoff', 'name': 'Dropoff', 'type': 'probability', 'format': 'percent'},
                {'id': 'expected_cost_gbp', 'name': 'Expected Cost (£)', 'type': 'currency', 'format': 'currency_gbp'},
                {'id': 'expected_labour_cost', 'name': 'Expected Cost (Labour)', 'type': 'duration', 'format': 'number'},
            ],
            'chart': {
                'recommended': 'funnel',
                # Bridge is a useful "step delta" view (waterfall) for funnels.
                'alternatives': ['bridge', 'bar_grouped', 'table'],
                'hints': {'show_dropoff': True}
            }
        },
        'dimension_values': {
            'stage': stage_dimension_values,
            'scenario_id': scenario_dimension_values,
        },
        'data': data_rows,
    }


def _scoped_conditioned_forecast(
    scenarios_payload: list[dict[str, Any]],
) -> dict[str, Any]:
    """Invoke handle_conditioned_forecast scoped to the funnel path.

    Direct Python call (same process, no HTTP). Each scenario in the
    payload carries its own graph dict, analytics_dsl (path subject),
    and effective_query_dsl (temporal clause). See doc 52 §4.2.

    Returns the CF response dict with per-scenario edge scalars.
    """
    from api_handlers import handle_conditioned_forecast
    return handle_conditioned_forecast({'scenarios': scenarios_payload})


def _find_raw_edge_in_scenario_graph(
    scenario_graph: dict[str, Any],
    from_key: str,
    to_key: str,
) -> Optional[dict[str, Any]]:
    """Find the raw edge dict for the given (from, to) in the scenario's raw graph.

    `from_key` and `to_key` may be UUIDs or human IDs. The scenario graph
    stores edges with `from` / `to` as UUIDs typically. Matches on either
    field.
    """
    for e in scenario_graph.get('edges', []) or []:
        ef = e.get('from') or e.get('from_node')
        et = e.get('to') or e.get('to_node')
        if (ef == from_key or ef == to_key) and (et == to_key or et == from_key):
            # Belt-and-braces: match either direction
            if ef == from_key and et == to_key:
                return e
    # Second pass: strict direction match (some graphs use different key conventions)
    for e in scenario_graph.get('edges', []) or []:
        ef = e.get('from') or e.get('from_node')
        et = e.get('to') or e.get('to_node')
        if ef == from_key and et == to_key:
            return e
    return None


def run_conversion_funnel(
    G: nx.DiGraph,
    start_id: str,
    end_id: str,
    intermediate_nodes: list[str] = None,
    all_scenarios: Optional[list] = None,
    visited_any_groups: Optional[list[list[str]]] = None,
    from_node: Optional[str] = None,
    to_node: Optional[str] = None,
) -> dict[str, Any]:
    """Conversion funnel — Level 2 per doc 52.

    Bar heights and uncertainty bands are computed by `runner/funnel_engine.py`
    per regime (e / f / e+f). Run_path supplies the surrounding row schema
    (cost, lag, completeness, dropoff). The runner overrides `probability`
    with the engine's bar value and adds `probability_lo`/`probability_hi`
    plus striation fields.

    Doc 52 §8.4: non-linear topologies and visitedAny groups are rejected
    (returns `error`). CF failures in e+f mode propagate as hard errors —
    no silent fallback.

    Args:
        G: NetworkX graph.
        start_id, end_id: resolved UUIDs for S_0 and S_N.
        intermediate_nodes: resolved UUIDs for intermediate stages.
        all_scenarios: list of ScenarioData objects.
        visited_any_groups: grouped stages (visitedAny). Rejected.
        from_node, to_node: human-readable node IDs (from DSL) used to
            construct `analytics_dsl` for the scoped CF call.
    """
    from .funnel_engine import (
        compute_bars_e,
        compute_bars_ef,
        compute_bars_f,
    )

    intermediate_nodes = intermediate_nodes or []

    # ── Always emit baseline (run_path) so the chart never goes blank ──
    # Bands and striation are added on top when topology supports it.
    result = run_path(
        G, start_id, end_id, intermediate_nodes, pruning=None,
        all_scenarios=all_scenarios, visited_any_groups=visited_any_groups,
    )
    if isinstance(result, dict) and result.get('error'):
        return result

    md = result.setdefault('metadata', {})
    md['is_conversion_funnel'] = True
    md['description'] = 'Conversion funnel with hi/lo bars (doc 52 Level 2)'

    # ── Topology gate for Level 2 augmentation (doc 52 §8.2) ──────
    # Non-linear funnels and visitedAny grouped stages are deferred per
    # §8.2 — emit the baseline rows without bands rather than failing.
    band_skip_reason: Optional[str] = None
    if visited_any_groups and any(len(g) > 1 for g in visited_any_groups):
        band_skip_reason = 'visitedAny grouped stages not yet supported (doc 52 §8.2)'

    sorted_intermediates = _sort_nodes_topologically(G, start_id, intermediate_nodes)
    stage_ids: list[str] = [start_id] + sorted_intermediates + [end_id]

    path_edge_uvs: list[tuple[str, str]] = []
    if band_skip_reason is None:
        for i in range(len(stage_ids) - 1):
            u, v = stage_ids[i], stage_ids[i + 1]
            if not G.has_edge(u, v):
                band_skip_reason = (
                    f'non-linear topology between consecutive funnel stages '
                    f'(no direct edge {u}→{v})'
                )
                path_edge_uvs = []
                break
            path_edge_uvs.append((u, v))

    if band_skip_reason is not None:
        md['hi_lo_bands_skipped'] = band_skip_reason
        return result

    # Labels for DSL construction (CF call)
    # Resolve human IDs for each stage node (used to pair CF response edges
    # to the funnel path's edge sequence). CF returns edges keyed by
    # (from_node, to_node) human IDs, not UUIDs.
    def _stage_label(node_id: str) -> str:
        if node_id in G:
            return str(G.nodes[node_id].get('id') or G.nodes[node_id].get('label') or node_id)
        return str(node_id)
    stage_labels = [_stage_label(s) for s in stage_ids]
    path_edge_labels: list[tuple[str, str]] = list(zip(stage_labels[:-1], stage_labels[1:]))

    # ── Pre-fetch whole-graph CF response for any e+f scenarios ────
    # We use whole-graph mode (no analytics_dsl) so CF enriches every
    # parameterised edge; we then pick out the funnel-path edges in
    # order. Calling with .visited()-decorated DSL only enriches the
    # end-to-end subject (1 edge), which doesn't match a multi-hop funnel.
    cf_responses_by_scenario: dict[str, list[dict[str, Any]]] = {}
    ef_scenarios_payload: list[dict[str, Any]] = []
    scenario_raw_graph_by_id: dict[str, dict[str, Any]] = {}

    if all_scenarios:
        for sc in all_scenarios:
            scenario_raw_graph_by_id[sc.scenario_id] = sc.graph
            effective_dsl = getattr(sc, 'effective_query_dsl', '') or ''
            visibility = getattr(sc, 'visibility_mode', 'f+e') or 'f+e'
            if visibility == 'f+e':
                ef_scenarios_payload.append({
                    'scenario_id': sc.scenario_id,
                    'graph': sc.graph,
                    # No analytics_dsl → whole-graph enrichment (mode b).
                    # CF needs candidate_regimes_by_edge to resolve subjects
                    # in mode b (all_graph_parameters).
                    'effective_query_dsl': effective_dsl,
                    'candidate_regimes_by_edge': getattr(sc, 'candidate_regimes_by_edge', None) or {},
                })

    cf_skip_reason: Optional[str] = None
    if ef_scenarios_payload:
        print(f'[funnel-L2] CF call: {len(ef_scenarios_payload)} f+e scenarios, '
              f'expecting {len(path_edge_labels)} edges per scenario for path '
              f'{path_edge_labels}')
        try:
            cf_response = _scoped_conditioned_forecast(ef_scenarios_payload)
        except Exception as exc:
            cf_skip_reason = f'Scoped CF call failed: {exc}'
            cf_response = None
            print(f'[funnel-L2] CF FAILED: {exc}')
        if cf_response is not None:
            # CF returns ALL graph edges in arbitrary order. Pair each
            # funnel-path edge (from_label, to_label) with its CF entry.
            for sc_result in cf_response.get('scenarios', []) or []:
                sid = sc_result.get('scenario_id', '')
                all_cf_edges = sc_result.get('edges', []) or []
                cf_by_pair = {
                    (e.get('from_node'), e.get('to_node')): e for e in all_cf_edges
                }
                print(f'[funnel-L2] scenario={sid} CF returned {len(all_cf_edges)} edges; '
                      f'keys sample: {list(cf_by_pair.keys())[:5]}')
                ordered: list[dict[str, Any]] = []
                missing: list[tuple[str, str]] = []
                for (fl, tl) in path_edge_labels:
                    e = cf_by_pair.get((fl, tl))
                    if e is None:
                        missing.append((fl, tl))
                    else:
                        ordered.append(e)
                if missing:
                    md.setdefault('hi_lo_bands_skipped_per_scenario', {})[sid] = (
                        f'CF response missing {len(missing)} funnel-path edge(s): '
                        f'{[f"{f}->{t}" for f, t in missing]}'
                    )
                    print(f'[funnel-L2] scenario={sid} MISSING {len(missing)} edges: {missing}')
                else:
                    cf_responses_by_scenario[sid] = ordered
                    print(f'[funnel-L2] scenario={sid} aligned {len(ordered)} edges OK; '
                          f'p_means={[e.get("p_mean") for e in ordered]}')
    if cf_skip_reason is not None:
        md['cf_skip_reason'] = cf_skip_reason

    # ── Compute bars per scenario and merge over existing rows ─────
    rows_by_key: dict[tuple, dict[str, Any]] = {}
    for row in result.get('data') or []:
        key = (row.get('stage'), row.get('scenario_id'))
        rows_by_key[key] = row

    prepared = _prepare_scenarios(G, all_scenarios)
    for s in prepared:
        scenario_id = s['scenario_id']
        visibility_mode = s['visibility_mode']

        raw_graph = scenario_raw_graph_by_id.get(scenario_id)
        path_edges_raw: list[dict[str, Any]] = []
        for (u, v) in path_edge_uvs:
            if raw_graph is not None:
                raw_edge = _find_raw_edge_in_scenario_graph(raw_graph, u, v) or {'p': {}}
            else:
                attrs = G.edges[u, v]
                raw_edge = {'p': {
                    'evidence': attrs.get('evidence') or {},
                    'forecast': attrs.get('forecast') or {},
                    'latency': attrs.get('latency') or {},
                }}
            path_edges_raw.append(raw_edge)

        try:
            bars_e_data = compute_bars_e(path_edges_raw)
            if visibility_mode == 'e':
                bars = bars_e_data
            elif visibility_mode == 'f':
                bars = compute_bars_f(path_edges_raw, temporal_mode='window')
            elif visibility_mode == 'f+e':
                cf_edges = cf_responses_by_scenario.get(scenario_id)
                if not cf_edges or len(cf_edges) != len(path_edge_uvs):
                    # No valid CF for this scenario — leave baseline rows untouched
                    continue
                bars = compute_bars_ef(cf_edges, bars_e_data.bar)
            else:
                continue
        except Exception as exc:
            md.setdefault('hi_lo_bands_skipped_per_scenario', {})[scenario_id] = (
                f'Engine error: {exc}'
            )
            continue

        # Override probability/p_mean/evidence_mean with engine values so
        # the FE chart driver consumes Level 2 numbers. Set striation
        # fields too so consumers (current `evidence_mean`/`p_mean`-based
        # stack and future `bar_height_*`-based stack) both work.
        for i, stage_id in enumerate(stage_ids):
            row = rows_by_key.get((stage_id, scenario_id))
            if row is None:
                continue

            row['probability'] = bars.bar[i]

            if bars.lo[i] is not None:
                row['probability_lo'] = bars.lo[i]
            if bars.hi[i] is not None:
                row['probability_hi'] = bars.hi[i]

            if visibility_mode == 'e':
                row['evidence_mean'] = bars.bar[i]
            elif visibility_mode == 'f':
                row['forecast_mean'] = bars.bar[i]
            elif visibility_mode == 'f+e':
                # p_mean drives the FE stacked-bar total; evidence_mean
                # drives the solid e portion.
                row['p_mean'] = bars.bar[i]
                if bars.bar_e is not None:
                    row['evidence_mean'] = bars.bar_e[i]
                    row['bar_height_e'] = bars.bar_e[i]
                if bars.bar_f_residual is not None:
                    row['bar_height_f_residual'] = bars.bar_f_residual[i]

        # Re-derive step_probability/dropoff from the engine bars so they
        # stay consistent with the new probability values.
        prev = None
        for i, stage_id in enumerate(stage_ids):
            row = rows_by_key.get((stage_id, scenario_id))
            if row is None:
                prev = None
                continue
            if i == 0:
                prev = bars.bar[i]
                row.pop('step_probability', None)
                row.pop('dropoff', None)
                continue
            if prev is not None and prev > 0:
                row['step_probability'] = bars.bar[i] / prev
                row['dropoff'] = max(0.0, prev - bars.bar[i])
            prev = bars.bar[i]

    # Advertise the new metrics in semantics so chart builders can discover them
    sem = result.setdefault('semantics', {})
    metrics = sem.setdefault('metrics', [])
    existing_ids = {m.get('id') for m in metrics}
    new_metrics = [
        {'id': 'probability_lo', 'name': '5% band', 'type': 'probability', 'format': 'percent'},
        {'id': 'probability_hi', 'name': '95% band', 'type': 'probability', 'format': 'percent'},
        {'id': 'bar_height_e', 'name': 'Observed portion', 'type': 'probability', 'format': 'percent'},
        {'id': 'bar_height_f_residual', 'name': 'Forecast portion', 'type': 'probability', 'format': 'percent'},
    ]
    for m in new_metrics:
        if m['id'] not in existing_ids:
            metrics.append(m)
    # Chart hints
    chart = sem.setdefault('chart', {})
    hints = chart.setdefault('hints', {})
    hints['show_hi_lo'] = True
    hints['stacked_striation'] = True

    return result


def run_partial_path(
    G: nx.DiGraph,
    start_id: str,
    intermediate_nodes: list[str],
    pruning: Optional[PruningResult] = None,
    all_scenarios: Optional[list] = None,
) -> dict[str, Any]:
    """
    Analyze partial path from start through intermediates.
    New declarative schema: scenario-first with outcome secondary.
    
    LAG support: includes visibility_mode per scenario for UI adaptors.
    """
    from_label = G.nodes[start_id].get('label') or start_id if start_id in G else start_id
    
    # Get absorbing nodes for outcome dimension
    absorbing_nodes = find_absorbing_nodes(G)
    outcome_dimension_values = {}
    for i, absorbing in enumerate(absorbing_nodes):
        outcome_label = G.nodes[absorbing].get('label') or absorbing if absorbing in G else absorbing
        outcome_dimension_values[absorbing] = {
            'name': outcome_label,
            'order': i
        }
    
    prepared_scenarios = _prepare_scenarios(G, all_scenarios)
    scenario_dimension_values = {}
    data_rows = []

    for s in prepared_scenarios:
        scenario_G = s['scenario_G']
        scenario_id = s['scenario_id']
        scenario_name = s['scenario_name']
        visibility_mode = s['visibility_mode']

        scenario_dimension_values[scenario_id] = {
            'name': scenario_name,
            'colour': s['scenario_colour'],
            'visibility_mode': visibility_mode,
            'probability_label': s['probability_label'],
        }

        for absorbing in absorbing_nodes:
            result = calculate_path_probability(scenario_G, start_id, absorbing, pruning)
            if result.probability > 0:
                data_rows.append({
                    'scenario_id': scenario_id,
                    'scenario_name': scenario_name,
                    'visibility_mode': visibility_mode,
                    'outcome': absorbing,
                    'probability': result.probability,
                    'expected_cost_gbp': result.expected_cost_gbp,
                    'expected_labour_cost': result.expected_labour_cost,
                })
    
    return {
        'metadata': {
            'from_node': start_id,
            'from_label': from_label,
            'intermediate_nodes': intermediate_nodes,
        },
        'semantics': {
            'dimensions': [
                {'id': 'scenario_id', 'name': 'Scenario', 'type': 'scenario', 'role': 'primary'},
                {'id': 'outcome', 'name': 'Outcome', 'type': 'node', 'role': 'secondary'},
            ],
            'metrics': [
                {'id': 'probability', 'name': 'Probability', 'type': 'probability', 'format': 'percent', 'role': 'primary'},
                {'id': 'expected_cost_gbp', 'name': 'Expected Cost (£)', 'type': 'currency', 'format': 'currency_gbp'},
                {'id': 'expected_labour_cost', 'name': 'Expected Cost (Labour)', 'type': 'duration', 'format': 'number'},
            ],
            'chart': {
                'recommended': 'bar_grouped',
                'alternatives': ['pie', 'table', 'time_series'],
            }
        },
        'dimension_values': {
            'scenario_id': scenario_dimension_values,
            'outcome': outcome_dimension_values,
        },
        'data': data_rows,
    }


def run_general_stats(
    G: nx.DiGraph,
    node_keys: list[str],
    pruning: Optional[PruningResult] = None,
    all_scenarios: Optional[list] = None,
) -> dict[str, Any]:
    """
    General statistics for arbitrary node selection.
    New declarative schema: node-first with scenario secondary.
    
    LAG support: includes visibility_mode per scenario for UI adaptors.
    
    Args:
        node_keys: Graph keys (UUIDs), already resolved by dispatcher
    """
    # Build node dimension values (using human IDs for output)
    node_dimension_values = {}
    for i, graph_key in enumerate(node_keys):
        if graph_key in G:
            node_data = G.nodes[graph_key]
            node_label = node_data.get('label') or node_data.get('id') or graph_key
            human_id = node_data.get('id') or graph_key  # Use human ID for output
            node_type = 'middle'
            if node_data.get('is_entry'):
                node_type = 'entry'
            elif node_data.get('absorbing'):
                node_type = 'absorbing'
        else:
            human_id = graph_key
            node_label = graph_key
            node_type = 'unknown'
        
        node_dimension_values[human_id] = {
            'name': node_label,
            'type': node_type,
            'order': i
        }
    
    prepared_scenarios = _prepare_scenarios(G, all_scenarios)
    scenario_dimension_values = {}
    data_rows = []

    for s in prepared_scenarios:
        scenario_G = s['scenario_G']
        scenario_id = s['scenario_id']
        scenario_name = s['scenario_name']
        visibility_mode = s['visibility_mode']

        scenario_dimension_values[scenario_id] = {
            'name': scenario_name,
            'colour': s['scenario_colour'],
            'visibility_mode': visibility_mode,
            'probability_label': s['probability_label'],
        }

        for graph_key in node_keys:
            if graph_key not in scenario_G:
                continue
            node_data = scenario_G.nodes[graph_key]
            human_id = node_data.get('id') or graph_key
            result = calculate_path_through_node(scenario_G, graph_key, pruning)
            data_rows.append({
                'node': human_id,
                'scenario_id': scenario_id,
                'scenario_name': scenario_name,
                'visibility_mode': visibility_mode,
                'path_through_probability': result.probability,
            })
    
    # Get human IDs for metadata
    human_ids = [G.nodes[k].get('id') or k for k in node_keys if k in G]
    
    return {
        'metadata': {
            'selected_nodes': human_ids,
        },
        'semantics': {
            'dimensions': [
                {'id': 'node', 'name': 'Node', 'type': 'node', 'role': 'primary'},
                {'id': 'scenario_id', 'name': 'Scenario', 'type': 'scenario', 'role': 'secondary'},
            ],
            'metrics': [
                {'id': 'path_through_probability', 'name': 'Path Through', 'type': 'probability', 'format': 'percent', 'role': 'primary'},
            ],
            'chart': {
                'recommended': 'bar_grouped',
                'alternatives': ['table'],
            }
        },
        'dimension_values': {
            'node': node_dimension_values,
            'scenario_id': scenario_dimension_values,
        },
        'data': data_rows,
    }


def run_graph_overview(
    G: nx.DiGraph,
    node_ids: list[str] = None,
    pruning: Optional[PruningResult] = None,
    all_scenarios: Optional[list] = None,
) -> dict[str, Any]:
    """
    Analyze entire graph without selection.
    
    Returns overall graph statistics and structure analysis.
    New declarative schema: outcome-first with scenario secondary.
    
    LAG support: includes visibility_mode per scenario for UI adaptors.
    """
    # Get outcome dimension values (absorbing nodes)
    absorbing_nodes = find_absorbing_nodes(G)
    outcome_dimension_values = {}
    for i, absorbing in enumerate(absorbing_nodes):
        outcome_label = G.nodes[absorbing].get('label') or absorbing if absorbing in G else absorbing
        outcome_dimension_values[absorbing] = {
            'name': outcome_label,
            'order': i
        }
    
    prepared_scenarios = _prepare_scenarios(G, all_scenarios)
    scenario_dimension_values = {}
    data_rows = []

    for s in prepared_scenarios:
        scenario_G = s['scenario_G']
        scenario_id = s['scenario_id']
        scenario_name = s['scenario_name']
        visibility_mode = s['visibility_mode']

        scenario_dimension_values[scenario_id] = {
            'name': scenario_name,
            'colour': s['scenario_colour'],
            'visibility_mode': visibility_mode,
            'probability_label': s['probability_label'],
        }

        entry_nodes = find_entry_nodes(scenario_G)

        for absorbing in absorbing_nodes:
            total_prob = 0.0
            total_cost_gbp = 0.0
            total_labour_cost = 0.0

            for entry in entry_nodes:
                entry_weight = scenario_G.nodes[entry].get('entry_weight', 1.0 / len(entry_nodes)) if entry_nodes else 0
                result = calculate_path_probability(scenario_G, entry, absorbing, pruning)
                total_prob += entry_weight * result.probability
                total_cost_gbp += entry_weight * result.expected_cost_gbp
                total_labour_cost += entry_weight * result.expected_labour_cost

            data_rows.append({
                'outcome': absorbing,
                'scenario_id': scenario_id,
                'scenario_name': scenario_name,
                'visibility_mode': visibility_mode,
                'probability': total_prob,
                'expected_cost_gbp': total_cost_gbp,
                'expected_labour_cost': total_labour_cost,
            })
    
    # Get graph stats from primary graph
    stats = get_graph_stats(G)
    entry_nodes = find_entry_nodes(G)
    
    return {
        'metadata': {
            'node_count': stats.get('node_count', 0),
            'edge_count': stats.get('edge_count', 0),
            'entry_nodes': [{'id': n, 'label': G.nodes[n].get('label') or n} for n in entry_nodes],
        },
        'semantics': {
            'dimensions': [
                {'id': 'outcome', 'name': 'Outcome', 'type': 'node', 'role': 'primary'},
                {'id': 'scenario_id', 'name': 'Scenario', 'type': 'scenario', 'role': 'secondary'},
            ],
            'metrics': [
                {'id': 'probability', 'name': 'Probability', 'type': 'probability', 'format': 'percent', 'role': 'primary'},
                {'id': 'expected_cost_gbp', 'name': 'Expected Cost (£)', 'type': 'currency', 'format': 'currency_gbp'},
                {'id': 'expected_labour_cost', 'name': 'Expected Cost (Labour)', 'type': 'duration', 'format': 'number'},
            ],
            'chart': {
                'recommended': 'bar_grouped',
                'alternatives': ['pie', 'table'],
                'hints': {
                    'sort': {'by': 'probability', 'order': 'desc'}  # Highest first
                }
            }
        },
        'dimension_values': {
            'outcome': outcome_dimension_values,
            'scenario_id': scenario_dimension_values,
        },
        'data': data_rows,
    }


# Runner dispatch table
RUNNERS = {
    'single_node_runner': run_single_node_entry,
    'path_to_end_runner': run_path_to_end,
    'path_through_runner': run_path_through,
    'end_comparison_runner': run_end_comparison,
    'branch_comparison_runner': run_branch_comparison,
    'path_runner': run_path,
    'conversion_funnel_runner': run_conversion_funnel,
    'partial_path_runner': run_partial_path,
    'general_stats_runner': run_general_stats,
    'graph_overview_runner': run_graph_overview,
}


def get_runner(runner_name: str):
    """Get runner function by name."""
    return RUNNERS.get(runner_name)

