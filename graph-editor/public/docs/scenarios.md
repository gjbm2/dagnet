# Scenarios

Scenarios let you explore “what if we changed these parameters?” without losing your baseline graph. They are **parameter overlays** that sit on top of your Base and Current values and can be turned on/off, reordered, edited in YAML, and flattened back into the working graph.

This document explains **how scenarios work in DagNet as implemented today** – including the layers, the Scenarios panel, the YAML formats, and how composition/flatten behave.

---

## 1. Layers: Base, Current, Scenarios

Every graph session has three kinds of parameter layers:

- **Base** ("Original")  
  - Baseline parameters captured when you opened the graph (or after a Flatten).  
  - Used as the reference for diff snapshots.

- **Current**  
  - The live working state you see in the graph (including any What‑If effects).  
  - When you adjust probabilities/costs in the UI, you are editing Current.

- **Scenarios**  
  - Named overlays that store **only parameter overrides**.  
  - Each scenario can change one or many parameters.  
  - Multiple scenarios can be visible at once and are composed on top of Base.

### Composition order

When DagNet computes the value for a parameter (e.g. an edge probability), it composes layers in this order:

1. Start from **Base** parameters  
2. Apply each **visible scenario overlay** in stack order (earlier rows lower in the stack; later rows higher)  
3. Apply **Current** on top

If multiple overlays touch the same parameter, **the last overlay in the stack wins**.

---

## 2. Scenarios Panel (UI)

Open the **Scenarios** tab in the right‑hand sidebar (What‑If panel). You’ll see:

- A row for **Base**
- A row for **Current**
- One row per **user scenario**

Each row has:

- **Eye icon** – show/hide that layer in the composition
- **Color chip** – the color used for that scenario in the graph
- **Name** – editable scenario name (timestamp by default)
- **Context menu** (right‑click) with actions:
  - **Show / Hide** – toggle visibility
  - **Show only** – hide all other scenarios and show just this one
  - **Edit** – open YAML/JSON editor for this layer (Base, Current, or a scenario)
  - **Use as current** – copy this layer’s composed values into Current
  - **Delete** – remove a user scenario (not available for Base or Current)

At the top‑right of the panel you’ll see:

- **+ New…** menu
  - **Snapshot everything** – create a full snapshot of the current composed values  
    *(Full snapshot: type = `all`)*
  - **Snapshot differences** – create a diff snapshot (only parameters that differ from the baseline)  
    *(Diff snapshot: type = `differences`)*
  - **New blank scenario** – create an empty overlay you can edit manually in YAML.
- **Flatten** button  
  - Copies the **composed Current** parameters into **Base**  
  - Deletes all scenarios for this graph  
  - Leaves Current visible  
  - Can be undone via normal graph history (Ctrl+Z)

> **Baseline for diffs**  
> Today, diff snapshots compare against the **composed visible state (Base + visible overlays)** rather than raw Base only. This means “Snapshot differences” captures what changed relative to what you’re currently looking at.

---

## 3. Creating Scenarios

### 3.1 Snapshot everything (full snapshot)

Captures a **full copy** of the current composed parameters:

- All edge probabilities, conditional probabilities, costs, and case weights
- Stored as `meta.source = "all"`, `meta.sourceDetail = "visible"`

Use this when you want a **complete baseline** (e.g. “Q4 2024 Actuals”).

### 3.2 Snapshot differences (diff snapshot)

Captures only parameters whose values **differ from the baseline**:

- Stores a sparse overlay (only changed keys)
- Stored as `meta.source = "differences"`, `meta.sourceDetail = "visible"`

Use this when you want to capture **just the deltas** from what you’re currently seeing (e.g. “Optimistic conversion +20%”, “Higher support cost”).

### 3.3 New blank scenario

Creates an empty scenario overlay:

- Starts with `{ edges: {}, nodes: {} }`
- Scenario opens in the YAML/JSON editor immediately
- You can then paste or hand‑write HRN keys for parameters you want to override

---

## 4. Editing Scenarios in YAML / JSON

When you choose **Edit** on Base, Current, or a scenario row, you get the **Scenario Editor** modal:

- **Syntax** toggle: **YAML** (default) or **JSON**
- **Structure** toggle: **Flat** (default) or **Nested**
- **Metadata panel**: shows creation time, source, optional note
- **Note field**: free‑text note you can edit
- Buttons: **Apply**, **Cancel**, **Export CSV**

### 4.1 Flat format (explicit HRN keys)

Flat format is the default and easiest to scan. Each line is a single **HRN path → value** pair.

**Examples (taken from the Scenarios Manager spec):**

```yaml
# Edge base probability
"e.checkout-to-purchase.p.mean": 0.42
"e.checkout-to-purchase.p.stdev": 0.05

# Edge cost
"e.checkout-to-purchase.cost_gbp.mean": 1.5

# Conditional probability
"e.from(checkout).to(purchase).visited(promo).p.mean": 0.30

# Case variant weights
"n.checkout_case.case(checkout_case:treatment).weight": 1.0
"n.checkout_case.case(checkout_case:control).weight": 0.0
```

Notes:

