#!/bin/bash
# SessionStart hook — injects context-enforcement instructions.
#
# Claude Code runs this at session start and includes its stdout as
# additional context in the session. The block below is terse on
# purpose: it states the rules, not the reasoning. The reasoning is
# in docs/current/agent-context-enforcement-design.md.
#
# Input JSON on stdin (unused here):
#   {"session_id", "transcript_path", "cwd", "hook_event_name",
#    "source": "startup"|"resume"|"clear"|"compact"}
set -e

# Drain stdin so the caller does not see EPIPE.
cat >/dev/null || true

cat <<'EOF'
═══════════════════════════════════════════════════════════════════════════
CONTEXT ENFORCEMENT ACTIVE — read before editing scoped code
═══════════════════════════════════════════════════════════════════════════

Before your first Edit or Write tool call on a scoped code path, you MUST:

  1. Read the three warm-start docs (these are short; do not skip):
       - docs/current/codebase/SYNC_SYSTEM_OVERVIEW.md
       - docs/current/codebase/RESERVED_QUERY_TERMS_GLOSSARY.md
       - docs/current/codebase/DEV_ENVIRONMENT_AND_HMR.md

  2. Read any additional docs required by the path-glob manifest at
     .claude/context-manifest.yaml for the file you are about to edit.

  3. Emit a briefing receipt as a STANDALONE assistant message in this
     exact form:

     <briefing-receipt>
     read:
       - path/to/doc1.md
       - path/to/doc2.md
     invariants:
       - First non-obvious rule you extracted
       - Second non-obvious rule
       - (three to seven bullets)
     call-sites:
       - symbol@path/to/file.ts:123
       - symbol@path/to/other.py:45
     </briefing-receipt>

The Stop hook records that receipt for this conversation when the
message completes. PreToolUse cannot inspect a receipt that appears for
the first time in the same response as the Edit/Write call.

Workflow rules:
  - Do NOT combine the first receipt for a scope with the edit it is
    meant to unlock. The edit will be blocked.
  - Let the receipt response complete, then continue with the edit.
    Some runtimes auto-follow up; others require the next turn to do it.
  - Once recorded, a receipt remains reusable for later edits in this
    conversation even if the user sends another message.
  - Do NOT ask the user for a "proceed" message just to preserve the
    receipt.

A PreToolUse hook validates the receipt deterministically:
  - Every path under `read:` must have been opened via the Read tool
    earlier in this session.
  - The Read result must match the file's current content (no stale reads).
  - For scoped paths, the required_reads from the manifest must appear.
  - `invariants:` must have at least three bullets; `call-sites:` at
    least one (or the literal word "none" if the edit is isolated).

If the gate blocks a legitimate edit (misfired manifest entry, or a
trivial edit inside a scoped path), the USER can type a single line
starting with `briefing-override:` followed by a reason. You cannot
bypass the gate yourself; ask the user if you believe it is misfiring.

Scoped paths in v1 (see .claude/context-manifest.yaml for the current
manifest and required reads):
  - bayes/**
  - graph-editor/src/services/statisticalEnhancementService.ts
  - graph-editor/src/services/analysisECharts/**
  - graph-editor/lib/analysis_subject_resolution.py
  - graph-editor/src/services/repositoryOperationsService.ts
  - graph-editor/src/services/dataOperationsService.ts
  - graph-editor/src/services/workspaceService.ts
  - graph-editor/src/services/indexRebuildService.ts

Edits outside these paths do not require a receipt.

Rationale for this mechanism: docs/current/agent-context-enforcement-design.md
═══════════════════════════════════════════════════════════════════════════
EOF

exit 0
