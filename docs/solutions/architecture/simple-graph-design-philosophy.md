---
title: "Simple Graph Design: Context-Based Segmentation Over Structural Complexity"
category: architecture
date: 8-Apr-26
tags:
  - graph-design
  - context-dsl
  - dagnet-adoption
  - segmentation
  - li-energy-simple
components:
  - data-repo/graphs
  - data-repo/contexts
severity: medium
---

# Simple Graph Design: Context-Based Segmentation Over Structural Complexity

## Problem

The LI cohort segmentation graph (v2) had 36 nodes and 55 edges encoding 4 parallel
sub-funnels (ineligible, retention, acquisition+BDS, acquisition-no-BDS). It was
technically correct but practically unusable — nobody opened it daily because tracing
any single question required first figuring out which cohort path to follow.

## Root Cause

Segmentation was encoded in the **graph structure** (separate nodes per cohort) instead
of the **context DSL** (same graph, different filter slices). This multiplied nodes
by the number of segments, creating exponential complexity.

## Solution

Build simple graphs (10-15 nodes) with one clear path and minimal branching. Use
context dimensions for segmentation:

- **Old approach**: 4 parallel sub-funnels x 9 steps = 36 nodes
- **New approach**: 1 funnel x 12 steps + 1 branch = 15 nodes, 3 context dimensions

The LI Energy Simple v1 graph demonstrates this:
- Core path: Landing → Household → Account → Quiz → Delegation → Deal Available → Registration → Success
- One branch: Deal Viewed → Switch Now (instant proposals)
- 3 context dimensions: onboarding-segment, onboarding-blueprint-variant, energy-blueprint-variant

Same analytical power, fraction of the complexity.

## Design Rules for Playable Graphs

1. **8-15 nodes max.** If you can't explain the graph in 30 seconds by pointing at it, it's too complex.
2. **One clear entry, one success, 2-3 failure exits.** The shape tells the story.
3. **Stages match how the team talks.** Not every micro-event, just the decision points.
4. **Segmentation via contexts, not branching.** `context(segment:retention)` is a toggle, not 2x the nodes.
5. **Every node earns its place.** If collapsing two nodes doesn't lose a decision you'd act on, collapse them.
6. **Use unfiltered G_* golden events.** Don't bake amplitude_filters into events. Let context DSL handle filtering so the same graph serves multiple analyses.

## Context File Management

When trimming context values for a specific graph, create NEW context files with a
graph-specific prefix (e.g. `lis-onboarding-blueprint`) rather than modifying shared
context files that other graphs depend on.

## When to Branch vs Context

- **Branch**: The two paths have genuinely different intermediate steps (e.g. Deal Viewed → Switch Now vs direct to Registration). The user journey is structurally different.
- **Context**: The same steps happen, just for different user populations (LI v1 vs v4, retention vs acquisition). The funnel shape is identical.

## Prevention

Before building a new graph, ask: "Am I encoding segment logic in the structure?"
If two sub-paths share >70% of their nodes, use a context instead.

## Related

- `docs/solutions/integration-issues/parallel-split-paths-amplitude-mece-separation.md` — MECE separation when paths share events
- `graph-ops/playbooks/create-graph.md` (in the data repo) — Build workflow
- `docs/current/li-energy-simple-v1.pen` — Visual diagram of the simple graph
