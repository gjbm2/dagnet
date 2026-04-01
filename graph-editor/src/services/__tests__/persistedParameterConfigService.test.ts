/**
 * PersistedParameterConfigService – source selection matrix
 *
 * Proves the contract:
 * - Versioned operations (writeToFile=true) prefer the parameter file's persisted config when present.
 * - Direct operations (writeToFile=false) use the graph's persisted config.
 * - Connection name ALWAYS comes from graph param (not file) — connection is a graph-level concern.
 * - Connection string still comes from file for versioned mode (per-parameter config).
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { selectPersistedProbabilityConfig, mergeLatencyConfig } from '../persistedParameterConfigService';

describe('selectPersistedProbabilityConfig', () => {
  it('uses file config in versioned mode — but connection comes from graph, not file', () => {
    const cfg = selectPersistedProbabilityConfig({
      writeToFile: true,
      fileParamData: {
        connection: 'from-file',
        connection_string: '{"a":1}',
        latency: { path_t95: 40, path_t95_overridden: true },  // locked on file
      },
      graphParam: {
        connection: 'from-graph',
        connection_string: '{"a":2}',
        latency: { path_t95: 26 },
      },
    });

    expect(cfg.source).toBe('file');
    // Connection name resolved from graph, NOT file (graph-level concern)
    expect(cfg.connection).toBe('from-graph');
    // Connection string still from file (per-parameter config)
    expect(cfg.connection_string).toBe('{"a":1}');
    // path_t95 locked on file — file value preserved
    expect(cfg.latency?.path_t95).toBe(40);
  });

  it('uses graph config in versioned mode when file data is missing', () => {
    const cfg = selectPersistedProbabilityConfig({
      writeToFile: true,
      fileParamData: undefined,
      graphParam: {
        connection: 'from-graph',
        connection_string: '{"a":2}',
        latency: { path_t95: 26 },
      },
    });

    expect(cfg.source).toBe('graph');
    expect(cfg.connection).toBe('from-graph');
    expect(cfg.latency?.path_t95).toBe(26);
  });

  it('uses graph config in direct mode even if file data exists', () => {
    const cfg = selectPersistedProbabilityConfig({
      writeToFile: false,
      fileParamData: {
        connection: 'from-file',
        connection_string: '{"a":1}',
        latency: { path_t95: 40 },
      },
      graphParam: {
        connection: 'from-graph',
        connection_string: '{"a":2}',
        latency: { path_t95: 26 },
      },
    });

    expect(cfg.source).toBe('graph');
    expect(cfg.connection).toBe('from-graph');
    expect(cfg.connection_string).toBe('{"a":2}');
    expect(cfg.latency?.path_t95).toBe(26);
  });

  it('returns undefined connection when graph param has no connection (caller falls back to graph.defaultConnection)', () => {
    const cfg = selectPersistedProbabilityConfig({
      writeToFile: true,
      fileParamData: {
        connection: 'from-file',
        connection_string: '{"a":1}',
      },
      graphParam: {
        // No connection on graph param
        connection_string: '{"a":2}',
      },
    });

    expect(cfg.source).toBe('file');
    // Connection undefined because graph param has no connection
    // Caller should fall back to graph.defaultConnection
    expect(cfg.connection).toBeUndefined();
    // Connection string still from file
    expect(cfg.connection_string).toBe('{"a":1}');
  });

  it('file connection is ignored even when graph param connection is undefined', () => {
    const cfg = selectPersistedProbabilityConfig({
      writeToFile: true,
      fileParamData: {
        connection: 'amplitude-prod',
        connection_string: '{"segment":"mobile"}',
      },
      graphParam: {},
    });

    expect(cfg.source).toBe('file');
    // File connection NOT used — connection is graph-level only
    expect(cfg.connection).toBeUndefined();
  });
});

// ============================================================================
// mergeLatencyConfig — lazy cascade tests
// ============================================================================

describe('mergeLatencyConfig', () => {
  it('should cascade graph latency_parameter when file lacks it (the bug scenario)', () => {
    const result = mergeLatencyConfig(
      { t95: 14, path_t95: 40 },                                          // file: no latency_parameter
      { latency_parameter: true, latency_parameter_overridden: true, anchor_node_id: 'anchor-1' },  // graph
    );

    // Graph-mastered and override-gated fields cascaded from graph
    expect(result?.latency_parameter).toBe(true);
    expect(result?.latency_parameter_overridden).toBe(true);
    expect(result?.anchor_node_id).toBe('anchor-1');
    // File-mastered derived fields preserved from file
    expect(result?.t95).toBe(14);
    expect(result?.path_t95).toBe(40);
  });

  it('should respect file lock — file t95_overridden blocks graph cascade', () => {
    const result = mergeLatencyConfig(
      { t95: 14, t95_overridden: true },   // file: locked
      { t95: 30 },                          // graph: wants to cascade
    );

    expect(result?.t95).toBe(14);           // file wins — locked
    expect(result?.t95_overridden).toBe(true);
  });

  it('should cascade graph t95 when file is NOT locked', () => {
    const result = mergeLatencyConfig(
      { t95: 14 },                                    // file: not locked (no t95_overridden)
      { t95: 30, t95_overridden: true },               // graph
    );

    expect(result?.t95).toBe(30);                      // graph cascades
    expect(result?.t95_overridden).toBe(true);          // flag cascades too
  });

  it('should always use file for file-mastered fields (no override mechanism)', () => {
    const result = mergeLatencyConfig(
      { mu: 2.5, sigma: 0.8 },
      { mu: 3.0, sigma: 1.2 },
    );

    expect(result?.mu).toBe(2.5);
    expect(result?.sigma).toBe(0.8);
  });

  it('should use graph wholesale when file has no latency', () => {
    const result = mergeLatencyConfig(
      undefined,
      { latency_parameter: true, t95: 30, anchor_node_id: 'node-A' },
    );

    expect(result?.latency_parameter).toBe(true);
    expect(result?.t95).toBe(30);
    expect(result?.anchor_node_id).toBe('node-A');
  });

  it('should return undefined when neither has latency', () => {
    expect(mergeLatencyConfig(undefined, undefined)).toBeUndefined();
  });

  it('should always overlay anchor_node_id from graph (inherently graph-mastered)', () => {
    const result = mergeLatencyConfig(
      { anchor_node_id: 'file-anchor', anchor_node_id_overridden: true },   // file has it locked
      { anchor_node_id: 'graph-anchor', anchor_node_id_overridden: false },  // graph has different
    );

    // anchor_node_id is inherently graph-mastered — always from graph
    expect(result?.anchor_node_id).toBe('graph-anchor');
    expect(result?.anchor_node_id_overridden).toBe(false);
  });
});




