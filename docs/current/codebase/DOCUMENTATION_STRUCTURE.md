# Documentation Structure

## User-Facing Documentation
**Location:** `graph-editor/public/docs/`

User guides, references, and changelogs accessible in-app and on GitHub:
- `user-guide.md` - Getting started and core concepts
- `query-expressions.md` - Query DSL reference
- `api-reference.md` - Programmatic access
- `keyboard-shortcuts.md` - Productivity tips
- `CHANGELOG.md` - Release history

## Technical Documentation
**Location:** `docs/`

Developer and architecture documentation:

1. **Current Docs** (`docs/current/`)
   - **Root** (`docs/current/*.md`) - Default home for active docs: design specs, investigation records, open issue lists, pending plans. If a doc doesn't belong in a subdirectory, it lives here.
   - **Codebase** (`docs/current/codebase/`) - Curated, indexed reference library of how the app works. Architecture, subsystem design, standards, patterns. NOT a dumping ground — docs here should be groomed, reviewed against existing coverage, and properly indexed.
   - **Contexts feature project** (`docs/current/project-contexts/`) - Design docs for the "contexts" app feature ONLY. Not a general bucket.
   - **Handover Notes** (`docs/current/handover/`) - Session continuity notes from previous agent sessions. If one exists for your current work area, **read it first** — it contains decisions, rationale, and gotchas that are expensive to re-derive.

2. **Component Docs** (`graph-editor/docs/`)
   - Component-specific technical documentation
   - Setup guides (e.g., `AMPLITUDE_CREDENTIALS_SETUP.md`)
   - Testing guides (`INTEGRATION_TESTING_GUIDE.md`, `TESTING_STRATEGY.md`)

3. **Archive** (`docs/archive/`)
   - Historical documentation
   - Completed work - useful for understanding design decisions

## When Making System Changes

**ALWAYS check relevant docs BEFORE making changes:**
1. Check `docs/current/handover/` for any handover notes relevant to the current work area
2. Search `docs/current/codebase/` for architecture decisions and known issues
3. Search `docs/archive/` for historical context on design decisions
4. Update `graph-editor/public/docs/` if user-facing behaviour changes
