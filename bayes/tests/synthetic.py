"""
Synthetic graph and evidence generators for compiler parameter recovery tests.

Each builder produces:
  - graph_snapshot: dict matching the format analyse_topology() expects
  - param_files: dict of param_id → param file data with values[] entries
  - ground_truth: dict of edge_id → true probability (for recovery checks)

Evidence is generated from Binomial/Multinomial draws with a fixed seed.
"""

from __future__ import annotations

import uuid
import numpy as np


# ---------------------------------------------------------------------------
# Node / edge helpers
# ---------------------------------------------------------------------------

def _node(
    node_id: str,
    *,
    is_start: bool = False,
    absorbing: bool = False,
    event_id: str | None = None,
) -> dict:
    node = {
        "uuid": node_id,
        "id": node_id,
        "entry": {"is_start": is_start} if is_start else {},
        "absorbing": absorbing,
    }
    if event_id:
        node["event_id"] = event_id
    return node


def _edge(
    edge_id: str,
    from_node: str,
    to_node: str,
    param_id: str,
    *,
    p_mean: float = 0.5,
    latency: dict | None = None,
) -> dict:
    p_block: dict = {
        "id": param_id,
        "mean": p_mean,
    }
    if latency:
        p_block["latency"] = latency
    return {
        "uuid": edge_id,
        "from": from_node,
        "to": to_node,
        "p": p_block,
    }


def _window_param_file(
    n: int,
    k: int,
    *,
    param_id: str = "",
    mean: float | None = None,
) -> dict:
    """Build a minimal parameter file dict with a single window observation."""
    effective_mean = mean if mean is not None else (k / n if n > 0 else 0.5)
    return {
        "id": param_id,
        "values": [
            {
                "sliceDSL": "window(1-Jan-25:1-Mar-25)",
                "n": int(n),
                "k": int(k),
                "mean": effective_mean,
                "stdev": 0.01,
            },
        ],
    }


def _cohort_param_file(
    n_daily: list[int],
    k_daily: list[int],
    dates: list[str],
    *,
    param_id: str = "",
    anchor_node: str = "node-anchor",
) -> dict:
    """Build a parameter file dict with a cohort observation (daily arrays)."""
    total_n = sum(n_daily)
    total_k = sum(k_daily)
    return {
        "id": param_id,
        "values": [
            {
                "sliceDSL": f"cohort({anchor_node},1-Oct-24:1-Jan-25)",
                "n": total_n,
                "k": total_k,
                "n_daily": n_daily,
                "k_daily": k_daily,
                "dates": dates,
                "mean": total_k / total_n if total_n > 0 else 0.5,
                "stdev": 0.01,
            },
        ],
    }


def _window_and_cohort_param_file(
    window_n: int,
    window_k: int,
    n_daily: list[int],
    k_daily: list[int],
    dates: list[str],
    *,
    param_id: str = "",
    anchor_node: str = "node-anchor",
) -> dict:
    """Build a parameter file with both window and cohort observations."""
    total_n = sum(n_daily)
    total_k = sum(k_daily)
    return {
        "id": param_id,
        "values": [
            {
                "sliceDSL": "window(1-Jan-25:1-Mar-25)",
                "n": window_n,
                "k": window_k,
                "mean": window_k / window_n if window_n > 0 else 0.5,
                "stdev": 0.01,
            },
            {
                "sliceDSL": f"cohort({anchor_node},1-Oct-24:1-Jan-25)",
                "n": total_n,
                "k": total_k,
                "n_daily": n_daily,
                "k_daily": k_daily,
                "dates": dates,
                "mean": total_k / total_n if total_n > 0 else 0.5,
                "stdev": 0.01,
            },
        ],
    }


# ---------------------------------------------------------------------------
# Multinomial draw helper
# ---------------------------------------------------------------------------

def _multinomial_draw(
    rng: np.random.Generator,
    n: int,
    probs: list[float],
) -> list[int]:
    """Draw from Multinomial(n, probs). Last component is dropout if sum < 1."""
    p_total = sum(probs)
    if p_total < 1.0:
        full_probs = probs + [1.0 - p_total]
    else:
        full_probs = probs
    counts = rng.multinomial(n, full_probs)
    return list(counts)


