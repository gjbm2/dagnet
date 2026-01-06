/**
 * DateRangePicker Component
 * 
 * A drag-select date range picker using react-date-range
 */

import React, { useState, useRef, useEffect } from 'react';
import { DateRangePicker as ReactDateRangePicker, Range } from 'react-date-range';
import { format } from 'date-fns';
import { Calendar } from 'lucide-react';
import 'react-date-range/dist/styles.css';
import 'react-date-range/dist/theme/default.css';
import './DateRangePicker.css';
import { isUKDate, parseUKDate, formatDateUK, toUTCMidnightFromLocalDate } from '../lib/dateFormat';

// Parse date string in either UK (d-MMM-yy) or ISO (YYYY-MM-DD) format
function parseFlexibleDate(dateStr: string): Date {
  if (!dateStr) return new Date();
  if (isUKDate(dateStr)) {
    return parseUKDate(dateStr);
  }
  // Handle ISO format
  return new Date(dateStr);
}

export interface DateRangePickerProps {
  startDate: string;
  endDate: string;
  onChange: (start: string, end: string) => void;
  minDate?: string;
  maxDate?: string;
  className?: string;
}

export function DateRangePicker({
  startDate,
  endDate,
  onChange,
  minDate,
  maxDate,
  className = '',
}: DateRangePickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Convert string dates to Date objects for react-date-range
  const [range, setRange] = useState<Range>({
    startDate: startDate ? parseFlexibleDate(startDate) : new Date(),
    endDate: endDate ? parseFlexibleDate(endDate) : new Date(),
    key: 'selection',
  });

  // Update range when props change
  useEffect(() => {
    setRange({
      startDate: startDate ? parseFlexibleDate(startDate) : new Date(),
      endDate: endDate ? parseFlexibleDate(endDate) : new Date(),
      key: 'selection',
    });
  }, [startDate, endDate]);

  const minDateObj = minDate ? parseFlexibleDate(minDate) : undefined;
  const maxDateObj = maxDate ? parseFlexibleDate(maxDate) : undefined;

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  const handleSelect = (r: { selection: Range }) => {
    const selection = r.selection;
    setRange(selection);
    
    if (selection.startDate && selection.endDate) {
      // Both dates selected - output in UK format (d-MMM-yy).
      //
      // IMPORTANT:
      // react-date-range returns Date objects that represent the user's *local* midnight.
      // DagNet's date-only semantics are UTC-midnight to avoid timezone drift, so we
      // normalise the local calendar day to UTC midnight before formatting.
      onChange(
        formatDateUK(toUTCMidnightFromLocalDate(selection.startDate)),
        formatDateUK(toUTCMidnightFromLocalDate(selection.endDate))
      );
      setIsOpen(false);
    }
  };

  const displayText = startDate && endDate
    ? `${format(parseFlexibleDate(startDate), 'MMM d, yyyy')} - ${format(parseFlexibleDate(endDate), 'MMM d, yyyy')}`
    : 'Select date range';

  return (
    <div ref={containerRef} className={`date-range-picker ${className}`}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="date-range-picker-trigger"
        aria-label="Select date range"
      >
        <Calendar size={16} />
        <span className="date-range-picker-text">{displayText}</span>
      </button>
      
      {isOpen && (
        <div className="date-range-picker-dropdown">
          <ReactDateRangePicker
            ranges={[range]}
            onChange={handleSelect}
            minDate={minDateObj}
            maxDate={maxDateObj}
            months={2}
            direction="horizontal"
            showDateDisplay={false}
            showMonthAndYearPickers={true}
            rangeColours={['#1976d2']}
          />
        </div>
      )}
    </div>
  );
}

