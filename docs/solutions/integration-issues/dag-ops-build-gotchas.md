---
title: "dag-ops Build Mode Gotchas — Lessons from LI Energy Simple v1"
category: integration-issues
date: 8-Apr-26
tags:
  - dag-ops
  - graph-building
  - amplitude-events
  - latency
  - overrides
  - complement-edges
  - n_query
  - dataInterestsDSL
  - contexts
components:
  - data-repo/graphs
  - data-repo/events
  - data-repo/parameters
  - data-repo/contexts
severity: high
---

# dag-ops Build Mode Gotchas

Lessons from building li-energy-simple-v1 (8-Apr-26). Each section is a mistake
that was made and corrected during the build.

## 1. Override Discipline

**Rule**: Don't set `_overridden: true` unless technically required.

The editor auto-manages `n_query`, labels, and queries. Setting overrides locks
values and shows orange warning badges in the UI.

- `label_overridden: true` on nodes → orange "Overrides: label" badge. Remove it.
- `n_query_overridden: true` on plain forward edges → unnecessary lock. Remove it.
- `query_overridden: false` is fine (it's the default, not an override).

**The ONE exception**: `.exclude()` edges need `n_query_overridden: true` because
the auto-computed denominator would apply the `.exclude()` condition to the
denominator, distorting the conversion rate. Set `n_query: to(<source-node>)` and
`n_query_overridden: true` on these edges only.

**Detection**: `grep -r "overridden.*true" graphs/<name>.json | grep -v query_overridden`

## 2. Latency Placement

**Rule**: Only set `latency_parameter: true` on edges with cross-session delay.

Same-session edges (landing → household → account → quiz → delegation) have
sub-minute latency. Setting latency on them adds noise without insight.

Cross-session edges that need latency:
- Delegation → Deal Available (backend deal generation, can be hours)
- Deal Available → Registration (user returns later)
- Deal Available → Deal Viewed (user may view deal later)
- Reg Successful → Switch Success (switch takes days/weeks)

**Critical**: Setting only `anchor_node_id` without `latency_parameter: true` does
NOT enable latency tracking. The model checks `latency_parameter` to decide
whether to compute lag distributions.

## 3. Complement Edge Cleanliness

**Rule**: Complement/abandon edges must have NO fetch-related fields.

Strip from BOTH the graph JSON edge AND the parameter file:
- `query` (even empty string `""` triggers validator warnings)
- `query_overridden`
- `n_query`, `n_query_overridden`
- `p.id`, `p.connection`

The field must be **absent**, not empty. `query: ""` ≠ no query.

**Detection**: `python3 -c "import json; [print(e['id']) for e in json.load(open('graphs/<name>.json'))['edges'] if not e.get('p',{}).get('connection') and e.get('query')]"`

## 4. dataInterestsDSL Syntax

**Rule**: Use bracketed cross-cut pattern for cohort + context.

Wrong (flat semicolons — cohort doesn't cross-cut):
```
context(a);context(b);window(-30d:);cohort(node,-30d:)
```

Right (brackets create the cross product):
```
(window(-30d:);cohort(node,-30d:)).(context(a);context(b);context(c))
```

Reference: `li-cohort-segmentation-v2.json` uses this pattern.

## 5. Event Verification Before Build

**Rule**: Always verify ALL events in Amplitude before building.

Check three things:
1. **Event exists**: `search` MCP with exact event name
2. **Has volume**: >100 uniques in 30 days (use `query_amplitude_data`)
3. **Funnel narrows**: Build actual funnels in Amplitude — no downstream step should
   exceed upstream volume

Specific findings from this build:
- `G_landing_page_viewed` has only ~272 uniques/30d — use `Viewed Marketing Site Landing Page` instead
- `G_recommendation_available` has only ~419 uniques/30d — superseded by `G_deal_available` (9,107)
- `Recommendation SwitchNowClicked` (389) vs `SwitchNowSucceeded` (354) — ~9% of clicks don't succeed

## 6. Index Entry Verification

**Rule**: When the index update script says "SKIP (exists)" — verify the ID.

`li-G_delegation_enabled` and `G_delegation_enabled` are different IDs. A substring
match can give false confidence. Always verify exact ID match.

**Detection**: `grep "^  - id: G_delegation_enabled$" events-index.yaml`

## 7. onboardingSegment Context

**Rule**: Use behavioural filter on event property, not user property.

The user property `gp:onboardingSegment` has many `(none)` values (~50% of users).
The event property `segment` on `G_onboarding_segment_classified` is reliable.

Use behavioural segment filter:
```yaml
sources:
  amplitude:
    type: behavioral
    event_type: G_onboarding_segment_classified
    filter_property: segment
    filter_value: can_offer_energy_gave_bds
    time_type: rolling
    time_value: 366
```

Values: `cant_offer_energy`, `can_offer_energy_no_bds`,
`can_offer_energy_retention`, `can_offer_energy_gave_bds`.

## 8. Split-Path Discriminator (G_deal_viewed)

**Rule**: Shared tail edges AFTER the rejoin don't need discriminators.

For the LI Energy Simple graph:
- Fork node: `lis-deal-available`
- Discriminator: `G_deal_viewed`
- Standard path: `.exclude(lis-deal-viewed)` on deal-available → reg-attempted
- IP path: `.visited(lis-deal-viewed)` on switch-now → reg-attempted
- Shared tail (reg-attempted → reg-successful → switch-success): NO discriminator needed

The `.visited()` edge has NO `n_query` per the decision matrix — dual-query path
breaks population scoping and produces near-0% conversion.

## Related

- `docs/solutions/architecture/simple-graph-design-philosophy.md` — Design philosophy
- `docs/solutions/integration-issues/parallel-split-paths-amplitude-mece-separation.md` — MECE separation
- `graph-ops/reference/common-pitfalls.md` (in the data repo) — General pitfalls
