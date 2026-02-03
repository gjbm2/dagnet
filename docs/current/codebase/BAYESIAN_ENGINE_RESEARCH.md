# Bayesian Engine Research: Nightly Incremental Model Fitting

**Date**: 3-Feb-26  
**Purpose**: Research existing tools with Bayesian engines that calculate model fit nightly based on incremental datasets

---

## Executive Summary

**Finding**: While many tools support Bayesian inference, **very few** offer **automated nightly incremental model fitting** specifically for conversion funnels or probabilistic graphs. Most tools require manual model specification and execution.

**Key Tools Identified**:
1. **Probabilistic Programming Frameworks** (PyMC, Pyro, Stan) - General-purpose, require custom implementation
2. **A/B Testing Platforms** (Optimizely, VWO) - Bayesian methods but not nightly incremental fitting
3. **Analytics Platforms** (Amplitude, Mixpanel) - No Bayesian model fitting
4. **Specialized Tools** - None found for conversion funnel Bayesian fitting

**Recommendation**: DagNet would be **pioneering** this capability in the conversion funnel analytics space.

---

## 1. Probabilistic Programming Frameworks

### PyMC (formerly PyMC3/PyMC4)
**Position**: Open-source Python probabilistic programming framework  
**Capabilities**:
- ✅ **Bayesian inference**: MCMC (NUTS, HMC), Variational Inference (ADVI)
- ✅ **Model specification**: Define models in Python code
- ✅ **Automation**: Can be scripted for nightly runs
- ⚠️ **Incremental learning**: Not built-in; requires custom implementation
- ⚠️ **Conversion funnels**: No domain-specific support

**Use Case**: General-purpose Bayesian modeling; requires custom implementation for DagNet's use case.

**Example**:
```python
import pymc as pm

# Model specification
with pm.Model() as model:
    # Priors
    mu = pm.Normal('mu', mu=0, sigma=1)
    sigma = pm.HalfNormal('sigma', sigma=1)
    
    # Likelihood
    y = pm.Normal('y', mu=mu, sigma=sigma, observed=data)
    
    # Inference
    trace = pm.sample(1000, tune=1000)
```

**For DagNet**: Would require custom implementation of:
- Incremental data loading from parameter files
- Hierarchical Bayesian survival model for latency
- Nightly batch processing
- Posterior storage and retrieval

---

### Pyro (Uber)
**Position**: Probabilistic programming framework built on PyTorch  
**Capabilities**:
- ✅ **Bayesian inference**: SVI, MCMC (HMC, NUTS), Importance Sampling
- ✅ **Automatic guides**: AutoNormal, AutoDelta, AutoStructured
- ✅ **Scalability**: Built on PyTorch for GPU acceleration
- ⚠️ **Incremental learning**: Not built-in; requires custom implementation
- ⚠️ **Conversion funnels**: No domain-specific support

**Use Case**: General-purpose Bayesian modeling with PyTorch integration; requires custom implementation.

**Example**:
```python
import pyro
import pyro.distributions as dist

def model(data):
    mu = pyro.sample("mu", dist.Normal(0, 1))
    sigma = pyro.sample("sigma", dist.HalfNormal(1))
    with pyro.plate("data", len(data)):
        return pyro.sample("obs", dist.Normal(mu, sigma), obs=data)

# Inference
guide = pyro.infer.autoguide.AutoNormal(model)
svi = pyro.infer.SVI(model, guide, pyro.optim.Adam({"lr": 0.01}), 
                     loss=pyro.infer.Trace_ELBO())
```

**For DagNet**: Similar to PyMC—requires custom implementation for incremental learning and conversion funnel models.

---

### Stan
**Position**: Probabilistic programming language with multiple interfaces  
**Capabilities**:
- ✅ **Bayesian inference**: MCMC (NUTS, HMC), Variational Inference
- ✅ **Model specification**: Stan language (separate from data)
- ✅ **Interfaces**: R (rstan), Python (pystan, cmdstanpy), Julia, MATLAB
- ⚠️ **Incremental learning**: Not built-in; requires custom implementation
- ⚠️ **Conversion funnels**: No domain-specific support

**Use Case**: General-purpose Bayesian modeling; requires custom implementation.

