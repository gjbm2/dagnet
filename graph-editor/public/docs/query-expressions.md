# DagNet DSL: Parameter Addressing Guide

**Version:** 2.1  
**Last Updated:** December 2025

---

## Overview

DagNet uses a simple DSL (Domain-Specific Language) to refer to parameters on your graph. This guide shows you how to read and write parameter references in:

- **Scenario overlays** (YAML/JSON)
- **Google Sheets** parameter tables
- **Parameter files**
- **Cohort windows** for time-based analysis

---

## Quick Start Examples

### Setting a probability
```
e.checkout-to-purchase.p.mean: 0.45
```
*"Set the mean probability on edge `checkout-to-purchase` to 0.45"*

### Setting a conditional probability
```
e.checkout-to-purchase.visited(promo).p.mean: 0.72
```
*"Set probability to 0.72 when users have visited the promo page"*

### Setting a case variant weight
```
n.promo-gate.case(promo-experiment:treatment).weight: 0.6
```
*"Set the treatment variant weight to 60% on the promo-gate case node"*

### Setting a cohort window (New in 1.0)
```
cohort(1-Dec-25:7-Dec-25)
```
*"Analyse users who entered the funnel between 1st and 7th December 2025"*

---

## Basic Syntax

All parameter references follow this pattern:

```
<entity-type>.<entity-identifier>.<parameter-path>
```

### Entity Types

- `e.` — Edges (transitions between nodes)
- `n.` — Nodes (states, gates, decision points)

### Examples

```
e.cart-to-checkout.p.mean          # Edge probability
e.cart-to-checkout.cost_gbp.mean   # Edge cost in GBP
n.homepage.entry.weight            # Node entry weight
```

---

## Referring to Edges

You can refer to an edge in two ways:

### 1. By Edge ID (Direct)
```
e.checkout-to-purchase.p.mean
```

### 2. By Endpoints (Topology)
```
e.from(checkout).to(purchase).p.mean
```

Both are equivalent. Use whichever is clearer for you. The second form is helpful when:
- You don't know the edge ID
- You want to be explicit about what connects to what
- The edge was auto-generated and has a long ID

---

## Edge Parameters

### Probability Parameters

**Base probability** (applies when no conditions match):
```
e.edge-id.p.mean: 0.5
e.edge-id.p.stdev: 0.05
```

**Conditional probability** (applies when condition is met):
```
e.edge-id.visited(node-id).p.mean: 0.7
e.edge-id.visited(node-id).p.stdev: 0.03
```

The condition sits directly between the edge ID and `.p.` — this is how you specify WHICH probability parameter on that edge.

**Multiple conditions:**
```
e.edge-id.visited(promo).exclude(blog).p.mean: 0.65
```

**Common conditions:**
- `visited(node-id)` — user has visited this node
- `exclude(node-id)` — user has NOT visited this node
- `context(key:value)` — matches context (e.g., `context(device:mobile)`)
- `case(experiment:variant)` — applies to specific A/B test variant

### Cost Parameters

**Monetary cost:**
```
e.checkout-to-purchase.cost_gbp.mean: 12.50
```

**Time cost:**
```
e.email-to-purchase.labour_cost.mean: 86400  # seconds
```

---

## Node Parameters

### Case Variant Weights

For A/B tests and feature gates:

```
n.promo-gate.case(promo-experiment:control).weight: 0.5
n.promo-gate.case(promo-experiment:treatment).weight: 0.5
```

Format: `n.<node-id>.case(<case-id>:<variant-name>).weight`

### Entry Weights

```
n.homepage.entry.weight: 1000
```

---

## Format Options

### YAML (Flat)

Most explicit - every line has the full path:

```yaml
e.checkout-to-purchase.p.mean: 0.45
e.checkout-to-purchase.p.stdev: 0.03
e.checkout-to-purchase.visited(promo).p.mean: 0.72
e.product-to-cart.p.mean: 0.28
```

**Best for:**
- Google Sheets (one parameter per row)
- Quick edits
- Copy-pasting individual parameters

