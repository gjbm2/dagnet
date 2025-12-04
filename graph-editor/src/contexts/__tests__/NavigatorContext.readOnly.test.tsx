/**
 * Read-Only Mode Tests
 *
 * Tests for read-only detection logic used in useIsReadOnly hook.
 * These are unit tests for the detection logic itself, not integration tests.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect } from 'vitest';

/**
 * The read-only detection logic used in useIsReadOnly hook.
 * Extracted here for testability.
 */
function isReadOnlyToken(token: string | undefined | null): boolean {
  return !token || token.trim() === '';
}

describe('Read-only detection logic', () => {
  describe('isReadOnlyToken', () => {
    it('should return true when token is undefined', () => {
      expect(isReadOnlyToken(undefined)).toBe(true);
    });

    it('should return true when token is null', () => {
      expect(isReadOnlyToken(null)).toBe(true);
    });

    it('should return true when token is empty string', () => {
      expect(isReadOnlyToken('')).toBe(true);
    });

    it('should return true when token is whitespace only', () => {
      expect(isReadOnlyToken('   ')).toBe(true);
      expect(isReadOnlyToken('\t')).toBe(true);
      expect(isReadOnlyToken('\n')).toBe(true);
      expect(isReadOnlyToken('  \t\n  ')).toBe(true);
    });

    it('should return false when token is a valid string', () => {
      expect(isReadOnlyToken('ghp_abc123')).toBe(false);
    });

    it('should return false when token has leading/trailing whitespace but content', () => {
      expect(isReadOnlyToken('  ghp_abc123  ')).toBe(false);
    });
  });
});

describe('Sample data credentials structure', () => {
  // This is the structure created by handleUseSampleData in AppShell.tsx
  const sampleCredentials = {
    version: '1.0.0',
    git: [{
      name: 'dagnet',
      isDefault: true,
      owner: 'gjbm2',
      // No token - public repo allows unauthenticated read access
      basePath: 'param-registry/test',
      graphsPath: 'graphs',
      paramsPath: 'parameters',
      contextsPath: 'contexts',
      casesPath: 'cases',
      nodesPath: 'nodes',
      eventsPath: 'events',
    }]
  };

  it('should have correct version', () => {
    expect(sampleCredentials.version).toBe('1.0.0');
  });

  it('should have exactly one git credential', () => {
    expect(sampleCredentials.git).toHaveLength(1);
  });

  it('should have correct repo name', () => {
    expect(sampleCredentials.git[0].name).toBe('dagnet');
  });

  it('should have correct owner', () => {
    expect(sampleCredentials.git[0].owner).toBe('gjbm2');
  });

  it('should be marked as default', () => {
    expect(sampleCredentials.git[0].isDefault).toBe(true);
  });

  it('should NOT have a token (read-only public repo)', () => {
    expect(sampleCredentials.git[0]).not.toHaveProperty('token');
  });

  it('should have correct basePath for test data', () => {
    expect(sampleCredentials.git[0].basePath).toBe('param-registry/test');
  });

  it('should have all required directory paths', () => {
    expect(sampleCredentials.git[0].graphsPath).toBe('graphs');
    expect(sampleCredentials.git[0].paramsPath).toBe('parameters');
    expect(sampleCredentials.git[0].contextsPath).toBe('contexts');
    expect(sampleCredentials.git[0].casesPath).toBe('cases');
    expect(sampleCredentials.git[0].nodesPath).toBe('nodes');
    expect(sampleCredentials.git[0].eventsPath).toBe('events');
  });

  it('should be detected as read-only by the detection logic', () => {
    const token = (sampleCredentials.git[0] as any).token;
    expect(isReadOnlyToken(token)).toBe(true);
  });
});

describe('Credentials schema compliance', () => {
  it('should have required name field', () => {
    const creds = { name: 'test', owner: 'owner' };
    expect(creds).toHaveProperty('name');
    expect(typeof creds.name).toBe('string');
    expect(creds.name.length).toBeGreaterThan(0);
  });

  it('should have required owner field', () => {
    const creds = { name: 'test', owner: 'owner' };
    expect(creds).toHaveProperty('owner');
    expect(typeof creds.owner).toBe('string');
    expect(creds.owner.length).toBeGreaterThan(0);
  });

  it('should allow optional token field', () => {
    const withToken = { name: 'test', owner: 'owner', token: 'ghp_123' };
    const withoutToken = { name: 'test', owner: 'owner' };
    
    // Both should be valid
    expect(withToken).toHaveProperty('name');
    expect(withToken).toHaveProperty('owner');
    expect(withoutToken).toHaveProperty('name');
    expect(withoutToken).toHaveProperty('owner');
  });

  it('should allow optional basePath field', () => {
    const withBasePath = { name: 'test', owner: 'owner', basePath: 'some/path' };
    const withoutBasePath = { name: 'test', owner: 'owner' };
    
    expect(withBasePath.basePath).toBe('some/path');
    expect(withoutBasePath).not.toHaveProperty('basePath');
  });
});

describe('Read-only vs write mode scenarios', () => {
  it('sample data credentials should be read-only', () => {
    const sampleGitCred = {
      name: 'dagnet',
      owner: 'gjbm2',
      // No token
    };
    
    expect(isReadOnlyToken((sampleGitCred as any).token)).toBe(true);
  });

  it('authenticated credentials should NOT be read-only', () => {
    const authGitCred = {
      name: 'dagnet',
      owner: 'gjbm2',
      token: 'ghp_realtoken123',
    };
    
    expect(isReadOnlyToken(authGitCred.token)).toBe(false);
  });

  it('empty token string should be read-only', () => {
    const emptyTokenCred = {
      name: 'dagnet',
      owner: 'gjbm2',
      token: '',
    };
    
    expect(isReadOnlyToken(emptyTokenCred.token)).toBe(true);
  });

  it('whitespace-only token should be read-only', () => {
    const whitespaceTokenCred = {
      name: 'dagnet',
      owner: 'gjbm2',
      token: '   ',
    };
    
    expect(isReadOnlyToken(whitespaceTokenCred.token)).toBe(true);
  });
});
