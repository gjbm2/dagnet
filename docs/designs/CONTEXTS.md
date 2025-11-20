## Contexts: Design & Implementation Notes

### Overview

**Goal**: Introduce a first‑class notion of **contexts** (e.g. `channel`, `browser-type`) into the data/graph model and UI so that:

- **Explicit context selection (in-graph)**: A variable/window/edge can explicitly request data for a given context (or combination of contexts).
- **Explicit context selection (in-app / live)**: A user can say “I am interested in X and Y right now” (e.g. `channel = google` and `browser-type = chrome`) and have the graph fetched/rendered in that precise context set.
- **Implicit context selection (graph-level pinning)**: One or more **context DSL expressions are pinned onto a graph file**; these act as background interests that:
  - guide how the UI nudges users to choose contexts when inspecting that graph, and
  - inform the nightly runner how to contextualise data queries it constructs to populate that graph’s vars.

We want this to be:

- **Composable** in the DSL (similar to `case(...)`, `visited(...)`, etc.).
- **MECE-safe** in the data model (mutually exclusive, collectively exhaustive enum values per context key).
- **Source-agnostic** but with **source-specific mappings** (e.g. Amplitude, Sheets) configured via context metadata.

### Context Types & Selection Modes

#### Explicit context selection

- **In-graph (`1a`)**:
  - **Definition**: User includes a context reference directly in a conditional / variable / edge expression.
  - **Example**: “For this step, show conversion in channel = `google`”, expressed as e.g. `e.a-b.context(channel:google).p.mean`.
  - **Handling**: This is a **conditional‑P** style construct; we already have scaffolding for conditional probabilities in the DSL and adapters. The main work is to ensure that this machinery cleanly extends to context keys/values (so e.g. Amplitude receives the right filter predicates when a conditional expression includes `.context(...)`).

- **Implicit / graph-level pinning (`1b`)**:
  - **Definition**: User declares that a given graph is *generally interested* in certain context patterns (e.g. “per-channel slices”, “per-browser-type slices”, possibly including specific cross-products).
  - **Behavior**:
    - These pinned context expressions drive **background batch queries** (e.g. nightly runs) and populate the cache with slices the graph “cares about”.
    - Pinned contexts themselves form a small DSL over **one or more context expressions**:
      - `context(channel)` → enumerate all channel values and fetch **single-key slices**.
      - `context(browser-type)` → enumerate all browser-type values and fetch **single-key slices**.
      - `context(browser-type).context(channel)` → explicitly request the **Cartesian product** of all browser types × all channels.
      - `or(context(channel), context(browser-type))` → union of the two sets of slices (no products).
    - This lets the user **opt into** specific Cartesian products or exotic combinations instead of us always or never taking the full product, with `or(...)` providing an explicit, familiar way to say “also this other expression”.

#### Explicit in-app / live context selection (`2`)

- **Definition**: User is explicitly “retrieving in a particular context set live into the current graph” (e.g. “right now, show this graph as if `channel = google` & `browser-type = chrome`”).
- **Interpretation**:
  - This is an **explicit, immediate request** (“I care about X and Y now”), not just a background interest.
  - Implementation-wise it should reuse the same query-building and caching pipeline as pinning, but with an **ephemeral, user-specified context DSL string** layered on top of the graph’s pinned string.
  - UX-wise this likely looks like context expressions rendered as **chips via the existing query selector / Monaco component**, with:
    - one **ephemeral “current context DSL”** string built interactively as the user tweaks the chips for the current view/window, and
    - one **pinned “graph context DSL”** string stored on the graph and editable via a dedicated contexts pop-up (used sparingly, mainly for long-lived defaults and nightly runs).

### Context Semantics & MECE Assumption

- **Context key**: A named dimension like `channel`, `browser-type`, etc.
- **Context value**: An *enumerated* option for that key: `google`, `meta`, `other`, `chrome`, `safari`, etc.

We make the simplifying assumption that:

- **Each context key has a known, finite enum of values**, and
- These values are **mutually exclusive and collectively exhaustive (MECE)** over the dataset.

Implications:

- For any key (e.g. `channel`), every event / user either:
  - Has exactly one labeled value (e.g. `google`, `meta`, `direct`, etc.), or
  - Falls into a catch‑all **`other`** bucket.
