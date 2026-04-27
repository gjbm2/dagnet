# What-If Analysis

How DagNet applies hypothetical overrides to graph probabilities for scenario exploration.

## What-If Override Types

1. **Case variant overrides**: force a specific variant in a case node (e.g. `case(case_id:treatment)`)
2. **Conditional probability overrides**: override an edge's conditional_p to activate a specific condition (e.g. `visited(node-a)`)

## DSL Integration

What-if conditions are expressed as a unified DSL string:
```
case(case_id:treatment).visited(nodea).exclude(nodeb)
```

Parsed to populate `caseOverrides` and `conditionalOverrides` for backward compatibility. Old format (separate objects) is auto-migrated to DSL on first render.

## Effective Edge Probability

`computeEffectiveEdgeProbability()` is the single source of truth. Applies overrides in order:
1. Explicit conditional override
2. Implicit/context activation (from case what-ifs or path analysis)
3. Case variant weighting

Specificity scoring picks the most specific matching `conditional_p` condition.

## Storage

What-if DSL is stored in tab state (`editorState.whatIfDSL`). Persisted per-tab, not per-graph.

## Key Files

| File | Role |
|------|------|
| `src/contexts/WhatIfContext.tsx` | What-if state management |
| `src/components/WhatIfAnalysisControl.tsx` | UI controls |
| `src/lib/whatIf.ts` | DSL parsing, override application, effective probability computation |
