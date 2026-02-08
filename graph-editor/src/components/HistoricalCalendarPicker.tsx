/**
 * HistoricalCalendarPicker — popover for selecting a historical file version by date.
 *
 * Thin wrapper around CalendarGrid that:
 *   - Renders as a positioned popover (portal) anchored to a reference element
 *   - Highlights dates that have git commits
 *   - When a date has a single commit, selects it directly
 *   - When a date has multiple commits, shows a sub-list to pick from
 *   - Closes on click-outside or Escape
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { CalendarGrid } from './CalendarGrid';
import type { CommitDateMap, HistoricalCommit } from '../services/historicalFileService';
import './HistoricalCalendarPicker.css';

export interface HistoricalCalendarPickerProps {
  /** Map of ISO date → commits on that date */
  commitDates: CommitDateMap;
  /** Whether commit dates are still loading */
  isLoading: boolean;
  /** Called when user selects a specific commit */
  onCommitSelected: (commit: HistoricalCommit) => void;
  /** Called to close the picker */
  onClose: () => void;
  /** Element to anchor the popover to (used for positioning) */
  anchorRef: React.RefObject<HTMLElement | null>;
  /** Optional title shown at top of the popover */
  title?: string;
}

export function HistoricalCalendarPicker({
  commitDates,
  isLoading,
  onCommitSelected,
  onClose,
  anchorRef,
  title = 'Open historical version',
}: HistoricalCalendarPickerProps) {
  const popoverRef = useRef<HTMLDivElement>(null);

  // Month cursor — start at the most recent commit date, or today
  const [monthCursor, setMonthCursor] = useState<Date>(() => {
    // Find the most recent date in the commitDates map
    let latest: Date | null = null;
    for (const [isoDate] of commitDates) {
      const d = new Date(isoDate + 'T00:00:00Z');
      if (!latest || d > latest) latest = d;
    }
    if (latest) {
      return new Date(Date.UTC(latest.getUTCFullYear(), latest.getUTCMonth(), 1));
    }
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  });

  // When a date has multiple commits, show a positioned submenu
  const [expandedDate, setExpandedDate] = useState<string | null>(null);
  const [submenuPosition, setSubmenuPosition] = useState<{ top: number; left: number } | null>(null);

  // Build the highlighted dates set
  const highlightedDates = useMemo(() => {
    return new Set(commitDates.keys());
  }, [commitDates]);

  // Position the popover relative to the anchor element
  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;

    const rect = anchor.getBoundingClientRect();
    // Position below the anchor, aligned to its left edge
    // Clamp to viewport
    const top = Math.min(rect.bottom + 4, window.innerHeight - 400);
    const left = Math.min(rect.left, window.innerWidth - 320);
    setPosition({ top: Math.max(0, top), left: Math.max(0, left) });
  }, [anchorRef]);

  // Click-outside to close
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        // If anchor is null (e.g., virtual anchor removed), treat as "outside"
        (!anchorRef.current || !anchorRef.current.contains(e.target as Node))
      ) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    // Delay adding listener to avoid closing immediately from the triggering click
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleEscape);
    }, 50);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose, anchorRef]);

  // Handle date click — for multi-commit days, position a submenu near the cell
  const handleDateClick = useCallback((isoDate: string, event?: React.MouseEvent) => {
    const commits = commitDates.get(isoDate);
    if (!commits || commits.length === 0) return;

    if (commits.length === 1) {
      // Single commit — select directly
      onCommitSelected(commits[0]);
    } else {
      // Multiple commits — show positioned submenu near the clicked day cell
      if (expandedDate === isoDate) {
        setExpandedDate(null);
        setSubmenuPosition(null);
        return;
      }
      setExpandedDate(isoDate);
      if (event) {
        const target = event.currentTarget as HTMLElement;
        const rect = target.getBoundingClientRect();
        // Position to the right of the clicked cell; fall back to left if near viewport edge
        const submenuWidth = 260; // approx. min-width + padding
        const left = rect.right + 4 + submenuWidth > window.innerWidth
          ? rect.left - submenuWidth - 4
          : rect.right + 4;
        setSubmenuPosition({
          top: Math.min(rect.top, window.innerHeight - 200),
          left: Math.max(4, left),
        });
      }
    }
  }, [commitDates, onCommitSelected, expandedDate]);

  // Day title tooltip
  const getDayTitle = useCallback((iso: string, highlighted: boolean) => {
    if (!highlighted) return 'No commits on this date';
    const commits = commitDates.get(iso);
    if (!commits) return '';
    if (commits.length === 1) return `1 commit: ${commits[0].message}`;
    return `${commits.length} commits — click to choose`;
  }, [commitDates]);

  // Get expanded commits for the sub-list
  const expandedCommits = expandedDate ? (commitDates.get(expandedDate) || []) : [];

  const formatTime = (dateStr: string) => {
    try {
      const d = new Date(dateStr);
      return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  };

  return createPortal(
    <div
      ref={popoverRef}
      className="historical-calendar-popover"
      style={{ top: position.top, left: position.left }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="historical-calendar-header">
        <div className="historical-calendar-title">{title}</div>
        <button
          type="button"
          className="historical-calendar-close"
          onClick={onClose}
          title="Close"
        >
          <X size={14} />
        </button>
      </div>

      {/* Calendar grid */}
      <CalendarGrid
        monthCursor={monthCursor}
        setMonthCursor={setMonthCursor}
        highlightedDates={highlightedDates}
        selectedDate={expandedDate}
        onDateClick={handleDateClick}
        getDayTitle={getDayTitle}
        isLoading={isLoading}
        footer="Highlighted dates have git commits for this file."
      />

      {/* Multi-commit submenu — floating popup positioned near the clicked day cell */}
      {expandedCommits.length > 1 && submenuPosition && (
        <div
          className="historical-calendar-submenu"
          style={{ top: submenuPosition.top, left: submenuPosition.left }}
        >
          <div className="historical-calendar-submenu-title">
            {expandedCommits.length} commits on {expandedCommits[0].dateUK}
          </div>
          {expandedCommits.map((commit) => (
            <button
              key={commit.sha}
              type="button"
              className="historical-calendar-commit-item"
              onClick={() => onCommitSelected(commit)}
              title={`${commit.shortSha}: ${commit.message}`}
            >
              <span className="historical-calendar-commit-sha">{commit.shortSha}</span>
              <span className="historical-calendar-commit-msg">{commit.message}</span>
              <span className="historical-calendar-commit-time">{formatTime(commit.date)}</span>
            </button>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}