- This allows us to:
  - confidently **sum `n` and `k` over all values of a key** to obtain a correct total (no overlaps, no omissions),
  - reason about **complements** in a principled way (e.g. “NOT google” as some union of non-google values) rather than “total − google” in a hand‑rolled way.

We likely need to **require** an explicit `other` (or equivalent) value for every context key to ensure completeness, but **how we encode “not this set of contexts” is still an open design choice**:

- Reserving a magic `other` label may be too rigid.
- Alternatives include:
  - allowing `context(key:*)` to denote “all values”,
  - introducing an explicit negation form (e.g. `contextNot(channel:google)`), or
  - relying on explicit positive lists via `contextAny(...)` and seeing how far that gets us before adding NOT.

Separately, we will need to decide **how to discover and maintain the enum of values for each key**:

- v1 can rely on the registry (`contexts.yaml`) as the authoritative list.
- Longer term we may want a discovery path (e.g. from Amplitude APIs) to:
  - detect unmapped raw values (to avoid silently dumping too much mass into `other`), and
  - surface suggestions for new enum entries.

### Typical Use Cases

#### A. Nightly run (batch queries, graph-level contexts)

- **Input**: `graph_id`.
- **Process**:
  - Determine which **variables / params / cases / edges** in the graph need data.
  - Read the graph’s **pinned context DSL string(s)** (e.g. expressions over `channel`, `browser-type`).
  - For each pinned key:
    - Go to its **context definition file** and enumerate all allowed values.
    - Build a **set of queries per key**:
      - For every variable `v` mentioned on the graph,
      - For each context value of that key,
      - Build a query for `v` in that context value.
  - **Important**: at this stage we **do not** build full Cartesian products across context keys:
    - We want: \(\forall x \in [\text{channels}]\) + \(\forall y \in [\text{browser types}]\).
    - We do *not* want: \(\forall (x, y) \in [\text{channels}] \times [\text{browser types}]\).
    - Rationale: avoid sparsity + API explosion.
  - Query results are:
    - Dropped into **windowed data blocks** on the relevant vars,
    - With appropriate **context metadata** attached to each window (e.g. `{channel: google}`).

#### B. Live in-graph exploration (multi-context AND queries)

- **Example**: User wants “exactly how well does this step do if `browser-type = chrome` AND `channel = google`?”.
- **Flow**:
  - User sets both context attributes on a window component (often along with a date range).
  - Window aggregator inspects what data are already present:
    - It may have slices for each dimension individually (e.g. channel‑only, browser‑only),
    - but not necessarily for the **AND** combination (channel & browser).
  - If the exact requested combination is missing:
    - Aggregator constructs an **AND query** (multi-dimension filter) and adds it to a batch request,
    - The DAS adapter (e.g. Amplitude) executes the query,
    - Results are stored in the vars as new windows, tagged with the **combined context** (e.g. `{channel: google, browser-type: chrome}`).
  - This also acts as a **caching layer**: future requests for the same combination can be served from stored windows.
  - Today, **window date ranges live only in UI state**; part of this work should define a graph-level “current query DSL” (including both context and window/date clauses) so that:
    - persisted graphs record the context + date slice they were last inspected under, and
    - when a graph is re-opened, we can pre-populate the context/date selector UI from that stored DSL.

### DSL for Context Specification

We need a **DSL convention** for:

- Encoding context on **windows** (in var files), *** DO WE NOT HAVE THIS ALREADY? I THINK WE MAY HAVE STUBBED IT... CHECK CURRENT GRAPH SCHEMA ***
- Expressing context in **formulas / expressions** (similar to `case(...)` and other query constraints),
- Interoperating with **source-specific adapters**.

Two important alignment points with the existing system:

- **Colon syntax is canonical**: Everywhere we reference contexts in the query/condition DSL we use `key:value` pairs (e.g. `context(channel:google)`, `case(experiment:variant)`), matching `query-dsl-1.0.0.json` and `queryDSL.ts`. We do **not** introduce an `=` form.
- **Condition placement is canonical in HRNs**: For edge probabilities and conditionals, the full constraint string (including any `context(...)`, `visited(...)`, etc.) lives **between** the edge identifier and `.p.<field>`:  
  - Canonical: `e.edge-id.context(channel:google).p.mean`  
  - Not supported today: `e.edge-id.p.mean.context(channel:google)` (would be treated as nested property, not a condition).