### YAML (Nested)

Groups by entity to reduce repetition:

```yaml
e:
  checkout-to-purchase:
    p:
      mean: 0.45
      stdev: 0.03
    visited(promo):
      p:
        mean: 0.72
  product-to-cart:
    p:
      mean: 0.28
```

**Best for:**
- Editing multiple parameters on the same edge
- Scenario files
- Better readability when changing many related values

### JSON (Flat)

```json
{
  "e.checkout-to-purchase.p.mean": 0.45,
  "e.checkout-to-purchase.p.stdev": 0.03,
  "e.checkout-to-purchase.visited(promo).p.mean": 0.72
}
```

**Best for:**
- API integrations
- Programmatic parameter updates

### JSON (Nested)

```json
{
  "e": {
    "checkout-to-purchase": {
      "p": {
        "mean": 0.45,
        "stdev": 0.03
      },
      "visited(promo)": {
        "p": {
          "mean": 0.72
        }
      }
    }
  }
}
```

---

## Google Sheets Usage

### Basic Parameter Table

```
| A                                 | B        |
|-----------------------------------|----------|
| e.homepage-to-product.p.mean      | 0.35     |
| e.product-to-cart.p.mean          | 0.28     |
| e.cart-to-checkout.p.mean         | 0.78     |
| e.checkout-to-purchase.p.mean     | 0.45     |
| e.checkout-to-purchase.p.stdev    | 0.03     |
```

### Conditional Probabilities

```
| A                                              | B      |
|------------------------------------------------|--------|
| e.checkout-to-purchase.visited(promo).p.mean   | 0.72   |
| e.checkout-to-purchase.visited(promo).p.stdev  | 0.04   |
| e.checkout-to-purchase.visited(blog).p.mean    | 0.58   |
```

### Case Variants

```
| A                                                      | B     |
|--------------------------------------------------------|-------|
| n.promo-gate.case(promo-experiment:control).weight    | 0.5   |
| n.promo-gate.case(promo-experiment:treatment).weight  | 0.5   |
```

### Multiple Scenarios in Columns

```
| A                                 | B (Current) | C (Optimistic) | D (Pessimistic) |
|-----------------------------------|-------------|----------------|-----------------|
| e.checkout-to-purchase.p.mean     | 0.45        | 0.55           | 0.35            |
| e.checkout-to-purchase.p.stdev    | 0.03        | 0.02           | 0.05            |
```

---

## Common Patterns

### Pattern 1: Base vs Conditional Probabilities

```yaml
# Base probability (fallback when no conditions match)
e.checkout-to-purchase.p.mean: 0.45

# Higher probability when user visited promo page
e.checkout-to-purchase.visited(promo).p.mean: 0.72

# Lower probability when user came from email
e.checkout-to-purchase.visited(email).p.mean: 0.38
```

### Pattern 2: Using Endpoint References

Instead of:
```yaml
e.checkout-to-purchase.p.mean: 0.45
```

You can write:
```yaml
e.from(checkout).to(purchase).p.mean: 0.45
```

Both are equivalent. Use whichever is clearer.

### Pattern 3: Multiple Parameters on Same Edge

**Flat format:**
```yaml
e.checkout-to-purchase.p.mean: 0.45
e.checkout-to-purchase.p.stdev: 0.03
e.checkout-to-purchase.cost_gbp.mean: 15.00
```

**Nested format (less repetition):**
```yaml
e:
  checkout-to-purchase:
    p:
      mean: 0.45
      stdev: 0.03
    cost_gbp:
      mean: 15.00
```

### Pattern 4: A/B Test Variants

```yaml
n.promo-gate.case(promo-experiment:control).weight: 0.5
n.promo-gate.case(promo-experiment:treatment).weight: 0.5
```

To shift traffic to treatment:
```yaml
n.promo-gate.case(promo-experiment:control).weight: 0.2
n.promo-gate.case(promo-experiment:treatment).weight: 0.8
```

---

