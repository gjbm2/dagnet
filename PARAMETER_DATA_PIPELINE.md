# Parameter Data Pipeline - Complete Architecture

**Purpose:** Define how parameters connect to priors, posteriors, and raw observation data with context and conditional filtering

---

## The Complete Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    PRIOR SOURCES                                 │
│  (Current best estimates - may be periodically updated)         │
├─────────────────────────────────────────────────────────────────┤
│  • Google Sheets (manual estimates)                             │
│  • Previous posterior calculations                              │
│  • Expert estimates                                             │
└───────────────────────┬─────────────────────────────────────────┘
                        │
                        │ Read priors
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│              PARAMETER DEFINITION (Config File)                  │
│  • Prior source: where to get current estimate                  │
│  • Observation query: how to get raw data from data lake        │
│  • Context sharding: filter by channel, device, etc.            │
│  • Conditional logic: filter by visited nodes                   │
│  • Posterior destination: where to write updated estimates      │
└───────────────────────┬─────────────────────────────────────────┘
                        │
                        │ Query raw data
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│                  DATA LAKE / EVENT STREAM                        │
│  (Raw observations: user journeys, events, outcomes)            │
├─────────────────────────────────────────────────────────────────┤
│  • User journey events (clicked, viewed, converted)             │
│  • Sharded by: date, channel, device, etc.                      │
│  • Event stream: visit(homepage), visit(pricing), signup        │
└───────────────────────┬─────────────────────────────────────────┘
                        │
                        │ Aggregate to trials/successes
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│                  BAYESIAN UPDATE ENGINE                          │
│  • Prior: α=8, β=17 (or mean=0.32, stdev=0.06)                 │
│  • Observations: 150 trials, 52 successes                       │
│  • Posterior: α'=8+52=60, β'=17+98=115                          │
└───────────────────────┬─────────────────────────────────────────┘
                        │
                        │ Write posteriors
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│                  POSTERIOR STORAGE                               │
│  (Updated estimates become new priors)                          │
├─────────────────────────────────────────────────────────────────┤
│  • Google Sheets (for visibility)                               │
│  • Database (for history/tracking)                              │
│  • Can become priors for next iteration                         │
└─────────────────────────────────────────────────────────────────┘
```

---

## Example 1: Simple Parameter (No Conditionals)

### Parameter: `signup-google-mobile.p.mean`

```yaml
id: signup-google-mobile
name: "Signup Conversion - Google Mobile"
type: probability
edge_reference: e.signup.context(channel='google',device='mobile').p.mean

# Context filters (used in observation query)
context_filter:
  channel: google
  device: mobile

# ============================================================================
# PRIOR SOURCE: Where to get current best estimate
# ============================================================================
prior_source:
  type: sheets
  url: "https://docs.google.com/spreadsheets/d/abc123/edit"
  range: "Priors!B2:C2"  # B2=mean, C2=stdev
  refresh_frequency: "1h"
  authentication:
    type: oauth
    
  # OR: Use previous posterior as prior
  # type: posterior_history
  # query: "SELECT mean, stdev FROM posteriors WHERE param_id='signup-google-mobile' ORDER BY timestamp DESC LIMIT 1"

# ============================================================================
# OBSERVATION SOURCE: Where to get raw data for Bayesian updating
# ============================================================================
observation_source:
  type: sql
  connection: "analytics_datalake"
  
  # Query returns: trials, successes, [optional: alpha_prior, beta_prior]
  query: |
    SELECT 
      COUNT(*) as trials,
      COUNT(CASE WHEN converted THEN 1 END) as successes,
      -- Optional: include prior if stored in DB
      MAX(prior_alpha) as alpha_prior,
      MAX(prior_beta) as beta_prior
    FROM user_journeys
    WHERE 
      -- Context filtering (from context_filter above)
      channel = 'google'
      AND device = 'mobile'
      
      -- Date range (parameterized)
      AND created_at >= :start_date
      AND created_at < :end_date
      
      -- Event of interest
      AND edge_slug = 'signup'
      AND outcome IS NOT NULL  -- Completed journey
  
  # Parameters for query
  parameters:
    start_date: "NOW() - INTERVAL '7 days'"
    end_date: "NOW()"
  
  # How to interpret results
  result_mapping:
    trials: "trials"
    successes: "successes"
    alpha_prior: "alpha_prior"  # Optional
    beta_prior: "beta_prior"     # Optional
  
  # Minimum sample size before updating
  min_sample_size: 100
  
  refresh_frequency: "1h"

