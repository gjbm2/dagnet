# Agent Context Enforcement — Design Proposal

**Status**: Proposal, awaiting approval
**Author**: Prepared for review by Greg
**Date**: 21-Apr-26
**Scope**: Claude Code harness configuration for the dagnet repository

## Summary

This document proposes a mechanism to stop Claude Code agents from guessing at code paths instead of reading the mandated briefing docs. The problem is endemic, severe, and — as external research confirms — a documented model-level failure of Opus 4.6 rather than a prompting skill issue. The fix has to run in the harness, not the model. The proposal is a three-part hook stack, scoped to the areas of the codebase where guessing is most dangerous, rolled out in phases from warn-only to blocking.

## The problem

Our `CLAUDE.md` currently mandates a "warm start" routine at the top of every session: read three foundational docs (sync overview, reserved terms glossary, dev environment guide), then read task-specific docs from the reading guide. The language is as strong as prose can be — `MANDATORY`, `HARD BLOCK`, `before doing ANY work`.

In practice, agents routinely skip this and proceed to edit code based on pattern-matching from training data. The damage is disproportionately concentrated in functionally complex domains — statistical forecasting, Bayesian inference, the sync machinery, the analysis subject resolution paths. These are exactly the domains where pattern-matching is most dangerous, because the code looks conventional while encoding non-obvious invariants. Every missed warm start in these areas generates rework, external verification load, and, in several recent incidents, silent regressions that only surfaced under adversarial review.

The cost is no longer acceptable. It blocks downstream work, erodes trust in agent output, and makes it impossible to delegate cognitively dense tasks without external babysitting.

## Evidence this is a model-level failure, not a prompting failure

Research into the current state of the practice confirms that this failure mode is widely documented against Opus 4.6 specifically, and is not resolvable by stronger wording in the system prompt.

Anthropic's own issue tracker holds multiple open, well-populated reports: agents ignoring skills and `CLAUDE.md` rules under default high-think-effort, agents skipping mandatory session-start files to optimise for speed, agents preferring training-data patterns over the documented rules file, and a specific regression around 15-Apr-26 in which the multi-tier rules hierarchy stopped being followed where it had previously worked. The community consensus, shared by multiple engineering blogs and by Anthropic's own guidance, is that `CLAUDE.md` functions as soft context — it competes for attention with everything else in the window — and that extended thinking budgets make the problem worse by increasing the weight of the model's internal plan relative to the injected rules.

A further finding that reshapes our thinking: Vercel's public evaluation reports that Claude Code skills are skipped in fifty-six per cent of cases where they ought to fire. Skills are a useful mechanism for isolating context within a specialist subagent, but they cannot carry enforcement. Any design that depends on the model electing to invoke a skill is unreliable by construction.

The implication is direct. Exhortations in the rules file, no matter how strongly worded, cannot fix this. The harness can. Hooks, unlike rules, are executed by the runtime. The model has no choice about whether they fire.

## Design principles

Five principles shape the proposal.

**Mechanism over exhortation.** The failure mode is that the model disregards text in the prompt. Adding more text cannot fix this. Anything load-bearing must be enforced by the harness through hooks.

**Scoped, not blanket.** Blanket enforcement penalises trivial sessions — a typo fix in a README, a one-line documentation edit — and trains agents and humans alike to route around the gate. Gates should fire only when the edit touches a surface where the cost of guessing is high. The surfaces we care about are well-known and enumerable.

**Auditable, not introspective.** Hooks can observe tool calls; they cannot verify that content was absorbed. The design must demand artefacts the agent has to produce — a briefing receipt — and verify those artefacts deterministically (for example by file content hash), rather than try to infer whether reading "really" happened.

**Recoverable by design.** Any gate that blocks progress must offer a clearly documented override path. The override is an escape valve for legitimate edge cases (a one-line fix that genuinely does not need the briefing) and for hook-logic failure (a misfire in the manifest). Overrides must be visible in the transcript so they are auditable, not silent.

**Ship blocking on day one; the override is the safety mechanism.** A phased warn-only rollout is the default reflex for new harness rules, but it does not match the severity of the failure this design is addressing. The override path, by design, lets us punch through any misfire of an unvalidated manifest entry in seconds. That is what makes it safe to enforce immediately — the cost of a false positive is one typed line, and the cost of continued under-enforcement is the rework pattern this document was written to stop. The manifest is tightened in place as evidence arrives, not on a phase schedule.

