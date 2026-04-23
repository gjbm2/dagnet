from __future__ import annotations

from pathlib import Path

import pytest

from bayes.tracker.storage import (
    TrackerStorageError,
    exclusive_lock,
    load,
    save,
)


def test_roundtrip_preserves_state(tmp_yaml, sample_state):
    save(tmp_yaml, sample_state)
    loaded = load(tmp_yaml)
    # Compare via model_dump to avoid id-object identity issues.
    assert loaded.model_dump(mode="json") == sample_state.model_dump(mode="json")


def test_load_missing_file_raises(tmp_yaml):
    with pytest.raises(TrackerStorageError, match="not found"):
        load(tmp_yaml)


def test_load_malformed_yaml_raises(tmp_yaml):
    tmp_yaml.parent.mkdir(parents=True, exist_ok=True)
    tmp_yaml.write_text("this: is: not: yaml:\n  [garbage", encoding="utf-8")
    with pytest.raises(TrackerStorageError, match="YAML parse error"):
        load(tmp_yaml)


def test_load_rejects_unknown_keys(tmp_yaml, sample_state):
    save(tmp_yaml, sample_state)
    text = tmp_yaml.read_text(encoding="utf-8")
    tmp_yaml.write_text(text + "\nsurprise_key: oops\n", encoding="utf-8")
    with pytest.raises(TrackerStorageError, match="schema validation"):
        load(tmp_yaml)


def test_load_rejects_missing_required_field(tmp_yaml, sample_state):
    save(tmp_yaml, sample_state)
    # Rename a required key so the YAML stays valid but the schema
    # sees the field as missing (and an unknown key present).
    text = tmp_yaml.read_text(encoding="utf-8")
    corrupted = text.replace("why_this_run_exists:", "mystery_field:", 1)
    tmp_yaml.write_text(corrupted, encoding="utf-8")
    with pytest.raises(TrackerStorageError, match="schema validation"):
        load(tmp_yaml)


def test_load_rejects_invalid_enum(tmp_yaml, sample_state):
    save(tmp_yaml, sample_state)
    text = tmp_yaml.read_text(encoding="utf-8")
    corrupted = text.replace("state: verified", "state: bogus_state")
    tmp_yaml.write_text(corrupted, encoding="utf-8")
    with pytest.raises(TrackerStorageError, match="schema validation"):
        load(tmp_yaml)


def test_save_validates_cross_refs(tmp_yaml, sample_state):
    # Mutate to introduce a dangling reference.
    sample_state.runs[0].related_issue_ids.append("I-999")
    with pytest.raises(ValueError, match="missing issue"):
        save(tmp_yaml, sample_state)


def test_exclusive_lock_reentrant(tmp_yaml, sample_state):
    save(tmp_yaml, sample_state)
    # Reentry within the same process should not deadlock.
    with exclusive_lock(tmp_yaml):
        with exclusive_lock(tmp_yaml):
            loaded = load(tmp_yaml)
            assert loaded.current_line.label == "sparse-graph completion"


def test_atomic_write_survives_temp_presence(tmp_yaml, sample_state):
    # Leave a stale temp file; subsequent save must still succeed and
    # must not see or include the stale file's content.
    tmp_yaml.parent.mkdir(parents=True, exist_ok=True)
    stale = tmp_yaml.parent / f".{tmp_yaml.name}.stale.tmp"
    stale.write_text("garbage", encoding="utf-8")
    save(tmp_yaml, sample_state)
    assert "garbage" not in tmp_yaml.read_text(encoding="utf-8")
