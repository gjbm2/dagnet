# Context Parameters - Usage Examples

This document provides concrete examples of how context parameters work in practice.

---

## Resolution Hierarchy Example

Given an edge called `signup`, here's how parameters are resolved:

### Available Parameters

```yaml
# 1. Base parameter (no filters)
id: signup-base
edge_reference: e.signup.p.mean
value: 0.30

# 2. Channel-only context
id: signup-google
edge_reference: e.signup.context(channel='google').p.mean
context_filter: { channel: google }
value: 0.35

# 3. Device-only context  
id: signup-mobile
edge_reference: e.signup.context(device='mobile').p.mean
context_filter: { device: mobile }
value: 0.28

# 4. Channel + Device context
id: signup-google-mobile
edge_reference: e.signup.context(channel='google',device='mobile').p.mean
context_filter: { channel: google, device: mobile }
value: 0.32

# 5. Visited only
id: signup-visited-pricing
edge_reference: e.signup.visited(pricing).p.mean
visited_filter: [pricing]
value: 0.40

# 6. Visited + Context
id: signup-visited-pricing-google
edge_reference: e.signup.visited(pricing).context(channel='google').p.mean
visited_filter: [pricing]
context_filter: { channel: google }
value: 0.45
```

### Resolution Examples

#### Scenario 1: Google Mobile User, Visited Pricing
**Active Contexts:** `{ channel: [google], device: [mobile] }`  
**Visited Nodes:** `[pricing]`