**Example** (Stan language):
```stan
data {
  int<lower=0> N;
  real y[N];
}
parameters {
  real mu;
  real<lower=0> sigma;
}
model {
  mu ~ normal(0, 1);
  sigma ~ half_normal(1);
  y ~ normal(mu, sigma);
}
```

**For DagNet**: Would require custom Stan model for hierarchical survival analysis and incremental data handling.

---

### PyAutoFit
**Position**: Python package for Bayesian model fitting  
**Capabilities**:
- ✅ **Bayesian inference**: Multiple non-linear search methods
- ✅ **Model specification**: Python API for model definition
- ✅ **Analysis workflows**: Structured analysis configuration
- ⚠️ **Incremental learning**: Not mentioned in documentation
- ⚠️ **Conversion funnels**: No domain-specific support

**Use Case**: Scientific applications requiring structured Bayesian analysis workflows.

---

## 2. A/B Testing Platforms (Partial Overlap)

### Optimizely
**Position**: A/B testing and experimentation platform  
**Capabilities**:
- ✅ **Bayesian methods**: Uses Bayesian inference for statistical analysis
- ✅ **Automated analysis**: Automatic statistical analysis of experiments
- ⚠️ **Nightly fitting**: Not mentioned; analysis happens on-demand
- ❌ **Conversion funnels**: Focuses on A/B tests, not funnel modeling
- ❌ **Incremental learning**: Not mentioned

**Relevance**: Uses Bayesian methods but not for nightly incremental model fitting of conversion funnels.

---

### VWO (Visual Website Optimizer)
**Position**: A/B testing and conversion optimization platform  
**Capabilities**:
- ✅ **Bayesian methods**: Uses Bayesian inference for experiment analysis
- ✅ **Automated analysis**: Automatic statistical analysis
- ⚠️ **Nightly fitting**: Not mentioned; analysis happens on-demand
- ❌ **Conversion funnels**: Focuses on A/B tests, not funnel modeling
- ❌ **Incremental learning**: Not mentioned

**Relevance**: Similar to Optimizely—Bayesian methods for A/B testing, not funnel modeling.

---

### Statsig
**Position**: Feature flags and experimentation platform  
**Capabilities**:
- ✅ **Bayesian methods**: Uses Bayesian inference for experiment analysis
- ✅ **Automated analysis**: Automatic statistical analysis
- ⚠️ **Nightly fitting**: Not mentioned; analysis happens on-demand
- ❌ **Conversion funnels**: Focuses on experiments, not funnel modeling
- ❌ **Incremental learning**: Not mentioned

**Relevance**: Bayesian methods for experimentation, not conversion funnel modeling.

---

## 3. Analytics Platforms (No Bayesian Fitting)

### Amplitude
**Position**: Product analytics platform  
**Capabilities**:
- ❌ **Bayesian model fitting**: No Bayesian inference capabilities
- ❌ **Nightly fitting**: No automated model fitting
- ✅ **Funnel analysis**: Conversion funnel tracking and analysis
- ✅ **Cohort analysis**: Cohort-based analytics

**Relevance**: DagNet integrates with Amplitude as a data source but Amplitude doesn't do Bayesian model fitting.

---

### Mixpanel
**Position**: Product analytics platform  
**Capabilities**:
- ❌ **Bayesian model fitting**: No Bayesian inference capabilities
- ❌ **Nightly fitting**: No automated model fitting
- ✅ **Funnel analysis**: Conversion funnel tracking and analysis
- ✅ **Cohort analysis**: Cohort-based analytics

**Relevance**: Similar to Amplitude—no Bayesian model fitting capabilities.

---

## 4. Specialized Tools (None Found)

**Research Result**: No specialized tools found that:
- ✅ Calculate Bayesian model fit nightly
- ✅ Handle incremental datasets
- ✅ Focus on conversion funnels or probabilistic graphs
- ✅ Provide automated nightly batch processing

**Gap in Market**: This appears to be an **unmet need** in the market.

---

## 5. Incremental Bayesian Learning (Technical Approach)

### Online Bayesian Learning
**Concept**: Update posterior distributions incrementally as new data arrives

