## 1. Purpose

WP8 from `60-forecast-adaptation-programme.md` permits one late behaviour
change after WP0-WP7 are green: make the direct-`cohort()` rate-conditioning
path explicit, but keep it narrow.

This note fixes the first landing:

- the flag lives only on `p_conditioning_evidence`
- the first landing is cohort mode only
- the first landing is exact single-hop subjects only
- carrier semantics, latency semantics, and numerator representation stay as
  they were after WP3-WP7

## 2. Eligible cases

The flag is enabled only when the live caller is solving an exact single-hop
cohort subject. In practice that means:

- `cohort()` mode, not `window()`
- one subject edge, not a multi-hop `X -> end` query

Everything else stays on the existing seam:

- `window()` remains window-conditioned
- multi-hop `cohort()` remains on doc 47's window-led subject evidence family
- degraded/query-scoped paths from doc 57 still degrade rather than sweeping

## 3. Rate-conditioning mechanism

The flag does not admit a new gross numerator and does not retarget the
subject-span operator. It only makes the rate-conditioning seam explicit.

When the flag is on, `p_conditioning_evidence` is tagged as
`direct_cohort_exact_subject`. The runtime still uses the same prepared
subject-span, carrier, and latency inputs that the structural work packages
already established. The first landing is intentionally narrow: it names and
bounds the direct single-hop cohort rate-conditioning path without widening it
to multi-hop or rewriting the solve.

## 4. Doc 52 discipline

Doc 52's aggregate-prior discipline is unchanged.

- Aggregate priors may still update from the in-scope conditioning evidence.
- Query-scoped posteriors identified by `alpha_beta_query_scoped` still do not
  update again.
- Where the aggregate-prior blend is active, the same blend math remains in
  force; the new flag only identifies which evidence family occupied the
  rate-conditioning seam.

## 5. Non-goals

This WP8 landing does not:

- change carrier selection
- change latency parameter selection
- widen multi-hop cohort admission
- create a public API toggle
- promote whole-query numerators

Those would be separate changes and would need their own ratification.
