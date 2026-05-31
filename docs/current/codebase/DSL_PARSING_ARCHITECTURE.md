# DSL Parsing Architecture

**Scope**: this doc covers both the **FE TypeScript** parser cluster (`queryDSL.ts`, `dslExplosion.ts`, `compositeQueryParser.ts`) and the **BE Python** parser plus auxiliary extractors (`query_dsl.py`, `analysis_subject_resolution.py`, `forecast_preparation.py`).

The FE side has a single parser: `queryDSL.ts` is the only place that handles `context()`, `window()`, `visited()`, etc. on the frontend. The BE side has a formal parser (`query_dsl.py`) that handles **most** of the grammar but **not `cohort()`**; cohort-mode requests are extracted from the raw DSL string via auxiliary regex helpers. The "single source of truth" property is per-side, not global.

## Core Modules (FE)

### 1. `queryDSL.ts` - Atomic Expression Parser
**Purpose**: Parse individual constraint expressions (no compound operators)

**Functions**:
- `parseConstraints(dsl)` - Parse atomic expression → `{ visited, exclude, context, window, ... }`
- `normalizeConstraintString(dsl)` - Canonical form for comparison
- `parseDSL(dsl)` - Full query with from/to

**Used By**: Everything in the codebase

**Handles**:
- `visited(a,b)`, `exclude(c)`, `visitedAny(d,e)`
- `context(key:value)`, `contextAny(key:v1,v2)` (including bare keys)
- `window(start:end)`, `case(key:value)`

**Does NOT Handle**: Compound operators (;, or(), minus, plus)

---

### 2. `dslExplosion.ts` - Compound Expression Explosion
**Purpose**: Expand compound expressions into atomic slices

**Functions**:
- `explodeDSL(dsl)` - Explode compound → array of atomic strings
- `countAtomicSlices(dsl)` - Count without full expansion

**Uses**: `parseConstraints()` and `normalizeConstraintString()` from queryDSL.ts

**Handles**:
- Semicolons: `a;b;c` → 3 slices
- or(): `or(a,b,c)` → 3 slices (including nested: `or(a,or(b,c))`)
- Parentheses with suffixes: `(a;b).window(...)` → distributes window
- Prefix distribution: `c.(a;b)` → `c.a;c.b`
- Bare key expansion: `context(channel)` → all values (Cartesian product)
- All equivalences: `(a;b).c = c.(a;b) = or(a,b).c = a.c;b.c`

**Used By**:
- PinnedQueryModal (slice explosion preview)
- Nightly runner (when implemented)

---

### 3. `compositeQueryParser.ts` - Minus/Plus Operators
**Purpose**: Parse inclusion-exclusion queries for MSMDC

**Functions**:
- `parseCompositeQuery(dsl)` - Extract base, minus terms, plus terms
- `getExecutionTerms(parsed)` - Convert to execution terms with coefficients

**Does NOT Use**: parseConstraints (separate concern - handles from/to/minus/plus only)

**Handles**:
- `from(a).to(b).minus(c,d)` → base + subtract paths visiting c or d
- `from(a).to(b).plus(e,f)` → add back paths visiting e or f

**Used By**: compositeQueryExecutor.ts (DAS queries)

---

## Core Modules (BE — Python)

### 4. `query_dsl.py` — Formal Grammar Parser (BE)

**Purpose**: Parse query DSL into a typed `ParsedQuery` dataclass on the backend.

**Functions**:
- `parse_query(dsl) → ParsedQuery` — full parse: from/to, visited, exclude, context, contextAny, window, case, asat
- Schema authority: `graph-editor/public/schemas/query-dsl-1.0.0.json`

**Handles**: from, to, visited, visitedAny, exclude, context, contextAny, window, case, minus, plus, asat.

**Does NOT Handle**: `cohort()` — the cohort clause is parsed by the auxiliary extractors below. This is the root reason for the auxiliary helpers in §5; consolidating `cohort()` into `query_dsl.py` is the long-term clean-up.

**Used By**: `analysis_subject_resolution.py`, the runner cluster broadly, anything that needs `ParsedQuery` fields.

---

### 5. Auxiliary BE Extractors (regex-based)

Because `query_dsl.py` does not parse `cohort()`, three auxiliary helpers extract cohort-clause fields by regex on the raw DSL string. Each has a single concern:

