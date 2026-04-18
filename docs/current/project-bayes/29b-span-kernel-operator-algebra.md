# 29b — Span Kernel: Operator Algebra and DAG-Cover Planner

**Date**: 9-Apr-26
**Status**: Design stress-test (companion to doc 29)
**Purpose**: Define the unified operator algebra for multi-hop cohort
maturity, then stress-test it systematically across all structural
cases.

---

## 1. Operator Abstraction

Every available piece — whether a fitted cohort() macro-block or a raw
window() edge block — is represented as one operator type:

```
Operator(s, t, f_{s→t}(τ), F_{s→t}(τ), metadata)
```

| Field | Meaning |
|-------|---------|
| `s` | Start node |
| `t` | End node |
| `f(τ)` | Sub-probability density on the discrete tau grid |
| `F(τ) = Σ_{u≤τ} f(u)` | Sub-probability CDF |
| `metadata` | Slice/context/asat, fit quality, block size, source type |

**Interpretation**: "given unit mass at s, what mass reaches t by age τ?"

Leakage is encoded in `F(∞) < 1`. No special leakage handling needed.

### Operator sources

| Source | Notation | How density is obtained |
|--------|----------|------------------------|
| Window() edge posterior | `W(u→v)` | `f(τ) = p · pdf(τ; onset, mu, sigma)` from edge posterior |
| Fitted cohort() macro-block | `C[a \| s→t]` | `f(τ) = p_path · pdf(τ; path_onset, path_mu, path_sigma)` from path-level posterior anchored at a, spanning s→t |

Available macro-blocks today:
- Every edge: `W(u→v)` — always available
- Every edge's path-level posterior: `C[a | a→v]` — anchor-rooted
  macro-block from anchor a to the edge's to-node v

Arbitrary sub-path macro-blocks (e.g. `C[a | B→D]`) do not exist
today. They would require sub-path fitting in the Bayes engine.

---

## 2. Composition Algebra

Two operations only:

**Serial composition** (block A feeds block B at a shared node):

```
f_{s→t}(τ) = (f_{s→m} * f_{m→t})(τ) = Σ_u f_{s→m}(u) · f_{m→t}(τ − u)
```

Convolution of sub-probability densities. Asymptotic:
`F_{s→t}(∞) = F_{s→m}(∞) · F_{m→t}(∞)`.

**Parallel composition** (two branches reach the same downstream node):

```
f_{s→t}(τ) = f_{route_1}(τ) + f_{route_2}(τ)
```

Sum of per-route densities. Routes are mutually exclusive given arrival
at s. Asymptotic: `F_{s→t}(∞) = Σ_r F_r(∞)`.

Numerical implementation: discrete convolution on integer tau grid
(0..max_tau). O(max_tau²) per serial composition.

---

## 3. Two-Pass DAG-Cover Planner

For a requested analysis `from(x).to(y)` with anchor a:

### 3.1 Build target regime DAGs

- **Upstream regime**: `G_up = closure(a→x)` — all edges on paths
  from a to x
- **Subject regime**: `G_sub = closure(x→y)` — all edges on paths
  from x to y

When x = a, G_up is empty (identity operator: F_up = δ(τ=0),
F_up(∞) = 1).

### 3.2 Generate candidate blocks

For each target DAG, collect all usable operators.

A block is **admissible** for a target regime if:
1. Its start and end nodes lie inside the target DAG
2. All edges it spans lie inside the target DAG
3. Its slice/context/asat are compatible with the query
4. Its anchor matches the regime's anchor (for cohort() blocks)

**Admissibility examples**:
- `C[a | a→v]` is admissible for G_up if v is a node in G_up
- `C[a | a→v]` is admissible for G_sub only if a = x (i.e. x = a)
- `W(u→v)` is admissible for any regime containing edge u→v
- `C[a | b→y]` where b is inside G_sub but a ≠ x: **NOT admissible**
  for G_sub (wrong anchor — see §misaligned block case)

### 3.3 Solve the cover

**Goal**: cover the target regime DAG with a set of compatible blocks
that compose exactly (edge-disjoint, composition-compatible at seams).

**Preference ordering**:
1. Single macro-block covering the entire regime (zero convolutions)
2. Fewest macro-blocks tiling the regime (fewer seams)
3. Fill remaining gaps with single-edge window() blocks

For today's block inventory (anchor-rooted paths + single edges), the
planner is simple:
- **Upstream**: try `C[a | a→x]` first (covers all of G_up). If not
  available, try `C[a | a→v]` for intermediate nodes v, compose
  remaining with `W` blocks.
- **Subject**: try `C[a | x→y]` (only available when x = a). If not,
  cover entirely with `W` blocks.

For graphs of realistic size (2–10 edges), exhaustive search over
valid covers is trivially fast. A greedy "largest block from frontier"
is sufficient.

### 3.4 Evaluate the plan

Once a cover is chosen, evaluate it using the composition algebra
(§2). The result is a single operator for each regime:

```
F_up(τ)  — upstream operator (a→x)
F_sub(τ) — subject operator (x→y)
```

### 3.5 Compute the maturity rate

