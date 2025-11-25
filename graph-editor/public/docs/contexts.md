# Contexts

Contexts let you segment your conversion data by dimensions like channel, browser type, device family, or any custom categorization. Instead of viewing aggregate conversion rates, you can drill down into specific user segments and compare performance across them.

---

## What Are Contexts?

A **context** is a categorical dimension that partitions your data into mutually exclusive segments. For example:

- **Channel**: `google`, `facebook`, `organic`, `direct`
- **Browser Type**: `chrome`, `safari`, `firefox`, `edge`
- **Device Family**: `desktop`, `mobile`, `tablet`
- **Subscription Tier**: `free`, `pro`, `enterprise`

When you apply a context to your data, DagNet fetches separate conversion rates for each segment, allowing you to see how different user groups perform.

### MECE Partitions

Contexts follow the **MECE principle** (Mutually Exclusive, Collectively Exhaustive):

- **Mutually Exclusive**: Each user falls into exactly one context value
- **Collectively Exhaustive**: All users are covered by the context values

This ensures that segment totals add up correctly and comparisons are meaningful.

---

## Using Contexts in Queries

### Basic Context Query

To query data for a specific context value, use the `context()` function in the Query DSL:

```
context(channel:google)
```

This fetches conversion data only for users in the "google" channel.

### Multiple Context Values

To query multiple values from the same context, use `contextAny()`:

```
contextAny(channel:google,channel:facebook)
```

This fetches and aggregates data for both Google and Facebook channels.

### Combining Contexts with Other Filters

Contexts can be combined with other query constraints:

```
context(channel:google).visited(homepage).window(-30d:)
```

This queries Google channel users who visited the homepage, over the last 30 days.

### Multiple Contexts

You can apply multiple context dimensions simultaneously:

```
context(channel:google).context(device-family:mobile)
```

This drills down to Google channel users on mobile devices.

---

## Context Definitions

Contexts are defined in YAML files in your parameter registry. Each context definition specifies:

### Basic Structure

```yaml
id: channel
name: Marketing Channel
description: Traffic source / acquisition channel
values:
  - id: google
    name: Google
    filters:
      utm_source: google
  - id: facebook
    name: Facebook
    filters:
      utm_source: facebook
  - id: organic
    name: Organic Search
    filters:
      utm_medium: organic
  - id: direct
    name: Direct Traffic
    filters:
      referrer: null
otherPolicy: computed
```

### Context Fields

- **`id`**: Unique identifier for the context (used in DSL queries)
- **`name`**: Human-readable display name
- **`description`**: Explanation of what the context represents
- **`values`**: Array of possible context values
- **`otherPolicy`**: How to handle users who don't match any defined value

### Context Values

Each value in a context has:

- **`id`**: Identifier (used in `context(contextId:valueId)`)
- **`name`**: Display name
- **`filters`**: Criteria that identify users in this segment (adapter-specific)

### Other Policy

The `otherPolicy` field determines how to handle "other" users:

