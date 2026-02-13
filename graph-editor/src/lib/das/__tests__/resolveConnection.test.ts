/**
 * resolveConnection — tests for connection inheritance (`extends`).
 */
import { describe, it, expect } from 'vitest';
import { resolveConnection, resolveAllConnections } from '../resolveConnection';
import type { ConnectionDefinition } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid connection (all required fields). */
function makeConnection(overrides: Partial<ConnectionDefinition> & { name: string }): ConnectionDefinition {
  return {
    provider: 'amplitude',
    kind: 'http',
    adapter: {
      request: { method: 'GET', path_template: '/api/test' },
      response: {},
      upsert: { mode: 'merge', writes: [] },
    },
    ...overrides,
  } as ConnectionDefinition;
}

const parentConnection = makeConnection({
  name: 'amplitude-prod',
  description: 'Production Amplitude',
  credsRef: 'amplitude',
  enabled: true,
  defaults: {
    base_url: 'https://amplitude.com/api/2',
    excluded_cohorts: ['cohort-abc'],
    timeout_ms: 30000,
  },
  capabilities: {
    supports_native_exclude: true,
    supports_visited: true,
    max_funnel_length: 10,
  } as any,
  adapter: {
    pre_request: { script: 'const x = 1;' },
    request: { method: 'POST', path_template: '/api/2/funnels' },
    response: { extract: [{ name: 'n', jmes: 'data.n' }] },
    upsert: { mode: 'merge', writes: [{ target: '/p/mean', value: '{{mean}}' }] },
  },
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveConnection', () => {
  it('returns a connection without extends as-is', () => {
    const connections = [parentConnection];
    const result = resolveConnection('amplitude-prod', connections);
    expect(result).toEqual(parentConnection);
  });

  it('resolves a child that extends a parent — inherits all parent fields', () => {
    const child = makeConnection({
      name: 'amplitude-staging',
      extends: 'amplitude-prod',
      credsRef: 'amplitude-staging',
      description: 'Staging Amplitude',
    });
    // Strip fields that should come from parent
    delete (child as any).provider;
    delete (child as any).kind;
    delete (child as any).adapter;

    const connections = [parentConnection, child];
    const result = resolveConnection('amplitude-staging', connections);

    expect(result.name).toBe('amplitude-staging');
    expect(result.extends).toBeUndefined();
    expect(result.credsRef).toBe('amplitude-staging');
    expect(result.description).toBe('Staging Amplitude');
    // Inherited from parent
    expect(result.provider).toBe('amplitude');
    expect(result.kind).toBe('http');
    expect(result.enabled).toBe(true);
    expect(result.adapter).toEqual(parentConnection.adapter);
    expect(result.defaults).toEqual(parentConnection.defaults);
  });

  it('child name is preserved, not inherited from parent', () => {
    const child: ConnectionDefinition = {
      name: 'amplitude-staging',
      extends: 'amplitude-prod',
    } as any;

    const connections = [parentConnection, child];
    const result = resolveConnection('amplitude-staging', connections);
    expect(result.name).toBe('amplitude-staging');
  });

  it('child credsRef overrides parent credsRef', () => {
    const child: ConnectionDefinition = {
      name: 'amplitude-staging',
      extends: 'amplitude-prod',
      credsRef: 'staging-creds',
    } as any;

    const connections = [parentConnection, child];
    const result = resolveConnection('amplitude-staging', connections);
    expect(result.credsRef).toBe('staging-creds');
  });

  it('deep merges defaults — child adds new keys and overrides existing', () => {
    const child: ConnectionDefinition = {
      name: 'amplitude-staging',
      extends: 'amplitude-prod',
      defaults: {
        base_url: 'https://staging.amplitude.com/api/2',  // override
        new_setting: true,                                  // add
        // excluded_cohorts and timeout_ms inherited from parent
      },
    } as any;

    const connections = [parentConnection, child];
    const result = resolveConnection('amplitude-staging', connections);

    expect(result.defaults).toEqual({
      base_url: 'https://staging.amplitude.com/api/2',   // overridden
      excluded_cohorts: ['cohort-abc'],                    // inherited
      timeout_ms: 30000,                                   // inherited
      new_setting: true,                                   // added
    });
  });

  it('child can clear a parent defaults key by setting it to an empty array', () => {
    const child: ConnectionDefinition = {
      name: 'amplitude-staging',
      extends: 'amplitude-prod',
      defaults: {
        excluded_cohorts: [],  // clear parent's cohort exclusions
      },
    } as any;

    const connections = [parentConnection, child];
    const result = resolveConnection('amplitude-staging', connections);

    expect(result.defaults!.excluded_cohorts).toEqual([]);
    expect(result.defaults!.base_url).toBe('https://amplitude.com/api/2');
  });

  it('atomic replace of adapter — child adapter replaces parent entirely', () => {
    const childAdapter = {
      request: { method: 'GET' as const, path_template: '/api/custom' },
      response: {},
      upsert: { mode: 'merge' as const, writes: [] },
    };

    const child: ConnectionDefinition = {
      name: 'custom-connection',
      extends: 'amplitude-prod',
      adapter: childAdapter,
    } as any;

    const connections = [parentConnection, child];
    const result = resolveConnection('custom-connection', connections);

    // Child adapter entirely replaces parent — no merging of individual adapter fields
    expect(result.adapter).toEqual(childAdapter);
    expect(result.adapter.pre_request).toBeUndefined();  // parent's pre_request NOT inherited
  });

  it('atomic replace of capabilities — child capabilities replace parent entirely', () => {
    const child: ConnectionDefinition = {
      name: 'limited-connection',
      extends: 'amplitude-prod',
      capabilities: { supports_native_exclude: false } as any,
    } as any;

    const connections = [parentConnection, child];
    const result = resolveConnection('limited-connection', connections);

    expect((result as any).capabilities).toEqual({ supports_native_exclude: false });
    // Parent's supports_visited and max_funnel_length NOT inherited
    expect((result as any).capabilities.supports_visited).toBeUndefined();
  });

  it('throws error when extends references non-existent connection', () => {
    const child: ConnectionDefinition = {
      name: 'orphan',
      extends: 'does-not-exist',
    } as any;

    expect(() => resolveConnection('orphan', [parentConnection, child]))
      .toThrow(/extends "does-not-exist", but that connection was not found/);
  });

  it('throws error when extends references self', () => {
    const child: ConnectionDefinition = {
      name: 'self-ref',
      extends: 'self-ref',
    } as any;

    expect(() => resolveConnection('self-ref', [child]))
      .toThrow(/extends itself/);
  });

  it('throws error when extends references another extending connection (no chains)', () => {
    const middle: ConnectionDefinition = {
      name: 'middle',
      extends: 'amplitude-prod',
      credsRef: 'middle-creds',
    } as any;

    const leaf: ConnectionDefinition = {
      name: 'leaf',
      extends: 'middle',
    } as any;

    expect(() => resolveConnection('leaf', [parentConnection, middle, leaf]))
      .toThrow(/Inheritance chains are not supported/);
  });

  it('throws error when connection name is not found', () => {
    expect(() => resolveConnection('nonexistent', [parentConnection]))
      .toThrow(/Connection "nonexistent" not found/);
  });

  it('enabled: false on child disables the connection', () => {
    const child: ConnectionDefinition = {
      name: 'disabled-staging',
      extends: 'amplitude-prod',
      enabled: false,
    } as any;

    const connections = [parentConnection, child];
    const result = resolveConnection('disabled-staging', connections);
    expect(result.enabled).toBe(false);
  });

  it('child with only name + extends inherits everything from parent', () => {
    const child: ConnectionDefinition = {
      name: 'clone',
      extends: 'amplitude-prod',
    } as any;

    const connections = [parentConnection, child];
    const result = resolveConnection('clone', connections);

    expect(result.name).toBe('clone');
    expect(result.extends).toBeUndefined();
    expect(result.provider).toBe(parentConnection.provider);
    expect(result.kind).toBe(parentConnection.kind);
    expect(result.credsRef).toBe(parentConnection.credsRef);
    expect(result.description).toBe(parentConnection.description);
    expect(result.enabled).toBe(parentConnection.enabled);
    expect(result.defaults).toEqual(parentConnection.defaults);
    expect(result.adapter).toEqual(parentConnection.adapter);
  });
});

describe('resolveAllConnections', () => {
  it('resolves all connections in a list', () => {
    const child: ConnectionDefinition = {
      name: 'amplitude-staging',
      extends: 'amplitude-prod',
      credsRef: 'amplitude-staging',
    } as any;

    const connections = [parentConnection, child];
    const results = resolveAllConnections(connections);

    expect(results).toHaveLength(2);
    expect(results[0].name).toBe('amplitude-prod');
    expect(results[0].extends).toBeUndefined();
    expect(results[1].name).toBe('amplitude-staging');
    expect(results[1].extends).toBeUndefined();
    expect(results[1].credsRef).toBe('amplitude-staging');
    expect(results[1].provider).toBe('amplitude');
    expect(results[1].adapter).toEqual(parentConnection.adapter);
  });

  it('handles a list with no extending connections', () => {
    const other = makeConnection({ name: 'sheets-readonly', provider: 'google-sheets' });
    const connections = [parentConnection, other];
    const results = resolveAllConnections(connections);

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual(parentConnection);
    expect(results[1]).toEqual(other);
  });
});
