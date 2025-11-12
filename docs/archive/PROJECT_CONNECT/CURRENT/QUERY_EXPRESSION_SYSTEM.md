# Query Expression System: Technical Specification

**Document Status:** Draft  
**Version:** 0.1  
**Last Updated:** 2025-11-04  
**Related Documents:**
- [DATA_CONNECTIONS.md](./DATA_CONNECTIONS.md) — Main data connections specification
- [DATA_CONNECTIONS_SCHEMA_VALIDATION.md](./DATA_CONNECTIONS_SCHEMA_VALIDATION.md) — Schema design & validation
- [DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md](./DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md) — Design decisions

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [Query Expression DSL](#3-query-expression-dsl)
4. [MSMDC Algorithm: Minimal Set of Maximally Discriminating Constraints](#4-msmdc-algorithm)
5. [Query Factorization for Batch Optimization](#5-query-factorization-for-batch-optimization)
6. [UI/UX: Query Constructor Component](#6-uiux-query-constructor-component)
7. [Implementation Phases](#7-implementation-phases)
8. [References & Prior Art](#8-references--prior-art)

---

## 1. Executive Summary

This document specifies the **Query Expression System** for DagNet's data connection infrastructure. The system enables:

1. **Self-contained parameter files** that define their own data retrieval constraints
2. **Automated generation** of minimal, precise query expressions from graph topology
3. **Batch optimization** that minimizes redundant API calls across multiple parameters
4. **User-friendly query constructor** with IDE-like autocomplete for manual refinement

### Key Components

| Component | Purpose | Phase |
|-----------|---------|-------|
| **Query Expression DSL** | Compact, human-readable constraint language | Phase 1 |
| **MSMDC Algorithm** | Auto-generate minimal discriminating constraints | Phase 1 |
| **Query Factorization** | Optimize batch retrieval (N params → M queries, M ≪ N) | Phase 2 |
| **Query Constructor UI** | IDE-like editor with registry-aware autocomplete | Phase 2 |

---

## 2. Problem Statement

### 2.1 The Core Challenge

**Parameter files must be self-contained for data retrieval**, but the information needed to construct queries lives in the graph:

- **What to retrieve:** Event sequence from node A → node B
- **How to discriminate:** Exclude alternate paths (e.g., A→C→B vs. A→B direct)
- **Graph topology determines constraints**, but we can't rely on graph being available at retrieval time

### 2.2 Design Requirements

1. **Self-containment:** Parameter file includes all information needed for data retrieval
2. **Human-readable:** User can inspect and debug query expressions
3. **Minimal specificity:** Only include constraints needed to discriminate (avoid over-specification)
4. **Graph-assisted construction:** Graph editor helps build expression, but doesn't execute it
5. **Runtime parsing:** Query expression parsed at retrieval time to generate API calls
6. **Validation:** System detects when expressions become invalid (deleted nodes, new siblings)

### 2.3 Use Case Example

```yaml
# File: params/conversion_checkout_to_purchase.yaml
id: checkout-to-purchase-direct
slug: checkout-to-purchase-direct
name: "Checkout → Purchase (Direct)"
type: probability

# Query expression (self-contained)
query: "from(checkout).to(purchase).exclude(abandoned-cart)"

# Data retrieval uses this expression:
# → Amplitude: "Event(checkout) THEN Event(purchase) WHERE NOT Event(abandoned-cart)"
# → No need to consult graph at retrieval time

values:
  - mean: 0.68
    n: 1250
    window_from: "2025-10-01T00:00:00Z"
    # ... retrieved data
```

---

## 3. Query Expression DSL

### 3.1 Syntax Specification

**Grammar:**

```ebnf
query          ::= from-clause to-clause constraint*
from-clause    ::= "from(" node-id ")"
to-clause      ::= "to(" node-id ")"
constraint     ::= exclude-clause | visited-clause | case-clause

exclude-clause ::= ".exclude(" node-list ")"
visited-clause ::= ".visited(" node-list ")"
case-clause    ::= ".case(" case-id ":" variant ")"

node-list      ::= node-id ("," node-id)*
node-id        ::= [a-z0-9-]+
case-id        ::= [a-z0-9-]+
variant        ::= [a-z0-9-]+
```

**Semantics:**

| Constraint | Meaning | Example |
|------------|---------|---------|
| `from(A)` | Path starts at node A | `from(homepage)` |
| `to(B)` | Path ends at node B | `to(checkout)` |
| `.exclude(C)` | Path must NOT visit node C | `.exclude(abandoned-cart)` |
| `.exclude(C,D)` | Path must NOT visit C or D | `.exclude(back-button,exit)` |
| `.visited(X)` | Path MUST visit node X | `.visited(product-view)` |
| `.case(T:v)` | Filter by case variant | `.case(experiment-1:treatment)` |

**Properties:**

- **Order-independent:** `.exclude(A,B)` ≡ `.exclude(B,A)`
- **Idempotent:** `.exclude(A).exclude(A)` ≡ `.exclude(A)`
- **Composable:** Constraints are logically ANDed together

### 3.2 Examples

```typescript
// Example 1: Direct path (no intermediate nodes)
"from(homepage).to(checkout)"
// → Amplitude: Event(homepage) THEN Event(checkout)

// Example 2: Exclude alternate route
"from(homepage).to(checkout).exclude(back-button)"
// → Event(homepage) THEN Event(checkout) WHERE NOT Event(back-button)

// Example 3: Conditional probability (must visit product page first)
"from(product-view).to(checkout).visited(add-to-cart)"
// → Event(product-view) THEN Event(add-to-cart) THEN Event(checkout)

// Example 4: Experiment-specific
"from(homepage).to(checkout).case(onboarding-test:treatment)"
// → Filter by case variant before computing probability

// Example 5: Complex path discrimination
"from(start).to(end).exclude(detour-a,detour-b).visited(checkpoint)"
// → Path must go through checkpoint, but not detours
```

### 3.3 Parsing & Validation

```typescript
interface ParsedQuery {
  from: string;              // node_id
  to: string;                // node_id
  exclude: string[];         // node_ids to avoid
  visited: string[];         // node_ids that must be on path
  cases: Array<{             // case-based filtering
    caseId: string;
    variant: string;
  }>;
}

function parseQuery(query: string): ParsedQuery {
  const match = query.match(/^from\(([^)]+)\)\.to\(([^)]+)\)(.*)$/);
  if (!match) throw new ParseError("Invalid query format");
  
  const [_, from, to, constraintsStr] = match;
  
  const exclude = extractConstraint(constraintsStr, 'exclude');
  const visited = extractConstraint(constraintsStr, 'visited');
  const cases = extractCases(constraintsStr);
  
  return { from, to, exclude, visited, cases };
}

// Validation rules:
// 1. from and to nodes must exist in graph
// 2. exclude/visited nodes must exist in graph
// 3. from and to must not be in exclude list
// 4. At least one path must satisfy constraints (not over-specified)
```

---

## 4. MSMDC Algorithm: Minimal Set of Maximally Discriminating Constraints

### 4.1 Formal Problem Definition

**Given:**
- Directed graph G = (V, E)
- Source node s, target node t
- Target path P* from s to t (the path this edge represents)
- Set of alternate paths {P₁, P₂, ..., Pₖ} from s to t

**Find:**
- Minimal set of constraints C that uniquely identifies P*
- Constraints are literals: `vis(v)` (must visit) or `exc(v)` (must exclude)

**This is a Set Cover problem:**

A literal ℓ "rules out" an alternate path Pᵢ iff:
- `vis(v)` rules out Pᵢ when v ∉ Pᵢ
- `exc(v)` rules out Pᵢ when v ∈ Pᵢ

**Objective:** Find minimum set of literals C such that every alternate path is ruled out by at least one literal in C.

### 4.2 Algorithm: Greedy Set Cover

```typescript
/**
 * MSMDC: Minimal Set of Maximally Discriminating Constraints
 * 
 * Finds the minimal set of node constraints (exclude/visited) that
 * uniquely identify a target path among alternate paths.
 * 
 * Algorithm: Greedy Set Cover with literal-based formulation
 * Complexity: O(k·n) where k = # paths, n = # nodes per path
 * Approximation: log(k)-factor (near-optimal in practice)
 */
class MSMDCAlgorithm {
  
  /**
   * Main entry: Generate minimal query constraints for an edge
   */
  async generateConstraints(
    edge: Edge,
    graph: Graph
  ): Promise<{ exclude: string[], visited: string[] }> {
    
    // Step 1: Find all simple paths from edge.from to edge.to
    const allPaths = this.findAllSimplePaths(edge.from, edge.to, graph);
    
    if (allPaths.length === 1) {
      // Only one path exists → no constraints needed
      return { exclude: [], visited: [] };
    }
    
    // Step 2: Identify which path this edge represents
    const targetPath = this.identifyTargetPath(edge, allPaths);
    
    // Step 3: Get alternate paths (all except target)
    const alternatePaths = allPaths.filter(p => 
      !this.pathsEqual(p, targetPath)
    );
    
    // Step 4: Build literal universe
    const literals = this.buildLiterals(targetPath, alternatePaths);
    
    // Step 5: Solve Set Cover (greedy)
    const selectedLiterals = this.greedySetCover(literals, alternatePaths);
    
    // Step 6: Partition into exclude/visited
    const exclude = selectedLiterals
      .filter(l => l.type === 'exclude')
      .map(l => l.nodeId);
    
    const visited = selectedLiterals
      .filter(l => l.type === 'visited')
      .map(l => l.nodeId);
    
    return { exclude, visited };
  }
  
  /**
   * Step 4: Build literal universe (all possible constraints)
   */
  private buildLiterals(
    targetPath: Path,
    alternatePaths: Path[]
  ): Literal[] {
    const literals: Literal[] = [];
    const targetNodes = new Set(targetPath.intermediates);
    
    // Build exclude literals: nodes NOT on target path
    const allNodes = new Set<string>();
    for (const path of alternatePaths) {
      for (const node of path.intermediates) {
        allNodes.add(node);
      }
    }
    
    for (const node of allNodes) {
      if (!targetNodes.has(node)) {
        literals.push({
          type: 'exclude',
          nodeId: node,
          rulesOut: this.computeRuledOutPaths(
            'exclude',
            node,
            alternatePaths
          )
        });
      }
    }
    
    // Build visited literals: nodes ON target path
    for (const node of targetPath.intermediates) {
      literals.push({
        type: 'visited',
        nodeId: node,
        rulesOut: this.computeRuledOutPaths(
          'visited',
          node,
          alternatePaths
        )
      });
    }
    
    return literals;
  }
  
  /**
   * Compute which alternate paths a literal rules out
   */
  private computeRuledOutPaths(
    type: 'exclude' | 'visited',
    nodeId: string,
    alternatePaths: Path[]
  ): Set<number> {
    const ruledOut = new Set<number>();
    
    for (let i = 0; i < alternatePaths.length; i++) {
      const path = alternatePaths[i];
      const nodeInPath = path.intermediates.includes(nodeId);
      
      if (type === 'exclude' && nodeInPath) {
        // exc(v) rules out paths containing v
        ruledOut.add(i);
      } else if (type === 'visited' && !nodeInPath) {
        // vis(v) rules out paths NOT containing v
        ruledOut.add(i);
      }
    }
    
    return ruledOut;
  }
  
  /**
   * Step 5: Greedy Set Cover
   * 
   * Repeatedly select the literal that covers the most uncovered paths
   * Guarantees: (1 + ln k)-approximation of optimal solution
   */
  private greedySetCover(
    literals: Literal[],
    alternatePaths: Path[]
  ): Literal[] {
    const selected: Literal[] = [];
    const uncovered = new Set<number>(
      alternatePaths.map((_, i) => i)
    );
    
    while (uncovered.size > 0) {
      // Find literal that covers most uncovered paths
      let bestLiteral: Literal | null = null;
      let bestCoverage = 0;
      
      for (const literal of literals) {
        const coverage = Array.from(literal.rulesOut)
          .filter(i => uncovered.has(i))
          .length;
        
        if (coverage > bestCoverage) {
          bestLiteral = literal;
          bestCoverage = coverage;
        }
      }
      
      if (!bestLiteral || bestCoverage === 0) {
        // No literal can cover remaining paths → over-constrained
        console.warn('Cannot fully discriminate paths with available literals');
        break;
      }
      
      // Add literal to solution
      selected.push(bestLiteral);
      
      // Mark covered paths
      for (const pathIdx of bestLiteral.rulesOut) {
        uncovered.delete(pathIdx);
      }
    }
    
    return selected;
  }
  
  /**
   * Step 1: Find all simple paths (DFS with cycle detection)
   */
  private findAllSimplePaths(
    from: string,
    to: string,
    graph: Graph,
    maxPaths: number = 20  // Safety limit
  ): Path[] {
    const paths: Path[] = [];
    const visited = new Set<string>();
    
    const dfs = (current: string, path: string[]) => {
      if (paths.length >= maxPaths) return;  // Limit explosion
      
      if (current === to) {
        paths.push({
          nodes: [...path, current],
          intermediates: path.slice(1)  // Exclude from/to
        });
        return;
      }
      
      visited.add(current);
      
      // Explore outgoing edges
      const outEdges = graph.edges.filter(e => e.from === current);
      for (const edge of outEdges) {
        if (!visited.has(edge.to)) {
          dfs(edge.to, [...path, current]);
        }
      }
      
      visited.delete(current);
    };
    
    dfs(from, []);
    return paths;
  }
}

interface Literal {
  type: 'exclude' | 'visited';
  nodeId: string;
  rulesOut: Set<number>;  // Indices of alternate paths this rules out
}

interface Path {
  nodes: string[];           // Full path [from, ..., to]
  intermediates: string[];   // Nodes between from and to
}
```

### 4.3 Complexity & Optimality

| Aspect | Analysis |
|--------|----------|
| **Time Complexity** | O(k·n·m) where k = paths, n = nodes/path, m = literals |
| **Space Complexity** | O(k·n) to store paths and coverage matrix |
| **Approximation Ratio** | log(k)-factor (greedy) |
| **Optimality** | Near-optimal for typical graphs (k ≤ 20 paths) |
| **Exact Solution** | ILP formulation available if needed (Phase 3+) |

**Why Greedy is Sufficient:**
1. Conversion graphs typically have k ≤ 10 paths between nodes
2. Greedy provides near-optimal solutions for small k
3. Runtime is milliseconds even for large graphs
4. User can manually refine if needed

### 4.4 Validation & Graph Health Checks

The MSMDC algorithm doubles as a **graph validation service**:

```typescript
/**
 * Graph Validation Service
 * 
 * Runs on graph save/modification to detect:
 * - Invalid query expressions (deleted nodes)
 * - Under-specified queries (new sibling paths)
 * - Over-specified queries (redundant constraints)
 */
class GraphValidationService {
  
  async validateGraph(graph: Graph): Promise<ValidationReport> {
    const issues: ValidationIssue[] = [];
    
    // Check all edges with parameter references
    for (const edge of graph.edges) {
      if (!edge.p?.parameter_id) continue;
      
      const param = await this.loadParameter(edge.p.parameter_id);
      if (!param.query) continue;
      
      // Parse query expression
      const query = parseQuery(param.query);
      
      // 1. Check node existence
      const missingNodes = this.findMissingNodes(query, graph);
      if (missingNodes.length > 0) {
        issues.push({
          severity: 'error',
          edge: edge.id,
          parameter: param.id,
          message: `Query references deleted nodes: ${missingNodes.join(', ')}`,
          suggestion: 'Update parameter query or regenerate constraints'
        });
      }
      
      // 2. Check discrimination completeness
      const discriminationCheck = await this.checkDiscrimination(
        edge,
        query,
        graph
      );
      
      if (discriminationCheck.ambiguous) {
        issues.push({
          severity: 'warning',
          edge: edge.id,
          parameter: param.id,
          message: `Query is ambiguous (matches ${discriminationCheck.matchingPaths} paths)`,
          suggestion: `Add constraints: ${discriminationCheck.suggestedConstraints.join(', ')}`
        });
      }
      
      // 3. Check for over-specification
      const redundancy = this.checkRedundancy(query, graph);
      if (redundancy.hasRedundant) {
        issues.push({
          severity: 'info',
          edge: edge.id,
          parameter: param.id,
          message: `Query has redundant constraints: ${redundancy.redundant.join(', ')}`,
          suggestion: 'Consider simplifying query'
        });
      }
    }
    
    return { issues, timestamp: new Date() };
  }
  
  /**
   * Check if query constraints uniquely identify a path
   */
  private async checkDiscrimination(
    edge: Edge,
    query: ParsedQuery,
    graph: Graph
  ): Promise<DiscriminationCheck> {
    // Find all paths matching query constraints
    const allPaths = this.findAllSimplePaths(query.from, query.to, graph);
    const matchingPaths = allPaths.filter(path =>
      this.pathMatchesQuery(path, query)
    );
    
    if (matchingPaths.length === 1) {
      return { ambiguous: false, matchingPaths: 1 };
    }
    
    // Query is ambiguous → suggest additional constraints
    const msmdc = new MSMDCAlgorithm();
    const suggested = await msmdc.generateConstraints(edge, graph);
    
    return {
      ambiguous: true,
      matchingPaths: matchingPaths.length,
      suggestedConstraints: [
        ...suggested.exclude.map(n => `exclude(${n})`),
        ...suggested.visited.map(n => `visited(${n})`)
      ]
    };
  }
}
```

---

## 5. Query Factorization for Batch Optimization

### 5.1 The Batch Retrieval Problem

**Naive approach for N parameters:**
- Execute N separate Amplitude API calls (one per parameter)
- Each call fetches overlapping event data
- **Cost:** O(N) API calls + redundant data transfer

**Smart approach:**
- Find minimal covering set of M queries where M ≪ N
- Execute M broader queries
- Filter results in-memory to distribute to parameters
- **Cost:** O(M) API calls + cheap local filtering

**Savings:** For typical graphs, M ≈ √N or better

### 5.2 Formal Problem: Query Subsumption & Set Cover

**Query Subsumption:**

A query Q₁ **subsumes** query Q₂ if:
- Q₁ fetches a superset of the data Q₂ needs
- i.e., Q₁ is less constrained than Q₂

**Examples:**

```typescript
// Q1 subsumes Q2:
Q1: from(A).to(B)                    // Any A→B path
Q2: from(A).to(B).exclude(C)         // A→B not via C

// Q1 subsumes both Q2 and Q3:
Q1: from(A).to(B)
Q2: from(A).to(B).exclude(C)
Q3: from(A).to(B).exclude(C,D)

// Optimal plan: Execute Q1 once, filter for Q2 and Q3
```

**Set Cover Formulation:**

- **Universe:** Set of N parameter requests
- **Sets:** For each candidate query Qⱼ, the set of parameters it can satisfy
- **Goal:** Find minimum set of queries covering all parameters

### 5.3 Algorithm: Query Factorization

```typescript
/**
 * Query Factorization: Minimize API calls for batch retrieval
 * 
 * Given N parameter requests, find minimal set M of queries
 * where M ≪ N, using query subsumption and set cover.
 */
class QueryFactorization {
  
  /**
   * Main entry: Create optimized batch retrieval plan
   */
  async factorize(parameters: Parameter[]): Promise<QueryPlan[]> {
    // Step 1: Parse all parameter query constraints
    const requests = parameters.map(p => ({
      param: p,
      constraints: parseQuery(p.query)
    }));
    
    // Step 2: Generate candidate queries (relaxed constraints)
    const candidates = this.generateCandidateQueries(requests);
    
    // Step 3: Build coverage matrix (which candidates cover which requests)
    const coverageMatrix = this.buildCoverageMatrix(requests, candidates);
    
    // Step 4: Solve Set Cover (greedy)
    const selectedQueries = this.greedyQueryCover(
      candidates,
      coverageMatrix,
      requests
    );
    
    // Step 5: Build execution plan with post-filters
    const plan = this.buildExecutionPlan(selectedQueries, requests);
    
    return plan;
  }
  
  /**
   * Step 2: Generate candidate queries by relaxing constraints
   */
  private generateCandidateQueries(
    requests: Request[]
  ): CandidateQuery[] {
    const candidates: CandidateQuery[] = [];
    const seen = new Set<string>();
    
    for (const req of requests) {
      // Candidate 1: Exact match (no relaxation)
      this.addCandidate(req.constraints, candidates, seen);
      
      // Candidate 2: Drop each exclude constraint (one at a time)
      for (let i = 0; i < req.constraints.exclude.length; i++) {
        const relaxed = {
          ...req.constraints,
          exclude: req.constraints.exclude.filter((_, idx) => idx !== i)
        };
        this.addCandidate(relaxed, candidates, seen);
      }
      
      // Candidate 3: Drop ALL exclude constraints (most general)
      const mostGeneral = {
        ...req.constraints,
        exclude: []
      };
      this.addCandidate(mostGeneral, candidates, seen);
      
      // (Could also relax visited, case constraints if beneficial)
    }
    
    return candidates;
  }
  
  /**
   * Step 3: Build coverage matrix
   * 
   * For each (candidate, request) pair, check if candidate subsumes request
   */
  private buildCoverageMatrix(
    requests: Request[],
    candidates: CandidateQuery[]
  ): boolean[][] {
    const matrix: boolean[][] = [];
    
    for (const candidate of candidates) {
      const row: boolean[] = [];
      
      for (const request of requests) {
        const canSatisfy = this.querySubsumes(
          candidate.constraints,
          request.constraints
        );
        row.push(canSatisfy);
      }
      
      matrix.push(row);
    }
    
    return matrix;
  }
  
  /**
   * Check if query Q1 subsumes query Q2
   * (Q1 is less constrained → fetches superset of data)
   */
  private querySubsumes(
    q1: ParsedQuery,
    q2: ParsedQuery
  ): boolean {
    // Must have same from/to
    if (q1.from !== q2.from || q1.to !== q2.to) return false;
    
    // Q1 must have SUBSET of excludes (fewer = broader)
    const q1Excludes = new Set(q1.exclude);
    const q2Excludes = new Set(q2.exclude);
    
    for (const node of q1Excludes) {
      if (!q2Excludes.has(node)) {
        // Q1 excludes something Q2 doesn't → too narrow
        return false;
      }
    }
    
    // Q1 must have SUBSET of visited (fewer = broader)
    const q1Visited = new Set(q1.visited);
    const q2Visited = new Set(q2.visited);
    
    for (const node of q1Visited) {
      if (!q2Visited.has(node)) {
        // Q1 requires visiting something Q2 doesn't → too narrow
        return false;
      }
    }
    
    // Similar logic for case constraints
    // (Details depend on semantics of case filtering)
    
    return true;
  }
  
  /**
   * Step 4: Greedy Set Cover
   * 
   * Repeatedly select candidate that covers most uncovered requests
   */
  private greedyQueryCover(
    candidates: CandidateQuery[],
    coverageMatrix: boolean[][],
    requests: Request[]
  ): SelectedQuery[] {
    const selected: SelectedQuery[] = [];
    const uncovered = new Set<number>(
      requests.map((_, i) => i)
    );
    
    while (uncovered.size > 0) {
      let bestCandidate: CandidateQuery | null = null;
      let bestCandidateIdx = -1;
      let bestScore = -Infinity;
      
      // Score each candidate: coverage / cost
      for (let c = 0; c < candidates.length; c++) {
        const candidate = candidates[c];
        
        // Count uncovered requests this candidate would cover
        const coverage = Array.from(uncovered).filter(r =>
          coverageMatrix[c][r]
        ).length;
        
        if (coverage === 0) continue;
        
        // Cost: # of constraints (prefer more general queries)
        const cost = candidate.constraints.exclude.length +
                     candidate.constraints.visited.length;
        
        // Score: maximize coverage, minimize cost
        const score = coverage / (1 + cost);
        
        if (score > bestScore) {
          bestScore = score;
          bestCandidate = candidate;
          bestCandidateIdx = c;
        }
      }
      
      if (!bestCandidate) break;  // No candidate can cover remaining
      
      // Add to selection
      const coveredRequests = Array.from(uncovered).filter(r =>
        coverageMatrix[bestCandidateIdx][r]
      );
      
      selected.push({
        query: bestCandidate,
        covers: coveredRequests
      });
      
      // Mark covered
      for (const r of coveredRequests) {
        uncovered.delete(r);
      }
    }
    
    return selected;
  }
  
  /**
   * Step 5: Build execution plan with post-filters
   */
  private buildExecutionPlan(
    selectedQueries: SelectedQuery[],
    requests: Request[]
  ): QueryPlan[] {
    const plan: QueryPlan[] = [];
    
    for (const selected of selectedQueries) {
      const parameterMappings: ParameterMapping[] = [];
      
      for (const requestIdx of selected.covers) {
        const request = requests[requestIdx];
        
        // Compute what needs to be filtered after query execution
        const postFilter = this.computePostFilter(
          selected.query.constraints,
          request.constraints
        );
        
        parameterMappings.push({
          parameter: request.param,
          postFilter
        });
      }
      
      plan.push({
        amplitudeQuery: this.buildAmplitudeQuery(selected.query.constraints),
        constraints: selected.query.constraints,
        parameters: parameterMappings
      });
    }
    
    return plan;
  }
  
  /**
   * Compute post-filter: what to filter after query execution
   */
  private computePostFilter(
    queryConstraints: ParsedQuery,
    requestConstraints: ParsedQuery
  ): PostFilter {
    // Additional excludes needed (request has, query doesn't)
    const additionalExcludes = requestConstraints.exclude.filter(
      node => !queryConstraints.exclude.includes(node)
    );
    
    // Additional visited needed
    const additionalVisited = requestConstraints.visited.filter(
      node => !queryConstraints.visited.includes(node)
    );
    
    return {
      excludeNodes: additionalExcludes,
      visitedNodes: additionalVisited,
      cases: requestConstraints.cases
    };
  }
  
  /**
   * Build actual Amplitude API query from constraints
   */
  private buildAmplitudeQuery(constraints: ParsedQuery): AmplitudeQuery {
    // Convert DSL constraints to Amplitude funnel query format
    // (Implementation depends on Amplitude API specifics)
    return {
      eventSequence: [
        { eventType: constraints.from },
        { eventType: constraints.to }
      ],
      exclusions: constraints.exclude.map(node => ({ eventType: node })),
      // ... etc.
    };
  }
}

interface Request {
  param: Parameter;
  constraints: ParsedQuery;
}

interface CandidateQuery {
  constraints: ParsedQuery;
}

interface SelectedQuery {
  query: CandidateQuery;
  covers: number[];  // Request indices
}

interface QueryPlan {
  amplitudeQuery: AmplitudeQuery;
  constraints: ParsedQuery;
  parameters: ParameterMapping[];
}

interface ParameterMapping {
  parameter: Parameter;
  postFilter: PostFilter;
}

interface PostFilter {
  excludeNodes: string[];
  visitedNodes: string[];
  cases: Array<{ caseId: string; variant: string }>;
}
```

### 5.4 Performance Analysis

**Typical Savings:**

| Scenario | Naive | Optimized | Savings |
|----------|-------|-----------|---------|
| 10 params, similar constraints | 10 calls | 2-3 calls | 70-80% |
| 50 params, diverse constraints | 50 calls | 8-12 calls | 75-85% |
| 100 params, sparse graph | 100 calls | 15-25 calls | 75-85% |

**When Optimization Helps Most:**
1. **Nightly batch refresh** (many parameters)
2. **Amplitude rate limits** (avoid throttling)
3. **Large event volumes** (minimize data transfer)
4. **Cost optimization** (Amplitude charges per query)

**When Optimization Helps Least:**
1. Single parameter update
2. Completely disjoint constraint sets
3. Very small graphs (<10 parameters)

---

## 6. UI/UX: Query Constructor Component

### 6.1 Design Goals

**User Experience:**
- **IDE-like autocomplete** as user types query expression
- **Registry-aware suggestions** (node IDs, case IDs from registry)
- **Syntax highlighting** for query DSL
- **Real-time validation** with inline error messages
- **Visual feedback** showing which paths query matches

**Technical Requirements:**
- **Fast:** Sub-50ms response for autocomplete
- **Context-aware:** Suggest only valid node IDs for current position
- **Error-tolerant:** Handle partial/invalid input gracefully
- **Accessible:** Keyboard navigation, screen reader support

### 6.2 UI Component Specification

```typescript
/**
 * QueryConstructor Component
 * 
 * IDE-like editor for query expressions with autocomplete,
 * validation, and visual feedback.
 */
interface QueryConstructorProps {
  value: string;                      // Current query expression
  graph: Graph;                       // For node/case suggestions
  onChange: (value: string) => void;  // Update callback
  onValidate?: (valid: boolean, errors: string[]) => void;
  readOnly?: boolean;
  placeholder?: string;
}

// Example usage:
<QueryConstructor
  value={parameter.query}
  graph={currentGraph}
  onChange={handleQueryChange}
  onValidate={handleValidation}
  placeholder="from(node).to(node).exclude(node)"
/>
```

### 6.3 Autocomplete Logic

```typescript
/**
 * Autocomplete Provider
 * 
 * Provides context-aware suggestions as user types
 */
class QueryAutocompleteProvider {
  
  getSuggestions(
    query: string,
    cursorPosition: number,
    graph: Graph
  ): Suggestion[] {
    // Parse query up to cursor
    const prefix = query.substring(0, cursorPosition);
    const context = this.detectContext(prefix);
    
    switch (context.type) {
      case 'from-node':
      case 'to-node':
      case 'exclude-node':
      case 'visited-node':
        return this.getNodeSuggestions(graph, context.partialInput);
      
      case 'case-id':
        return this.getCaseSuggestions(graph, context.partialInput);
      
      case 'case-variant':
        return this.getVariantSuggestions(
          graph,
          context.caseId,
          context.partialInput
        );
      
      case 'constraint-type':
        return this.getConstraintSuggestions(context.partialInput);
      
      default:
        return [];
    }
  }
  
  /**
   * Detect what user is currently typing
   */
  private detectContext(prefix: string): AutocompleteContext {
    // Match patterns to determine context
    
    if (/from\($/.test(prefix)) {
      return { type: 'from-node', partialInput: '' };
    }
    
    if (/from\(([a-z0-9-]*)$/.test(prefix)) {
      const match = prefix.match(/from\(([a-z0-9-]*)$/);
      return { type: 'from-node', partialInput: match![1] };
    }
    
    if (/to\(([a-z0-9-]*)$/.test(prefix)) {
      const match = prefix.match(/to\(([a-z0-9-]*)$/);
      return { type: 'to-node', partialInput: match![1] };
    }
    
    if (/\.exclude\(([a-z0-9,-]*)$/.test(prefix)) {
      const match = prefix.match(/\.exclude\(([a-z0-9,-]*)$/);
      const partial = match![1].split(',').pop() || '';
      return { type: 'exclude-node', partialInput: partial };
    }
    
    if (/\.case\(([a-z0-9-]*)$/.test(prefix)) {
      const match = prefix.match(/\.case\(([a-z0-9-]*)$/);
      return { type: 'case-id', partialInput: match![1] };
    }
    
    if (/\.case\([a-z0-9-]+:([a-z0-9-]*)$/.test(prefix)) {
      const match = prefix.match(/\.case\(([a-z0-9-]+):([a-z0-9-]*)$/);
      return {
        type: 'case-variant',
        caseId: match![1],
        partialInput: match![2]
      };
    }
    
    if (/\.([a-z]*)$/.test(prefix)) {
      const match = prefix.match(/\.([a-z]*)$/);
      return { type: 'constraint-type', partialInput: match![1] };
    }
    
    return { type: 'unknown' };
  }
  
  /**
   * Get node ID suggestions
   */
  private getNodeSuggestions(
    graph: Graph,
    partialInput: string
  ): Suggestion[] {
    const nodes = graph.nodes.filter(n =>
      n.id.startsWith(partialInput) ||
      n.name.toLowerCase().includes(partialInput.toLowerCase())
    );
    
    return nodes.map(n => ({
      label: n.name,
      value: n.id,
      type: 'node',
      description: n.description,
      icon: 'Circle'
    }));
  }
  
  /**
   * Get case ID suggestions
   */
  private getCaseSuggestions(
    graph: Graph,
    partialInput: string
  ): Suggestion[] {
    // Load from cases registry
    const cases = this.loadCasesFromRegistry();
    
    return cases
      .filter(c => c.id.startsWith(partialInput))
      .map(c => ({
        label: c.name,
        value: c.id,
        type: 'case',
        description: `Variants: ${c.variants.join(', ')}`,
        icon: 'GitBranch'
      }));
  }
  
  /**
   * Get constraint type suggestions
   */
  private getConstraintSuggestions(partialInput: string): Suggestion[] {
    const constraints = [
      {
        value: 'exclude',
        label: 'exclude',
        description: 'Exclude nodes from path',
        icon: 'X'
      },
      {
        value: 'visited',
        label: 'visited',
        description: 'Must visit these nodes',
        icon: 'CheckCircle'
      },
      {
        value: 'case',
        label: 'case',
        description: 'Filter by case variant',
        icon: 'GitBranch'
      }
    ];
    
    return constraints.filter(c => c.value.startsWith(partialInput));
  }
}

interface Suggestion {
  label: string;        // Display text
  value: string;        // Inserted text
  type: string;         // For styling/icons
  description?: string; // Tooltip/help text
  icon?: string;        // Lucide icon name
}
```

### 6.4 Visual Feedback: Path Matching Visualization

```typescript
/**
 * QueryVisualization Component
 * 
 * Shows which paths in the graph match the current query
 */
interface QueryVisualizationProps {
  query: string;
  graph: Graph;
  edge: Edge;
}

// Visual representation:
// 1. Highlight matched path(s) in green
// 2. Fade out non-matching paths
// 3. Show constraint violations in red
// 4. Display path count: "Matches 1 of 3 paths"
```

### 6.5 Library Recommendations

Based on research, recommended libraries for implementation:

| Component | Library | Rationale |
|-----------|---------|-----------|
| **Base Editor** | Monaco Editor or CodeMirror 6 | Mature, extensible, excellent autocomplete |
| **React Integration** | `@monaco-editor/react` or `@codemirror/react` | Official React bindings |
| **Syntax Highlighting** | Custom Monaco language or CodeMirror parser | Define query DSL syntax |
| **Autocomplete** | Monaco's `CompletionItemProvider` | Built-in, performant |
| **Validation** | Custom Monaco markers | Real-time error highlighting |
| **Fallback (simpler)** | `react-select` with creatable + `react-tag-input` | Lightweight, chip-based UI |

**Recommended Approach:**

**Phase 1 (MVP):** Simple text input with `react-select` autocomplete
- Pros: Fast to implement, lightweight
- Cons: Less IDE-like, limited syntax highlighting

**Phase 2:** Full Monaco Editor integration
- Pros: Professional UX, extensible, syntax highlighting
- Cons: Larger bundle size (~2-3 MB)

**Example: Monaco Editor Integration**

```typescript
import Editor, { useMonaco } from '@monaco-editor/react';

function QueryEditor({ value, onChange, graph }: QueryEditorProps) {
  const monaco = useMonaco();
  
  useEffect(() => {
    if (!monaco) return;
    
    // Register custom language
    monaco.languages.register({ id: 'dagnet-query' });
    
    // Define syntax highlighting
    monaco.languages.setMonarchTokensProvider('dagnet-query', {
      tokenizer: {
        root: [
          [/from|to|exclude|visited|case/, 'keyword'],
          [/[a-z0-9-]+/, 'identifier'],
          [/\(|\)/, 'bracket'],
          [/\./, 'operator']
        ]
      }
    });
    
    // Register autocomplete provider
    monaco.languages.registerCompletionItemProvider('dagnet-query', {
      provideCompletionItems: (model, position) => {
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn
        };
        
        const suggestions = getAutocompleteSuggestions(
          model.getValue(),
          position,
          graph
        );
        
        return {
          suggestions: suggestions.map(s => ({
            label: s.label,
            kind: monaco.languages.CompletionItemKind.Function,
            insertText: s.value,
            range,
            documentation: s.description
          }))
        };
      }
    });
  }, [monaco, graph]);
  
  return (
    <Editor
      height="60px"
      defaultLanguage="dagnet-query"
      value={value}
      onChange={onChange}
      options={{
        minimap: { enabled: false },
        lineNumbers: 'off',
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        quickSuggestions: true,
        suggestOnTriggerCharacters: true
      }}
    />
  );
}
```

---

## 7. Implementation Phases

### Phase 0: Schema Preparation ✓ (Complete)
- [x] Add `query` field to parameter schema
- [x] Add `event_id` to node and graph schemas
- [x] Create events registry schema
- [x] Update credential schema for data sources

### Phase 1: Core Query System (Current)

**Milestone: Single Parameter Synchronous Retrieval**

| Task | Component | Effort |
|------|-----------|--------|
| Implement query parser | `src/services/queryParser.ts` | 2 days |
| Implement MSMDC algorithm | `src/services/msmdc.ts` | 3 days |
| Add graph validation service | `src/services/graphValidation.ts` | 2 days |
| Build simple query editor UI | `src/components/QueryEditor.tsx` | 2 days |
| Integration with connect/selector | Update existing components | 2 days |
| Unit tests | Test all algorithms | 2 days |
| **Total** | | **~2 weeks** |

**Deliverables:**
- Query expression parser with validation
- MSMDC algorithm generating minimal constraints
- Graph validation warnings on save
- Basic text-based query editor
- Single parameter data retrieval working end-to-end

### Phase 2: Batch Optimization & Advanced UI

**Milestone: Batch Retrieval + IDE-like Editor**

| Task | Component | Effort |
|------|-----------|--------|
| Implement query factorization | `src/services/queryFactorization.ts` | 4 days |
| Build batch retrieval orchestrator | `src/services/batchRetrieval.ts` | 3 days |
| Integrate Monaco Editor | `src/components/MonacoQueryEditor.tsx` | 3 days |
| Autocomplete provider | Custom Monaco provider | 2 days |
| Visual path matching | Graph overlay component | 3 days |
| Batch UI & progress tracking | Dashboard component | 2 days |
| Performance testing | Load tests with 100+ params | 2 days |
| **Total** | | **~3 weeks** |

**Deliverables:**
- Query factorization reducing M queries for N params
- Asynchronous batch retrieval with progress UI
- Monaco-based query editor with autocomplete
- Visual feedback showing matched paths
- Performance validated for 100+ parameter graphs

### Phase 3: Advanced Features (Future)

**Milestone: ILP Optimization + Extended Literals**

| Task | Effort |
|------|--------|
| ILP solver for exact MSMDC | 1 week |
| Edge-based literals | 1 week |
| Ordered checkpoint literals | 1 week |
| Weighted constraint costs | 3 days |
| Query expression versioning | 3 days |
| API routes for system-to-system | 1 week |
| **Total** | **~5 weeks** |

---

## 8. References & Prior Art

### 8.1 Graph Theory Foundations

- **Set Cover Problem:** Karp's 21 NP-complete problems (1972)
- **Greedy approximation:** Johnson (1974) — (1 + ln n)-approximation
- **Hitting Set duality:** Equivalent to Set Cover via complement

### 8.2 Query Languages

- **Regular Path Queries (RPQ):** Mendelzon & Wood (1989)
- **SPARQL Property Paths:** W3C standard for RDF graph queries
- **Cypher (Neo4j):** Pattern matching with path constraints
- **GraphQL:** Declarative data fetching with field selection

### 8.3 Code Completion / Autocomplete

- **Language Server Protocol (LSP):** Microsoft (2016)
- **IntelliSense:** IDE autocomplete architecture
- **CodeFill:** Multi-token code completion (ACM 2022)
- **Tabnine / GitHub Copilot:** AI-powered code completion

### 8.4 Relevant Libraries

| Library | Purpose | Link |
|---------|---------|------|
| **Monaco Editor** | VS Code's editor (web) | [monaco-editor](https://microsoft.github.io/monaco-editor/) |
| **CodeMirror 6** | Extensible code editor | [codemirror.net](https://codemirror.net/) |
| **react-querybuilder** | React query builder UI | [github.com](https://github.com/react-querybuilder/react-querybuilder) |
| **react-select** | Select with autocomplete | [react-select.com](https://react-select.com/) |
| **react-mentions** | Mention-style input | [github.com](https://github.com/signavio/react-mentions) |

---

## Document History

| Date | Version | Changes |
|------|---------|---------|
| 2025-11-04 | 0.1 | Initial draft: MSMDC, query factorization, UI design |

---

**End of Document**