# ============================================================================
# BAYESIAN UPDATE CONFIG: How to combine prior + observations
# ============================================================================
bayesian_update:
  # Prior distribution (Beta for probabilities)
  prior:
    distribution: beta
    alpha: 8.0    # Equivalent to ~32% success rate
    beta: 17.0    # with ~25 effective samples
  
  # Update rule
  update_rule: conjugate  # Beta-Binomial conjugate
  
  # Posterior calculation
  # α_posterior = α_prior + successes
  # β_posterior = β_prior + (trials - successes)

# ============================================================================
# POSTERIOR DESTINATION: Where to write updated estimates
# ============================================================================
posterior_destination:
  # Can have multiple destinations
  destinations:
    # Write to Sheets for visibility
    - type: sheets
      url: "https://docs.google.com/spreadsheets/d/abc123/edit"
      range: "Posteriors!A:H"  # Append new row
      mode: append
      format:
        - param_id
        - timestamp
        - prior_mean
        - prior_stdev
        - trials
        - successes
        - posterior_mean
        - posterior_stdev
    
    # Write to database for history
    - type: sql
      connection: "analytics_datalake"
      table: "parameter_posteriors"
      mode: insert
      conflict_resolution: update  # Update if param_id + date exists
  
  write_frequency: "1d"  # How often to update

# ============================================================================
# MODEL FIT MONITORING: Alert if prior diverges from observations
# ============================================================================
model_fit:
  # Divergence check
  thresholds:
    # Alert if observed rate outside prior's 95% credible interval
    divergence_threshold: 2.0  # Standard deviations
    min_sample_size: 100        # Need 100+ samples to compare
  
  # Alert destination
  alerts:
    type: slack
    webhook: "https://hooks.slack.com/services/..."
    channel: "#model-monitoring"

# Fallback value (used if all sources fail)
fallback_value:
  mean: 0.32
  stdev: 0.06

metadata:
  description: "Signup conversion for Google mobile traffic"
  created_at: "2025-10-21T00:00:00Z"
  author: "data-team"
  version: "1.0.0"
```

---

## Example 2: Conditional Parameter (With Visited Nodes)

### Parameter: `signup-google-mobile-returning.p.mean`

**User must have visited homepage AND pricing page**

```yaml
id: signup-google-mobile-returning
name: "Signup Conversion - Google Mobile (Returning Visitors)"
type: probability
edge_reference: e.signup.visited(homepage,pricing).context(channel='google',device='mobile').p.mean

# Structural condition (visited nodes)
visited_filter:
  - homepage
  - pricing

# Context condition
context_filter:
  channel: google
  device: mobile

# ============================================================================
# PRIOR SOURCE
# ============================================================================
prior_source:
  type: sheets
  url: "https://docs.google.com/spreadsheets/d/abc123/edit"
  range: "Priors!B10:C10"
  refresh_frequency: "1h"