```
X_x(s, τ) = a_pop(s) · F_up(τ)        [denominator]
Y_y(s, τ) = Σ_u ΔX_x(s, u) · F_sub(τ − u)  [numerator]
rate(s, τ) = Y_y(s, τ) / X_x(s, τ)
```

Where `a_pop(s)` is the anchor population for cohort s (varies by
anchor_day).

When x = a: F_up = δ(τ=0), so X_x = a_pop(s) for all τ, and
Y_y = a_pop(s) · F_sub(τ).

**Window() mode**: F_up is not needed. X_x is the fixed observed count
at x (constant for all τ), and Y_y = X_x · F_sub(τ). The convolution
collapses because ΔX_x is a delta at τ=0.

### 3.6 Evidence/forecast boundary

The formulas above describe the **forecast** (model-derived) rate.
Real cohort maturity charts also have an **observed** region from
snapshot evidence.

- **Observed region** (τ ≤ tau_observed): use actual (x_obs, y_obs)
  from composed evidence frames. The operator model is not used here.
- **Forecast region** (τ > tau_observed): use the operator model
  (F_up, F_sub) as above.
- **Frontier transition**: at tau_observed, the row builder performs
  Bayesian conditioning — updating the prior using observed (x, y) to
  produce a posterior, then forecasting beyond the frontier using the
  posterior predictive with the operator's temporal shape. See doc 29
  §"MC fan bands and frontier conditioning" for detail.

The operator algebra in this doc specifies the forecast model. The
evidence composition and frontier conditioning are specified in doc 29.

---

## 4. Stress Cases

### Notation

```
a, b, c, ... = graph nodes
W(u→v) = window() edge operator
C[a | s→t] = fitted cohort() macro-block anchored at a, spanning s→t
→ = directed edge
G_up = upstream regime (a→x)
G_sub = subject regime (x→y)
```

For each case we verify:
- **(L) Latency**: the composed operator's temporal shape is correct
  (convolution produces the right density)
- **(M) Mass**: the composed operator's asymptotic value is correct
  (leakage, branching, and joins handled correctly)

---

### Case 1: Upstream simple, Subject simple

```
a → x → y
```

Query: `from(x).to(y)`, anchor = a.

**G_up** = {a→x} (one edge)
**G_sub** = {x→y} (one edge)

**Available blocks**: W(a→x), W(x→y), C[a | a→x], C[a | a→y]

**Upstream cover**: C[a | a→x] preferred (single macro-block). Falls
back to W(a→x).

**Subject cover**: C[a | a→y] is NOT admissible — it spans a→y, not
x→y, and a ≠ x. Use W(x→y).

Wait — when x = a, C[a | a→y] IS admissible for G_sub since a = x.
When x ≠ a, only W(x→y) is available.

**Sub-case 1a: x = a** (query `from(a).to(y)`):
- G_up is empty. F_up = δ(τ=0).
- G_sub = {a→y}. C[a | a→y] covers it. Single macro-block.
- X_a = a_pop. Y_y = a_pop · F_{a→y}(τ).
- This is current single-edge cohort maturity. **Parity: exact.**

**Sub-case 1b: x ≠ a**:
- G_up = {a→x}. Use C[a | a→x] or W(a→x).
- G_sub = {x→y}. Use W(x→y).
- X_x(τ) = a_pop · F_{a→x}(τ). Y_y(τ) = Σ_u ΔX_x(u) · F_{x→y}(τ−u).

**(L) Latency**: G_up: single operator, no composition needed — shape
is directly from the a→x posterior or the a→x edge posterior. G_sub:
single operator, shape from x→y edge posterior. Convolution of ΔX_x
with F_sub gives the correct temporal spread. ✓

**(M) Mass**: X_x(∞) = a_pop · p_{a→x}. Y_y(∞) = a_pop · p_{a→x} ·
p_{x→y} = a_pop · p_{a→y}. Correct — leakage at each edge compounds.
✓

---

### Case 2: Upstream split+join, Subject simple

```
a → b → x → y
 \→ c →/
```

Query: `from(x).to(y)`, anchor = a.

**G_up** = {a→b, b→x, a→c, c→x} (diamond)
**G_sub** = {x→y} (one edge)

**Available blocks**: W(a→b), W(b→x), W(a→c), W(c→x), W(x→y),
C[a | a→b], C[a | a→x] (path-level from edges b→x or c→x),
C[a | a→y]

**Upstream cover**:

Option 1: C[a | a→x] — single macro-block covering the entire diamond.
This is the path-level operator from the Bayes engine, which already
accounts for both routes (the Bayes path composition handles
branching). **Preferred**.

Option 2: Compose from atomic blocks.
- Route 1: W(a→b) * W(b→x)  → f_route1(τ)
- Route 2: W(a→c) * W(c→x)  → f_route2(τ)
- Combined: f_{a→x}(τ) = f_route1(τ) + f_route2(τ)

Both options should agree. If C[a | a→x] is available and high quality,
prefer it. Otherwise fall back to composed atomic blocks.

**Subject cover**: W(x→y). (C[a | a→y] only admissible if x = a.)