| Policy | Behavior |
|--------|----------|
| `computed` | Automatically compute "other" as total minus known values |
| `explicit` | Require an explicit "other" value in the list |
| `null` | Ignore "other" users (don't include in totals) |
| `error` | Raise an error if unmatched users exist |

---

## Time Windows

Contexts work seamlessly with time-bounded queries using the `window()` function:

### Relative Windows

```
context(channel:google).window(-30d:)
```

Last 30 days of Google channel data.

### Absolute Windows

```
context(channel:google).window(2025-01-01:2025-03-31)
```

Q1 2025 data for Google channel.

### Combined with Data Interests

Set `dataInterestsDSL` on your graph to automatically fetch contextual data:

```
context(channel).window(-90d:)
```

This tells DagNet to fetch the last 90 days of data, broken down by all channel values.

---

## Viewing Contextual Data

### Context Selector

When a graph has contextual data, the **Context Selector** appears in the toolbar. Use it to:

1. **Select a context dimension**: Choose which context to visualize
2. **Select a value**: Pick a specific segment or "All" for aggregate
3. **Compare values**: View multiple segments side-by-side

### Color Coding

Each context value is assigned a distinct color for easy visual comparison:

- Edges update to show segment-specific conversion rates
- Node metrics reflect the selected context
- Path analysis respects context selection

### Aggregate View

Select "All" to see the weighted aggregate across all context values. This combines segment data based on sample sizes.

---

## Aggregation

When you have data for multiple context values, DagNet can aggregate them:

### Weighted Aggregation

Conversion rates are aggregated using sample-size weighting:

```
p_aggregate = Σ(k_i) / Σ(n_i)
```

Where `n_i` is the sample size and `k_i` is the conversion count for each segment.

### Standard Deviation

Aggregate standard deviation accounts for:
- Within-segment variance
- Between-segment variance
- Sample size weighting

### Daily Data

When using daily breakdowns (`n_daily`, `k_daily`), aggregation:
- Aligns data by date across segments
- Handles missing days gracefully
- Preserves time-series structure

---

## Creating Context Files

### In the Navigator

1. Click **+ New** button
2. Select **Context**
3. Enter the context ID (e.g., `channel`)
4. Fill in the form or edit YAML directly

### Context File Location

Context files are stored in your parameter registry:

```
param-registry/
├── contexts/
│   ├── channel.yaml
│   ├── browser-type.yaml
│   └── device-family.yaml
└── contexts-index.yaml
```

### Index File

The `contexts-index.yaml` file lists all available contexts:

```yaml
version: "1.0.0"
contexts:
  - id: channel
    name: Marketing Channel
    file_path: contexts/channel.yaml
  - id: browser-type
    name: Browser Type
    file_path: contexts/browser-type.yaml
```

---

## Data Source Integration

Contexts integrate with data adapters (Amplitude, Google Sheets, etc.):

### Source Mapping

Each context value can specify how it maps to the data source:

```yaml
values:
  - id: google
    name: Google
    sources:
      amplitude:
        property: user_properties.utm_source
        operator: equals
        value: google
      google-sheets:
        column: channel
        value: Google
```

### Adapter Support

The Amplitude adapter automatically:
- Translates context filters to Amplitude segment definitions
- Fetches separate funnel data for each context value
- Handles "other" computation based on `otherPolicy`

---

## Best Practices

### Context Design

1. **Keep contexts focused**: Each context should represent a single dimension
2. **Use clear naming**: IDs should be kebab-case, names should be human-readable
3. **Document filters**: Explain how each value is determined
4. **Test MECE**: Verify that values don't overlap and cover all users

### Performance

1. **Limit active contexts**: Don't drill down on too many dimensions at once
2. **Cache data**: Use `dataInterestsDSL` to pre-fetch commonly used contexts
3. **Use incremental fetch**: For daily data, only fetch missing days

### Analysis

1. **Compare like with like**: Ensure time windows match when comparing segments
2. **Watch for small samples**: Low-volume segments may have high variance
3. **Consider interactions**: Some context combinations may have unexpected behavior

---

## Example: Marketing Channel Analysis

### 1. Define the Context

```yaml
# contexts/channel.yaml
id: channel
name: Marketing Channel
description: Acquisition channel for user traffic
otherPolicy: computed
values:
  - id: google
    name: Google Ads
    filters:
      utm_source: google
      utm_medium: cpc
  - id: facebook
    name: Facebook Ads
    filters:
      utm_source: facebook
  - id: organic
    name: Organic Search
    filters:
      utm_medium: organic
  - id: direct
    name: Direct Traffic
    filters:
      referrer: "(direct)"
```

### 2. Set Graph Data Interests

In your graph metadata:

```yaml
dataInterestsDSL: "context(channel).window(-30d:)"
```

### 3. Fetch Data

Use **Data > Get All Data** to fetch conversion rates for all channels.

### 4. Analyze

- Use the Context Selector to switch between channels
- Compare Google vs Facebook conversion rates
- Identify which channels have the best ROI

---

## Related Documentation

- [Query Expressions](./query-expressions.md) — Full DSL reference
- [Data Connections](./data-connections.md) — Adapter configuration
- [What-If Analysis](./what-ifs-with-conditionals.md) — Scenario modeling
- [Scenarios](./scenarios.md) — Parameter overlays

