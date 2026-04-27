# DagNet Competitive Analysis

**Date**: 3-Feb-26  
**Purpose**: Research and document existing tools that DagNet competes with or complements

---

## Executive Summary

DagNet operates in a **hybrid competitive space** spanning multiple tool categories:

1. **Product Analytics Platforms** (primary competitors)
2. **Business Intelligence Tools** (partial overlap)
3. **Graph Visualization & Modeling Tools** (complementary/adjacent)
4. **Probabilistic Modeling Software** (specialized niche)

**Key Differentiator**: DagNet uniquely combines **temporal probability modeling** with **live data integration** and **version-controlled, shareable models** — a combination not found in existing tools.

---

## 1. Product Analytics Platforms (Primary Competitors)

### Amplitude
**Position**: Market leader in product analytics  
**Overlap**: Conversion funnel analysis, cohort tracking, event-based analytics  
**DagNet's Advantage**:
- **Time-indexed flow (latency)**: Amplitude shows static conversion rates; DagNet models "when" conversions happen
- **Evidence vs. Forecast split**: DagNet separates observed vs. projected conversions
- **What-if scenario comparison**: side-by-side scenario modeling
- **A/B test allocation modeling**: experiment variants as first-class cases
- **Conditional probabilities**: path-dependent probabilities (`visited()`, `exclude()`)
- **Path-aware reach analysis**: reach through complex multi-path graphs
- **Shareable live dashboards**: version-controlled and shareable via Git

**Key Quote from Codebase**:
> "A funnel in Amplitude is a query; a funnel in DagNet is a **model**."

**Integration**: DagNet **integrates with** Amplitude as a data source, positioning it as a modeling layer on top of Amplitude's analytics.

---

### Mixpanel
**Position**: Real-time product analytics with strong funnel analysis  
**Overlap**: Multi-step funnels, cohort analysis, user journey tracking  
**DagNet's Advantage**:
- **Temporal modeling**: Mixpanel tracks conversions but doesn't model latency distributions
- **Probabilistic modeling**: uncertainty and conditional dependencies
- **Scenario comparison**: systematic what-if analysis
- **Model versioning**: Git-backed and version-controlled
- **Graph-based modeling**: DAGs for complex branching paths

**Integration**: Similar to Amplitude, DagNet could integrate with Mixpanel as a data source.

---

### Heap Analytics
**Position**: Auto-capture analytics (retroactive funnel building)  
**Overlap**: Event tracking, funnel analysis  
**DagNet's Advantage**:
- **Modeling vs. querying**: Heap builds funnels retroactively; DagNet builds forward-looking models
- **Temporal dynamics**: Heap doesn't model latency or cohort maturation
- **Probabilistic calculations**: probability mass calculations and uncertainty modeling
- **Shareable models**: shareable artifacts, not just dashboards

---

### Google Analytics 4 (GA4)
**Position**: Web analytics and e-commerce funnel tracking  
**Overlap**: Basic funnel analysis, conversion tracking  
**DagNet's Advantage**:
- **Advanced modeling**: GA4 is limited to 10-step funnels; DagNet supports unlimited complexity
- **Temporal modeling**: GA4 doesn't model latency or time-to-convert
- **Conditional logic**: conditional probabilities and path dependencies
- **What-if analysis**: scenario modeling and parameter overrides

---

## 2. Business Intelligence Tools (Partial Overlap)

### Looker (Google Cloud)
**Position**: Enterprise BI platform with data modeling  
**Overlap**: Data visualization, dashboarding, data modeling  
**DagNet's Advantage**:
- **Temporal probability modeling**: Looker doesn't model probabilistic flows or latency
- **Graph-based modeling**: DAGs for structural modeling
- **Evidence vs. Forecast**: separates observed vs. projected data
- **Scenario comparison**: systematic what-if analysis
- **Model versioning**: Git-backed and reviewable

**Complementary**: Looker could be used alongside DagNet for broader BI needs, with DagNet handling conversion funnel modeling.

---

### Tableau
**Position**: Data visualization and analytics platform  
**Overlap**: Data visualization, dashboarding, analytics  
**DagNet's Advantage**:
- **Specialized domain**: purpose-built for conversion funnel modeling
- **Temporal modeling**: Tableau doesn't model latency or cohort maturation
- **Probabilistic calculations**: probability mass and uncertainty modeling
- **Graph-based modeling**: DAGs for structural representation

**Complementary**: Tableau could visualize DagNet's outputs, but doesn't compete directly on modeling capabilities.

---

