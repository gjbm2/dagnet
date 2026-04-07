import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sessionLogService } from '../sessionLogService';

describe('sessionLogService — level-based suppression', () => {
  beforeEach(() => {
    sessionLogService.clear();
    sessionLogService.setDisplayThreshold('info');
  });

  // ─── Group 1: Level-based suppression in addChild ───────────────────

  describe('addChild notifyListeners gating', () => {
    it('should call notifyListeners when info child is added at info threshold', () => {
      const listener = vi.fn();
      const unsub = sessionLogService.subscribe(listener);
      listener.mockClear(); // clear the initial call from subscribe setup

      const opId = sessionLogService.startOperation('info', 'data-fetch', 'TEST_OP', 'test');
      listener.mockClear();

      sessionLogService.addChild(opId, 'info', 'CHILD', 'info child');
      expect(listener).toHaveBeenCalledTimes(1);

      unsub();
    });

    it('should not call notifyListeners when debug child is added at info threshold', () => {
      const listener = vi.fn();
      const unsub = sessionLogService.subscribe(listener);

      const opId = sessionLogService.startOperation('info', 'data-fetch', 'TEST_OP', 'test');
      listener.mockClear();

      sessionLogService.addChild(opId, 'debug', 'CHILD', 'debug child');
      expect(listener).not.toHaveBeenCalled();

      unsub();
    });

    it('should not call notifyListeners when trace child is added at info threshold', () => {
      const listener = vi.fn();
      const unsub = sessionLogService.subscribe(listener);

      const opId = sessionLogService.startOperation('info', 'data-fetch', 'TEST_OP', 'test');
      listener.mockClear();

      sessionLogService.addChild(opId, 'trace', 'CHILD', 'trace child');
      expect(listener).not.toHaveBeenCalled();

      unsub();
    });

    it('should call notifyListeners when debug child is added at debug threshold', () => {
      sessionLogService.setDisplayThreshold('debug');
      const listener = vi.fn();
      const unsub = sessionLogService.subscribe(listener);

      const opId = sessionLogService.startOperation('info', 'data-fetch', 'TEST_OP', 'test');
      listener.mockClear();

      sessionLogService.addChild(opId, 'debug', 'CHILD', 'debug child');
      expect(listener).toHaveBeenCalledTimes(1);

      unsub();
    });

    it('should always call notifyListeners for warning children regardless of threshold', () => {
      const listener = vi.fn();
      const unsub = sessionLogService.subscribe(listener);

      const opId = sessionLogService.startOperation('info', 'data-fetch', 'TEST_OP', 'test');
      listener.mockClear();

      sessionLogService.addChild(opId, 'warning', 'CHILD', 'warning child');
      expect(listener).toHaveBeenCalledTimes(1);

      unsub();
    });

    it('should always call notifyListeners for error children regardless of threshold', () => {
      const listener = vi.fn();
      const unsub = sessionLogService.subscribe(listener);

      const opId = sessionLogService.startOperation('info', 'data-fetch', 'TEST_OP', 'test');
      listener.mockClear();

      sessionLogService.addChild(opId, 'error', 'CHILD', 'error child');
      expect(listener).toHaveBeenCalledTimes(1);

      unsub();
    });

    it('should add debug/trace children to parent.children even when below threshold', () => {
      const opId = sessionLogService.startOperation('info', 'data-fetch', 'TEST_OP', 'test');

      sessionLogService.addChild(opId, 'debug', 'D1', 'debug child');
      sessionLogService.addChild(opId, 'trace', 'T1', 'trace child');
      sessionLogService.addChild(opId, 'info', 'I1', 'info child');

      // During the operation, all children are in the array
      const entry = sessionLogService.getEntry(opId);
      expect(entry?.children).toHaveLength(3);
      expect(entry?.children?.map(c => c.level)).toEqual(['debug', 'trace', 'info']);
    });
  });

  // ─── Group 2: endOperation cleanup ──────────────────────────────────

  describe('endOperation sub-threshold child stripping', () => {
    it('should strip debug children from parent.children when operation ends at info threshold', () => {
      const opId = sessionLogService.startOperation('info', 'data-fetch', 'TEST_OP', 'test');
      sessionLogService.addChild(opId, 'debug', 'D1', 'debug child');
      sessionLogService.addChild(opId, 'info', 'I1', 'info child');

      sessionLogService.endOperation(opId, 'info', 'done');

      const entry = sessionLogService.getEntry(opId);
      expect(entry?.children).toHaveLength(1);
      expect(entry?.children?.[0].level).toBe('info');
    });

    it('should strip trace children from parent.children when operation ends at info threshold', () => {
      const opId = sessionLogService.startOperation('info', 'data-fetch', 'TEST_OP', 'test');
      sessionLogService.addChild(opId, 'trace', 'T1', 'trace child');
      sessionLogService.addChild(opId, 'info', 'I1', 'info child');
      sessionLogService.addChild(opId, 'warning', 'W1', 'warning child');

      sessionLogService.endOperation(opId, 'warning', 'done with warning');

      const entry = sessionLogService.getEntry(opId);
      expect(entry?.children).toHaveLength(2);
      expect(entry?.children?.map(c => c.level)).toEqual(['info', 'warning']);
    });

    it('should retain info/warning/error children in parent.children after endOperation', () => {
      const opId = sessionLogService.startOperation('info', 'data-fetch', 'TEST_OP', 'test');
      sessionLogService.addChild(opId, 'info', 'I1', 'info');
      sessionLogService.addChild(opId, 'success', 'S1', 'success');
      sessionLogService.addChild(opId, 'warning', 'W1', 'warning');
      sessionLogService.addChild(opId, 'error', 'E1', 'error');
      sessionLogService.addChild(opId, 'debug', 'D1', 'debug');

      sessionLogService.endOperation(opId, 'error', 'done');

      const entry = sessionLogService.getEntry(opId);
      expect(entry?.children).toHaveLength(4);
      expect(entry?.children?.map(c => c.level)).toEqual(['info', 'success', 'warning', 'error']);
    });

    it('should retain debug children when threshold is at debug', () => {
      sessionLogService.setDisplayThreshold('debug');

      const opId = sessionLogService.startOperation('info', 'data-fetch', 'TEST_OP', 'test');
      sessionLogService.addChild(opId, 'debug', 'D1', 'debug child');
      sessionLogService.addChild(opId, 'trace', 'T1', 'trace child');
      sessionLogService.addChild(opId, 'info', 'I1', 'info child');

      sessionLogService.endOperation(opId, 'info', 'done');

      const entry = sessionLogService.getEntry(opId);
      expect(entry?.children).toHaveLength(2);
      expect(entry?.children?.map(c => c.level)).toEqual(['debug', 'info']);
    });

    it('should not leave stripped children in entriesById', () => {
      const opId = sessionLogService.startOperation('info', 'data-fetch', 'TEST_OP', 'test');
      const debugId = sessionLogService.addChild(opId, 'debug', 'D1', 'debug child');
      const infoId = sessionLogService.addChild(opId, 'info', 'I1', 'info child');

      sessionLogService.endOperation(opId, 'info', 'done');

      // Debug child was below threshold — should not be in entriesById
      expect(sessionLogService.getEntry(debugId)).toBeUndefined();
      // Info child was at threshold — should be findable
      expect(sessionLogService.getEntry(infoId)).toBeDefined();
    });
  });

  // ─── Group 3: getEntries() after endOperation ──────────────────────

  describe('getEntries after endOperation', () => {
    it('should return entries with only info+ children after operation ends at info threshold', () => {
      const opId = sessionLogService.startOperation('info', 'data-fetch', 'TEST_OP', 'test');
      sessionLogService.addChild(opId, 'debug', 'D1', 'debug');
      sessionLogService.addChild(opId, 'trace', 'T1', 'trace');
      sessionLogService.addChild(opId, 'info', 'I1', 'info');
      sessionLogService.addChild(opId, 'warning', 'W1', 'warning');

      sessionLogService.endOperation(opId, 'warning', 'done');

      const entries = sessionLogService.getEntries();
      // Find the operation entry (skip any SESSION_START entry from init)
      const opEntry = entries.find(e => e.operation === 'TEST_OP');
      expect(opEntry).toBeDefined();
      expect(opEntry?.children).toHaveLength(2);
      expect(opEntry?.children?.map(c => c.level)).toEqual(['info', 'warning']);
    });

    it('should return entries with debug+ children after operation ends at debug threshold', () => {
      sessionLogService.setDisplayThreshold('debug');

      const opId = sessionLogService.startOperation('info', 'data-fetch', 'TEST_OP', 'test');
      sessionLogService.addChild(opId, 'debug', 'D1', 'debug');
      sessionLogService.addChild(opId, 'trace', 'T1', 'trace');
      sessionLogService.addChild(opId, 'info', 'I1', 'info');

      sessionLogService.endOperation(opId, 'info', 'done');

      const entries = sessionLogService.getEntries();
      const opEntry = entries.find(e => e.operation === 'TEST_OP');
      expect(opEntry?.children).toHaveLength(2);
      expect(opEntry?.children?.map(c => c.level)).toEqual(['debug', 'info']);
    });
  });

  // ─── Group 4: isLevelEnabled ────────────────────────────────────────

  describe('isLevelEnabled', () => {
    it('should return false for debug at info threshold', () => {
      expect(sessionLogService.isLevelEnabled('debug')).toBe(false);
    });

    it('should return false for trace at info threshold', () => {
      expect(sessionLogService.isLevelEnabled('trace')).toBe(false);
    });

    it('should return true for debug at debug threshold', () => {
      sessionLogService.setDisplayThreshold('debug');
      expect(sessionLogService.isLevelEnabled('debug')).toBe(true);
    });

    it('should return true for trace at trace threshold', () => {
      sessionLogService.setDisplayThreshold('trace');
      expect(sessionLogService.isLevelEnabled('trace')).toBe(true);
    });

    it('should always return true for info, warning, error regardless of threshold', () => {
      expect(sessionLogService.isLevelEnabled('info')).toBe(true);
      expect(sessionLogService.isLevelEnabled('success')).toBe(true);
      expect(sessionLogService.isLevelEnabled('warning')).toBe(true);
      expect(sessionLogService.isLevelEnabled('error')).toBe(true);
    });
  });

  // ─── Group 5: Threshold changes ────────────────────────────────────

  describe('threshold changes', () => {
    it('should trigger notifyListeners when threshold is lowered', () => {
      const listener = vi.fn();
      const unsub = sessionLogService.subscribe(listener);
      listener.mockClear();

      sessionLogService.setDisplayThreshold('debug');
      expect(listener).toHaveBeenCalledTimes(1);

      unsub();
    });

    it('should strip to new threshold on next endOperation after threshold is raised', () => {
      sessionLogService.setDisplayThreshold('debug');

      const opId = sessionLogService.startOperation('info', 'data-fetch', 'TEST_OP', 'test');
      sessionLogService.addChild(opId, 'debug', 'D1', 'debug child');
      sessionLogService.addChild(opId, 'info', 'I1', 'info child');

      // Raise threshold before ending
      sessionLogService.setDisplayThreshold('info');

      sessionLogService.endOperation(opId, 'info', 'done');

      const entry = sessionLogService.getEntry(opId);
      expect(entry?.children).toHaveLength(1);
      expect(entry?.children?.[0].level).toBe('info');
    });
  });

  // ─── Group 6: Parity with diagnostic buffering ─────────────────────

  describe('parity with diagnostic buffering', () => {
    it('should not include debug/trace children in getEntries on a clean run', () => {
      const opId = sessionLogService.startOperation('info', 'data-fetch', 'BATCH_OP', 'batch');
      // Simulate a clean run with many debug/trace children
      for (let i = 0; i < 50; i++) {
        sessionLogService.addChild(opId, 'debug', `D${i}`, `debug ${i}`);
        sessionLogService.addChild(opId, 'trace', `T${i}`, `trace ${i}`);
      }
      sessionLogService.addChild(opId, 'info', 'SUMMARY', 'summary');

      sessionLogService.endOperation(opId, 'success', 'clean run complete');

      const entries = sessionLogService.getEntries();
      const opEntry = entries.find(e => e.operation === 'BATCH_OP');
      expect(opEntry).toBeDefined();
      // Only the info-level SUMMARY child should survive
      expect(opEntry?.children).toHaveLength(1);
      expect(opEntry?.children?.[0].operation).toBe('SUMMARY');
    });

    it('should surface warning/error children immediately via notifyListeners', () => {
      const listener = vi.fn();
      const unsub = sessionLogService.subscribe(listener);

      const opId = sessionLogService.startOperation('info', 'data-fetch', 'BATCH_OP', 'batch');
      // Add many debug children silently
      for (let i = 0; i < 10; i++) {
        sessionLogService.addChild(opId, 'debug', `D${i}`, `debug ${i}`);
      }
      listener.mockClear();

      // Warning child should trigger notifyListeners
      sessionLogService.addChild(opId, 'warning', 'WARN', 'something went wrong');
      expect(listener).toHaveBeenCalledTimes(1);

      unsub();
    });

    it('should not surface debug siblings when a warning child arrives', () => {
      const opId = sessionLogService.startOperation('info', 'data-fetch', 'BATCH_OP', 'batch');

      // Add debug children
      sessionLogService.addChild(opId, 'debug', 'D1', 'debug 1');
      sessionLogService.addChild(opId, 'debug', 'D2', 'debug 2');

      // Add warning child
      sessionLogService.addChild(opId, 'warning', 'WARN', 'warning');

      // Add more debug children
      sessionLogService.addChild(opId, 'debug', 'D3', 'debug 3');

      sessionLogService.endOperation(opId, 'warning', 'done with warning');

      const entry = sessionLogService.getEntry(opId);
      // Only the warning child should survive stripping
      expect(entry?.children).toHaveLength(1);
      expect(entry?.children?.[0].level).toBe('warning');
      expect(entry?.children?.[0].operation).toBe('WARN');
    });
  });
});
