"""Shared helpers for per-slice recovery parsing and truth composition."""

from __future__ import annotations

from itertools import combinations, permutations, product


SLICE_LABEL_SEPARATOR = " :: "


def split_dsl_parts(dsl: str) -> list[str]:
    """Split a DSL string on dots, respecting parenthesised content."""
    if not dsl:
        return []

    parts: list[str] = []
    current: list[str] = []
    depth = 0
    for ch in dsl:
        if ch == "(":
            depth += 1
            current.append(ch)
        elif ch == ")":
            depth = max(depth - 1, 0)
            current.append(ch)
        elif ch == "." and depth == 0:
            part = "".join(current).strip()
            if part:
                parts.append(part)
            current = []
        else:
            current.append(ch)

    tail = "".join(current).strip()
    if tail:
        parts.append(tail)
    return parts


def make_slice_label(ctx_key: str, edge_key: str) -> str:
    return f"{ctx_key}{SLICE_LABEL_SEPARATOR}{edge_key}"


def parse_slice_label(label: str) -> tuple[str, str] | None:
    if SLICE_LABEL_SEPARATOR not in label:
        return None
    ctx_key, edge_key = label.rsplit(SLICE_LABEL_SEPARATOR, 1)
    ctx_key = ctx_key.strip()
    edge_key = edge_key.strip()
    if not ctx_key or not edge_key:
        return None
    return ctx_key, edge_key


def match_truth_edge_key(edge_key: str, truth_edges: dict[str, dict]) -> str | None:
    if edge_key in truth_edges:
        return edge_key
    for truth_key in truth_edges:
        if edge_key.endswith(truth_key) or edge_key.endswith(f"-{truth_key}"):
            return truth_key
    return None


def _match_edge_overrides(
    edges_map: dict[str, dict],
    edge_key: str,
    truth_key: str,
) -> dict:
    if truth_key in edges_map:
        return edges_map[truth_key] or {}
    if edge_key in edges_map:
        return edges_map[edge_key] or {}
    for candidate, overrides in edges_map.items():
        if edge_key.endswith(candidate) or edge_key.endswith(f"-{candidate}"):
            return overrides or {}
        if truth_key.endswith(candidate) or truth_key.endswith(f"-{candidate}"):
            return overrides or {}
    return {}


def _parse_ctx_part(part: str) -> tuple[str, str] | None:
    if not part or "(" not in part or not part.endswith(")"):
        return None

    fn_name, inner = part.split("(", 1)
    fn_name = fn_name.strip().lower()
    inner = inner[:-1].strip()
    if not inner:
        return None

    if fn_name in {"context", "case", "contextany", "visited", "visitedany"}:
        if ":" in inner:
            dim_id, value_id = inner.split(":", 1)
            return dim_id.strip(), value_id.strip()
        if fn_name.startswith("visited"):
            return fn_name, inner
    return None


def compose_slice_truth(truth: dict, edge_key: str, ctx_key: str) -> dict | None:
    """Compose per-slice truth for any context-qualified key."""
    truth_edges = truth.get("edges", {})
    truth_key = match_truth_edge_key(edge_key, truth_edges)
    if truth_key is None:
        return None

    base = truth_edges.get(truth_key)
    if not isinstance(base, dict) or base.get("p") is None:
        return None

    if not ctx_key:
        return {
            "p": base["p"],
            "mu": base.get("mu", 0.0),
            "sigma": base.get("sigma", 0.5),
            "onset": base.get("onset", 0.0),
        }

    dim_lookup = {
        dim.get("id"): dim
        for dim in truth.get("context_dimensions", [])
        if isinstance(dim, dict) and dim.get("id")
    }

    p_mult = 1.0
    mu_offset = 0.0
    sigma_mult = 1.0
    onset_offset = 0.0
    matched_parts = 0

    for part in split_dsl_parts(ctx_key):
        parsed = _parse_ctx_part(part)
        if parsed is None:
            continue

        dim_id, value_id = parsed
        dim = dim_lookup.get(dim_id)
        if dim is None:
            return None

        value = next(
            (entry for entry in dim.get("values", []) if entry.get("id") == value_id),
            None,
        )
        if value is None:
            return None

        overrides = _match_edge_overrides(value.get("edges") or {}, edge_key, truth_key)
        p_mult *= float(overrides.get("p_mult", 1.0))
        mu_offset += float(overrides.get("mu_offset", 0.0))
        sigma_mult *= float(overrides.get("sigma_mult", 1.0))
        onset_offset += float(overrides.get("onset_offset", 0.0))
        matched_parts += 1

    if matched_parts == 0:
        return None

    return {
        "p": base["p"] * p_mult,
        "mu": base.get("mu", 0.0) + mu_offset,
        "sigma": base.get("sigma", 0.5) * sigma_mult,
        "onset": base.get("onset", 0.0) + onset_offset,
    }


def iter_expected_single_slice_specs(truth: dict) -> list[dict]:
    """Expected single-dimension slice contracts from truth values."""
    specs: list[dict] = []
    for dim in truth.get("context_dimensions", []):
        dim_id = dim.get("id")
        if not dim_id:
            continue
        for value in dim.get("values", []):
            value_id = value.get("id")
            if not value_id:
                continue
            ctx_key = f"context({dim_id}:{value_id})"
            for edge_key in (value.get("edges") or {}).keys():
                slice_truth = compose_slice_truth(truth, edge_key, ctx_key)
                if slice_truth is None:
                    continue
                specs.append(
                    {
                        "ctx_key": ctx_key,
                        "edge_key": edge_key,
                        "label": make_slice_label(ctx_key, edge_key),
                        "truth": slice_truth,
                    }
                )
    return specs


def build_slice_truth_baselines(truth: dict) -> dict[str, dict[str, dict]]:
    """Precompute truth baselines for all context-dimension combinations."""
    context_dims = [
        dim for dim in truth.get("context_dimensions", [])
        if dim.get("id") and dim.get("values")
    ]
    if not context_dims:
        return {}

    truth_edges = truth.get("edges", {})
    baselines: dict[str, dict[str, dict]] = {}

    dim_values = [
        (dim["id"], [value["id"] for value in dim.get("values", []) if value.get("id")])
        for dim in context_dims
    ]

    for edge_key, edge_truth in truth_edges.items():
        if not isinstance(edge_truth, dict) or edge_truth.get("p") is None:
            continue

        edge_baselines: dict[str, dict] = {}
        for size in range(1, len(dim_values) + 1):
            for chosen_dims in combinations(dim_values, size):
                for chosen_values in product(*(values for _, values in chosen_dims)):
                    ordered_parts = [
                        (dim_id, value_id)
                        for (dim_id, _), value_id in zip(chosen_dims, chosen_values)
                    ]
                    for ordered_ctx in permutations(ordered_parts):
                        ctx_key = ".".join(
                            f"context({dim_id}:{value_id})"
                            for dim_id, value_id in ordered_ctx
                        )
                        slice_truth = compose_slice_truth(truth, edge_key, ctx_key)
                        if slice_truth is not None:
                            edge_baselines[ctx_key] = slice_truth

        if edge_baselines:
            baselines[edge_key] = edge_baselines

    return baselines
