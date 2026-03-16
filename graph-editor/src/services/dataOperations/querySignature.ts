/**
 * Query signature computation and context-key extraction.
 *
 * The query signature uniquely identifies the semantic content of a data query
 * for cache matching and consistency checking. It is a structured JSON with
 * a core hash (connection + events + filters) and per-context definition hashes.
 *
 * Extracted from dataOperationsService.ts (Cluster D) during slimdown.
 *
 * @see docs/current/multi-sig-matching.md for full design specification
 */

import type { Graph } from '../../types';
import { parseDSL } from '../../lib/queryDSL';
import { serialiseSignature } from '../signatureMatchingService';
import { contextRegistry } from '../contextRegistry';
import { sessionLogService } from '../sessionLogService';

/**
 * Compute query signature for consistency checking.
 *
 * Returns a STRUCTURED signature (JSON) with two components:
 * - coreHash: SHA-256 of non-context semantic inputs (connection, events, filters, etc.)
 * - contextDefHashes: Per-context-key definition hashes
 *
 * This enables cache sharing when:
 * - Query asks for uncontexted data but cache has contexted MECE slices
 * - Query asks for single-dimension data but cache has multi-dimensional slices
 *
 * @see docs/current/multi-sig-matching.md for full design specification
 */
export async function computeQuerySignature(
  queryPayload: any,
  connectionName?: string,
  graph?: Graph | null,
  edge?: any,
  contextKeys?: string[],
  workspace?: { repository: string; branch: string },
  eventDefinitions?: Record<string, any>  // NEW: Event definitions for hashing
): Promise<string> {
  try {
    // Extract event_ids from nodes if graph and edge are provided
    let from_event_id: string | undefined;
    let to_event_id: string | undefined;
    let visited_event_ids: string[] = [];
    let exclude_event_ids: string[] = [];

    if (graph && edge && edge.query) {
      // Helper to find node by ID or UUID
      const findNode = (ref: string): any | undefined => {
        let node = graph.nodes?.find((n: any) => n.id === ref);
        if (!node) {
          node = graph.nodes?.find((n: any) => n.uuid === ref);
        }
        return node;
      };

      // Parse query to get node references (using static import)
      try {
        const parsed = parseDSL(edge.query);

        // Extract event_ids from from/to nodes
        const fromNode = parsed.from ? findNode(parsed.from) : null;
        const toNode = parsed.to ? findNode(parsed.to) : null;

        if (fromNode) from_event_id = fromNode.event_id;
        if (toNode) to_event_id = toNode.event_id;

        // Extract event_ids from visited nodes
        if (parsed.visited && Array.isArray(parsed.visited)) {
          visited_event_ids = parsed.visited
            .map((ref: string) => {
              const node = findNode(ref);
              return node?.event_id;
            })
            .filter((id: string | undefined): id is string => !!id);
        }

        // Extract event_ids from exclude nodes
        if (parsed.exclude && Array.isArray(parsed.exclude)) {
          exclude_event_ids = parsed.exclude
            .map((ref: string) => {
              const node = findNode(ref);
              return node?.event_id;
            })
            .filter((id: string | undefined): id is string => !!id);
        }
      } catch (error) {
        console.warn('[DataOperationsService] Failed to parse query for event_ids:', error);
        // Continue without event_ids if parsing fails
      }
    }

    const sortPrimitiveArray = (items: unknown[]): unknown[] => {
      if (items.every(v => typeof v === 'string')) {
        return [...(items as string[])].sort();
      }
      if (items.every(v => typeof v === 'number')) {
        return [...(items as number[])].sort((a, b) => a - b);
      }
      return items;
    };

    const normalizeObjectKeys = (obj: Record<string, any>): Record<string, any> => {
      const out: Record<string, any> = {};
      Object.keys(obj).sort().forEach((k) => {
        const v = obj[k];
        if (Array.isArray(v)) {
          out[k] = v.map((item) => (item && typeof item === 'object' ? normalizeObjectKeys(item) : item));
        } else if (v && typeof v === 'object') {
          out[k] = normalizeObjectKeys(v);
        } else {
          out[k] = v;
        }
      });
      return out;
    };

    const normalizeContextDefinition = (ctx: any): Record<string, any> => {
      const values = Array.isArray(ctx?.values) ? [...ctx.values] : [];
      const normalizedValues = values
        .map((v: any) => ({
          id: v.id,
          label: v.label,
          description: v.description,
          order: v.order,
          aliases: Array.isArray(v.aliases) ? sortPrimitiveArray(v.aliases) : v.aliases,
          sources: v.sources ? normalizeObjectKeys(v.sources) : v.sources,
        }))
        .sort((a: any, b: any) => String(a.id ?? '').localeCompare(String(b.id ?? '')));

      const metadata = ctx?.metadata ? normalizeObjectKeys(ctx.metadata) : ctx?.metadata;

      return normalizeObjectKeys({
        id: ctx?.id,
        name: ctx?.name,
        description: ctx?.description,
        type: ctx?.type,
        otherPolicy: ctx?.otherPolicy ?? 'undefined',
        values: normalizedValues,
        metadata,
      });
    };

    const hashText = async (canonical: string): Promise<string> => {
      const encoder = new TextEncoder();
      const data = encoder.encode(canonical);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    };

    const payloadContextKeys = Array.isArray(queryPayload?.context)
      ? queryPayload.context.map((c: any) => c?.key).filter(Boolean)
      : [];
    const allContextKeys = Array.from(new Set([...(contextKeys || []), ...payloadContextKeys]))
      .map((k) => String(k))
      .sort();

    // ─────────────────────────────────────────────────────────────────────────────
    // CONTEXT DEFINITION HASHES (per-key, for structured signature)
    // ─────────────────────────────────────────────────────────────────────────────
    const contextDefHashes: Record<string, string> = {};
    for (const key of allContextKeys) {
      try {
        const ctx = await contextRegistry.getContext(key, workspace ? { workspace } : undefined);
        if (!ctx) {
          contextDefHashes[key] = 'missing';
        } else {
          const normalized = normalizeContextDefinition(ctx);
          contextDefHashes[key] = await hashText(JSON.stringify(normalized));
        }
      } catch (error) {
        console.warn('[computeQuerySignature] Failed to hash context definition:', { key, error });
        contextDefHashes[key] = 'error';
      }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // RESOLVE ANCHOR NODE → EVENT ID (BUG FIX: use event_id, not node_id)
    // ─────────────────────────────────────────────────────────────────────────────
    const edgeLatency = edge?.p?.latency;
    const latencyAnchorEventId = (() => {
      const anchorNodeId = edgeLatency?.anchor_node_id;
      if (!anchorNodeId || !graph?.nodes) return '';
      const anchorNode = graph.nodes.find((n: any) => n.id === anchorNodeId || n.uuid === anchorNodeId);
      return anchorNode?.event_id || '';
    })();

    // ─────────────────────────────────────────────────────────────────────────────
    // EVENT DEFINITION HASHES (detect when event definition files change)
    // ─────────────────────────────────────────────────────────────────────────────
    const eventDefHashes: Record<string, string> = {};
    const allEventIds = [
      from_event_id,
      to_event_id,
      ...visited_event_ids,
      ...exclude_event_ids,
      latencyAnchorEventId,
    ].filter(Boolean) as string[];

    for (const eventId of allEventIds) {
      const eventDef = eventDefinitions?.[eventId];
      if (eventDef) {
        // Hash the semantically relevant parts of the event definition
        const normalized = {
          id: eventDef.id,
          provider_event_names: eventDef.provider_event_names || {},
          amplitude_filters: eventDef.amplitude_filters || [],
        };
        eventDefHashes[eventId] = await hashText(JSON.stringify(normalized));
      } else {
        eventDefHashes[eventId] = 'not_loaded';
      }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // NORMALIZE ORIGINAL QUERY TO USE EVENT IDS (maximise cache sharing)
    // ─────────────────────────────────────────────────────────────────────────────
    const escapeRegex = (str: string): string => {
      return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    };

    const normalizeQueryToEventIds = (q: string): string => {
      if (!q || !graph?.nodes) return q;
      let out = q;
      // Replace node references with their event_ids
      for (const node of graph.nodes) {
        if (node.id && node.event_id) {
          // Replace from(nodeId) with from(eventId), etc.
          out = out.replace(new RegExp(`\\b${escapeRegex(node.id)}\\b`, 'g'), node.event_id);
        }
      }
      return out;
    };

    // Normalize original query string for signature purposes.
    //
    // CRITICAL DESIGN RULE:
    // - Signature MUST include context *definition* hashes (so it changes when the context YAML changes)
    // - Signature MUST NOT vary by context *value* (e.g. channel:paid-search vs channel:other)
    //   because slice identity already carries the value and MECE fulfilment relies on stable semantics.
    //
    // Therefore we strip `.context(...)` / `.contextAny(...)` and explicit window/cohort bounds from the
    // original query string before hashing. We still preserve minus()/plus()/visited()/exclude() structure.
    const normalizeOriginalQueryForSignature = (q: string): string => {
      if (!q) return '';
      let out = String(q);
      // Remove trailing/embedded context constraints.
      out = out.replace(/\.contextAny\([^)]*\)/g, '');
      out = out.replace(/\.context\([^)]*\)/g, '');
      // Remove explicit window/cohort bounds if present on the edge query (rare but possible).
      // Bounds must not affect signature; cache coverage is proven via header ranges.
      out = out.replace(/\.window\([^)]*\)/g, '');
      out = out.replace(/\.cohort\([^)]*\)/g, '');
      // Collapse whitespace and repeated dots from removals.
      out = out.replace(/\s+/g, ' ').trim();
      out = out.replace(/\.\./g, '.');
      // Remove trailing dot.
      out = out.replace(/\.$/, '');
      return out;
    };

    const rawOriginalQuery = edge?.query || '';
    const strippedQuery = normalizeOriginalQueryForSignature(rawOriginalQuery);
    // Convert node IDs to event IDs for cross-graph cache sharing
    const normalizedOriginalQuery = normalizeQueryToEventIds(strippedQuery);

    // ─────────────────────────────────────────────────────────────────────────────
    // BUILD CORE HASH (everything EXCEPT context keys/hashes)
    // ─────────────────────────────────────────────────────────────────────────────
    const coreCanonical = JSON.stringify({
      connection: connectionName || '',
      // Event IDs (semantic identity)
      from_event_id: from_event_id || '',
      to_event_id: to_event_id || '',
      visited_event_ids: visited_event_ids.sort(),
      exclude_event_ids: exclude_event_ids.sort(),
      // Event definition hashes (detect event file changes)
      event_def_hashes: eventDefHashes,
      // Other semantic inputs
      event_filters: queryPayload.event_filters || {},
      case: (queryPayload.case || []).sort(),
      cohort_mode: !!queryPayload.cohort,
      cohort_anchor_event_id: queryPayload?.cohort?.anchor_event_id || '',
      latency_parameter: edgeLatency?.latency_parameter === true,
      latency_anchor_event_id: latencyAnchorEventId,  // Uses event_id, not node_id!
      // Normalized query (uses event_ids, not node_ids)
      original_query: normalizedOriginalQuery,
    });
    const coreHash = await hashText(coreCanonical);

    // ─────────────────────────────────────────────────────────────────────────────
    // BUILD STRUCTURED SIGNATURE
    // ─────────────────────────────────────────────────────────────────────────────
    const structuredSig = serialiseSignature({ coreHash, contextDefHashes });

    // ===== DIAGNOSTIC: Show what went into the signature =====
    if (sessionLogService.getDiagnosticLoggingEnabled()) {
      sessionLogService.info('data-fetch', 'SIGNATURE_COMPUTED',
        `Computed signature: ${coreHash.substring(0, 12)}... (${Object.keys(eventDefHashes).length} events)`,
        undefined,
        {
          coreHash: coreHash.substring(0, 16),
          contextKeys: Object.keys(contextDefHashes),
          originalQuery: rawOriginalQuery || 'N/A',
          normalizedOriginalQuery: normalizedOriginalQuery || 'N/A',
          eventDefHashes,
          eventDefinitionsLoaded: Object.fromEntries(
            Object.entries(eventDefinitions || {}).map(([id, def]) => [
              id,
              {
                provider_event_names: (def as any)?.provider_event_names,
                amplitude_filters: (def as any)?.amplitude_filters,
              }
            ])
          ),
        }
      );
    }
    // =========================================================

    return structuredSig;
  } catch (error) {
    console.warn('[DataOperationsService] Failed to compute query signature:', error);
    // Fallback: use simple string hash
    return `fallback-${Date.now()}`;
  }
}

/**
 * Extract context keys from parsed constraint objects.
 * Used by data operations to determine which context definitions need hashing
 * for signature computation.
 */
export function extractContextKeysFromConstraints(constraints?: {
  context?: Array<{ key: string }>;
  contextAny?: Array<{ pairs: Array<{ key: string }> }>;
} | null): string[] {
  if (!constraints) return [];
  const keys = new Set<string>();
  for (const ctx of constraints.context || []) {
    if (ctx?.key) keys.add(ctx.key);
  }
  for (const ctxAny of constraints.contextAny || []) {
    for (const pair of ctxAny?.pairs || []) {
      if (pair?.key) keys.add(pair.key);
    }
  }
  return Array.from(keys).sort();
}
