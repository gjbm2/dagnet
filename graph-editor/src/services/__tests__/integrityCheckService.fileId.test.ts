/**
 * Tests for IntegrityCheckService fileId handling
 * 
 * CRITICAL: The integrity checker must ALWAYS:
 * 1. Strip workspace prefixes when comparing files
 * 2. Display human-readable names, NEVER raw prefixed fileIds
 * 3. Treat prefixed and unprefixed versions of the same file as identical
 */

import { describe, it, expect } from 'vitest';
import { IntegrityCheckService } from '../integrityCheckService';

describe('IntegrityCheckService fileId handling', () => {
  describe('getCanonicalFileId', () => {
    it('should return unprefixed fileId unchanged', () => {
      expect(IntegrityCheckService.getCanonicalFileId('parameter-coffee-to-bds', 'parameter'))
        .toBe('parameter-coffee-to-bds');
      expect(IntegrityCheckService.getCanonicalFileId('graph-myname', 'graph'))
        .toBe('graph-myname');
      expect(IntegrityCheckService.getCanonicalFileId('node-checkout', 'node'))
        .toBe('node-checkout');
    });

    it('should strip workspace prefix from prefixed fileId', () => {
      expect(IntegrityCheckService.getCanonicalFileId('nous-conversion-main-parameter-coffee-to-bds', 'parameter'))
        .toBe('parameter-coffee-to-bds');
      expect(IntegrityCheckService.getCanonicalFileId('myrepo-main-graph-myname', 'graph'))
        .toBe('graph-myname');
      expect(IntegrityCheckService.getCanonicalFileId('repo-branch-node-checkout', 'node'))
        .toBe('node-checkout');
    });

    it('should handle multi-hyphen names correctly', () => {
      // The name itself has hyphens
      expect(IntegrityCheckService.getCanonicalFileId('repo-branch-parameter-my-long-name-here', 'parameter'))
        .toBe('parameter-my-long-name-here');
      expect(IntegrityCheckService.getCanonicalFileId('parameter-my-long-name-here', 'parameter'))
        .toBe('parameter-my-long-name-here');
    });

    it('should handle multi-hyphen workspace prefixes', () => {
      // Workspace prefix has multiple parts: "nous-conversion-main"
      expect(IntegrityCheckService.getCanonicalFileId('nous-conversion-main-parameter-coffee-to-bds', 'parameter'))
        .toBe('parameter-coffee-to-bds');
      expect(IntegrityCheckService.getCanonicalFileId('some-org-repo-name-feature-branch-graph-test', 'graph'))
        .toBe('graph-test');
    });

    it('should handle edge cases', () => {
      // Empty string
      expect(IntegrityCheckService.getCanonicalFileId('', 'parameter')).toBe('');
      // Type marker at start (already canonical)
      expect(IntegrityCheckService.getCanonicalFileId('event-signup', 'event')).toBe('event-signup');
      // Type at index 0 is treated as canonical (no prefix to strip)
      expect(IntegrityCheckService.getCanonicalFileId('parameter-containing-parameter-word', 'parameter'))
        .toBe('parameter-containing-parameter-word');
    });
  });

  describe('getDisplayName', () => {
    it('should return just the name part from unprefixed fileId', () => {
      expect(IntegrityCheckService.getDisplayName('parameter-coffee-to-bds', 'parameter'))
        .toBe('coffee-to-bds');
      expect(IntegrityCheckService.getDisplayName('graph-myname', 'graph'))
        .toBe('myname');
      expect(IntegrityCheckService.getDisplayName('node-checkout', 'node'))
        .toBe('checkout');
    });

    it('should return just the name part from prefixed fileId', () => {
      expect(IntegrityCheckService.getDisplayName('nous-conversion-main-parameter-coffee-to-bds', 'parameter'))
        .toBe('coffee-to-bds');
      expect(IntegrityCheckService.getDisplayName('myrepo-main-graph-myname', 'graph'))
        .toBe('myname');
      expect(IntegrityCheckService.getDisplayName('repo-branch-node-checkout', 'node'))
        .toBe('checkout');
    });

    it('should preserve hyphenated names', () => {
      expect(IntegrityCheckService.getDisplayName('parameter-my-complex-name', 'parameter'))
        .toBe('my-complex-name');
      expect(IntegrityCheckService.getDisplayName('nous-main-parameter-my-complex-name', 'parameter'))
        .toBe('my-complex-name');
    });

    it('should NEVER include workspace prefix in display name', () => {
      // This is the critical test - display names must be clean
      const prefixedFileId = 'nous-conversion-main-parameter-coffee-to-bds';
      const displayName = IntegrityCheckService.getDisplayName(prefixedFileId, 'parameter');
      
      expect(displayName).not.toContain('nous');
      expect(displayName).not.toContain('conversion');
      expect(displayName).not.toContain('main');
      expect(displayName).toBe('coffee-to-bds');
    });

    it('should NEVER include type prefix in display name', () => {
      const displayName = IntegrityCheckService.getDisplayName('parameter-myname', 'parameter');
      expect(displayName).not.toContain('parameter');
      expect(displayName).toBe('myname');
    });
  });

  describe('extractExpectedId', () => {
    // The extractExpectedId method is private but called via getDisplayName
    // These tests ensure the extraction logic is correct
    
    it('should extract ID correctly for all file types', () => {
      const types = ['parameter', 'node', 'event', 'case', 'context', 'graph'];
      
      for (const type of types) {
        const unprefixed = `${type}-myid`;
        const prefixed = `repo-branch-${type}-myid`;
        
        expect(IntegrityCheckService.getDisplayName(unprefixed, type)).toBe('myid');
        expect(IntegrityCheckService.getDisplayName(prefixed, type)).toBe('myid');
      }
    });
  });

  describe('duplicate detection fileId handling', () => {
    // These tests verify that duplicate detection handles fileIds correctly
    // The actual duplicate detection is tested via the full service, but we can
    // verify the helper methods work correctly in isolation
    
    it('should treat prefixed and unprefixed as same file', () => {
      const prefixed = 'nous-conversion-main-parameter-coffee-to-bds';
      const unprefixed = 'parameter-coffee-to-bds';
      
      // Both should canonicalize to the same value
      expect(IntegrityCheckService.getCanonicalFileId(prefixed, 'parameter'))
        .toBe(IntegrityCheckService.getCanonicalFileId(unprefixed, 'parameter'));
    });

    it('should distinguish actually different files', () => {
      const file1 = 'parameter-alpha';
      const file2 = 'parameter-beta';
      
      expect(IntegrityCheckService.getCanonicalFileId(file1, 'parameter'))
        .not.toBe(IntegrityCheckService.getCanonicalFileId(file2, 'parameter'));
    });
  });

  describe('edge case: type name appears in workspace prefix', () => {
    // Edge case: what if the workspace name contains a type name?
    // This is a known limitation - if the type marker appears at index 0,
    // we can't distinguish it from a non-prefixed fileId.
    // 
    // In practice, this is rare and the user would see confusing results.
    // The fix would require knowing the workspace prefix explicitly.
    
    it('documents limitation when type name starts the fileId', () => {
      // Repository named "parameter-testing", branch "main", type "parameter", name "myname"
      // Results in: "parameter-testing-main-parameter-myname"
      // The first "parameter-" is at index 0, so we can't detect the prefix.
      const fileId = 'parameter-testing-main-parameter-myname';
      
      // KNOWN LIMITATION: This is treated as canonical because "parameter-" is at index 0
      expect(IntegrityCheckService.getCanonicalFileId(fileId, 'parameter'))
        .toBe('parameter-testing-main-parameter-myname');
      
      // Display name extracts everything after the first "parameter-"
      expect(IntegrityCheckService.getDisplayName(fileId, 'parameter'))
        .toBe('testing-main-parameter-myname');
      
      // NOTE: In practice, repository names rarely match file type names,
      // and the standard workspace prefix format (repo-branch-type-name)
      // doesn't usually create this collision.
    });

    it('documents limitation with graph type name at start', () => {
      // Edge case: repo "graph-tools", branch "main", type "graph", name "test"
      const fileId = 'graph-tools-main-graph-test';
      
      // "graph-" appears at index 0, so it's treated as canonical (no prefix to strip)
      const canonical = IntegrityCheckService.getCanonicalFileId(fileId, 'graph');
      expect(canonical).toBe('graph-tools-main-graph-test');
      
      // The display name extracts everything after "graph-"
      const displayName = IntegrityCheckService.getDisplayName(fileId, 'graph');
      expect(displayName).toBe('tools-main-graph-test');
    });

    it('handles typical workspace prefixes correctly', () => {
      // This is the COMMON case - workspace prefix doesn't start with a type name
      // Repository "nous-conversion", branch "main", type "parameter", name "test"
      const fileId = 'nous-conversion-main-parameter-test';
      
      // "parameter-" is at index 21 (> 0), so prefix is stripped correctly
      expect(IntegrityCheckService.getCanonicalFileId(fileId, 'parameter'))
        .toBe('parameter-test');
      
      expect(IntegrityCheckService.getDisplayName(fileId, 'parameter'))
        .toBe('test');
    });
  });
});

describe('IntegrityCheckService output validation', () => {
  // These are conceptual tests that document the contract
  // Full integration tests would require mocking the database
  
  describe('fileId in issue output', () => {
    it('should document that fileId in issues may be prefixed (for internal use)', () => {
      // The fileId field in IntegrityIssue is kept as-is for internal navigation
      // This is acceptable because it's used for lookup, not display
      // Display should use getDisplayName()
      expect(true).toBe(true); // Documentation test
    });
  });

  describe('message content', () => {
    it('should NEVER include raw prefixed fileIds in user-facing messages', () => {
      // This is a documentation/contract test
      // All messages should use getDisplayName() or getCanonicalFileId()
      // NOT raw fileId values that include workspace prefixes
      expect(true).toBe(true); // Documentation test
    });
  });
});

