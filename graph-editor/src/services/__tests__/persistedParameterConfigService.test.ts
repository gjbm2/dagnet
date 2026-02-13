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
import { selectPersistedProbabilityConfig } from '../persistedParameterConfigService';

describe('selectPersistedProbabilityConfig', () => {
  it('uses file config in versioned mode — but connection comes from graph, not file', () => {
    const cfg = selectPersistedProbabilityConfig({
      writeToFile: true,
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

    expect(cfg.source).toBe('file');
    // Connection name resolved from graph, NOT file (graph-level concern)
    expect(cfg.connection).toBe('from-graph');
    // Connection string still from file (per-parameter config)
    expect(cfg.connection_string).toBe('{"a":1}');
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




