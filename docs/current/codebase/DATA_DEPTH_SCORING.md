# Data Depth Scoring

How DagNet computes and displays data coverage scores for graph edges.

## What Data Depth Is

A composite coverage score (in [0, 1]) for each edge, computed from three dimensions:

| Dimension | Weight | Measures |
|-----------|--------|----------|
| f1 | 40% | Slice x date coverage (recency-weighted with half-life decay) |
| f2 | 30% | Snapshot DB coverage (completeness in snapshot tables) |
| f3 | 30% | Sample size adequacy (n relative to graph median) |

Composite: `0.4 * f1 + 0.3 * f2 + 0.3 * f3`

## Per-Slice Breakdown

The service returns detailed coverage by slice family (e.g. `context(channel:paid-search)`) for hover tooltips, showing covered/total days and n per slice.

## Tiers

**Location**: `src/utils/dataDepthTier.ts`

Scores are bucketed into tiers for visual rendering (edge colourisation).

## Context Provider

**Location**: `src/contexts/DataDepthContext.tsx`

Distributes precomputed scores (`Map<edgeUuid, DataDepthScore>`) to edge components for rendering. Scores are null while async computation runs.

## Key Files

| File | Role |
|------|------|
| `src/services/dataDepthService.ts` | Score computation (three-dimension composite) |
| `src/utils/dataDepthTier.ts` | Tier definitions |
| `src/contexts/DataDepthContext.tsx` | Score distribution to components |
