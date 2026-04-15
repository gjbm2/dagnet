---
title: DagNet as Daily Management Tool
date: 9-Apr-26
status: draft
---

# DagNet as Daily Management Tool

## Problem

DagNet has a working graph editor, daily data pipeline, and TV dashboard — but it's
not delivering business value because (a) the graph on display is too complex to read,
(b) analytical features (bridge views, scenarios, contexts) aren't being used, and
(c) there's no workflow connecting what DagNet shows to decisions being made.

The boss wants DagNet used daily. The team currently uses Amplitude for "what happened"
and Omni for ad-hoc queries. DagNet's unique value — structural funnel reasoning,
scenario comparison, and "where should we focus" — is untapped.

## Solution

Replace the TV dashboard graph with the new li-energy-simple-v1 (15 nodes, readable
from across the room) and build a rotating view cycle that surfaces actionable
insights: experiment comparisons, week-over-week changes, and eventually forecasts.
Establish a weekly rhythm where DagNet findings drive conversion discussions.

## User Stories

- As a founder, I want to glance at the TV and see whether IP v3 is outperforming v2
  so I can decide whether to roll it out wider
- As a team member, I want to see which funnel step changed this week so I know where
  to investigate
- As a manager, I want to compare onboarding variants (v3 vs v4) at a glance so I can
  prioritise engineering work on the right variant
- As a founder, I want the old cluttered graphs archived so the tool feels clean and
  usable when I open it

## Acceptance Criteria

### Phase 1: TV-Ready (this week)
- [ ] li-energy-simple-v1 replaces li-cohort-segmentation-v2 on the TV dashboard
- [ ] Layout is clean and legible at TV distance (no overlapping nodes, clear flow)
- [ ] Rotating views cycle through: Funnel Overview → IP v2 vs v3 → Week-over-week → LI v3 vs v4
- [ ] Bridge views show full waterfall decomposition (not just start/end bars)
- [ ] All 6 scenarios have data and are regenerating on daily fetch

### Phase 2: Insight Rhythm (weeks 2-3)
- [ ] Weekly review uses DagNet bridge view as primary artefact
- [ ] At least one conversion decision is informed by a DagNet bridge view
- [ ] IP v3 experiment has enough data for meaningful v2 vs v3 comparison
- [ ] Cohort maturity chart shows convergence pattern on cross-session edges
- [ ] Onboarding-segment bridge added (retention vs can-offer-energy)

### Phase 3: Expand (weeks 3-4)
- [ ] Second simple graph built (HIF or growth marketing) following same design philosophy
- [ ] Old graphs archived or clearly marked as legacy in the navigator
- [ ] Unused entities cleaned up (orphaned parameter files, dead events)
- [ ] TV rotation includes both graphs

### Phase 4: Forecasting (when Bayes ships)
- [ ] Bayes model running nightly on li-energy-simple-v1
- [ ] Fancharts pinned to canvas showing confidence bands on key edges
- [ ] Forecasting view added to TV rotation
- [ ] Per-context models generating (one model per onboarding-segment, energy-blueprint)

## Edge Cases

- What if IP v3 has too little volume for meaningful comparison? Wait for 500+ users
  through the fork before drawing conclusions. The cohort maturity chart will show
  whether the data is mature enough.
- What if the bridge views break after editor updates? The bridge references
  editor-generated scenario IDs which can change. Re-pull and check IDs if bridges
  go blank.
- What if daily fetch fails? Check the automation logs at
  `.dagnet/automation-logs/`. The graph has `dailyFetch: true` so it will retry
  next cycle.
- What if someone asks about a funnel not in the simple graph? Build a new simple
  graph for that funnel. Don't add nodes to the existing one — keep each graph
  focused and readable.

## Out of Scope

- Building a custom TV dashboard app (DagNet's built-in dashboard mode + view
  rotation is sufficient)
- Modifying the DagNet editor codebase to fix scenario loading from JSON (workaround
  documented — create scenarios in editor UI)
- Automated alerting (no threshold-based alerts — DagNet is for structural reasoning,
  not monitoring)
- Multi-graph composite dashboards (each graph is standalone on the TV rotation)

## Technical Considerations

- **Graph design philosophy**: 10-15 nodes max, context-based segmentation, unfiltered
  golden events. See `docs/solutions/architecture/simple-graph-design-philosophy.md`.
- **Scenario creation**: Must be done in editor UI, not programmatically. Agent provides
  DSL fragments, user creates and regenerates. See dag-ops SKILL.md "Editor Interaction
  Rules".
- **Hash mappings**: Required when editing context files (adding new variants). Use
  `diff-hash` → edit → `diff-hash` → `add-mapping` workflow.
- **Bridge view scoping**: Each bridge should be scoped to its relevant section
  (onboarding: `to(lis-delegation)`, IP: `from(lis-deal-available).to(lis-switch-success)`).
- **Base DSL**: Use `cohort(entry-node,-30d:)` not `window(-30d:)` for graphs with
  cross-session edges.
- **View rotation**: DagNet dashboard mode supports timed view cycling. Configure in
  the editor's dashboard settings.

## Open Questions

- What's the TV dashboard rotation interval? (Suggested: 30-45 seconds per view)
- Which graph goes on the TV first for HIF/GM when Phase 3 starts?
- Does the team want a Slack notification when the weekly bridge shows a significant
  shift, or is the TV enough?
- When Bayes ships, what's the minimum data depth needed before fancharts are meaningful?