- Keys start with **`e.`** for **edges** and **`n.`** for **nodes**
- Edge selectors can be **simple IDs** (`checkout-to-purchase`) or **query‑style selectors** (`from(checkout).to(purchase).visited(promo)`)
- Node selectors are usually **node IDs** (`checkout_case`)
- Case variants use `case(<caseId>:<variantName>).weight`

You will normally see **quoted keys** in the editor (as above) because some keys contain parentheses and dots.

### 4.2 Nested format (implicit YAML)

Nested structure groups related keys to reduce repetition. The semantics are identical to flat format.

Using the same example as above, nested YAML looks like:

```yaml
e:
  checkout-to-purchase:
    p:
      mean: 0.42
      stdev: 0.05
    cost_gbp:
      mean: 1.5
  from(checkout).to(purchase).visited(promo):
    p:
      mean: 0.30
n:
  checkout_case:
    case(checkout_case:treatment):
      weight: 1.0
    case(checkout_case:control):
      weight: 0.0
```

You can switch between **Flat** and **Nested** at any time; DagNet converts between them without losing information.

### 4.3 Typical edits

- **Change an edge probability**
  - Flat:  `"e.checkout-to-purchase.p.mean": 0.55`
- **Change a conditional probability**
  - Flat:  `"e.from(checkout).to(purchase).visited(promo).p.mean": 0.30`
- **Change a case variant weight**
  - Flat:  `"n.checkout_case.case(checkout_case:treatment).weight": 1.0`
- **Remove an override**
  - Set the value to `null` (e.g. `"e.checkout-to-purchase.p.mean": null`) and Apply

DagNet validates edits before applying. You’ll see errors/warnings inline if keys don’t match known edges/nodes or the value types are wrong.

---

## 5. Referencing Nodes and Edges

In HRN paths you always reference **node and edge IDs**, not UUIDs.

- Edge ID examples: `checkout-to-purchase`, `cart-to-checkout`  
- Node ID examples: `homepage`, `checkout_case`

IDs:

- Are set in the **Properties Panel** when a node or edge is selected
- Must be unique within the graph
- Are shown in tooltips and in the Properties Panel

Use those IDs inside HRN selectors:

- Simple edge: `e.checkout-to-purchase.p.mean`
- Query‑style edge: `e.from(checkout).to(purchase).visited(promo).p.mean`
- Case node: `n.checkout_case.case(checkout_case:treatment).weight`

You never need to see or type UUIDs – the app handles UUID↔ID mapping internally.

---

## 6. Scenario Composition & "Use as current"

### 6.1 Composition

Recall the composition order:

1. Base  
2. Visible scenarios (in stack order)  
3. Current

When you toggle a scenario’s eye icon:

- **On** – its params participate in composition (can override Base and lower scenarios)
- **Off** – its params are ignored, but the scenario definition remains

When multiple overlays set the same HRN key, the **last visible scenario in the stack wins**, then Current on top.

### 6.2 "Use as current"

Right‑click a row and choose **Use as current**:

- For **Base**: copies Base params into Current
- For a **scenario**: composes all visible layers **up to and including that scenario**, then sets Current to that result
- Clears any What‑If DSL state on the tab
- Ensures Current is visible

This is useful when you want to “promote” a composed scenario stack into your working state and continue editing from there.

### 6.3 Flatten

The **Flatten** button (panel footer) applies the spec behavior:

- Sets **Base := Current** for this graph session
- Deletes all user scenarios for this graph
- Leaves Current visible
- Does **not** commit anything to Git – this is editor‑local and reversible via Undo

Flatten is a good way to **lock in** a scenario you like as the new baseline before exploring further variations.

---

## 7. Scenario Workflow Examples

### Example 1: Baseline vs Optimistic vs Pessimistic

1. Tune your graph until Current reflects your best baseline.  
2. In Scenarios panel, **Snapshot everything** → rename to `Q4 Baseline`.  
3. Make optimistic edits (higher conversions, lower costs) and snapshot differences → `Optimistic`.  
4. Make pessimistic edits and snapshot differences → `Pessimistic`.  
5. Toggle visibility to compare `Q4 Baseline`, `Optimistic`, `Pessimistic` side‑by‑side.

### Example 2: Case experiment variants

1. Build a **case node** with variants `treatment` and `control`.  
2. Run an experiment and pull actual weights via data connections (Base/Current).  
3. Create scenarios that override only the case weights:

   ```yaml
   "n.checkout_case.case(checkout_case:treatment).weight": 1.0
   "n.checkout_case.case(checkout_case:control).weight": 0.0
   ```

4. Compare paths and outcomes when each variant is “forced on”.

---

## 8. Tips & Gotchas

- **Keep scenarios small** – prefer diff snapshots over full snapshots once you have a solid baseline.  
- **Name scenarios clearly** – include date, window, and intent (e.g. `2025-01 window – Mobile uplift`).  
- **Don’t hand‑edit Base lightly** – instead, snapshot and edit scenarios; use Flatten only when you’re sure.  
- **Validate before Apply** – the editor runs validation, but read warnings; unresolved HRNs mean the key didn’t match any current node/edge.

For more detail on the underlying HRN grammar and scenario semantics, see `SCENARIOS_MANAGER_SPEC.md` in the docs.
