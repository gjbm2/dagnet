# Data Connections Documentation

**Last Updated:** 2025-11-04  
**Status:** Active Development (Phase 0)

---

## 🗺️ Document Overview

This folder contains comprehensive documentation for DagNet's Data Connections system. Documents are organized by purpose:

### **📋 Start Here**

| Document | Purpose | Audience |
|----------|---------|----------|
| **[DATA_CONNECTIONS_IMPLEMENTATION_PLAN.md](./DATA_CONNECTIONS_IMPLEMENTATION_PLAN.md)** ⭐ | **Consolidated actionable plan** | Developers implementing features |

**Read this first** if you're building the system. It has everything you need:
- Current status & what's done
- Phase-by-phase tasks with file names
- Acceptance criteria
- Risk mitigation
- Next actions

---

### **📖 Reference Specifications**

| Document | Purpose | When to Read |
|----------|---------|--------------|
| [DATA_CONNECTIONS.md](./DATA_CONNECTIONS.md) | **Main specification** | Understanding overall architecture |
| [QUERY_EXPRESSION_SYSTEM.md](./QUERY_EXPRESSION_SYSTEM.md) | **Query DSL & algorithms** | Implementing query parser, MSMDC, batch optimization |
| [QUERY_SELECTOR_DESIGN.md](./QUERY_SELECTOR_DESIGN.md) | **UI component design** | Building query editor or similar components |

---

### **🔍 Deep Dives**

| Document | Purpose | When to Read |
|----------|---------|--------------|
| [DATA_CONNECTIONS_SCHEMA_VALIDATION.md](./DATA_CONNECTIONS_SCHEMA_VALIDATION.md) | **Schema design & validation** | Working on schemas, resolving data issues |
| [DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md](./DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md) | **Design rationale** | Understanding "why" behind decisions |

---

## 🚀 Quick Start

### **For Developers**

1. Read [DATA_CONNECTIONS_IMPLEMENTATION_PLAN.md](./DATA_CONNECTIONS_IMPLEMENTATION_PLAN.md)
2. Check "Current Status" to see what's done
3. Look at current phase tasks
4. Pick a task and implement
5. Update checkboxes as you go

### **For Reviewers**

1. Read [DATA_CONNECTIONS.md](./DATA_CONNECTIONS.md) — Executive Summary
2. Review [DATA_CONNECTIONS_IMPLEMENTATION_PLAN.md](./DATA_CONNECTIONS_IMPLEMENTATION_PLAN.md) — Phase breakdown
3. Check specific specs as needed

### **For Product/Design**

1. [DATA_CONNECTIONS.md](./DATA_CONNECTIONS.md) — Section 2 (User Interface)
2. [QUERY_SELECTOR_DESIGN.md](./QUERY_SELECTOR_DESIGN.md) — UI component specs

---

## 📊 System Architecture (High Level)

```
┌─────────────────────────────────────────────────────────┐
│                     User Interface                       │
│  • EnhancedSelector (connect/selector)                  │
│  • QueryExpressionEditor (query/selector) ✓ BUILT       │
│  • Top Menu "Data" (batch operations)                   │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│              Data Connection Services                    │
│  • DataConnectionService (pull/push/retrieve)           │
│  • BatchDataConnectionService (async batch ops)         │
│  • QueryFactorization (optimize N → M queries)          │
│  • FieldMapper (graph ↔ param mapping)                  │
└────────────────────┬────────────────────────────────────┘
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
┌─────────────────────┐  ┌─────────────────────┐
│ Data Source         │  │ Data Source         │
│ Connectors          │  │ Connectors          │
│                     │  │                     │
│ • GoogleSheets      │  │ • Amplitude         │
│ • (Future: more)    │  │ • (Future: more)    │
└─────────────────────┘  └─────────────────────┘
```

---

## 🎯 Current Status

### ✅ Completed

- [x] Query Expression DSL defined
- [x] MSMDC algorithm documented
- [x] Query factorization algorithm documented
- [x] QueryExpressionEditor component built & integrated
- [x] Dual-mode UI (Monaco ↔ Chips)
- [x] Context-aware autocomplete
- [x] All core documentation complete

### 🚧 In Progress (Phase 0)

- [ ] Schema updates (parameter, graph, node)
- [ ] Events registry implementation
- [ ] Credentials schema updates

### 📋 Next Up (Phase 1)

- [ ] Query parser service
- [ ] MSMDC algorithm implementation
- [ ] Data connection services
- [ ] Google Sheets connector
- [ ] Amplitude connector (basic)

**Timeline:** Phase 0 (2-3 days) → Phase 1 (5-7 days) → Phase 2 (5-7 days)

---

## 🔑 Key Concepts

### **Query Expression DSL**

Compact language for defining data retrieval constraints:

```
from(checkout).to(purchase).exclude(abandoned-cart)
```