# ---------------------------------------------------------------------------
# Scenario builders
# ---------------------------------------------------------------------------

def build_branch_group_3way(
    p_true: list[float],
    n_a: int = 10_000,
    *,
    all_targets_have_events: bool = False,
    seed: int = 42,
) -> tuple[dict, dict[str, dict], dict[str, float]]:
    """Build A → {B, C, D} branch group with known Multinomial truth.

    Args:
        p_true: [p_B, p_C, p_D]. If sum < 1, residual is dropout.
        n_a: shared denominator (source node traffic).
        all_targets_have_events: if True, all target nodes get event_ids,
            causing the compiler to infer exhaustiveness.
        seed: random seed for reproducible draws.

    Returns:
        (graph_snapshot, param_files, ground_truth)
    """
    rng = np.random.default_rng(seed)

    # Fixed UUIDs for determinism
    anchor_id = "node-anchor"
    node_a = "node-a"
    node_b = "node-b"
    node_c = "node-c"
    node_d = "node-d"

    edge_anchor_a = "edge-anchor-a"
    edge_a_b = "edge-a-b"
    edge_a_c = "edge-a-c"
    edge_a_d = "edge-a-d"

    # Draw observations
    if all_targets_have_events:
        # Exhaustive: probabilities must sum to 1, no dropout
        normalised = [p / sum(p_true) for p in p_true]
        counts = _multinomial_draw(rng, n_a, normalised)
    else:
        counts = _multinomial_draw(rng, n_a, p_true)
    k_b, k_c, k_d = counts[0], counts[1], counts[2]

    graph_snapshot = {
        "nodes": [
            _node(anchor_id, is_start=True),
            _node(node_a),
            # When all_targets_have_events, give each target an event_id
            # so the compiler infers exhaustiveness from graph structure.
            _node(node_b, absorbing=True,
                  event_id="evt-b" if all_targets_have_events else None),
            _node(node_c, absorbing=True,
                  event_id="evt-c" if all_targets_have_events else None),
            _node(node_d, absorbing=True,
                  event_id="evt-d" if all_targets_have_events else None),
        ],
        "edges": [
            _edge(edge_anchor_a, anchor_id, node_a, "param-anchor-a", p_mean=0.9),
            _edge(edge_a_b, node_a, node_b, "param-a-b", p_mean=p_true[0]),
            _edge(edge_a_c, node_a, node_c, "param-a-c", p_mean=p_true[1]),
            _edge(edge_a_d, node_a, node_d, "param-a-d", p_mean=p_true[2]),
        ],
    }

    param_files = {
        "param-anchor-a": _window_param_file(n_a * 2, int(n_a * 2 * 0.9), param_id="param-anchor-a"),
        "param-a-b": _window_param_file(n_a, k_b, param_id="param-a-b"),
        "param-a-c": _window_param_file(n_a, k_c, param_id="param-a-c"),
        "param-a-d": _window_param_file(n_a, k_d, param_id="param-a-d"),
    }

    ground_truth = {
        edge_a_b: p_true[0],
        edge_a_c: p_true[1],
        edge_a_d: p_true[2],
    }

    return graph_snapshot, param_files, ground_truth


def build_branch_group_2way(
    p_true: list[float],
    n_a: int = 20_000,
    *,
    seed: int = 42,
) -> tuple[dict, dict[str, dict], dict[str, float]]:
    """Build A → {B, C} branch group (2 siblings + dropout).

    Args:
        p_true: [p_B, p_C]. Residual is dropout.
        n_a: shared denominator.
        seed: random seed.

    Returns:
        (graph_snapshot, param_files, ground_truth)
    """
    rng = np.random.default_rng(seed)

    anchor_id = "node-anchor"
    node_a = "node-a"
    node_b = "node-b"
    node_c = "node-c"

    edge_anchor_a = "edge-anchor-a"
    edge_a_b = "edge-a-b"
    edge_a_c = "edge-a-c"

    counts = _multinomial_draw(rng, n_a, p_true)
    k_b, k_c = counts[0], counts[1]

    graph_snapshot = {
        "nodes": [
            _node(anchor_id, is_start=True),
            _node(node_a),
            _node(node_b, absorbing=True),
            _node(node_c, absorbing=True),
        ],
        "edges": [
            _edge(edge_anchor_a, anchor_id, node_a, "param-anchor-a", p_mean=0.9),
            _edge(edge_a_b, node_a, node_b, "param-a-b", p_mean=p_true[0]),
            _edge(edge_a_c, node_a, node_c, "param-a-c", p_mean=p_true[1]),
        ],
    }

    param_files = {
        "param-anchor-a": _window_param_file(n_a * 2, int(n_a * 2 * 0.9), param_id="param-anchor-a"),
        "param-a-b": _window_param_file(n_a, k_b, param_id="param-a-b"),
        "param-a-c": _window_param_file(n_a, k_c, param_id="param-a-c"),
    }

    ground_truth = {
        edge_a_b: p_true[0],
        edge_a_c: p_true[1],
    }

    return graph_snapshot, param_files, ground_truth