## Condition Syntax Reference

Conditions can be combined to create specific targeting:

### Single Conditions

```
visited(node-id)           # User visited this node
exclude(node-id)           # User did NOT visit this node
context(key:value)         # Matches context variable
case(experiment:variant)   # In this experiment variant
```

### Combined Conditions

```
visited(promo).exclude(blog)                    # Visited promo but not blog
visited(a).visited(b)                           # Visited both a and b
context(device:mobile).case(test:treatment)     # Mobile users in treatment
```

---

## Complete Example: E-commerce Funnel

```yaml
# Base conversion probabilities
e.homepage-to-product.p.mean: 0.35
e.product-to-cart.p.mean: 0.28
e.cart-to-checkout.p.mean: 0.78
e.checkout-to-purchase.p.mean: 0.45

# Conditional probabilities (promo campaign)
e.checkout-to-purchase.visited(promo-landing).p.mean: 0.62

# Costs
e.checkout-to-purchase.cost_gbp.mean: 15.00
e.checkout-to-purchase.labour_cost.mean: 300

# A/B test on checkout flow
n.checkout-gate.case(checkout-redesign:control).weight: 0.5
n.checkout-gate.case(checkout-redesign:simplified).weight: 0.5
```

---

## Cohort Windows (New in 1.0)

Cohort windows let you analyse data for users who entered the funnel during a specific date range.

### Basic Syntax

```
cohort(start-date:end-date)
```

Dates use the `d-MMM-yy` format (e.g., `1-Dec-25`, `15-Jan-26`).

### Examples

**Last week's cohort:**
```
cohort(2-Dec-25:8-Dec-25)
```
*Analyses users who entered between 2nd and 8th December 2025*

**Single day:**
```
cohort(5-Dec-25:5-Dec-25)
```
*Analyses users who entered on 5th December only*

### Combining with Other DSL Elements

**Cohort + Context:**
```
cohort(1-Dec-25:7-Dec-25).context(channel:organic)
```
*Organic users who entered during the first week of December*

**In Edge Queries:**
```
from(homepage).to(checkout).cohort(1-Dec-25:7-Dec-25)
```
*Homepage→Checkout conversion for December cohort*

### How Cohort Aggregation Works

When you set a cohort window:
1. Daily n/k data is retrieved for each day in the window
2. Values are summed: total n = Σ(daily n), total k = Σ(daily k)
3. Mean probability is recalculated: p = k ÷ n
4. Evidence fields are populated with the window dates

### Evidence Fields

After cohort aggregation, edges contain:
- `p.evidence.n` — Total users in cohort
- `p.evidence.k` — Users who converted
- `p.evidence.window_from` — Cohort start date
- `p.evidence.window_to` — Cohort end date
- `p.evidence.retrieved_at` — When data was fetched

### Tips

- **Exclude very recent dates**: Users need time to convert; include a buffer
- **Use consistent window sizes**: Makes comparison between periods meaningful
- **Check n values**: Smaller cohorts have higher variance in probability estimates

---

## Historical Queries (as-at snapshots)

DagNet supports **historical query mode** via the `asat(...)` clause, which retrieves data from the snapshot database **as it was known at a past date**.

### Syntax

- **Canonical**: `asat(d-MMM-yy)`
- **Alias (sugar)**: `at(d-MMM-yy)` (normalised to `asat(...)`)
- **Order-indifferent**: `asat(...)` may appear anywhere in the query chain.

### Examples

**Basic historical query:**

```
from(homepage).to(checkout).asat(5-Nov-25)
```

**With a window:**

```
from(homepage).to(checkout).window(1-Oct-25:31-Oct-25).asat(15-Oct-25)
```

**Order-indifferent placement:**

```
from(homepage).asat(15-Oct-25).to(checkout).window(1-Oct-25:31-Oct-25)
```

### Behaviour

- **Read-only**: `asat(...)` queries do not write to files, IndexedDB, or the snapshot DB.
- **Signature integrity**: historical reads are keyed by the query signature; if the query definition has changed since snapshots were stored, DagNet will not return mismatched data. Use the **Snapshot Manager** to create equivalence links between old and new signatures if you need historical continuity after a query change.

