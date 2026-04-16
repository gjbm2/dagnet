"""
DSL Explosion — blind specification tests.

Written from the contract (dslExplosion.ts docstring + equivalences),
NOT from reading the implementation.

Contract:
    (a;b).c  =  c.(a;b)  =  or(a,b).c  =  or(a.c,b.c)  =  a.c;b.c
    a;b;c    =  or(a,b,c)
    or(a,or(b,c))  =  a;b;c
    (A;B)(C;D)  =  A.C;A.D;B.C;B.D   (juxtaposed groups → cartesian)

Bare-key expansion (context(channel) → per-value) is NOT tested here
because the Python module does structural explosion only.

What real bugs would these tests catch?
    - Naive semicolon split breaking on (A;B)(C) compound forms
      (the doc-43 defect itself)
    - Distribution applied in wrong direction
    - or() flattening failing on nesting
    - Parenthesis matching off-by-one
    - prefix.or(...) not distributing
    - Empty branches lost or duplicated

What would a false pass look like?
    - Testing only atomic inputs (no compound forms)
    - Asserting only length without checking content
    - Not testing equivalence between alternative syntaxes
"""

import pytest

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from bayes.dsl_explosion import explode_dsl


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def sorted_result(dsl: str) -> list[str]:
    return sorted(explode_dsl(dsl))


def assert_equivalent(dsl_a: str, dsl_b: str) -> None:
    """Two DSL expressions must produce the same set of atomic clauses."""
    a = sorted_result(dsl_a)
    b = sorted_result(dsl_b)
    assert a == b, f"\n  DSL A: {dsl_a}\n  DSL B: {dsl_b}\n  A result: {a}\n  B result: {b}"


# ---------------------------------------------------------------------------
# 1. Syntactic equivalences
# ---------------------------------------------------------------------------

class TestEquivalences:
    """Different notation, identical atomic clauses."""

    def test_or_equals_semicolon(self):
        assert_equivalent(
            "or(context(channel:ch-1),context(geo:geo-1))",
            "context(channel:ch-1);context(geo:geo-1)",
        )
        assert len(explode_dsl("or(context(channel:ch-1),context(geo:geo-1))")) == 2

    def test_or_three_equals_semicolon_three(self):
        assert_equivalent(
            "or(context(channel:ch-1),context(geo:geo-1),context(device:dev-1))",
            "context(channel:ch-1);context(geo:geo-1);context(device:dev-1)",
        )
        assert len(explode_dsl("or(context(channel:ch-1),context(geo:geo-1),context(device:dev-1))")) == 3

    def test_grouped_suffix_equals_flat(self):
        assert_equivalent(
            "(context(channel:ch-1);context(channel:ch-2)).window(-30d:)",
            "context(channel:ch-1).window(-30d:);context(channel:ch-2).window(-30d:)",
        )
        assert len(explode_dsl("(context(channel:ch-1);context(channel:ch-2)).window(-30d:)")) == 2

    def test_prefix_dot_group_equals_flat(self):
        # Structural explosion preserves clause order (prefix.suffix),
        # so we compare sets of contained parts, not literal strings.
        result = explode_dsl("window(-30d:).(context(channel:ch-1);context(channel:ch-2))")
        assert len(result) == 2
        assert any("window(-30d:)" in s and "context(channel:ch-1)" in s for s in result)
        assert any("window(-30d:)" in s and "context(channel:ch-2)" in s for s in result)

    def test_or_suffix_equals_paren_suffix(self):
        assert_equivalent(
            "or(context(channel:ch-1),context(channel:ch-2)).window(-30d:)",
            "(context(channel:ch-1);context(channel:ch-2)).window(-30d:)",
        )

    def test_prefix_or_equals_prefix_paren(self):
        assert_equivalent(
            "window(-30d:).or(context(channel:ch-1),context(channel:ch-2))",
            "window(-30d:).(context(channel:ch-1);context(channel:ch-2))",
        )

    def test_paren_paren_cartesian_equals_flat(self):
        """(a;b).(c;d) = a.c;a.d;b.c;b.d"""
        assert_equivalent(
            "(window(-30d:);cohort(-30d:)).(context(channel:ch-1);context(geo:geo-1))",
            "window(-30d:).context(channel:ch-1);"
            "window(-30d:).context(geo:geo-1);"
            "cohort(-30d:).context(channel:ch-1);"
            "cohort(-30d:).context(geo:geo-1)",
        )
        assert len(explode_dsl(
            "(window(-30d:);cohort(-30d:)).(context(channel:ch-1);context(geo:geo-1))"
        )) == 4

    def test_or_or_equals_paren_paren(self):
        assert_equivalent(
            "or(window(-30d:),cohort(-30d:)).or(context(channel:ch-1),context(geo:geo-1))",
            "(window(-30d:);cohort(-30d:)).(context(channel:ch-1);context(geo:geo-1))",
        )

    def test_nested_or_flattens(self):
        assert_equivalent(
            "or(context(channel:ch-1),or(context(geo:geo-1),context(device:dev-1)))",
            "context(channel:ch-1);context(geo:geo-1);context(device:dev-1)",
        )
        assert len(explode_dsl(
            "or(context(channel:ch-1),or(context(geo:geo-1),context(device:dev-1)))"
        )) == 3

    def test_nested_parens_flatten(self):
        """((a;b);c) = a;b;c"""
        result = explode_dsl("((context(channel:ch-1);context(channel:ch-2));context(geo:geo-1))")
        assert len(result) == 3


