import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatDateUK, parseUKDate, resolveRelativeDate, isRelativeDate } from '../dateFormat';

describe('Date Formatting (d-MMM-yy)', () => {
  describe('formatDateUK', () => {
    it('should format date to d-MMM-yy', () => {
      expect(formatDateUK('2025-01-01')).toBe('1-Jan-25');
      expect(formatDateUK('2025-03-15')).toBe('15-Mar-25');
      expect(formatDateUK('2025-12-31')).toBe('31-Dec-25');
    });
    
    it('should handle Date objects', () => {
      expect(formatDateUK(new Date('2025-01-01'))).toBe('1-Jan-25');
      expect(formatDateUK(new Date('2025-11-24'))).toBe('24-Nov-25');
    });
    
    it('should handle ISO timestamps', () => {
      expect(formatDateUK('2025-01-15T00:00:00Z')).toBe('15-Jan-25');
      expect(formatDateUK('2025-11-23T23:59:59Z')).toBe('23-Nov-25');
    });
    
    it('should throw on invalid dates', () => {
      expect(() => formatDateUK('invalid')).toThrow('Invalid date');
    });
  });
  
  describe('parseUKDate', () => {
    it('should parse d-MMM-yy to Date', () => {
      const date1 = parseUKDate('1-Jan-25');
      expect(date1.getFullYear()).toBe(2025);
      expect(date1.getMonth()).toBe(0); // January = 0
      expect(date1.getDate()).toBe(1);
      
      const date2 = parseUKDate('15-Mar-25');
      expect(date2.getFullYear()).toBe(2025);
      expect(date2.getMonth()).toBe(2); // March = 2
      expect(date2.getDate()).toBe(15);
    });
    
    it('should assume 2000s for years 00-49', () => {
      const date = parseUKDate('1-Jan-25');
      expect(date.getFullYear()).toBe(2025);
      
      const date2 = parseUKDate('1-Jan-49');
      expect(date2.getFullYear()).toBe(2049);
    });
    
    it('should assume 1900s for years 50-99', () => {
      const date = parseUKDate('1-Jan-99');
      expect(date.getFullYear()).toBe(1999);
      
      const date2 = parseUKDate('1-Jan-50');
      expect(date2.getFullYear()).toBe(1950);
    });
    
    it('should throw on invalid format', () => {
      expect(() => parseUKDate('2025-01-01')).toThrow('Invalid month'); // '01' is not a month name
      expect(() => parseUKDate('1/Jan/25')).toThrow('Invalid d-MMM-yy format');
      expect(() => parseUKDate('Jan-1-25')).toThrow(); // Wrong order
    });
    
    it('should throw on invalid month', () => {
      expect(() => parseUKDate('1-Xxx-25')).toThrow('Invalid month');
    });
  });
  
  describe('Round-trip conversion', () => {
    it('should preserve dates through format and parse', () => {
      const original = '2025-01-15';
      const ukFormat = formatDateUK(original);
      const parsed = parseUKDate(ukFormat);
      const backToISO = parsed.toISOString().split('T')[0];
      
      expect(backToISO).toBe(original);
    });
  });

  // ==========================================================================
  // isRelativeDate tests
  // ==========================================================================

  describe('isRelativeDate', () => {
    it('should identify day-based relative dates', () => {
      expect(isRelativeDate('-7d')).toBe(true);
      expect(isRelativeDate('-14d')).toBe(true);
      expect(isRelativeDate('-30d')).toBe(true);
      expect(isRelativeDate('-1d')).toBe(true);
      expect(isRelativeDate('-100d')).toBe(true);
    });

    it('should identify week-based relative dates', () => {
      expect(isRelativeDate('-1w')).toBe(true);
      expect(isRelativeDate('-2w')).toBe(true);
      expect(isRelativeDate('-4w')).toBe(true);
    });

    it('should identify month-based relative dates', () => {
      expect(isRelativeDate('-1m')).toBe(true);
      expect(isRelativeDate('-3m')).toBe(true);
      expect(isRelativeDate('-12m')).toBe(true);
    });

    it('should identify year-based relative dates', () => {
      expect(isRelativeDate('-1y')).toBe(true);
      expect(isRelativeDate('-2y')).toBe(true);
    });

    it('should identify positive offsets', () => {
      expect(isRelativeDate('7d')).toBe(true);
      expect(isRelativeDate('1w')).toBe(true);
      expect(isRelativeDate('1m')).toBe(true);
    });

    it('should reject non-relative dates', () => {
      expect(isRelativeDate('1-Jan-25')).toBe(false);
      expect(isRelativeDate('2025-01-01')).toBe(false);
      expect(isRelativeDate('today')).toBe(false);
      expect(isRelativeDate('')).toBe(false);
      expect(isRelativeDate('d')).toBe(false);
      expect(isRelativeDate('-d')).toBe(false);
      expect(isRelativeDate('7')).toBe(false);
    });
  });

  // ==========================================================================
  // resolveRelativeDate tests
  // ==========================================================================

  describe('resolveRelativeDate', () => {
    // Use a fixed date for predictable tests
    const mockNow = new Date('2025-12-03T12:00:00Z');
    
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(mockNow);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should resolve day-based negative offsets', () => {
      // -7d from Dec 3 = Nov 26
      expect(resolveRelativeDate('-7d')).toBe('26-Nov-25');
      // -14d from Dec 3 = Nov 19
      expect(resolveRelativeDate('-14d')).toBe('19-Nov-25');
      // -1d from Dec 3 = Dec 2
      expect(resolveRelativeDate('-1d')).toBe('2-Dec-25');
      // -30d from Dec 3 = Nov 3
      expect(resolveRelativeDate('-30d')).toBe('3-Nov-25');
    });

    it('should resolve week-based negative offsets', () => {
      // -1w from Dec 3 = Nov 26 (7 days back)
      expect(resolveRelativeDate('-1w')).toBe('26-Nov-25');
      // -2w from Dec 3 = Nov 19 (14 days back)
      expect(resolveRelativeDate('-2w')).toBe('19-Nov-25');
    });

    it('should resolve month-based negative offsets', () => {
      // -1m from Dec 3 = Nov 3
      expect(resolveRelativeDate('-1m')).toBe('3-Nov-25');
      // -3m from Dec 3 = Sep 3
      expect(resolveRelativeDate('-3m')).toBe('3-Sep-25');
    });

    it('should resolve year-based negative offsets', () => {
      // -1y from Dec 3, 2025 = Dec 3, 2024
      expect(resolveRelativeDate('-1y')).toBe('3-Dec-24');
    });

    it('should resolve positive offsets (future dates)', () => {
      // +7d from Dec 3 = Dec 10
      expect(resolveRelativeDate('7d')).toBe('10-Dec-25');
      // +1m from Dec 3 = Jan 3
      expect(resolveRelativeDate('1m')).toBe('3-Jan-26');
    });

    it('should return non-relative dates unchanged', () => {
      expect(resolveRelativeDate('1-Jan-25')).toBe('1-Jan-25');
      expect(resolveRelativeDate('2025-01-01')).toBe('2025-01-01');
      expect(resolveRelativeDate('today')).toBe('today');
    });

    it('should handle empty string', () => {
      expect(resolveRelativeDate('')).toBe('');
    });

    it('should handle undefined-like empty values', () => {
      // Empty string should return empty (for open-ended windows)
      const result = resolveRelativeDate('');
      expect(result).toBe('');
    });

    it('should handle edge case: 0d (today)', () => {
      expect(resolveRelativeDate('0d')).toBe('3-Dec-25');
    });

    it('should handle edge case: 0w (today)', () => {
      expect(resolveRelativeDate('0w')).toBe('3-Dec-25');
    });

    it('should handle edge case: 0m (today)', () => {
      expect(resolveRelativeDate('0m')).toBe('3-Dec-25');
    });
  });
});

