# Segment “Realtime mode” (Graph lighting + trace)

**Status**: Scoping  
**Date**: 3-Feb-26

---

## 1. Intent

DagNet today is oriented around **analysis-grade retrieval** (e.g. Amplitude-derived \(n/k\) time series) and “latest-wins” parameter semantics. This proposal adds a **separate Realtime mode** whose purpose is *not* to update parameter files or buckets, but to provide a **live visualisation** of event flow:

- Nodes “light up” when their corresponding event fires.
- (Optional) Events can be correlated by an identifier so the UI can show a user/session “travelling along the graph”.
- Events **accumulate from the moment the user enables Realtime mode** (a deliberate “start watching now” mental model).

Realtime mode is explicitly a **different product surface** than the Amplitude-backed analytics results. It is a *live feed / instrumentation view*.

---

## 2. Non-goals (important)

- **Not** intended to provide the same semantics as Amplitude-derived \(n/k\) or to replace analytics queries.
- **Not** intended (initially) to backfill history prior to enabling Realtime mode.
- **Not** intended to write realtime-derived counts into parameter files or the snapshot DB.
- **Not** intended (initially) to guarantee ordering or completeness.

---

## 3. User experience

### 3.1 Mode toggle

Add a top-level UI toggle: **Realtime: Off / On**.

When toggled **On**:
- DagNet starts a “watch session” (see §5) and begins ingesting/displaying events.
- UI shows a clear “LIVE” indicator and a counter of received events since enable.
- UI offers quick controls:
  - **Pause** (stop visual updates but continue buffering, or stop ingest entirely — decision required)
  - **Clear** (reset accumulation back to empty for the current watch session)
  - **Filter** (by event type / node / trace id / user id if permitted)

When toggled **Off**:
- DagNet stops ingesting events (and closes any live subscription).
- The accumulated feed may be discarded, or retained as a local “session log” (decision required).

### 3.2 Visual language

Node lighting should be unmistakable but not distracting:
- Brief pulse/glow animation on receipt.
- Optional intensity proportional to short-window frequency (e.g. events/sec).
- Optional “recent” badge (e.g. last fired at).

### 3.3 “Trace view” (optional)

If events include a correlatable identifier, DagNet can:
- Draw a temporary highlight path along edges as the trace progresses.
- Display a side panel: list of events for the active trace, with timestamps.
- Allow pinning: “Follow this trace id” so only that trace animates.

This is best framed as “follow a session/user path”, not “prove funnel conversion”.

---

## 4. Mapping Segment events to DagNet nodes

Realtime lighting requires a mapping from **incoming Segment event** → **DagNet node**.

### 4.1 Recommended mapping mechanism

Use a single source of truth mapping, aligned with existing provider mappings (e.g. Amplitude event name mapping):
- Canonical DagNet node has an internal `event_id`.
- Each provider has a provider-specific event name; for Segment this would be the Segment `event` (for `track`) and possibly `name` for `page/screen`-like events.

### 4.2 Unmapped events

When an event is received that cannot be mapped to a node:
- Option A: show it in a “Unmapped events” panel (no node lighting).
- Option B: allow user to assign/map it to a node (this becomes an authoring flow; defer initially).

---

## 5. “Accumulate from toggle-on”: watch sessions

The “accumulate from now” requirement implies a **watch session** concept:

- A watch session starts when the user enables Realtime mode.
- Only events received after start are shown/accumulated.
- A watch session can be cleared/restarted without reloading the app.

### 5.1 Watch session identifiers

Each watch session has a `watch_session_id` (random id). This id is used to:
- scope the UI’s in-memory store of events
- (if using server-side routing) scope which client receives which pushed events

---

## 6. Architectural patterns

There are two materially different interpretations of “realtime”:

1. **Local realtime (this browser only)**: light nodes when *this user’s* client triggers Segment calls.
2. **Remote realtime (observe external traffic)**: light nodes when Segment ingests events from many clients and forwards them to DagNet.

Both can coexist, but they have very different complexity and risk profiles.

### 6.1 Pattern A — Local realtime interception (lowest friction)

**Flow**:
- The DagNet frontend intercepts Segment calls in the browser at the moment they are invoked (e.g. the local `analytics.track(...)` API).
- DagNet updates UI immediately without any network calls.

**Pros**:
- Extremely fast and reliable for “what did my app just emit?”
- No server, no credentials, no privacy concerns beyond local machine.
- Perfect fit for “nodes lit up when event fired” and “trace within my session”.

**Cons**:
- Not observing production traffic or other users.
- Requires Segment client presence in the app and a stable interception point.

**Best use**: instrumentation/debug mode, product QA, verifying event taxonomy.

### 6.2 Pattern B — Segment → webhook → store → polling (easiest remote)

**Flow**:
- Segment forwards events to a Vercel HTTP endpoint (webhook destination).
- Endpoint stores events (or aggregates) with TTL.
- DagNet UI polls periodically while Realtime mode is on and renders updates.