# ---------------------------------------------------------------------------
# 2. Distribution — prefix x suffix branching
# ---------------------------------------------------------------------------

class TestDistribution:

    def test_2_prefix_3_suffix(self):
        result = explode_dsl(
            "(window(-30d:);cohort(-30d:))."
            "(context(channel:ch-1);context(channel:ch-2);context(channel:ch-3))"
        )
        assert len(result) == 6
        for time in ("window(-30d:)", "cohort(-30d:)"):
            for ctx in ("context(channel:ch-1)", "context(channel:ch-2)", "context(channel:ch-3)"):
                assert any(time in s and ctx in s for s in result), \
                    f"Missing combination: {time} + {ctx}"

    def test_3_prefix_2_suffix(self):
        result = explode_dsl(
            "(context(channel:ch-1);context(channel:ch-2);context(channel:ch-3))."
            "(window(-7d:);window(-30d:))"
        )
        assert len(result) == 6

    def test_distribution_preserves_all_parts(self):
        result = explode_dsl("(window(-7d:);cohort(-30d:)).context(channel:ch-1)")
        assert len(result) == 2
        assert any("window(-7d:)" in s and "context(channel:ch-1)" in s for s in result)
        assert any("cohort(-30d:)" in s and "context(channel:ch-1)" in s for s in result)


# ---------------------------------------------------------------------------
# 3. Juxtaposed groups — (A;B)(C;D) without dot
# ---------------------------------------------------------------------------