#### Basic operations (first pass)

- **Single-context filter**:
  - `context(key:value)`  
  - Example: `context(channel:google)` → slice data where `channel == 'google'`.

- **ContextAny (OR over values for a single key)**:
  - `contextAny(key:v1,v2,...)`
  - Example: `contextAny(channel:google,meta)` → slice data where `channel ∈ {google, meta}`.
  - Useful for representing “NOT google” as:
    - `contextAny(channel:meta,other,...)` if the value set is MECE and fully known.
  - Syntactically we should allow **heterogeneous value lists** as well (e.g. `contextAny(channel:meta,channel:organic,browser-type:chrome)`), even if some combinations are semantically odd; responsibility for meaning rests with the user / higher-level tooling.

- **Multiple contexts (AND over keys)**:
  - Option 1: **Chaining**:
    - `context(channel:google).context(browser-type:chrome)`  
    - Interpreted as AND: `channel == google` ∧ `browser-type == chrome`.
  - Option 2: **Multi-arg form**:
    - `context(channel:google,browser-type:chrome)`  
    - Single call with multiple key:value pairs; also interpreted as AND.
  - We should choose **one canonical internal representation** but likely **support both** syntaxes at the DSL level, mirroring what we already do for `visited(...)` vs `visited(a,b)`.
  - Note: because `,` is already used inside function arguments to imply a kind of **product / AND** (as with `visited(a,b)`), we **cannot** also use `,` to sequence “OR” clauses. We therefore need:
    - an explicit `or()` operator to express unions of full expressions (e.g. `or(context(source), context(channel))`), and/or
    - a higher-level interpretation of multiple expressions in pinned DSL as a union. In v1 we will introduce `or()` as the **user-facing** way to express OR; how or whether we additionally support raw `;` as lower-level sugar is an implementation detail.

#### Interaction with existing DSL (cases, visited, etc.)

- **Analogy with `case(...)`**:
  - `case(my-case:control)` currently encodes a partition of data.
  - Contexts behave similarly but along **independent dimensions**, with explicit MECE guarantees per key.

- **Analogy with `visited(...)`**:
  - The existing query DSL and helpers (`parseConstraints`, `normalizeConstraintString`, etc.) already treat constraint functions (`visited`, `exclude`, `context`, `case`, `visitedAny`) in an **order-insensitive** way:
    - `visited(a).context(channel:google)` and `context(channel:google).visited(a)` are parsed into the same sets of visited/context constraints.
    - Canonical strings are produced via `normalizeConstraintString`, which sorts within each constraint type.
  - We should ensure context usages in conditions continue to go through this machinery so that **sequence of constraint terms does not affect semantics**, while still keeping the HRN layout `e.edge.<constraint>.p.field` fixed.

#### Context in source-provided parameters (e.g. Sheets)

- For non-Amplitude sources like Sheets, users might **hard-code** context-labeled values:
  - Example:  
    - `e.landing-page-conversion.context(channel:google).p.mean: 0.1`
  - Parsing / ingest should:
    - Treat the `context(...)` segment as part of the **conditional/constraint string** (between edge ID and `.p`), exactly as we do for `visited(...)` conditions.
    - Upsert the value into the var file as a window with:
      - appropriate **context metadata** (e.g. `{channel: google}`),
      - any other window metadata (time range, etc.).

### Context Metadata Files

We already have **context definition files** in the parameter registry (e.g. `param-registry/contexts.yaml`) from the earlier context-parameters work; this design reuses and clarifies that infrastructure.

- **Metadata for the key**:
  - Human-readable name, description, maybe grouping/ordering hints.

- **Enum of acceptable values**:
  - The MECE set of allowed values, ideally including an explicit “catch‑all” bucket (today often called `other` in examples).
  - Optional display names / labels per value.
  - We still need to decide whether to **standardize on a reserved label** (e.g. `other`) vs allowing users to choose their own naming and expressing complements via DSL (e.g. `contextAny(channel:meta,organic,...)`, or a future `contextNot(...)`).