**Mathematical Foundation**:
```
Prior: P(θ | D_old)
New Data: D_new
Posterior: P(θ | D_old, D_new) ∝ P(D_new | θ) × P(θ | D_old)
```

**Key Insight**: The previous posterior becomes the new prior when processing new data.

**Advantages**:
- ✅ **Memory efficient**: Don't need to store all historical data
- ✅ **Faster updates**: Only process new data, not entire dataset
- ✅ **Natural for streaming**: Handles continuous data streams

**Challenges**:
- ⚠️ **Non-stationarity**: Assumes data distribution doesn't change
- ⚠️ **Model complexity**: Hierarchical models require careful handling
- ⚠️ **Convergence**: Need to ensure posterior converges correctly

---

### Implementation Approaches

#### A. Sequential Bayesian Updates
**Approach**: Update posterior distribution sequentially as new data arrives

**Example** (Beta-Binomial):
```python
# Initial prior: Beta(alpha_0, beta_0)
alpha, beta = 1, 1

# For each new batch of data:
for batch in incremental_data:
    n_new, k_new = batch['n'], batch['k']
    # Update: posterior = Beta(alpha + k_new, beta + n_new - k_new)
    alpha += k_new
    beta += (n_new - k_new)
    
# Posterior: Beta(alpha, beta)
```

**Pros**: Simple, exact for conjugate priors  
**Cons**: Limited to conjugate models, doesn't handle non-stationarity

---

#### B. Variational Inference (VI) with Incremental Updates
**Approach**: Use variational inference to approximate posterior, update incrementally

**Example** (Pyro):
```python
# Initial guide
guide = pyro.infer.autoguide.AutoNormal(model)

# For each new batch:
for batch in incremental_data:
    svi.step(batch)  # Update variational parameters
```

**Pros**: Handles complex models, scalable  
**Cons**: Approximate, requires careful tuning

---

#### C. MCMC with Warm Starts
**Approach**: Use previous posterior samples as initialization for new MCMC run

**Example** (PyMC):
```python
# Initial run
trace_old = pm.sample(1000)

# For new data:
with model:
    # Use previous trace as initialization
    trace_new = pm.sample(1000, initvals=trace_old[-1])
```

**Pros**: Exact inference, handles complex models  
**Cons**: Slower, requires storing previous samples

---

## 6. DagNet's Current Bayesian Infrastructure

### Existing Capabilities
Based on codebase analysis:

1. **Statistical Enhancement Service** (`statisticalEnhancementService.ts`)
   - ✅ MCMC support mentioned (`'mcmc'` method)
   - ✅ Bayesian complex support (`'bayesian-complex'` method)
   - ✅ Python backend integration (`lib/stats_enhancement.py`)

2. **Hierarchical Bayesian Models** (Documented in `docs/current/project-lag/archive/`)
   - ✅ Hierarchical survival model design documented
   - ✅ Context pooling across slices
   - ✅ Posterior summaries for latency parameters

3. **Incremental Data Handling**
   - ✅ Incremental fetch logic (`calculateIncrementalFetch`)
   - ✅ Gap detection and filling
   - ✅ Snapshot database for historical data

### Missing Pieces for Nightly Fitting

1. **Automated Nightly Jobs**
   - ❌ No scheduled job system
   - ❌ No batch processing infrastructure
   - ❌ No job queue or task scheduling

2. **Incremental Bayesian Updates**
   - ❌ No incremental posterior update logic
   - ❌ No warm start for MCMC chains
   - ❌ No variational inference with incremental updates

3. **Model Fit Storage**
   - ❌ No storage for posterior samples
   - ❌ No storage for model fit metrics
   - ❌ No versioning of fitted models

4. **Model Fit Evaluation**
   - ❌ No model fit metrics (WAIC, LOO, etc.)
   - ❌ No convergence diagnostics
   - ❌ No posterior predictive checks

---

## 7. Recommended Implementation Approach

### Phase 1: Foundation
1. **Extend Python Backend**
   - Add PyMC/Pyro integration for hierarchical survival models
   - Implement incremental data loading from snapshot DB
   - Add posterior storage (pickle or database)

2. **Add Nightly Job Infrastructure**
   - Scheduled job system (cron or task queue)
   - Batch processing for all parameters
   - Error handling and retry logic

