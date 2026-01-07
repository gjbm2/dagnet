import pytest

from lib.runner.constraint_eval import (
    evaluate_constraint_condition,
    parse_constraint_condition,
    constraint_specificity_score,
)


def test_parse_constraint_condition_extracts_all_supported_clauses():
    parsed = parse_constraint_condition("visited(a,b).exclude(c).visitedAny(d,e).case(foo:bar).context(channel:google)")
    assert parsed.visited == ["a", "b"]
    assert parsed.exclude == ["c"]
    assert parsed.visited_any == [["d", "e"]]
    assert ("foo", "bar") in parsed.cases
    assert ("channel", "google") in parsed.contexts


def test_evaluate_constraint_condition_visited_and_exclude():
    visited = {"a", "b"}
    assert evaluate_constraint_condition("visited(a)", visited_nodes=visited) is True
    assert evaluate_constraint_condition("visited(a).exclude(c)", visited_nodes=visited) is True
    assert evaluate_constraint_condition("visited(a).exclude(b)", visited_nodes=visited) is False
    assert evaluate_constraint_condition("visited(z)", visited_nodes=visited) is False


def test_evaluate_constraint_condition_visited_any():
    visited = {"x"}
    assert evaluate_constraint_condition("visitedAny(a,x)", visited_nodes=visited) is True
    assert evaluate_constraint_condition("visitedAny(a,b)", visited_nodes=visited) is False


def test_evaluate_constraint_condition_context_and_case():
    visited = {"a"}
    ctx = {"channel": "google"}
    cases = {"pricing": "v1"}
    assert evaluate_constraint_condition("visited(a).context(channel:google)", visited_nodes=visited, context=ctx) is True
    assert evaluate_constraint_condition("context(channel:google)", visited_nodes=visited, context=ctx) is True
    assert evaluate_constraint_condition("context(channel:facebook)", visited_nodes=visited, context=ctx) is False
    assert evaluate_constraint_condition("case(pricing:v1)", visited_nodes=visited, case_variants=cases) is True
    assert evaluate_constraint_condition("case(pricing:v2)", visited_nodes=visited, case_variants=cases) is False


def test_parse_rejects_unsupported_functions():
    with pytest.raises(ValueError):
        parse_constraint_condition("contextAny(channel:google,channel:facebook)")
    with pytest.raises(ValueError):
        parse_constraint_condition("window(1-Nov-25:7-Nov-25)")
    with pytest.raises(ValueError):
        parse_constraint_condition("cohort(1-Nov-25:7-Nov-25)")


def test_constraint_specificity_score_prefers_more_specific_and_penalises_visited_any_width():
    # More ANDed constraints => higher score
    assert constraint_specificity_score("visited(a)") < constraint_specificity_score("visited(a).exclude(b)")
    # visitedAny is OR-shaped; wider group should be less specific
    assert constraint_specificity_score("visitedAny(a)") > constraint_specificity_score("visitedAny(a,b,c)")


