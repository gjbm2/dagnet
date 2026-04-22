from __future__ import annotations

import pytest

from bayes.tracker.renderer import MARKER_SECTIONS, RendererError, render_into


def test_render_fills_markers_and_preserves_outside(tmp_md, sample_state):
    before = tmp_md.read_text(encoding="utf-8")
    assert "Preamble text preserved." in before
    render_into(tmp_md, sample_state)
    after = tmp_md.read_text(encoding="utf-8")
    # Outside-region narrative preserved byte-for-byte.
    assert "Preamble text preserved." in after
    assert "Middle narrative." in after
    assert "More narrative." in after
    assert "Tail.\n" in after
    # Markers still present.
    for section in MARKER_SECTIONS:
        assert f"<!-- tracker:{section}:start -->" in after
        assert f"<!-- tracker:{section}:end -->" in after


def test_render_populates_current_line(tmp_md, sample_state):
    render_into(tmp_md, sample_state)
    text = tmp_md.read_text(encoding="utf-8")
    assert "Current line**: sparse-graph completion" in text
    assert "Current priority**: blockers first" in text


def test_render_populates_run_log_reverse_chronological(tmp_md, sample_state):
    render_into(tmp_md, sample_state)
    text = tmp_md.read_text(encoding="utf-8")
    idx_r1 = text.find("R-001 — Initial sparse regression")
    idx_r2 = text.find("R-002 — Post-parser rerun")
    assert idx_r1 != -1 and idx_r2 != -1
    # Reverse-chronological means R-002 appears before R-001.
    assert idx_r2 < idx_r1


def test_render_populates_issues_grouped(tmp_md, sample_state):
    render_into(tmp_md, sample_state)
    text = tmp_md.read_text(encoding="utf-8")
    # Both issues rendered; state-group headings present.
    assert "I-001 — Parser artefact" in text
    assert "I-002 — Onset bias" in text
    assert "### Observed" in text
    assert "### Verified" in text


def test_render_overwrites_previous_region_content(tmp_md, sample_state):
    tmp_md.write_text(
        tmp_md.read_text(encoding="utf-8").replace(
            "<!-- tracker:current-line:start -->\n"
            "<!-- tracker:current-line:end -->",
            "<!-- tracker:current-line:start -->\n"
            "STALE CONTENT\n"
            "<!-- tracker:current-line:end -->",
        ),
        encoding="utf-8",
    )
    render_into(tmp_md, sample_state)
    text = tmp_md.read_text(encoding="utf-8")
    assert "STALE CONTENT" not in text
    assert "sparse-graph completion" in text


def test_render_missing_markers_raises(tmp_md, sample_state):
    tmp_md.write_text(
        "# No markers here\n\nPlain content.\n", encoding="utf-8"
    )
    with pytest.raises(RendererError, match="marker regions missing"):
        render_into(tmp_md, sample_state)


def test_render_missing_file_raises(tmp_path, sample_state):
    with pytest.raises(RendererError, match="not found"):
        render_into(tmp_path / "nope.md", sample_state)


def test_render_is_idempotent(tmp_md, sample_state):
    render_into(tmp_md, sample_state)
    first = tmp_md.read_text(encoding="utf-8")
    render_into(tmp_md, sample_state)
    second = tmp_md.read_text(encoding="utf-8")
    assert first == second
