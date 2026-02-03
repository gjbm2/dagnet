# Realtime mode: simple concrete proposal (Segment → Pusher → DagNet)

**Status**: Proposal (scoped, simple)  
**Date**: 3-Feb-26

---

## 1. Goal

Enable a **Realtime mode** in DagNet where a client can subscribe to a near-realtime stream of production events and:

- filter locally to “events relevant to the currently loaded graph”
- light nodes when matching events arrive
- optionally group/animate by `trace_id`

This mode is **separate from analytics** (no parameter file updates; no \(n/k\) recomputation).

---

## 2. Proposed architecture (one clear path)

### 2.1 Components

- **Segment**: collects production events as it does today.
- **Pusher Channels**: provides realtime distribution (connections + fanout).
- **DagNet (Vercel-hosted)**: provides only a **private-channel auth endpoint** (API route).
- **DagNet client**: subscribes, then filters and renders.

### 2.2 End-to-end schematic

```
Production apps (Segment SDK)
        │
        ▼
     Segment
        │  Destination Function (or equivalent) publishes each event
        │  to Pusher via Pusher HTTP API
        ▼
 Pusher Channels (private channel)
        ▲
        │  auth for subscription
        │
DagNet (Vercel) API route  ─────► signs subscription (server secret)
        │
        ▼
DagNet client subscribes → receives events → filters locally → lights nodes / traces
```

Notes:
- “Segment → Pusher” is implemented by **Segment server-side code** (Destination Function) calling Pusher’s publish API.
- DagNet is **not** in the ingest path. DagNet only controls who may subscribe.

---

## 3. Channel model (simple)

- Single environment channel, e.g. `private-prod-segment-events`
  - optionally split by workspace later if needed

This keeps the server side dumb; the **client decides relevance**.

---

## 4. Auth model (inside DagNet / Vercel)

### 4.1 What the API route does

DagNet hosts an auth endpoint (e.g. `/api/realtime/pusher-auth`) that:

- validates the DagNet user is permitted to use Realtime mode
- signs the `socket_id` + `channel_name` for Pusher private channel subscription
- returns the signed payload to the client

### 4.2 Why this is the only DagNet server responsibility

- prevents “security through obscurity” of public channels
- allows revocation/permission changes without redeploying clients
- keeps production event ingress outside DagNet

---

## 5. Client behaviour (DagNet)

### 5.1 Minimal event envelope

To stay within message size limits and reduce sensitivity, publish a thin payload such as:

- `event_name`
- `occurred_at` (or Segment timestamp)
- `message_id` (for dedupe in the client)
- optional `trace_id` (preferred over userId/anonymousId for privacy)
- optional minimal `properties` allow-list (only if needed for filtering)

### 5.2 Filtering & rendering

When Realtime mode is enabled:

- subscribe to the channel
- keep a bounded in-memory buffer (ring) “events since toggle-on”
- filter: match `event_name` to nodes present in the current graph
- on match: light node (pulse/glow); update trace view if `trace_id` exists

---

## 6. Cost/limit sanity (why this should be fine)

Pusher counts “messages” as **publishes + deliveries**.

- One publish delivered to \(S\) subscribers counts as \((1 + S)\) messages.
- With \(S \approx 1–2\) and moderate event volume, the free tier is likely sufficient, but we should confirm empirically by measuring:
  - events forwarded/day (publisher-side metric)
  - Pusher dashboard usage (messages/day)

If we exceed free tier unexpectedly, the first lever is to publish only while Realtime mode is actively in use (or to publish only a subset such as `track`).

---

## 7. Implementation phases (tight)

1. **Pusher setup**: create app, private channel naming, verify publish from Segment-side code.
2. **DagNet auth endpoint**: add API route that signs private-channel subscriptions.
3. **DagNet client**: add Realtime mode toggle, subscribe + buffer + node lighting.
4. **Trace support (optional)**: recognise `trace_id` and render “travel along the graph”.