### Power BI (Microsoft)
**Position**: Enterprise BI and analytics platform  
**Overlap**: Data visualization, dashboarding, analytics  
**DagNet's Advantage**:
- Similar to Tableau — DagNet specializes in probabilistic funnel modeling
- **Temporal dynamics**: Power BI doesn't model latency or time-indexed flows
- **Scenario modeling**: systematic what-if analysis

---

## 3. Graph Visualization & Modeling Tools (Adjacent)

### DAGitty
**Position**: Browser-based causal diagram editor  
**Overlap**: DAG editing, causal modeling  
**DagNet's Advantage**:
- **Temporal modeling**: DAGitty focuses on causal structure, not temporal dynamics
- **Data integration**: live data sources (Amplitude, Sheets)
- **Probabilistic calculations**: probability mass and uncertainty modeling
- **Scenario modeling**: what-if analysis and parameter overrides
- **Version control**: Git-backed and shareable

**Complementary**: DAGitty focuses on causal inference; DagNet focuses on conversion funnel modeling with live data.

---

### yEd / draw.io / Lucidchart
**Position**: General-purpose diagramming tools  
**Overlap**: Graph visualization, node-edge editing  
**DagNet's Advantage**:
- **Domain-specific modeling**: general tools vs. purpose-built for conversion funnels
- **Data integration**: live data sources
- **Probabilistic calculations**: probability and latency modeling
- **Scenario modeling**: what-if analysis
- **Version control**: Git-backed

**Complementary**: These tools could be used for initial graph design, then imported into DagNet for analysis.

---

### Gephi / Cytoscape
**Position**: Network analysis and visualization tools  
**Overlap**: Graph visualization, network analysis  
**DagNet's Advantage**:
- **Domain-specific**: general network analysis tools vs. purpose-built for conversion funnels
- **Temporal modeling**: don't model latency or cohort maturation
- **Data integration**: live data sources
- **Probabilistic calculations**: probability mass and uncertainty modeling

**Complementary**: These tools focus on network analysis; DagNet focuses on conversion funnel modeling.

---

## 4. Probabilistic Modeling Software (Specialized Niche)

### aGrUM / pyAgrum
**Position**: Comprehensive probabilistic graphical model platform  
**Overlap**: Bayesian networks, decision trees, probabilistic inference  
**DagNet's Advantage**:
- **Domain-specific**: aGrUM is general-purpose; DagNet is purpose-built for conversion funnels
- **Data integration**: live data sources (Amplitude, Sheets)
- **Temporal modeling**: latency and cohort maturation
- **User-friendly interface**: visual graph editing vs. programmatic approach
- **Version control**: Git-backed and shareable

**Complementary**: aGrUM could be used for advanced probabilistic inference; DagNet focuses on conversion funnel modeling with live data.

---

### OpenMarkov
**Position**: Open-source probabilistic graphical model editor  
**Overlap**: Bayesian networks, influence diagrams, decision trees  
**DagNet's Advantage**:
- **Domain-specific**: OpenMarkov is general-purpose; DagNet is purpose-built for conversion funnels
- **Data integration**: live data sources
- **Temporal modeling**: latency and cohort maturation
- **Modern web interface**: web-based visual editing
- **Version control**: Git-backed and shareable

---

### pgmpy
**Position**: Python library for probabilistic graphical models  
**Overlap**: Bayesian networks, causal inference, probabilistic inference  
**DagNet's Advantage**:
- **Domain-specific**: pgmpy is a library; DagNet is a complete application
- **Data integration**: live data sources
- **Temporal modeling**: latency and cohort maturation
- **User-friendly interface**: visual graph editing vs. programmatic approach
- **Version control**: Git-backed and shareable

**Complementary**: pgmpy could be used for advanced probabilistic inference; DagNet focuses on conversion funnel modeling with live data.

---

## Competitive Positioning Matrix

| Tool Category | Primary Function | Temporal Modeling | Data Integration | Scenario Modeling | Model Versioning |
|---------------|------------------|-------------------|------------------|-------------------|------------------|
| **DagNet** | Conversion funnel modeling | Latency-aware | Live data (Amplitude, Sheets) | What-if scenarios | Git-backed |
| **Amplitude** | Product analytics | Static rates | Event tracking | Limited | Dashboard-only |
| **Mixpanel** | Product analytics | Static rates | Event tracking | Limited | Dashboard-only |
| **Looker** | Business intelligence | No temporal modeling | Data warehouse | Limited | LookML versioning |
| **Tableau** | Data visualization | No temporal modeling | Data connectors | Limited | Workbook versioning |
| **DAGitty** | Causal diagrams | No temporal modeling | No integration | No scenarios | File-based |
| **aGrUM** | Probabilistic models | No temporal modeling | No integration | No scenarios | File-based |