3. **Implement Incremental Updates**
   - Sequential Bayesian updates for simple models
   - Warm-start MCMC for complex models
   - Variational inference for scalable updates

### Phase 2: Model Fit Evaluation
1. **Add Fit Metrics**
   - WAIC (Widely Applicable Information Criterion)
   - LOO (Leave-One-Out) cross-validation
   - Posterior predictive checks

2. **Add Convergence Diagnostics**
   - R-hat statistic
   - Effective sample size
   - Trace plots

3. **Add Model Comparison**
   - Compare different distribution families (log-normal vs. Weibull)
   - Compare hierarchical vs. non-hierarchical models
   - Model selection based on fit metrics

### Phase 3: Integration
1. **UI Integration**
   - Display model fit metrics in Properties Panel
   - Show posterior uncertainty bands
   - Visualize model fit quality

2. **Alerting**
   - Alert on poor model fit
   - Alert on convergence failures
   - Alert on significant parameter changes

---

## 8. Competitive Advantage

### Unique Positioning
**DagNet would be the first tool** to offer:
- ✅ **Automated nightly Bayesian model fitting** for conversion funnels
- ✅ **Incremental learning** from daily cohort data
- ✅ **Hierarchical Bayesian survival models** for latency
- ✅ **Integration** with live data sources (Amplitude, Sheets)
- ✅ **Version-controlled models** with Git-backed storage

### Market Opportunity
**Gap**: No existing tool combines:
- Conversion funnel modeling
- Bayesian inference
- Automated nightly fitting
- Incremental learning

**Competitive Moat**: 
- Deep integration with DagNet's data architecture
- Domain-specific models (hierarchical survival models)
- Version-controlled model storage
- Live data integration

---

## 9. Comparison Matrix

| Tool | Bayesian Inference | Nightly Fitting | Incremental Learning | Conversion Funnels | Domain-Specific |
|------|-------------------|-----------------|---------------------|-------------------|-----------------|
| **DagNet (Proposed)** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **PyMC** | ✅ | ⚠️ Custom | ⚠️ Custom | ❌ | ❌ |
| **Pyro** | ✅ | ⚠️ Custom | ⚠️ Custom | ❌ | ❌ |
| **Stan** | ✅ | ⚠️ Custom | ⚠️ Custom | ❌ | ❌ |
| **Optimizely** | ✅ | ❌ | ❌ | ⚠️ A/B tests | ⚠️ Experiments |
| **VWO** | ✅ | ❌ | ❌ | ⚠️ A/B tests | ⚠️ Experiments |
| **Amplitude** | ❌ | ❌ | ❌ | ✅ | ✅ |
| **Mixpanel** | ❌ | ❌ | ❌ | ✅ | ✅ |

**Legend**:
- ✅ = Native support
- ⚠️ = Requires custom implementation
- ❌ = Not supported

---

## 10. Recommendations

### Immediate Actions
1. **Research PyMC vs. Pyro**: Evaluate which framework better fits DagNet's needs
2. **Design Incremental Update Strategy**: Choose between sequential updates, warm-start MCMC, or VI
3. **Plan Job Infrastructure**: Design nightly batch processing system
4. **Prototype Model Fitting**: Build proof-of-concept for hierarchical survival model

### Long-Term Strategy
1. **Build Competitive Moat**: This would be a unique capability in the market
2. **Focus on Domain Expertise**: Leverage DagNet's deep understanding of conversion funnels
3. **Integrate Seamlessly**: Make Bayesian fitting feel native to DagNet's workflow
4. **Document Extensively**: This is advanced functionality that needs clear documentation

---

## Conclusion

**Finding**: No existing tool offers **automated nightly Bayesian model fitting** for conversion funnels with **incremental learning** capabilities.

**Opportunity**: DagNet would be **pioneering** this capability, creating a significant competitive advantage.

**Recommendation**: Proceed with implementation, focusing on:
1. PyMC/Pyro integration for hierarchical survival models
2. Incremental Bayesian update strategies
3. Nightly job infrastructure
4. Model fit evaluation and storage

This would position DagNet as the **only tool** offering temporal probability modeling with automated Bayesian inference for conversion funnels.