def build_mixed_solo_and_branch(
    *,
    branch_p: list[float] = [0.4, 0.3],
    anchor_p: list[float] = [0.5, 0.2],
    solo_p_xy: float = 0.7,
    n_branch: int = 10_000,
    n_anchor: int = 10_000,
    seed: int = 42,
) -> tuple[dict, dict[str, dict], dict[str, float]]:
    """Build a graph with both branch groups and an independent solo edge.

    Topology:
      anchor → {A, X} (branch group, p=anchor_p — must sum < 1)
      A → {B, C} (branch group, p=branch_p — must sum < 1)
      X → Y (solo edge, p=solo_p_xy)

    For regression testing: solo edge X→Y must be unaffected by the Dirichlets.
    """
    rng = np.random.default_rng(seed)

    anchor_id = "node-anchor"
    node_a = "node-a"
    node_b = "node-b"
    node_c = "node-c"
    node_x = "node-x"
    node_y = "node-y"

    edge_anchor_a = "edge-anchor-a"
    edge_a_b = "edge-a-b"
    edge_a_c = "edge-a-c"
    edge_anchor_x = "edge-anchor-x"
    edge_x_y = "edge-x-y"

    # Anchor branch group: anchor → {A, X} with shared denominator
    anchor_counts = _multinomial_draw(rng, n_anchor, anchor_p)
    k_anchor_a = anchor_counts[0]
    k_anchor_x = anchor_counts[1]

    # Node A branch group: A → {B, C} with shared denominator
    branch_counts = _multinomial_draw(rng, n_branch, branch_p)
    k_b, k_c = branch_counts[0], branch_counts[1]

    # Solo edge: X → Y (independent Binomial)
    k_x_y = rng.binomial(k_anchor_x, solo_p_xy)

    graph_snapshot = {
        "nodes": [
            _node(anchor_id, is_start=True),
            _node(node_a),
            _node(node_b, absorbing=True),
            _node(node_c, absorbing=True),
            _node(node_x),
            _node(node_y, absorbing=True),
        ],
        "edges": [
            _edge(edge_anchor_a, anchor_id, node_a, "param-anchor-a", p_mean=anchor_p[0]),
            _edge(edge_a_b, node_a, node_b, "param-a-b", p_mean=branch_p[0]),
            _edge(edge_a_c, node_a, node_c, "param-a-c", p_mean=branch_p[1]),
            _edge(edge_anchor_x, anchor_id, node_x, "param-anchor-x", p_mean=anchor_p[1]),
            _edge(edge_x_y, node_x, node_y, "param-x-y", p_mean=solo_p_xy),
        ],
    }

    # n for X→Y is the count of users reaching X (= k_anchor_x)
    n_x_y = max(k_anchor_x, 1)

    param_files = {
        "param-anchor-a": _window_param_file(n_anchor, k_anchor_a, param_id="param-anchor-a"),
        "param-a-b": _window_param_file(n_branch, k_b, param_id="param-a-b"),
        "param-a-c": _window_param_file(n_branch, k_c, param_id="param-a-c"),
        "param-anchor-x": _window_param_file(n_anchor, k_anchor_x, param_id="param-anchor-x"),
        "param-x-y": _window_param_file(n_x_y, k_x_y, param_id="param-x-y"),
    }

    ground_truth = {
        edge_anchor_a: anchor_p[0],
        edge_a_b: branch_p[0],
        edge_a_c: branch_p[1],
        edge_anchor_x: anchor_p[1],
        edge_x_y: solo_p_xy,
    }

    return graph_snapshot, param_files, ground_truth