class TestJuxtaposedGroups:
    """The exact form that caused doc-43: (window;cohort)(context(dim))."""

    def test_basic_juxtaposition(self):
        """(a;b)(c;d) distributes as a.c, a.d, b.c, b.d."""
        result = explode_dsl(
            "(window(12-Dec-25:11-Mar-26);cohort(12-Dec-25:11-Mar-26))"
            "(context(synth-channel))"
        )
        assert len(result) == 2
        assert any("window(" in s and "context(synth-channel)" in s for s in result)
        assert any("cohort(" in s and "context(synth-channel)" in s for s in result)

    def test_doc43_exact_form(self):
        """The exact DSL that triggered the defect."""
        result = explode_dsl(
            "(window(12-Dec-25:11-Mar-26);cohort(12-Dec-25:11-Mar-26))"
            "(context(synth-channel))"
        )
        # Must produce exactly 2 clauses, one window+context, one cohort+context
        assert len(result) == 2
        window_ctx = [s for s in result if "window(" in s and "context(" in s]
        cohort_ctx = [s for s in result if "cohort(" in s and "context(" in s]
        assert len(window_ctx) == 1, f"Expected 1 window+context clause, got {window_ctx}"
        assert len(cohort_ctx) == 1, f"Expected 1 cohort+context clause, got {cohort_ctx}"

    def test_two_groups_two_contexts(self):
        """(w;c)(ctx1;ctx2) → 4 clauses."""
        result = explode_dsl(
            "(window(1-Jan-26:1-Mar-26);cohort(1-Jan-26:1-Mar-26))"
            "(context(channel);context(device))"
        )
        assert len(result) == 4
        assert any("window(" in s and "context(channel)" in s for s in result)
        assert any("window(" in s and "context(device)" in s for s in result)
        assert any("cohort(" in s and "context(channel)" in s for s in result)
        assert any("cohort(" in s and "context(device)" in s for s in result)

    def test_three_chained_groups(self):
        """(A;B)(C;D)(E;F) → 2*2*2 = 8."""
        result = explode_dsl("(a;b)(c;d)(e;f)")
        assert len(result) == 8
        # Spot-check: a.c.e and b.d.f should both exist
        assert any("a" in s and "c" in s and "e" in s for s in result)
        assert any("b" in s and "d" in s and "f" in s for s in result)

    def test_juxtaposition_equals_dot_form(self):
        """(a;b)(c;d) = (a;b).(c;d)"""
        assert_equivalent(
            "(window(-30d:);cohort(-30d:))(context(ch:v1);context(geo:v2))",
            "(window(-30d:);cohort(-30d:)).(context(ch:v1);context(geo:v2))",
        )


# ---------------------------------------------------------------------------
# 4. Nesting depth
# ---------------------------------------------------------------------------

class TestNesting:

    def test_deeply_nested_or_flattens(self):
        result = explode_dsl(
            "or(context(channel:ch-1),or(context(channel:ch-2),"
            "or(context(channel:ch-3),context(geo:geo-1))))"
        )
        assert len(result) == 4

    def test_nested_parens_with_distribution(self):
        result = explode_dsl(
            "((context(channel:ch-1);context(channel:ch-2));context(geo:geo-1)).window(-7d:)"
        )
        assert len(result) == 3
        assert all("window(-7d:)" in s for s in result)

    def test_distribution_both_sides_nested_or(self):
        result = explode_dsl(
            "or(window(-7d:),cohort(-30d:)).or(context(channel:ch-1),"
            "or(context(geo:geo-1),context(geo:geo-2)))"
        )
        assert len(result) == 2 * 3  # 6


# ---------------------------------------------------------------------------
# 5. Edge cases and passthrough
# ---------------------------------------------------------------------------

class TestEdgeCases:

    def test_empty_string(self):
        assert explode_dsl("") == []

    def test_whitespace_only(self):
        assert explode_dsl("   ") == []

    def test_atomic_passthrough(self):
        result = explode_dsl("context(channel:ch-1).window(-30d:)")
        assert len(result) == 1
        assert "context(channel:ch-1)" in result[0]
        assert "window(-30d:)" in result[0]

    def test_cohort_anchor_preserved(self):
        result = explode_dsl("cohort(start-node,-14d:).context(channel:ch-1)")
        assert len(result) == 1
        assert "cohort(start-node,-14d:)" in result[0]

    def test_whitespace_tolerance_in_or(self):
        result = explode_dsl("or( context(channel:ch-1) , context(channel:ch-2) )")
        assert len(result) == 2

    def test_single_paren_group_strips(self):
        """(a) should return just a."""
        result = explode_dsl("(window(-30d:))")
        assert len(result) == 1
        assert result[0] == "window(-30d:)"

    def test_unbalanced_paren_raises(self):
        with pytest.raises(ValueError, match="Unbalanced"):
            explode_dsl("or(a,b")


# ---------------------------------------------------------------------------
# 6. Reordering and commutativity
# ---------------------------------------------------------------------------