# ============================================================================
# OBSERVATION SOURCE: Complex query with conditional filtering
# ============================================================================
observation_source:
  type: sql
  connection: "analytics_datalake"
  
  # IMPORTANT: Must filter for users who visited specified nodes
  query: |
    WITH visited_users AS (
      -- Find users who visited BOTH homepage and pricing
      SELECT DISTINCT user_id, session_id
      FROM events
      WHERE 
        event_type = 'page_view'
        AND node_slug IN ('homepage', 'pricing')
        AND created_at >= :start_date
        AND created_at < :end_date
        AND channel = 'google'
        AND device = 'mobile'
      GROUP BY user_id, session_id
      HAVING 
        -- Must have visited ALL specified nodes
        COUNT(DISTINCT node_slug) = 2  -- homepage + pricing
    ),
    
    signup_attempts AS (
      -- Get signup attempts from those users
      SELECT 
        e.user_id,
        e.session_id,
        MAX(CASE WHEN e.event_type = 'signup_success' THEN 1 ELSE 0 END) as converted
      FROM events e
      INNER JOIN visited_users v 
        ON e.user_id = v.user_id 
        AND e.session_id = v.session_id
      WHERE 
        e.event_type IN ('signup_attempt', 'signup_success')
        AND e.created_at >= :start_date
        AND e.created_at < :end_date
      GROUP BY e.user_id, e.session_id
    )
    
    SELECT 
      COUNT(*) as trials,
      SUM(converted) as successes
    FROM signup_attempts
  
  parameters:
    start_date: "NOW() - INTERVAL '7 days'"
    end_date: "NOW()"
  
  result_mapping:
    trials: "trials"
    successes: "successes"
  
  min_sample_size: 50  # Lower threshold for conditional (less data)
  
  refresh_frequency: "1h"

# ============================================================================
# BAYESIAN UPDATE CONFIG
# ============================================================================
bayesian_update:
  prior:
    distribution: beta
    alpha: 12.0   # Expecting higher conversion (45%)
    beta: 15.0    # for returning visitors
  
  update_rule: conjugate

# ============================================================================
# POSTERIOR DESTINATION
# ============================================================================
posterior_destination:
  destinations:
    - type: sheets
      url: "https://docs.google.com/spreadsheets/d/abc123/edit"
      range: "Posteriors_Conditional!A:I"
      mode: append
      format:
        - param_id
        - timestamp
        - visited_nodes  # Include conditional info
        - context_filter
        - prior_mean
        - trials
        - successes
        - posterior_mean
        - posterior_stdev
    
    - type: sql
      connection: "analytics_datalake"
      table: "parameter_posteriors"
      mode: insert
  
  write_frequency: "1d"

# Model fit monitoring
model_fit:
  thresholds:
    divergence_threshold: 2.0
    min_sample_size: 50  # Lower for conditional params
  
  alerts:
    type: slack
    webhook: "https://hooks.slack.com/services/..."
    channel: "#model-monitoring"

fallback_value:
  mean: 0.45
  stdev: 0.08

metadata:
  description: "Signup conversion for Google mobile users who viewed homepage and pricing"
  tags: [conditional, returning, google, mobile]
  created_at: "2025-10-21T00:00:00Z"
  version: "1.0.0"
```

---

## Example 3: Multiple Context Shards

### Observation Query Template with Context Variables

```yaml
id: signup-template
name: "Signup Conversion (Template for all contexts)"
type: probability

# ============================================================================
# OBSERVATION SOURCE: Templated query using context variables
# ============================================================================
observation_source:
  type: sql
  connection: "analytics_datalake"
  
  # Query template - context_filter values are injected
  query_template: |
    SELECT 
      COUNT(*) as trials,
      SUM(CASE WHEN converted THEN 1 END) as successes,
      '{{channel}}' as context_channel,
      '{{device}}' as context_device
    FROM user_journeys
    WHERE 
      edge_slug = 'signup'
      AND created_at >= :start_date
      AND created_at < :end_date
      
      -- Context filters (injected from context_filter)
      {% if channel %}
      AND channel = '{{channel}}'
      {% endif %}
      
      {% if device %}
      AND device = '{{device}}'
      {% endif %}
      
      {% if utm_source %}
      AND utm_source = '{{utm_source}}'
      {% endif %}
      
      {% if geo_country %}
      AND geo_country = '{{geo_country}}'
      {% endif %}
    
    GROUP BY channel, device  -- Shard by contexts
  
  # The context_filter values get injected into template
  context_variables:
    - channel
    - device
    - utm_source
    - geo_country
  
  parameters:
    start_date: "NOW() - INTERVAL '7 days'"
    end_date: "NOW()"
  
  min_sample_size: 100
  refresh_frequency: "1h"
```

---

## Example 4: Hierarchical Queries for Visited Nodes

### Complex Conditional: "Visited ANY of (A, B, C)" vs "Visited ALL of (A, B, C)"

```yaml
id: checkout-flexible-path
name: "Checkout Conversion - Flexible Path"
type: probability