# ---------------------------------------------------------------------------
# Phase A scenario builders: solo edges, chains, cohort data
# ---------------------------------------------------------------------------

def _generate_cohort_daily(
    rng: np.random.Generator,
    p_true: float,
    n_per_day: int,
    n_days: int,
    *,
    onset: float = 0.0,
    mu: float = 2.0,
    sigma: float = 0.5,
    today_str: str = "2025-03-01",
) -> tuple[list[int], list[int], list[str]]:
    """Generate synthetic cohort daily arrays with completeness effects.

    For each day, users enter. Some convert with true probability p_true,
    but those whose latency exceeds the observation window are censored.
    This produces the completeness effect the model must handle.

    Returns (n_daily, k_daily, dates).
    """
    from datetime import datetime, timedelta
    from bayes.compiler.completeness import shifted_lognormal_cdf

    today = datetime.strptime(today_str, "%Y-%m-%d")
    n_daily = []
    k_daily = []
    dates = []

    for day_offset in range(n_days):
        cohort_date = today - timedelta(days=n_days - day_offset)
        age_days = (today - cohort_date).days

        true_k = rng.binomial(n_per_day, p_true)

        # Apply completeness censoring
        completeness = shifted_lognormal_cdf(age_days, onset, mu, sigma)
        observed_k = rng.binomial(true_k, completeness)

        n_daily.append(int(n_per_day))
        k_daily.append(int(observed_k))
        dates.append(cohort_date.strftime("%Y-%m-%d"))

    return n_daily, k_daily, dates


def build_solo_edge_window(
    p_true: float = 0.3,
    n: int = 10_000,
    *,
    seed: int = 50,
) -> tuple[dict, dict[str, dict], dict[str, float]]:
    """A1: Single solo edge with abundant window data.

    Topology: anchor → A → B (absorbing)
    Evidence: window observation on A→B.
    """
    rng = np.random.default_rng(seed)
    k = rng.binomial(n, p_true)

    graph_snapshot = {
        "nodes": [
            _node("node-anchor", is_start=True),
            _node("node-a"),
            _node("node-b", absorbing=True),
        ],
        "edges": [
            _edge("edge-anchor-a", "node-anchor", "node-a", "param-anchor-a", p_mean=0.9),
            _edge("edge-a-b", "node-a", "node-b", "param-a-b", p_mean=p_true),
        ],
    }

    param_files = {
        "param-anchor-a": _window_param_file(n * 2, int(n * 2 * 0.9), param_id="param-anchor-a"),
        "param-a-b": _window_param_file(n, k, param_id="param-a-b"),
    }

    return graph_snapshot, param_files, {"edge-a-b": p_true}


def build_solo_edge_sparse(
    p_true: float = 0.4,
    n: int = 50,
    *,
    seed: int = 51,
) -> tuple[dict, dict[str, dict], dict[str, float]]:
    """A2: Single solo edge with sparse data (n=50)."""
    rng = np.random.default_rng(seed)
    k = rng.binomial(n, p_true)

    graph_snapshot = {
        "nodes": [
            _node("node-anchor", is_start=True),
            _node("node-a"),
            _node("node-b", absorbing=True),
        ],
        "edges": [
            _edge("edge-anchor-a", "node-anchor", "node-a", "param-anchor-a", p_mean=0.9),
            _edge("edge-a-b", "node-a", "node-b", "param-a-b", p_mean=p_true),
        ],
    }

    param_files = {
        "param-anchor-a": _window_param_file(n * 3, int(n * 3 * 0.9), param_id="param-anchor-a"),
        "param-a-b": _window_param_file(n, k, param_id="param-a-b"),
    }

    return graph_snapshot, param_files, {"edge-a-b": p_true}