- **Source-specific mappings**:
  - For each **data source** (e.g. Amplitude, Sheets, other DAS backends),
  - For each **context value**, we may need:
    - a mapping to the **source’s field name**,
    - the **filter expression / segment ID** for that value,
    - any additional configuration required by that source.

- **Extensibility**:
  - Some sources might not support the exact same value set;
  - We may need:
    - fallbacks from “desired enum” to “available slices”,
    - a way to mark values as “not available in this source”,
    - mapping multiple raw values to a single logical enum value.

This implies:

- We must **extend the Amplitude DAS adapter** to:
  - Translate `context(...)` and `contextAny(...)` into valid Amplitude segment or filter clauses,
  - Use per-value mapping strings from context metadata,
  - Handle multi-dimension AND combinations.

### MSMDC Implications (probability mass integrity)

Context affects how we construct MSMDC expressions and how we preserve **probability mass integrity** across edges, but the crucial point is:

- **Sibling complement logic is per conditional slice, not per context partition.**

Given a conditioning event \(C\) (which may itself include context constraints, visited/exclude, cases, etc.), a sibling family out of node `a` should satisfy:

- \(\sum_i P(\text{edge}_i \mid C) = 1\)
- Complements are taken **within the same condition**. For example:
  - `e.a-b.context(channel:google).p.mean = X`
  - `e.a-c.context(channel:google).p.mean = 1 - X`
  - both are \(P(\cdot \mid A,\ \text{channel}=\text{google})\).

Attempts like:

- `e.a-c.contextAny(channel:meta,other,...).p.mean = 1 - e.a-b.context(channel:google).p.mean`
- or `e.a-c.p.mean = 1 - e.a-b.context(channel:google).p.mean`

are **mathematically wrong in general**, because they mix probabilities conditioned on **different events** (different context slices, or conditional vs unconditional).

**Implication**:  
We should **enforce** that all competing edges at a node share the same **context keying regime** for any given condition (either all uncontexted, or all with the same context constraint) and only apply `1 - X` style complements **within that shared condition**. If we want a “not google” slice, it should be modeled as its own explicit condition (e.g. `contextAny(channel:meta,other,...)`) with its own sibling PMF summing to 1, not derived as `1 - X` from the google slice.

Today’s `UpdateManager.rebalanceConditionalProbabilities(...)` already follows this rule: it keeps the edited conditional entry fixed, finds **siblings that share the exact same `condition` string**, and redistributes the remaining mass across just those siblings so that the conditional PMF for that condition sums back to 1. When we extend the conditional substrate to include `context(...)` / `contextAny(...)`, we must add regression tests that:

- Create edges with conditional_ps that include context constraints in their condition strings,
- Rebalance after editing one conditional,
- And assert that, for each distinct condition string (including contexts), the sibling probabilities still sum to 1 and no cross-condition leakage occurs.

### UI Considerations

#### Graph-level context pinning

- Allow users to:
  - **Pin context keys** to a graph (e.g. `channel`, `browser-type`),
  - Optionally choose **which values** they care about (all values vs subset).
- These pinned contexts:
  - drive **overnight / background queries**,
  - determine which context slices appear as options in the graph UI,
  - should be **visible and editable** in some graph settings panel.

#### Window-level context selection & search

- Within a window component:
  - User should be able to **select / search** for specific context combinations:
    - Single key (e.g. `channel = google`),
    - Multi-key AND (e.g. `channel = google` AND `browser-type = chrome`),
    - Possibly custom sets (e.g. “all paid channels” via `contextAny`).
  - The UI should:
    - Show which context(s) are active on the window,
    - Indicate whether data already exist (cached) or a new fetch is required,
    - Let users quickly switch between “global pinned contexts” and “local overrides”.

#### Global / live context controls

- For implicit selection (`2`):
  - Consider a **graph-level context bar** where:
    - The user selects a “current context view” (e.g. `channel = google`, `browser-type = chrome`),
    - This propagates down as **default filters** for all windows,
    - But windows can still override or clear the global context if needed.

### Major Open Questions & Concerns

