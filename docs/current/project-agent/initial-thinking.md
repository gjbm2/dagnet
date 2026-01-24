# Project Agent: Initial Thinking (Directional Notes)

Date: 24-Jan-26

## What we’re trying to solve

We want an **agent mode** inside DagNet that lets users interact with a LLM agent to **inspect, analyse, and (eventually) adapt** a graph and its supporting artefacts (nodes, parameters, events, indexes, and related documentation).

The intended “shape” is similar to tools like Cursor:

- **Conversation-driven**: user asks a goal-oriented question.
- **Tool-driven**: the agent gathers evidence by calling well-defined tools (rather than inventing answers).
- **Reviewable**: the agent can propose changes, but the user remains in control.
- **Auditable**: the system records what the agent saw, what it did, and why.

We will phase this to keep it manageable and safe:

- **Phase 0 (preparatory)**: foundations that make the agent reliable even in read-only mode.
- **Phase 1 (read-only agent)**: high-value diagnostics and exploration without mutation.
- **Phase 2 (write capability)**: gated change proposals and controlled application of edits.

## Core posture (principles)

- **Read-only by default**: in early phases the agent cannot mutate state.
- **Services are the single source of truth**: UI is an access point; orchestration and graph/file logic lives in services.
- **Tool outputs are evidence**: answers should be grounded in explicit artefacts (node IDs, param IDs, event IDs, file paths).
- **Deterministic change bundles**: when we add write capability, the agent should produce a reviewable bundle of intended changes before anything is applied.
- **Session logging is non-negotiable**: agent operations must be logged like other external/data operations.

## Main functional components (overview)

### 1) Agent UI surface (chat + evidence + proposals)

The UI should provide:

- **Chat thread**: prompts, tool progress, and final responses.
- **Evidence pane**: what the agent looked at (graph snapshot details, referenced files/IDs, analysis outputs).
- **Proposals pane (later)**: a structured “what would change” view with explicit user approval and clear apply/cancel.

Important: the UI should not contain business logic. It should call a single service boundary.

### 2) Agent orchestration service (the roundtrip loop)

A dedicated service (directional name: `agentOperationsService`) that:

- Owns the **conversation state** and “current scope” (which workspace/branch/subgraph is in play).
- Runs the **tool roundtrip loop** (model → tool calls → tool results → model).
- Enforces policies:
  - phase-specific capability flags (read-only vs propose-only vs apply)
  - maximum tool iterations per user request
  - timeouts / retries per tool
- Produces consistent artefacts for the UI:
  - progress events
  - citations/evidence references
  - (later) a structured change bundle

### 3) MCP server (tool surface for the agent)

An MCP server (local to the app) that provides:

- **Read tools** to fetch graph/param/event context in targeted slices.
- **Analysis tools** for domain-specific questions (e.g. conservation diagnostics).
- **(Later) write tools** that apply changes via existing internal services rather than raw file edits.

The MCP server should be treated as a narrow, deliberate “capability boundary”.

### 4) Context retrieval and packaging layer

We will need a small internal layer that turns “what the agent needs” into bounded, relevant context:

- **Summaries first** (graph outline and key stats), then targeted drills (node/param/event by ID, neighbourhood traversal, etc.).
- Avoid “dump the world” prompts; prefer retrieval that can explain itself (“I loaded nodes A/B/C because…”).
- Track provenance so answers can be grounded and reviewable.

### 5) Policy, safety, and approvals

Even for read-only mode, we need:

- **Clear operational modes**:
  - read-only (Phase 1)
  - propose-only (early Phase 2)
  - apply (later Phase 2, behind explicit approval)
- **Injection-aware design**: treat graph content and workspace files as potentially untrusted instructions.
- **No silent mutation**: when write tools exist, every change should be explicitly approved and clearly explained.

### 6) Logging, audit trail, and reproducibility

Agent operations should create a durable record of:

- user request
- tool calls made and outputs received
- final response / diagnosis
- (later) proposed bundle and whether it was applied

This is essential for:

- debugging agent failures
- user trust (“why did it do that?”)
- regression detection as prompts/models evolve

### 7) Evaluation harness (practical correctness)

To avoid “it feels good” but unreliable behaviour, we will likely need:

- a small set of representative tasks (e.g. conservation failures, variant promotions, event tracing)
- a way to run them and compare outputs across prompt/model/tool changes
- “known-good” ground truth for at least the key diagnostics

This can begin lightweight in Phase 1 and grow over time.

## Key design patterns (directional)

- **State machine orchestration**: treat the agent roundtrip as a bounded loop with explicit stop conditions.
- **Structured tool contracts**: strict schemas for tool inputs/outputs; reject malformed requests early.
- **Capability gating**: phase-specific flags enforced centrally (not scattered across UI).
- **Propose → review → apply**: do not allow an agent to “just do it” when changes are involved.
- **Single mutation path**: changes flow through existing services to preserve invariants (dirty tracking, index rules, persistence).
- **Small-scope context**: retrieval by need, with provenance, rather than full-workspace prompts.

