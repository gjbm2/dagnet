import { describe, it, expect } from 'vitest';
import { merge3Way, canAutoMerge, formatConflict, mergeJson3Way } from '../mergeService';

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

describe('mergeJson3Way — structural JSON merge', () => {
  it('should auto-merge when local adds key A and remote adds key B', () => {
    const base = { nodes: [], edges: [] };
    const local = { nodes: [], edges: [], canvasAnalyses: [{ id: 'chart-1' }] };
    const remote = { nodes: [], edges: [], _bayes: { posteriors: [0.5] } };

    const result = mergeJson3Way(base, local, remote);

    expect(result.hasConflicts).toBe(false);
    expect(result.merged.canvasAnalyses).toEqual([{ id: 'chart-1' }]);
    expect(result.merged._bayes).toEqual({ posteriors: [0.5] });
    expect(result.merged.nodes).toEqual([]);
    expect(result.merged.edges).toEqual([]);
  });

  it('should auto-merge when local modifies key A and remote modifies key B', () => {
    const base = { a: 1, b: 2, c: 3 };
    const local = { a: 10, b: 2, c: 3 };
    const remote = { a: 1, b: 20, c: 3 };

    const result = mergeJson3Way(base, local, remote);

    expect(result.hasConflicts).toBe(false);
    expect(result.merged).toEqual({ a: 10, b: 20, c: 3 });
  });

  it('should report conflict when both modify same key to different values', () => {
    const base = { a: 1 };
    const local = { a: 2 };
    const remote = { a: 3 };

    const result = mergeJson3Way(base, local, remote);

    expect(result.hasConflicts).toBe(true);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].path).toEqual(['a']);
    expect(result.conflicts[0].base).toBe(1);
    expect(result.conflicts[0].local).toBe(2);
    expect(result.conflicts[0].remote).toBe(3);
    // Default to local for conflicting key
    expect(result.merged.a).toBe(2);
  });

  it('should keep value when both modify same key to same value', () => {
    const base = { a: 1 };
    const local = { a: 2 };
    const remote = { a: 2 };

    const result = mergeJson3Way(base, local, remote);

    expect(result.hasConflicts).toBe(false);
    expect(result.merged.a).toBe(2);
  });

  it('should recurse into nested objects to avoid false conflicts', () => {
    const base = { _bayes: { config: { method: 'mcmc' }, posteriors: null } };
    const local = { _bayes: { config: { method: 'mcmc' }, posteriors: null }, canvasAnalyses: [] };
    const remote = { _bayes: { config: { method: 'mcmc' }, posteriors: [0.5, 0.3] } };

    const result = mergeJson3Way(base, local, remote);

    expect(result.hasConflicts).toBe(false);
    expect(result.merged._bayes.posteriors).toEqual([0.5, 0.3]);
    expect(result.merged.canvasAnalyses).toEqual([]);
  });

  it('should take the changed side when only one side modifies an array', () => {
    const base = { items: [1, 2, 3] };
    const local = { items: [1, 2, 3] };
    const remote = { items: [1, 2, 3, 4] };

    const result = mergeJson3Way(base, local, remote);

    expect(result.hasConflicts).toBe(false);
    expect(result.merged.items).toEqual([1, 2, 3, 4]);
  });

  it('should delete key when one side deletes and other side is unchanged', () => {
    const base = { a: 1, b: 2 };
    const local = { a: 1 }; // deleted b
    const remote = { a: 1, b: 2 }; // unchanged

    const result = mergeJson3Way(base, local, remote);

    expect(result.hasConflicts).toBe(false);
    expect(result.merged).toEqual({ a: 1 });
    expect('b' in result.merged).toBe(false);
  });

  it('should conflict when one side deletes and other modifies', () => {
    const base = { a: 1, b: 2 };
    const local = { a: 1 }; // deleted b
    const remote = { a: 1, b: 99 }; // modified b

    const result = mergeJson3Way(base, local, remote);

    expect(result.hasConflicts).toBe(true);
    expect(result.conflicts[0].path).toEqual(['b']);
    expect(result.conflicts[0].local).toBeUndefined();
    expect(result.conflicts[0].remote).toBe(99);
  });

  it('should handle the real-world graph scenario: chart + bayes on different keys', () => {
    const base = {
      nodes: [{ id: 'n1', type: 'node' }],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
      metadata: { name: 'test-graph' },
    };
    const local = {
      ...base,
      canvasAnalyses: [{ id: 'chart-1', x: 96, y: 5, width: 400, height: 300, view_mode: 'chart' }],
    };
    const remote = {
      ...base,
      _bayes: { posteriors: { 'param-1': [0.5, 0.3, 0.2] }, fit_ts: '2026-03-18' },
    };

    const result = mergeJson3Way(base, local, remote);

    expect(result.hasConflicts).toBe(false);
    expect(result.merged.nodes).toEqual(base.nodes);
    expect(result.merged.edges).toEqual(base.edges);
    expect(result.merged.metadata).toEqual(base.metadata);
    expect(result.merged.canvasAnalyses).toEqual(local.canvasAnalyses);
    expect(result.merged._bayes).toEqual(remote._bayes);
  });

  it('should return base when neither side changed', () => {
    const base = { a: 1, b: [1, 2] };
    const result = mergeJson3Way(base, { a: 1, b: [1, 2] }, { a: 1, b: [1, 2] });

    expect(result.hasConflicts).toBe(false);
    expect(result.merged).toEqual(base);
  });

  // ---- Domain-specific ownership policies ----

  it('should always take remote for _bayes (Bayes service is authoritative)', () => {
    const base = { _bayes: { posteriors: [0.1] }, nodes: [] };
    const local = { _bayes: { posteriors: [0.1] }, nodes: [] }; // unchanged
    const remote = { _bayes: { posteriors: [0.5, 0.3] }, nodes: [] }; // new run

    const result = mergeJson3Way(base, local, remote);

    expect(result.hasConflicts).toBe(false);
    expect(result.merged._bayes).toEqual({ posteriors: [0.5, 0.3] });
  });

  it('should take remote _bayes even when local also changed _bayes (stale local)', () => {
    const base = { _bayes: { posteriors: [0.1] } };
    const local = { _bayes: { posteriors: [0.2] } }; // old run result
    const remote = { _bayes: { posteriors: [0.5, 0.3], fit_ts: '2026-03-18' } }; // new run

    const result = mergeJson3Way(base, local, remote);

    expect(result.hasConflicts).toBe(false);
    expect(result.merged._bayes).toEqual(remote._bayes);
  });

  it('should keep local addition when remote never had the key (not a deletion)', () => {
    // canvasAnalyses added by local, never in base, not in remote.
    // This is a local addition, not a remote deletion.
    const base = { nodes: [] };
    const local = { canvasAnalyses: [{ id: 'c1' }], nodes: [] };
    const remote = { nodes: [] };

    const result = mergeJson3Way(base, local, remote);

    expect(result.hasConflicts).toBe(false);
    expect(result.merged.canvasAnalyses).toEqual([{ id: 'c1' }]);
  });

  it('should handle the full Bayes roundtrip: chart preserved + bayes updated + no conflict', () => {
    const base = {
      nodes: [{ id: 'n1' }],
      edges: [{ uuid: 'e1', source: 'a', target: 'b', p: { id: 'p1' } }],
      _bayes: { posteriors: [0.1], fit_ts: '2026-03-17' },
      canvasAnalyses: [{ id: 'chart-1', view_mode: 'chart' }],
      metadata: { updated_at: '2026-03-17T00:00:00Z' },
    };
    const local = {
      ...base,
      metadata: { updated_at: '2026-03-18T10:00:00Z' },
    };
    const remote = {
      nodes: [{ id: 'n1' }],
      edges: [{ uuid: 'e1', source: 'a', target: 'b', p: { id: 'p1' } }],
      _bayes: { posteriors: [0.5, 0.3], fit_ts: '2026-03-18' },
      // no canvasAnalyses — remote doesn't know about charts
      metadata: { updated_at: '2026-03-18T08:00:00Z' },
    };

    const result = mergeJson3Way(base, local, remote);

    expect(result.hasConflicts).toBe(false);
    expect(result.merged._bayes).toEqual(remote._bayes); // remote wins (REMOTE_WINS_KEYS)
    // canvasAnalyses: present in base and local (unchanged), absent from remote.
    // Standard merge rule: "deleted by remote, local unchanged → omit".
    // No LOCAL_WINS policy exists for canvasAnalyses, so the deletion stands.
    expect(result.merged.canvasAnalyses).toBeUndefined();
    expect(result.merged.metadata.updated_at).toBe('2026-03-18T10:00:00Z'); // most recent
    expect(result.merged.nodes).toEqual(base.nodes);
  });

  it('should merge arrays of objects by uuid when both sides modify different elements', () => {
    const base = {
      edges: [
        { uuid: 'e1', source: 'a', target: 'b', weight: 1 },
        { uuid: 'e2', source: 'c', target: 'd', weight: 2 },
      ],
    };
    const local = {
      edges: [
        { uuid: 'e1', source: 'a', target: 'b', weight: 10 }, // modified weight
        { uuid: 'e2', source: 'c', target: 'd', weight: 2 },
      ],
    };
    const remote = {
      edges: [
        { uuid: 'e1', source: 'a', target: 'b', weight: 1 },
        { uuid: 'e2', source: 'c', target: 'd', weight: 20 }, // modified weight
      ],
    };

    const result = mergeJson3Way(base, local, remote);

    expect(result.hasConflicts).toBe(false);
    expect(result.merged.edges).toEqual([
      { uuid: 'e1', source: 'a', target: 'b', weight: 10 },
      { uuid: 'e2', source: 'c', target: 'd', weight: 20 },
    ]);
  });

  it('should merge arrays by id when uuid not present', () => {
    const base = { nodes: [{ id: 'n1', label: 'A' }] };
    const local = { nodes: [{ id: 'n1', label: 'A' }, { id: 'n2', label: 'B' }] };
    const remote = { nodes: [{ id: 'n1', label: 'A-updated' }] };

    const result = mergeJson3Way(base, local, remote);

    expect(result.hasConflicts).toBe(false);
    // n1: remote modified label → take remote. n2: local added → keep.
    expect(result.merged.nodes).toEqual([
      { id: 'n1', label: 'A-updated' },
      { id: 'n2', label: 'B' },
    ]);
  });

  it('should auto-resolve updated_at timestamps (take most recent)', () => {
    const base = { metadata: { name: 'g', updated_at: '2026-01-01T00:00:00Z' } };
    const local = { metadata: { name: 'g', updated_at: '2026-03-18T14:09:00Z' } };
    const remote = { metadata: { name: 'g', updated_at: '2026-03-16T06:10:00Z' } };

    const result = mergeJson3Way(base, local, remote);

    expect(result.hasConflicts).toBe(false);
    expect(result.merged.metadata.updated_at).toBe('2026-03-18T14:09:00Z');
  });

  it('should handle the real scenario: edges with uuid + metadata.updated_at + chart addition', () => {
    const base = {
      edges: [
        { uuid: 'e1', source: 'a', target: 'b', data: { weight: 1 } },
      ],
      metadata: { name: 'graph', updated_at: '2026-03-15T00:00:00Z' },
      _bayes: { config: { method: 'mcmc' } },
    };
    const local = {
      edges: [
        { uuid: 'e1', source: 'a', target: 'b', data: { weight: 1 } },
      ],
      metadata: { name: 'graph', updated_at: '2026-03-18T14:09:00Z' },
      _bayes: { config: { method: 'mcmc' } },
      canvasAnalyses: [{ id: 'chart-1', view_mode: 'chart' }],
    };
    const remote = {
      edges: [
        { uuid: 'e1', source: 'a', target: 'b', data: { weight: 1, _bayes_posterior: 0.5 } },
      ],
      metadata: { name: 'graph', updated_at: '2026-03-16T06:10:00Z' },
      _bayes: { config: { method: 'mcmc' }, posteriors: [0.5] },
    };

    const result = mergeJson3Way(base, local, remote);

    expect(result.hasConflicts).toBe(false);
    // Edge: remote added _bayes_posterior, local unchanged → take remote's edge data
    expect(result.merged.edges[0].data._bayes_posterior).toBe(0.5);
    // Metadata: local is more recent → take local
    expect(result.merged.metadata.updated_at).toBe('2026-03-18T14:09:00Z');
    // _bayes: remote added posteriors, local unchanged → take remote
    expect(result.merged._bayes.posteriors).toEqual([0.5]);
    // canvasAnalyses: local-only addition → keep
    expect(result.merged.canvasAnalyses).toEqual([{ id: 'chart-1', view_mode: 'chart' }]);
  });
});

