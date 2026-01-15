import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from 'lz-string';

export type SharePayloadV1 =
  | {
      version: '1.0.0';
      target: 'chart';
      /**
       * Graph DSL state to replay deterministically in share mode.
       *
       * Rationale:
       * - Authoring can change base/current DSLs without committing back to the repo.
       * - Live share must replay "what the author saw", not whatever baseDSL happens to be in the repo graph file.
       */
      graph_state?: {
        base_dsl?: string;
        current_query_dsl?: string;
      };
      chart: {
        kind: 'analysis_funnel' | 'analysis_bridge';
        title?: string;
      };
      analysis: {
        query_dsl: string;
        analysis_type?: string | null;
        what_if_dsl?: string | null;
      };
      scenarios: {
        /** Ordered list of LIVE scenario definitions (Base/Current are implicit). */
        items: Array<{
          /**
           * Optional stable scenario id (authoring-side).
           *
           * Share boot should preserve this when possible so that:
           * - bridge charts can rehydrate identically (scenario_id stable)
           * - colours/labels can be keyed stably by id
           */
          id?: string;
          dsl: string;
          name?: string;
          colour?: string;
          visibility_mode?: 'f+e' | 'f' | 'e';
          subtitle?: string;
        }>;
        /**
         * Optional metadata for the implicit Current layer.
         *
         * Why this exists:
         * - Current is treated as an implicit layer in share payloads.
         * - But its display+analysis metadata (DSL/colour/visibility mode) must still be preserved
         *   for rehydration fidelity and chart parity.
         */
        current?: {
          dsl?: string;
          name?: string;
          colour?: string;
          visibility_mode?: 'f+e' | 'f' | 'e';
        };
        hide_current?: boolean;
        selected_scenario_dsl?: string | null;
      };
    }
  | {
      version: '1.0.0';
      target: 'bundle';
      /**
       * Graph DSL state to replay deterministically in share mode (applies to all tabs).
       */
      graph_state?: {
        base_dsl?: string;
        current_query_dsl?: string;
      };
      /** Presentation hints */
      presentation?: {
        dashboardMode?: boolean;
        activeTabIndex?: number;
      };
      /** Bundle tab list (ordered) */
      tabs: Array<
        | {
            type: 'graph';
            title?: string;
          }
        | {
            type: 'chart';
            title?: string;
            chart: { kind: 'analysis_funnel' | 'analysis_bridge' };
            analysis: {
              query_dsl: string;
              analysis_type?: string | null;
              what_if_dsl?: string | null;
            };
          }
      >;
      /** Shared scenario definitions applied across tabs */
      scenarios?: {
        items: Array<{
          /** Optional stable scenario id (authoring-side). */
          id?: string;
          dsl: string;
          name?: string;
          colour?: string;
          visibility_mode?: 'f+e' | 'f' | 'e';
          subtitle?: string;
        }>;
        /** Optional metadata for the implicit Current layer (applies across bundle tabs). */
        current?: {
          dsl?: string;
          name?: string;
          colour?: string;
          visibility_mode?: 'f+e' | 'f' | 'e';
        };
        hide_current?: boolean;
        selected_scenario_dsl?: string | null;
      };
    };

export function encodeSharePayloadToParam(payload: SharePayloadV1): string {
  return compressToEncodedURIComponent(JSON.stringify(payload));
}

export function decodeSharePayloadFromParam(param: string): SharePayloadV1 | null {
  try {
    const decompressed = decompressFromEncodedURIComponent(param);
    if (!decompressed) return null;
    const parsed = JSON.parse(decompressed) as SharePayloadV1;
    if (!parsed || typeof parsed !== 'object') return null;
    if ((parsed as any).version !== '1.0.0') return null;
    const target = (parsed as any).target;
    if (target !== 'chart' && target !== 'bundle') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function decodeSharePayloadFromUrl(): SharePayloadV1 | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('share');
    if (!raw) return null;
    return decodeSharePayloadFromParam(raw);
  } catch {
    return null;
  }
}

export function stableShortHash(input: string): string {
  // Simple non-cryptographic hash for stable IDs (share-scoped only).
  // This is NOT used for security.
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h) ^ input.charCodeAt(i);
  }
  // Force unsigned and base36 for compactness.
  return (h >>> 0).toString(36);
}

