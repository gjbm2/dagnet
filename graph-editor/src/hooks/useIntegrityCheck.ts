/**
 * useIntegrityCheck Hook
 * 
 * Centralized hook for running integrity checks on all workspace files.
 * Used by FileMenu.
 */

import { useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { useTabContext } from '../contexts/TabContext';
import { IntegrityCheckService } from '../services/integrityCheckService';

interface UseIntegrityCheckResult {
  /** Run the integrity check */
  runCheck: () => Promise<void>;
  /** Whether check is currently running */
  isChecking: boolean;
}

/**
 * Hook to run integrity checks on workspace files
 * 
 * Validates all files for:
 * - Schema validation (required fields)
 * - Referential integrity (parameter IDs exist)
 * - Naming consistency (id matches filename)
 * - Metadata completeness
 */
export function useIntegrityCheck(): UseIntegrityCheckResult {
  const { operations } = useTabContext();
  const [isChecking, setIsChecking] = useState(false);
  
  const runCheck = useCallback(async () => {
    if (isChecking) return;
    
    setIsChecking(true);
    const toastId = toast.loading('Checking integrity...');
    
    try {
      const result = await IntegrityCheckService.checkIntegrity(operations, true);
      
      if (result.success) {
        toast.success(
          `✅ No issues found (${result.totalFiles} files checked)`,
          { id: toastId }
        );
      } else {
        const { errors, warnings, info } = result.summary;
        toast.error(
          `Found ${errors} error(s), ${warnings} warning(s), ${info} info`,
          { id: toastId, duration: 5000 }
        );
      }
    } catch (error) {
      toast.error(
        `Integrity check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { id: toastId }
      );
    } finally {
      setIsChecking(false);
    }
  }, [operations, isChecking]);
  
  return {
    runCheck,
    isChecking
  };
}