**Pros**:
- Simple to implement; no persistent connections required.
- Works on Vercel without special realtime infrastructure.

**Cons**:
- Polling delay; “realtime” is near-realtime.
- Needs authentication + privacy controls for ingestion endpoint.
- Must handle retries/deduping.

**Best use**: early remote MVP, low operational risk.

### 6.3 Pattern C — Segment → webhook → pub/sub provider → UI subscribe (recommended “proper remote realtime”)

**Flow**:
- Segment forwards events to a Vercel ingestion endpoint.
- Endpoint publishes events to a managed realtime provider (channels scoped by workspace and/or watch session).
- DagNet UI subscribes to the channel while Realtime mode is enabled.

**Pros**:
- True push UX, scalable, operationally sane on Vercel.
- Provider handles persistent connections and fanout.

**Cons**:
- Additional vendor dependency and cost.
- Requires careful auth and channel design.

**Best use**: production-grade remote realtime.

### 6.4 Pattern D — Segment streaming pipeline (overkill initially)

Stream processing (Kafka/Kinesis/etc) for aggregates and correctness guarantees. Likely unjustified unless realtime becomes a core operational surface.

---

## 7. Event correlation (“travel along the graph”)

To show a trace moving through the graph, we need a stable identifier across events.

### 7.1 Candidate identifiers (in priority order)

- **App-defined `trace_id`**: explicitly set as an event property by the app (recommended if we want deterministic tracing).
  - Example: generate a UUID when the user enters a flow; attach to all events in that flow.
- **Session-level id**: a session identifier (if present/available and stable).
- **User id**: Segment `userId` for logged-in users (privacy implications; requires access controls).
- **Anonymous id**: Segment `anonymousId` (still sensitive; treat as pseudonymous identifier).

### 7.2 Trace semantics

Realtime tracing should be framed carefully:
- It is a *visual aid* for understanding flows.
- It is not proof of conversion attribution.
- Ordering may be approximate; late events can “jump backwards”.

### 7.3 UI affordances

- “Follow trace”: select a trace id and only animate that trace.
- “Show last N traces”: list recent trace ids with counts and last event time.
- “Trace timeline”: per-trace event list, optionally grouped by node.

---

## 8. Data handling: deduping, ordering, retention

### 8.1 Deduplication

Assume **at-least-once** delivery for remote patterns.
- Deduplicate by Segment `messageId` (or equivalent stable per-event id).
- Keep a short TTL “seen set” per watch session/workspace to prevent replays from double-lighting.

### 8.2 Ordering

Do not assume ordering.
- UI should render events as they arrive.
- If a timestamp exists, show both “arrived at” and “occurred at”.

### 8.3 Retention / accumulation

Realtime mode accumulation must be bounded.
- Keep an in-memory ring buffer (e.g. last 5–20k events) per watch session.
- Optionally keep short TTL server-side retention for remote polling/subscribe patterns.

---

## 9. Security and privacy (remote patterns)

Remote traffic observation is powerful and risky.

### 9.1 Minimum safeguards

- **Authenticated ingestion endpoint**: verify Segment signature/HMAC where available; require an allow-list of sources.
- **Redaction**: strip/deny-list properties that may contain PII.
- **Access control**: restrict Realtime mode to authorised users (admin/dev).
- **Sampling**: allow a sampling rate or filters to prevent accidental firehoses.
- **Rate limiting**: protect the endpoint and downstream pub/sub.

### 9.2 Workspace isolation

Events must be scoped to the correct workspace/environment:
- Include explicit `workspace_id` / `env` in forwarded payloads (or infer by source).
- Never allow cross-workspace leakage in channels or polling endpoints.

---

## 10. Recommended phased delivery

### Phase 0 — Local realtime (fastest value)

- Light nodes based on locally emitted Segment events.
- Add “watch session” accumulation and clear/pause controls.
- Add optional trace id support (if the app provides it).

### Phase 1 — Remote near-realtime (polling MVP)

- Segment → webhook → store with TTL.
- DagNet polls while Realtime mode is on.
- Basic filters and security.

### Phase 2 — Remote push (managed pub/sub)

- Replace polling with subscription.
- Add multi-user trace selection (if permitted).

---

## 11. Key decisions required

1. **Local-only vs remote**: do we ship local interception first (recommended), remote later, or jump straight to remote?
2. **Pause semantics**: pause UI only (buffer continues) vs pause ingest (stop receiving).
3. **Trace identifier contract**: do we mandate an app-defined `trace_id` for meaningful tracing?
4. **Privacy posture**: do we allow userId/anonymousId visibility at all, or only trace ids explicitly emitted for this purpose?
5. **Event mapping strategy**: do we require Segment event names to be present in the node event definitions, or maintain a separate mapping registry?

---

## 12. Success criteria

- In Realtime mode, nodes reliably light up when relevant events are observed.
- Users can clear and restart accumulation without refreshing.
- Users can follow a trace id and visually see flow progression (when identifiers are present).
- The system remains safe: bounded memory, deduping, and strong privacy controls (for remote patterns).