**(L) Latency**: Upstream option 2: route 1 density is the convolution
of W(a→b) and W(b→x) densities — spreading from a through b to x.
Route 2 is the convolution of W(a→c) and W(c→x). The sum gives the
combined arrival profile at x. Some arrivals come early (via the faster
route), some later (via the slower route). The combined CDF may be
non-lognormal (bimodal if routes have very different latencies). The
numerical grid convolution captures this correctly. ✓

Option 1 (macro-block) uses a single shifted-lognormal fitted to the
overall a→x path. This is a parametric approximation of the true
bimodal shape. It matches at the mean and variance (FW composition) but
may lose bimodality. This is why we prefer the macro-block for
numerical quality (it was fitted to actual observed data) but note that
its parametric form may not capture multi-modal structure.

**(M) Mass**: Upstream: F_{a→x}(∞) = p_{a→b}·p_{b→x} + p_{a→c}·p_{c→x}.
This is the total reach from a to x across both routes. Equals
`calculate_path_probability(a, x)`. ✓

X_x(∞) = a_pop · reach(a→x). Y_y(∞) = a_pop · reach(a→x) · p_{x→y}.
Correct. ✓

---

### Case 3: Upstream join-depth, Subject simple

```
a → b → d → x → y
 \→ c →/
```

Query: `from(x).to(y)`, anchor = a.

**G_up** = {a→b, a→c, b→d, c→d, d→x} (diamond + tail)
**G_sub** = {x→y}

**Available blocks**: all W edges, C[a | a→b], C[a | a→d] (from edges
b→d or c→d), C[a | a→x] (from edge d→x)

**Upstream cover**:

Option 1: C[a | a→x] — single macro-block. Preferred.

Option 2: C[a | a→d] * W(d→x).
- C[a | a→d] covers the diamond (a→b→d + a→c→d) as one macro-block
- W(d→x) covers the tail
- Serial composition at seam d

Option 3: Full atomic composition.
- Routes a→b→d and a→c→d (parallel sum), then serial with W(d→x)

**Subject cover**: W(x→y).

**(L) Latency**: Option 2 is interesting: the macro-block C[a | a→d]
captures the diamond's temporal shape (possibly bimodal from two
routes), and we convolve it with the d→x edge density. This is one
convolution instead of three (option 3 requires two convolutions for
the diamond routes, then the serial composition). The temporal shape is
correct in both cases. ✓

**(M) Mass**: F_{a→x}(∞) = reach(a→d) · p_{d→x} =
(p_{a→b}·p_{b→d} + p_{a→c}·p_{c→d}) · p_{d→x}. Correct. ✓

---

### Case 4: Upstream simple, Subject split+join

```
a → x → b → y
      \→ c →/
```

Query: `from(x).to(y)`, anchor = a.

**G_up** = {a→x} (one edge, or empty if x = a)
**G_sub** = {x→b, b→y, x→c, c→y} (diamond)

**Available blocks**: all W edges, C[a | a→x], C[a | a→b] (from x→b
when x = a), C[a | a→y] (from b→y or c→y when x = a)

**Subject cover**:

If x = a: C[a | a→y] may cover the entire diamond as one macro-block.
Preferred.

If x ≠ a: no macro-blocks available for G_sub. Compose from atomic:
- Route 1: W(x→b) * W(b→y) → f_route1(τ)
- Route 2: W(x→c) * W(c→y) → f_route2(τ)
- Combined: f_{x→y}(τ) = f_route1(τ) + f_route2(τ)

**(L) Latency**: Subject: two routes from x to y. Each route's density
is the serial convolution of its two edge densities. The combined
density is the sum. The resulting CDF K_{x→y}(τ) captures both routes'
temporal profiles. If one route is fast (low latency edges) and the
other slow, the CDF will show a characteristic two-phase rise. The
numerical grid convolution captures this exactly. ✓

**(M) Mass**: K_{x→y}(∞) = p_{x→b}·p_{b→y} + p_{x→c}·p_{c→y}.
This is the total conditional probability of reaching y given arrival
at x, across both routes. ✓

---

### Case 5: Upstream simple, Subject split+join+depth

```
a → x → b → d → y
      \→ c →/
```

Query: `from(x).to(y)`, anchor = a.

**G_up** = {a→x}
**G_sub** = {x→b, x→c, b→d, c→d, d→y} (diamond + tail)

**Subject cover**:

If x = a: C[a | a→y] may exist as one macro-block.

If x ≠ a: Atomic composition.
- Routes to d: W(x→b)*W(b→d) + W(x→c)*W(c→d)  → f_{x→d}(τ)
- Tail: f_{x→y}(τ) = (f_{x→d} * f_{d→y})(τ)

This is a three-stage computation:
1. Convolve each route to d (two serial compositions)
2. Sum routes at d (parallel composition)
3. Convolve with d→y (one serial composition)

The DP naturally does this in topological order: process b and c
(receiving from x), then d (receiving from b and c), then y (receiving
from d).

**(L) Latency**: The diamond portion spreads arrivals at d across two
temporal profiles. The sum at d captures the combined arrival shape.
Convolving with d→y further spreads arrivals. Correct — the DP handles
this naturally. ✓