- **Complement semantics & MSMDC**:
  - Should we always model complements explicitly via `contextAny` and MECE sets?
  - Do we ever allow `1 - e.a-b.context(...)` against an uncontexted sibling, or should that be forbidden / discouraged?

- **Cartesian products**:
  - Nightly batch: we currently **avoid** multi-key products to keep things sparse and cheap.
  - When and how do we introduce **joint context slices** (`channel` × `browser-type`) for more complex queries?
  - Should users be able to explicitly opt into these via pinned “context combos”?

- **Caching strategy**:
  - How do we index stored windows by context combination?  
    - e.g. canonical key ordering, normalization of `context` vs `contextAny`.
  - How do we mechanically detect “we already have this slice”?

- **Source discrepancies**:
  - What if a context key/value enum is only **partially supported** by a data source?
  - We need error / warning strategies and maybe “graceful degradation” (e.g. `unknown` or `not-available` values).

- **DSL ergonomics & discoverability**:
  - How do we expose `context(...)` and `contextAny(...)` in editors so users don’t have to memorize syntax?
    - In practice we can and should **reuse the existing Monaco / query selector pattern** used for conditional queries today: `context` / `contextAny` become first-class functions in the chip UI, with autocomplete, so users rarely type them manually.
  - How does this interact with other modifiers like `case(...)`, `visited(...)`, etc. (ordering, precedence, parsing)?

- **Context “stacking” and overrides (state model)**:
  - Conceptually there are two main layers:
    - the **graph**, which may optionally carry a pinned context DSL string (used to nudge window defaults and to drive nightly runs), and
    - the **window/query state**, which represents the current “inspection query” (contexts + dates) used to fetch/aggregate data into that graph.
  - We still need to pin down the precise precedence and composition rules between **pinned graph context** and **ephemeral window context** (e.g. does the window string override entirely, intersect, or layer on top?).

- **Backfill & migration**:
  - How do we retrofit existing graphs / vars with context metadata, if at all?
  - For this v1 context work, **migrating historical “implicit context” data is explicitly out of scope**; we focus on forward-compatible representation and leave any retrofitting as a future project.

### Next Steps

- Specify the **concrete syntax** for `context(...)` / `contextAny(...)` and how they attach to variables, edges, and windows.
- Define the **context metadata file format** and wiring into DAS adapters (starting with Amplitude).
- Formalize **MSMDC rules** for how context interacts with probability mass and edge families.
- Align **HRN parsing and normalization** with the order-insensitive constraint semantics:
  - Treat constraint ordering as irrelevant both in condition strings and in HRN layout, or at minimum add a canonical normalization step so `e.edge.context(...).p.mean` and `e.edge.p.mean.context(...)` are interpreted consistently.
- Extend **UpdateManager / conditional_p tests** so that `rebalanceConditionalProbabilities` is exercised with conditions that include contexts (e.g. `visited(...) + context(...)`, `contextAny(...)`) and verified to preserve per-condition PMFs.
- Design **UI flows** for:
  - graph-level context pinning,
  - window-level context selection/search,
  - global live context view.

### Design decisions & open questions (summary)

#### Resolved (for v1)

- **Colon syntax**: Use `key:value` inside `context(...)` / `contextAny(...)` / `case(...)` consistently; no `=` form.
- **Condition placement in HRNs**: Conditions (including context constraints) live between `edge-id` and `.p.<field>` (`e.edge.<condition>.p.mean`), and are parsed via the existing conditional_p machinery.
- **Sibling PMF semantics**: Rebalancing/complement logic is defined **per condition string** (including contexts), not across different context slices; we only enforce \(\sum_i P(e_i \mid C) = 1\) within a shared conditioning event `C`.
- **State model layers**: Conceptually two layers:
  - graph-level pinned context DSL (long-lived, drives nightly runs and default suggestions),
  - window-level / query DSL (ephemeral, used to inspect/fetch data into the graph, including contexts + dates).
- **Backfill scope**: Migrating historical graphs/vars to add context metadata is **out of scope** for this phase; the focus is on forward-compatible representation + UI.
- **Editor UX**: We will reuse the existing Monaco / query selector pattern (chips + autocomplete) for `context` / `contextAny`, so users rarely need to hand-type the DSL.