def build_solo_edge_window_and_cohort(
    p_true: float = 0.35,
    window_n: int = 5_000,
    cohort_n_per_day: int = 100,
    cohort_days: int = 90,
    *,
    onset: float = 2.0,
    mu: float = 2.3,
    sigma: float = 0.6,
    seed: int = 52,
) -> tuple[dict, dict[str, dict], dict[str, float]]:
    """A3: Solo edge with both window and cohort data.

    The hierarchical p_base/p_window/p_cohort structure is exercised.
    Edge has latency so completeness coupling is active on cohort obs.
    """
    rng = np.random.default_rng(seed)

    window_k = rng.binomial(window_n, p_true)
    n_daily, k_daily, dates = _generate_cohort_daily(
        rng, p_true, cohort_n_per_day, cohort_days,
        onset=onset, mu=mu, sigma=sigma,
    )

    latency_block = {
        "latency_parameter": True,
        "onset_delta_days": onset,
        "mu": mu,
        "sigma": sigma,
        "median_lag_days": onset + float(np.exp(mu)),
        "mean_lag_days": onset + float(np.exp(mu + sigma**2 / 2)),
    }

    graph_snapshot = {
        "nodes": [
            _node("node-anchor", is_start=True),
            _node("node-a"),
            _node("node-b", absorbing=True),
        ],
        "edges": [
            _edge("edge-anchor-a", "node-anchor", "node-a", "param-anchor-a", p_mean=0.9),
            _edge("edge-a-b", "node-a", "node-b", "param-a-b",
                  p_mean=p_true, latency=latency_block),
        ],
    }

    param_files = {
        "param-anchor-a": _window_param_file(
            window_n * 2, int(window_n * 2 * 0.9), param_id="param-anchor-a"),
        "param-a-b": _window_and_cohort_param_file(
            window_n, window_k, n_daily, k_daily, dates, param_id="param-a-b"),
    }

    return graph_snapshot, param_files, {"edge-a-b": p_true}


def build_solo_edge_immature_cohort(
    p_true: float = 0.5,
    cohort_n_per_day: int = 200,
    cohort_days: int = 30,
    *,
    onset: float = 5.0,
    mu: float = 3.0,
    sigma: float = 0.7,
    seed: int = 53,
) -> tuple[dict, dict[str, dict], dict[str, float]]:
    """A4: Solo edge with only immature cohort data.

    Long latency (onset=5, mu=3 → median ~25 days) and short cohort
    (30 days). Most recent days have low completeness. The model must
    attribute low observed k to immaturity, not low p.
    """
    rng = np.random.default_rng(seed)

    n_daily, k_daily, dates = _generate_cohort_daily(
        rng, p_true, cohort_n_per_day, cohort_days,
        onset=onset, mu=mu, sigma=sigma,
    )

    latency_block = {
        "latency_parameter": True,
        "onset_delta_days": onset,
        "mu": mu,
        "sigma": sigma,
        "median_lag_days": onset + float(np.exp(mu)),
        "mean_lag_days": onset + float(np.exp(mu + sigma**2 / 2)),
    }

    graph_snapshot = {
        "nodes": [
            _node("node-anchor", is_start=True),
            _node("node-b", absorbing=True),
        ],
        "edges": [
            _edge("edge-anchor-b", "node-anchor", "node-b", "param-anchor-b",
                  p_mean=p_true, latency=latency_block),
        ],
    }

    param_files = {
        "param-anchor-b": _cohort_param_file(
            n_daily, k_daily, dates,
            param_id="param-anchor-b", anchor_node="node-anchor"),
    }

    return graph_snapshot, param_files, {"edge-anchor-b": p_true}


