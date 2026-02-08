"""
Golden parity test for short_core_hash_from_canonical_signature.

Loads the shared fixture (core-hash-golden.json) and verifies the existing
Python implementation produces the expected core_hash for each input.

This test must pass BEFORE any migration work begins — it validates that
the fixture was generated correctly and the Python function is stable.
"""
import json
import os
import pytest

# The function under test lives in snapshot_service.py which is in lib/
# Add lib/ to the path so we can import it directly.
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from snapshot_service import short_core_hash_from_canonical_signature


FIXTURE_PATH = os.path.join(os.path.dirname(__file__), 'fixtures', 'core-hash-golden.json')


def load_golden_fixture():
    with open(FIXTURE_PATH, 'r', encoding='utf-8') as f:
        return json.load(f)


@pytest.fixture
def golden_cases():
    return load_golden_fixture()


class TestCoreHashGoldenParity:
    """Verify the Python hash function matches every golden fixture entry."""

    def test_fixture_is_non_empty(self, golden_cases):
        assert len(golden_cases) > 0, "Golden fixture must contain at least one test case"

    @pytest.mark.parametrize(
        "case",
        load_golden_fixture(),
        ids=[c.get("description", f"case-{i}") for i, c in enumerate(load_golden_fixture())],
    )
    def test_golden_case(self, case):
        result = short_core_hash_from_canonical_signature(case["input"])
        assert result == case["expected"], (
            f"Parity failure for '{case.get('description', '?')}':\n"
            f"  input:    {case['input']!r}\n"
            f"  expected: {case['expected']}\n"
            f"  got:      {result}"
        )

    def test_whitespace_cases_match_trimmed(self, golden_cases):
        """Extra safety: whitespace-padded inputs must produce the same hash as their trimmed equivalents."""
        trimmed_hash = short_core_hash_from_canonical_signature('{"c":"abc","x":{}}')
        for case in golden_cases:
            if "whitespace" in case.get("description", "").lower() or "spaces" in case.get("description", "").lower():
                result = short_core_hash_from_canonical_signature(case["input"])
                assert result == trimmed_hash, (
                    f"Whitespace case did not match trimmed: {case.get('description')}"
                )