**(M) Mass**: K_{x→y}(∞) = (p_{x→b}·p_{b→d} + p_{x→c}·p_{c→d}) ·
p_{d→y}. Correct. ✓

---

### Case 6: Upstream split+join, Subject split+join

```
a → b → d → x → p → r → y
 \→ c →/      \→ q →/
```

Query: `from(x).to(y)`, anchor = a.

**G_up** = {a→b, a→c, b→d, c→d, d→x} (diamond + tail)
**G_sub** = {x→p, x→q, p→r, q→r, r→y} (diamond + tail)

This is the Cartesian product: both regimes are diamond+tail.

**Upstream cover**: C[a | a→x] preferred, else atomic diamond+tail.
**Subject cover**: if x = a, C[a | a→y] preferred. Else atomic
diamond+tail.

**Composition when both are atomic**:

Upstream DP (topological: b, c, d, x):
- g_b = W(a→b).f
- g_c = W(a→c).f
- g_d = (g_b * W(b→d).f) + (g_c * W(c→d).f)
- g_x = g_d * W(d→x).f
- F_up = accumulate(g_x)

Subject DP (topological: p, q, r, y):
- g_p = W(x→p).f
- g_q = W(x→q).f
- g_r = (g_p * W(p→r).f) + (g_q * W(q→r).f)
- g_y = g_r * W(r→y).f
- F_sub = accumulate(g_y)

Then:
- X_x(τ) = a_pop · F_up(τ)
- Y_y(τ) = Σ_u ΔX_x(u) · F_sub(τ − u)

**(L) Latency**: Each regime independently resolves its diamond+tail
shape. The upstream produces a (possibly bimodal) arrival profile at x.
The subject produces a (possibly bimodal) conditional progression
shape. The convolution of ΔX_x with F_sub correctly accounts for the
temporal spread of arrivals at x flowing through the subject DAG. ✓

**(M) Mass**: X_x(∞) = a_pop · (p_{a→b}·p_{b→d} + p_{a→c}·p_{c→d}) ·
p_{d→x}. Y_y(∞) = X_x(∞) · (p_{x→p}·p_{p→r} + p_{x→q}·p_{q→r}) ·
p_{r→y}. Both correct. ✓

---

### Case 7: Leakage upstream

```
a → b → x → y
     \→ z
```

Query: `from(x).to(y)`, anchor = a.

**G_up** = {a→b, b→x}. Note: a→b→z is NOT in G_up (z is not on a
path to x).

**G_sub** = {x→y}

**Upstream cover**: W(a→b) * W(b→x), or C[a | a→x].

The edge b→z creates leakage at b: not everyone who reaches b
continues to x. This is already encoded in W(b→x): its `p_{b→x}` is
the probability of converting from b to x (given arrival at b), which
is less than 1 if b→z absorbs some mass.

Wait — `p_{b→x}` is the **edge conversion probability** for the b→x
edge, not `1 - p_{b→z}`. These are independent: p_{b→x} measures the
fraction of b-arrivals that reach x via the b→x edge. In a graph where
b has two outgoing edges (b→x and b→z), the probabilities should sum
to ≤ 1 (Dirichlet constraint), but each is independently estimated.

**(L) Latency**: The upstream operator f_{a→x} = W(a→b).f * W(b→x).f.
The temporal shape is the convolution of the a→b and b→x latencies.
The z branch does not affect latency — it only affects mass. ✓

**(M) Mass**: F_{a→x}(∞) = p_{a→b} · p_{b→x}. Since p_{b→x} < 1
(some b-arrivals go to z), X_x(∞) = a_pop · p_{a→b} · p_{b→x} <
a_pop · p_{a→b}. Leakage is correctly accounted for inside the edge
probabilities. No special planner logic needed. ✓

---

### Case 8: Leakage subject

```
a → x → b → y
      \→ c → sink
```

Query: `from(x).to(y)`, anchor = a.

**G_up** = {a→x} (or empty if x = a)
**G_sub** = {x→b, b→y}. Note: x→c→sink is NOT in G_sub (sink is not
on a path to y).

**Subject cover**: W(x→b) * W(b→y), or just W(x→y) if direct edge
exists.

The edge x→c creates leakage at x: not everyone at x goes toward y.
This is encoded in W(x→b): `p_{x→b}` is the fraction of x-arrivals
that go to b (vs c).

**(L) Latency**: Subject operator f_{x→y} = W(x→b).f * W(b→y).f.
Temporal shape is the x→b and b→y latency convolution. The c branch
doesn't affect latency for the x→y path. ✓

**(M) Mass**: K_{x→y}(∞) = p_{x→b} · p_{b→y}. Since p_{x→b} < 1
(some x-arrivals go to c), K < 1. This is the correct conditional
probability of reaching y given arrival at x, accounting for leakage
to c. ✓

---

### Case 9: Both regimes branched with leakage

```
a → b → x → p → y
 \→ c →/     \→ q → sink
b → z → sink
```

Query: `from(x).to(y)`, anchor = a.

**G_up** = {a→b, a→c, b→x, c→x} (diamond). Note: b→z→sink excluded
(z not on path to x).