# Visited filter with logic
visited_filter:
  operator: "OR"  # ANY of these nodes
  nodes:
    - product-page-1
    - product-page-2
    - product-page-3

observation_source:
  type: sql
  connection: "analytics_datalake"
  
  query: |
    WITH visited_users AS (
      SELECT DISTINCT user_id, session_id
      FROM events
      WHERE 
        event_type = 'page_view'
        -- ANY of these nodes (OR logic)
        AND node_slug IN ('product-page-1', 'product-page-2', 'product-page-3')
        AND created_at >= :start_date
        AND created_at < :end_date
      -- Note: No HAVING clause needed for OR logic
    ),
    
    checkout_attempts AS (
      SELECT 
        e.user_id,
        e.session_id,
        MAX(CASE WHEN e.event_type = 'checkout_success' THEN 1 ELSE 0 END) as converted
      FROM events e
      INNER JOIN visited_users v 
        ON e.user_id = v.user_id 
        AND e.session_id = v.session_id
      WHERE 
        e.event_type IN ('checkout_attempt', 'checkout_success')
        AND e.created_at >= :start_date
        AND e.created_at < :end_date
      GROUP BY e.user_id, e.session_id
    )
    
    SELECT 
      COUNT(*) as trials,
      SUM(converted) as successes
    FROM checkout_attempts
```

### Alternative: "Visited ALL of (A, B, C)"

```yaml
visited_filter:
  operator: "AND"  # ALL of these nodes
  nodes:
    - homepage
    - pricing
    - demo

observation_source:
  query: |
    WITH visited_users AS (
      SELECT user_id, session_id
      FROM events
      WHERE 
        event_type = 'page_view'
        AND node_slug IN ('homepage', 'pricing', 'demo')
        AND created_at >= :start_date
        AND created_at < :end_date
      GROUP BY user_id, session_id
      HAVING 
        -- Must have visited ALL specified nodes (AND logic)
        COUNT(DISTINCT node_slug) = 3  -- homepage + pricing + demo
    )
    -- ... rest of query
```

---

## Example 5: Date-Sharded Queries

### Tracking Parameter Drift Over Time

```yaml
id: signup-google-mobile-timeseries
name: "Signup Conversion - Google Mobile (Time Series)"

observation_source:
  type: sql
  connection: "analytics_datalake"
  
  # Query returns multiple rows (one per date shard)
  query: |
    SELECT 
      DATE(created_at) as observation_date,
      COUNT(*) as trials,
      SUM(CASE WHEN converted THEN 1 END) as successes
    FROM user_journeys
    WHERE 
      edge_slug = 'signup'
      AND channel = 'google'
      AND device = 'mobile'
      AND created_at >= :start_date
      AND created_at < :end_date
    GROUP BY DATE(created_at)
    ORDER BY observation_date
  
  parameters:
    start_date: "NOW() - INTERVAL '30 days'"
    end_date: "NOW()"
  
  # Process results as time series
  result_type: timeseries
  result_mapping:
    date: "observation_date"
    trials: "trials"
    successes: "successes"

# Posterior destination for time series
posterior_destination:
  destinations:
    - type: sheets
      url: "https://docs.google.com/spreadsheets/d/abc123/edit"
      range: "Posteriors_Timeseries!A:F"
      mode: replace  # Replace existing time series
      format:
        - date
        - trials
        - successes
        - posterior_mean
        - posterior_stdev
        - drift_alert  # Flag if drifting from prior
