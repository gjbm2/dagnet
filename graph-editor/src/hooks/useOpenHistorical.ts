/**
 * useOpenHistorical Hook
 *
 * Centralised hook for opening historical file versions.
 * Provides both:
 *   - Calendar-based access (for navigator @ icon / standalone popovers)
 *   - Menu-submenu access (for context menus and File menu)
 *
 * Used by NavigatorItem (@-icon), NavigatorItemContextMenu, TabContextMenu,
 * TabBar/TabContextMenu, FileMenu.
 */

import { useState, useCallback, useRef } from 'react';
import toast from 'react-hot-toast';
import { fileRegistry } from '../contexts/TabContext';
import { useNavigatorContext } from '../contexts/NavigatorContext';
import { historicalFileService, type CommitDateMap, type HistoricalCommit } from '../services/historicalFileService';

/** A menu-friendly representation of a historical commit date group */
export interface HistoricalDateItem {
  /** ISO date (YYYY-MM-DD) */
  dateISO: string;
  /** UK-formatted date (d-MMM-yy) */
  dateUK: string;
  /** Commits on this date (most recent first) */
  commits: HistoricalCommit[];
}

export interface UseOpenHistoricalResult {
  /** Whether the file can have historical versions opened */
  canOpenHistorical: boolean;

  // ── Calendar-based access (for navigator @ icon) ──────────────────────
  /** Whether commit dates are currently loading */
  isLoading: boolean;
  /** Grouped commit dates for the calendar picker (null until loaded) */
  commitDates: CommitDateMap | null;
  /** Whether the calendar picker is open */
  isCalendarOpen: boolean;
  /** Open the calendar picker (triggers loading commit dates) */
  openCalendar: () => void;
  /** Close the calendar picker */
  closeCalendar: () => void;
  /** Called when the user selects a date in the calendar */
  selectCommit: (commit: HistoricalCommit) => Promise<string | null>;
  /** Ref for the anchor element (where the calendar popover should appear) */
  anchorRef: React.RefObject<HTMLElement | null>;

  // ── Menu-submenu access (for context menus) ───────────────────────────
  /** Date items for rendering as submenu entries (null until loaded) */
  dateItems: HistoricalDateItem[] | null;
  /** Load dates for submenu display (call when submenu opens) */
  loadDates: () => Promise<void>;
}

/**
 * Hook to open historical file versions via a calendar picker or menu submenu.
 *
 * @param fileId - The file ID to open historical versions for
 * @returns Object with calendar state, submenu data, and actions
 */
export function useOpenHistorical(fileId: string | undefined): UseOpenHistoricalResult {
  const { state: navState } = useNavigatorContext();
  const [isLoading, setIsLoading] = useState(false);
  const [commitDates, setCommitDates] = useState<CommitDateMap | null>(null);
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  const [dateItems, setDateItems] = useState<HistoricalDateItem[] | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);

  const canOpenHistorical = fileId ? historicalFileService.canOpenHistorical(fileId) : false;

  // Debug: log why canOpenHistorical is true/false
  if (fileId) {
    const _file = fileRegistry.getFile(fileId);
    console.log(`[useOpenHistorical] fileId=${fileId} canOpenHistorical=${canOpenHistorical}`, {
      fileExists: !!_file,
      hasPath: !!_file?.source?.path,
      isLocal: _file?.isLocal,
      hasSha: !!_file?.sha,
    });
  }

  /** Fetch commit dates and store them for both calendar and submenu use */
  const fetchDates = useCallback(async (): Promise<CommitDateMap> => {
    console.log(`[useOpenHistorical.fetchDates] called, fileId=${fileId}, canOpenHistorical=${canOpenHistorical}`);
    if (!fileId || !canOpenHistorical) return new Map();

    const dates = await historicalFileService.getCommitDates(
      fileId,
      navState.selectedRepo,
      navState.selectedBranch,
    );

    setCommitDates(dates);

    // Build sorted date items for submenu use (most recent first)
    const items: HistoricalDateItem[] = [];
    for (const [isoDate, commits] of dates) {
      if (commits.length > 0) {
        items.push({
          dateISO: isoDate,
          dateUK: commits[0].dateUK,
          commits,
        });
      }
    }
    items.sort((a, b) => b.dateISO.localeCompare(a.dateISO));
    setDateItems(items);

    return dates;
  }, [fileId, canOpenHistorical, navState.selectedRepo, navState.selectedBranch]);

  /** Open the calendar picker (triggers loading commit dates) */
  const openCalendar = useCallback(async () => {
    if (!fileId || !canOpenHistorical) return;

    setIsCalendarOpen(true);
    setIsLoading(true);

    try {
      const dates = await fetchDates();
      if (dates.size === 0) {
        toast('No historical versions found for this file', { icon: 'ℹ️' });
      }
    } catch (error) {
      toast.error(`Failed to load history: ${error instanceof Error ? error.message : 'Unknown error'}`);
      setIsCalendarOpen(false);
    } finally {
      setIsLoading(false);
    }
  }, [fileId, canOpenHistorical, fetchDates]);

  /** Load dates for submenu display */
  const loadDates = useCallback(async () => {
    console.log(`[useOpenHistorical.loadDates] called, fileId=${fileId}, canOpenHistorical=${canOpenHistorical}, dateItems=${dateItems === null ? 'null' : `array(${dateItems?.length})`}`);
    if (!fileId || !canOpenHistorical) {
      console.log(`[useOpenHistorical.loadDates] early return: fileId=${fileId}, canOpenHistorical=${canOpenHistorical}`);
      return;
    }
    if (dateItems !== null) {
      console.log(`[useOpenHistorical.loadDates] already loaded, skipping`);
      return;
    }

    console.log(`[useOpenHistorical.loadDates] starting fetch...`);
    setIsLoading(true);
    try {
      const dates = await fetchDates();
      if (dates.size === 0) {
        toast('No historical versions found for this file', { icon: 'ℹ️' });
      }
    } catch (error) {
      toast.error(`Failed to load history: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsLoading(false);
    }
  }, [fileId, canOpenHistorical, dateItems, fetchDates]);

  const closeCalendar = useCallback(() => {
    setIsCalendarOpen(false);
    setCommitDates(null);
  }, []);

  const selectCommit = useCallback(async (commit: HistoricalCommit): Promise<string | null> => {
    if (!fileId) return null;

    const file = fileRegistry.getFile(fileId);
    const toastId = toast.loading(`Opening ${file?.name || fileId} at ${commit.dateUK}…`);

    try {
      const tabId = await historicalFileService.openHistoricalVersion(
        fileId,
        commit,
        navState.selectedRepo,
      );

      if (tabId) {
        toast.success(`Opened historical version (${commit.dateUK})`, { id: toastId });
        setIsCalendarOpen(false);
        setCommitDates(null);
      } else {
        toast.error('Failed to open historical version', { id: toastId });
      }

      return tabId;
    } catch (error) {
      toast.error(
        `Failed to open historical version: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { id: toastId },
      );
      return null;
    }
  }, [fileId, navState.selectedRepo]);

  return {
    canOpenHistorical,
    isLoading,
    commitDates,
    isCalendarOpen,
    openCalendar,
    closeCalendar,
    selectCommit,
    anchorRef,
    dateItems,
    loadDates,
  };
}
