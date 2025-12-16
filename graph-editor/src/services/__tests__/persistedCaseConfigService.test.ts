/**
 * PersistedCaseConfigService – source selection matrix
 *
 * Proves the contract:
 * - Versioned case operations (versionedCase=true) prefer case file config when present.
 * - Direct case operations (versionedCase=false) use graph node inline case config.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { selectPersistedCaseConfig } from '../persistedCaseConfigService';

describe('selectPersistedCaseConfig', () => {
  it('uses file config in versionedCase mode when file data exists', () => {
    const cfg = selectPersistedCaseConfig({
      versionedCase: true,
      fileCaseData: { id: 'c1', connection: 'from-file', connection_string: '{"a":1}' },
      graphNode: { case: { id: 'c1', connection: 'from-graph', connection_string: '{"a":2}' } },
    });

    expect(cfg.source).toBe('file');
    expect(cfg.connection).toBe('from-file');
    expect(cfg.connection_string).toBe('{"a":1}');
  });

  it('uses graph config in versionedCase mode when file data is missing', () => {
    const cfg = selectPersistedCaseConfig({
      versionedCase: true,
      fileCaseData: undefined,
      graphNode: { case: { id: 'c1', connection: 'from-graph', connection_string: '{"a":2}' } },
    });

    expect(cfg.source).toBe('graph');
    expect(cfg.connection).toBe('from-graph');
  });

  it('uses graph config in direct mode even if file data exists', () => {
    const cfg = selectPersistedCaseConfig({
      versionedCase: false,
      fileCaseData: { id: 'c1', connection: 'from-file', connection_string: '{"a":1}' },
      graphNode: { case: { id: 'c1', connection: 'from-graph', connection_string: '{"a":2}' } },
    });

    expect(cfg.source).toBe('graph');
    expect(cfg.connection).toBe('from-graph');
    expect(cfg.connection_string).toBe('{"a":2}');
  });
});




