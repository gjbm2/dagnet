/**
 * CalendarGrid — reusable calendar grid component
 *
 * Extracted from the @ asat picker in WindowSelector.tsx.
 * Used by:
 *   - WindowSelector (asat snapshot picker) — highlights days with snapshot coverage
 *   - HistoricalCalendarPicker (historical file versions) — highlights days with git commits
 *
 * The component is purely presentational: the caller provides highlighted dates,
 * optional per-day coverage/opacity, and click handlers.
 */

import React, { useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import './CalendarGrid.css';

export interface CalendarCell {
  iso: string;          // YYYY-MM-DD
  day: number;          // 1-31
  inMonth: boolean;     // whether this cell belongs to the displayed month
  highlighted: boolean; // whether this date should be highlighted (cyan)
  coverage: number;     // 0-1, used for variable opacity (1 = fully opaque)
}

export interface CalendarGridProps {
  /** Which month to display (UTC month cursor) */
  monthCursor: Date;
  /** Callback to change the displayed month */
  setMonthCursor: (d: Date) => void;
  /** Set of ISO date strings (YYYY-MM-DD) that should be highlighted */
  highlightedDates: Set<string>;
  /** Optional per-date coverage/opacity (0-1). Key is ISO date string. */
  coverage?: Record<string, number>;
  /** Currently selected date (ISO string), or null */
  selectedDate?: string | null;
  /** Called when a day cell is clicked. Receives the ISO date string and optionally the click event. */
  onDateClick: (isoDate: string, event?: React.MouseEvent) => void;
  /** Optional title for the day cell tooltip. Receives (iso, highlighted, coverage). */
  getDayTitle?: (iso: string, highlighted: boolean, coverage: number) => string;
  /** Whether data is loading */
  isLoading?: boolean;
  /** Error message to display instead of the grid */
  error?: string;
  /** Footer content (e.g., explanatory text) */
  footer?: React.ReactNode;
}

const DOW_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/**
 * Build a 6×7 grid of calendar cells for the given UTC month cursor.
 */
function buildCalendarCells(
  monthCursor: Date,
  highlightedDates: Set<string>,
  coverage: Record<string, number> | undefined,
): CalendarCell[] {
  const year = monthCursor.getUTCFullYear();
  const month = monthCursor.getUTCMonth();
  const firstOfMonth = new Date(Date.UTC(year, month, 1));
  const firstWeekday = firstOfMonth.getUTCDay(); // 0=Sun
  const start = new Date(Date.UTC(year, month, 1 - firstWeekday));

  const cells: CalendarCell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    const iso = d.toISOString().split('T')[0];
    const inMonth = d.getUTCMonth() === month;
    const cov = coverage?.[iso] ?? 0;

    cells.push({
      iso,
      day: d.getUTCDate(),
      inMonth,
      highlighted: inMonth && highlightedDates.has(iso),
      coverage: cov,
    });
  }
  return cells;
}

export function CalendarGrid({
  monthCursor,
  setMonthCursor,
  highlightedDates,
  coverage,
  selectedDate,
  onDateClick,
  getDayTitle,
  isLoading,
  error,
  footer,
}: CalendarGridProps) {
  const cells = useMemo(
    () => buildCalendarCells(monthCursor, highlightedDates, coverage),
    [monthCursor, highlightedDates, coverage],
  );

  const goToPrevMonth = () => {
    const d = new Date(monthCursor.getTime());
    d.setUTCMonth(d.getUTCMonth() - 1);
    d.setUTCDate(1);
    setMonthCursor(d);
  };

  const goToNextMonth = () => {
    const d = new Date(monthCursor.getTime());
    d.setUTCMonth(d.getUTCMonth() + 1);
    d.setUTCDate(1);
    setMonthCursor(d);
  };

  // Loading state
  if (isLoading) {
    return <div className="calendar-grid-message">Loading…</div>;
  }

  // Error state
  if (error) {
    return <div className="calendar-grid-error">{error}</div>;
  }

  return (
    <>
      {/* Month navigation */}
      <div className="calendar-grid-nav">
        <button
          type="button"
          className="calendar-grid-nav-btn"
          onClick={goToPrevMonth}
          title="Previous month"
        >
          <ChevronLeft size={14} />
        </button>
        <div className="calendar-grid-month">
          {monthCursor.toLocaleString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' })}
        </div>
        <button
          type="button"
          className="calendar-grid-nav-btn"
          onClick={goToNextMonth}
          title="Next month"
        >
          <ChevronRight size={14} />
        </button>
      </div>

      {/* Calendar grid */}
      <div className="calendar-grid">
        {/* Day-of-week headers */}
        {DOW_LABELS.map((label, idx) => (
          <div key={`${label}-${idx}`} className="calendar-grid-dow">{label}</div>
        ))}

        {/* Day cells */}
        {cells.map((c) => {
          const title = getDayTitle
            ? getDayTitle(c.iso, c.highlighted, c.coverage)
            : c.highlighted
              ? 'Available'
              : '';

          return (
            <button
              key={c.iso}
              type="button"
              data-testid={`calendar-day-${c.iso}`}
              className={[
                'calendar-grid-day',
                c.inMonth ? 'in-month' : 'out-month',
                c.highlighted ? 'highlighted' : '',
                c.highlighted ? 'has-snapshot' : '',
                selectedDate === c.iso ? 'selected' : '',
              ].filter(Boolean).join(' ')}
              style={
                c.highlighted && c.coverage > 0 && c.coverage < 1
                  ? { '--highlight-opacity': String(0.2 + c.coverage * 0.8) } as React.CSSProperties
                  : undefined
              }
              onClick={(e) => onDateClick(c.iso, e)}
              title={title}
            >
              {c.day}
            </button>
          );
        })}
      </div>

      {/* Footer */}
      {footer && <div className="calendar-grid-footer">{footer}</div>}
    </>
  );
}