## Proposed mechanism

The proposal is a three-part hook stack, each part addressing a different failure mode.

### Part one: forced context injection at session start

A SessionStart hook assembles the warm-start material and injects it directly into the session as structured additional context. The material is the same three foundational docs the rules file already names — sync system overview, reserved terms glossary, dev environment guide — but it arrives as a system-reminder the model cannot elect to skip, rather than as a pointer the model must elect to follow.

The distinction matters. Today, the rules file tells the model *to read* the briefing docs. Tomorrow, the hook will *have read* them on the model's behalf, and the content will be present in the window from the first turn. This removes the "I forgot to read them" failure mode entirely. It does not remove the "I read them but ignored them" failure mode, which is what parts two and three address.

Injected content must be budget-aware. The harness allows roughly ten thousand characters in the direct injection path; anything larger spills to a temporary file with a pointer. Our three foundational docs fit comfortably in the budget today, and we should actively resist growing them — the injection is not a dumping ground for every doc we might want the agent to see, only the irreducible minimum.

### Part two: briefing receipt as a prerequisite to editing

Before the first Edit or Write tool call in a session that touches a scoped path (see scope section below), the agent must produce a structured briefing receipt. The receipt is a short block stating, in the agent's own words, which task-specific docs it consulted beyond the warm start, what invariants it extracted from them, and which existing call-sites or services in the affected path it traced. The receipt is prose, produced as a standalone assistant message, and is visible in the transcript.

A Stop hook captures the receipt from `last_assistant_message` when the response completes, stores the latest receipt in a small conversation-local cache, and leaves older receipts discoverable in the transcript. The scoped PreToolUse gate first checks the cached latest receipt and then falls back to earlier receipts in the same conversation, so a valid receipt survives later user messages instead of being tied to one invisible turn boundary. Where the runtime supports stop-hook follow-up messages, the hook can also auto-continue after recording a receipt, removing the need for the user to hand-hold the model through an extra "continue" turn. Validation is deterministic: the gate checks that a receipt block is present, that it lists at least the minimum set of docs required by the task-type manifest, and that the file paths cited in the receipt correspond to files the agent actually opened via Read in the current session (cross-checked against the transcript). If the receipt is missing, incomplete, or cites files the agent did not open, the hook returns a block with a clear reason pointing the agent at what is missing. This split is necessary because PreToolUse does not receive the in-flight assistant text for the current response.

This mechanism is the load-bearing one. It addresses the commonest current failure: agents that assert they have understood a system when they have not read its key documents or call-sites. By making the assertion explicit and the check deterministic, we convert a soft claim into a verifiable artefact.

### Part three: scoped PreToolUse gate on required reads

For the highest-risk surfaces — the Bayesian compiler, the statistical enhancement paths, the sync and IDB machinery, the analysis subject resolution code — a PreToolUse hook cross-references the file being edited against a required-reads manifest. If the manifest lists specific docs as prerequisites for edits to that path, and the transcript shows those docs have not been read, the hook blocks the Edit or Write with a pointer to the missing docs.

This is narrower and stricter than part two. Part two requires a receipt; part three requires the receipt to include particular reads for particular paths. The justification is that these surfaces have repeatedly produced the rework incidents we are trying to stop, and a generic receipt is not enough — we need to know the agent looked at the specific invariants that matter for this specific path.

The manifest is the design artefact that does most of the work. It maps path globs to required-reading sets. It lives in the repo as a versioned file and is maintained as the docs evolve. The initial manifest should be small — four or five entries covering the known hot spots — and grow only when a post-mortem on a specific incident identifies a path that deserves inclusion.

## Scope

The scoped paths in the initial manifest should cover the surfaces where guessing has demonstrably cost us time. Based on the recent pattern of rework and external-review catches, the candidates are the Bayesian compiler and inference code, the statistical enhancement service, the analysis subject resolution module, the forecasting and funnel builders, the sync and workspace services, and the repository operations service. Out of scope for the initial rollout: documentation files, test fixtures, configuration files, and top-level UI components that only surface data produced elsewhere.