```

---

## Schema Extension: Complete Parameter Definition

### Updated parameter-schema.yaml

```yaml
properties:
  # ... existing fields ...
  
  # =========================================================================
  # PRIOR SOURCE: Where to get current best estimate
  # =========================================================================
  prior_source:
    type: object
    required: [type]
    properties:
      type:
        type: string
        enum: [sheets, sql, webhook, posterior_history, static]
      
      # For sheets
      url:
        type: string
        format: uri
      range:
        type: string
      
      # For SQL
      connection:
        type: string
      query:
        type: string
      
      # For all types
      refresh_frequency:
        type: string
        pattern: '^\\d+[smhd]$'
      
      authentication:
        type: object
  
  # =========================================================================
  # OBSERVATION SOURCE: Where to get raw data for Bayesian updating
  # =========================================================================
  observation_source:
    type: object
    required: [type, query]
    properties:
      type:
        type: string
        enum: [sql, bigquery, snowflake, redshift, clickhouse]
      
      connection:
        type: string
        description: "Database connection ID (from config)"
      
      query:
        type: string
        description: "SQL query to fetch trials/successes"
      
      query_template:
        type: string
        description: "Templated query with context variable injection"
      
      context_variables:
        type: array
        items:
          type: string
        description: "List of context variables to inject into query"
      
      parameters:
        type: object
        description: "Query parameters (e.g., date ranges)"
      
      result_mapping:
        type: object
        properties:
          trials:
            type: string
          successes:
            type: string
          alpha_prior:
            type: string
          beta_prior:
            type: string
      
      result_type:
        type: string
        enum: [single, timeseries]
        default: single
      
      min_sample_size:
        type: integer
        minimum: 1
        description: "Minimum samples before updating"
      
      refresh_frequency:
        type: string
        pattern: '^\\d+[smhd]$'
  
  # =========================================================================
  # BAYESIAN UPDATE CONFIG
  # =========================================================================
  bayesian_update:
    type: object
    properties:
      prior:
        type: object
        properties:
          distribution:
            type: string
            enum: [beta, normal, gamma, lognormal]
          
          # For Beta distribution (probabilities)
          alpha:
            type: number
            minimum: 0
          beta:
            type: number
            minimum: 0
          
          # For Normal distribution
          mu:
            type: number
          sigma:
            type: number
            minimum: 0
      
      update_rule:
        type: string
        enum: [conjugate, mcmc, variational]
        default: conjugate
      
      mcmc_config:
        type: object
        properties:
          samples:
            type: integer
          burn_in:
            type: integer
          chains:
            type: integer
  
  # =========================================================================
  # POSTERIOR DESTINATION: Where to write updated estimates
  # =========================================================================
  posterior_destination:
    type: object
    properties:
      destinations:
        type: array
        items:
          type: object
          properties:
            type:
              type: string
              enum: [sheets, sql, webhook]
            
            # For sheets
            url:
              type: string
            range:
              type: string
            mode:
              type: string
              enum: [append, replace, update]
            format:
              type: array
              items:
                type: string
            
            # For SQL
            connection:
              type: string
            table:
              type: string
            mode:
              type: string
              enum: [insert, update, upsert]
            conflict_resolution:
              type: string
      
      write_frequency:
        type: string
        pattern: '^\\d+[smhd]$'
  
  # =========================================================================
  # MODEL FIT MONITORING
  # =========================================================================
  model_fit:
    type: object
    properties:
      thresholds:
        type: object
        properties:
          divergence_threshold:
            type: number
            description: "Alert if divergence > N standard deviations"
          min_sample_size:
            type: integer
            description: "Minimum samples before checking fit"
      
      alerts:
        type: object
        properties:
          type:
            type: string
            enum: [slack, email, webhook, pagerduty]
          webhook:
            type: string
          channel:
            type: string
          email:
            type: string
  
  # =========================================================================
  # VISITED FILTER (for conditional parameters)
  # =========================================================================
  visited_filter:
    oneOf:
      # Simple array (AND logic by default)
      - type: array
        items:
          type: string
      
      # Complex with operator
      - type: object
        properties:
          operator:
            type: string
            enum: [AND, OR]
          nodes:
            type: array
            items:
              type: string
```

---

## Implementation: Data Pipeline Service

```typescript
// Service that orchestrates the complete data pipeline
export class ParameterDataPipeline {
  