**G_sub** = {x→p, p→y}. Note: x→q→sink excluded (sink not on path
to y).

Edges: a→b, a→c, b→x, c→x, x→p, p→y, p→q, b→z, q→sink, z→sink.
Node p has two outgoing: p→y and p→q.

**G_up** = {a→b, a→c, b→x, c→x}. b→z excluded (z not on path to x).
**G_sub** = {x→p, p→y}. p→q excluded (sink not on path to y).

**Upstream cover**: Two routes (a→b→x, a→c→x). Leakage at b (b→z).
- Route 1: W(a→b) * W(b→x). p_{b→x} absorbs the b→z leakage.
- Route 2: W(a→c) * W(c→x).
- Combined: sum.

Or: C[a | a→x] as single macro-block.

**Subject cover**: W(x→p) * W(p→y). p_{p→y} absorbs the p→q leakage.

**(L) Latency**: Upstream diamond produces the bimodal arrival profile
at x. Subject chain produces the x→p→y progression shape. Convolution
of ΔX_x with F_sub accounts for temporal spread. ✓

**(M) Mass**: X_x(∞) = a_pop · (p_{a→b}·p_{b→x} + p_{a→c}·p_{c→x}).
Note p_{b→x} already accounts for b→z leakage (p_{b→x} + p_{b→z} ≤ 1).
K_{x→y}(∞) = p_{x→p} · p_{p→y}. p_{p→y} already accounts for p→q
leakage (p_{p→y} + p_{p→q} ≤ 1).
Y_y(∞) = X_x(∞) · K_{x→y}(∞). Correct. ✓

---

### Case 10: Misaligned macro-block

Consider case 3's graph:

```
a → b → d → x → y
 \→ c →/
```

Available: C[a | b→y] — a fitted cohort() block anchored at a,
spanning b→y. This block crosses the x boundary: it covers part of
G_up (b→d→x) and part of G_sub (x→y).

**Is C[a | b→y] admissible for either regime?**

- For G_up (a→x): Start node is b, not a. The block starts mid-regime.
  It could cover {b→d, d→x} within G_up, but it also extends past x
  into G_sub. The block **overhangs** the regime boundary.

- For G_sub (x→y): Start node is b, not x. The block starts before
  the regime. It **underhangs** into G_up.

**Design decision**: Reject overhanging/underhanging blocks. A block
must fit entirely within one target regime. Reasons:

1. **Separation of concerns**: the upstream and subject regimes are
   independent DAG-cover problems. A block that spans both couples
   them.

2. **Composition correctness**: if we use C[a | b→y] for G_sub, we
   need x_provider to deliver arrivals at b (not x), but the regime
   boundary is at x. The operator's start node doesn't match the
   regime's start node.

3. **Accounting for the diamond**: G_up includes the a→c→d route.
   C[a | b→y] only covers the b branch. Using it would leave the
   c branch unaccounted for in the upstream regime.

**Rule**: A block is admissible only if its start and end nodes are
both inside the target regime AND all edges it spans are inside the
target regime. Blocks that cross the x boundary are rejected.

**Could we decompose C[a | b→y] into a b→x part and an x→y part?**
Not from a single fitted macro-block — the path-level posterior
describes b→y as a unit. We'd need the Bayes engine to fit sub-paths
separately. This is future work (sub-path fitting).

**Practical consequence**: For today's block inventory, overhanging
blocks don't arise because all macro-blocks are anchor-rooted
(C[a | a→v]). An anchor-rooted block C[a | a→v] where v is inside
G_up is always admissible for G_up (it starts at a, which is the
regime start). It can't overhang into G_sub because it ends at v ≤ x.
An anchor-rooted block C[a | a→v] where v is inside G_sub is only
admissible if a = x (then a is the regime start for G_sub).

So the overhanging case is a theoretical concern for future block
types, not a practical issue for Phase A.

---

### Case 11: Topology match, regime mismatch

Use case 2's graph:

```
a → b → x → y
 \→ c →/
```

Available: W(a→b) with slice `context(channel:paid)`, W(a→c) with bare
aggregate (no context). Both cover edges in G_up.

**Are these composable?** No. The context slice `context(channel:paid)`
selects a subset of cohort members (those who arrived via the paid
channel). The bare aggregate covers all cohort members. Composing them
would mix populations:

- Route 1 (via b): counts only paid-channel arrivals at b
- Route 2 (via c): counts all arrivals at c

The parallel sum at x would add paid-channel-via-b to all-via-c, which
is an incoherent population.

**Admissibility rule**: All blocks in a single plan must have
**compatible metadata**. Specifically:
- Same slice type (all window() or all cohort())
- Same context scope (all bare, or all with the same context predicate)
- Compatible asat/retrieved_at windows

The planner should filter candidate blocks by metadata compatibility
before solving the cover. If no compatible set covers the regime,
fall back to the lowest-common-denominator blocks (typically bare
aggregate window() edges, which are always available).

**(L) Latency**: Not applicable — composition is rejected. ✓

**(M) Mass**: Not applicable — composition is rejected. ✓

---

## 5. Summary Matrix

