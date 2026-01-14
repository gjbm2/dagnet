import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from 'lz-string';

export type SharePayloadV1 =
  | {
      version: '1.0.0';
      target: 'chart';
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
          dsl: string;
          name?: string;
          colour?: string;
          visibility_mode?: 'f+e' | 'f' | 'e';
          subtitle?: string;
        }>;
        hide_current?: boolean;
        selected_scenario_dsl?: string | null;
      };
    }
  | {
      version: '1.0.0';
      target: 'bundle';
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
          dsl: string;
          name?: string;
          colour?: string;
          visibility_mode?: 'f+e' | 'f' | 'e';
          subtitle?: string;
        }>;
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