**Resolution order:**
1. ✅ Check for exact match: `visited=[pricing], context={channel=google,device=mobile}`
   - **Not found** (we don't have this combination)
2. ✅ Check for context-only: `context={channel=google,device=mobile}`
   - **Found:** `signup-google-mobile` → returns **0.32**

**Result:** 0.32

---

#### Scenario 2: Google Desktop User, Visited Pricing
**Active Contexts:** `{ channel: [google], device: [desktop] }`  
**Visited Nodes:** `[pricing]`

**Resolution order:**
1. Check for exact match: `visited=[pricing], context={channel=google,device=desktop}`
   - **Not found**
2. Check for context-only: `context={channel=google,device=desktop}`
   - **Not found** (we only have google+mobile, not google+desktop)
3. Check for visited-only: `visited=[pricing]`
   - **Found:** `signup-visited-pricing` → returns **0.40**

**Result:** 0.40

---

#### Scenario 3: Facebook Mobile User, No Visits
**Active Contexts:** `{ channel: [facebook], device: [mobile] }`  
**Visited Nodes:** `[]`

**Resolution order:**
1. Check for exact match: (none, no visited nodes)
2. Check for context-only: `context={channel=facebook,device=mobile}`
   - **Not found**
3. Check for visited-only: (none, no visited nodes)
4. Check for base: no filters
   - **Found:** `signup-base` → returns **0.30**

**Result:** 0.30

---

#### Scenario 4: Multiple Active Context Values
**Active Contexts:** `{ channel: [google, facebook, organic], device: [mobile, desktop] }`  
**Visited Nodes:** `[]`

When multiple context values are active, **all matching parameters are valid**.

**Matching parameters:**
- `signup-google` (channel=google ✓)
- `signup-mobile` (device=mobile ✓)
- `signup-google-mobile` (channel=google ✓, device=mobile ✓)

**How this is used:**
- **Monte Carlo simulation:** Randomly sample from matching distributions
- **Expected value calculation:** Weighted average by traffic distribution
- **Sensitivity analysis:** Show range across all matching parameters

---

## What-If Analysis UI Examples

### Example 1: Channel Comparison

**User Action:** Deselect all channels except Google and Facebook

**UI State:**
```
☑ Google Ads
☑ Facebook Ads
☐ Organic Search
☐ Email Campaign
☐ Direct
```

**Graph Impact:**
- Only parameters with `channel: google` or `channel: facebook` are used
- Base parameters (no context) still apply
- Graph shows "Expected conversion: 31.5% (Google+Facebook mix)"

---

### Example 2: Device-Specific Analysis

**User Action:** Select only mobile devices

**UI State:**
```
Device Type
☑ Mobile
☐ Desktop
☐ Tablet
```

**Graph Impact:**
- All mobile-specific parameters active
- Desktop/tablet parameters ignored
- Shows "Mobile conversion rate: 28%"

---

### Example 3: Combined Analysis

**User Action:** Select Google + Mobile

**UI State:**
```
Marketing Channel
☑ Google Ads
☐ Facebook Ads
☐ Organic Search

Device Type
☑ Mobile
☐ Desktop
☐ Tablet
```

**Graph Impact:**
- Uses `signup-google-mobile` (32%)
- Falls back to `signup-google` for other edges without mobile-specific params
- Shows "Google mobile conversion: 32%"

---

## Creating Context Parameters in UI

### Workflow 1: Create from Edge Properties

**Steps:**
1. User selects an edge in graph
2. Opens properties panel
3. Clicks "Create Context Parameter"
4. Dialog appears:
   ```
   Create Context Parameter
   
   Edge: signup
   Parameter: probability (mean)
   Current value: 0.35
   
   Context Filters:
   ☑ Add context filter
   
   Channel:     [Google Ads      ▼]
   Device:      [Mobile          ▼]
   
   Parameter ID: signup-google-mobile
   Parameter Name: Signup Conversion - Google Mobile
   
   [Cancel]  [Create & Link]
   ```
5. Creates YAML file in `param-registry/parameters/probability/signup-google-mobile.yaml`
6. Links edge to new parameter

---

### Workflow 2: Browse & Link Existing Parameter

**Steps:**
1. User selects edge
2. Opens properties panel
3. Clicks "Link to Registry"
4. Parameter browser appears:
   ```
   Select Parameter for edge: signup
   
   Filter by context:
   Channel: [All ▼]
   Device:  [All ▼]
   
   Available Parameters:
   ☐ signup-base (30% ± 5%) - Baseline
   ☑ signup-google (35% ± 4%) - Google Ads
   ☐ signup-google-mobile (32% ± 6%) - Google Mobile
   ☐ signup-facebook-desktop (28% ± 5%) - Facebook Desktop
   
   [Cancel]  [Link Selected]
   ```
5. Links edge to selected parameter(s)

---

## Real-World Scenarios

### Scenario A: E-commerce Checkout Optimization

**Context Setup:**
```yaml
contexts:
  - channel: [google, facebook, organic]
  - device: [mobile, desktop]
  - browser: [chrome, safari, firefox]
```

**Parameters:**
- `checkout-mobile-safari`: 38% (optimized UI for iOS)
- `checkout-mobile-chrome`: 35%
- `checkout-desktop`: 55%
- `checkout-google-mobile`: 40% (Google users more intent)

**Analysis:**
> "If we improve Safari mobile checkout from 38% to 42%, what's the overall impact?"
> - Filter to Safari + Mobile
> - Adjust parameter value
> - See impact on total conversion

---

### Scenario B: Marketing Channel Attribution

**Context Setup:**
```yaml
contexts:
  - channel: [google, facebook, email, organic]
  - utm_source: [newsletter, promo-campaign, referral]
```

**Parameters:**
- `signup-google`: 35%
- `signup-facebook`: 28%
- `signup-email-newsletter`: 42%
- `signup-organic`: 48%

**Questions:**
1. "What's our conversion rate if we cut Facebook ads?"
   - Deselect Facebook → see graph recalculate
   
2. "What if newsletter campaigns perform 10% better?"
   - Filter to newsletter
   - Increase parameter by 10%
   - See overall impact

---

### Scenario C: A/B Test with Context

**Setup:** Testing new signup button colors, but results vary by channel

**Parameters:**
```yaml
# Control (blue button)
id: signup-blue-google
case_parameter_id: button-color
variant: blue
context_filter: { channel: google }
value: 0.35

id: signup-blue-facebook  
case_parameter_id: button-color
variant: blue
context_filter: { channel: facebook }
value: 0.28

# Treatment (green button)
id: signup-green-google
case_parameter_id: button-color
variant: green
context_filter: { channel: google }
value: 0.37  # +2% on Google

id: signup-green-facebook
case_parameter_id: button-color
variant: green
context_filter: { channel: facebook }
value: 0.27  # -1% on Facebook (worse!)
```

**Analysis:**
- Green button wins on Google but loses on Facebook
- Context-aware A/B test shows nuanced results
- Can make channel-specific decisions

---

## Parameter Coverage Analysis

### Coverage Matrix Example

For edge `signup` with contexts `[channel, device]`:

|                | Google | Facebook | Organic | Email | Direct |
|----------------|--------|----------|---------|-------|--------|
| **Mobile**     | ✅ 32% | ❌      | ❌      | ✅ 40%| ❌     |
| **Desktop**    | ✅ 36% | ✅ 28%  | ✅ 48%  | ❌    | ❌     |
| **Tablet**     | ❌     | ❌      | ❌      | ❌    | ❌     |

**Insights:**
- **Coverage:** 6/15 combinations (40%)
- **Missing:** Organic mobile, all tablet parameters
- **Suggestion:** Create parameters for high-traffic missing combinations

---

### Auto-Generate Missing Parameters

**Tool:** `dagnet param suggest`

```bash
$ dagnet param suggest --edge signup --contexts channel,device

Analyzing parameter coverage for edge: signup
Contexts: channel (5 values) × device (3 values) = 15 combinations

Current coverage: 6/15 (40%)

Top missing combinations by traffic:
1. organic + mobile (18% of traffic) - uses fallback: signup-base (30%)
2. google + tablet (3% of traffic) - uses fallback: signup-google (35%)
3. facebook + mobile (8% of traffic) - uses fallback: signup-mobile (28%)

Recommended actions:
1. Create signup-organic-mobile (high traffic, no good fallback)
2. Create signup-facebook-mobile (medium traffic, poor current fallback)

[Create Parameters]  [Export List]  [Dismiss]
```

---

## Migration & Adoption

### Step 1: Add Base Parameters (No Breaking Changes)

Add context-aware parameters alongside existing values:

```typescript
// Before: hardcoded value
edge.p = { mean: 0.35, stdev: 0.05 };

// After: can use registry OR hardcoded
edge.p = { 
  mean: 0.35,           // Fallback if parameter not found
  stdev: 0.05,
  parameter_id: "signup-google"  // Optional reference
};
```

### Step 2: Gradually Add Context Coverage

Start with high-impact contexts:
1. Add `channel` context (5 parameters)
2. Add `device` context for mobile (3 parameters)
3. Add `channel × device` for top combinations (6 parameters)
4. Monitor coverage and add as needed

### Step 3: Enable What-If UI

Once parameters exist:
1. Enable context selector in UI
2. Users can filter and analyze
3. Collect usage data on which contexts matter most

---

## API & Apps Script Integration

### Apps Script Context Override

```javascript
// In Google Sheets
function setContextFilters() {
  const contexts = {
    channel: ['google', 'facebook'],
    device: ['mobile']
  };
  
  dagnet.setActiveContexts(contexts);
  dagnet.recalculateGraph();
}

// Read context-specific parameter
function getContextParam() {
  const param = dagnet.getParameter('e.signup.context(channel="google").p.mean');
  Logger.log(param); // 0.35
}
```

### REST API

```bash
# Get available contexts
GET /api/contexts
→ [{ id: "channel", values: ["google", "facebook", ...] }, ...]

# Get parameters for contexts
GET /api/parameters?context[channel]=google&context[device]=mobile
→ [{ id: "signup-google-mobile", value: 0.32, ... }]

# Simulate with contexts
POST /api/simulate
{
  "graph_id": "checkout-flow",
  "contexts": {
    "channel": ["google"],
    "device": ["mobile", "desktop"]
  },
  "samples": 10000
}
→ { conversion_rate: 0.33, confidence_interval: [0.31, 0.35] }
```

---

## Summary

Context parameters enable:

1. **Fine-grained modeling**: Different conversion rates by channel, device, etc.
2. **What-if analysis**: Toggle contexts on/off to see impact
3. **Data-driven decisions**: Compare performance across contexts
4. **Incremental adoption**: Add context awareness gradually
5. **Scalable coverage**: Start with key combinations, expand as needed

**Next:** Review design, create implementation plan, build Phase 1 (core infrastructure)