---

## Key Differentiators

### 1. **Temporal Probability Modeling**
- **Unique**: models **latency distributions** and **cohort maturation**
- **Competitors**: most show static conversion rates without temporal dynamics
- **Value**: Answers "When will users convert?" not just "What is the conversion rate?"

### 2. **Evidence vs. Forecast Separation**
- **Unique**: separates **observed evidence** from **projected forecasts**
- **Competitors**: most blend observed and projected data
- **Value**: uncertainty-aware decision making

### 3. **Model-First Approach**
- **Unique**: treats funnels as **version-controlled models**, not just queries
- **Competitors**: most treat funnels as queries or dashboards
- **Value**: Models can be reviewed, shared, and versioned like code

### 4. **Graph-Based Probabilistic Modeling**
- **Unique**: **DAGs with conditional probabilities** for complex branching
- **Competitors**: most support linear funnels or simple branching
- **Value**: complex user journeys with path dependencies

### 5. **Live Data Integration with Modeling**
- **Unique**: integrates **live data sources** (Amplitude, Sheets) with **probabilistic modeling**
- **Competitors**: focus on data (analytics tools) or modeling (probabilistic tools), not both
- **Value**: Models stay up-to-date with real data while maintaining probabilistic structure

### 6. **Systematic Scenario Comparison**
- **Unique**: **side-by-side scenario comparison** with parameter overrides
- **Competitors**: limited what-if analysis
- **Value**: systematic exploration of "what happens if X changes?"

---

## Market Positioning

### Primary Use Case
**"Probabilistic, latency-aware funnel simulation for product and growth teams"**

### Target Audience
1. **Product Managers**: Modeling user journeys and conversion funnels
2. **Growth Teams**: Optimizing conversion paths and A/B testing
3. **Data Scientists**: Probabilistic modeling with live data integration
4. **Analytics Teams**: Moving beyond static dashboards to dynamic models

### Competitive Strategy
1. **Complement, Don't Replace**: Position as a **modeling layer** on top of analytics tools (Amplitude, Mixpanel)
2. **Specialize**: Focus on **temporal probability modeling** rather than general analytics
3. **Differentiate**: Emphasize **model versioning**, **scenario comparison**, **evidence vs. forecast**
4. **Integrate**: Integrate with existing data sources rather than replacing them

---

## Gaps in the Market

### What's Missing
1. **Temporal Modeling**: No existing tool models latency distributions in conversion funnels
2. **Model Versioning**: Most tools treat funnels as queries, not version-controlled models
3. **Evidence vs. Forecast**: Most blend observed and projected data without separation
4. **Graph-Based Probabilistic Modeling**: Most support linear funnels, not complex DAGs
5. **Live Data + Modeling**: Most focus on data (analytics) or modeling (probabilistic tools), not both

### DagNet's Opportunity
DagNet fills a **unique niche** combining:
- **Product analytics** (like Amplitude/Mixpanel)
- **Probabilistic modeling** (like aGrUM/pgmpy)
- **Graph visualization** (like DAGitty/yEd)
- **Version control** (like Git)
- **Temporal dynamics** (unique to DagNet)

---

## Competitive Threats

### Potential Competitors
1. **Amplitude/Mixpanel adding temporal modeling**: could add latency modeling features
2. **Looker/Tableau adding probabilistic modeling**: could add probability and scenario features
3. **New entrants**: startups focusing on temporal funnel modeling

### Defensive Advantages
1. **First-mover advantage**: early in temporal probability modeling space
2. **Deep integration**: complex integration with data sources and modeling algorithms
3. **Open source**: Git-backed models enable community and ecosystem development
4. **Domain expertise**: deep understanding of conversion funnel modeling

---

## Conclusion

DagNet operates in a **hybrid competitive space** with no direct competitors offering the same combination of:

- Temporal probability modeling
- Live data integration
- Graph-based probabilistic modeling
- Model versioning and sharing
- Evidence vs. forecast separation
- Systematic scenario comparison

**Positioning**: DagNet is best positioned as a **specialized modeling tool** that **complements** existing analytics platforms (Amplitude, Mixpanel) rather than replacing them, while offering capabilities not available in general-purpose BI tools (Looker, Tableau) or probabilistic modeling software (aGrUM, pgmpy).

**Key Message**: 
> "DagNet is the only tool that combines temporal probability modeling with live data integration and version-controlled, shareable models — enabling product and growth teams to answer 'When will users convert, and what happens if we change X?'"
