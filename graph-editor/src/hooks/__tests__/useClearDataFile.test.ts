/**
 * useClearDataFile Hook Tests
 * 
 * Tests for clearing fetched data from parameter/case files.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useClearDataFile } from '../useClearDataFile';
import { fileRegistry } from '../../contexts/TabContext';
import type { FileState } from '../../types';

// Mock dependencies
vi.mock('../../contexts/TabContext', () => ({
  fileRegistry: {
    getFile: vi.fn(),
    updateFile: vi.fn(),
  }
}));

vi.mock('../../contexts/DialogContext', () => ({
  useDialog: () => ({
    showConfirm: vi.fn().mockResolvedValue(true)
  })
}));

vi.mock('react-hot-toast', () => {
  const toast = Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
  });
  return { default: toast };
});

vi.mock('../../services/sessionLogService', () => ({
  sessionLogService: {
    success: vi.fn(),
    error: vi.fn(),
  }
}));

describe('useClearDataFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('canClearData', () => {
    it('should return true for parameter files with data', () => {
      const paramFile: Partial<FileState> = {
        fileId: 'parameter-test',
        type: 'parameter',
        data: {
          values: [
            { mean: 0.5, n: 100, k: 50, data_source: { type: 'amplitude' } }
          ]
        }
      };
      
      vi.mocked(fileRegistry.getFile).mockReturnValue(paramFile as FileState);
      
      const { result } = renderHook(() => useClearDataFile());
      
      expect(result.current.canClearData('parameter-test')).toBe(true);
    });

    it('should return false for parameter files without data', () => {
      const paramFile: Partial<FileState> = {
        fileId: 'parameter-empty',
        type: 'parameter',
        data: {
          values: [{ mean: 0.5 }] // No n, k, or data_source
        }
      };
      
      vi.mocked(fileRegistry.getFile).mockReturnValue(paramFile as FileState);
      
      const { result } = renderHook(() => useClearDataFile());
      
      expect(result.current.canClearData('parameter-empty')).toBe(false);
    });

    it('should return true for case files with schedules', () => {
      const caseFile: Partial<FileState> = {
        fileId: 'case-test',
        type: 'case',
        data: {
          case: {
            schedules: [{ start: '2025-01-01', end: '2025-12-31' }]
          }
        }
      };
      
      vi.mocked(fileRegistry.getFile).mockReturnValue(caseFile as FileState);
      
      const { result } = renderHook(() => useClearDataFile());
      
      expect(result.current.canClearData('case-test')).toBe(true);
    });

    it('should return false for case files without schedules', () => {
      const caseFile: Partial<FileState> = {
        fileId: 'case-empty',
        type: 'case',
        data: {
          case: {
            schedules: []
          }
        }
      };
      
      vi.mocked(fileRegistry.getFile).mockReturnValue(caseFile as FileState);
      
      const { result } = renderHook(() => useClearDataFile());
      
      expect(result.current.canClearData('case-empty')).toBe(false);
    });

    it('should return false for non-data file types', () => {
      const graphFile: Partial<FileState> = {
        fileId: 'graph-test',
        type: 'graph',
        data: { nodes: [], edges: [] }
      };
      
      vi.mocked(fileRegistry.getFile).mockReturnValue(graphFile as FileState);
      
      const { result } = renderHook(() => useClearDataFile());
      
      expect(result.current.canClearData('graph-test')).toBe(false);
    });

    it('should return false for non-existent files', () => {
      vi.mocked(fileRegistry.getFile).mockReturnValue(undefined);
      
      const { result } = renderHook(() => useClearDataFile());
      
      expect(result.current.canClearData('non-existent')).toBe(false);
    });
  });

  describe('clearDataFile', () => {
    it('should clear values from parameter file keeping first mean', async () => {
      const paramFile: Partial<FileState> = {
        fileId: 'parameter-test',
        type: 'parameter',
        data: {
          id: 'test',
          name: 'Test Parameter',
          values: [
            { mean: 0.75, n: 100, k: 75, data_source: { type: 'amplitude' } },
            { mean: 0.8, n: 200, k: 160, data_source: { type: 'amplitude' } }
          ],
          metadata: { description: 'Test' }
        }
      };
      
      vi.mocked(fileRegistry.getFile).mockReturnValue(paramFile as FileState);
      vi.mocked(fileRegistry.updateFile).mockResolvedValue(undefined);
      
      const { result } = renderHook(() => useClearDataFile());
      
      let clearResult: any;
      await act(async () => {
        clearResult = await result.current.clearDataFile('parameter-test', true);
      });
      
      expect(clearResult.success).toBe(true);
      expect(clearResult.clearedCount).toBe(2); // Both values cleared
      
      expect(fileRegistry.updateFile).toHaveBeenCalledWith('parameter-test', {
        id: 'test',
        name: 'Test Parameter',
        values: [], // Fully cleared - no stub entries that cause aggregation issues
        force_replace_at_ms: expect.any(Number),
        metadata: { description: 'Test' }
      });
    });

    it('should clear schedules from case file', async () => {
      const caseFile: Partial<FileState> = {
        fileId: 'case-test',
        type: 'case',
        data: {
          id: 'test',
          name: 'Test Case',
          case: {
            variants: [{ name: 'control' }, { name: 'treatment' }],
            schedules: [
              { start: '2025-01-01', end: '2025-06-30' },
              { start: '2025-07-01', end: '2025-12-31' }
            ]
          }
        }
      };
      
      vi.mocked(fileRegistry.getFile).mockReturnValue(caseFile as FileState);
      vi.mocked(fileRegistry.updateFile).mockResolvedValue(undefined);
      
      const { result } = renderHook(() => useClearDataFile());
      
      let clearResult: any;
      await act(async () => {
        clearResult = await result.current.clearDataFile('case-test', true);
      });
      
      expect(clearResult.success).toBe(true);
      expect(clearResult.clearedCount).toBe(2); // 2 schedules cleared
      
      expect(fileRegistry.updateFile).toHaveBeenCalledWith('case-test', {
        id: 'test',
        name: 'Test Case',
        force_replace_at_ms: expect.any(Number),
        case: {
          variants: [{ name: 'control' }, { name: 'treatment' }],
          schedules: [] // Schedules cleared
        }
      });
    });

    it('should return success with zero count when no data to clear', async () => {
      const paramFile: Partial<FileState> = {
        fileId: 'parameter-empty',
        type: 'parameter',
        data: {
          values: [{ mean: 0.5 }] // No data to clear
        }
      };
      
      vi.mocked(fileRegistry.getFile).mockReturnValue(paramFile as FileState);
      
      const { result } = renderHook(() => useClearDataFile());
      
      let clearResult: any;
      await act(async () => {
        clearResult = await result.current.clearDataFile('parameter-empty', true);
      });
      
      expect(clearResult.success).toBe(true);
      expect(clearResult.clearedCount).toBe(0);
      expect(fileRegistry.updateFile).not.toHaveBeenCalled();
    });

    it('should reject non-data file types', async () => {
      const graphFile: Partial<FileState> = {
        fileId: 'graph-test',
        type: 'graph',
        data: { nodes: [], edges: [] }
      };
      
      vi.mocked(fileRegistry.getFile).mockReturnValue(graphFile as FileState);
      
      const { result } = renderHook(() => useClearDataFile());
      
      let clearResult: any;
      await act(async () => {
        clearResult = await result.current.clearDataFile('graph-test', true);
      });
      
      expect(clearResult.success).toBe(false);
      expect(fileRegistry.updateFile).not.toHaveBeenCalled();
    });
  });

  describe('clearDataFiles (batch)', () => {
    it('clears malformed values keys even when values array is empty', async () => {
      const paramFile: Partial<FileState> = {
        fileId: 'parameter-malformed',
        type: 'parameter',
        data: {
          id: 'malformed',
          name: 'Malformed Parameter',
          values: [],
          'values[0]': { n: 1, k: 1, data_source: { type: 'amplitude' } }
        }
      };

      vi.mocked(fileRegistry.getFile).mockReturnValue(paramFile as FileState);
      vi.mocked(fileRegistry.updateFile).mockResolvedValue(undefined);

      const { result } = renderHook(() => useClearDataFile());

      let clearResult: any;
      await act(async () => {
        clearResult = await result.current.clearDataFiles(['parameter-malformed'], true);
      });

      expect(clearResult.success).toBe(true);
      expect(fileRegistry.updateFile).toHaveBeenCalledWith('parameter-malformed', {
        id: 'malformed',
        name: 'Malformed Parameter',
        force_replace_at_ms: expect.any(Number),
        values: []
      });
    });
  });

  describe('getParameterFileId', () => {
    it('should return parameter file ID from parameter ID', () => {
      const { result } = renderHook(() => useClearDataFile());
      
      expect(result.current.getParameterFileId('my-param')).toBe('parameter-my-param');
    });

    it('should return undefined for undefined input', () => {
      const { result } = renderHook(() => useClearDataFile());
      
      expect(result.current.getParameterFileId(undefined)).toBeUndefined();
    });
  });
});