#### Still open

- **Complement and NOT semantics**:
  - Whether to rely solely on positive enumerations (`contextAny(...)`) vs introducing an explicit negation form (e.g. `contextNot(...)`) and/or special handling for a catch-all “other” value.
  - Likely v1 stance:
    - Model “NOT X” via **positive lists** plus good UI (e.g. “select all, then deselect instagram” giving `contextAny(source:facebook,google,organic,...)`), and accept that the DSL string may be long but auto-authored.
    - Revisit an explicit NOT operator only if/when we have very high-cardinality enums where this pattern becomes unmanageable.

- **Enum discovery from sources**:
  - How (and whether) to introspect context value sets from sources like Amplitude vs treating the registry as authority and only surfacing unmapped values as suggestions/warnings. 
  - Open item: research Amplitude’s REST APIs (especially around UTM-like properties) to understand how safely and cheaply we can enumerate distinct values for a key and feed that back into registry maintenance / suggestions.

- **OR semantics in the DSL**:
  - Exact choice of syntax for “OR across expressions” (e.g. `;` vs an `or()` function) given that `,` is already used for AND/product within function arguments.
  - For now:
    - We **keep `,` as AND/product** within functions (no change).
    - We introduce an explicit **`or()` operator** as the *user-facing* way to express unions of full expressions:
      - e.g. `or(context(source), context(channel))` meaning “all source slices ∪ all channel slices”.
    - Internally it’s an implementation detail whether `or(...)` is desugared to a clause list (equivalent to a `;`-separated representation) before parsing, or handled directly in the DSL parser; at the DSL level `or()` is the canonical construct, chosen to avoid overloading punctuation and to feel familiar to spreadsheet users.

- **Context metadata conventions**:
  - Whether we reserve a specific label (e.g. `other`) and how strictly we validate against `contexts.yaml` for each source.

*** WHAT ARE THE CIRCUMSTANCES IN WHICH WE TRULY CARE ABOUT THIS. LET'S PLAY IT OUT. I HAVE A KEY 'SOURCE' AND DEFINE VALUES 'GOOGLE' AND 'META'. THERE IS AN IMPLICIT 'OTHER' EVEN IF NOT MENTIOEND ON THE CONTEXT VAR FILE BECAUSE WHEN AMPLITUDE QUERIES ARE CONSTRUCTED, WE MUST RETRIEVE FOR (A) SOURCE:GOOGLE, (B) SOURCE:META AND (C) =ALL_RESULTS(A)-(B). NOW WE HAVE TO WRITE THOSE QUERY STRINGS ONTO THE VAR FILE SOMEHOW IN A DATA WINDOW OBJECT AND WE'VE SAID THAT WE'RE GOING TO USE DSL STRINGS TO DO THAT, SO WE NEED A CANONICAL WAY OF EXPRESSING NOT_ANY_OF *OR* 'OTHER'.
-- AND THEN WHEN USER IS INSPECTING THE DATA THEY MAY WANT COMFORT THAT THE VALUES ARE WELL CONFIGURED SO WILL WANT TO SPECIFY A QUERY SUCH AS SOURCE:<OTHER> IN ORDER TO CONFIRM THAT IT'S NOT ACTUALLY DARK MATTER. 

SO. WE NEED AN UNAMBIGUOUS DSL EXRESSION WHICH IS INTERPRETED AS <OTHER>. WHAT ARE OUR OPTIONS? ***

  - We care most when we:
    - construct “everything-else” windows (e.g. `source:other` = ALL_RESULTS − known sources) at the adapter layer, and
    - allow users to inspect that `other` bucket explicitly to confirm it isn’t just dark matter.
  - v1 leaning:
    - Keep a **registry-level catch-all** (likely `other`) with clearly defined adapter behavior (complement of explicitly enumerated values for that key and source).
    - Treat a more general `contextNot(...)` form as a later enhancement if we need more nuanced complements.

