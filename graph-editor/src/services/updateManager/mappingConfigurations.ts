/**
 * Mapping configurations for UpdateManager.
 *
 * Extracted from UpdateManager.ts (Cluster H — ~1,200 lines of addMapping() calls)
 * as part of the src-slimdown modularisation.
 *
 * These configurations are platform-agnostic — no browser imports.
 * All transform/condition functions are stateless predicates operating on
 * the source and target objects passed in.
 */

import type {
  Direction,
  Operation,
  SubDestination,
  FieldMapping,
  MappingConfiguration,
} from './types';

import { normalizeToUK } from '../../lib/dateFormat';
import { roundToDP, roundHorizonDays } from './roundingUtils';

// ============================================================
// Helpers
// ============================================================

/**
 * Build a unique key for a mapping configuration entry.
 * Format: `direction:operation` or `direction:operation:subDestination`.
 */
export function getMappingKey(
  direction: Direction,
  operation: Operation,
  subDest?: SubDestination
): string {
  return subDest ? `${direction}:${operation}:${subDest}` : `${direction}:${operation}`;
}

// ============================================================
// Build all mapping configurations into a Map
// ============================================================

function buildMappingConfigurations(): Map<string, MappingConfiguration> {
  const map = new Map<string, MappingConfiguration>();

  function addMapping(
    direction: Direction,
    operation: Operation,
    subDest: SubDestination | undefined,
    mappings: FieldMapping[]
  ) {
    const key = getMappingKey(direction, operation, subDest);
    map.set(key, {
      direction,
      operation,
      subDestination: subDest,
      mappings
    });
  }

  // ============================================================
  // Flow A: Graph Internal (MSMDC, cascades)
  // ============================================================

  addMapping('graph_internal', 'UPDATE', undefined, [
    // MSMDC query regeneration handled separately
    // Label cascades handled by graph editor directly
  ]);

  // ============================================================
  // Flows B-F: Graph → File
  // ============================================================

  // Flow B.CREATE: Graph → File/Parameter (CREATE new file)
  // Note: When creating a new param file, we initialize its name/description from the edge
  // as a sensible default. This is different from GET, where we don't overwrite edge metadata.
  addMapping('graph_to_file', 'CREATE', 'parameter', [
    { sourceField: 'id', targetField: 'id' },
    { sourceField: 'label', targetField: 'name' },
    { sourceField: 'description', targetField: 'description' },
    { sourceField: 'query', targetField: 'query' },
    // Connection settings: initialize from graph if present
    // Probability parameter connection
    {
      sourceField: 'p.connection',
      targetField: 'connection',
      condition: (source) => !!source.p?.connection && source.p?.id
    },
    {
      sourceField: 'p.connection_string',
      targetField: 'connection_string',
      condition: (source) => !!source.p?.connection_string && source.p?.id
    },
    // Cost GBP parameter connection
    {
      sourceField: 'cost_gbp.connection',
      targetField: 'connection',
      condition: (source) => !!source.cost_gbp?.connection && source.cost_gbp?.id
    },
    {
      sourceField: 'cost_gbp.connection_string',
      targetField: 'connection_string',
      condition: (source) => !!source.cost_gbp?.connection_string && source.cost_gbp?.id
    },
    // Cost Time parameter connection
    {
      sourceField: 'labour_cost.connection',
      targetField: 'connection',
      condition: (source) => !!source.labour_cost?.connection && source.labour_cost?.id
    },
    {
      sourceField: 'labour_cost.connection_string',
      targetField: 'connection_string',
      condition: (source) => !!source.labour_cost?.connection_string && source.labour_cost?.id
    },
    // Type field: determine from which edge param is populated
    {
      sourceField: 'p',
      targetField: 'parameter_type',
      condition: (source) => !!source.p?.id,
      transform: () => 'probability'
    },
    {
      sourceField: 'cost_gbp',
      targetField: 'parameter_type',
      condition: (source) => !!source.cost_gbp?.id,
      transform: () => 'cost_gbp'
    },
    {
      sourceField: 'labour_cost',
      targetField: 'parameter_type',
      condition: (source) => !!source.labour_cost?.id,
      transform: () => 'labour_cost'
    },
    // Initial values: populate from whichever param type exists
    {
      sourceField: 'p.mean',
      targetField: 'values[0]',
      condition: (source) => !!source.p?.id,
      transform: (value, source) => ({
        mean: value,
        stdev: source.p.stdev,
        distribution: source.p.distribution,
        n: source.p.evidence?.n,
        k: source.p.evidence?.k,
        window_from: source.p.evidence?.window_from || normalizeToUK(new Date().toISOString()),
        window_to: source.p.evidence?.window_to
      })
    },
    {
      sourceField: 'cost_gbp.mean',
      targetField: 'values[0]',
      condition: (source) => !!source.cost_gbp?.id,
      transform: (value, source) => ({
        mean: value,
        stdev: source.cost_gbp.stdev,
        distribution: source.cost_gbp.distribution,
        window_from: source.cost_gbp.evidence?.window_from || normalizeToUK(new Date().toISOString()),
        window_to: source.cost_gbp.evidence?.window_to
      })
    },
    {
      sourceField: 'labour_cost.mean',
      targetField: 'values[0]',
      condition: (source) => !!source.labour_cost?.id,
      transform: (value, source) => ({
        mean: value,
        stdev: source.labour_cost.stdev,
        distribution: source.labour_cost.distribution,
        window_from: source.labour_cost.evidence?.window_from || normalizeToUK(new Date().toISOString()),
        window_to: source.labour_cost.evidence?.window_to
      })
    }
  ]);

  // Flow B.UPDATE: Graph → File/Parameter (UPDATE metadata)
  // NOTE: Connection settings always sync from graph to file (file doesn't have override flags)
  // If graph has overridden connection, PUT will update file to match graph's override
  // NOTE: query and description respect file-side override flags
  addMapping('graph_to_file', 'UPDATE', 'parameter', [
    {
      sourceField: 'description',
      targetField: 'description',
      overrideFlag: 'metadata.description_overridden' // Respect file-side override
    },
    {
      sourceField: 'query',
      targetField: 'query',
      overrideFlag: 'query_overridden' // Respect file-side override
    },
    // Copy override flags on explicit PUT (graph → file).
    // NOTE: This mapping does not mutate permissions in automated flows because callers must opt in
    // via `ignoreOverrideFlags` (see UpdateOptions).
    {
      sourceField: 'query_overridden',
      targetField: 'query_overridden',
      requiresIgnoreOverrideFlags: true,
      condition: (source) => source.query_overridden !== undefined
    },
    {
      sourceField: 'n_query',
      targetField: 'n_query',
      overrideFlag: 'n_query_overridden',
      condition: (source) => source.n_query !== undefined
    },
    {
      sourceField: 'n_query_overridden',
      targetField: 'n_query_overridden',
      requiresIgnoreOverrideFlags: true,
      condition: (source) => source.n_query_overridden !== undefined
    },
    // Connection settings: always sync from graph to file
    // Probability parameter connection
    {
      sourceField: 'p.connection',
      targetField: 'connection',
      condition: (source) => !!source.p?.connection && source.p?.id
    },
    {
      sourceField: 'p.connection_string',
      targetField: 'connection_string',
      condition: (source) => !!source.p?.connection_string && source.p?.id
    },
    // Cost GBP parameter connection
    {
      sourceField: 'cost_gbp.connection',
      targetField: 'connection',
      condition: (source) => !!source.cost_gbp?.connection && source.cost_gbp?.id
    },
    {
      sourceField: 'cost_gbp.connection_string',
      targetField: 'connection_string',
      condition: (source) => !!source.cost_gbp?.connection_string && source.cost_gbp?.id
    },
    // Cost Time parameter connection
    {
      sourceField: 'labour_cost.connection',
      targetField: 'connection',
      condition: (source) => !!source.labour_cost?.connection && source.labour_cost?.id
    },
    {
      sourceField: 'labour_cost.connection_string',
      targetField: 'connection_string',
      condition: (source) => !!source.labour_cost?.connection_string && source.labour_cost?.id
    },

    // LAG: Latency CONFIG fields (graph → file, bidirectional)
    // latency_parameter: explicit enablement flag
    {
      sourceField: 'p.latency.latency_parameter',
      targetField: 'latency.latency_parameter',
      overrideFlag: 'latency.latency_parameter_overridden',
      condition: (source) => source.p?.latency?.latency_parameter !== undefined && source.p?.id
    },
    {
      sourceField: 'p.latency.latency_parameter_overridden',
      targetField: 'latency.latency_parameter_overridden',
      requiresIgnoreOverrideFlags: true,
      condition: (source) => source.p?.latency?.latency_parameter_overridden !== undefined && source.p?.id
    },
    {
      sourceField: 'p.latency.anchor_node_id',
      targetField: 'latency.anchor_node_id',
      overrideFlag: 'latency.anchor_node_id_overridden',
      condition: (source) => source.p?.latency?.anchor_node_id !== undefined && source.p?.id
    },
    {
      sourceField: 'p.latency.anchor_node_id_overridden',
      targetField: 'latency.anchor_node_id_overridden',
      requiresIgnoreOverrideFlags: true,
      condition: (source) => source.p?.latency?.anchor_node_id_overridden !== undefined && source.p?.id
    },
    // t95 and path_t95: horizon fields (derived but user-overridable)
    {
      sourceField: 'p.latency.t95',
      targetField: 'latency.t95',
      overrideFlag: 'latency.t95_overridden',
      condition: (source) => source.p?.latency?.t95 !== undefined && source.p?.id,
      transform: (value: number) => roundHorizonDays(value)
    },
    {
      sourceField: 'p.latency.t95_overridden',
      targetField: 'latency.t95_overridden',
      requiresIgnoreOverrideFlags: true,
      condition: (source) => source.p?.latency?.t95_overridden !== undefined && source.p?.id
    },
    {
      sourceField: 'p.latency.path_t95',
      targetField: 'latency.path_t95',
      overrideFlag: 'latency.path_t95_overridden',
      condition: (source) => source.p?.latency?.path_t95 !== undefined && source.p?.id,
      transform: (value: number) => roundHorizonDays(value)
    },
    {
      sourceField: 'p.latency.path_t95_overridden',
      targetField: 'latency.path_t95_overridden',
      requiresIgnoreOverrideFlags: true,
      condition: (source) => source.p?.latency?.path_t95_overridden !== undefined && source.p?.id
    },
    // onset_delta_days: onset delay (aggregated in LAG topo pass, user-overridable)
    {
      sourceField: 'p.latency.onset_delta_days',
      targetField: 'latency.onset_delta_days',
      overrideFlag: 'latency.onset_delta_days_overridden',
      condition: (source) => source.p?.latency?.onset_delta_days !== undefined && source.p?.id
    },
    {
      sourceField: 'p.latency.onset_delta_days_overridden',
      targetField: 'latency.onset_delta_days_overridden',
      requiresIgnoreOverrideFlags: true,
      condition: (source) => source.p?.latency?.onset_delta_days_overridden !== undefined && source.p?.id
    },
    // mu, sigma, model_trained_at: fitted model params (internal, no override flags)
    // Synced to file so they survive git commit/clone and are available offline.
    {
      sourceField: 'p.latency.mu',
      targetField: 'latency.mu',
      condition: (source) => source.p?.latency?.mu !== undefined && source.p?.id
    },
    {
      sourceField: 'p.latency.sigma',
      targetField: 'latency.sigma',
      condition: (source) => source.p?.latency?.sigma !== undefined && source.p?.id
    },
    {
      sourceField: 'p.latency.model_trained_at',
      targetField: 'latency.model_trained_at',
      condition: (source) => source.p?.latency?.model_trained_at !== undefined && source.p?.id
    },
    // path_mu, path_sigma: path-level A→Y CDF params (Fenton–Wilkinson, internal)
    {
      sourceField: 'p.latency.path_mu',
      targetField: 'latency.path_mu',
      condition: (source) => source.p?.latency?.path_mu !== undefined && source.p?.id
    },
    {
      sourceField: 'p.latency.path_sigma',
      targetField: 'latency.path_sigma',
      condition: (source) => source.p?.latency?.path_sigma !== undefined && source.p?.id
    },
    // path_onset_delta_days: path-level Σ onset_delta_days (DP sum along path, internal)
    {
      sourceField: 'p.latency.path_onset_delta_days',
      targetField: 'latency.path_onset_delta_days',
      condition: (source) => source.p?.latency?.path_onset_delta_days !== undefined && source.p?.id
    },
    // NOTE: Bayesian posteriors are NOT mapped graph → file.
    // The webhook is the sole writer of posterior data to param files.
    // The graph carries a stripped summary (no fit_history/slices/_model_state)
    // which must not overwrite the full posterior on the file.
  ]);

  // Flow B.APPEND: Graph → File/Parameter (APPEND new value)
  addMapping('graph_to_file', 'APPEND', 'parameter', [
    // Probability parameter: edge.p.* → parameter.values[]
    // Preserve all relevant fields including evidence data if present
    // NOTE: Do NOT include daily values (n_daily, k_daily, dates) - those are only from external data pulls
    // NOTE: conditional_probability type is treated identically to probability (PARITY PRINCIPLE)
    {
      sourceField: 'p.mean',
      targetField: 'values[]',
      condition: (source, target) => target.type === 'probability' || target.type === 'conditional_probability' || target.parameter_type === 'probability' || target.parameter_type === 'conditional_probability',
      transform: (value, source) => {
        const entry: any = { mean: value };

        // Statistical fields
        if (source.p.stdev !== undefined) entry.stdev = source.p.stdev;
        if (source.p.distribution) entry.distribution = source.p.distribution;

        // Evidence fields (if present - from data pulls)
        // NOTE: Do NOT include n_daily/k_daily/dates - those are only for external data pulls
        // Only include evidence if it's from a data_source (not stale from previous GET)
        // Manual edits should NOT include stale evidence - check if data_source exists and is not manual
        if (source.p.evidence && source.p.data_source && source.p.data_source.type && source.p.data_source.type !== 'manual') {
          if (source.p.evidence.n !== undefined) entry.n = source.p.evidence.n;
          if (source.p.evidence.k !== undefined) entry.k = source.p.evidence.k;
          if (source.p.evidence.window_from) entry.window_from = source.p.evidence.window_from;
          if (source.p.evidence.window_to) entry.window_to = source.p.evidence.window_to;
        }

        // If no evidence window_from, use current time
        if (!entry.window_from) {
          entry.window_from = new Date().toISOString();
        }

        // Data source: preserve from edge if exists, otherwise mark as manual
        if (source.p.data_source) {
          entry.data_source = source.p.data_source;
        } else if (source.p.evidence?.source) {
          // If evidence has source info, construct data_source from evidence
          entry.data_source = {
            type: source.p.evidence.source,
            retrieved_at: source.p.evidence.retrieved_at || new Date().toISOString(),
            full_query: source.p.evidence.full_query,
            debug_trace: source.p.evidence.debug_trace
          };
        } else {
          // Manual edit - no evidence or data_source
          entry.data_source = {
            type: 'manual',
            edited_at: new Date().toISOString()
          };
        }

        return entry;
      }
    },
    // Cost GBP parameter: edge.cost_gbp.* → parameter.values[]
    {
      sourceField: 'cost_gbp.mean',
      targetField: 'values[]',
      condition: (source, target) => target.type === 'cost_gbp' || target.parameter_type === 'cost_gbp',
      transform: (value, source) => {
        const entry: any = { mean: value };

        // Statistical fields
        if (source.cost_gbp.stdev !== undefined) entry.stdev = source.cost_gbp.stdev;
        if (source.cost_gbp.distribution) entry.distribution = source.cost_gbp.distribution;

        // Evidence fields (if present - from data pulls)
        if (source.cost_gbp.evidence) {
          if (source.cost_gbp.evidence.n !== undefined) entry.n = source.cost_gbp.evidence.n;
          if (source.cost_gbp.evidence.k !== undefined) entry.k = source.cost_gbp.evidence.k;
          if (source.cost_gbp.evidence.window_from) entry.window_from = source.cost_gbp.evidence.window_from;
          if (source.cost_gbp.evidence.window_to) entry.window_to = source.cost_gbp.evidence.window_to;
        }

        // If no evidence window_from, use current time
        if (!entry.window_from) {
          entry.window_from = new Date().toISOString();
        }

        // Data source: preserve from edge if exists, otherwise mark as manual
        if (source.cost_gbp.data_source) {
          entry.data_source = source.cost_gbp.data_source;
        } else if (source.cost_gbp.evidence?.source) {
          entry.data_source = {
            type: source.cost_gbp.evidence.source,
            retrieved_at: source.cost_gbp.evidence.retrieved_at || new Date().toISOString(),
            full_query: source.cost_gbp.evidence.full_query,
            debug_trace: source.cost_gbp.evidence.debug_trace
          };
        } else {
          entry.data_source = {
            type: 'manual',
            edited_at: new Date().toISOString()
          };
        }

        return entry;
      }
    },
    // Cost Time parameter: edge.labour_cost.* → parameter.values[]
    {
      sourceField: 'labour_cost.mean',
      targetField: 'values[]',
      condition: (source, target) => target.type === 'labour_cost' || target.parameter_type === 'labour_cost',
      transform: (value, source) => {
        const entry: any = { mean: value };

        // Statistical fields
        if (source.labour_cost.stdev !== undefined) entry.stdev = source.labour_cost.stdev;
        if (source.labour_cost.distribution) entry.distribution = source.labour_cost.distribution;

        // Evidence fields (if present - from data pulls)
        if (source.labour_cost.evidence) {
          if (source.labour_cost.evidence.n !== undefined) entry.n = source.labour_cost.evidence.n;
          if (source.labour_cost.evidence.k !== undefined) entry.k = source.labour_cost.evidence.k;
          if (source.labour_cost.evidence.window_from) entry.window_from = source.labour_cost.evidence.window_from;
          if (source.labour_cost.evidence.window_to) entry.window_to = source.labour_cost.evidence.window_to;
        }

        // If no evidence window_from, use current time
        if (!entry.window_from) {
          entry.window_from = new Date().toISOString();
        }

        // Data source: preserve from edge if exists, otherwise mark as manual
        if (source.labour_cost.data_source) {
          entry.data_source = source.labour_cost.data_source;
        } else if (source.labour_cost.evidence?.source) {
          entry.data_source = {
            type: source.labour_cost.evidence.source,
            retrieved_at: source.labour_cost.evidence.retrieved_at || new Date().toISOString(),
            full_query: source.labour_cost.evidence.full_query,
            debug_trace: source.labour_cost.evidence.debug_trace
          };
        } else {
          entry.data_source = {
            type: 'manual',
            edited_at: new Date().toISOString()
          };
        }

        return entry;
      }
    }

    // NOTE: Conditional probabilities (edge.conditional_p[i].p) reuse the same mappings above
    // The dataOperationsService must pass conditional_p[i].p (the ProbabilityParam object) as the source
    // This way, the probability parameter mappings work for both edge.p and edge.conditional_p[i].p
  ]);

  // Flow C.CREATE: Graph → File/Case (CREATE new file)
  // Note: When creating a new case file, we pre-populate it with helpful defaults from the graph
  // User will then edit the form and save. After that, case file and node metadata are independent.
  addMapping('graph_to_file', 'CREATE', 'case', [
    { sourceField: 'case.id', targetField: 'case.id' },  // case.id (inside case object, not root level)
    { sourceField: 'label', targetField: 'name' },  // Initialize case name from node label
    { sourceField: 'description', targetField: 'description' },  // Initialize case description from node
    { sourceField: 'case.variants', targetField: 'case.variants' }  // Variants go inside case object
  ]);

  // Flow C.UPDATE: Graph → File/Case (UPDATE current case metadata + variant weights)
  // Note: This updates case.variants array with current weights from graph
  // and also syncs connection settings from graph node to case file (under case.*).
  addMapping('graph_to_file', 'UPDATE', 'case', [
    {
      sourceField: 'case.variants',
      targetField: 'case.variants',
      transform: (graphVariants, source, target) => {
        // Update weights in case file from graph node
        // Preserve all other variant properties from file

        // If file doesn't have case.variants yet, just return graph variants
        if (!target.case?.variants || !Array.isArray(target.case.variants)) {
          return graphVariants.map((gv: any) => ({
            name: gv.name,
            weight: gv.weight,
            description: gv.description
          }));
        }

        // 1. Update existing file variants with graph data
        const updated = target.case.variants.map((fileVariant: any) => {
          const graphVariant = graphVariants.find((gv: any) => gv.name === fileVariant.name);
          if (graphVariant) {
            return {
              ...fileVariant,
              name: graphVariant.name_overridden ? graphVariant.name : fileVariant.name,
              weight: graphVariant.weight_overridden ? graphVariant.weight : fileVariant.weight,
              description: graphVariant.description_overridden ? graphVariant.description : fileVariant.description
            };
          }
          return fileVariant;
        });

        // 2. Add any new variants from graph that don't exist in file
        const fileVariantNames = new Set(target.case.variants.map((fv: any) => fv.name));
        const newVariants = graphVariants
          .filter((gv: any) => !fileVariantNames.has(gv.name))
          .map((gv: any) => ({
            name: gv.name,
            weight: gv.weight,
            description: gv.description
          }));

        return [...updated, ...newVariants];
      }
    },
    // Connection settings: always sync from graph case node to case file (nested under case.* per case-parameter-schema)
    {
      sourceField: 'case.connection',
      targetField: 'case.connection',
      condition: (source) => !!source.case?.connection
    },
    {
      sourceField: 'case.connection_string',
      targetField: 'case.connection_string',
      condition: (source) => !!source.case?.connection_string
    }
  ]);

  // Flow C.APPEND: Graph → File/Case (APPEND new schedule)
  addMapping('graph_to_file', 'APPEND', 'case', [
    {
      sourceField: 'case.variants',
      targetField: 'case.schedules[]',  // Case files have schedules under case.schedules, not at root
      transform: (variants) => ({
        variants: variants.map((v: any) => ({
          name: v.name,
          weight: v.weight
        })),
        window_from: new Date().toISOString(),
        source: 'manual',
        edited_at: new Date().toISOString()
        // TODO: Add author from credentials when available
      })
    }
  ]);

  // Flow D.CREATE: Graph → File/Node (CREATE new registry entry)
  addMapping('graph_to_file', 'CREATE', 'node', [
    { sourceField: 'id', targetField: 'id' },  // human-readable ID
    { sourceField: 'label', targetField: 'name' },
    { sourceField: 'description', targetField: 'description' },
    { sourceField: 'event_id', targetField: 'event_id' }
  ]);

  // Flow D.UPDATE: Graph → File/Node (UPDATE registry entry)
  addMapping('graph_to_file', 'UPDATE', 'node', [
    { sourceField: 'label', targetField: 'name' },
    { sourceField: 'description', targetField: 'description' },
    { sourceField: 'event_id', targetField: 'event_id' },
    {
      sourceField: 'url',
      targetField: 'url',
      overrideFlag: 'url_overridden'
    },
    {
      sourceField: 'images',
      targetField: 'images',
      overrideFlag: 'images_overridden',
      transform: (images) => {
        // When syncing graph → registry:
        // - Keep image_id, caption, file_extension
        // - Remove caption_overridden (graph-only field)
        // - Add uploaded_at, uploaded_by (registry fields)
        return images?.map((img: any) => ({
          image_id: img.image_id,
          caption: img.caption,
          file_extension: img.file_extension,
          uploaded_at: img.uploaded_at || new Date().toISOString(),
          uploaded_by: img.uploaded_by || 'unknown'
        }));
      }
    }
  ]);

  // Flow E.CREATE: Graph → File/Context (CREATE new registry entry)
  addMapping('graph_to_file', 'CREATE', 'context', [
    // Contexts are curated manually, not auto-created from graph
    // This mapping exists for completeness but is rarely used
  ]);

  // Flow F.CREATE: Graph → File/Event (CREATE new registry entry)
  addMapping('graph_to_file', 'CREATE', 'event', [
    // Events are curated manually, not auto-created from graph
    // This mapping exists for completeness but is rarely used
  ]);

  // ============================================================
  // Flows G-I: File → Graph
  // ============================================================

  // Flow G: File/Parameter → Graph (UPDATE edge)
  // Note: This updates edge.p.* fields (probability parameter data), NOT edge-level metadata
  // NOTE: conditional_probability type is treated identically to probability (PARITY PRINCIPLE)
  const isProbType = (source: any) =>
    source.type === 'probability' ||
    source.type === 'conditional_probability' ||
    source.parameter_type === 'probability' ||
    source.parameter_type === 'conditional_probability';

  addMapping('file_to_graph', 'UPDATE', 'parameter', [
    // Edge-level query configuration (file → graph)
    //
    // Graph-mastered policy (15-Dec-25):
    // - `edge.query`, `edge.n_query`, and `edge.p.latency.anchor_node_id` are graph-mastered,
    //   because the graph has the context to generate and validate them.
    // - Therefore, we DO NOT copy these fields from parameter files → graph edges.

    // Probability parameters → edge.p.*
    {
      sourceField: 'values[latest].mean',
      targetField: 'p.mean',
      overrideFlag: 'p.mean_overridden',
      condition: isProbType
    },
    {
      sourceField: 'values[latest].stdev',
      targetField: 'p.stdev',
      overrideFlag: 'p.stdev_overridden',
      condition: isProbType
    },
    {
      sourceField: 'values[latest].distribution',
      targetField: 'p.distribution',
      overrideFlag: 'p.distribution_overridden',
      condition: isProbType
    },
    {
      sourceField: 'values[latest].n',
      targetField: 'p.evidence.n',
      condition: isProbType
    },
    {
      sourceField: 'values[latest].k',
      targetField: 'p.evidence.k',
      condition: isProbType
    },
    {
      sourceField: 'values[latest].window_from',
      targetField: 'p.evidence.window_from',
      condition: isProbType,
      transform: (v) => (typeof v === 'string' ? normalizeToUK(v) : v)
    },
    {
      sourceField: 'values[latest].window_to',
      targetField: 'p.evidence.window_to',
      condition: isProbType,
      transform: (v) => (typeof v === 'string' ? normalizeToUK(v) : v)
    },
    {
      sourceField: 'values[latest].data_source',
      targetField: 'p.data_source',
      condition: isProbType
    },
    // Map data_source fields to evidence if data_source exists
    {
      sourceField: 'values[latest].data_source.retrieved_at',
      targetField: 'p.evidence.retrieved_at',
      condition: (source) => isProbType(source) && source.values?.[source.values.length - 1]?.data_source?.retrieved_at
    },
    {
      sourceField: 'values[latest].data_source.type',
      targetField: 'p.evidence.source',
      condition: (source) => isProbType(source) && source.values?.[source.values.length - 1]?.data_source?.type
    },
    {
      sourceField: 'values[latest].data_source.full_query',
      targetField: 'p.evidence.full_query',
      condition: (source) => isProbType(source) && source.values?.[source.values.length - 1]?.data_source?.full_query
    },
    {
      sourceField: 'values[latest].data_source.debug_trace',
      targetField: 'p.evidence.debug_trace',
      condition: (source) => isProbType(source) && source.values?.[source.values.length - 1]?.data_source?.debug_trace
    },
    // LAG FIX (lag-fixes.md §4.3): Map evidence scalars to edge
    // evidence.mean = raw observed rate (k/n), evidence.stdev = binomial uncertainty
    {
      sourceField: 'values[latest].evidence.mean',
      targetField: 'p.evidence.mean',
      condition: (source) => isProbType(source) && source.values?.[source.values.length - 1]?.evidence?.mean !== undefined
    },
    {
      sourceField: 'values[latest].evidence.stdev',
      targetField: 'p.evidence.stdev',
      condition: (source) => isProbType(source) && source.values?.[source.values.length - 1]?.evidence?.stdev !== undefined
    },

    // LAG: Latency CONFIG fields (file → graph, bidirectional)
    // latency_parameter: explicit enablement flag
    {
      sourceField: 'latency.latency_parameter',
      targetField: 'p.latency.latency_parameter',
      overrideFlag: 'p.latency.latency_parameter_overridden',
      condition: isProbType
    },
    { sourceField: 'latency.latency_parameter_overridden', targetField: 'p.latency.latency_parameter_overridden', requiresIgnoreOverrideFlags: true },
    // anchor_node_id is graph-mastered (see note above) – do not copy from file → graph.
    // t95 and path_t95: horizon fields (derived but user-overridable)
    {
      sourceField: 'latency.t95',
      targetField: 'p.latency.t95',
      overrideFlag: 'p.latency.t95_overridden',
      condition: isProbType
    },
    { sourceField: 'latency.t95_overridden', targetField: 'p.latency.t95_overridden', requiresIgnoreOverrideFlags: true },
    {
      sourceField: 'latency.path_t95',
      targetField: 'p.latency.path_t95',
      overrideFlag: 'p.latency.path_t95_overridden',
      condition: isProbType
    },
    { sourceField: 'latency.path_t95_overridden', targetField: 'p.latency.path_t95_overridden', requiresIgnoreOverrideFlags: true },
    // onset_delta_days: onset delay (user-overridable, edge-level)
    {
      sourceField: 'latency.onset_delta_days',
      targetField: 'p.latency.onset_delta_days',
      overrideFlag: 'p.latency.onset_delta_days_overridden',
      condition: isProbType
    },
    { sourceField: 'latency.onset_delta_days_overridden', targetField: 'p.latency.onset_delta_days_overridden', requiresIgnoreOverrideFlags: true },
    // mu, sigma, model_trained_at: fitted model params (internal, no override flags)
    { sourceField: 'latency.mu', targetField: 'p.latency.mu', condition: isProbType },
    { sourceField: 'latency.sigma', targetField: 'p.latency.sigma', condition: isProbType },
    { sourceField: 'latency.model_trained_at', targetField: 'p.latency.model_trained_at', condition: isProbType },
    // path_mu, path_sigma, path_onset_delta_days: path-level A→Y CDF params (Fenton–Wilkinson, internal)
    { sourceField: 'latency.path_mu', targetField: 'p.latency.path_mu', condition: isProbType },
    { sourceField: 'latency.path_sigma', targetField: 'p.latency.path_sigma', condition: isProbType },
    { sourceField: 'latency.path_onset_delta_days', targetField: 'p.latency.path_onset_delta_days', condition: isProbType },

    // Bayesian posteriors (doc 21: unified posterior schema)
    // File has posterior.slices with unified entries. We project onto graph
    // edge in the shapes UI components expect (ProbabilityPosterior on
    // p.posterior, LatencyPosterior on p.latency.posterior). Strips
    // fit_history/slices/_model_state from the graph copy.
    {
      sourceField: 'posterior',
      targetField: 'p.posterior',
      condition: (source) => isProbType(source) && source.posterior?.slices !== undefined,
      transform: (value: any) => {
        if (!value || typeof value !== 'object' || !value.slices) return value;
        const windowSlice = value.slices['window()'];
        if (!windowSlice) return undefined;
        // Project ProbabilityPosterior shape from window() + cohort() slices
        const cs = value.slices['cohort()'];
        return {
          distribution: 'beta',
          alpha: windowSlice.alpha,
          beta: windowSlice.beta,
          hdi_lower: windowSlice.p_hdi_lower,
          hdi_upper: windowSlice.p_hdi_upper,
          hdi_level: value.hdi_level ?? 0.9,
          ess: windowSlice.ess,
          rhat: windowSlice.rhat,
          evidence_grade: windowSlice.evidence_grade ?? 0,
          fitted_at: value.fitted_at,
          fingerprint: value.fingerprint,
          provenance: windowSlice.provenance ?? 'bayesian',
          divergences: windowSlice.divergences ?? 0,
          prior_tier: value.prior_tier ?? 'uninformative',
          surprise_z: value.surprise_z,
          // Path-level from cohort() slice
          ...(cs?.alpha != null ? {
            path_alpha: cs.alpha,
            path_beta: cs.beta,
            path_hdi_lower: cs.p_hdi_lower,
            path_hdi_upper: cs.p_hdi_upper,
            path_provenance: cs.provenance ?? 'bayesian',
          } : {}),
        };
      },
    },
    // Latency posterior — projected from unified posterior.slices onto p.latency.posterior
    {
      sourceField: 'posterior',
      targetField: 'p.latency.posterior',
      condition: (source) => isProbType(source) && source.posterior?.slices?.['window()']?.mu_mean !== undefined,
      transform: (value: any) => {
        if (!value || typeof value !== 'object' || !value.slices) return undefined;
        const ws = value.slices['window()'];
        const cs = value.slices['cohort()'];
        if (!ws?.mu_mean) return undefined;
        // Project LatencyPosterior shape from window + cohort slices
        return {
          distribution: 'lognormal',
          onset_delta_days: ws.onset_mean ?? 0,
          mu_mean: ws.mu_mean,
          mu_sd: ws.mu_sd,
          sigma_mean: ws.sigma_mean,
          sigma_sd: ws.sigma_sd,
          hdi_t95_lower: ws.hdi_t95_lower,
          hdi_t95_upper: ws.hdi_t95_upper,
          hdi_level: value.hdi_level ?? 0.9,
          ess: ws.ess,
          rhat: ws.rhat,
          fitted_at: value.fitted_at,
          fingerprint: value.fingerprint,
          provenance: ws.provenance ?? 'bayesian',
          ...(ws.onset_mean != null ? { onset_mean: ws.onset_mean, onset_sd: ws.onset_sd } : {}),
          ...(ws.onset_mu_corr != null ? { onset_mu_corr: ws.onset_mu_corr } : {}),
          // Path-level from cohort() slice
          ...(cs?.mu_mean != null ? {
            path_onset_delta_days: cs.onset_mean,
            path_onset_sd: cs.onset_sd,
            path_mu_mean: cs.mu_mean,
            path_mu_sd: cs.mu_sd,
            path_sigma_mean: cs.sigma_mean,
            path_sigma_sd: cs.sigma_sd,
            ...(cs.hdi_t95_lower != null ? { path_hdi_t95_lower: cs.hdi_t95_lower, path_hdi_t95_upper: cs.hdi_t95_upper } : {}),
            ...(cs.onset_mu_corr != null ? { path_onset_mu_corr: cs.onset_mu_corr } : {}),
            path_provenance: cs.provenance,
          } : {}),
        };
      },
    },

    // LAG: Latency DATA fields (file → graph only, display-only)
    {
      sourceField: 'values[latest].latency.median_lag_days',
      targetField: 'p.latency.median_lag_days',
      condition: (source) => isProbType(source) && source.values?.[source.values.length - 1]?.latency?.median_lag_days !== undefined
    },
    {
      sourceField: 'values[latest].latency.completeness',
      targetField: 'p.latency.completeness',
      condition: (source) => isProbType(source) && source.values?.[source.values.length - 1]?.latency?.completeness !== undefined
    },
    {
      sourceField: 'values[latest].latency.t95',
      targetField: 'p.latency.t95',
      condition: (source) => isProbType(source) && source.values?.[source.values.length - 1]?.latency?.t95 !== undefined
    },
    {
      sourceField: 'values[latest].latency.path_t95',
      targetField: 'p.latency.path_t95',
      condition: (source) => isProbType(source) && source.values?.[source.values.length - 1]?.latency?.path_t95 !== undefined
    },

    // LAG: Forecast fields (file → graph only)
    {
      sourceField: 'values[latest].forecast',
      targetField: 'p.forecast.mean',
      condition: (source) => isProbType(source) && source.values?.[source.values.length - 1]?.forecast !== undefined
    },

    // Cost GBP parameters → edge.cost_gbp.*
    {
      sourceField: 'values[latest].mean',
      targetField: 'cost_gbp.mean',
      overrideFlag: 'cost_gbp.mean_overridden',
      condition: (source) => source.type === 'cost_gbp' || source.parameter_type === 'cost_gbp'
    },
    {
      sourceField: 'values[latest].stdev',
      targetField: 'cost_gbp.stdev',
      overrideFlag: 'cost_gbp.stdev_overridden',
      condition: (source) => source.type === 'cost_gbp' || source.parameter_type === 'cost_gbp'
    },
    {
      sourceField: 'values[latest].distribution',
      targetField: 'cost_gbp.distribution',
      overrideFlag: 'cost_gbp.distribution_overridden',
      condition: (source) => source.type === 'cost_gbp' || source.parameter_type === 'cost_gbp'
    },
    {
      sourceField: 'values[latest].window_from',
      targetField: 'cost_gbp.evidence.window_from',
      condition: (source) => source.type === 'cost_gbp' || source.parameter_type === 'cost_gbp',
      transform: (v) => (typeof v === 'string' ? normalizeToUK(v) : v)
    },
    {
      sourceField: 'values[latest].window_to',
      targetField: 'cost_gbp.evidence.window_to',
      condition: (source) => source.type === 'cost_gbp' || source.parameter_type === 'cost_gbp',
      transform: (v) => (typeof v === 'string' ? normalizeToUK(v) : v)
    },

    // Cost Time parameters → edge.labour_cost.*
    {
      sourceField: 'values[latest].mean',
      targetField: 'labour_cost.mean',
      overrideFlag: 'labour_cost.mean_overridden',
      condition: (source) => source.type === 'labour_cost' || source.parameter_type === 'labour_cost'
    },
    {
      sourceField: 'values[latest].stdev',
      targetField: 'labour_cost.stdev',
      overrideFlag: 'labour_cost.stdev_overridden',
      condition: (source) => source.type === 'labour_cost' || source.parameter_type === 'labour_cost'
    },
    {
      sourceField: 'values[latest].distribution',
      targetField: 'labour_cost.distribution',
      overrideFlag: 'labour_cost.distribution_overridden',
      condition: (source) => source.type === 'labour_cost' || source.parameter_type === 'labour_cost'
    },
    {
      sourceField: 'values[latest].window_from',
      targetField: 'labour_cost.evidence.window_from',
      condition: (source) => source.type === 'labour_cost' || source.parameter_type === 'labour_cost',
      transform: (v) => (typeof v === 'string' ? normalizeToUK(v) : v)
    },
    {
      sourceField: 'values[latest].window_to',
      targetField: 'labour_cost.evidence.window_to',
      condition: (source) => source.type === 'labour_cost' || source.parameter_type === 'labour_cost',
      transform: (v) => (typeof v === 'string' ? normalizeToUK(v) : v)
    },
    {
      sourceField: 'values[latest].data_source',
      targetField: 'labour_cost.data_source',
      condition: (source) => source.type === 'labour_cost' || source.parameter_type === 'labour_cost'
    },
    {
      sourceField: 'values[latest].data_source.retrieved_at',
      targetField: 'labour_cost.evidence.retrieved_at',
      condition: (source) => (source.type === 'labour_cost' || source.parameter_type === 'labour_cost') && source.values?.[source.values.length - 1]?.data_source?.retrieved_at
    },
    {
      sourceField: 'values[latest].data_source.type',
      targetField: 'labour_cost.evidence.source',
      condition: (source) => (source.type === 'labour_cost' || source.parameter_type === 'labour_cost') && source.values?.[source.values.length - 1]?.data_source?.type
    },
    {
      sourceField: 'values[latest].data_source.full_query',
      targetField: 'labour_cost.evidence.full_query',
      condition: (source) => (source.type === 'labour_cost' || source.parameter_type === 'labour_cost') && source.values?.[source.values.length - 1]?.data_source?.full_query
    },
    {
      sourceField: 'values[latest].data_source.debug_trace',
      targetField: 'labour_cost.evidence.debug_trace',
      condition: (source) => (source.type === 'labour_cost' || source.parameter_type === 'labour_cost') && source.values?.[source.values.length - 1]?.data_source?.debug_trace
    },

    // NOTE: Query string is NOT synced from file→graph
    // The dataOperationsService must:
    // 1. Find the conditional_p[i] element that matches the target param (by p.id)
    // 2. Pass conditional_p[i].p (the ProbabilityParam object) as the target to UpdateManager
    // 3. After update, replace conditional_p[i].p with the updated object
    // This way, the same mappings work for both edge.p and edge.conditional_p[i].p

    // NOTE: We do NOT map parameter.name or parameter.description to edge.label or edge.description
    // Those are edge-level metadata and should be independent of the parameter

    // Connection settings: file → graph sync
    // NOTE: connection NAME no longer syncs from file → graph. Connection is a graph-level concern
    // (resolved from edge.p.connection → graph.defaultConnection). The file carries connection as
    // provenance only (written by graph→file flow, not read back).
    // Connection STRING still syncs (per-parameter provider-specific config).
    // Probability parameter connection_string
    {
      sourceField: 'connection_string',
      targetField: 'p.connection_string',
      overrideFlag: 'p.connection_overridden',
      condition: (source) => (source.type === 'probability' || source.parameter_type === 'probability') && !!source.connection_string
    },
    // Cost GBP parameter connection_string
    {
      sourceField: 'connection_string',
      targetField: 'cost_gbp.connection_string',
      overrideFlag: 'cost_gbp.connection_overridden',
      condition: (source) => (source.type === 'cost_gbp' || source.parameter_type === 'cost_gbp') && !!source.connection_string
    },
    // Cost Time parameter connection_string
    {
      sourceField: 'connection_string',
      targetField: 'labour_cost.connection_string',
      overrideFlag: 'labour_cost.connection_overridden',
      condition: (source) => (source.type === 'labour_cost' || source.parameter_type === 'labour_cost') && !!source.connection_string
    }
  ]);

  // Flow H: File/Case → Graph (UPDATE case node)
  // Note: This updates node.case.* fields (case-specific data), NOT node-level metadata
  // Node label/description come from node files, not case files
  addMapping('file_to_graph', 'UPDATE', 'case', [
    // Case status
    {
      sourceField: 'case.status',
      targetField: 'case.status',
      overrideFlag: 'case.status_overridden'
    },
    // Case variants - prefer schedules[latest].variants if schedules exist
    {
      sourceField: 'case.variants',  // Fallback field
      targetField: 'case.variants',
      transform: (fileVariants, source, target) => {
        // Sync variant names and weights from case file to graph node
        // Respect override flags: if graph has overridden a variant, preserve it

        // Normalize fileVariants to array format
        let normalizedFileVariants = fileVariants;
        if (fileVariants && !Array.isArray(fileVariants) && typeof fileVariants === 'object') {
          normalizedFileVariants = Object.entries(fileVariants).map(([name, weight]) => ({
            name,
            weight: typeof weight === 'number' ? weight : parseFloat(String(weight))
          }));
        }

        // If case file has schedules, use the latest schedule's variants
        let variantsToUse = normalizedFileVariants;
        if (source.case?.schedules && source.case.schedules.length > 0) {
          // Get schedules[latest] by timestamp
          const sortedSchedules = source.case.schedules.slice().sort((a: any, b: any) => {
            const timeA = a.window_from ? new Date(a.window_from).getTime() : 0;
            const timeB = b.window_from ? new Date(b.window_from).getTime() : 0;
            return timeB - timeA; // Most recent first
          });
          const scheduleVariants = sortedSchedules[0].variants;

          // Convert variants from object/map to array if necessary
          // Schema has two formats:
          // - Array: [{ name: 'control', weight: 0.5 }, ...]
          // - Object/Map: { control: 0.5, 'single-page': 0.5 }
          if (Array.isArray(scheduleVariants)) {
            variantsToUse = scheduleVariants;
          } else if (scheduleVariants && typeof scheduleVariants === 'object') {
            // Convert object to array
            variantsToUse = Object.entries(scheduleVariants).map(([name, weight]) => ({
              name,
              weight: typeof weight === 'number' ? weight : parseFloat(String(weight))
            }));
          }
        }

        // If target doesn't have variants yet, create fresh from file
        if (!target.case || !target.case.variants || target.case.variants.length === 0) {
          return variantsToUse.map((fv: any) => ({
            name: fv.name,
            name_overridden: false,
            weight: fv.weight,
            weight_overridden: false,
            description: fv.description,
            description_overridden: false
          }));
        }

      // Merge: respect overrides, sync non-overridden fields
      // 1. Start with all variants from file (these are authoritative)
      const merged = variantsToUse.map((fv: any) => {
        const graphVariant = target.case.variants.find((gv: any) => gv.name === fv.name);

        return {
          name: graphVariant?.name_overridden ? graphVariant.name : fv.name,
          name_overridden: graphVariant?.name_overridden ?? false,
          weight: graphVariant?.weight_overridden ? graphVariant.weight : fv.weight,
          weight_overridden: graphVariant?.weight_overridden ?? false,
          description: graphVariant?.description_overridden ? graphVariant.description : fv.description,
          description_overridden: graphVariant?.description_overridden ?? false,
          // Preserve graph-only fields (e.g. edges array)
          ...(graphVariant && graphVariant.edges ? { edges: graphVariant.edges } : {})
        };
      });

      // 2. Preserve graph-only variants ONLY if they have edges or overrides
      // Non-overridden variants without edges are "disposable" and should be removed on GET
      const fileVariantNames = new Set(variantsToUse.map((fv: any) => fv.name));
      const graphOnlyVariants = target.case.variants.filter((gv: any) => {
        if (fileVariantNames.has(gv.name)) return false; // Already in file

        // Keep if it has edges or any override flags
        return gv.edges?.length > 0 ||
               gv.name_overridden ||
               gv.weight_overridden ||
               gv.description_overridden;
      });

      return [...merged, ...graphOnlyVariants];
      }
    }
    // NOTE: We do NOT map case.name or case.description to node.label or node.description
    // Those are node-level metadata and come from node files, not case files
    // If needed, we could add node.case.name and node.case.description fields for case metadata
  ]);

  // Flow I: File/Node → Graph (UPDATE node from registry)
  addMapping('file_to_graph', 'UPDATE', 'node', [
    {
      sourceField: 'name',
      targetField: 'label',
      overrideFlag: 'label_overridden'
    },
    {
      sourceField: 'description',
      targetField: 'description',
      overrideFlag: 'description_overridden'
    },
    {
      sourceField: 'event_id',
      targetField: 'event_id',
      overrideFlag: 'event_id_overridden'
    },
    {
      sourceField: 'url',
      targetField: 'url',
      overrideFlag: 'url_overridden'
    },
    {
      sourceField: 'images',
      targetField: 'images',
      overrideFlag: 'images_overridden',
      transform: (images: any) => {
        // When syncing registry → graph:
        // - Keep image_id, caption, file_extension
        // - Remove uploaded_at, uploaded_by (registry-only fields)
        // - Add caption_overridden: false
        return images?.map((img: any) => ({
          image_id: img.image_id,
          caption: img.caption,
          file_extension: img.file_extension,
          caption_overridden: false
        }));
      }
    }
  ]);

  // ============================================================
  // Flows L-M: External → Graph
  // ============================================================

  // Flow L: External → Graph/Parameter (UPDATE edge directly)
  // Uses schema terminology: mean, n, k, stdev (not external API terminology)
  addMapping('external_to_graph', 'UPDATE', 'parameter', [
    {
      sourceField: 'mean',
      targetField: 'p.mean',
      overrideFlag: 'p.mean_overridden',
      transform: (mean, source) => {
        // Prefer explicit mean if provided (may be adjusted/rounded)
        // Only recalculate if explicit mean not available
        if (mean !== undefined && mean !== null) {
          return roundToDP(mean);
        }
        // Fallback: calculate from n/k if both are available
        if (source.n > 0 && source.k !== undefined) {
          // Calculate mean, clamping to [0, 1] in case of data errors
          const calculated = source.k / source.n;
          return roundToDP(Math.max(0, Math.min(1, calculated)));
        }
        // No mean data available - don't update mean
        return undefined;
      }
    },
    {
      sourceField: 'stdev',
      targetField: 'p.stdev',
      overrideFlag: 'p.stdev_overridden',
      transform: (stdev, _source) => {
        // Round stdev to standard precision for consistency
        if (stdev !== undefined && stdev !== null) {
          return roundToDP(stdev);
        }
        return undefined;
      }
    },
    {
      sourceField: 'n',
      targetField: 'p.evidence.n'
    },
    {
      sourceField: 'k',
      targetField: 'p.evidence.k'
    },
    {
      // CRITICAL: Evidence mode uses p.evidence.mean (not p.mean).
      // If this stays stale while n/k update, E-mode computations and logs will be wrong.
      sourceField: 'mean',
      targetField: 'p.evidence.mean',
      transform: (mean, source) => {
        if (mean !== undefined && mean !== null) {
          return roundToDP(mean);
        }
        if (source.n > 0 && source.k !== undefined) {
          const calculated = source.k / source.n;
          return roundToDP(Math.max(0, Math.min(1, calculated)));
        }
        return undefined;
      }
    },
    {
      sourceField: 'window_from',
      targetField: 'p.evidence.window_from',
      transform: (v) => (typeof v === 'string' ? normalizeToUK(v) : v)
    },
    {
      sourceField: 'window_to',
      targetField: 'p.evidence.window_to',
      transform: (v) => (typeof v === 'string' ? normalizeToUK(v) : v)
    },
    {
      sourceField: 'retrieved_at',
      targetField: 'p.evidence.retrieved_at'
    },
    {
      sourceField: 'source',
      targetField: 'p.evidence.source'
    },
    {
      sourceField: 'data_source',
      targetField: 'p.data_source'
    }
  ]);

  // Flow M: External → Graph/Case (UPDATE case node directly)
  // NOTE: External sources do NOT define variants - they only provide weights
  // that map to user-defined variants in the case file. This mapping ONLY
  // updates existing variants, it does NOT add new ones.
  addMapping('external_to_graph', 'UPDATE', 'case', [
    {
      sourceField: 'variants',
      targetField: 'case.variants',
      transform: (externalVariants, source, target) => {
        // Update weights for existing variants only (by name match)
        // Respect weight_overridden flags
        if (!target.case?.variants || !Array.isArray(externalVariants)) {
          return target.case?.variants || [];
        }

        return target.case.variants.map((v: any) => {
          const externalVariant = externalVariants.find((ev: any) => ev.name === v.name);

          // Only update weight if NOT overridden and external has data
          const shouldUpdate = !v.weight_overridden && externalVariant;

          return {
            ...v,
            weight: shouldUpdate ? externalVariant.weight : v.weight
          };
        });
      }
    },
    {
      sourceField: 'data_source',
      targetField: 'case.evidence',
      transform: (dataSource) => ({
        source: dataSource?.connection || dataSource?.type,
        fetched_at: dataSource?.retrieved_at,
        path: 'direct'
      })
    }
  ]);

  // ============================================================
  // Flows Q-R: External → File
  // ============================================================

  // Flow Q: External → File/Parameter (APPEND to values[])
  // Uses schema terminology: mean, n, k, stdev (not external API terminology)
  addMapping('external_to_file', 'APPEND', 'parameter', [
    {
      sourceField: 'data',
      targetField: 'values[]',
      transform: (externalData) => {
        // Calculate mean from n/k if not provided directly
        let mean = externalData.mean;
        if (mean === undefined && externalData.n > 0 && externalData.k !== undefined) {
          // Calculate and clamp to [0, 1]
          mean = Math.max(0, Math.min(1, externalData.k / externalData.n));
        }

        // Build value object with whatever fields we have (using schema terminology)
        const value: any = {};
        if (mean !== undefined) value.mean = mean;
        if (externalData.stdev !== undefined) value.stdev = externalData.stdev;
        if (externalData.n !== undefined) value.n = externalData.n;
        if (externalData.k !== undefined) value.k = externalData.k;
        if (externalData.window_from) value.window_from = externalData.window_from;
        if (externalData.window_to) value.window_to = externalData.window_to;
        if (externalData.retrieved_at) value.retrieved_at = externalData.retrieved_at;

        return value;
      }
    }
  ]);

  // Flow R: External → File/Case (APPEND to schedules[])
  addMapping('external_to_file', 'APPEND', 'case', [
    {
      sourceField: 'data',
      targetField: 'schedules[]',
      transform: (externalData) => ({
        variants: externalData.variants.map((v: any) => ({
          name: v.name,
          weight: v.weight
        })),
        window_from: externalData.window_from,
        window_to: externalData.window_to,
        retrieved_at: externalData.retrieved_at
      })
    }
  ]);

  return map;
}

// ============================================================
// Module-level singleton (eager-init, replaces lazy-init pattern)
// ============================================================

/**
 * All mapping configurations, keyed by `direction:operation[:subDestination]`.
 *
 * This replaces the class-level `sharedMappingConfigurations` static.
 * Module-level constants are effectively eager-init singletons — built once
 * on first import, shared across all consumers.
 */
export const MAPPING_CONFIGURATIONS: ReadonlyMap<string, MappingConfiguration> =
  buildMappingConfigurations();