def build_linear_chain(
    p_true: list[float] = [0.7, 0.5, 0.3],
    n: int = 8_000,
    *,
    seed: int = 54,
) -> tuple[dict, dict[str, dict], dict[str, float]]:
    """A5: Linear chain A → B → C → D (3 solo edges in series).

    Tests that edges in a chain are fitted independently. Window only,
    no latency, no cohort.
    """
    rng = np.random.default_rng(seed)

    k_ab = rng.binomial(n, p_true[0])
    n_bc = k_ab
    k_bc = rng.binomial(n_bc, p_true[1])
    n_cd = k_bc
    k_cd = rng.binomial(n_cd, p_true[2])

    graph_snapshot = {
        "nodes": [
            _node("node-a", is_start=True),
            _node("node-b"),
            _node("node-c"),
            _node("node-d", absorbing=True),
        ],
        "edges": [
            _edge("edge-a-b", "node-a", "node-b", "param-a-b", p_mean=p_true[0]),
            _edge("edge-b-c", "node-b", "node-c", "param-b-c", p_mean=p_true[1]),
            _edge("edge-c-d", "node-c", "node-d", "param-c-d", p_mean=p_true[2]),
        ],
    }

    param_files = {
        "param-a-b": _window_param_file(n, k_ab, param_id="param-a-b"),
        "param-b-c": _window_param_file(max(n_bc, 1), k_bc, param_id="param-b-c"),
        "param-c-d": _window_param_file(max(n_cd, 1), k_cd, param_id="param-c-d"),
    }

    ground_truth = {
        "edge-a-b": p_true[0],
        "edge-b-c": p_true[1],
        "edge-c-d": p_true[2],
    }

    return graph_snapshot, param_files, ground_truth


# ---------------------------------------------------------------------------
# Phase S: snapshot row generators
# ---------------------------------------------------------------------------

def generate_snapshot_rows(
    rng: np.random.Generator,
    p_true: float,
    n_per_day: int,
    n_days: int,
    retrieval_dates: list[str],
    *,
    onset: float = 0.0,
    mu: float = 2.0,
    sigma: float = 0.5,
    slice_key: str = "cohort(node-anchor,2024-10-01:2025-01-01)",
    param_id: str = "repo-branch-param-a-b",
    core_hash: str = "test-hash",
    today_str: str = "2025-03-01",
) -> list[dict]:
    """Generate synthetic snapshot DB rows with maturation trajectories.

    For each cohort day, draws per-converter lags from the true latency
    distribution. At each retrieval age, the cumulative count is the number
    of converters whose lag ≤ age. This produces naturally monotonic
    trajectories (later retrievals always show ≥ earlier counts).
    """
    from datetime import datetime, timedelta

    today = datetime.strptime(today_str, "%Y-%m-%d")
    rows = []

    sorted_ret_dates = sorted(retrieval_dates)

    for day_offset in range(n_days):
        cohort_date = today - timedelta(days=n_days - day_offset)
        anchor_day_str = cohort_date.strftime("%Y-%m-%d")

        # Draw true converters and their lags
        true_k = rng.binomial(n_per_day, p_true)
        if true_k > 0:
            # Each converter's lag from the shifted lognormal
            raw_lags = rng.lognormal(mu, sigma, size=true_k)
            lags = onset + raw_lags
        else:
            lags = np.array([])

        for ret_date_str in sorted_ret_dates:
            ret_date = datetime.strptime(ret_date_str, "%Y-%m-%d")
            if ret_date < cohort_date:
                continue

            age = (ret_date - cohort_date).days
            # Count converters whose lag ≤ age (naturally monotonic)
            observed_k = int(np.sum(lags <= age)) if len(lags) > 0 else 0

            rows.append({
                "param_id": param_id,
                "core_hash": core_hash,
                "slice_key": slice_key,
                "anchor_day": anchor_day_str,
                "retrieved_at": f"{ret_date_str}T12:00:00",
                "a": n_per_day,
                "x": n_per_day,
                "y": observed_k,
                "median_lag_days": onset + float(np.exp(mu)),
                "mean_lag_days": onset + float(np.exp(mu + sigma**2 / 2)),
                "onset_delta_days": onset,
            })

    return rows


