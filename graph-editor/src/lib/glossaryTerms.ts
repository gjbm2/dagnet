/*
 * Glossary term registry for inline UI tooltips.
 *
 * Used by <GlossaryTooltip term="..."> to render a consistent, short
 * explanation on hover. Definitions are derived from
 * graph-editor/public/docs/glossary.md — keep the two in sync when adding
 * or refining entries.
 *
 * Keys are stable slugs (kebab-case). Prefer slugs that read naturally in
 * consumer JSX (`term="path-t95"`) and are resilient to UI label changes.
 */

export interface GlossaryTerm {
  /** Bold header shown above the description. Usually the display term with any notation (e.g. "Path t95"). */
  title: string;
  /** One- to two-sentence plain-language explanation. Avoid heavy maths. */
  description: string;
  /** Optional hash-linked URL to the full glossary entry for users who want more detail. */
  moreUrl?: string;
}

/**
 * Seed registry. Populated as later tooltip phases touch more surfaces.
 * Adding a term here is cheap; removing one is a breaking change for any
 * <GlossaryTooltip term="..."> consumer, so prefer updating the definition.
 */
export const GLOSSARY_TERMS: Record<string, GlossaryTerm> = {
  // --- Core graph / edge parameters -------------------------------------
  'probability': {
    title: 'Probability (p)',
    description:
      'The chance of taking this edge from its source node. Values are between 0 and 1; siblings from the same source should sum to 1.',
  },
  'stdev': {
    title: 'Standard deviation',
    description:
      'Uncertainty around the mean estimate. Larger values mean the parameter is less precisely known.',
  },
  'latency': {
    title: 'Latency',
    description:
      'Time-to-convert distribution for an edge — how long users typically take to traverse it.',
  },
  't95': {
    title: 'Edge t95',
    description:
      '95th percentile lag in days for this single edge: 95% of conversions complete within this time.',
  },
  'path-t95': {
    title: 'Path t95',
    description:
      'Cumulative 95th percentile lag from the cohort anchor through all upstream edges to this one.',
  },
  'onset': {
    title: 'Onset',
    description:
      'Dead-time before conversions can begin on this edge — the minimum delay before any user could plausibly traverse it.',
  },
  'cohort-anchor': {
    title: 'Cohort anchor',
    description:
      'The upstream node that defines when a user enters the cohort. Defaults to the furthest upstream Start node.',
  },
  'weight-default': {
    title: 'Weight default',
    description:
      'Used to distribute residual probability among edges from the same source that do not have an explicit value.',
  },
  'entry-weight': {
    title: 'Entry weight',
    description:
      'Relative share of incoming traffic assigned to this node when there are multiple entry points.',
  },
  'variant-weight': {
    title: 'Variant weight',
    description:
      'Share of traffic routed to this case variant. Weights across variants of the same case must sum to 1.',
  },

  // --- Bayesian / statistical -------------------------------------------
  'posterior': {
    title: 'Posterior',
    description:
      'The distribution of a parameter after combining prior beliefs with observed evidence.',
  },
  'prior': {
    title: 'Prior',
    description:
      'Initial belief about a parameter before observing any evidence — set from structure, defaults, or previous fits.',
  },
  'alpha-beta': {
    title: 'α / β (Beta parameters)',
    description:
      'Shape parameters of the Beta distribution used to model probabilities. α ≈ successes + 1, β ≈ failures + 1.',
  },
  'r-hat': {
    title: 'r̂ (Rhat)',
    description:
      'Convergence diagnostic for MCMC chains. Values below 1.01 indicate the chains have mixed well.',
  },
  'ess': {
    title: 'ESS (Effective Sample Size)',
    description:
      'Number of effectively independent samples from the posterior. Higher is better; <400 is usually too few.',
  },
  'evidence-grade': {
    title: 'Evidence grade',
    description:
      'Data sufficiency for this parameter on a 0–3 scale. 0 = no usable evidence; 3 = ample, reliable data.',
  },
  'quality-tier': {
    title: 'Quality tier',
    description:
      'Summary of fit quality: good (converged, enough samples), fair (acceptable), poor (thin data), very poor (did not converge).',
  },
  'delta-elpd': {
    title: 'ΔELPD',
    description:
      'Model-fit comparison: positive means the Bayesian model predicts held-out data better than a point estimate; negative means worse.',
  },
  'pareto-k': {
    title: 'Pareto k',
    description:
      'Reliability of leave-one-out cross-validation per observation. <0.5 reliable, 0.5–0.7 acceptable, >0.7 unreliable.',
  },
  'mu': {
    title: 'μ (mu)',
    description:
      'Log-normal scale parameter for latency — the median lag on the log scale.',
  },
  'sigma': {
    title: 'σ (sigma)',
    description:
      'Log-normal shape parameter for latency — controls spread and skew of the time-to-convert distribution.',
  },

  // --- Data / query DSL --------------------------------------------------
  'dsl': {
    title: 'DSL (Query Expression)',
    description:
      'Compact syntax for specifying which data to retrieve or constrain, e.g. from(a).to(b).window(-30d:).context(channel:google).',
  },
  'base-dsl': {
    title: 'Base DSL',
    description:
      'Graph-level query inherited by all live scenarios unless individually overridden.',
  },
  'data-interests-dsl': {
    title: 'Data interests DSL',
    description:
      'Query template that drives which context slices the nightly runner fetches for this graph.',
  },
  'slice': {
    title: 'Slice',
    description:
      'A single context-filtered subset of data implied by the DSL — one combination of context values. Too many slices slow down nightly runs.',
  },
  'cohort': {
    title: 'Cohort mode',
    description:
      'Dates refer to when users entered the funnel. Conversions can still arrive later, measured relative to their entry day.',
  },
  'window': {
    title: 'Window mode',
    description:
      'Dates refer to when events occurred, regardless of when the user originally entered the funnel.',
  },
  'asat': {
    title: 'As-at snapshot',
    description:
      'Read parameters as they were on a specific historical date — useful for reproducing past analyses.',
  },
  'snapshot': {
    title: 'Snapshot',
    description:
      'A stored, point-in-time value for a parameter, captured from a retrieval or fit.',
  },
  'override': {
    title: 'Override',
    description:
      'A manually-set value that supersedes the automatic one. Shown with a lightning-off icon; clear it to return to auto.',
  },
  'rebalance-siblings': {
    title: 'Rebalance siblings',
    description:
      'Adjusts the probabilities of edges sharing this source so that they sum to 1, preserving their relative proportions.',
  },

  // --- Scenarios ---------------------------------------------------------
  'base-layer': {
    title: 'Base',
    description:
      'Foundation parameter layer inherited by every scenario. Edit here to change the defaults for all live scenarios.',
  },
  'current-layer': {
    title: 'Current',
    description:
      'Your live working state. Always present and used by analyses unless you pick a different scenario.',
  },
  'live-scenario': {
    title: 'Live scenario',
    description:
      'Scenario defined by a query — parameters are regenerated when data changes. Opposite of a static snapshot.',
  },
  'static-scenario': {
    title: 'Static scenario',
    description:
      'Scenario with parameters captured at one point in time. Does not update as new data arrives.',
  },
  'visibility-mode': {
    title: 'Visibility mode',
    description:
      'Controls what this scenario contributes to charts: F+E (forecast and evidence), F (forecast only), or E (evidence only).',
  },
  'flatten': {
    title: 'Flatten',
    description:
      'Copy the Current state into Base and remove all scenario overlays. Destructive to scenarios but not to data.',
  },
  'what-if': {
    title: 'What-If',
    description:
      'Temporary constraints applied on top of Current — e.g. force a specific case variant or conditional branch.',
  },

  // --- Phase 1: properties panel labels ---------------------------------
  'sub-route-probability': {
    title: 'Sub-route probability',
    description:
      'Probability of taking this edge given that a specific case variant was selected upstream. Conditional on the variant.',
  },
  'external-data-source': {
    title: 'External data source',
    description:
      'Which connection (file or database) supplies observed values for this parameter.',
  },
  'data-retrieval-query': {
    title: 'Data retrieval query',
    description:
      'Query expression used to fetch data for this parameter. Usually auto-generated from graph topology via MSMDC; can be overridden manually.',
  },
  'n-query': {
    title: 'N query (optional)',
    description:
      'Explicit query for n (denominator) when it differs from the main query. Use when the "from" node shares an event with other nodes and n cannot be derived by stripping conditions.',
  },
  'conditional-probability': {
    title: 'Conditional probability',
    description:
      'A probability that applies only when a specific condition holds (e.g. a waypoint was visited, a context matches, or a case variant is active). Conditions are evaluated top-to-bottom with OR semantics.',
  },
  'condition': {
    title: 'Condition',
    description:
      'Semantic constraint that determines when a conditional probability applies. Examples: visited(promo), context(device:mobile), case(test:treatment).',
  },
  'condition-colour': {
    title: 'Condition colour',
    description:
      'Colour used on the canvas to distinguish this condition from siblings when rendering conditional edges.',
  },
  'cost-gbp': {
    title: 'Cost (£)',
    description:
      'Monetary cost in pounds sterling incurred when a user traverses this edge.',
  },
  'cost-time': {
    title: 'Cost (Time)',
    description:
      'Labour or processing time cost associated with this edge, in minutes.',
  },

  // --- Node properties --------------------------------------------------
  'node-id': {
    title: 'Node ID',
    description:
      'Stable identifier used to reference this node in DSL queries, parameter files, and analyses. Changing this may break references.',
  },
  'start-node': {
    title: 'Start node',
    description:
      'Marks this node as an entry point for flow calculations. Multiple start nodes are allowed; their relative shares are set by entry weights.',
  },
  'terminal-node': {
    title: 'Terminal (absorbing) node',
    description:
      'Marks this node as an outcome state — no outgoing flow leaves it. Terminal nodes represent the final states of a path.',
  },
  'outcome-type': {
    title: 'Outcome type',
    description:
      'Classification of a terminal node (success, failure, error, neutral, other). Used by analyses that partition outcomes.',
  },
  'event-connection': {
    title: 'Event connection',
    description:
      'Links this node to an event in the underlying data source so that observed counts can be attached to it.',
  },
  'case-id': {
    title: 'Case ID',
    description:
      'Identifier of the case file this node is bound to. The case file defines the variants and their weights.',
  },
  'case-status': {
    title: 'Status',
    description:
      'Lifecycle state of the case: Active (routing traffic), Paused (temporarily held), Completed (archived and read-only).',
  },
  'variants': {
    title: 'Variants',
    description:
      'Alternative paths a case can take (e.g. Control vs Treatment). Variant weights across a case must sum to 1.',
  },

  // --- Graph properties -------------------------------------------------
  'default-connection': {
    title: 'Default connection',
    description:
      'Fallback data connection used by all edges in this graph unless they override it per-edge.',
  },
  'model-source': {
    title: 'Model source',
    description:
      'Which model source to promote to scalar parameters across all edges. Auto picks the best available; Bayesian uses posterior means; Analytic uses point estimates from the fitter.',
  },
  'daily-automation': {
    title: 'Include in daily automation',
    description:
      'When enabled, this graph is included in unattended nightly runs (?retrieveall) that refresh data from configured sources.',
  },
  'run-bayes-fit': {
    title: 'Run Bayes fit',
    description:
      'If enabled, runs a Bayesian re-fit after each nightly data retrieval. Requires daily fetch to be on first.',
  },

  // --- Phase 2: window + pinned query ----------------------------------
  'pinned-query': {
    title: 'Pinned query',
    description:
      'Graph-level DSL that defines which context slices are fetched automatically overnight and suggested in the Context dropdown. Same underlying concept as Data interests DSL.',
  },
  'implied-slices': {
    title: 'Implied slices',
    description:
      'Number of distinct context combinations the DSL expands into. Each slice is a separate data fetch. Very large counts (>500) slow nightly runs; 50–500 may impact performance.',
  },
  'context-filter': {
    title: 'Context filter',
    description:
      'Adds a context() clause to the query so that data is restricted to (or grouped by) a specific context value.',
  },
  'full-query-dsl': {
    title: 'Full query DSL',
    description:
      'The complete query expression currently applied to this view, combining the base DSL, window, context filters and any scenario overrides.',
  },
  'fetch-data': {
    title: 'Fetch data',
    description:
      'Retrieve data for the current query from configured sources. Refresh pulls again; Up to date means the cache is fresh.',
  },
  'bulk-create-scenarios': {
    title: 'Create scenarios',
    description:
      'Generate one scenario per context value (or time period) for side-by-side comparison without editing parameters manually.',
  },

  // --- Phase 2: scenarios panel ---------------------------------------
  'scenarios-panel': {
    title: 'Scenarios',
    description:
      'Named parameter overlays on top of Base. Use scenarios to compare alternatives or capture point-in-time states. Up to 15 scenarios per graph.',
  },
  'recolour-scenarios': {
    title: 'Recolour',
    description:
      'Apply a preset colour palette across all scenarios so they are easy to distinguish on charts.',
  },
  'refresh-live-scenario': {
    title: 'Refresh from source',
    description:
      'Re-run this live scenario’s query to regenerate its parameters from the latest data.',
  },
  'to-base': {
    title: 'To Base',
    description:
      'Push the current query DSL to Base and regenerate all live scenarios. Use this to promote your current working query as the new default.',
  },
  'capture-everything': {
    title: 'Capture everything',
    description:
      'Static snapshot of every parameter in the current state. Will not change when data updates.',
  },
  'capture-differences': {
    title: 'Capture differences',
    description:
      'Static snapshot of only the parameters that differ from Base. Will not change when data updates.',
  },
  'scenario-blank': {
    title: 'Blank scenario',
    description:
      'Empty scenario you can edit manually (YAML/JSON) without any captured parameters.',
  },
  'scenario-source': {
    title: 'Source',
    description:
      'Where this scenario was created from (e.g. window preset, context bulk, manual capture). Helps trace how it was generated.',
  },
  'scenario-note': {
    title: 'Note',
    description:
      'Free-form text describing why this scenario exists or what it represents. Shown in the scenario list tooltip.',
  },
  'scenario-structure': {
    title: 'Structure',
    description:
      'Flat: one key per leaf path (e.g. edges.abc.p.mean). Nested: hierarchical objects. Same data, different formatting.',
  },
  'scenario-syntax': {
    title: 'Syntax',
    description:
      'Show the scenario data as YAML (compact, comment-friendly) or JSON (strict, machine-readable). Toggle freely.',
  },

  // --- Phase 2: automation manager -------------------------------------
  'automation-manager': {
    title: 'Automation Manager',
    description:
      'Controls which graphs are processed by the unattended nightly run (?retrieveall) and whether a Bayesian fit follows each retrieval.',
  },
  'bayes-fit-checkbox': {
    title: 'Bayes',
    description:
      'Commission a Bayesian re-fit of this graph after each nightly data retrieval. Produces updated posteriors for all parameters.',
  },

  // --- Phase 3: Bayesian / statistical internals ------------------------
  'hdi': {
    title: 'HDI (Highest Density Interval)',
    description:
      'Shortest interval containing a given probability mass of the posterior. Narrower is more certain. Preferred over symmetric credible intervals for skewed distributions.',
  },
  'onset-mu-corr': {
    title: 'onset ↔ μ correlation',
    description:
      'Posterior correlation between onset (dead-time) and μ (log-normal scale). Values near ±1 suggest the data cannot separate the two — one is compensating for the other.',
  },
  'ppc-coverage': {
    title: 'Posterior predictive coverage',
    description:
      'Fraction of held-out observations that fall inside the 90% posterior predictive interval. 82–97% is healthy; outside suggests miscalibration.',
  },
  'provenance': {
    title: 'Provenance',
    description:
      'How this posterior was produced — e.g. which fitter, sampling recipe, or manual override. Used to audit where numbers came from.',
  },
  'active-source': {
    title: 'Active source',
    description:
      'The model source currently promoted to scalar values on this edge. Determined by the graph-level Model Source preference plus any per-edge override.',
  },
  'fitted-at': {
    title: 'Fitted',
    description:
      'When this posterior was most recently produced. Green = fresh, yellow/orange = stale relative to data, red = very old.',
  },
  'data-fetched': {
    title: 'Data fetched',
    description:
      'When the raw evidence was last retrieved from the source. If older than the fit timestamp, the fit is behind the data.',
  },
  'prior-tier': {
    title: 'Prior',
    description:
      'Tier of the prior used to regularise the fit (e.g. informative, weakly-informative). Stronger priors pull the posterior toward reference values when evidence is thin.',
  },
  't95-hdi': {
    title: 't95 HDI',
    description:
      'Posterior uncertainty range for t95: a plausible window for the 95th percentile conversion lag.',
  },
  'completeness': {
    title: 'Completeness',
    description:
      'Fraction of expected conversions already observed by query time, based on the fitted lag distribution. Low completeness (immature cohorts) means the forecast is doing more of the work.',
  },
  'forecast-vs-evidence': {
    title: 'Forecast vs evidence',
    description:
      'Solid layer = observed conversions (evidence). Hatched layer = modelled/projected conversions (forecast) — the portion expected but not yet observed for immature cohorts.',
  },

  // --- Phase 4: View menu -----------------------------------------------
  'sankey-view': {
    title: 'Sankey View',
    description:
      'Flow-diagram rendering: edge widths scale with traffic share. Useful for spotting where most users end up.',
  },
  'data-values-overlay': {
    title: 'Data Values',
    description:
      'Show parameter values (probabilities, latencies) directly on edges in the canvas.',
  },
  'path-view': {
    title: 'Path View',
    description:
      'Renders path-level aggregates (cumulative probability, cumulative t95) instead of per-edge values.',
  },
  'confidence-intervals': {
    title: 'Confidence intervals',
    description:
      'Shaded bands around chart lines showing posterior uncertainty at the chosen credible level (99/95/90/80%).',
  },
  'forecast-quality-overlay': {
    title: 'Forecast Quality overlay',
    description:
      'Shades edges by the quality tier of their Bayesian fit — quick visual of which edges have trustworthy forecasts.',
  },
  'data-depth-overlay': {
    title: 'Data Depth overlay',
    description:
      'Shades edges by how much evidence supports them (sample count). Thin data = shallow depth.',
  },
  'projection-view': {
    title: 'Projection view',
    description:
      'Projects expected flow forward using the latency model — see how immature cohorts are expected to mature.',
  },
  'snap-to-guides': {
    title: 'Snap to Guides',
    description:
      'Snap dragged nodes to alignment guides that appear between neighbouring nodes.',
  },
  'animate-flow': {
    title: 'Animate Flow',
    description:
      'Animated dashes along edges, flow direction indicator. Purely cosmetic — does not affect values.',
  },

  // --- Phase 4: Data menu -----------------------------------------------
  'retrieve-all-slices': {
    title: 'Retrieve All Slices',
    description:
      'Fetch every slice implied by the current Data Interests DSL. Heavy; normally scheduled overnight.',
  },
  'get-from-source-direct': {
    title: 'Get from Source (direct)',
    description:
      'Query the source (e.g. Amplitude) and apply results directly, bypassing the file cache. Use when you need freshness over speed.',
  },
  'get-from-source': {
    title: 'Get from Source',
    description:
      'Query the source and write the results into the local data file, then apply from there.',
  },
  'get-from-file': {
    title: 'Get from File',
    description:
      'Apply values from the local data file without re-querying the source. Fast; reflects last fetch.',
  },
  'put-to-file': {
    title: 'Put to File',
    description:
      'Persist the current in-memory parameter values into the local data file.',
  },
  'unsign-cache': {
    title: 'Unsign file cache',
    description:
      'Remove signature metadata so the next fetch is treated as a fresh retrieval. Rarely needed; used to recover from cache divergence.',
  },
  'remove-overrides': {
    title: 'Remove Overrides',
    description:
      'Clear user-entered overrides on selected parameters so that they revert to automatic/model values.',
  },
  'latency-horizon-recompute-global': {
    title: 'Recompute globally (uncontexted)',
    description:
      'Rebuild latency horizons (t95, path_t95) for every edge using the graph-wide default context.',
  },
  'latency-horizon-recompute-current': {
    title: 'Recompute based on current',
    description:
      'Rebuild latency horizons for every edge using the currently-selected context/window.',
  },
  'latency-horizon-set-all': {
    title: 'Set all horizons overrides',
    description:
      'Mark every edge’s computed latency horizon as an override so it stops auto-updating.',
  },
  'latency-horizon-remove-all': {
    title: 'Remove all horizons overrides',
    description:
      'Clear override flags on every edge’s latency horizons so they go back to auto.',
  },
  'run-bayesian-fit': {
    title: 'Run Bayesian Fit',
    description:
      'Execute a full Bayesian fit now for this graph. Produces fresh posteriors for all parameters.',
  },
  'reset-bayesian-priors': {
    title: 'Reset Bayesian Priors',
    description:
      'Clear prior hints so the next fit starts from defaults. Non-destructive — does not touch previous posteriors.',
  },
  'delete-bayesian-history': {
    title: 'Delete Bayesian History',
    description:
      'Irreversibly remove all saved posteriors and fit metadata for this graph.',
  },
  'forecasting-settings': {
    title: 'Forecasting settings',
    description:
      'Controls for the analytic forecast pipeline: recency half-life, minimum ESS, default t95, blend λ and related knobs.',
  },
  'exclude-test-accounts': {
    title: 'Exclude test accounts',
    description:
      'Filter out events from internal/test accounts (per the configured list) from all analyses.',
  },
  'auto-update-charts': {
    title: 'Auto-update charts',
    description:
      'When on, chart recomputation fires automatically after parameter changes. Off = manual recompute only.',
  },

  // --- Phase 4: Element palette ---------------------------------------
  'conversion-node': {
    title: 'Conversion Node',
    description:
      'A stage in the funnel — users transition between nodes along edges with a probability and a latency distribution.',
  },
  'container-element': {
    title: 'Container',
    description:
      'Visual group used to organise nodes on the canvas. No semantic effect on flow or analysis.',
  },
  'canvas-analysis': {
    title: 'Canvas Analysis',
    description:
      'Embedded chart/table pinned to the canvas so that results stay visible next to the graph structure.',
  },
};

export function getGlossaryTerm(key: string): GlossaryTerm | undefined {
  return GLOSSARY_TERMS[key];
}