- **from/to:** Define path endpoints
- **exclude:** Nodes to avoid
- **visited:** Nodes that must be on path
- **case:** Filter by experiment variant

### **MSMDC Algorithm**

**Minimal Set of Maximally Discriminating Constraints**

Given multiple paths between nodes, automatically generates the minimal set of constraints needed to uniquely identify the target path.

**Example:**
```
Paths: A→B→D, A→C→D, A→D
Target: A→D (direct)
Result: exclude(B,C)
```

Uses Set Cover algorithm to find optimal constraints.

### **Query Factorization**

Batch optimization that reduces N separate API queries to M queries where M ≪ N.

**Example:**
```
Naive: 50 parameters → 50 Amplitude API calls
Optimized: 50 parameters → 8 API calls (84% reduction)
```

Uses query subsumption to find minimal covering set.

### **Dual-Mode UI**

Components that switch between edit and view modes:

- **View:** Color-coded chips (visual, readable)
- **Edit:** Monaco editor (powerful, autocomplete)
- **Behavior:** Click to edit, blur to view

---

## 🧪 Testing

### **Unit Tests**

- Query parser (all syntax variants)
- MSMDC algorithm (various graph topologies)
- Field mapper (all parameter types)
- Connectors (mocked responses)

**Target:** 80%+ coverage

### **Integration Tests**

- End-to-end data flows
- Batch operations
- Error handling

### **Manual Testing**

See [DATA_CONNECTIONS_IMPLEMENTATION_PLAN.md](./DATA_CONNECTIONS_IMPLEMENTATION_PLAN.md) — Testing Strategy

---

## 📝 Contributing

### **Adding Documentation**

1. Keep specs focused (one concern per doc)
2. Use tables, diagrams, code examples
3. Link between documents liberally
4. Update this README when adding new docs

### **Updating Implementation Plan**

1. Check off tasks as completed: `- [ ]` → `- [x]`
2. Add actual effort vs. estimated
3. Document blockers or issues
4. Update "Current Status" section

### **Coding Standards**

See implementation plan for:
- File naming conventions
- Service architecture
- Error handling patterns
- Testing requirements

---

## ❓ FAQ

### **Q: Where do I start implementing?**

A: Read [DATA_CONNECTIONS_IMPLEMENTATION_PLAN.md](./DATA_CONNECTIONS_IMPLEMENTATION_PLAN.md), check "Current Status", pick the next unchecked task.

### **Q: How does the query language work?**

A: See [QUERY_EXPRESSION_SYSTEM.md](./QUERY_EXPRESSION_SYSTEM.md) — Section 3 (Query Expression DSL).

### **Q: What's the MSMDC algorithm?**

A: See [QUERY_EXPRESSION_SYSTEM.md](./QUERY_EXPRESSION_SYSTEM.md) — Section 4 (MSMDC Algorithm). TL;DR: Automatically generates minimal constraints to uniquely identify a path.

### **Q: How do I build a similar component?**

A: See [QUERY_SELECTOR_DESIGN.md](./QUERY_SELECTOR_DESIGN.md) — Component Architecture section. QueryExpressionEditor is the reference implementation.

### **Q: Why do we need so many documents?**

A: Each serves a specific purpose:
- **Implementation Plan:** What to build (actionable)
- **Specifications:** How it works (reference)
- **Design Docs:** Why this way (rationale)

### **Q: What if specs conflict?**

A: [DATA_CONNECTIONS_IMPLEMENTATION_PLAN.md](./DATA_CONNECTIONS_IMPLEMENTATION_PLAN.md) is the source of truth. If you find conflicts, update the plan and note the decision in [DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md](./DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md).

---

## 🔗 External Resources

### **Google Sheets API**
- [Service Account Auth](https://developers.google.com/sheets/api/guides/authorizing)
- [Reading Values](https://developers.google.com/sheets/api/guides/values)
- [Batch Operations](https://developers.google.com/sheets/api/guides/batchupdate)

### **Amplitude API**
- [Funnel Analysis](https://developers.amplitude.com/docs/dashboard-rest-api#funnels)
- [Event Segmentation](https://developers.amplitude.com/docs/dashboard-rest-api#event-segmentation)
- [Rate Limits](https://developers.amplitude.com/docs/analytics-api#rate-limits)

### **Graph Theory**
- [Set Cover Problem](https://en.wikipedia.org/wiki/Set_cover_problem)
- [Hitting Set Problem](https://en.wikipedia.org/wiki/Hitting_set)
- [Greedy Approximation](https://en.wikipedia.org/wiki/Greedy_algorithm)

---

## 📧 Contact

For questions about this system, ask in:
- `#dagnet-dev` (Slack)
- Implementation plan discussions (GitHub)

---

**Last Updated:** 2025-11-04  
**Next Review:** After Phase 0 completion

---

**End of Document**

