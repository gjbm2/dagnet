Below is a **consolidated, structured, technically precise summary** of all our prior discussions about *latency, lags, and the statistical treatment of daily n/k evidence* as it applies to the **DAG-based conversion-funnel tool**, including how they integrate with the graph schema (e.g., the JSON schema you uploaded ).

---

# ⭐ Comprehensive Summary of Our Discussions on Latency, Lags & Daily n/k Evidence

This summary ties together the conceptual threads we have been developing for weeks:

* How *lagged* conversion evidence is represented statistically
* How we build a generative model for per-node latency
* How this integrates with the DAG runner
* How partial-cohort forecasting works (fan charts)
* How Amplitude's daily n/k slices inform a Bayesian posterior
* How we will ultimately “convolve” these latency models onto the graph

The discussion breaks down into **six conceptual areas**.

---

# 1. **Motivation: Why Latency Modeling Matters in a DAG Funnel**

The DAG already handles **structural flow**: nodes are states; edges are conditional transitions; outgoing edges partition probability mass (with residual-to-default as defined in the schema).

However, for forecasting and analytics we need **temporal behaviour**:

* Users seldom transition within a single day.
* Each *node → edge → node* transition has a *lag distribution*.
* Amplitude data provides **daily n/k** evidence for *“how many of the cohort have completed this step after t days”*.

Thus we need a **latency engine** that:

1. Learns **lag distributions** from daily partial conversion data
2. Allows **forward convolutions** of flow × lag to compute expected arrivals at each node over time
3. Allows **forecasting** of partially observed cohorts
4. Supports **scenario comparison** on latency assumptions

You explicitly want this **declarative**: latency distributions should be first-class parameters, not embedded algorithmically into the runner.

---

# 2. **Statistical Model We Agreed Is Likely Correct**

Throughout the discussions, you kept returning to two core statistical concepts:

### 2.1. **Daily n/k slices define a latent CDF**

* For a node transition, each day `t` gives:

  * `n_t` = exposure up to day t
  * `k_t` = number having transitioned
* These imply an empirical CDF for transition completion times.
* Across channels or contexts, these are hierarchical slices.

### 2.2. **Each slice has its own binomial likelihood**

For each slice (e.g., by channel):

[
k_t \sim \text{Binomial}(n_t, F(t))
]

Where:

* ( F(t) ) is the cumulative probability that a user has completed the transition by lag t.

### 2.3. **Parametric form: Survival / latency distribution**

We identified plausible distributions:

* **Log-Normal**
* **Weibull**
* **Gamma**
* **Discrete hazard model** (non-parametric)

Your key realisation:

> Splitting into slices gives more information than naive pooling
> — you get multiple independent binomial curves pointing to the *same underlying distribution*.

Thus the natural model is:

### 2.4. **Hierarchical Bayesian Survival Model**

For a transition:

[
\theta_c \sim \text{(hierarchical prior)}
]
[
F_c(t) = F(t \mid \theta_c)
]
[
k_{c,t} \sim \text{Binomial}(n_{c,t}, F_c(t))
]

Where:

* (c) indexes context slices (channel, campaign, cohort window, platform)
* (\theta_c) is the param set for the latency distribution for that slice
* Hyperpriors pool information across contexts

We discussed NUTS/MCMC with hierarchical pooling as *tractable* because:

* Params per distribution are tiny (2–3)
* Context slices ~10–20
* Nodes ~50

So the entire posterior sampling is totally feasible.

---

# 3. **Convolving Latency onto the DAG**

Once each edge has a posterior latency distribution (f_{edge}(t)), we need to:

* propagate daily mass forward through the DAG
* compute expected arrivals at nodes over time
* allow partial cohort forecasting with fan charts

We agreed on this mathematical structure:

### 3.1. **Forward pass is a series of discrete convolutions**

If (x_{node}(t)) is the inflow at node N on day t, and the edge N→M has latency pmf (L(\tau)), then:

[
x_{M}(t) = \sum_{\tau=0}^{t} x_{N}(t - \tau), p(N\to M), L(\tau)
]

Where:

* (p(N\to M)) is the structural probability from the graph JSON
* (L(\tau)) is the lag distribution inferred from Amplitude daily n/k

This gives:

* **Node arrival curves**
* **Edge flow curves**
* **Absorbing outcome projections**

And everything is time-indexed.

### 3.2. **Monte Carlo version**

To get uncertainty bands:

1. Sample parameters of each latency distribution from the posterior.
2. Generate a discrete pmf for each edge.
3. Propagate mass through the DAG.
4. Aggregate results over runs → fan charts.

This matches your desire for partial-cohort forecasting with confidence bands.

---

# 4. **Handling Partial Cohorts Cleanly**

This has been a major theme.

Your requirement:

> When a cohort is only partially mature, we want the forecast to respect actual observed k/n and then use inference to project the tail.

This leads to:

### 4.1. **Observed data overrides model pre-lag**

For days 0..T where we have k/n data:

* We compute the likelihood contribution to update posterior
* But the forecast uses the **actual cumulative conversions**, not the model

### 4.2. **Forecasting uses the posterior for T+1 onward**

For future days:

[
\hat{F}(t) = \mathbb{E}[F(t) \mid \text{posterior}]
]

We explicitly noted:

* Actual data vs forecast must be visually distinguished (solid vs dashed lines)
* The UI needs to be declarative: user does not manually specify “fetch full k/n”; the system infers it from the cohort window

---

# 5. **Latencies Exist Outside the Graph Definition**

Another critical theme:

* The DAG JSON defines **structural** probabilities and topology.
* Lag models and Amplitude daily k/n evidence belong to **external parameter sets** ("scenarios").

You said:

> We have k/n evidence blocks in the params beneath the graph but do not import them into the graph.

So the clean architecture is:

```
Graph JSON (static, structural)
Scenario JSON
    - latency_models (priors or posteriors)
    - amplitude_daily_data (n/k by day by context)
    - forecasting windows
    - posterior samples
```

The runner takes:

```
Graph + Scenario → Time-indexed flows
```

This keeps the DAG clean and declarative.

---

# 6. **What Statistical Approach Makes the Most Sense? (Final Answer)**

Based on all our discussions, the statistically correct and practical approach is:

## ✅ **A hierarchical Bayesian survival model for each edge**, inferred from daily n/k Amplitude data sliced by context.

### Why hierarchical?

* Context slices (e.g., channels) share shape
* Shrinkage reduces variance for low-data slices
* Allows scenario-level priors

### Why survival / lag modeling?

* Daily n/k data directly expresses cumulative completion curves
* Convolution onto DAG requires pmf/cdf

### Why Bayesian?

* Natural handling of partial cohorts
* Natural generation of uncertainty bands
* Strong priors improve stability for low-volume nodes
* Works cleanly with our Monte-Carlo DAG runner

### Why convolution?

* It integrates latency into conversion flow correctly
* Supports:

  * time-indexed forecasting
  * per-node arrival curves
  * absorbing-outcome predictions
  * scenario comparison

### Expected modelling objects for each edge:

* (p(edge)): from the graph JSON
* (L(t)): inferred lag distribution for the step
* Convolution: to propagate flow forward
* Posterior samples: for uncertainty

This is the architecture we kept converging to.

---
