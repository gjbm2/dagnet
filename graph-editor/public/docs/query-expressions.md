# Query Expression Syntax & Semantics

**Version:** 1.0  
**Last Updated:** November 2025

---

## Overview

Query expressions are a domain-specific language (DSL) for specifying data retrieval constraints in DagNet. They define **which path** through a conversion graph you want to retrieve data for, when multiple paths exist between two nodes.

**Use Cases:**
- **Parameter Data Retrieval:** Specify which events to query from Amplitude
- **Conditional Probabilities:** Define path conditions (e.g., "probability of B→C given visited A")
- **Parameter Packs:** Group related parameters with shared constraints
- **Python Analytics:** Use the same syntax in dagCalc and Bayesian modeling scripts

---

## Quick Start

### Basic Syntax

```
from(start-node).to(end-node)
```

This is the simplest query: retrieve data for **all** paths from `start-node` to `end-node`.

### Example

**Graph:**
```
homepage → product-page → checkout → purchase
```

**Query:**
```
from(product-page).to(checkout)
```

**Meaning:** Get conversion rate from product page to checkout (includes all traffic).

---

## Core Concepts

### Node Identifiers

**What they are:**
- `node_id` in the graph (e.g., `homepage`, `product-page`)
- Uses **ids** from graph nodes (not UUIDs)
- Falls back to registry IDs if node has no id

**Conventions:**
- Lowercase with hyphens: `checkout-page`
- Descriptive: `abandoned-cart-email`
- Consistent across graph, registry, and external systems

### Path Constraints

Query expressions define a **target path** by specifying:
1. **Start and end:** Required (`.from()` and `.to()`)
2. **Exclusions:** Nodes the path must NOT visit (`.exclude()`)
3. **Requirements:** Nodes the path MUST visit (`.visited()`)
4. **Case filters:** Experiment variants to include (`.case()`)

---

## Syntax Reference

### 1. From-To (Required)

```
from(node-id).to(node-id)
```

**Purpose:** Define start and end nodes of the path.

**Rules:**
- Must always appear (both required)
- Order doesn't matter: `from(a).to(b)` = `to(b).from(a)`
- Can only specify one `from` and one `to`

**Examples:**
```
from(homepage).to(purchase)
from(signup-start).to(signup-complete)
```

---

### 2. Exclude (Optional)

```
.exclude(node-id)
.exclude(node-id, node-id, ...)
```

**Purpose:** Rule out paths that visit specific nodes.

**Use When:**
- Multiple paths exist, and you want to avoid certain routes
- Isolating "direct" conversions vs. "detour" conversions
- Filtering out specific user journeys

**Examples:**

**Single exclusion:**
```
from(homepage).to(purchase).exclude(abandoned-cart)
```
*Meaning:* Get conversions that didn't abandon cart.

**Multiple exclusions:**
```
from(homepage).to(purchase).exclude(help-page, faq-page)
```
*Meaning:* Get conversions without visiting support pages.

**Real-world scenario:**
```
Graph:
  homepage → product → checkout → purchase
  homepage → product → cart → checkout → purchase
  
Query: from(homepage).to(purchase).exclude(cart)
Result: Only the direct path (skips cart step)
```

---

### 3. Visited (Optional)

```
.visited(node-id)
.visited(node-id, node-id, ...)
```

**Purpose:** Require paths that visit specific nodes (conditional probability).

**Use When:**
- Measuring "what happens after X?"
- Conditional conversion rates
- Sequential event analysis

**Examples:**

**Single requirement:**
```
from(homepage).to(purchase).visited(email-click)
```
*Meaning:* Conversion rate for users who clicked an email first.

**Multiple requirements:**
```
from(product-page).to(purchase).visited(reviews-page, add-to-cart)
```
*Meaning:* Users who viewed reviews AND added to cart.

**Real-world scenario (conditional probability):**
```
Graph:
  homepage → blog → product → purchase
  homepage → product → purchase
  
Query: from(product).to(purchase).visited(blog)
Result: Conversion rate for users who came via blog
```

---

### 4. Case (Optional)

```
.case(case-id:variant)
.case(case-id:variant, case-id:variant, ...)
```

**Purpose:** Filter by A/B test or experiment variant.

**Use When:**
- Analyzing experiment results
- Comparing treatment vs. control
- Segmenting by user group

**Syntax:**
- `case-id`: Identifier for the experiment (from case registry)
- `variant`: Specific variant name (e.g., `treatment`, `control`, `variant-a`)

**Examples:**

**Single case:**
```
from(homepage).to(purchase).case(pricing-test:treatment)
```
*Meaning:* Conversion rate for users in the pricing test treatment group.

**Multiple cases:**
```
from(homepage).to(purchase).case(pricing-test:treatment, ui-redesign:variant-b)
```
*Meaning:* Users in BOTH the pricing treatment AND UI variant B.

**Real-world scenario:**
```
Experiment: "checkout-flow-v2"
Variants: control, simplified, express

Query: from(cart).to(purchase).case(checkout-flow-v2:simplified)
Result: Conversion rate for simplified checkout variant only
```