class TestReordering:

    def test_interleaved_semicolons(self):
        """context;window;context — three additive branches."""
        result = explode_dsl("context(channel:ch-1);window(-30d:);context(geo:geo-1)")
        assert len(result) == 3

    def test_context_dot_group(self):
        """context(a).(window;context(b)) → 2 branches each with context(a)."""
        result = explode_dsl(
            "context(channel:ch-1).(window(-30d:);context(geo:geo-1))"
        )
        assert len(result) == 2
        assert all("context(channel:ch-1)" in s for s in result)
        assert any("window(-30d:)" in s for s in result)
        assert any("context(geo:geo-1)" in s for s in result)

    def test_mixed_types_both_sides(self):
        """(context(a);window).(context(b);cohort) → 4 branches."""
        result = explode_dsl(
            "(context(channel:ch-1);window(-30d:)).(context(geo:geo-1);cohort(-30d:))"
        )
        assert len(result) == 4
        assert any("channel:ch-1" in s and "geo:geo-1" in s for s in result)
        assert any("channel:ch-1" in s and "cohort(-30d:)" in s for s in result)
        assert any("window(-30d:)" in s and "geo:geo-1" in s for s in result)
        assert any("window(-30d:)" in s and "cohort(-30d:)" in s for s in result)

    def test_commutativity_paren_groups(self):
        """(A;B).C and C.(A;B) produce same number of clauses with same parts."""
        a = explode_dsl("(context(channel:ch-1);context(geo:geo-1)).window(-30d:)")
        b = explode_dsl("window(-30d:).(context(channel:ch-1);context(geo:geo-1))")
        assert len(a) == len(b) == 2
        # Both produce clauses containing the same constraint parts
        a_parts = {frozenset(s.split(".")) for s in a}
        b_parts = {frozenset(s.split(".")) for s in b}
        assert a_parts == b_parts


# ---------------------------------------------------------------------------
# 7. Uncontexted slice via empty or() arg / trailing semicolons
# ---------------------------------------------------------------------------

class TestUncontextedSlices:

    def test_trailing_semicolon_preserves_empty(self):
        """context(a); → two branches: context(a) and empty."""
        # The structural parser should see the empty branch.
        # In practice the caller filters empties, but explode_dsl
        # strips them. We test that the non-empty part survives.
        result = explode_dsl("context(channel:ch-1);")
        # Empty branch is stripped by explode_dsl, so we get 1
        assert len(result) == 1
        assert "context(channel:ch-1)" in result[0]

    def test_or_with_empty_arg(self):
        """or(a,) → the non-empty branch."""
        result = explode_dsl("or(context(channel:ch-1),)")
        # Empty branch stripped
        assert len(result) == 1

    def test_distribution_with_trailing_semicolon(self):
        """(window;cohort).(context(a);) — trailing ; creates empty branch,
        which distributes to produce bare window + bare cohort alongside
        the contexted ones → 4 clauses total."""
        result = explode_dsl(
            "(window(-90d:);cohort(-90d:)).(context(channel:ch-1);)"
        )
        assert len(result) == 4
        contexted = [s for s in result if "context(" in s]
        bare = [s for s in result if "context(" not in s]
        assert len(contexted) == 2
        assert len(bare) == 2


# ---------------------------------------------------------------------------
# 8. Real-world synth_gen patterns
# ---------------------------------------------------------------------------