  async updateParameter(paramId: string): Promise<PosteriorUpdate> {
    // 1. Load parameter definition
    const param = await loadParameter(paramId);
    
    // 2. Fetch prior
    const prior = await this.fetchPrior(param.prior_source);
    
    // 3. Query observations from data lake
    const observations = await this.queryObservations(
      param.observation_source,
      param.context_filter,
      param.visited_filter
    );
    
    // 4. Check minimum sample size
    if (observations.trials < param.observation_source.min_sample_size) {
      console.log(`Insufficient samples for ${paramId}: ${observations.trials} < ${param.observation_source.min_sample_size}`);
      return { skipped: true, reason: 'insufficient_samples' };
    }
    
    // 5. Perform Bayesian update
    const posterior = await this.bayesianUpdate(
      prior,
      observations,
      param.bayesian_update
    );
    
    // 6. Check model fit
    const divergence = this.checkModelFit(prior, observations, param.model_fit);
    if (divergence.alert) {
      await this.sendAlert(param, divergence);
    }
    
    // 7. Write posterior
    await this.writePosterior(
      param.posterior_destination,
      {
        param_id: paramId,
        timestamp: new Date(),
        prior,
        observations,
        posterior,
        divergence
      }
    );
    
    return { posterior, observations, divergence };
  }
  
  async queryObservations(
    source: ObservationSource,
    contextFilter?: ContextFilter,
    visitedFilter?: VisitedFilter
  ): Promise<Observations> {
    
    // Build query with context injection
    let query = source.query_template || source.query;
    
    // Inject context variables
    if (contextFilter && source.context_variables) {
      for (const contextVar of source.context_variables) {
        const value = contextFilter[contextVar];
        if (value) {
          query = query.replace(`{{${contextVar}}}`, value);
        }
      }
    }
    
    // Execute query
    const result = await this.executeQuery(source.connection, query, source.parameters);
    
    return {
      trials: result[source.result_mapping.trials],
      successes: result[source.result_mapping.successes],
      alpha_prior: result[source.result_mapping.alpha_prior],
      beta_prior: result[source.result_mapping.beta_prior]
    };
  }
  
  async bayesianUpdate(
    prior: Prior,
    observations: Observations,
    config: BayesianUpdateConfig
  ): Promise<Posterior> {
    
    if (config.update_rule === 'conjugate' && prior.distribution === 'beta') {
      // Beta-Binomial conjugate update
      const alpha_posterior = prior.alpha + observations.successes;
      const beta_posterior = prior.beta + (observations.trials - observations.successes);
      
      const mean = alpha_posterior / (alpha_posterior + beta_posterior);
      const variance = (alpha_posterior * beta_posterior) / 
        (Math.pow(alpha_posterior + beta_posterior, 2) * (alpha_posterior + beta_posterior + 1));
      const stdev = Math.sqrt(variance);
      
      return {
        distribution: 'beta',
        alpha: alpha_posterior,
        beta: beta_posterior,
        mean,
        stdev,
        credible_interval_95: [
          betaQuantile(0.025, alpha_posterior, beta_posterior),
          betaQuantile(0.975, alpha_posterior, beta_posterior)
        ]
      };
    }
    
    // Other update rules (MCMC, variational, etc.)
    throw new Error(`Update rule ${config.update_rule} not implemented`);
  }
}
```

---

## Summary

The parameter definition is a **complete data pipeline configuration** that specifies:

1. **Prior Source**: Where to GET current estimate
   - Sheets, SQL, previous posteriors

2. **Observation Source**: WHERE/HOW to query raw data
   - SQL query with context filtering (`WHERE channel = 'google'`)
   - Conditional filtering (`WHERE user_id IN (SELECT ... visited nodes)`)
   - Date sharding (`WHERE created_at >= ...`)
   - Aggregation to trials/successes

3. **Bayesian Update**: HOW to combine prior + observations
   - Prior distribution (Beta, Normal, etc.)
   - Update rule (conjugate, MCMC, etc.)

4. **Posterior Destination**: Where to WRITE updated estimates
   - Sheets (for visibility)
   - Database (for history)
   - Can become priors for next cycle

5. **Model Fit**: HOW to detect divergence
   - Thresholds for alerts
   - Minimum sample sizes
   - Alert destinations

This gives you the complete prior → observations → posterior pipeline with context sharding and conditional event stream filtering!