| Case | Upstream | Subject | Key verification |
|------|----------|---------|-----------------|
| 1a | trivial (x=a) | single edge | Parity with current code |
| 1b | single edge | single edge | Two independent single-block covers |
| 2 | diamond | single edge | Branched upstream: sum at join node |
| 3 | diamond+tail | single edge | Macro-block + seam composition |
| 4 | single edge | diamond | Branched subject: sum at join node |
| 5 | single edge | diamond+tail | Three-stage subject composition |
| 6 | diamond+tail | diamond+tail | Full Cartesian: both regimes complex |
| 7 | with leakage | single edge | Leakage in edge p, no planner logic |
| 8 | single edge | with leakage | Leakage in edge p, no planner logic |
| 9 | diamond+leakage | chain+leakage | Combined leakage from both sides |
| 10 | — | — | Overhanging block: rejected |
| 11 | — | — | Metadata mismatch: rejected |

All cases pass both latency (L) and mass (M) verification.

---

## 6. Observations

1. **The planner is trivially simple for today's block inventory.**
   Anchor-rooted macro-blocks tile the upstream regime naturally.
   The subject regime uses single-edge blocks unless x = a. The
   interesting planning only emerges when sub-path macro-blocks become
   available.

2. **The DP evaluation is the same regardless of block source.** Whether
   a regime is covered by one macro-block or many atomic blocks, the
   composition algebra is identical. The macro-block just skips
   intermediate convolutions.

3. **Leakage requires no special handling.** It's encoded in per-edge
   probabilities and compounds correctly through both serial and
   parallel composition.

4. **The metadata admissibility check is the main non-topological
   filter.** Slice/context/asat compatibility must be checked before
   composition, not after.

5. **Overhanging blocks are a theoretical concern.** For the current
   block inventory they don't arise. If sub-path fitting is added
   later, the planner needs the regime-boundary rejection rule.

6. **Macro-block vs atomic composition is a quality trade-off.** A
   macro-block (e.g. C[a | a→x]) is fitted to observed data so its
   p (mass) is more accurate, but its temporal shape is constrained
   to a single shifted-lognormal (may lose bimodality from branching).
   Atomic composition captures the true shape (via numerical
   convolution) but each edge's p comes from a separate fit (more
   estimation noise). When a high-quality macro-block is available,
   prefer it for mass accuracy. When temporal shape matters (branching
   with very different latencies), the atomic composition may be more
   faithful.

---

## 7. Critique of the Simplified Framing

Sections 1-6 are useful for defining the clean operator algebra, but
they are still somewhat idealised. Three caveats matter in practice.

### 7.1 "Linear" production funnels are usually leaky

Many real graphs look visually linear along a main spine, but still lose
mass at every stage:

```text
a -> b -> c -> d -> e
a -> f
b -> g
c -> h
d -> i
```

This is not a special edge case. It is the normal case. Even when there
is only one visible success spine, the upstream regime `a->x` and the
subject regime `x->y` both inherit leakage through side exits. Any cover
algorithm that only stress-tests clean chains and diamonds will miss the
main operational difficulty.

### 7.2 The live block inventory is uneven

Today we effectively have:

- universal atomic `window()` edge operators (`W(u->v)`)
- anchor-rooted cohort-mode fitted objects attached to edges

Those cohort-mode fitted objects are very useful "duplo" blocks for
success mass, because the Bayes pipeline does run a second pass on
`cohort()` observations and runtime consumers prefer the cohort fields
(`cohort_alpha/cohort_beta`) over the window ones in cohort mode.

However, the current block inventory is not yet the clean abstract
library assumed earlier in this note:

- arbitrary sub-path macro-blocks (for example a fitted reusable
  `C[b | b->d]`) do **not** exist today
- probability/mass and latency are not guaranteed to have identical
  provenance at the block level
- for full maturity over tau, the hard problem remains the denominator
  engine, not the existence of the cover planner itself

So sections 1-6 should be read as the target operator algebra, not as a
claim that every ideal operator already exists in the live Bayes output.

### 7.3 Packing still helps

Even with those caveats, the planner framing remains useful:

- cover the encapsulated upstream DAG `a->x`
- cover the encapsulated subject DAG `x->y`
- prefer the largest compatible cohort-fitted blocks where available
- fill gaps with atomic `window()` edges

Leakage is still handled inside the statistical operators themselves
(`F(infinity) < 1`), not by separate planner logic.

---

## 8. More Realistic Leaky Funnel Stress Cases

The cases below are deliberately closer to real funnels than the clean
chain/diamond motifs above. They are meant to stress the cover planner,
not just the convolution algebra.

### Case 12: Leaky spine, simple subject

```text
a -> b -> c -> d -> e
a -> f
b -> g
c -> h
d -> i
```

Query: `from(d).to(e)`, anchor = `a`

**Upstream regime**: `a->d`
**Subject regime**: `d->e`

This looks "linear", but denominator mass at `d` is not trivial:

```text
reach(a->d) = p_{a->b} * p_{b->c} * p_{c->d}
```

with each edge probability already absorbing leakage through the side
exit at that node.

**Planner stress**:

