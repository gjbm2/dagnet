import { describe, it, expect } from 'vitest';
import { merge3Way, canAutoMerge, formatConflict } from '../mergeService';

describe('mergeService', () => {
  describe('merge3Way', () => {
    it('should handle no changes', () => {
      const base = 'line 1\nline 2\nline 3';
      const local = 'line 1\nline 2\nline 3';
      const remote = 'line 1\nline 2\nline 3';

      const result = merge3Way(base, local, remote);

      expect(result.success).toBe(true);
      expect(result.hasConflicts).toBe(false);
      expect(result.merged).toBe(base);
    });

    it('should auto-merge when only local changed', () => {
      const base = 'line 1\nline 2\nline 3';
      const local = 'line 1\nlocal change\nline 3';
      const remote = 'line 1\nline 2\nline 3';

      const result = merge3Way(base, local, remote);

      expect(result.success).toBe(true);
      expect(result.hasConflicts).toBe(false);
      expect(result.merged).toContain('local change');
    });

    it('should auto-merge when only remote changed', () => {
      const base = 'line 1\nline 2\nline 3';
      const local = 'line 1\nline 2\nline 3';
      const remote = 'line 1\nremote change\nline 3';

      const result = merge3Way(base, local, remote);

      expect(result.success).toBe(true);
      expect(result.hasConflicts).toBe(false);
      expect(result.merged).toContain('remote change');
    });

    it('should auto-merge when both changed different lines', () => {
      const base = 'line 1\nline 2\nline 3\nline 4';
      const local = 'line 1\nlocal change\nline 3\nline 4';
      const remote = 'line 1\nline 2\nline 3\nremote change';

      const result = merge3Way(base, local, remote);

      expect(result.success).toBe(true);
      expect(result.hasConflicts).toBe(false);
      expect(result.merged).toContain('local change');
      expect(result.merged).toContain('remote change');
    });

    it('should auto-merge when both made same change', () => {
      const base = 'line 1\nline 2\nline 3';
      const local = 'line 1\nsame change\nline 3';
      const remote = 'line 1\nsame change\nline 3';

      const result = merge3Way(base, local, remote);

      expect(result.success).toBe(true);
      expect(result.hasConflicts).toBe(false);
      expect(result.merged).toContain('same change');
    });

    it('should detect conflict when both changed same line differently', () => {
      const base = 'line 1\nline 2\nline 3';
      const local = 'line 1\nlocal change\nline 3';
      const remote = 'line 1\nremote change\nline 3';

      const result = merge3Way(base, local, remote);

      expect(result.success).toBe(false);
      expect(result.hasConflicts).toBe(true);
      expect(result.conflicts).toBeDefined();
      expect(result.conflicts!.length).toBeGreaterThan(0);
      expect(result.merged).toContain('<<<<<<< LOCAL');
      expect(result.merged).toContain('local change');
      expect(result.merged).toContain('=======');
      expect(result.merged).toContain('remote change');
      expect(result.merged).toContain('>>>>>>> REMOTE');
    });

    it('should handle multiple conflicts', () => {
      const base = 'line 1\nline 2\nline 3\nline 4\nline 5';
      const local = 'line 1\nlocal A\nline 3\nlocal B\nline 5';
      const remote = 'line 1\nremote A\nline 3\nremote B\nline 5';

      const result = merge3Way(base, local, remote);

      expect(result.success).toBe(false);
      expect(result.hasConflicts).toBe(true);
      expect(result.conflicts!.length).toBeGreaterThan(0);
    });

    it('should handle addition at end', () => {
      const base = 'line 1\nline 2';
      const local = 'line 1\nline 2\nlocal addition';
      const remote = 'line 1\nline 2';

      const result = merge3Way(base, local, remote);

      expect(result.success).toBe(true);
      expect(result.hasConflicts).toBe(false);
      expect(result.merged).toContain('local addition');
    });

    it('should handle deletion', () => {
      const base = 'line 1\nline 2\nline 3';
      const local = 'line 1\nline 3';
      const remote = 'line 1\nline 2\nline 3';

      const result = merge3Way(base, local, remote);

      expect(result.success).toBe(true);
      expect(result.hasConflicts).toBe(false);
      expect(result.merged).not.toContain('line 2');
    });

    it('should detect conflict when one deletes and other modifies', () => {
      const base = 'line 1\nline 2\nline 3';
      const local = 'line 1\nline 3';
      const remote = 'line 1\nmodified line 2\nline 3';

      const result = merge3Way(base, local, remote);

      // This is a conflict scenario - one deleted, one modified
      expect(result.hasConflicts).toBe(true);
    });

    it('should handle YAML structure', () => {
      const base = 'key1: value1\nkey2: value2\nkey3: value3';
      const local = 'key1: local_value1\nkey2: value2\nkey3: value3';
      const remote = 'key1: value1\nkey2: value2\nkey3: remote_value3';

      const result = merge3Way(base, local, remote);

      expect(result.success).toBe(true);
      expect(result.hasConflicts).toBe(false);
      expect(result.merged).toContain('local_value1');
      expect(result.merged).toContain('remote_value3');
    });

    it('should handle JSON structure', () => {
      const base = '{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}';
      const local = '{\n  "a": 100,\n  "b": 2,\n  "c": 3\n}';
      const remote = '{\n  "a": 1,\n  "b": 2,\n  "c": 300\n}';

      const result = merge3Way(base, local, remote);

      expect(result.success).toBe(true);
      expect(result.hasConflicts).toBe(false);
      expect(result.merged).toContain('100');
      expect(result.merged).toContain('300');
    });

    it('should handle empty lines', () => {
      const base = 'line 1\n\nline 3';
      const local = 'line 1\nlocal\nline 3';
      const remote = 'line 1\n\nline 3';

      const result = merge3Way(base, local, remote);

      expect(result.success).toBe(true);
      expect(result.hasConflicts).toBe(false);
    });

    it('should handle whitespace differences', () => {
      const base = 'line 1';
      const local = 'line 1 ';
      const remote = 'line 1';

      const result = merge3Way(base, local, remote);

      // Whitespace differences should be detected
      expect(result.hasConflicts).toBe(false); // Same content, whitespace only
    });

    it('should preserve conflict metadata', () => {
      const base = 'line 1\nline 2\nline 3';
      const local = 'line 1\nlocal change\nline 3';
      const remote = 'line 1\nremote change\nline 3';

      const result = merge3Way(base, local, remote);

      expect(result.conflicts).toBeDefined();
      expect(result.conflicts![0]).toHaveProperty('base');
      expect(result.conflicts![0]).toHaveProperty('local');
      expect(result.conflicts![0]).toHaveProperty('remote');
      expect(result.conflicts![0]).toHaveProperty('startLine');
      expect(result.conflicts![0]).toHaveProperty('endLine');
    });

    it('should handle large files efficiently', () => {
      const lines = 1000;
      const base = Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n');
      const local = Array.from({ length: lines }, (_, i) => i === 500 ? 'local change' : `line ${i}`).join('\n');
      const remote = Array.from({ length: lines }, (_, i) => i === 700 ? 'remote change' : `line ${i}`).join('\n');

      const start = Date.now();
      const result = merge3Way(base, local, remote);
      const elapsed = Date.now() - start;

      expect(result.success).toBe(true);
      expect(elapsed).toBeLessThan(1000); // Should complete in less than 1 second
    });
  });

  describe('canAutoMerge', () => {
    it('should return true for auto-mergeable changes', () => {
      const base = 'line 1\nline 2\nline 3';
      const local = 'line 1\nlocal\nline 3';
      const remote = 'line 1\nline 2\nremote';

      expect(canAutoMerge(base, local, remote)).toBe(true);
    });

    it('should return false for conflicting changes', () => {
      const base = 'line 1\nline 2\nline 3';
      const local = 'line 1\nlocal\nline 3';
      const remote = 'line 1\nremote\nline 3';

      expect(canAutoMerge(base, local, remote)).toBe(false);
    });
  });

  describe('formatConflict', () => {
    it('should format conflict with markers', () => {
      const conflict = {
        startLine: 0,
        endLine: 0,
        base: ['original line'],
        local: ['local change'],
        remote: ['remote change']
      };

      const formatted = formatConflict(conflict);

      expect(formatted).toContain('<<<<<<< LOCAL');
      expect(formatted).toContain('local change');
      expect(formatted).toContain('=======');
      expect(formatted).toContain('remote change');
      expect(formatted).toContain('>>>>>>> REMOTE');
      expect(formatted).toContain('BASE (Original):');
      expect(formatted).toContain('original line');
    });
  });

  describe('edge cases', () => {
    it('should handle empty files', () => {
      const result = merge3Way('', '', '');
      expect(result.success).toBe(true);
      expect(result.merged).toBe('');
    });

    it('should handle file with only newlines', () => {
      const result = merge3Way('\n\n', '\n\n', '\n\n');
      expect(result.success).toBe(true);
    });

    it('should handle single line files', () => {
      const result = merge3Way('line', 'local', 'remote');
      expect(result.hasConflicts).toBe(true);
    });

    it('should handle unicode content', () => {
      const base = 'Hello 世界\nLine 2';
      const local = 'Hello 世界\nLocal 變化';
      const remote = 'Hello 世界\nLine 2';

      const result = merge3Way(base, local, remote);
      expect(result.success).toBe(true);
      expect(result.merged).toContain('變化');
    });

    it('should handle very long lines', () => {
      const longLine = 'x'.repeat(10000);
      const base = `${longLine}\nline 2`;
      const local = `${longLine}\nlocal`;
      const remote = `${longLine}\nline 2`;

      const result = merge3Way(base, local, remote);
      expect(result.success).toBe(true);
    });
  });

  describe('real-world scenarios', () => {
    it('should handle parameter file changes', () => {
      const base = `
metadata:
  version: 1.0.0
  author: Alice
value: 100
description: Original`;

      const local = `
metadata:
  version: 1.0.0
  author: Alice
value: 150
description: Original`;

      const remote = `
metadata:
  version: 1.0.1
  author: Alice
value: 100
description: Updated description`;

      const result = merge3Way(base, local, remote);
      expect(result.success).toBe(true);
      expect(result.merged).toContain('150'); // Local value change
      expect(result.merged).toContain('1.0.1'); // Remote version bump
      expect(result.merged).toContain('Updated description'); // Remote description
    });

    it('should detect conflicts in graph JSON', () => {
      const base = `{
  "nodes": {
    "node1": { "type": "decision" }
  }
}`;

      const local = `{
  "nodes": {
    "node1": { "type": "action" }
  }
}`;

      const remote = `{
  "nodes": {
    "node1": { "type": "condition" }
  }
}`;

      const result = merge3Way(base, local, remote);
      expect(result.hasConflicts).toBe(true);
    });
  });
});