### From the Snapshot Manager

The Snapshot Manager's **"View graph at DATE"** button combines historical file viewing with `asat()`:
1. Opens the graph file as it was at the git commit closest to the selected signature's creation date
2. Automatically injects `asat(DATE)` into the graph's DSL query
3. This lets you see the historical graph structure with the data as it was known at that time

---

## Validation & Errors

### Valid References

✅ `e.checkout-to-purchase.p.mean`  
✅ `e.from(cart).to(checkout).p.mean`  
✅ `e.edge-id.visited(promo).p.mean`  
✅ `n.case-node.case(exp:control).weight`  
✅ `cohort(1-Dec-25:7-Dec-25)`

### Common Mistakes

❌ `e.edge-id.conditional_p.visited(promo).mean`  
→ Use: `e.edge-id.visited(promo).p.mean`

❌ `edge-id.p.mean` (missing `e.` prefix)  
→ Use: `e.edge-id.p.mean`

❌ `e.edge-id.probability.mean` (wrong parameter name)  
→ Use: `e.edge-id.p.mean`

### What Happens When...

**You reference a non-existent edge?**
- In scenarios: Warning displayed, parameter ignored
- In Sheets: Logged as skipped, other parameters still applied

**You reference a non-existent condition?**
- Parameter is stored but won't match at runtime
- No error (allows forward references)

**You mix different edges in one Sheets range?**
- Only parameters matching the target edge are applied
- Others are logged as out-of-scope

---

## Advanced: Nested Structures

When using nested YAML/JSON, the structure maps directly to the flat format:

### Nested YAML
```yaml
e:
  checkout-to-purchase:
    p:
      mean: 0.45
      stdev: 0.03
    visited(promo):
      p:
        mean: 0.72
        stdev: 0.05
```

### Equivalent Flat YAML
```yaml
e.checkout-to-purchase.p.mean: 0.45
e.checkout-to-purchase.p.stdev: 0.03
e.checkout-to-purchase.visited(promo).p.mean: 0.72
e.checkout-to-purchase.visited(promo).p.stdev: 0.05
```

Both produce the same result. Use nested for better readability when editing many parameters; use flat for Google Sheets and quick edits.

---

## Tips & Best Practices

### 1. Use Descriptive IDs

**Good:**
```
e.product-detail-to-add-to-cart.p.mean
```

**Less clear:**
```
e.pdp-atc.p.mean
```

### 2. Copy from Scenarios Modal

The easiest way to get the correct syntax:
1. Open a scenario in DagNet
2. View as YAML (flat format)
3. Copy the parameter reference
4. Paste into your Sheet or file

### 3. Start with Flat Format

Until you're comfortable with the syntax, use flat format:
- Less indentation to worry about
- Easier to copy individual lines
- Works great in Google Sheets

### 4. Group Related Parameters

When editing many parameters on the same edge, switch to nested format:

```yaml
e:
  checkout-to-purchase:
    p:
      mean: 0.45
      stdev: 0.03
      n: 1000
      k: 450
```

Instead of:
```yaml
e.checkout-to-purchase.p.mean: 0.45
e.checkout-to-purchase.p.stdev: 0.03
e.checkout-to-purchase.p.n: 1000
e.checkout-to-purchase.p.k: 450
```

---

## Complete Reference

### Edge Parameters

```
# Probability
e.<edge-id>.p.mean                             # Mean probability
e.<edge-id>.p.stdev                            # Standard deviation
e.<edge-id>.p.n                                # Sample size
e.<edge-id>.p.k                                # Success count

# Conditional probability
e.<edge-id>.<condition>.p.mean                 # Conditional mean
e.<edge-id>.<condition>.p.stdev                # Conditional stdev

# Costs
e.<edge-id>.cost_gbp.mean                      # Cost in GBP
e.<edge-id>.labour_cost.mean                     # Time cost (seconds)

# Weight (for probability distribution)
e.<edge-id>.weight_default                     # Fallback weight
```