def build_solo_edge_with_snapshots(
    p_true: float = 0.35,
    n_per_day: int = 100,
    n_days: int = 60,
    *,
    onset: float = 2.0,
    mu: float = 2.3,
    sigma: float = 0.6,
    seed: int = 60,
) -> tuple[dict, dict[str, dict], dict[str, list[dict]], dict[str, float]]:
    """S1: Solo edge with snapshot cohort evidence (maturation trajectory).

    Returns (graph_snapshot, param_files, snapshot_rows, ground_truth).
    The param_files have minimal data (for prior resolution). The rich
    evidence comes from snapshot_rows.
    """
    rng = np.random.default_rng(seed)
    today_str = "2025-03-01"

    from datetime import datetime, timedelta
    today = datetime.strptime(today_str, "%Y-%m-%d")
    cohort_start = today - timedelta(days=n_days)

    retrieval_dates = []
    ret = cohort_start + timedelta(days=30)
    while ret <= today:
        retrieval_dates.append(ret.strftime("%Y-%m-%d"))
        ret += timedelta(days=10)

    latency_block = {
        "latency_parameter": True,
        "onset_delta_days": onset,
        "mu": mu,
        "sigma": sigma,
        "median_lag_days": onset + float(np.exp(mu)),
        "mean_lag_days": onset + float(np.exp(mu + sigma**2 / 2)),
    }

    graph_snapshot = {
        "nodes": [
            _node("node-anchor", is_start=True),
            _node("node-a"),
            _node("node-b", absorbing=True),
        ],
        "edges": [
            _edge("edge-anchor-a", "node-anchor", "node-a", "param-anchor-a", p_mean=0.9),
            _edge("edge-a-b", "node-a", "node-b", "param-a-b",
                  p_mean=p_true, latency=latency_block),
        ],
    }

    param_files = {
        "param-anchor-a": _window_param_file(
            n_per_day * n_days * 2, int(n_per_day * n_days * 2 * 0.9),
            param_id="param-anchor-a"),
        "param-a-b": {"id": "param-a-b", "values": [
            {"sliceDSL": "window(1-Jan-25:1-Mar-25)",
             "n": 100, "k": int(100 * p_true),
             "mean": p_true, "stdev": 0.05}]},
    }

    rows = generate_snapshot_rows(
        rng, p_true, n_per_day, n_days, retrieval_dates,
        onset=onset, mu=mu, sigma=sigma,
        slice_key="cohort(node-anchor,2024-10-01:2025-01-01)",
        param_id="repo-branch-param-a-b",
        today_str=today_str,
    )

    return graph_snapshot, param_files, {"edge-a-b": rows}, {"edge-a-b": p_true}



def build_snapshot_with_fallback(
    p_true_snapshot: float = 0.3,
    p_true_paramfile: float = 0.6,
    n_snapshot: int = 10_000,
    n_paramfile: int = 5_000,
    *,
    seed: int = 62,
) -> tuple[dict, dict[str, dict], dict[str, list[dict]], dict[str, float]]:
    """S3: Two edges — one with snapshot data, one without (fallback).

    edge-a-b has window snapshot rows. edge-b-c has param file only.
    """
    rng = np.random.default_rng(seed)

    k_ab = rng.binomial(n_snapshot, p_true_snapshot)
    k_bc = rng.binomial(n_paramfile, p_true_paramfile)

    graph_snapshot = {
        "nodes": [
            _node("node-a", is_start=True),
            _node("node-b"),
            _node("node-c", absorbing=True),
        ],
        "edges": [
            _edge("edge-a-b", "node-a", "node-b", "param-a-b", p_mean=p_true_snapshot),
            _edge("edge-b-c", "node-b", "node-c", "param-b-c", p_mean=p_true_paramfile),
        ],
    }

    param_files = {
        "param-a-b": {"id": "param-a-b", "values": [
            {"sliceDSL": "window(1-Jan-25:1-Mar-25)",
             "n": 100, "k": int(100 * p_true_snapshot),
             "mean": p_true_snapshot, "stdev": 0.05}]},
        "param-b-c": _window_param_file(n_paramfile, k_bc, param_id="param-b-c"),
    }

    snapshot_rows = {
        "edge-a-b": [{
            "param_id": "repo-branch-param-a-b",
            "core_hash": "test-hash",
            "slice_key": "window(1-Jan-25:1-Mar-25)",
            "anchor_day": "2025-01-15",
            "retrieved_at": "2025-03-01T12:00:00",
            "a": None, "x": n_snapshot, "y": k_ab,
        }],
    }

    ground_truth = {
        "edge-a-b": p_true_snapshot,
        "edge-b-c": p_true_paramfile,
    }

    return graph_snapshot, param_files, snapshot_rows, ground_truth


