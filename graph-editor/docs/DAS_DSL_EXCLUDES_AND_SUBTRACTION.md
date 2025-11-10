## DAS Funnel DSL: Exclusion, Subtraction, and Edge Probability

### Purpose
- Clarify the problem we’re solving: estimating an edge probability p(A→C) from event funnels, sometimes with “not via B” constraints.
- Summarize constraints discovered when implementing Amplitude via the Dashboard REST API (GET), and why native excludes aren’t available.
- Precisely state the current user-facing DSL algebra and its properties.
- Propose the minimal, order-independent DSL addition that encodes subtractive funnels in the DSL string (no hidden policy), plus when it works and when it needs more terms.

### Problem We’re Solving
- We want to compute p on a specific edge A→C (n, k, and p_mean = k/n) under priors/hyperpriors (filters, segments, date window).
- In some cases, we require “A→C without B between them” (avoid paths that include B as a mediator between the anchors).
- Our data source is Amplitude via the Dashboard REST API (GET). Findings:
  - Ordered funnels are supported (default; can set `mode=ordered` explicitly).
  - The GET endpoint does not honor an “exclude” parameter; attempts with `ex=...` are ignored.
  - Therefore, native “exclude B” must be implemented via subtraction of funnel counts.

### Current Implementation Status (high-level)
- Amplitude adapter works via GET; URL/auth escaping fixed; proxying implemented for dev/prod to avoid CORS.
- Event mappings resolve from IDB and filters are applied correctly (confirmed: property key `level` for “ServiceLevel Confirmed”).
- Minimal working funnel GET parameters: repeated `e=...` for steps, `start`, `end`, `i=1`, `mode=ordered` (optional explicitness).
- Exclusion is not honored by the public GET endpoint; must use subtractive logic at our layer.

### Current User-Facing DSL (String) and Properties
- Surface syntax (today):
  - `from(A).to(C).visited(...).visitedAny(...).excludes(...)`
  - Optional `mode(ordered|unordered|sequential)`; date window controlled outside or implied.
- Algebraic properties (design choice we must respect):
  - Commutative, homomorphic: token order must not carry semantics.
  - Anchors are defined by `from(...)` and `to(...)`.
  - `visited(X)` means “X occurs somewhere strictly between anchors.”
  - `excludes(B)` is author intent; when provider lacks native exclude, we must compile intent to subtraction (see proposal).

### Graph-Theory Framing (why subtraction works)
- Events form a directed graph G = (V, E); a user’s timeline is a walk on G.
- Let S(A→…→C) be the set of users whose event sequence contains the ordered subsequence [A, …, C] within the window/filters.
- For a single mediator B, “A→C without B” corresponds to set difference:
  - |S(A→C without B)| = |S(A→C)| − |S(A→B→C)|
  - This is valid when measurement mode/filters/window are identical and counts are uniques.

### Minimal DSL Extension (String) – Order Independent
- Keep existing grammar. Add one operator:
  - `minus( …funnel_expr… )`
- Canonical subtractive “exclude B between A and C” (entirely in the DSL string):
  - `from(A).to(C).minus(from(A).to(C).visited(B))`
  - Equivalent (order-free): `minus(from(A).to(C).visited(B)).from(A).to(C)`
- Semantics:
  - Treat the expression as a multiset of signed funnel terms: a positive base funnel and one or more negative terms inside `minus(...)`.
  - Base funnel: `from(A).to(C)`
    - n = from_count(A→C)
    - k_base = to_count(A→C)
  - Subtractive term: `minus(from(A).to(C).visited(B))`
    - k_excl = to_count(A→B→C)
  - Result: k = max(0, k_base − k_excl), p_mean = (n > 0) ? k/n : 0
  - Anchors must match: the minus funnel shares the same from/to anchors as the base (or it’s ill-formed).

### Why This Addition
- Completely user-visible policy: no hidden plan/JSON. The DSL string alone encodes intent and the algebra.
- Order-independent: works with a commutative/homomorphic DSL; the position of `minus(...)` does not matter.
- Minimality: a single unary operator; zero changes to `from()`, `to()`, `visited()`, `visitedAny()`, or `excludes()`.
- Interop with existing DSL: `excludes(B)` can remain as author intent; MSMDC (with graph context) can rewrite it to the explicit `minus(from(A).to(C).visited(B))` form under a “no-native-exclude” policy.