### Node Parameters

```
# Entry weight
n.<node-id>.entry.weight                       # Entry probability weight

# Case variants
n.<node-id>.case(<case-id>:<variant>).weight   # Variant weight
```

### Condition Syntax

```
visited(<node-id>)                             # User visited this node
visited(<node-a>).visited(<node-b>)            # Visited both nodes
exclude(<node-id>)                             # User did NOT visit
visited(<node-a>).exclude(<node-b>)            # Visited a but not b
context(<key>:<value>)                         # Context matches
case(<experiment>:<variant>)                   # In experiment variant
```

---

## Real-World Example: Promo Campaign Analysis

You're running a promo campaign and want to model different conversion rates based on whether users saw the promo.

### Scenario YAML

```yaml
# Base conversions (no promo)
e.product-to-cart.p.mean: 0.25
e.cart-to-checkout.p.mean: 0.75
e.checkout-to-purchase.p.mean: 0.45

# Improved conversions after seeing promo
e.product-to-cart.visited(promo-landing).p.mean: 0.35
e.cart-to-checkout.visited(promo-landing).p.mean: 0.80
e.checkout-to-purchase.visited(promo-landing).p.mean: 0.62
```

### Google Sheet Version

```
| A                                                  | B (No Promo) | C (With Promo) |
|----------------------------------------------------|--------------|----------------|
| e.product-to-cart.p.mean                           | 0.25         | —              |
| e.product-to-cart.visited(promo-landing).p.mean    | —            | 0.35           |
| e.cart-to-checkout.p.mean                          | 0.75         | —              |
| e.cart-to-checkout.visited(promo-landing).p.mean   | —            | 0.80           |
| e.checkout-to-purchase.p.mean                      | 0.45         | —              |
| e.checkout-to-purchase.visited(promo-landing).p.mean | —          | 0.62           |
```

---

## FAQ

### Can I use spaces in the DSL?
No. Use hyphens for multi-word IDs:
- ✅ `e.checkout-to-purchase`
- ❌ `e.checkout to purchase`

### What if my edge doesn't have an ID?
Use the `from().to()` syntax:
```
e.from(node-a).to(node-b).p.mean
```

### Can I set multiple fields at once?
Yes, in nested format:
```yaml
e:
  checkout-to-purchase:
    p:
      mean: 0.45
      stdev: 0.03
      n: 1000
```

Or in Google Sheets, use multiple rows:
```
e.checkout-to-purchase.p.mean     | 0.45
e.checkout-to-purchase.p.stdev    | 0.03
e.checkout-to-purchase.p.n        | 1000
```

### What's the difference between `visited(a).visited(b)` and `visited(a,b)`?
They're the same — both mean "visited both a AND b".

### How do I know if my syntax is correct?
DagNet validates all parameter references when you:
- Save a scenario
- Import from Google Sheets
- Edit parameter files

Invalid references show clear error messages.

---

## Getting Started

1. **Open a scenario** in DagNet
2. **View as YAML (flat)** to see existing parameters
3. **Copy a parameter reference** as a template
4. **Modify the value** or condition as needed
5. **Save** and DagNet validates your changes

For Google Sheets:
1. Create a sheet with two columns: **Parameter** and **Value**
2. In column A, paste parameter references (e.g., `e.checkout-to-purchase.p.mean`)
3. In column B, enter the values
4. Connect the sheet to your edge in DagNet
5. Click "Get from Source"

---

## Need More Help?

- **In DagNet**: Open the Scenarios modal to see live examples of parameter references
- **For Google Sheets**: See the Google Sheets integration documentation in the app
- **For Developers**: See the implementation specifications in the repository docs

---

**Version History:**
- **2.1** (December 2025): Added cohort windows and LAG-related DSL
- **2.0** (November 2025): Simplified user guide format, correct conditional probability syntax
- **1.0** (November 2025): Initial release