def build_contexted_solo_edge_with_snapshot_slices(
    slice_ps: dict[str, float] | None = None,
    n_per_day: int = 80,
    n_days: int = 45,
    *,
    onset: float = 2.0,
    mu: float = 2.1,
    sigma: float = 0.55,
    seed: int = 63,
) -> tuple[
    dict,
    dict[str, dict],
    dict[str, list[dict]],
    dict[str, set[str]],
    list[str],
    dict[str, float],
]:
    """Snapshot-backed solo edge with commissioned MECE context slices.

    Produces two or more context-qualified hash-sharing slice families for a
    single latency edge. This is the smallest local fixture that exercises the
    real Phase C snapshot path:

      snapshot rows -> bind_snapshot_evidence(... commissioned_slices=...)
                   -> SliceGroups -> build_model()

    Returns:
      graph_snapshot,
      param_files,
      snapshot_rows,
      commissioned_slices,
      mece_dimensions,
      slice_truth   # context_key -> true p
    """
    if slice_ps is None:
        slice_ps = {
            "google": 0.62,
            "direct": 0.38,
        }

    rng = np.random.default_rng(seed)
    today_str = "2025-03-01"

    from datetime import datetime, timedelta

    today = datetime.strptime(today_str, "%Y-%m-%d")
    cohort_start = today - timedelta(days=n_days)

    retrieval_dates = []
    ret = cohort_start + timedelta(days=20)
    while ret <= today:
        retrieval_dates.append(ret.strftime("%Y-%m-%d"))
        ret += timedelta(days=10)

    latency_block = {
        "latency_parameter": True,
        "onset_delta_days": onset,
        "mu": mu,
        "sigma": sigma,
        "median_lag_days": onset + float(np.exp(mu)),
        "mean_lag_days": onset + float(np.exp(mu + sigma**2 / 2)),
    }

    mean_p = float(np.mean(list(slice_ps.values())))

    graph_snapshot = {
        "nodes": [
            _node("node-anchor", is_start=True),
            _node("node-a"),
            _node("node-b", absorbing=True),
        ],
        "edges": [
            _edge("edge-anchor-a", "node-anchor", "node-a", "param-anchor-a", p_mean=0.9),
            _edge(
                "edge-a-b",
                "node-a",
                "node-b",
                "param-a-b",
                p_mean=mean_p,
                latency=latency_block,
            ),
        ],
    }

    param_files = {
        "param-anchor-a": _window_param_file(
            n_per_day * n_days * 2,
            int(n_per_day * n_days * 2 * 0.9),
            param_id="param-anchor-a",
        ),
        "param-a-b": {
            "id": "param-a-b",
            "values": [
                {
                    "sliceDSL": "window(1-Jan-25:1-Mar-25)",
                    "n": 100,
                    "k": int(100 * mean_p),
                    "mean": mean_p,
                    "stdev": 0.05,
                }
            ],
        },
    }

    shared_hash = "ctx-shared-hash"
    rows: list[dict] = []
    commissioned = {
        "edge-a-b": {
            f"context(channel:{ctx_name})"
            for ctx_name in slice_ps
        }
    }
    mece_dimensions = ["channel"]
    slice_truth = {
        f"context(channel:{ctx_name})": p_true
        for ctx_name, p_true in slice_ps.items()
    }

    for ctx_name, p_true in slice_ps.items():
        ctx_key = f"context(channel:{ctx_name})"
        rows.extend(
            generate_snapshot_rows(
                rng,
                p_true,
                n_per_day,
                n_days,
                retrieval_dates,
                onset=onset,
                mu=mu,
                sigma=sigma,
                slice_key=f"{ctx_key}.window(1-Jan-25:1-Mar-25)",
                param_id="repo-branch-param-a-b",
                core_hash=shared_hash,
                today_str=today_str,
            )
        )
        rows.extend(
            generate_snapshot_rows(
                rng,
                p_true,
                n_per_day,
                n_days,
                retrieval_dates,
                onset=onset,
                mu=mu,
                sigma=sigma,
                slice_key=f"{ctx_key}.cohort(node-anchor,2024-10-01:2025-01-01)",
                param_id="repo-branch-param-a-b",
                core_hash=shared_hash,
                today_str=today_str,
            )
        )

    return (
        graph_snapshot,
        param_files,
        {"edge-a-b": rows},
        commissioned,
        mece_dimensions,
        slice_truth,
    )