*** I THINK WE HAVE A POLICY PER CONTEXT FILE [DEFAULTS TO SOMETHING SENSIBLE] WHICH CONSTRUCTS OTHER FOR THE SELECTED SOURCE. STANGARD REGIMES MIGHT INCLUDE:
- OTHER = NULL [I.E. ASSERT THAT VALUES ARE MECE]
- OTHER = ALL RESULTS LESS ALL SPECIFIED VALUES
- OTHER = THIS SPECIFIC SET OF ITEMS (LIST)

ALSO NOTE FOR IMPLEMENTATION PURPOSES WE WILL NEED TO ALLOW THE CONNECTION STRING TO PERMIT REGEX FOR VALUES SO E.G. WE CAN COLLAPSE LARGE UTM STRING SPACES INTO A LIST WITH MANAGEABLE CARDINALITY 
***

- **Window/query persistence**:
  - The precise shape and location of the “current query DSL” we store on graphs (contexts + date window) so that saved graphs can rehydrate the context/date selector state.

*** WELL WE HAVE THE CONTEXT DSL FROM THIS WORK. THE ONLY THING WE LACK IS A DATE WINDOW DSL, NO? PROPOSE ONE ***

- Contexts come from this design; the missing piece is a **date/window DSL**, for which a candidate is:
    - `window(2025-01-01:2025-12-31)` (or ISO timestamps) alongside `context(...)` in the same DSL string.

*** YES, BUT WE PROBABLY ALSO NEED A FORM OF WINDOW() EXPRESSION WHICH IS RELATIVE RATHER THAN ABOSLUTE SO WE CAN USE IT TO BUILD DYNAMIC SCENARIOS TOO. I'M THINKING E.G. WINDOW(-14D:-7D) OR WINDOW(-30D:). WE AREN'T GOING TO USE THAT YET, BUT WORTH DEFINING THE CONCEPT PROPERLY SO ITS EXTENSIBLE *** 

- **Pinned vs window precedence rules**:
  - Exact composition semantics when both pinned graph context and ephemeral window context are present.
  - v1 stance:
    - The **current window/query DSL always wins** for what is shown/fetched; pinned graph context is a default / nudge and for nightly runs, not a hard constraint.
    - UI must clearly indicate when the current query is outside the cached dataset and requires a fetch (extending the existing window “Fetch” button) and leverage an index over existing windows (by var/day/context) to make this determination fast.

These lists should be updated as implementation progresses so that CONTEXTS.md remains the single place to track which design questions have been settled vs still under discussion.

### Preliminary scope of work (v1)

- **DSL & schema**
  - Finalize syntax for `context(...)` / `contextAny(...)` (including any OR / NOT forms chosen for v1).
  - Update `query-dsl-1.0.0.json`, `queryDSL.ts`, Python parser, and any validators so contexts are fully supported as first-class constraints.
  - Ensure HRN parsing/normalization handles context-bearing condition strings correctly and order-insensitively.

- **Data model & metadata**
  - Confirm and, if needed, extend the context registry files (`contexts.yaml` etc.) to act as the MECE enum source for each key.
  - Decide and implement how windows/vars store context metadata (and add time-window metadata where necessary).
  - Add graph-level fields for pinned context DSL and “current query DSL” (contexts + dates) as needed.

- **Adapters & ingestion**
  - Extend the Amplitude DAS adapter to translate `context(...)` / `contextAny(...)` into source-specific filters/segments, using mappings from context metadata.
  - Ensure Sheets and other sources can supply context-bearing condition strings via the existing param-pack / HRN pipeline (no bespoke paths).
  - Wire context-aware slices into the nightly runner so pinned contexts drive the appropriate batch queries.

- **MSMDC & probability integrity**
  - Verify that existing conditional_p sibling rebalance logic behaves correctly when conditions include contexts.
  - Add tests covering context-bearing conditions and enforce per-condition PMF constraints.

- **UI / UX**
  - Add context chips to the appropriate panels (windows, global context bar) using the existing query selector component.
  - Implement editing of pinned graph context DSL vs ephemeral window context DSL, with clear affordances and defaults.
  - Surface available context keys/values based on the registry and pinned expressions, including search/filter where needed.

- **Testing & docs**
  - Extend unit/integration tests around HRN parsing, UpdateManager, and DAS adapters to cover contexts.
  - Update user-facing docs (DSL guide, Sheets integration, scenarios docs) to show context usage patterns and best practices.