---

## Semantics & Evaluation

### Path Matching

A query expression defines a **filter** over all possible paths in the graph.

**Matching Algorithm:**
```
1. Find all paths from source to target
2. For each path P:
   a. If any node in .exclude() is in P → reject
   b. If any node in .visited() is NOT in P → reject
   c. If case variant doesn't match → reject
   d. Otherwise → accept
3. Query results = union of all accepted paths
```

### Logical Interpretation

**Constraints are ANDed:**
```
from(a).to(b).exclude(c).visited(d)
```
Means: 
- Start at A AND
- End at B AND
- NOT visit C AND
- DO visit D

**Multiple items in one constraint are ORed:**
```
.exclude(c, d)  →  NOT (visit C OR visit D)
.visited(c, d)  →  visit C AND visit D  (both required)
```

---

## Minimality & Validation

### Minimal Constraints

**Principle:** Use the **minimum** number of constraints needed to uniquely identify your path.

**Why:**
- Simpler queries are easier to understand
- Less brittle when graph structure changes
- Better for debugging

**Example:**

```
Graph: A → B → C → D
       A → E → D

Query 1 (over-specified):
  from(a).to(d).visited(b).visited(c).exclude(e)

Query 2 (minimal):
  from(a).to(d).exclude(e)

Both identify the same path, but Query 2 is better.
```

**DagNet's MSMDC Algorithm:** Automatically generates minimal queries for you.

### Validation

**Queries are validated on:**

1. **Ambiguity:** Does the query match multiple paths?
   - ⚠️ Warning: "Query matches 3 paths. Consider adding `.exclude(node-x)`"
   
2. **Empty Results:** Does the query match NO paths?
   - ❌ Error: "No path matches this query. Check node IDs."
   
3. **Missing Nodes:** Are all referenced nodes in the graph?
   - ❌ Error: "`node-xyz` not found in graph or registry."

4. **Redundancy:** Are there unnecessary constraints?
   - 💡 Info: "`.visited(b)` is redundant (only one path through B)."

---

## Common Patterns

### 1. Direct vs. Indirect Paths

**Scenario:** Users can checkout directly or go through cart first.

```
Graph:
  product → checkout → purchase
  product → cart → checkout → purchase
```

**Direct conversions:**
```
from(product).to(purchase).exclude(cart)
```

**Cart-based conversions:**
```
from(product).to(purchase).visited(cart)
```

---

### 2. Email Campaign Effectiveness

**Scenario:** Measure conversions driven by email clicks.

```
Graph:
  homepage → product → purchase
  email-click → product → purchase
```

**Email-driven conversions:**
```
from(product).to(purchase).visited(email-click)
```

**Organic conversions (no email):**
```
from(product).to(purchase).exclude(email-click)
```

---

### 3. Experiment Analysis

**Scenario:** A/B test with different landing pages.

```
Experiment: "hero-image-test"
Variants: control, lifestyle, product-focus
```

**Treatment group conversion:**
```
from(landing-page).to(signup).case(hero-image-test:lifestyle)
```

**Control group conversion:**
```
from(landing-page).to(signup).case(hero-image-test:control)
```

---

### 4. Sequential Engagement

**Scenario:** Users who engaged with content before converting.

```
Graph:
  homepage → blog-post → product → purchase
  homepage → product → purchase
```

**Content-engaged conversions:**
```
from(product).to(purchase).visited(blog-post)
```

---

## Advanced Usage

### Combining Multiple Constraints

**Complex filtering:**
```
from(homepage).to(purchase)
  .visited(product-page, reviews-page)
  .exclude(support-chat, help-center)
  .case(pricing-test:treatment)
```

**Meaning:**
- Users who viewed product page AND reviews
- But didn't visit support
- And were in the pricing test treatment

---

### Parameter Packs

**Group related parameters with shared constraints:**

```yaml
# parameter-pack.yaml
pack_id: checkout-funnel-treatment
base_query: "from(cart).case(checkout-flow-v2:simplified)"
parameters:
  - param_id: cart-to-shipping
    query: "${base_query}.to(shipping)"
  - param_id: shipping-to-payment
    query: "${base_query}.to(payment)"
  - param_id: payment-to-complete
    query: "${base_query}.to(purchase)"
```

This retrieves all three parameters with consistent case filtering.

---

### Python Integration (dagCalc, Bayesian Models)

**Use the same syntax in Python:**

```python
# dagcalc/query_parser.py
from dagnet.query import parse_query

query = parse_query("from(a).to(b).exclude(c)")

# Execute against Amplitude
results = amplitude_client.query(
    start_event=query.from_node,
    end_event=query.to_node,
    exclude_events=query.excluded_nodes
)

# Use in Bayesian models
prior = get_parameter("conversion-rate")
likelihood = query_results_to_likelihood(results, query)
posterior = bayesian_update(prior, likelihood)
```

---

## Reference Implementation

### TypeScript