| Helper | Location | Extracts |
|---|---|---|
| `_extract_temporal_mode(query_dsl)` | [`analysis_subject_resolution.py:394`](../../graph-editor/lib/analysis_subject_resolution.py#L394) | Returns `'cohort'` / `'window'` / `None` by string presence |
| `_extract_time_bounds(query_dsl)` | [`analysis_subject_resolution.py:470`](../../graph-editor/lib/analysis_subject_resolution.py#L470) | Returns `(anchor_from, anchor_to)` as ISO date strings. Regex handles both `window(start:end)` and `cohort([anchor,]start:end)` — the optional anchor prefix is the AP31 defect site (see Pitfalls below). |
| `_extract_cohort_anchor_node(query_dsl)` | [`forecast_preparation.py:283`](../../graph-editor/lib/runner/forecast_preparation.py#L283) | Returns the anchor node id from `cohort(anchor,start:end)`, or `None`. Separate concern from `_extract_time_bounds` (anchor vs dates). |

These are **not duplicates of each other** — they have distinct outputs. They are duplicate **with the formal parser's responsibility**: each one would disappear if `query_dsl.py` parsed `cohort()`. Until then, add new cohort extractors here (not elsewhere) and keep them adjacent so the redundancy stays visible.

**Used By**: `analysis_subject_resolution.resolve_analysis_subjects`, `forecast_preparation.resolve_forecast_subjects`, ultimately the CF preparation layer (see [`FORECAST_PREPARATION.md`](FORECAST_PREPARATION.md) §2.4).

---

## Architecture Principles

1. **Single Parser for Constraints**: `parseConstraints()` is the ONLY place that parses context, window, visited, etc.

2. **Composable**:
   - dslExplosion calls parseConstraints on each atomic slice
   - compositeQueryParser focuses on minus/plus (doesn't duplicate constraint parsing)

3. **Normalized Output**: All paths use `normalizeConstraintString()` for canonical form

4. **No Duplication (FE)**:
   - Don't write regex for context() parsing outside queryDSL.ts
   - Don't parse window() outside queryDSL.ts
   - Call parseConstraints() if you need to extract constraints

5. **BE additions must go via the formal parser** (`query_dsl.py`) where possible. New cohort-clause fields belong in the §5 auxiliary helpers only until `cohort()` is promoted into `query_dsl.py`; consolidating there closes the §5 redundancy.

## Usage Examples

```typescript
// Parse atomic expression
const parsed = parseConstraints('context(channel:google).window(1-Jan-25:31-Dec-25)');
// → { context: [{key:'channel', value:'google'}], window: {start:'1-Jan-25', end:'31-Dec-25'}, ... }

// Explode compound expression
const slices = await explodeDSL('context(channel);context(browser).window(-90d:)');
// → ['context(channel:google)', 'context(channel:meta)', 'context(browser:chrome).window(-90d:)', ...]

// Parse composite query (minus/plus)
const composite = parseCompositeQuery('from(a).to(b).minus(c,d)');
// → { base: {from:'a', to:'b'}, minusTerms: [['c','d']], plusTerms: [] }
```

## Adding New DSL Features

When adding new constraint types:

1. Add to QUERY_FUNCTIONS constant in queryDSL.ts
2. Add regex matcher in parseConstraints()
3. Add to normalizeConstraintString() canonical order
4. Update ParsedConstraints interface
5. Add to Monaco autocomplete in QueryExpressionEditor.tsx
6. Don't create separate parsing logic

## Tests

- `queryDSL.test.ts`: 67 tests for parseConstraints, normalization
- `dslExplosion.test.ts`: 10 tests for compound explosion
- All parsing logic is tested

## Pitfalls

### Anti-pattern 31: Regex not handling optional prefixes in DSL clauses

**Signature**: `_extract_time_bounds` (or similar DSL parsers) returns today's date instead of the dates in the DSL. Downstream filters silently exclude all historical data.

**Root cause**: `cohort(anchor,start:end)` has an optional anchor-node prefix before the date range. A regex like `cohort\(([^:]*):([^)]*)\)` captures `anchor,start-date` as group 1. `_resolve_date('anchor,12-Dec-25')` fails all date-format checks and falls through to `today.isoformat()`.

**Fix**: make the anchor prefix optional in the regex: `cohort\((?:[^,)]*,)?([^:,]*):([^)]*)\)`. Test with both `cohort(start:end)` and `cohort(anchor,start:end)` forms. Check the grammar in `DSL_SYNTAX_REFERENCE.md` before writing DSL regexes.

**Current state**: `_extract_time_bounds` ([`analysis_subject_resolution.py:470`](../../graph-editor/lib/analysis_subject_resolution.py#L470)) implements the fixed regex. AP31 is closed there, but the broader anti-pattern (writing a regex for a DSL clause that the formal parser doesn't own) is the recurring failure mode — the auxiliary helpers in §5 are all candidates for the same defect when their regexes are widened. Promotion of `cohort()` into `query_dsl.py` retires the whole class.

## Related Docs

- **`DSL_SYNTAX_REFERENCE.md`** — Full grammar, all 14 functions, composition rules, examples (the "what" to this doc's "how")
- **`DATA_RETRIEVAL_QUERIES.md`** — Three purposes of queries (topology, conditional metadata, data retrieval)
- **`RESERVED_QUERY_TERMS_GLOSSARY.md`** — Semantic term definitions
- **Canonical schemas**: `public/schemas/query-dsl-1.1.0.json`
- **User-facing guide**: `public/docs/query-expressions.md`