The manifest should name each scoped path and the minimum set of docs the agent must consult before editing it. Where a path already has a project-level doc (for example a forecasting architecture doc or the sync system overview), that doc is the required read. Where a path does not yet have such a doc, the correct response to drafting the manifest is to notice the gap and either write the doc or explicitly mark the path as "briefing-gap, receipt only" — the manifest is also a forcing function for documentation coverage.

## Rollout

All three hooks ship blocking from the first session after merge. No warn-only phase, no staged enablement. The justification is the severity of the problem this proposal was written to address — a phased rollout trades weeks of continued under-enforcement for risk reduction we can buy more cheaply through the override.

The override is the load-bearing safety mechanism. An entry in the path-glob manifest that misfires on a legitimate edit costs the user one typed line to bypass. That bound on the worst case is what makes immediate blocking safe in a way that harness rules without escape valves are not.

The manifest is treated as a living artefact from day one. Every override fires a log entry through the existing session-log service; manifest entries that produce repeated overrides are candidates for narrowing or removal. Every incident review of agent rework asks whether the manifest should grow. Every new high-risk subsystem gets a manifest entry as part of its acceptance criteria. Ownership per entry (named in the manifest) is the mechanism that stops this review discipline from decaying into nobody's job.

Two checkpoints we should hold even without phasing: a one-week review of override frequency and reasons (to catch manifest misfires quickly), and a first-month review of whether the receipt mechanism alone is carrying the weight or whether the path-glob manifest is doing material additional work. If the receipt mechanism is sufficient on its own, part three can be retired rather than extended — simplicity wins where it can.

## Design decisions

Five specific decisions, each grounded in current published practice and proposed as the v1 behaviour.

**Override must originate from the user, not the agent.** The receipt gate is bypassed for one turn, and one turn only, when the most recent user message contains the literal prefix `briefing-override:` followed by a free-text reason on the same line. The reason is required. The hook checks the message author role, not the content — an agent cannot forge an override because it cannot author a user-role message. The override appears in the transcript and is logged through the existing session-log service. This pattern is adapted from the user-origin task-marker convention popularised by the claudefa.st Stop-hook write-up and by the "500 lines of rules" DEV post, both of which report that overrides drift into habit when any party can invoke them. Friction is the point: the user types the reason every time.

**Receipt is a delimited block with three required fields, captured via Stop and validated via PreToolUse.** The agent emits a block opened by the literal tag `<briefing-receipt>` and closed by the matching tag, as a standalone assistant message before the first Edit or Write in a session that touches a scoped path. The block contains three fields on separate lines — `read:` (repo-relative file paths consulted), `invariants:` (three to seven bullet lines describing the non-obvious rules extracted), and `call-sites:` (symbols in `path:line` form for existing code the change will interact with). The Stop hook persists the newest receipt for the conversation, and PreToolUse can fall back to earlier receipts from the same transcript when a later turn edits the same scoped area. This removes the brittle "receipt must land and be used in the same user turn" coupling while preserving the rule that PreToolUse cannot see text that appears for the first time in the same response as the tool call. Validation then runs deterministically against the session transcript: every path listed under `read:` must appear in a completed Read tool call earlier in the session, and the Read result for that path must match the file's current content (guards against stale reads and against citing a path that was only Grep'd). The SHA-based "bundle citation" variant from the Agentic Coding Trends material was considered and rejected for v1 — transcript cross-check achieves the same anti-gaming property with lower implementation cost, because the transcript already contains the Read results the hook needs.

**Manifest lives at `.claude/context-manifest.yaml` with five v1 entries and owned per-entry.** Part three keys on path globs, not on imported-service analysis: direct globs are deterministic, fast, and easy to debug when they misfire. The initial five entries cover the surfaces with the worst recent rework history — the Bayes compiler and inference tree under `bayes/`; the statistical enhancement service and forecasting builders under `graph-editor/src/services/`; the analysis subject resolution module under `graph-editor/lib/`; the repository operations service and workspace service under `graph-editor/src/services/`; the sync and index-rebuild services. Each entry names the specific docs required before an edit proceeds, and each entry carries an owner field (the person responsible for keeping the mapping current). Ownership is the anti-rot mechanism — manifests without owners are exactly the kind of dead config we already have too much of. Transitive required-reads (inferring requirements from imports) is explicitly out of scope for v1.

