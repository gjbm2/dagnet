import json
import sys
from pathlib import Path


def test_to_node_reach_ignores_conditional_p_by_default():
    """
    Regression test for Layer-1 decision:
    - Python runner analytics should NOT implicitly apply edge.conditional_p when computing reach.

    This matters because the graph may contain conditional_p used for What-If modelling,
    but analytics (outside explicit activation) must use the baked edge probabilities only.
    """
    repo_root = Path(__file__).resolve().parents[2]
    graph_editor_root = repo_root / "graph-editor"
    sys.path.insert(0, str(graph_editor_root))

    from lib.runner.analyzer import analyze
    from lib.runner.types import AnalysisRequest, ScenarioData

    graph = {
        "nodes": [
            {"uuid": "A", "id": "A", "entry": {"is_start": True}},
            {"uuid": "B", "id": "B"},
            {"uuid": "C", "id": "C", "absorbing": True, "outcome_type": "success"},
        ],
        "edges": [
            {
                "uuid": "A->B",
                "from": "A",
                "to": "B",
                "p": {
                    "mean": 0.5,
                    "evidence": {"mean": 0.5, "n": 100, "k": 50},
                },
            },
            {
                "uuid": "B->C",
                "from": "B",
                "to": "C",
                "p": {
                    "mean": 0.5,
                    "evidence": {"mean": 0.5, "n": 100, "k": 50},
                },
                # Conditional branch that would inflate probability if applied implicitly.
                "conditional_p": [
                    {
                        "condition": "visited(A)",
                        "p": {"mean": 0.9},
                    }
                ],
            },
        ],
    }

    req = AnalysisRequest(
        scenarios=[ScenarioData(scenario_id="current", name="Current", colour="#3b82f6", visibility_mode="e", graph=graph)],
        query_dsl="to(C).cohort(1-Nov-25:1-Nov-25)",
        analysis_type="to_node_reach",
    )
    res = analyze(req)
    assert res.success is True, json.dumps(res.model_dump(), indent=2)
    row = (res.result.data or [None])[0]
    # If conditional_p is ignored, reach is 0.5 * 0.5 = 0.25.
    assert abs(float(row["probability"]) - 0.25) < 1e-12


