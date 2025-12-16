/**
 * PersistedParameterConfigService – source selection matrix
 *
 * Proves the contract:
 * - Versioned operations (writeToFile=true) prefer the parameter file's persisted config when present.
 * - Direct operations (writeToFile=false) use the graph's persisted config.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { selectPersistedProbabilityConfig } from '../persistedParameterConfigService';

describe('selectPersistedProbabilityConfig', () => {
  it('uses file config in versioned mode when file data exists', () => {
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
    expect(cfg.connection).toBe('from-file');
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
});