**Plan Mode reduces the receipt burden but does not replace it.** If the session entered Act Mode from Plan Mode, and a plan document exists in the conversation naming the scoped paths being edited, the `invariants:` field may collapse to a pointer into the plan (for example `see plan §3.2 — kept-alive cohorts rule`). The `read:` and `call-sites:` fields remain required in full. This matches the published guidance that Plan Mode earns its keep only when exit requires explicit user approval: the approved plan is a user-sanctioned statement of intent, not evidence that context was grounded. Treating it as a substitute for the receipt would reintroduce the exact failure we are fixing. Treating it as wholly redundant with the receipt wastes what Plan Mode actually gives us.

**Subagents face the identical stack; parent receipts do not carry forward.** SessionStart injection, the receipt gate, and the path-glob manifest all apply to subagent sessions exactly as they do to the parent. Parent-session receipts cannot transfer, because subagents receive their own context window — the premise of subagent isolation. The implication is a shift in how the parent prompts its subagents: when delegating a task that will edit a scoped path, the parent's brief must include the warm-start material by content (not by pointer), the relevant docs by name, and the specific call-sites the parent has already traced, so the subagent has what it needs to produce its own receipt without re-duplicating the research. This matches the pattern in Anthropic's "Orchestrate teams of Claude Code sessions" guidance: the parent's responsibility is to hand over sufficient grounding, not to assume inheritance.

## Non-goals

Several things this design does **not** attempt, and should not be extended to attempt without a further proposal.

It does not try to verify that the agent has *understood* the docs it has read. Content-hash checks confirm the files were opened, not that the invariants landed. The receipt is a declaration, not a proof. The cost of trying to verify understanding automatically is disproportionate to the benefit and the failure modes of such verification are worse than the failure modes it would catch.

It does not replicate or replace `CLAUDE.md`. The rules file remains the canonical human-readable statement of how we work. The hooks are an enforcement layer *for the most load-bearing rules*, not a substitute for the rest of the file.

It does not extend to the adjacent private repositories. The pre-commit hook that protects those repositories is a separate, existing mechanism. This proposal is specific to the dagnet working directory.

It does not attempt to catch every possible class of poor agent behaviour. It targets one specific, endemic failure: editing scoped code paths without having read the docs that explain their invariants. Other failure modes — misuse of destructive git commands, weakening of tests without approval, blaming server staleness without evidence — are governed by other hooks already in place or by rules in `CLAUDE.md` that are less frequently violated.

## Future extensions

Two extensions are likely follow-ups once the hook stack is stable.

The first is symbol-level retrieval via an MCP server such as Serena or CodeGraphContext. Replacing ad-hoc Read and Grep discovery with deterministic symbol lookups (find-definition, find-references) makes the cheap path the grounded path — the agent stops inventing function signatures because finding the real ones is easier than guessing. This is particularly valuable for the Bayesian and forecasting code, where call graphs are load-bearing and where the current read-a-file, grep-around pattern produces the most pattern-matched guesses.

The second is a property-first or contract-first discipline for the statistical surfaces, extending what we already do for the Bayes compiler. New branches in the statistical enhancement service and the forecasting builders would require a synthetic builder and a property assertion before they can be merged. The recent research on property-generated solving and agentic property-based testing shows material gains in exactly this regime, and we have the scaffolding in place to apply it.

Both extensions assume the hook stack is working. They are amplifiers of a working mechanism, not replacements for one.

## Appendix: selected sources from the research

The research that shaped this proposal drew on several primary sources. The most load-bearing were the open Anthropic issue threads documenting the failure mode against Opus 4.6 specifically, the Anthropic Hooks reference for the capabilities and limits of the mechanism, the DEV Community post on using hooks for guaranteed context injection (including the Vercel skills-skip eval), the "500 lines of rules" engineering write-up, the Anthropic 2026 Agentic Coding Trends report, and the ArXiv papers on property-based testing for LLM-generated code (2506.18315 and 2510.09907). Full links are held in the session transcript that accompanied this proposal's drafting and can be added as a references section on request.