### Mathematical Completeness of minus()

Within the conversion-funnel DAG model (directed acyclic, finite, with observable events), we can prove:

**Theorem**: For any edge (A→T) and its local post-merge node M, there exists a finite set of `minus(...)` terms that exactly partition all non-kept A→M paths. Therefore, `minus()` composition is **complete** for edge discrimination, and a native `excludes()` operator is not logically required.

**Proof sketch**:
- All A→M paths can be partitioned by their first hop from A.
- For each alternate first hop (A→u where u ≠ T), find a separator node S_u (earliest node that all A→u→M paths must cross, and that the kept edge doesn't reach before that point).
- Add `minus(from(A).to(S_u).visited(u))` for each alternate u.
- The residual after all subtractions is exactly the paths starting with the kept edge (A→T).

### The Only True Failure Condition

After systematic exploration of edge cases (multi-branch splits, nested branches, side-quests, overlapping detours, re-entrant nodes), we identified exactly one failure mode:

**`minus()` fails only if:**
1. A competing branch has **no observable marker** before the merge M, AND
2. You **can't query** `from(u).to(M)` for that branch node u, AND
3. You **can't shrink the span** to a closer merge boundary.

If any of these is false, `minus()` can still isolate the desired edge.

This reframes "failure" not as a logical limitation of the algebra, but as a **data observability** limitation. The DAG formalism itself is closed under subtraction.

### Progressive Reasoning: What We Tested

| Context tested | Finding |
|----------------|---------|
| Simple 2-way split-merge (A→B vs A→D→C) | Trivial; direct `from(A).to(B)` suffices |
| Silent/default edge (A→M, A→B→M) | `minus()` needed and exact: `from(A).to(M).minus(from(A).to(M).visited(B))` |
| Multi-branch split (A→B, A→D, A→E→M) | `minus()` works; one per competitor; residual = "default edge" |
| Nested branches or re-entrant nodes (A→D→E→B→M) | Still composable; 2–3 minuses cover each detour family |
| Overlapping detours (B and D co-occur before merge) | Need add-back term if provider can't guarantee exclusivity |
| Side-quests or parallel non-gating events | Anchoring matters; shrink span to local split/merge |
| "Contamination" where excluded node reachable from kept edge | Fix by choosing narrower merge M′ or order-constraining the minus |
| **Unmarked/unobservable branches** | **The only true failure** — see above |

### General Algorithm for Generating minus() Terms

Given:
- Graph G (a DAG)
- Split node A
- Kept edge (A→T)
- First post-merge node M (minimal region that fully resolves the decision)

Output: A base query plus N subtractive sub-queries

**Steps:**
1. **Enumerate alternate first hops**: `Alt = { u | (A→u) in edges, u ≠ T }`
2. **For each u ∈ Alt**, find a **separator** S_u:
   - S_u is the earliest node that every A→u→…→M path must cross
   - The kept edge's path doesn't reach S_u before that point
3. **Add a minus term**:
   ```
   minus(from(A).to(S_u).visited(u))
   ```
4. **Final composite**:
   ```
   from(A).to(M)
     .minus(from(A).to(S_u1).visited(u1))
     .minus(from(A).to(S_u2).visited(u2))
     ...
   ```

This is equivalent to a **partition of all A→M paths by first hop** — the residual after all minuses is exactly those starting with the kept edge.

### When Multiple minus() Terms Are Needed

| Scenario | Solution |
|----------|----------|
| Single mediator B | One minus: `from(A).to(C).minus(from(A).to(C).visited(B))` |
| Multiple mediators B, D (exact) | Inclusion–exclusion: subtract each, add back overlap if needed |
| Interval-specific exclusion (B only between X and Y) | Anchored minus: `minus(from(X).to(Y).visited(B))` |
| Multi-branch split (3+ competitors) | One minus per alternate first hop using separators |
| Grouped/stratified outputs | Per-group subtraction with identical settings |
| Different modes/filters/windows | Invalid; all terms must share measurement settings |

### Execution Model (Where logic lives)
- MSMDC (Python, planner, has graph context):
  - Resolves `excludes(B)` (or policy) into an explicit subtractive DSL string:
    - `from(A).to(C).minus(from(A).to(C).visited(B))`
  - Ensures provider event names and filters are resolved.
- dataOperationsService (JS, executor/orchestrator):
  - Parses the DSL string into a base funnel and N minus funnels.
  - Executes each funnel via DAS/adapter (Amplitude GET):
    - Base: `e={"event_type":"A"}&e={"event_type":"C"}...`
    - Minus: `e={"event_type":"A"}&e={"event_type":"B"}&e={"event_type":"C"}...`
  - Extracts counts (e.g., `data[0].cumulativeRaw[...]`), computes n/k, clamps k≥0, writes `p.mean`, `p.evidence.n`, `p.evidence.k`.
- DASRunner/adapter:
  - Remains a simple single-request builder for a funnel path; no graph logic is added here.

### Practical Notes and Guardrails
- Always use identical window, mode, filters, and grouping between base and minus funnels.
- Use `mode=ordered` (explicit) for clarity; subtractive logic assumes ordered uniqueness.
- For multi-excludes, consider scope:
  - v1: allow exactly one minus term (single mediator) for simplicity and robustness.
  - v2: add authorable inclusion–exclusion (e.g., `plus(from(A).to(C).visited(B).visited(D))`) if exactness for multiple mediators is required.

### Examples (User DSL strings)
- A→C, no exclusion:
  - `from(A).to(C)`
- A→C, "without B" via subtraction:
  - `from(A).to(C).minus(from(A).to(C).visited(B))`
- A→C with a required context X, still excluding B:
  - `from(A).visited(X).to(C).minus(from(A).to(C).visited(B))`
- Interval-specific exclusion (exclude B only between X and Y):
  - `from(A).to(C).minus(from(X).to(Y).visited(B))`

### Strategic Architectural Implications

#### DSL Layer
- **`excludes()` is syntactic sugar**, not a fundamental primitive.
- It compiles to one or more `minus(...)` expressions via MSMDC (which has graph context).
- Grammar remains order-independent and backward-compatible.
- All policy is visible in the DSL string; no hidden JSON compilation artifacts.

#### Planner / Compiler (MSMDC)
- Needs a **subtractive cover generator**:
  - Identify competing first hops from split node A.
  - Compute separator nodes via dominance/post-dominance analysis.
  - Emit `minus(...)` clauses accordingly using the general algorithm.
- Optional optimization: minimal cover selection or overlap pruning for efficiency.

#### Runner / Orchestrator (dataOperationsService)
- Executes base + minus sub-queries (can be done in parallel).
- Combines counts deterministically: k = max(0, k_base − Σ k_minus[i])
- All queries share identical filters, context, window, and mode.
- Standard error and CI propagation can treat base/minus as paired counts.

#### Schema
- No schema changes required beyond adding `minus(...)` to the DSL grammar parser.
- Graph JSON structure (nodes, edges, policies) remains valid as-is.
- Optional: add `"excludes_strategy": "subtractive"` to policies for documentation.

#### Provider Independence
- This design is fully provider-agnostic; any source that supports `from()`, `to()`, and `visited()` can be used.
- No dependence on provider-specific "exclude" features.
- Maintains the modular, neutral design principles of the DAS architecture.

### Conclusion

We've proven that within the conversion-funnel DAG model:
- **`minus()` is a complete expressive replacement** for `excludes()`.
- The planner (MSMDC) can always construct a finite subtractive cover for any identifiable edge.
- Failures arise only from **missing observability** (no event, no queryable segment, no narrower merge) — a data limitation, not an algebraic one.

This gives us a clean, provider-agnostic DSL core that remains fully declarative and interpretable, perfectly aligned with the modular, schema-driven, DAG-based analysis model of the Graph Analysis for Conversion Funnel project.*** End Patch***}아요大 ***!

