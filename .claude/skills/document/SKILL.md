---
name: document
description: Review the full conversation and ensure all decisions, designs, and knowledge are properly documented in codebase docs and/or public docs. Creates or updates docs as needed.
---

# Document

Review everything discussed in this conversation and ensure it is properly documented in the appropriate location(s). This skill captures decisions, designs, architectural understanding, and user-facing changes into durable documentation.

## Instructions

1. **Review the full conversation** — scan all turns. Identify:
   - New subsystem understanding or architectural insights
   - Design decisions and their rationale
   - New features, behaviours, or API changes
   - Bug root causes that revealed non-obvious system behaviour
   - New fields, schemas, or data model changes
   - Workflow or process decisions

2. **Classify each item** into one or more documentation targets:

   | What was discussed | Where it belongs |
   |---|---|
   | How a subsystem works, data flows, invariants, guard mechanisms | `docs/current/codebase/` — update existing doc or create new one |
   | Design for a planned feature or system change | `docs/current/project-contexts/` or relevant design doc |
   | Diagnostic procedures, debugging checklists | `docs/current/codebase/DIAGNOSTIC_PLAYBOOKS.md` or relevant subsystem doc |
   | Anti-patterns discovered, failure modes with known fixes | `docs/current/codebase/KNOWN_ANTI_PATTERNS.md` |
   | User-facing feature, UI behaviour, query syntax, keyboard shortcuts | `graph-editor/public/docs/` — update relevant user-facing doc |
   | Changelog-worthy feature or fix | `graph-editor/public/docs/CHANGELOG.md` |
   | Reserved terms, glossary additions | `docs/current/codebase/RESERVED_QUERY_TERMS_GLOSSARY.md` |
   | Schema changes, new fields | `docs/current/codebase/SCHEMA_AND_TYPE_PARITY.md` and relevant subsystem doc |
   | Graph-ops procedures | `graph-ops/playbooks/` or `graph-ops/reference/` |

3. **Check existing docs first** — before creating a new doc, search for an existing one covering the same subsystem or topic. Prefer updating existing docs over creating new ones. Use the Task-Type Reading Guide in CLAUDE.md to identify relevant existing docs.

4. **For each documentation target**, either:
   - **Update** the existing doc with the new information, integrating it naturally into the existing structure
   - **Create** a new doc only if no suitable home exists (use UPPER_SNAKE_CASE.md for codebase docs, kebab-case.md for project contexts and public docs)

5. **Writing standards**:
   - UK English throughout (colour, behaviour, centre, etc.)
   - Dates in d-MMM-yy format
   - Prose only in design/architecture docs — no code snippets. Reference file paths and line numbers instead.
   - For codebase docs: focus on *how the system actually works*, not how it *should* work. Document the real behaviour, including edge cases and gotchas.
   - For public docs: focus on what the user needs to know to use the feature. Keep it practical and scannable.
   - Be specific — "the forecast service" is vague; "`forecastingParityService.ts` compares FE and BE topo-pass results field-by-field" is useful.

6. **Cross-reference updates**:
   - If a new codebase doc is created, check whether CLAUDE.md's Task-Type Reading Guide should reference it
   - If new terms are introduced, check whether they belong in the glossary
   - If a doc references other docs, verify those references are correct

## After documenting

7. **Report to the user**:
   - List each doc created or updated, with file path and a one-line summary of what was added
   - Flag any items from the conversation that you chose NOT to document, with reasoning (e.g. "too ephemeral", "already in the code", "derivable from git history")
   - Ask if anything was missed or if any item should be documented differently

## Quality checks

- **No stale content** — if updating an existing doc, read it first and ensure the new content is consistent with what's already there. If it contradicts existing content, flag to the user.
- **No code snippets in codebase docs** — reference file paths instead.
- **No duplicate docs** — if two docs would cover the same topic, merge into one.
- **Generalisable insights only** — document the *system behaviour*, not the specific bug or conversation. The conversation is ephemeral; the doc should be durable.
- **Not too granular** — don't create a doc for every small decision. Group related insights into a single coherent doc.