## Phased approach (directional plan)

### Phase 0: Preparatory capabilities (make Phase 1 reliable)

Aim: build foundations so that a read agent is useful, grounded, and debuggable.

- **Tooling foundations**
  - Define the MCP tool surface for read-only inspection and analysis.
  - Establish consistent IDs and stable addressing for nodes/params/events in tool APIs.
- **Context + provenance**
  - Define how the agent “cites” artefacts back to the UI (node IDs, file paths, etc.).
  - Establish bounded retrieval patterns (summaries, targeted fetch, graph traversal).
- **Session logging**
  - Add structured session logs for agent operations and tool calls.
- **Operational constraints**
  - Timeouts, iteration limits, and error handling semantics for tool loops.

Deliverable character: no fancy UX; we can run the orchestration loop and get grounded read answers with an audit trail.

### Phase 1: Read-only agent (high-value inspection + diagnostics)

Aim: deliver immediate user value without mutation risk.

- **Chat UI** with evidence visibility and clear “what the agent did” trace.
- **Read tools**: graph snapshot access, node/param/event fetching, branch traversal, search.
- **Analysis tools**: conservation diagnostics and related graph reasoning tools.
- **Explainability posture**
  - Agent answers should be evidence-backed (“based on nodes X/Y and param Z…”).
  - Where it cannot be sure, it should say so and suggest what to inspect next.

#### Phase 1 cornerstone: event stream inspection (graph-shape discovery)

The biggest “new” value we can provide (beyond reading local graph files) is letting the agent inspect the **real event stream** for a given household (or equivalent identifier) and reason about what graph branch/path is actually being exercised.

Key characteristics:

- Event volumes per query should be modest and bounded (typically seconds of agent time, not minutes).
- The agent should be able to answer questions like:
  - “Which events did this household emit in the last session?”
  - “Which branch does this event sequence correspond to?”
  - “Which expected events are missing (instrumentation gaps)?”
  - “Which events are responsible for entering this node/branch?”

Directionally, we treat “events” as a first-class external data source behind a single internal service boundary.

##### Internal service boundary: `eventStreamService` (directional)

We introduce a dedicated service that:

- Connects to providers (e.g. Amplitude, Segment) and retrieves event timelines for a single household/user within a time window.
- Normalises provider-specific payloads into a **provider-agnostic event shape** suitable for analysis.
- Enforces safety and operability constraints:
  - mandatory time windows and result limits
  - property allowlists/redaction (to avoid accidental leakage of sensitive fields)
  - rate limiting / backoff
  - environment separation (prod vs dev) and explicit provenance

##### MCP tool surface (read-only)

Expose the minimum set of event tools needed for inspection and flow reasoning:

- **Discovery**: list configured providers and capabilities.
- **Fetch**: retrieve a timeline for `(provider, household_id, from, to, limit)`.
- **Session view** (optional): retrieve a single session’s event sequence if the provider supports session identity.
- **Search** (optional): filter the timeline by event name/property predicates.

Important: tools should return data in a stable, bounded format with clear provenance (provider, window, query parameters).

##### Linking events ↔ graph semantics (analysis patterns)

The agent can provide “graph-shape discovery” by combining the timeline with read access to graph/param artefacts:

- **Event-to-graph reference mapping**: identify which nodes/params/branch conditions reference or depend on specific events.
- **Branch attribution**: infer which branch conditions were satisfied by the observed sequence (clearly labelled as inference, not certainty, unless the graph model makes it deterministic).
- **Missing expected events**: highlight when the graph expects events that are absent in the timeline.
- **Path reconstruction**: explain the most plausible graph path taken by the household during the window.

Deliverable character: “assistant investigator” that can answer “why” and “where”, and can connect observed reality (events) to intended logic (graph) with clear evidence.

Deliverable character: “assistant investigator” that can answer “why” and “where”, and help users navigate complex graphs quickly.

### Phase 2: Add write capability (controlled, reviewable adaptation)

Aim: allow safe graph changes without eroding trust or breaking invariants.

Start with **propose-only**, then add apply:

- **Propose-only**
  - Agent produces a structured change bundle (what would change, why, and expected impact).
  - UI supports review, with explicit accept/reject.
- **Apply (gated)**
  - Apply changes only through existing service boundaries.
  - Run post-change validations (schemas, index correctness, conservation checks as relevant).
  - Ensure operations are logged and reversible in practice (at least via Git/dirty state workflows).

Deliverable character: “pair editor” that can prepare changes quickly, but still requires explicit user approval and produces an auditable trail.

## Key risks / open questions