```typescript
interface QueryExpression {
  from: string;
  to: string;
  exclude?: string[];
  visited?: string[];
  cases?: Array<{ caseId: string; variant: string }>;
}

function parseQuery(expr: string): QueryExpression {
  // Parse "from(a).to(b).exclude(c).visited(d).case(e:f)"
  // Returns structured object
}

function validateQuery(
  query: QueryExpression, 
  graph: Graph
): ValidationResult {
  // Check ambiguity, empty results, missing nodes
}

function matchesPath(query: QueryExpression, path: string[]): boolean {
  // Returns true if path satisfies query constraints
}
```

---

## Grammar (Formal)

```ebnf
query ::= from-clause to-clause modifier*

from-clause ::= "from(" node-id ")"
to-clause   ::= "to(" node-id ")"

modifier ::= exclude-clause | visited-clause | case-clause

exclude-clause ::= ".exclude(" node-list ")"
visited-clause ::= ".visited(" node-list ")"
case-clause    ::= ".case(" case-list ")"

node-list ::= node-id ("," node-id)*
case-list ::= case-spec ("," case-spec)*
case-spec ::= case-id ":" variant-id

node-id    ::= [a-z0-9] [a-z0-9-]*
case-id    ::= [a-z0-9] [a-z0-9-]*
variant-id ::= [a-z0-9] [a-z0-9-]*
```

**Key Rules:**
- Whitespace is ignored
- IDs are lowercase alphanumeric with hyphens
- Order of clauses doesn't matter (except for readability)
- Duplicate clauses are invalid (e.g., two `.from()` calls)

---

## FAQ

### Q: Can I use event names instead of node IDs?

**A:** No. Query expressions use `node_id` (graph-level identifiers). Events are mapped to nodes via `node.event_id`, but queries operate at the graph topology level.

**Why:** This keeps param files self-contained and graph-centric.

---

### Q: What if I delete a node that's referenced in a query?

**A:** The query becomes invalid. DagNet's graph validation service will:
1. Detect the broken reference on save
2. Show a warning: "Query references deleted node `xyz`"
3. Suggest either updating the query or reconnecting the node

---

### Q: Can I specify "OR" logic (e.g., visit A or B)?

**A:** Not in v1. Constraints are always ANDed. If you need OR logic, create separate parameters with different queries.

**Future:** May add `visited(a | b)` syntax if use cases emerge.

---

### Q: How do I know if my query is minimal?

**A:** DagNet's MSMDC algorithm automatically generates minimal queries. If you edit manually, the validator will show an info hint if it detects redundant constraints.

---

### Q: Can I test a query without retrieving data?

**A:** Yes! The query editor shows real-time validation:
- ✅ Green: Valid, unambiguous
- ⚠️ Yellow: Valid but ambiguous (suggests fixes)
- ❌ Red: Invalid (broken references, syntax errors)

---

## Best Practices

### 1. Let Auto-Generation Do Its Job

**Default behavior:** When you connect a parameter to an edge, DagNet auto-generates the query.

**When to override:**
- You want a specific conditional probability
- You're analyzing a particular experiment variant
- You need custom filtering beyond topology

**Track state:** Queries are marked `query_auto_generated: true/false` so you know which are manual.

---

### 2. Use Descriptive Node IDs

**Good:**
```
from(product-detail-page).to(add-to-cart)
```

**Bad:**
```
from(pdp).to(atc)
```

Readable queries are easier to debug and share with teammates.

---

### 3. Avoid Over-Specification

**Over-specified:**
```
from(a).to(d).visited(b).visited(c).exclude(e)
```

**Minimal:**
```
from(a).to(d).exclude(e)
```

If there's only one path through B and C, specifying them is redundant.

---

### 4. Document Complex Queries

If a query has multiple constraints, add a comment in the parameter file:

```yaml
# parameters/conversion-rate-email-engaged.yaml
query: "from(product).to(purchase).visited(email-click).exclude(support-chat)"
description: "Conversion rate for email-driven users who didn't need support"
```

---

### 5. Test Before Committing

Before committing parameter changes:
1. Use "Validate Graph" to check all queries
2. Review warnings/suggestions
3. Test data retrieval on a single param
4. Then batch-update

---

## Related Documentation

- **[MSMDC Algorithm](./query-algorithms-white-paper.md#1-msmdc-minimal-set-of-maximally-discriminating-constraints):** Technical deep-dive on automatic query generation
- **[Query Factorization](./query-algorithms-white-paper.md#2-query-factorization-for-batch-optimization):** Batch optimization for efficient API calls
- **[Implementation Plan](../../../DATA_CONNECTIONS_IMPLEMENTATION_PLAN.md):** Roadmap for data connections system
- **[Parameter Schema](../../public/param-schemas/parameter-schema.yaml):** Full parameter file structure

---

**Version History:**
- **1.0** (Nov 2025): Initial release

**Maintained by:** DagNet Team  
**Questions?** See [DATA_CONNECTIONS_README.md](../../../DATA_CONNECTIONS_README.md)