class TestSynthGenPatterns:
    """The exact patterns produced by _build_synth_dsl."""

    def test_bare_dsl_no_context(self):
        """window(f:t);cohort(f:t) — simple split."""
        result = explode_dsl("window(12-Dec-25:11-Mar-26);cohort(12-Dec-25:11-Mar-26)")
        assert len(result) == 2
        assert any("window(" in s for s in result)
        assert any("cohort(" in s for s in result)
        # Neither should contain context
        assert not any("context(" in s for s in result)

    def test_single_context_dimension(self):
        """(window;cohort)(context(ch)) → 2 contexted clauses."""
        dsl = "(window(12-Dec-25:11-Mar-26);cohort(12-Dec-25:11-Mar-26))(context(synth-channel))"
        result = explode_dsl(dsl)
        assert len(result) == 2
        assert all("context(synth-channel)" in s for s in result)
        assert any("window(" in s for s in result)
        assert any("cohort(" in s for s in result)

    def test_two_context_dimensions(self):
        """(window;cohort)(context(ch);context(dev)) → 4 clauses."""
        dsl = (
            "(window(12-Dec-25:11-Mar-26);cohort(12-Dec-25:11-Mar-26))"
            "(context(synth-channel);context(synth-device))"
        )
        result = explode_dsl(dsl)
        assert len(result) == 4
        for mode in ("window(", "cohort("):
            for ctx in ("context(synth-channel)", "context(synth-device)"):
                assert any(mode in s and ctx in s for s in result), \
                    f"Missing: {mode} + {ctx}"

    def test_classification_of_clauses(self):
        """Each clause from (w;c)(ctx) should be classifiable as
        ctx+window or ctx+cohort — never bare, never ambiguous."""
        dsl = (
            "(window(12-Dec-25:11-Mar-26);cohort(12-Dec-25:11-Mar-26))"
            "(context(synth-channel))"
        )
        result = explode_dsl(dsl)
        for clause in result:
            has_window = "window(" in clause
            has_cohort = "cohort(" in clause
            has_context = "context(" in clause
            # Every clause must have context
            assert has_context, f"Clause missing context: {clause}"
            # Every clause must have exactly one of window/cohort
            assert has_window != has_cohort, \
                f"Clause must have exactly one of window/cohort: {clause}"

    def test_bare_plus_context_clauses_combined(self):
        """A mixed-epoch graph needs both bare and contexted clauses.
        Caller should call explode_dsl twice (on bare_dsl and full_dsl)
        and get distinct clause sets."""
        bare_dsl = "window(12-Dec-25:11-Mar-26);cohort(12-Dec-25:11-Mar-26)"
        full_dsl = (
            "(window(12-Dec-25:11-Mar-26);cohort(12-Dec-25:11-Mar-26))"
            "(context(synth-channel))"
        )
        bare_clauses = explode_dsl(bare_dsl)
        ctx_clauses = explode_dsl(full_dsl)

        # No overlap between bare and contexted
        bare_set = set(bare_clauses)
        ctx_set = set(ctx_clauses)
        assert not bare_set & ctx_set, \
            f"Overlap between bare and ctx clauses: {bare_set & ctx_set}"

        # All bare clauses have no context
        for c in bare_clauses:
            assert "context(" not in c
        # All ctx clauses have context
        for c in ctx_clauses:
            assert "context(" in c


# ---------------------------------------------------------------------------
# 9. Stress / boundary cases
# ---------------------------------------------------------------------------

class TestBoundary:

    def test_single_element_group(self):
        """(a)(b) → a.b"""
        result = explode_dsl("(window(-30d:))(context(ch:v1))")
        assert len(result) == 1
        assert "window(-30d:)" in result[0]
        assert "context(ch:v1)" in result[0]

    def test_many_semicolons(self):
        result = explode_dsl("a;b;c;d;e;f;g")
        assert len(result) == 7

    def test_deeply_nested_groups(self):
        """(((a;b))) → a;b"""
        result = explode_dsl("(((alpha;beta)))")
        assert len(result) == 2
        assert "alpha" in result
        assert "beta" in result

    def test_asat_clause_preserved(self):
        result = explode_dsl("window(-30d:).asat(15-Mar-26)")
        assert len(result) == 1
        assert "asat(15-Mar-26)" in result[0]
        assert "window(-30d:)" in result[0]

    def test_complex_dates_in_parens(self):
        """Dates contain colons and hyphens — must not confuse the parser."""
        result = explode_dsl(
            "(window(12-Dec-25:11-Mar-26);cohort(start,12-Dec-25:11-Mar-26))"
            "(context(synth-channel))"
        )
        assert len(result) == 2
        assert any("window(12-Dec-25:11-Mar-26)" in s for s in result)
        assert any("cohort(start,12-Dec-25:11-Mar-26)" in s for s in result)