- if an aligned anchor-rooted cohort block to `d` exists and is trusted,
  prefer it as one upstream "duplo" block
- otherwise compose the upstream from `W(a->b) * W(b->c) * W(c->d)`
- subject remains a simple `W(d->e)` edge block unless a reusable
  subject macro-block exists

**(L) Latency**: Three serial convolutions for atomic upstream. Each
edge's density convolved in sequence. Temporal shape captures full
a→d travel time. ✓

**(M) Mass**: F_{a→d}(∞) = p_{a→b} · p_{b→c} · p_{c→d}. Leakage at
f, g, h absorbed in respective p values. ✓

**Why this case matters**: it shows that "linear" does not mean
"non-compositional". Leakage compounds through every stage even without
an explicit branch that rejoins.

### Case 13: Same leaky spine, lower anchor

```text
a -> b -> c -> d -> e
a -> f
b -> g
c -> h
d -> i
```

Query: `from(d).to(e)`, anchor = `c`

Now the relevant upstream regime is `c->d`, not `a->d`.

**Planner stress**:

- a top-rooted block `C[a | a->d]` is no longer the right building block
  for the denominator, even though it contains the target regime
- the preferred block is an aligned local-anchor block `C[c | c->d]` if
  available
- otherwise fall back to `W(c->d)`

**(L) Latency**: Single edge W(c→d). No composition. ✓

**(M) Mass**: F_{c→d}(∞) = p_{c→d}. X_d = c_pop · p_{c→d}. ✓

**Why this case matters**: it makes explicit that cohort blocks are
local macro-operators. They are not universal top-of-graph primitives.

### Case 14: Leaky upstream diamond into x

```text
a -> b -> c -> x -> y
 \-> m -> n -/
b -> g
c -> h
n -> o
```

Query: `from(x).to(y)`, anchor = `a`

**Upstream regime**: all paths from `a` to `x`
**Subject regime**: `x->y`

**Planner stress**:

- the upstream cover must include both routes to `x`
- leakage at `b`, `c`, and `n` is handled inside route probabilities
- if a trusted anchor-rooted cohort block to `x` exists, prefer it
- otherwise compose both routes explicitly and sum at `x`

**(L) Latency**: Two multi-hop routes to x, each a 3-hop serial
convolution. Sum at x captures combined (possibly bimodal) arrival
profile. ✓

**(M) Mass**: F_{a→x}(∞) = p_{a→b}·p_{b→c}·p_{c→x} +
p_{a→m}·p_{m→n}·p_{n→x}. Leakage at g, h, o absorbed. ✓

**Why this case matters**: it is the realistic denominator analogue of
the clean diamond. It forces the planner to handle both branching and
attrition on each branch.

### Case 15: Leaky subject diamond

```text
a -> x -> b -> d -> y
      \-> c -/
b -> g
c -> h
d -> i
```

Query: `from(x).to(y)`, anchor = `a`

**Upstream regime**: `a->x`
**Subject regime**: all paths from `x` to `y`

**Planner stress**:

- the subject kernel must include both routes through `b` and `c`
- leakage at `b`, `c`, and `d` stays inside the subject operator
- if no aligned subject macro-block exists, the planner must still be
  able to build the subject operator from atomic `window()` edges

**(L) Latency**: Diamond subject resolved by DP (two routes to d,
sum, then serial with d→y). Leakage doesn't affect temporal shape. ✓

**(M) Mass**: K_{x→y}(∞) = (p_{x→b}·p_{b→d} + p_{x→c}·p_{c→d}) ·
p_{d→y}. Leakage at g, h, i absorbed. ✓

**Why this case matters**: it exercises the full branched subject DAG in
the presence of ordinary funnel leakage, not just clean parallel paths.

### Case 16: Leaky on both sides

```text
a -> b -> d -> x -> p -> r -> y
 \-> c ->/      \-> q ->/
b -> z
p -> s
q -> t
```

Query: `from(x).to(y)`, anchor = `a`

**Upstream regime**: diamond+tail with leakage before `x`
**Subject regime**: diamond+tail with leakage before `y`

This is the realistic "both regimes are non-trivial" case.

**Planner stress**:

- upstream and subject are independent DAG-cover problems
- each may choose a different mix of cohort "duplo" blocks and window
  "lego" blocks
- serial/parallel composition must still produce a coherent
  denominator operator `F_up` and subject operator `F_sub`

**(L) Latency**: Each regime resolves its diamond+tail independently
via DP. Convolution of ΔX_x with F_sub accounts for temporal spread. ✓

**(M) Mass**: X_x(∞) = a_pop · (p_{a→b}·p_{b→d} + p_{a→c}·p_{c→d})
· p_{d→x}. K_{x→y}(∞) = (p_{x→p}·p_{p→r} + p_{x→q}·p_{q→r}) ·
p_{r→y}. Leakage at z, s, t absorbed. ✓

**Why this case matters**: it is the smallest case where the cover
planner, the operator algebra, and the boundary between upstream and
subject regimes are all simultaneously exercised.

---

## 9. Asymmetry Between Subject and Upstream