- **What is the authoritative graph representation for tool reads?**
  - File-based model vs in-memory/IndexedDB snapshot vs a reconciled view.
- **How do we bound context while remaining useful?**
  - Retrieval strategy and summarisation become core product behaviour.
- **Prompt injection and untrusted content**
  - Graph content and workspace docs can contain instructions; the agent must treat them as data.
- **Latency and cost**
  - Tool-heavy interactions can be slow; we need visible progress and tight loop limits.
- **Correctness vs plausibility**
  - Diagnostics must be grounded, or the agent will be dangerously confident.

## Revisit “what’s out there?” (import vs patterns)

Once the above is the agreed high-level spec, we can assess whether there is anything to import wholesale.

Directionally, we will evaluate candidates against:

- **TypeScript-native runtime**: embeddable in the client app’s ecosystem.
- **Tool-loop quality**: bounded iterations, streaming, structured tool I/O, and good error semantics.
- **Observability**: tracing, logs, and a way to capture “what happened” in an agent run.
- **MCP compatibility**: ability to act as (or integrate with) an MCP client for our tool surface.
- **Human-in-the-loop controls**: ability to support propose/review/apply without fighting the framework.
- **Surface area**: avoid pulling in a large product when we only need a runtime core.

The likely outcome is:

- We can reuse components for streaming, tool-loop plumbing, and message/state management.
- The domain-specific pieces (graph context retrieval, conservation analyses, event normalisation, and safety posture) will remain DagNet-specific and should be implemented in-house.

### Directional recommendation: reuse the “boring infrastructure”, build the domain core

Given our phased posture (Phase 1 read-only, 10–30s interactive turns, and strong value from event-stream inspection), the most practical time-saver is to **import mature infra components** and keep DagNet-specific semantics in-house.

#### What to import (early)

- **MCP SDK (TypeScript)**
  - **Recommendation**: use the official MCP TypeScript SDK for both server and client plumbing.
  - **Rationale**: it avoids re-inventing transports, discovery, tool/resource conventions, and schema handling. It also aligns with our “tools are evidence” posture and makes it easier to test tooling independently of the model.
  - **Reference**: `@modelcontextprotocol/sdk` (overview + examples) at `https://www.npmjs.com/package/@modelcontextprotocol/sdk?activeTab=readme`.

- **Streaming chat + tool-usage UI pattern**
  - **Recommendation**: adopt the established streaming + tool-part rendering approach (and potentially components) from the Vercel AI SDK.
  - **Rationale**: it gives us a proven interaction protocol for “tool calls in the stream”, step boundaries, and user approvals, without needing WebSockets. It matches our needs for transparent evidence and eventual gated actions.
  - **Reference**: “Chatbot Tool Usage” docs at `https://sdk.vercel.ai/docs/ai-sdk-ui/chatbot-tool-usage`.

- **Observability (OpenTelemetry or equivalent)**
  - **Recommendation**: add trace spans for model calls, tool calls, retries, and failures from day one.
  - **Rationale**: agent behaviour is hard to debug without a timeline; observability becomes the difference between “we can iterate safely” and “we are guessing”. This also supports future evaluation harnesses.
  - **Reference**: OpenAI Agents SDK tracing guide (useful as a concrete span vocabulary even if we do not adopt their runner) at `https://openai.github.io/openai-agents-js/guides/tracing/`.

#### What to consider (later / optional)

- **Agent loop runner library**
  - **Candidate**: OpenAI Agents SDK (TypeScript) provides a ready-made agent loop with max-turn limits, streaming events, and structured error types.
  - **Rationale**: could save time on the “bounded loop” machinery; however it may be less attractive if we want strong provider neutrality (Claude + others) or we prefer to keep orchestration thin and explicit.
  - **Reference**: “Running agents” and the agent loop description at `https://openai.github.io/openai-agents-js/guides/running-agents/`.

- **Workflow/state-machine engines**
  - **Candidate**: LangGraph.js provides durable execution, persistence, interrupts, and checkpointing.
  - **Rationale**: likely overkill for Phase 1 (short interactive turns), but becomes more relevant if we add longer workflows, resumability, or complex multi-step plans in Phase 2.
  - **Reference**: LangGraph.js persistence concepts at `https://langchain-ai.github.io/langgraphjs/concepts/persistence/`.

#### What we should expect to remain homegrown

Even if we import the above, we should assume the following will remain DagNet-specific and implemented in-house:

- **Graph context retrieval** (bounded summaries + targeted fetch + provenance)
- **Conservation and graph diagnostics** (domain logic)
- **Event normalisation + safety** (`eventStreamService` and its PII/redaction posture)
- **Event-to-graph reasoning** (shape discovery, branch attribution, missing-instrumentation detection)
- **Write-path safeguards** (propose/review/apply bundles, post-change validation, and enforcement of DagNet invariants)

