import sys
from pathlib import Path

# Ensure graph-editor/lib is importable when running from repo root
sys.path.insert(0, str((Path(__file__).resolve().parent.parent / "lib").resolve()))

from graph_types import Graph  # type: ignore
from msmdc import generate_all_parameter_queries  # type: ignore


def test_amplitude_prod_does_not_compile_exclude_to_minus() -> None:
    """
    Regression: If the edge is configured to use amplitude-prod and excludes are required,
    MSMDC must keep exclude(...) (native support) and MUST NOT compile to minus()/plus().
    """
    graph_dict = {
        "nodes": [
            {"uuid": "a", "id": "a"},
            {"uuid": "b", "id": "b"},
            {"uuid": "c", "id": "c"},
        ],
        # Topology forces direct edge a->c to exclude(b) due to alternate path a->b->c
        "edges": [
            {"uuid": "ab", "id": "a-b", "from": "a", "to": "b", "p": {"mean": 0.5}},
            {"uuid": "bc", "id": "b-c", "from": "b", "to": "c", "p": {"mean": 0.5}},
            {
                "uuid": "ac",
                "id": "a-c",
                "from": "a",
                "to": "c",
                "p": {
                    "mean": 0.5,
                    "connection": "amplitude-prod",
                    "data_source": {"type": "amplitude", "retrieved_at": "1-Jan-26"},
                },
            },
        ],
        "policies": {"default_outcome": "c", "overflow_policy": "error", "free_edge_policy": "complement"},
        "metadata": {"version": "1.0.0", "created_at": "1-Jan-26"},
    }

    graph = Graph.model_validate(graph_dict)
    params = generate_all_parameter_queries(graph, edge_uuid="ac")
    base = [p for p in params if p.param_type == "edge_base_p"]
    assert len(base) == 1

    query = base[0].query
    assert ".exclude(" in query
    assert ".minus(" not in query
    assert ".plus(" not in query