The realistic leaky-funnel cases make one thing explicit: the subject
side and the upstream side are **not the same problem**.

### Subject side: true operator-cover problem

`x→y` is the real cover problem. The planner must tile the full
subject DAG with operators and compose them. This is the core of
Phase A and is fully specified by §§1–6 above.

### Upstream side: select a latency carrier, then choose a mass policy

`a→x` is only a full cover problem if we choose an evidence-driven
denominator. In practice it decomposes into two thinner sub-problems.

#### 9.1 Upstream latency carrier

The upstream latency question is: "what is the temporal shape of
arrivals at x from the a-cohort?" This determines how ΔX_x(s, u) is
distributed over tau.

Resolution order:

1. **x = a**: no upstream latency at all. X_x = a_pop for all τ.
   ΔX_x is a delta at τ=0. This is the common case.

2. **x ≠ a, aligned cohort-mode blocks on edges entering x**: the
   cohort() slices on edges into x already carry the a→x path latency
   (they were fitted with anchor = a). Use these as the latency
   carrier directly. If x has fan-in (multiple incoming edges), form
   a p-weighted mixture of their path-level CDFs — this is exactly
   what the current code does (`upstream_path_cdf_arr` in
   `cohort_forecast.py` lines 765–780).

3. **Ingress blocks missing/incompatible**: only then recurse further
   upstream and convolve edge-by-edge. This is the full DAG-cover
   problem for upstream, but it should be the fallback, not the
   default.

So upstream latency is usually a **much thinner problem** than subject
cover. It requires a full DAG-cover only when the seam blocks into x
are unavailable.

#### 9.2 Upstream mass policy

The upstream mass question is: "how much mass has arrived at x by
age τ?" This determines the scale of X_x(s, τ).

Two policies, with a clear resolution order:

**Policy A: reach × F_{a→x}(τ)** (current approximation)

```
X_x(s, τ) = a_pop(s) · reach(a→x) · F_{a→x}(τ)
```

Where `reach(a→x)` is the scalar path probability (from
`calculate_path_probability`) and `F_{a→x}(τ)` is the upstream
latency carrier from §9.1. This is what the current code does:
`reach_at_from_node` for the scalar, `upstream_path_cdf_arr` for
the temporal shape.

Note: reach alone is only a scalar — it gives the asymptotic
X_x(∞) = a_pop · reach. The latency carrier provides the temporal
shape. Together they produce the full X_x(s, τ) curve.

Benefits:
- Already implemented in spirit
- Cheap
- Latency carrier is usually available from ingress blocks (§9.1)

Cost:
- Compresses the upstream DAG into one reach scalar + one CDF
- Loses branch-local frontier evidence
- Reach is a static graph property; it doesn't adapt to observed
  upstream conversion rates

**Policy B: evidence-driven upstream propagation**

Reconstruct observed arrivals at x from upstream snapshot evidence:
- Walk upstream edges, use cohort() k(τ) / x(τ) values at each stage
- Sum at joins
- Propagate forward to x

This is where upstream becomes a genuine recursive cover problem
(the same planner from §3, applied to G_up). More exact, but more
plumbing and higher dependence on snapshot coverage.

Benefits:
- Respects actual observed upstream history
- Handles leakage naturally (from evidence, not from modelled p)
- Gives a denominator trajectory anchored in data

Cost:
- More plumbing and recursive logic
- Requires snapshot coverage across the upstream regime
- Only adds value beyond the frontier (observed region uses real X
  from evidence frames regardless of which option is chosen)

### 9.3 The clean framing

```
Subject side:  true operator-cover problem (§§1–6)
Upstream side: select an a→x latency carrier (§9.1)
               then choose a mass policy (§9.2–9.3)
```

This is roughly what the current code already does:
`reach_at_from_node` for mass, incoming-edge CDF mixture for timing.

### 9.4 Resolution order

**Policy B is preferable where k(τ) evidence exists across the fully
recursed upstream sub-graph.** Where it does not, fall back to
Policy A.

Concrete resolution:

1. **x = a**: no upstream problem. X_x = a_pop(s). Done.

2. **x ≠ a, full upstream evidence available** (k(τ) observed at
   every edge in G_up for the relevant cohort window): use Policy B.
   Reconstruct X_x(τ) from upstream snapshot evidence recursively.

3. **x ≠ a, partial or missing upstream evidence**: use Policy A.
   X_x(s, τ) = a_pop(s) · reach(a→x) · F_{a→x}(τ).

**Phase A recommendation**: use Policy A for all x ≠ a cases. This
matches the current code, enables adjacent-pair parity, and is already
implemented. Policy B is later work — it requires recursive upstream
snapshot propagation and evidence-completeness checking, neither of
which exists today.

### 9.5 Separation of concerns

The planner stays agnostic and simply requires an upstream operator /
denominator provider:

- the planner chooses *which* operators cover `x→y` (subject)
- the upstream provider determines *how* `X_x(τ)` is produced
- the row builder consumes both and applies the convolution + frontier
  conditioning (see §3.6)

This keeps the planning problem and the denominator-engine problem
separate. The separation survives the Policy A → Policy B transition:
only the upstream provider implementation changes.
